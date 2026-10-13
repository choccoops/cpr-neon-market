import { bestPlan } from "../services/service-rules.js";
import { CATEGORIES } from "./tech-data.js";

const { getProperty } = foundry.utils;

/**
 * Cyberpunk RED's Tech rules as data: repairs (CRB p.140), the Maker specialties and the
 * Upgrade/Fabricate/Invent table (pp.147-149). Reads documents and returns plain values.
 */

export const NAH_ID = "cpr-neon-at-home";
export const VAS_ID = "mmutons-cyberpunk-red-vas";

/** Market price of each category (p.385). */
export const CATEGORY_EB = { cheap: 10, everyday: 20, costly: 50, premium: 100, expensive: 500, veryExpensive: 1000, luxury: 5000, superLuxury: 10000 };

/**
 * DV and time for a full repair, an upgrade, a fabrication or an invention, by price category
 * (pp.140, 148). Super Luxury takes a month per 10,000eb of the item's price.
 */
export const WORK = {
  cheap: { dv: 9, time: "1h" },
  everyday: { dv: 9, time: "1h" },
  costly: { dv: 13, time: "6h" },
  premium: { dv: 17, time: "1d" },
  expensive: { dv: 21, time: "1w" },
  veryExpensive: { dv: 24, time: "2w" },
  luxury: { dv: 29, time: "1mo" },
  superLuxury: { dv: 29, time: "mo10k" }
};

/** Vehicle repairs by damage (p.140). */
export const VEHICLE_WORK = {
  minor: { dv: 9, time: "3h" },
  major: { dv: 13, time: "1d" },
  destroyed: { dv: 17, time: "1w" }
};

/** Kinds of gear and the skill that repairs each, the same as Neon At Home's maintenance kinds. */
export const KIND_SKILL = {
  armor: "basicTech",
  cyberdeck: "electronics",
  cyberware: "cybertech",
  drone: "electronics",
  gear: "basicTech",
  electronics: "electronics",
  vehicleAir: "airVehicle",
  vehicleLand: "landVehicle",
  vehicleSea: "seaVehicle",
  weapon: "weaponstech"
};

/** Item types that are never repaired, upgraded or made here. */
const NOT_GEAR = new Set(["ammo", "drug", "program", "netarch", "criticalInjury", "role", "skill"]);

/* ---------------------------------------- */
/*  Price categories                        */
/* ---------------------------------------- */

export function marketPrice(itemLike) {
  return Math.max(0, Math.round(Number(getProperty(itemLike, "system.price.market")) || 0));
}

/** The dearest category a price reaches; anything cheaper than 10eb is Cheap. */
export function categoryOf(price) {
  let at = "cheap";
  for (const key of CATEGORIES) if (price >= CATEGORY_EB[key]) at = key;
  return at;
}

export function categoryIndex(key) {
  return Math.max(0, CATEGORIES.indexOf(key));
}

/** Super Luxury work takes a month per 10,000eb: how many months for this price. */
export function superLuxuryMonths(price) {
  return Math.max(1, Math.ceil((Number(price) || 0) / 10000));
}

/* ---------------------------------------- */
/*  Kinds and skills                        */
/* ---------------------------------------- */

const lname = (doc) => String(doc?.name ?? "").toLowerCase();

function vehicleKindByName(n) {
  if (/\b(av|aerodyne|aerozep|heli|helicopter|gyro|plane|jet|vtol|airship|zeppelin)\b/.test(n)) return "vehicleAir";
  if (/\b(boat|ship|yacht|jetski|jet ski|sub|submarine|hovercraft|speedboat|sea)\b/.test(n)) return "vehicleSea";
  return "vehicleLand";
}

