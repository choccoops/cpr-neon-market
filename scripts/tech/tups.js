import { MODULE_ID } from "../constants.js";
import { HEAT, HEATS, normalizeTup } from "./tech-data.js";
import { bestPlan } from "../services/service-rules.js";
import { KIND_SKILL, MAKER_FLAG, WORK, isGear, kindOf, vasKind, upgradePlan, hasMakerUpgrade } from "./tech-rules.js";

const { getProperty } = foundry.utils;

/**
 * Invented Tech Upgrades (TUps) an NPC Tech sells, after the Invented Tech Upgrades DLC: hire the
 * Tech to install one, or buy a materials kit and have your own Tech install it.
 *
 * Installing costs Cost #1 (the materials of any upgrade, the item's price category, CRB p.148)
 * plus Cost #2 (the invention's own materials, set by its heat), plus labor: half of both.
 */

/* ---------------------------------------- */
/*  What a TUp fits                         */
/* ---------------------------------------- */

const cyberwareType = (i) => i.type === "cyberware" ? String(i.system?.type ?? "") : "";

const FITS = {
  any: (i) => isGear(i),
  weapon: (i) => i.type === "weapon",
  melee: (i) => i.type === "weapon" && !i.system?.isRanged,
  ranged: (i) => i.type === "weapon" && !!i.system?.isRanged,
  armor: (i) => i.type === "armor",
  cyberware: (i) => i.type === "cyberware" && cyberwareType(i) !== "borgware" && !i.system?.core,
  cyberlimb: (i) => ["cyberArm", "cyberLeg"].includes(cyberwareType(i)),
  cybereye: (i) => cyberwareType(i) === "cyberEye",
  cyberdeck: (i) => i.type === "cyberdeck",
  vehicle: (i) => i.type === "vehicle",
  electronics: (i) => isGear(i) && ["electronics", "drone", "cyberdeck"].includes(kindOf(i))
};

/** Whether this TUp can go in this item or (for vehicle TUps) this VAS vehicle. One upgrade per item. */
export function tupFits(tup, doc, { vas = false } = {}) {
  if (!doc || hasMakerUpgrade(doc)) return false;
  if (vas) return tup.fits === "vehicle" || tup.fits === "any";
  if (!isGear(doc)) return false;
  return (FITS[tup.fits] ?? FITS.any)(doc);
}

/** Whether this customer may see and buy this TUp: some are only sold to whoever commissioned them. */
export function tupVisible(tup, customer, { gm = false } = {}) {
  return gm || !tup.onlyFor || tup.onlyFor === customer?.uuid;
}

/* ---------------------------------------- */
/*  Prices                                  */
/* ---------------------------------------- */

export function tupLabor(tech, cost1, cost2) {
  const labor = Math.round(((cost1 + cost2) * tech.tupFees.laborPercent) / 100);
  return Math.max(tech.tupFees.minimum, labor);
}

/**
 * Hiring the Tech to install a TUp in an item. The DLC suggests the Tech simply succeeds; with
 * that option off the Tech makes the Upgrade check at the TUp's DV. Time is the item's upgrade time.
 * `kit` is a materials kit the customer brought: Cost #2 is already paid.
 */
export function tupInstallPlan(tech, tup, doc, { vas = false, kit = false } = {}) {
  const base = upgradePlan({ ...tech, skills: alwaysAble(tech.skills) }, doc, { vas });
  const cost1 = base.materials;
  const cost2 = kit ? 0 : tup.cost;
  const labor = tupLabor(tech, cost1, tup.cost);
  let check = null;
  if (!tech.options.tupAutoSuccess) {
    check = bestPlan(tech.skills, [{ skill: KIND_SKILL[vas ? vasKind(doc) : kindOf(doc)], dv: tup.dv, bonus: tech.maker.upgrade }]);
    if (!check) return null;
  }
  return { check, kind: base.kind, category: base.category, time: base.time, months: base.months, cost1, cost2, labor, materials: cost1 + cost2 };
}

