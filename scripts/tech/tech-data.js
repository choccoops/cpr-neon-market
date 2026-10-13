import { MODULE_ID, THEMES, DEFAULT_THEME } from "../constants.js";

const { mergeObject, deepClone } = foundry.utils;

export const TECH_FLAG = "tech";
export const TECH_SCHEMA = 1;

/** The Tech's check bases (TECH + Skill), one per TECH skill that repairs something (CRB pp.140-142). */
export const TECH_SKILLS = ["basicTech", "cybertech", "electronics", "weaponstech", "landVehicle", "seaVehicle", "airVehicle"];

/** Maker specialties (CRB p.147). Their ranks add to the matching checks. */
export const MAKER = ["field", "upgrade", "fabrication", "invention"];

export const TECH_SERVICES = ["repair", "upgrade", "fabricate", "invent"];

/** Cyberpunk RED's price categories (CRB p.385). */
export const CATEGORIES = ["cheap", "everyday", "costly", "premium", "expensive", "veryExpensive", "luxury", "superLuxury"];

/** Vehicle damage levels for repairs (CRB p.140). */
export const VEHICLE_DAMAGE = ["minor", "major", "destroyed"];

/**
 * A complete tech shop configuration. The rulebook doesn't price an NPC Tech's time, so the labor
 * defaults are this module's: roughly a working day's pay per day of work, from the Tech Hustle table.
 */
export function defaultTech(actor) {
  const theme = THEMES[DEFAULT_THEME];
  return {
    schema: TECH_SCHEMA,
    enabled: false,
    theme: DEFAULT_THEME,
    identity: {
      name: actor?.name ?? game.i18n.localize("NEONMARKET.Tech.Default.Name"),
      subtitle: game.i18n.localize("NEONMARKET.Tech.Default.Subtitle"),
      tech: actor?.name ?? "",
      art: actor?.img ?? "",
      background: "",
      greeting: game.i18n.localize("NEONMARKET.Tech.Default.Greeting"),
      accent: theme.accent,
      accent2: theme.accent2
    },
    skills: Object.fromEntries(TECH_SKILLS.map((k) => [k, 12])),
    maker: Object.fromEntries(MAKER.map((k) => [k, 2])),
    services: Object.fromEntries(TECH_SERVICES.map((k) => [k, true])),
    fees: {
      labor: { cheap: 10, everyday: 10, costly: 20, premium: 50, expensive: 200, veryExpensive: 400, luxury: 1000, superLuxury: 2000 },
      vehicle: { minor: 50, major: 100, destroyed: 500 }
    },
    blueprints: [],
    options: {
      chargeOnFailure: false,
      feesToActor: false
    }
  };
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const fee = (v, fallback) => Math.max(0, Math.round(num(v, fallback)));

/** Fill missing fields from defaults and coerce types. */
export function normalizeTech(raw, actor) {
  const base = defaultTech(actor);
  const t = mergeObject(base, deepClone(raw ?? {}), { inplace: false, insertKeys: true });
  if (!THEMES[t.theme]) t.theme = DEFAULT_THEME;
  for (const k of TECH_SKILLS) t.skills[k] = Math.max(0, Math.round(num(t.skills[k], 12)));
  for (const k of MAKER) t.maker[k] = Math.min(10, Math.max(0, Math.round(num(t.maker[k], 0))));
  for (const k of TECH_SERVICES) t.services[k] = t.services[k] !== false;
  for (const k of CATEGORIES) t.fees.labor[k] = fee(t.fees.labor[k], base.fees.labor[k]);
  for (const k of VEHICLE_DAMAGE) t.fees.vehicle[k] = fee(t.fees.vehicle[k], base.fees.vehicle[k]);
  t.blueprints = Array.isArray(t.blueprints) ? t.blueprints.filter((b) => b?.itemData?.name) : [];
  for (const b of t.blueprints) {
    b.id ||= foundry.utils.randomID(12);
    b.category = CATEGORIES.includes(b.category) ? b.category : "";
  }
  t.options.chargeOnFailure = !!t.options.chargeOnFailure;
  t.options.feesToActor = !!t.options.feesToActor;
  return t;
}

export function getRawTech(actor) {
  return actor?.getFlag?.(MODULE_ID, TECH_FLAG) ?? null;
}

export function isTech(actor) {
  return !!getRawTech(actor)?.enabled;
}

export function getTech(actor) {
  return normalizeTech(getRawTech(actor), actor);
}

export async function saveTech(actor, tech) {
  const clean = deepClone(tech);
  clean.schema = TECH_SCHEMA;
  return actor.update({ [`flags.${MODULE_ID}.${TECH_FLAG}`]: clean });
}