/** What kind of gear an item is, honoring the GM's per-item override in Neon At Home. */
export function kindOf(item) {
  const override = getProperty(item, `flags.${NAH_ID}.item.maint.kind`);
  if (KIND_SKILL[override]) return override;
  const s = item?.system ?? {};
  switch (item?.type) {
    case "weapon": return "weapon";
    case "armor": return "armor";
    case "cyberdeck": return "cyberdeck";
    case "cyberware": return "cyberware";
    case "vehicle": return vehicleKindByName(lname(item));
    case "itemUpgrade":
      return { weapon: "weapon", armor: "armor", cyberdeck: "cyberdeck", cyberware: "cyberware", vehicle: "vehicleLand" }[s.type] ?? "gear";
    default:
      if (/\bdrone\b/.test(lname(item))) return "drone";
      return s.isElectronic ? "electronics" : "gear";
  }
}

export function isGear(item) {
  if (!item || NOT_GEAR.has(item.type)) return false;
  return !(item.type === "cyberware" && item.system?.core);
}

/* ---------------------------------------- */
/*  Vehicle actors (MMuton's VAS)           */
/* ---------------------------------------- */

export function isVasVehicle(actor) {
  const sheet = getProperty(actor, "flags.core.sheetClass") ?? "";
  return String(sheet).startsWith(`${VAS_ID}.`) || Array.isArray(getProperty(actor, `flags.${VAS_ID}.positions`));
}

/** Land, sea or air: from the pilot skills on the vehicle's positions, else its name. */
export function vasKind(actor) {
  const skills = (getProperty(actor, `flags.${VAS_ID}.positions`) ?? []).map((p) => String(p.skills ?? "")).join(" ");
  if (/air vehicle/i.test(skills)) return "vehicleAir";
  if (/sea vehicle/i.test(skills)) return "vehicleSea";
  if (/land vehicle/i.test(skills)) return "vehicleLand";
  return vehicleKindByName(lname(actor));
}

const int = (v) => Math.trunc(Number(v) || 0);

/** What a VAS vehicle needs: lost SDP, ablated armor, damaged glass, critical injuries. */
export function vasDamage(actor) {
  const hp = { value: int(getProperty(actor, "system.derivedStats.hp.value")), max: int(getProperty(actor, "system.derivedStats.hp.max")) };
  const items = Array.from(actor?.items ?? []);
  const armor = items.filter((i) => i.type === "armor" && armorAblation(i) > 0);
  const glass = (getProperty(actor, `flags.${VAS_ID}.positions`) ?? []).filter((p) => p.bulletproofGlass && int(p.glassHp) < int(p.glassHpMax));
  const injuries = items.filter((i) => i.type === "criticalInjury");
  const hurt = hp.value < hp.max;
  if (!hurt && !armor.length && !glass.length && !injuries.length) return null;
  const level = hp.value <= 0 ? "destroyed" : hp.value < Math.ceil(hp.max / 2) ? "major" : "minor";
  return { level, hp, armor, glass, injuries };
}

/* ---------------------------------------- */
/*  What an item needs                      */
/* ---------------------------------------- */

/** Neon At Home's record of an item: condition, malfunction, whether the damage is hidden. */
export function nahState(item) {
  const f = getProperty(item, `flags.${NAH_ID}.item`) ?? {};
  const condition = ["damaged", "destroyed", "dbr"].includes(f.condition) ? f.condition : f.cyberState === "broken" ? "destroyed" : "";
  return { condition, hidden: !!f.hidden, malfunction: !!f.malfunction };
}

export function armorAblation(item) {
  return int(getProperty(item, "system.bodyLocation.ablation")) + int(getProperty(item, "system.headLocation.ablation"));
}

function shieldDamage(item) {
  const max = int(getProperty(item, "system.shieldHitPoints.max"));
  return max > 0 ? max - int(getProperty(item, "system.shieldHitPoints.value")) : 0;
}

/**
 * What a piece of gear needs from a repair, or null. Neon At Home's condition only counts when
 * it's active; hidden damage stays hidden until someone inspects it there.
 */
export function repairNeeds(item, { nah = true } = {}) {
  if (!isGear(item)) return null;
  const state = nah ? nahState(item) : { condition: "", hidden: false, malfunction: false };
  const condition = state.hidden && state.condition === "damaged" ? "" : state.condition;
  const ablation = item.type === "armor" ? armorAblation(item) : 0;
  const shield = item.type === "armor" ? shieldDamage(item) : 0;
  if (!condition && !state.malfunction && !ablation && !shield) return null;
  return { condition, malfunction: state.malfunction, ablation, shield, beyondRepair: condition === "dbr" };
}