/** The upgrade plan's time and Cost #1 don't depend on the Tech's skill, so price as if able. */
function alwaysAble(skills) {
  return Object.fromEntries(Object.keys(skills).map((k) => [k, Math.max(1, skills[k])]));
}

/** The gear kind (and so the Tech skill) behind each kind of TUp. */
export const FITS_KIND = {
  any: "gear", weapon: "weapon", melee: "weapon", ranged: "weapon", armor: "armor", cyberware: "cyberware",
  cyberlimb: "cyberware", cybereye: "cyberware", cyberdeck: "cyberdeck", vehicle: "vehicleLand", electronics: "electronics"
};

/**
 * Inventing a TUp (Invention Expertise, CRB p.149): the GM sets its heat, which sets the DV, the
 * time and the Tech's fee. Unlike a new item, an upgrade can run as mild as Premium (DLC).
 */
export function inventTupPlan(tech, fits, heat) {
  const h = HEAT[heat] ?? HEAT.medium;
  const kind = FITS_KIND[fits] ?? "gear";
  const p = bestPlan(tech.skills, [{ skill: KIND_SKILL[kind], dv: h.dv, bonus: tech.maker.invention }]);
  return p && { ...p, kind, category: h.category, time: WORK[h.category].time, months: h.category === "superLuxury" ? 1 : null, fee: tech.fees.labor[h.category] };
}

/* ---------------------------------------- */
/*  Kits                                    */
/* ---------------------------------------- */

export const KIT_FLAG = "tupKit";
export const TUP_ICON = "icons/svg/upgrade.svg";

/** The TUp a materials kit carries, or null. */
export function kitTup(item) {
  const tup = getProperty(item, `flags.${MODULE_ID}.${KIT_FLAG}`);
  return tup?.name ? normalizeTup(tup) : null;
}

/** A materials kit as a CPR gear item: Cost #2 paid, Cost #1 still due when it's installed. */
export function kitItemData(tup, shopName, L) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const description = [
    `<p><strong>${esc(L("NEONMARKET.Tup.KitHeading", { name: tup.name }))}</strong></p>`,
    tup.effect ? `<p>${esc(tup.effect)}</p>` : "",
    `<p>${esc(L("NEONMARKET.Tup.KitRules", { dv: tup.dv, fits: L(`NEONMARKET.Tup.Fits.${tup.fits}`), shop: shopName }))}</p>`
  ].join("");
  return {
    name: L("NEONMARKET.Tup.KitName", { name: tup.name }),
    type: "gear",
    img: TUP_ICON,
    system: { price: { market: tup.cost }, description: { value: description } },
    flags: { [MODULE_ID]: { [KIT_FLAG]: { ...tup, onlyFor: "" }, source: shopName } }
  };
}

/** What an installed TUp leaves on the item: the Maker upgrade flag and a line in its description. */
export function installedRecord(tup, techName) {
  return { upgrade: "invented", note: tup.effect, tup: { name: tup.name, heat: tup.heat, key: tup.key }, by: techName, at: Date.now() };
}

export { MAKER_FLAG };

/* ---------------------------------------- */
/*  Stock generator                         */
/* ---------------------------------------- */

/** d10 on the heat scale: mostly mild and medium, Diablo on a 10. */
export const HEAT_ROLL = [
  { max: 3, heat: "mild" },
  { max: 6, heat: "medium" },
  { max: 8, heat: "hot" },
  { max: 9, heat: "extraHot" },
  { max: 10, heat: "diablo" }
];

/** The heat a d10 gives, no hotter than the shop stocks. */
export function heatFor(d10, maxHeat = "diablo") {
  const rolled = (HEAT_ROLL.find((r) => d10 <= r.max) ?? HEAT_ROLL.at(-1)).heat;
  const cap = Math.max(0, HEATS.indexOf(maxHeat));
  return HEATS[Math.min(HEATS.indexOf(rolled), cap)];
}

