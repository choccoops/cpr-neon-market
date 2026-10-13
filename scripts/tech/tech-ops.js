import { MODULE_ID } from "../constants.js";
import { Compat } from "../compat.js";
import { CPR } from "../cpr-adapter.js";
import { ShopSocket } from "../socket.js";
import { ServiceRunner } from "../services/service-runner.js";
import { getTech, saveTech, CATEGORIES } from "./tech-data.js";
import {
  NAH_ID, VAS_ID, CATEGORY_EB, INVENTION_CATEGORIES, INVENTION_KINDS, MAKER_FLAG, UPGRADES,
  repairNeeds, repairPlan, repairFee, vasDamage, vasRepairPlan, isVasVehicle, upgradesFor, upgradePlan,
  fabricatePlan, inventPlan, lowerHumanityFormula, chanceText
} from "./tech-rules.js";

const { deepClone, randomID } = foundry.utils;
const L = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** Neon At Home's API, when it's active: it owns item condition (Breaking Your Stuff). */
export function nahApi() {
  const mod = game.modules.get(NAH_ID);
  return mod?.active && typeof mod.api?.setCondition === "function" ? mod.api : null;
}

export function vasActive() {
  return !!game.modules.get(VAS_ID)?.active;
}

/**
 * Tech shop jobs, run only on the active GM client. Each job is planned here; ServiceRunner prices
 * it, gets it approved, rolls for the Tech, charges the customer and applies it.
 */
export class TechOps {
  static init() {
    ShopSocket.register("tech", (payload, user) => this.run(payload, user));
  }

  static async run({ kind, customerUuid, shopUuid, params = {} }, user) {
    const customer = await fromUuid(customerUuid);
    const shopActor = await fromUuid(shopUuid);
    if (!(customer instanceof Actor) || !(shopActor instanceof Actor)) throw ServiceRunner.error("NEONMARKET.Error.BadActor");
    if (!user.isGM && !customer.testUserPermission(user, "OWNER")) throw ServiceRunner.error("NEONMARKET.Error.NotOwner");

    const tech = getTech(shopActor);
    if (!tech.enabled && !user.isGM) throw ServiceRunner.error("NEONMARKET.Tech.Error.Closed");
    const service = { repair: "repair", vehicle: "repair", upgrade: "upgrade", fabricate: "fabricate", invent: "invent" }[kind];
    if (!service || !tech.services[service]) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoService");

    const job = kind === "invent"
      ? await this.#invention(tech, shopActor, customer, params, user)
      : await this.#plan(kind, tech, shopActor, customer, params, user);
    if (job.plan) job.plan.label = L(`NEONMARKET.Tech.Skill.${job.plan.skill}`);
    return ServiceRunner.run({
      user,
      customer,
      venueActor: shopActor,
      venue: {
        name: tech.identity.name,
        staff: tech.identity.tech,
        accent: tech.identity.accent,
        icon: "fa-solid fa-screwdriver-wrench",
        chargeOnFailure: tech.options.chargeOnFailure,
        feesToActor: tech.options.feesToActor,
        labels: { customer: "NEONMARKET.Tech.Card.Customer", staff: "NEONMARKET.Tech.Card.Tech" }
      },
      job
    });
  }