/* ---------------------------------------- */
/*  Plans                                   */
/* ---------------------------------------- */

const plan = (tech, skill, dv, bonus) => bestPlan(tech.skills, [{ skill, dv, bonus }]);

/** A full repair of a piece of gear: its repair skill + Field Expertise at the category's DV (pp.140, 147). */
export function repairPlan(tech, item, { vehicleDamage = "major" } = {}) {
  const kind = kindOf(item);
  const skill = KIND_SKILL[kind];
  // A Simplify upgrade halves the time of any future full repair (p.148).
  const halved = getProperty(item, `flags.cpr-neon-market.${MAKER_FLAG}.upgrade`) === "simplify";
  if (item.type === "vehicle") {
    const level = VEHICLE_WORK[vehicleDamage] ? vehicleDamage : "major";
    const p = plan(tech, skill, VEHICLE_WORK[level].dv, tech.maker.field);
    return p && { ...p, time: VEHICLE_WORK[level].time, kind, level, halved };
  }
  const price = marketPrice(item);
  const cat = categoryOf(price);
  const p = plan(tech, skill, WORK[cat].dv, tech.maker.field);
  return p && { ...p, time: WORK[cat].time, months: cat === "superLuxury" ? superLuxuryMonths(price) : null, kind, category: cat, halved };
}

/** "73%", or a dash when the Tech can't do it. */
export function chanceText(p) {
  return p ? `${Math.round(p.chance * 100)}%` : "—";
}

export function vasRepairPlan(tech, actor, level) {
  const kind = vasKind(actor);
  const p = plan(tech, KIND_SKILL[kind], VEHICLE_WORK[level].dv, tech.maker.field);
  return p && { ...p, time: VEHICLE_WORK[level].time, kind, level };
}

/** Labor for a repair of this category or vehicle damage level. */
export function repairFee(tech, repair) {
  if (repair.level) return tech.fees.vehicle[repair.level];
  const fee = tech.fees.labor[repair.category];
  return repair.months ? fee * repair.months : fee;
}

/* ---------------------------------------- */
/*  Upgrades (Upgrade Expertise, p.148)     */
/* ---------------------------------------- */

const HL_DICE = /^(\d+)d6\b/i;

/**
 * The upgrades Upgrade Expertise grants. `auto` ones change the item; the rest are recorded on it
 * for the GM (CPR has no field for them). Each item can only benefit from one.
 */
export const UPGRADES = {
  humanity: {
    auto: true,
    // non-borgware cyberware whose Humanity Loss is 2d6 or more, not installed yet
    fits: (i) => i.type === "cyberware" && i.system?.type !== "borgware" && !i.system?.isInstalled
      && Number(HL_DICE.exec(String(i.system?.humanityLoss?.roll ?? ""))?.[1] ?? 0) >= 2
  },
  slot: { auto: true, fits: (i) => Number.isFinite(Number(i.system?.installedItems?.slots)) && i.system?.installedItems?.allowed !== false },
  simplify: { auto: true, fits: (i) => isGear(i) },
  conceal: { auto: true, fits: (i) => i.type === "weapon" && Number(i.system?.handsReq) === 1 && !i.system?.concealable?.concealable },
  quality: { auto: true, fits: (i) => i.type === "weapon" && i.system?.quality === "standard" },
  sp: { auto: true, fits: (i) => i.type === "armor" && (int(i.system?.bodyLocation?.sp) > 0 || int(i.system?.headLocation?.sp) > 0) },
  exoticSlot: { auto: false, fits: (i) => i.type === "weapon" },
  exoticAmmo: { auto: false, fits: (i) => i.type === "weapon" },
  vehicle: { auto: false, fits: (i) => i.type === "vehicle" },
  invented: { auto: false, fits: (i) => isGear(i) }
};

export const MAKER_FLAG = "maker";

