import { MODULE_ID } from "../constants.js";
import { Compat } from "../compat.js";
import { CPR } from "../cpr-adapter.js";
import { formatEb } from "../shop-data.js";
import { rollCheck } from "./service-rules.js";

/**
 * Runs one booked service (a clinic procedure, a tech job) on the active GM client.
 *
 * A job is { title, plan, fee, materials?, apply(user, check), fail?(user, check) }. The plan
 * (or none) is the staff's check: { skill, base, dv }. The job is priced and approved, the
 * staff roll, the customer is charged and the result applied. If applying fails, the charge is
 * refunded, so a customer never pays for something that didn't happen.
 *
 * Materials are only charged when the job succeeds: a failed fabrication or upgrade leaves them
 * unharmed (CRB p.148). The fee is charged on failure only when the venue says so.
 */
export class ServiceRunner {
  /**
   * @param {object} o
   * @param {User} o.user - who booked it
   * @param {Actor} o.customer - the patient or customer, who pays
   * @param {Actor} o.venueActor - the clinic or tech shop actor
   * @param {object} o.venue - { name, staff, accent, icon, chargeOnFailure, feesToActor, labels }
   *   labels: { customer, staff } i18n keys for the chat card ("Patient: {name}", "Doctor: {name}")
   * @param {object} o.job
   */
  static async run({ user, customer, venueActor, venue, job }) {
    const fee = Math.max(0, Math.round(job.fee ?? 0));
    const materials = Math.max(0, Math.round(job.materials ?? 0));
    const most = fee + materials;
    if (most > 0) {
      if (!CPR.hasWealth(customer)) throw this.error("NEONMARKET.Error.NoWealth", { name: customer.name });
      const wealth = CPR.getWealth(customer);
      if (wealth < most) {
        const err = this.error("NEONMARKET.Error.NotEnoughFunds", { name: customer.name, total: formatEb(most), wealth: formatEb(wealth) });
        err.code = "noFunds";
        throw err;
      }
    }

    await (job.approve ?? ((u) => this.approve(u, venue, customer, job, most)))(user);

    const check = job.plan ? await rollCheck(job.plan.base, job.plan.dv) : null;
    const success = check ? check.success : true;
    const charged = (success || venue.chargeOnFailure ? fee : 0) + (success ? materials : 0);
    const reason = game.i18n.format("NEONMARKET.Service.Ledger.Fee", { job: job.title, venue: venue.name });

    const undo = [];
    let outcome;
    try {
      if (charged > 0) {
        await CPR.changeWealth(customer, -charged, reason, user.name);
        undo.push(() => CPR.changeWealth(customer, charged, game.i18n.localize("NEONMARKET.Ledger.Rollback"), user.name));
        if (venue.feesToActor && CPR.hasWealth(venueActor)) {
          const income = game.i18n.format("NEONMARKET.Service.Ledger.Income", { job: job.title, customer: customer.name });
          await CPR.changeWealth(venueActor, charged, income, user.name);
          undo.push(() => CPR.changeWealth(venueActor, -charged, game.i18n.localize("NEONMARKET.Ledger.Rollback"), user.name));
        }
      }
      outcome = success ? await job.apply(user, check) : await (job.fail?.(user, check) ?? []);
    } catch (err) {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (e) {
          console.error(`${MODULE_ID} | service rollback step failed`, e);
        }
      }
      throw err;
    }

    await this.card({ user, venue, customer, job, check, success, charged, outcome });
    return { success, charged, total: check?.total ?? null, balance: CPR.hasWealth(customer) ? CPR.getWealth(customer) : null };
  }

  static error(key, data) {
    return new Error(data ? game.i18n.format(key, data) : game.i18n.localize(key));
  }

  /** The GM confirms player bookings when the world asks for approval. */
  static async approve(user, venue, customer, job, total) {
    if (user.isGM || !game.settings.get(MODULE_ID, "requireApproval")) return;
    const ok = await Compat.DialogV2.confirm({
      classes: ["neon-market-dialog"],
      window: { title: game.i18n.localize("NEONMARKET.Approval.Title") },
      content: `<p>${game.i18n.format("NEONMARKET.Service.Approval", {
        user: Handlebars.escapeExpression(user.name),
        actor: Handlebars.escapeExpression(customer.name),
        job: Handlebars.escapeExpression(job.title),
        venue: Handlebars.escapeExpression(venue.name),
        total: formatEb(total)
      })}</p>`,
      rejectClose: false
    });
    if (!ok) throw this.error("NEONMARKET.Error.Denied");
  }

  static async card({ user, venue, customer, job, check, success, charged, outcome }) {
    const mode = game.settings.get(MODULE_ID, "receiptMode");
    const extraRolls = Array.isArray(outcome) ? [] : outcome?.rolls ?? [];
    const lines = Array.isArray(outcome) ? outcome : outcome?.lines ?? [];
    const content = await Compat.renderTemplate(`modules/${MODULE_ID}/templates/chat-service.hbs`, {
      venueName: venue.name,
      icon: venue.icon,
      accent: venue.accent,
      job: job.title,
      customerLine: game.i18n.format(venue.labels.customer, { name: customer.name }),
      staffLine: venue.staff ? game.i18n.format(venue.labels.staff, { name: venue.staff }) : null,
      check: check && {
        skill: job.plan.label ?? job.plan.skill,
        base: check.base,
        die: check.die,
        crit: check.crit ? (check.crit > 0 ? `+${check.crit}` : String(check.crit)) : "",
        total: check.total,
        dv: check.dv
      },
      success,
      lines,
      time: job.time ?? null,
      fee: charged > 0 ? formatEb(charged) : game.i18n.localize("NEONMARKET.Service.NoCharge"),
      balance: CPR.hasWealth(customer) ? formatEb(CPR.getWealth(customer)) : null,
      customer: customer.name
    });
    // Rolls ride along so Dice So Nice and the roll log see them; the card supplies the text.
    const data = { content, speaker: ChatMessage.getSpeaker({ actor: customer }), rolls: [...(check?.rolls ?? []), ...extraRolls] };
    if (mode === "private" || mode === "none") {
      const owners = game.users.filter((u) => u.isGM || customer.testUserPermission(u, "OWNER")).map((u) => u.id);
      data.whisper = [...new Set([...owners, user.id])];
    }
    await ChatMessage.create(data);
  }
}