  /** The actor a job works on: the customer, or a vehicle the user owns. */
  static async #target(params, customer, user) {
    if (!params.actorUuid || params.actorUuid === customer.uuid) return customer;
    const actor = await fromUuid(params.actorUuid);
    if (!(actor instanceof Actor)) throw ServiceRunner.error("NEONMARKET.Error.BadActor");
    if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw ServiceRunner.error("NEONMARKET.Error.NotOwner");
    return actor;
  }

  static async #plan(kind, tech, shopActor, customer, params, user) {
    switch (kind) {
      case "repair": {
        const owner = await this.#target(params, customer, user);
        const item = owner.items.get(params.itemId);
        const needs = item && repairNeeds(item, { nah: !!nahApi() });
        if (!needs) throw ServiceRunner.error("NEONMARKET.Tech.Error.NothingToRepair");
        if (needs.beyondRepair) throw ServiceRunner.error("NEONMARKET.Tech.Error.BeyondRepair", { item: item.name });
        const plan = repairPlan(tech, item, { vehicleDamage: params.vehicleDamage });
        if (!plan) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoSkill");
        return {
          title: `${L("NEONMARKET.Tech.Service.repair")}: ${item.name}`,
          plan,
          fee: repairFee(tech, plan),
          time: timeText(plan),
          apply: async () => this.#repairItem(owner, item, needs)
        };
      }

      case "vehicle": {
        const vehicle = await this.#target(params, customer, user);
        if (!isVasVehicle(vehicle)) throw ServiceRunner.error("NEONMARKET.Error.BadActor");
        const damage = vasDamage(vehicle);
        if (!damage) throw ServiceRunner.error("NEONMARKET.Tech.Error.NothingToRepair");
        const plan = vasRepairPlan(tech, vehicle, damage.level);
        if (!plan) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoSkill");
        return {
          title: `${L("NEONMARKET.Tech.Service.repair")}: ${vehicle.name}`,
          plan,
          fee: tech.fees.vehicle[damage.level],
          time: timeText(plan),
          apply: async (u) => this.#repairVehicle(vehicle, damage, tech, u)
        };
      }

      case "upgrade": {
        const owner = await this.#target(params, customer, user);
        const vas = !params.itemId && isVasVehicle(owner);
        const doc = vas ? owner : owner.items.get(params.itemId);
        if (!doc) throw ServiceRunner.error("NEONMARKET.Tech.Error.NothingToUpgrade");
        const options = upgradesFor(doc, { vas });
        const option = params.upgrade;
        if (!options.includes(option)) throw ServiceRunner.error("NEONMARKET.Tech.Error.CantUpgrade", { item: doc.name });
        const note = String(params.note ?? "").trim().slice(0, 300);
        if (!UPGRADES[option].auto && !note) throw ServiceRunner.error("NEONMARKET.Tech.Error.NeedNote");
        const plan = upgradePlan(tech, doc, { vas });
        if (!plan) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoSkill");
        return {
          title: `${L(`NEONMARKET.Tech.Upgrade.${option}`)}: ${doc.name}`,
          plan,
          fee: plan.fee,
          materials: plan.materials,
          time: timeText(plan),
          apply: async () => this.#upgrade(doc, option, note, tech)
        };
      }

      case "fabricate": {
        const blueprint = tech.blueprints.find((b) => b.id === params.blueprintId);
        if (!blueprint) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoBlueprint");
        const plan = fabricatePlan(tech, blueprint);
        if (!plan) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoSkill");
        return {
          title: `${L("NEONMARKET.Tech.Service.fabricate")}: ${blueprint.itemData.name}`,
          plan,
          fee: plan.fee,
          materials: plan.materials,
          time: timeText(plan),
          apply: async () => {
            const data = deepClone(blueprint.itemData);
            delete data._id;
            foundry.utils.setProperty(data, `flags.${MODULE_ID}.source`, tech.identity.name);
            await customer.createEmbeddedDocuments("Item", [data]);
            return [L("NEONMARKET.Tech.Result.Fabricated", { item: data.name, name: customer.name })];
          }
        };
      }

      default:
        throw ServiceRunner.error("NEONMARKET.Tech.Error.NoService");
    }
  }

  /* ---------------------------------------- */
  /*  Invention                               */
  /* ---------------------------------------- */

  /**
   * The GM always decides an invention: whether it's workable and its price category (p.149).
   * That decision is the approval, so it happens before pricing.
   */
  static async #invention(tech, shopActor, customer, params, user) {
    const name = String(params.name ?? "").trim().slice(0, 80);
    const description = String(params.description ?? "").trim().slice(0, 2000);
    const kind = INVENTION_KINDS[params.inventionKind] ? params.inventionKind : "gear";
    if (!name || !description) throw ServiceRunner.error("NEONMARKET.Tech.Error.NeedIdea");

    const esc = Handlebars.escapeExpression;
    const options = INVENTION_CATEGORIES.map((c) => {
      const p = inventPlan(tech, kind, c);
      return `<option value="${c}">${esc(L(`NEONMARKET.Tier.${c.charAt(0).toUpperCase()}${c.slice(1)}`))} (DV${p?.dv ?? "?"}, ${esc(chanceText(p))})</option>`;
    }).join("");
    const category = await Compat.DialogV2.wait({
      classes: ["neon-market-dialog"],
      window: { title: L("NEONMARKET.Tech.Invent.GmTitle") },
      content: `<p>${L("NEONMARKET.Tech.Invent.GmAsk", { user: esc(user.name), actor: esc(customer.name), tech: esc(tech.identity.name) })}</p>`
        + `<p><b>${esc(name)}</b> (${esc(L(`NEONMARKET.Tech.Kind.${kind}`))})</p><p>${esc(description)}</p>`
        + `<div class="form-group"><label>${L("NEONMARKET.Tech.Invent.Category")}</label><select name="category">${options}</select></div>`,
      buttons: [
        { action: "ok", label: L("NEONMARKET.Tech.Invent.Approve"), default: true, callback: (event, button) => button.form.elements.category.value },
        { action: "no", label: L("NEONMARKET.Tech.Invent.Deny"), callback: () => null }
      ],
      rejectClose: false
    });
    if (!category || !CATEGORIES.includes(category)) throw ServiceRunner.error("NEONMARKET.Error.Denied");

    const plan = inventPlan(tech, kind, category);
    if (!plan) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoSkill");
    return {
      title: `${L("NEONMARKET.Tech.Service.invent")}: ${name}`,
      plan,
      fee: plan.fee,
      time: timeText(plan),
      approve: async () => {},
      apply: async () => {
        const fresh = getTech(shopActor);
        const itemData = {
          name,
          type: INVENTION_KINDS[kind],
          system: { price: { market: CATEGORY_EB[category] }, description: { value: `<p>${esc(description)}</p>` } }
        };
        fresh.blueprints.push({ id: randomID(12), itemData, category, inventedFor: customer.name });
        await saveTech(shopActor, fresh);
        return [L("NEONMARKET.Tech.Result.Invented", { item: name })];
      }
    };
  }

  /* ---------------------------------------- */
  /*  Applying results                        */
  /* ---------------------------------------- */

  /** Back to perfect condition: Neon At Home's condition and malfunction, and armor's SP and shield HP. */
  static async #repairItem(owner, item, needs) {
    const lines = [];
    const nah = nahApi();
    if (nah && (needs.condition || needs.malfunction)) {
      // Passing a cause makes Neon At Home write even when only a malfunction is being cleared.
      await nah.setCondition(owner, item.id, "", { cause: "" });
      lines.push(L("NEONMARKET.Tech.Result.Working", { item: item.name }));
    }
    if (needs.ablation || needs.shield) {
      await this.#restoreArmor(owner, item);
      lines.push(L("NEONMARKET.Tech.Result.ArmorRestored", { item: item.name }));
    }
    return lines;
  }

  static async #restoreArmor(owner, item) {
    const update = {};
    if (item.system?.bodyLocation) update["system.bodyLocation.ablation"] = 0;
    if (item.system?.headLocation) update["system.headLocation.ablation"] = 0;
    const shieldMax = Number(item.system?.shieldHitPoints?.max) || 0;
    if (shieldMax) update["system.shieldHitPoints.value"] = shieldMax;
    await item.update(update);
    // The worn armor's SP is mirrored on the actor (CPR and MMuton's vehicle sheet both read it).
    const ext = owner.system?.externalData ?? {};
    const sync = {};
    if (ext.currentArmorBody?.id === item.id) sync["system.externalData.currentArmorBody.value"] = Number(item.system.bodyLocation?.sp) || 0;
    if (ext.currentArmorHead?.id === item.id) sync["system.externalData.currentArmorHead.value"] = Number(item.system.headLocation?.sp) || 0;
    if (Object.keys(sync).length) await owner.update(sync);
  }

  /** A VAS vehicle to perfect condition: full SDP, armor, bulletproof glass, no critical injuries. */
  static async #repairVehicle(vehicle, damage, tech, user) {
    const lines = [];
    if (damage.hp.value < damage.hp.max) {
      await CPR.changeLedger(vehicle, "derivedStats.hp", damage.hp.max - damage.hp.value,
        L("NEONMARKET.Tech.Ledger.Repaired", { shop: tech.identity.name }), user.name);
      lines.push(L("NEONMARKET.Tech.Result.Sdp", { name: vehicle.name, max: damage.hp.max }));
    }
    for (const armor of damage.armor) await this.#restoreArmor(vehicle, armor);
    if (damage.armor.length) lines.push(L("NEONMARKET.Tech.Result.Plating", { name: vehicle.name }));
    if (damage.glass.length) {
      const positions = deepClone(vehicle.getFlag(VAS_ID, "positions") ?? []);
      for (const p of positions) if (p.bulletproofGlass) p.glassHp = p.glassHpMax;
      await vehicle.setFlag(VAS_ID, "positions", positions);
      lines.push(L("NEONMARKET.Tech.Result.Glass"));
    }
    if (damage.injuries.length) {
      await vehicle.deleteEmbeddedDocuments("Item", damage.injuries.map((i) => i.id));
      lines.push(L("NEONMARKET.Tech.Result.VehicleInjuries", { list: damage.injuries.map((i) => i.name).join(", ") }));
    }
    return lines;
  }

  static async #upgrade(doc, option, note, tech) {
    const lines = [];
    const rolls = [];
    const s = doc.system ?? {};
    switch (option) {
      case "humanity": {
        const roll = await new Roll("1d6").evaluate();
        rolls.push(roll);
        const before = String(s.humanityLoss?.roll ?? "");
        await doc.update({
          "system.humanityLoss.roll": lowerHumanityFormula(before, roll.total),
          "system.humanityLoss.static": Math.max(0, (Number(s.humanityLoss?.static) || 0) - roll.total)
        });
        lines.push(L("NEONMARKET.Tech.Result.Humanity", { item: doc.name, n: roll.total, formula: lowerHumanityFormula(before, roll.total) }));
        break;
      }
      case "slot":
        await doc.update({ "system.installedItems.slots": (Number(s.installedItems?.slots) || 0) + 1 });
        lines.push(L("NEONMARKET.Tech.Result.Slot", { item: doc.name, n: (Number(s.installedItems?.slots) || 0) + 1 }));
        break;
      case "conceal":
        await doc.update({ "system.concealable.concealable": true });
        lines.push(L("NEONMARKET.Tech.Result.Conceal", { item: doc.name }));
        break;
      case "quality":
        await doc.update({ "system.quality": "excellent" });
        lines.push(L("NEONMARKET.Tech.Result.Quality", { item: doc.name }));
        break;
      case "sp": {
        const update = {};
        if ((Number(s.bodyLocation?.sp) || 0) > 0) update["system.bodyLocation.sp"] = Number(s.bodyLocation.sp) + 1;
        if ((Number(s.headLocation?.sp) || 0) > 0) update["system.headLocation.sp"] = Number(s.headLocation.sp) + 1;
        await doc.update(update);
        lines.push(L("NEONMARKET.Tech.Result.Sp", { item: doc.name }));
        break;
      }
      case "simplify":
        lines.push(L("NEONMARKET.Tech.Result.Simplify", { item: doc.name }));
        break;
      default:
        lines.push(L("NEONMARKET.Tech.Result.Noted", { item: doc.name, note }));
    }
    await doc.setFlag(MODULE_ID, MAKER_FLAG, { upgrade: option, note, by: tech.identity.tech || tech.identity.name, at: Date.now() });
    return { lines, rolls };
  }
}

/** "1 week", "2 weeks", "3 months" for the chat card and the window. */
export function timeText(plan) {
  if (!plan?.time) return null;
  if (plan.time === "mo10k") return L("NEONMARKET.Tech.Time.months", { n: plan.months ?? 1 });
  const text = L(`NEONMARKET.Tech.Time.${plan.time}`);
  return plan.halved ? L("NEONMARKET.Tech.Time.Halved", { time: text }) : text;
}