export function hasMakerUpgrade(doc) {
  return !!getProperty(doc, `flags.cpr-neon-market.${MAKER_FLAG}.upgrade`);
}

/** Upgrades this item or vehicle can take. A VAS vehicle only takes the Nomad vehicle upgrade. */
export function upgradesFor(doc, { vas = false } = {}) {
  if (hasMakerUpgrade(doc)) return [];
  if (vas) return ["vehicle", "invented"];
  return Object.entries(UPGRADES).filter(([, u]) => u.fits(doc)).map(([k]) => k);
}

/** Upgrade check, materials and labor (p.148). Vehicle upgrades count as Very Expensive. */
export function upgradePlan(tech, doc, { vas = false } = {}) {
  const kind = vas ? vasKind(doc) : kindOf(doc);
  const cat = vas || doc.type === "vehicle" ? "veryExpensive" : categoryOf(marketPrice(doc));
  const p = plan(tech, KIND_SKILL[kind], WORK[cat].dv, tech.maker.upgrade);
  if (!p) return null;
  const months = cat === "superLuxury" ? superLuxuryMonths(marketPrice(doc)) : null;
  return {
    ...p, kind, category: cat, time: WORK[cat].time, months,
    materials: CATEGORY_EB[cat],
    fee: months ? tech.fees.labor[cat] * months : tech.fees.labor[cat]
  };
}

/** A Humanity Loss formula lowered by a rolled amount: "2d6" → "2d6-3", "2d6+1" → "2d6-2". */
export function lowerHumanityFormula(formula, by) {
  const m = /^(\d+d6)\s*([+-]\s*\d+)?\s*$/i.exec(String(formula).trim());
  if (!m) return formula;
  const mod = (Number(String(m[2] ?? "0").replace(/\s/g, "")) || 0) - by;
  return mod ? `${m[1]}${mod > 0 ? "+" : ""}${mod}` : m[1];
}

/* ---------------------------------------- */
/*  Fabrication and invention (p.148)       */
/* ---------------------------------------- */

/**
 * Materials to fabricate an item: one price category lower (Super Luxury: half its price).
 * The rulebook's own example puts a Cheap item at 5eb.
 */
export function fabricationMaterials(price, category) {
  if (category === "superLuxury") return Math.round(price / 2);
  const i = categoryIndex(category);
  return i === 0 ? 5 : CATEGORY_EB[CATEGORIES[i - 1]];
}

export function fabricatePlan(tech, blueprint) {
  const data = blueprint.itemData;
  const price = marketPrice(data);
  const cat = blueprint.category || categoryOf(price);
  const kind = kindOf(data);
  const p = plan(tech, KIND_SKILL[kind], WORK[cat].dv, tech.maker.fabrication);
  if (!p) return null;
  const months = cat === "superLuxury" ? superLuxuryMonths(price) : null;
  return {
    ...p, kind, category: cat, time: WORK[cat].time, months,
    materials: fabricationMaterials(price || CATEGORY_EB[cat], cat),
    fee: months ? tech.fees.labor[cat] * months : tech.fees.labor[cat]
  };
}

/** Invention: the GM sets the price category, Expensive at the least (p.149). */
export const INVENTION_CATEGORIES = ["expensive", "veryExpensive", "luxury", "superLuxury"];

/** Kinds an invention can be, and the CPR item type each becomes. */
export const INVENTION_KINDS = {
  gear: "gear", electronics: "gear", weapon: "weapon", armor: "armor", cyberware: "cyberware",
  cyberdeck: "cyberdeck", vehicleLand: "vehicle", vehicleSea: "vehicle", vehicleAir: "vehicle", drone: "gear"
};

export function inventPlan(tech, kind, category) {
  const cat = INVENTION_CATEGORIES.includes(category) ? category : "expensive";
  const p = plan(tech, KIND_SKILL[kind] ?? "basicTech", WORK[cat].dv, tech.maker.invention);
  return p && { ...p, kind, category: cat, time: WORK[cat].time, fee: tech.fees.labor[cat] };
}
