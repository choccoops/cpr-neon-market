import { MODULE_ID } from "../constants.js";
import { Compat } from "../compat.js";
import { CPR } from "../cpr-adapter.js";
import { ShopSocket } from "../socket.js";
import { ServiceRunner } from "../services/service-runner.js";
import { getClinic, THERAPIES } from "./clinic-data.js";
import {
  hp, humanity, body, woundState, feeForDv, stabilizePlan, quickFixPlan, treatmentPlan,
  cryoPlan, therapyPlan, installPlan, installTargets, installLocation, humanityItems, injuries,
  THERAPY, THERAPY_NIGHTS
} from "./clinic-rules.js";

const QUICK_FIX_FLAG = "quickFix";
const DAY = 86400;

/**
 * Clinic procedures, run only on the active GM client (players can't write to the
 * clinic actor or roll for its doctor). Each procedure is planned here; ServiceRunner
 * prices it, gets it approved, rolls for the doctor, charges the patient and applies it.
 */
export class ClinicOps {
  static init() {
    ShopSocket.register("clinic", (payload, user) => this.run(payload, user));
    Hooks.on("updateWorldTime", () => this.expireQuickFixes());
  }

  static async run({ kind, patientUuid, clinicUuid, params = {} }, user) {
    const patient = await fromUuid(patientUuid);
    const clinicActor = await fromUuid(clinicUuid);
    if (!(patient instanceof Actor) || !(clinicActor instanceof Actor)) throw this.#error("NEONMARKET.Error.BadActor");
    if (!user.isGM && !patient.testUserPermission(user, "OWNER")) throw this.#error("NEONMARKET.Error.NotOwner");
    if (patient.uuid === clinicActor.uuid) throw this.#error("NEONMARKET.Clinic.Error.SelfCare");

    const clinic = getClinic(clinicActor);
    if (!clinic.enabled && !user.isGM) throw this.#error("NEONMARKET.Clinic.Error.Closed");
    if (!clinic.services[kind]) throw this.#error("NEONMARKET.Clinic.Error.NoService");

    const job = this.#plan(kind, clinic, patient, params);
    if (job.plan) job.plan.label = game.i18n.localize(`NEONMARKET.Clinic.Skill.${job.plan.skill}`);
    return ServiceRunner.run({
      user,
      customer: patient,
      venueActor: clinicActor,
      venue: {
        name: clinic.identity.name,
        staff: clinic.identity.doctor,
        accent: clinic.identity.accent,
        icon: "fa-solid fa-user-doctor",
        chargeOnFailure: clinic.options.chargeOnFailure,
        feesToActor: clinic.options.feesToActor,
        labels: { customer: "NEONMARKET.Clinic.Card.Patient", staff: "NEONMARKET.Clinic.Card.Doctor" }
      },
      job
    });
  }

  /* ---------------------------------------- */
  /*  Procedures                              */
  /* ---------------------------------------- */