/**
 * Pre-made TUps for the generator, by heat. Names and effects are in lang/en.json under
 * NEONMARKET.Tup.Table. Effects are deliberately short rules text for the GM to adjudicate.
 */
export const TUP_TABLE = {
  mild: [
    { key: "chromeEtching", fits: "any" },
    { key: "glowSights", fits: "ranged" },
    { key: "quickStraps", fits: "armor" },
    { key: "moodFinish", fits: "cyberware" },
    { key: "serialScrub", fits: "weapon" },
    { key: "dashJukebox", fits: "vehicle" },
    { key: "whisperMode", fits: "electronics" }
  ],
  medium: [
    { key: "foldingFrame", fits: "ranged" },
    { key: "extendedFeed", fits: "ranged" },
    { key: "flexWeave", fits: "armor" },
    { key: "jamGuard", fits: "weapon" },
    { key: "twinRail", fits: "ranged" },
    { key: "limbLocker", fits: "cyberlimb" },
    { key: "longBarrel", fits: "ranged" }
  ],
  hot: [
    { key: "blastPlates", fits: "armor" },
    { key: "fieldFriendly", fits: "any" },
    { key: "burstGovernor", fits: "ranged" },
    { key: "overpressure", fits: "ranged" },
    { key: "instinctOverlay", fits: "cybereye" },
    { key: "compactMounts", fits: "cyberlimb" },
    { key: "crashCage", fits: "vehicle" }
  ],
  extraHot: [
    { key: "ghostReflex", fits: "cyberware" },
    { key: "pneumaticStride", fits: "cyberlimb" },
    { key: "metabolicBuffer", fits: "cyberware" },
    { key: "muscleMemory", fits: "cyberware" },
    { key: "rotaryFeed", fits: "ranged" }
  ],
  diablo: [
    { key: "neuralOverclock", fits: "cyberware" },
    { key: "tandemTrigger", fits: "ranged" },
    { key: "aegisWeave", fits: "armor" }
  ]
};

/** A table entry as a TUp for sale, at its heat's price and DV. */
export function tableTup(heat, entry, L) {
  return normalizeTup({
    key: entry.key,
    name: L(`NEONMARKET.Tup.Table.${entry.key}.Name`),
    effect: L(`NEONMARKET.Tup.Table.${entry.key}.Effect`),
    heat,
    fits: entry.fits,
    source: "rolled"
  });
}

/**
 * Roll new stock: for each pick, a d10 for heat, then a die for which TUp of that heat. A shop
 * doesn't stock the same TUp twice; if a heat has nothing left, the pick goes a heat cooler.
 * Returns the new TUps and the rolls (for the chat card).
 */
export async function rollStock(tech, { count, replace = false } = {}, L) {
  const keep = replace ? tech.tups.filter((t) => t.source !== "rolled") : [...tech.tups];
  const have = new Set(keep.map((t) => t.key).filter(Boolean));
  const picks = [];
  const rolls = [];
  const n = Math.max(1, Math.min(12, Math.round(Number(count ?? tech.generator.count) || 1)));
  for (let i = 0; i < n; i++) {
    const heatRoll = await new Roll("1d10").evaluate();
    rolls.push(heatRoll);
    let heat = heatFor(heatRoll.total, tech.generator.maxHeat);
    let pool = TUP_TABLE[heat].filter((e) => !have.has(e.key));
    while (!pool.length && HEATS.indexOf(heat) > 0) {
      heat = HEATS[HEATS.indexOf(heat) - 1];
      pool = TUP_TABLE[heat].filter((e) => !have.has(e.key));
    }
    if (!pool.length) break;
    const pickRoll = await new Roll(`1d${pool.length}`).evaluate();
    rolls.push(pickRoll);
    const entry = pool[Math.min(pool.length, Math.max(1, pickRoll.total)) - 1];
    have.add(entry.key);
    picks.push(tableTup(heat, entry, L));
  }
  return { tups: [...keep, ...picks], added: picks, rolls };
}

export { HEAT, HEATS };
