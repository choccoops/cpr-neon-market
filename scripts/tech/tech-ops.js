import { MODULE_ID } from "../constants.js";
import { Compat } from "../compat.js";
import { CPR } from "../cpr-adapter.js";
import { ShopSocket } from "../socket.js";
import { ServiceRunner } from "../services/service-runner.js";
import { getTech, saveTech, CATEGORIES, HEAT, HEATS, TUP_FITS, normalizeTup } from "./tech-data.js";
import {
  NAH_ID, VAS_ID, CATEGORY_EB, INVENTION_CATEGORIES, INVENTION_KINDS, MAKER_FLAG, UPGRADES,
  repairNeeds, repairPlan, repairFee, vasDamage, vasRepairPlan, isVasVehicle, upgradesFor, upgradePlan,
  fabricatePlan, inventPlan, lowerHumanityFormula, chanceText
} from "./tech-rules.js";
import { tupFits, tupVisible, tupInstallPlan, inventTupPlan, kitTup, kitItemData, installedRecord, rollStock } from "./tups.js";
import { formatEb } from "../shop-data.js";

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
    const service = { repair: "repair", vehicle: "repair", upgrade: "upgrade", tupInstall: "tups", tupKit: "tups", fabricate: "fabricate", invent: "invent" }[kind];
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

  /* ---------------------------------------- */
  /*  TUp stock                               */
  /* ---------------------------------------- */

  /** Roll Invented Tech Upgrades onto a tech shop's stock and tell the GMs what came up. */
  static async restock(tech, { count, replace = false } = {}) {
    const result = await rollStock(tech, { count, replace }, L);
    const esc = Handlebars.escapeExpression;
    const items = result.added.map((t) => `<li><span><b>${esc(t.name)}</b> · ${esc(L(`NEONMARKET.Tup.Heat.${t.heat}`))} · ${esc(L(`NEONMARKET.Tup.Fits.${t.fits}`))} · ${formatEb(t.cost)}</span></li>`).join("");
    const content = `<div class="neon-market-receipt nm-service-card is-success" style="--nm-accent:${esc(tech.identity.accent)}">`
      + `<header><i class="fa-solid fa-microchip"></i><div><strong>${esc(tech.identity.name)}</strong><span>${esc(L("NEONMARKET.Tup.Stock.Card", { n: result.added.length }))}</span></div></header>`
      + (items ? `<ul>${items}</ul>` : `<p>${esc(L("NEONMARKET.Tup.Stock.Nothing"))}</p>`)
      + `</div>`;
    await ChatMessage.create({ content, whisper: game.users.filter((u) => u.isGM).map((u) => u.id), rolls: result.rolls });
    return result;
  }

  /** The API's restock: rolls and saves straight onto the shop. GM only. */
  static async restockActor(actor, options = {}) {
    if (!game.user.isGM) throw ServiceRunner.error("NEONMARKET.Error.GMOnly");
    const tech = getTech(actor);
    const result = await this.restock(tech, options);
    tech.tups = result.tups;
    await saveTech(actor, tech);
    return result.added;
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

      case "tupInstall": {
        const kit = params.kitItemId ? customer.items.get(params.kitItemId) : null;
        const tup = kit ? kitTup(kit) : tech.tups.find((t) => t.id === params.tupId);
        if (!tup || (!kit && (!tup.install || !tupVisible(tup, customer, { gm: user.isGM })))) throw ServiceRunner.error("NEONMARKET.Tup.Error.Gone");
        const owner = await this.#target(params, customer, user);
        const vas = !params.itemId && isVasVehicle(owner);
        const doc = vas ? owner : owner.items.get(params.itemId);
        if (!doc) throw ServiceRunner.error("NEONMARKET.Tech.Error.NothingToUpgrade");
        if (!tupFits(tup, doc, { vas })) throw ServiceRunner.error("NEONMARKET.Tup.Error.DoesntFit", { tup: tup.name, item: doc.name });
        const plan = tupInstallPlan(tech, tup, doc, { vas, kit: !!kit });
        if (!plan) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoSkill");
        return {
          title: `${tup.name}: ${doc.name}`,
          plan: plan.check,
          fee: plan.labor,
          materials: plan.materials,
          time: timeText(plan),
          apply: async () => this.#installTup(tup, doc, { vas, kit, customer, tech })
        };
      }

      case "tupKit": {
        const tup = tech.tups.find((t) => t.id === params.tupId);
        if (!tup || !tup.kit || !tupVisible(tup, customer, { gm: user.isGM })) throw ServiceRunner.error("NEONMARKET.Tup.Error.Gone");
        return {
          title: L("NEONMARKET.Tup.KitName", { name: tup.name }),
          plan: null,
          fee: 0,
          materials: tup.cost,
          apply: async () => {
            const data = kitItemData(tup, tech.identity.name, L);
            await customer.createEmbeddedDocuments("Item", [data]);
            return [L("NEONMARKET.Tup.Result.Kit", { item: data.name, name: customer.name })];
          }
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
    if (!name || !description) throw ServiceRunner.error("NEONMARKET.Tech.Error.NeedIdea");
    if (params.inventionKind === "upgrade") return this.#inventTup(tech, shopActor, customer, { name, description }, user);
    const kind = INVENTION_KINDS[params.inventionKind] ? params.inventionKind : "gear";

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

  /**
   * An invented upgrade: the GM sets its heat (Cost #2, the DV, the time and the fee) and what it
   * goes in. On a success it joins the shop's TUps, sold only to the customer until the GM says
   * otherwise: the Tech decides who gets their babies (DLC).
   */
  static async #inventTup(tech, shopActor, customer, { name, description }, user) {
    const esc = Handlebars.escapeExpression;
    const fitsGuess = guessFits(description);
    const heatOptions = HEATS.map((h) => {
      const p = inventTupPlan(tech, fitsGuess, h);
      return `<option value="${h}"${h === "medium" ? " selected" : ""}>${esc(L(`NEONMARKET.Tup.Heat.${h}`))}: ${HEAT[h].cost}eb (DV${HEAT[h].dv}, ${esc(chanceText(p))})</option>`;
    }).join("");
    const fitsOptions = TUP_FITS.map((f) => `<option value="${f}"${f === fitsGuess ? " selected" : ""}>${esc(L(`NEONMARKET.Tup.Fits.${f}`))}</option>`).join("");
    const answer = await Compat.DialogV2.wait({
      classes: ["neon-market-dialog"],
      window: { title: L("NEONMARKET.Tech.Invent.GmTitle") },
      content: `<p>${L("NEONMARKET.Tup.Invent.GmAsk", { user: esc(user.name), actor: esc(customer.name), tech: esc(tech.identity.name) })}</p>`
        + `<p><b>${esc(name)}</b> (${esc(L("NEONMARKET.Tech.Kind.upgrade"))})</p><p>${esc(description)}</p>`
        + `<div class="form-group"><label>${L("NEONMARKET.Tup.HeatLabel")}</label><select name="heat">${heatOptions}</select></div>`
        + `<div class="form-group"><label>${L("NEONMARKET.Tup.FitsLabel")}</label><select name="fits">${fitsOptions}</select></div>`,
      buttons: [
        { action: "ok", label: L("NEONMARKET.Tech.Invent.Approve"), default: true, callback: (event, button) => ({ heat: button.form.elements.heat.value, fits: button.form.elements.fits.value }) },
        { action: "no", label: L("NEONMARKET.Tech.Invent.Deny"), callback: () => null }
      ],
      rejectClose: false
    });
    if (!answer || !HEAT[answer.heat]) throw ServiceRunner.error("NEONMARKET.Error.Denied");
    const fits = TUP_FITS.includes(answer.fits) ? answer.fits : "any";

    const plan = inventTupPlan(tech, fits, answer.heat);
    if (!plan) throw ServiceRunner.error("NEONMARKET.Tech.Error.NoSkill");
    return {
      title: `${L("NEONMARKET.Tech.Service.invent")}: ${name}`,
      plan,
      fee: plan.fee,
      time: timeText(plan),
      approve: async () => {},
      apply: async () => {
        const fresh = getTech(shopActor);
        fresh.tups.push(normalizeTup({
          name, effect: description, heat: answer.heat, fits, source: "invented", inventedFor: customer.name, onlyFor: customer.uuid
        }));
        await saveTech(shopActor, fresh);
        return [L("NEONMARKET.Tup.Result.Invented", { item: name, name: customer.name })];
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

  /** Install a TUp: record it as the item's one upgrade and write it into the item's description. */
  static async #installTup(tup, doc, { vas, kit, customer, tech }) {
    const by = tech.identity.tech || tech.identity.name;
    await doc.setFlag(MODULE_ID, MAKER_FLAG, installedRecord(tup, by));
    if (!vas && doc.system?.description) {
      const esc = Handlebars.escapeExpression;
      const line = `<p><strong>${esc(L("NEONMARKET.Tup.Installed", { name: tup.name }))}</strong> ${esc(tup.effect)}</p>`;
      await doc.update({ "system.description.value": `${line}${doc.system.description.value ?? ""}` });
    }
    const lines = [L("NEONMARKET.Tup.Result.Installed", { tup: tup.name, item: doc.name })];
    if (tup.effect) lines.push(tup.effect);
    if (kit) {
      const amount = Number(kit.system?.amount) || 1;
      if (amount > 1) await kit.update({ "system.amount": amount - 1 });
      else await customer.deleteEmbeddedDocuments("Item", [kit.id]);
      lines.push(L("NEONMARKET.Tup.Result.KitUsed", { item: kit.name }));
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

/** A first guess at what an invented upgrade goes in, from words in the pitch. The GM confirms it. */
function guessFits(text) {
  const t = String(text).toLowerCase();
  if (/\b(cyberdeck|deck)\b/.test(t)) return "cyberdeck";
  if (/\b(cyberarm|cyberleg|cyberlimb|arm|leg)\b/.test(t)) return "cyberlimb";
  if (/\b(cybereye|eye|optic)/.test(t)) return "cybereye";
  if (/\bcyber/.test(t)) return "cyberware";
  if (/\b(car|bike|truck|vehicle|av|boat|ride)\b/.test(t)) return "vehicle";
  if (/\b(armor|armour|jacket|vest|helmet|suit)\b/.test(t)) return "armor";
  if (/\b(blade|sword|knife|katana|club|bat|melee)\b/.test(t)) return "melee";
  if (/\b(gun|pistol|rifle|shotgun|smg|barrel|ammo|magazine)\b/.test(t)) return "ranged";
  return "any";
}

/** "1 week", "2 weeks", "3 months" for the chat card and the window. */
export function timeText(plan) {
  if (!plan?.time) return null;
  if (plan.time === "mo10k") return L("NEONMARKET.Tech.Time.months", { n: plan.months ?? 1 });
  const text = L(`NEONMARKET.Tech.Time.${plan.time}`);
  return plan.halved ? L("NEONMARKET.Tech.Time.Halved", { time: text }) : text;
}