  /**
   * Work out a procedure: its title, the doctor's check (or none), the fee, and what
   * happens on success and failure. Throws if the procedure can't be done here.
   */
  static #plan(kind, clinic, patient, params) {
    const L = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
    switch (kind) {
      case "stabilize": {
        const state = woundState(patient);
        if (state === "notWounded") throw this.#error("NEONMARKET.Clinic.Error.NotWounded", { name: patient.name });
        if (state === "dead") throw this.#error("NEONMARKET.Clinic.Error.Dead", { name: patient.name });
        const plan = stabilizePlan(clinic, patient);
        if (!plan) throw this.#error("NEONMARKET.Clinic.Error.NoSkill");
        return {
          title: L("NEONMARKET.Clinic.Service.stabilize"),
          plan,
          fee: feeForDv(clinic, plan.dv),
          apply: async (user) => {
            const lines = [];
            const now = hp(patient);
            if (now.value < 1) {
              await CPR.changeLedger(patient, "derivedStats.hp", 1 - now.value, L("NEONMARKET.Clinic.Ledger.Stabilized"), user.name);
              lines.push(L("NEONMARKET.Clinic.Result.Unconscious", { name: patient.name }));
            }
            await patient.update({ "system.derivedStats.deathSave.penalty": 0 });
            lines.unshift(L("NEONMARKET.Clinic.Result.Stabilized", { name: patient.name }));
            return lines;
          }
        };
      }

      case "quickFix":
      case "treatment": {
        const injury = patient.items.get(params.injuryId);
        if (injury?.type !== "criticalInjury") throw this.#error("NEONMARKET.Clinic.Error.NoInjury");
        const cyber = !!params.cyber;
        if (kind === "treatment" && injury.system?.treatment?.type === "quickFix") {
          throw this.#error("NEONMARKET.Clinic.Error.QuickFixHeals", { injury: injury.name });
        }
        const plan = kind === "quickFix" ? quickFixPlan(clinic, injury, { cyber }) : treatmentPlan(clinic, injury, { cyber });
        if (!plan) throw this.#error(kind === "quickFix" ? "NEONMARKET.Clinic.Error.NoQuickFix" : "NEONMARKET.Clinic.Error.NoTreatment", { injury: injury.name });
        return {
          title: `${L(`NEONMARKET.Clinic.Service.${kind}`)}: ${injury.name}`,
          plan,
          fee: feeForDv(clinic, plan.dv),
          apply: async () => {
            if (kind === "treatment" || plan.permanent) {
              await injury.delete();
              return [L("NEONMARKET.Clinic.Result.Healed", { injury: injury.name })];
            }
            await this.#quickFix(injury);
            return [L("NEONMARKET.Clinic.Result.QuickFixed", { injury: injury.name })];
          }
        };
      }

      case "rest":
      case "cryo": {
        const days = Math.min(30, Math.max(1, Math.floor(Number(params.days) || 1)));
        const now = hp(patient);
        if (now.value < 1) throw this.#error("NEONMARKET.Clinic.Error.StabilizeFirst", { name: patient.name });
        if (now.value >= now.max) throw this.#error("NEONMARKET.Clinic.Error.NotWounded", { name: patient.name });
        const plan = kind === "cryo" ? cryoPlan(clinic) : null;
        if (kind === "cryo" && !plan) throw this.#error("NEONMARKET.Clinic.Error.NoSkill");
        const rate = kind === "cryo" ? 2 : 1;
        return {
          title: L(`NEONMARKET.Clinic.Service.${kind}`) + ` (${L("NEONMARKET.Clinic.Days", { n: days })})`,
          plan,
          fee: (kind === "cryo" ? clinic.fees.cryo : clinic.fees.bed) * days,
          apply: async (user) => {
            const healed = await CPR.changeLedger(patient, "derivedStats.hp", body(patient) * rate * days,
              L("NEONMARKET.Clinic.Ledger.Healed", { clinic: clinic.identity.name }), user.name, { max: now.max });
            const after = hp(patient);
            return [L("NEONMARKET.Clinic.Result.HealedHp", { name: patient.name, n: healed, value: after.value, max: after.max })];
          },
          fail: async () => [L("NEONMARKET.Clinic.Result.CryoFailed")]
        };
      }

      case "therapy": {
        const therapy = THERAPIES.includes(params.therapy) ? params.therapy : "standard";
        const plan = therapyPlan(clinic, therapy);
        if (!plan) throw this.#error("NEONMARKET.Clinic.Error.NoSkill");
        const h = humanity(patient);
        if (therapy !== "addiction" && h.value >= h.max) throw this.#error("NEONMARKET.Clinic.Error.FullHumanity", { name: patient.name });
        const stay = !!params.stay;
        return {
          title: L(`NEONMARKET.Clinic.Therapy.${therapy}`),
          plan,
          fee: clinic.fees.therapy[therapy] + (stay ? clinic.fees.bed * THERAPY_NIGHTS : 0),
          apply: async (user) => {
            if (therapy === "addiction") return [L("NEONMARKET.Clinic.Result.Addiction", { name: patient.name })];
            const roll = await new Roll(THERAPY[therapy].regain).evaluate();
            const gained = await CPR.changeLedger(patient, "derivedStats.humanity", roll.total,
              L("NEONMARKET.Clinic.Ledger.Therapy", { clinic: clinic.identity.name }), user.name, { max: h.max });
            if (typeof patient.setMaxHumanity === "function") await patient.setMaxHumanity();
            const after = humanity(patient);
            return { lines: [L("NEONMARKET.Clinic.Result.Humanity", { name: patient.name, rolled: roll.total, n: gained, value: after.value, max: after.max })], rolls: [roll] };
          },
          fail: async () => [L("NEONMARKET.Clinic.Result.TherapyFailed")]
        };
      }

      case "install": {
        const item = patient.items.get(params.itemId);
        if (item?.type !== "cyberware" || item.system?.isInstalled) throw this.#error("NEONMARKET.Clinic.Error.NoCyberware");
        const location = installLocation(item);
        const plan = installPlan(clinic, item);
        if (!plan) {
          throw this.#error("NEONMARKET.Clinic.Error.WrongFacility", {
            item: item.name, need: L(`NEONMARKET.Clinic.Facility.${location}`)
          });
        }
        const targets = installTargets(patient, item);
        const target = targets.find((t) => t.id === params.targetId) ?? (targets.length === 1 ? targets[0] : null);
        if (!target) throw this.#error(targets.length ? "NEONMARKET.Clinic.Error.PickTarget" : "NEONMARKET.Clinic.Error.NoFoundation", { item: item.name });
        const lossItems = humanityItems(item);
        return {
          title: `${L("NEONMARKET.Clinic.Service.install")}: ${item.name}`,
          plan,
          fee: clinic.fees.install[location],
          apply: async () => {
            const doc = target.isActor ? patient : patient.items.get(target.id);
            if (!doc || typeof doc.installItems !== "function") throw this.#error("NEONMARKET.Clinic.Error.NoFoundation", { item: item.name });
            const ok = await doc.installItems([item]);
            if (!ok) throw this.#error("NEONMARKET.Clinic.Error.InstallFailed", { item: item.name, target: target.name });
            // CPR rolls Humanity Loss, posts its own roll cards and recalculates max Humanity and EMP.
            if (typeof patient.loseHumanityValue === "function") await patient.loseHumanityValue(lossItems, clinic.options.humanityLoss);
            return [L(target.isActor ? "NEONMARKET.Clinic.Result.Installed" : "NEONMARKET.Clinic.Result.InstalledIn", { item: item.name, target: target.name })];
          },
          fail: async () => {
            if (!clinic.options.destroyOnFailedInstall) return [L("NEONMARKET.Clinic.Result.InstallMissed", { item: item.name })];
            const ids = [item.id, ...CPR.installedChildren(item).map((c) => c.id)];
            await patient.deleteEmbeddedDocuments("Item", ids.filter((id) => patient.items.has(id)));
            return [L("NEONMARKET.Clinic.Result.Destroyed", { item: item.name })];
          }
        };
      }

      default:
        throw this.#error("NEONMARKET.Clinic.Error.NoService");
    }
  }

  /* ---------------------------------------- */
  /*  Quick Fixes                             */
  /* ---------------------------------------- */

  /**
   * A Quick Fix removes the Injury Effect for the rest of the day (p.223). The injury stays;
   * its active effects are switched off and remembered, and switched back on once the
   * world clock passes into the next day.
   */
  static async #quickFix(injury) {
    const ids = injury.effects.filter((e) => !e.disabled).map((e) => e.id);
    if (ids.length) await injury.updateEmbeddedDocuments("ActiveEffect", ids.map((_id) => ({ _id, disabled: true })));
    await injury.setFlag(MODULE_ID, QUICK_FIX_FLAG, { day: Math.floor(game.time.worldTime / DAY), effects: ids });
  }

  static async expireQuickFixes() {
    if (Compat.activeGM?.id !== game.user.id) return;
    const today = Math.floor(game.time.worldTime / DAY);
    for (const actor of game.actors) {
      for (const injury of injuries(actor)) {
        const fix = injury.getFlag(MODULE_ID, QUICK_FIX_FLAG);
        if (!fix || fix.day >= today) continue;
        const ids = (fix.effects ?? []).filter((id) => injury.effects.has(id));
        if (ids.length) await injury.updateEmbeddedDocuments("ActiveEffect", ids.map((_id) => ({ _id, disabled: false })));
        await injury.unsetFlag(MODULE_ID, QUICK_FIX_FLAG);
      }
    }
  }

  static isQuickFixed(injury) {
    return !!injury?.getFlag?.(MODULE_ID, QUICK_FIX_FLAG);
  }

  /* ---------------------------------------- */
  /*  Helpers                                 */
  /* ---------------------------------------- */

  static #error(key, data) {
    return new Error(data ? game.i18n.format(key, data) : game.i18n.localize(key));
  }
}
