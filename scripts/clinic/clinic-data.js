import { MODULE_ID, THEMES, DEFAULT_THEME } from "../constants.js";

const { mergeObject, deepClone } = foundry.utils;

export const CLINIC_FLAG = "clinic";
export const CLINIC_SCHEMA = 1;

/** Facility levels, lowest first. A facility can do any installation at or below its level (CRB p.110). */
export const FACILITIES = ["mall", "clinic", "hospital"];

/** The doctor's check bases (STAT + Skill), one per healing skill (CRB p.223). */
export const DOCTOR_SKILLS = ["firstAid", "paramedic", "surgery", "medicalTech", "cybertech"];

/** Services a clinic can offer; each can be switched off. */
export const SERVICES = ["stabilize", "quickFix", "treatment", "rest", "cryo", "therapy", "install"];

export const THERAPIES = ["standard", "extreme", "addiction"];

/** A complete clinic configuration with every field present. Fees default to the rulebook's prices. */
export function defaultClinic(actor) {
  const theme = THEMES[DEFAULT_THEME];
  return {
    schema: CLINIC_SCHEMA,
    enabled: false,
    facility: "clinic",
    theme: DEFAULT_THEME,
    identity: {
      name: actor?.name ?? game.i18n.localize("NEONMARKET.Clinic.Default.Name"),
      subtitle: game.i18n.localize("NEONMARKET.Clinic.Default.Subtitle"),
      doctor: actor?.name ?? "",
      art: actor?.img ?? "",
      background: "",
      greeting: game.i18n.localize("NEONMARKET.Clinic.Default.Greeting"),
      accent: theme.accent,
      accent2: theme.accent2
    },
    doctor: Object.fromEntries(DOCTOR_SKILLS.map((k) => [k, 12])),
    services: Object.fromEntries(SERVICES.map((k) => [k, true])),
    fees: {
      // Hospital visit by the highest DV of stabilization or treatment (CRB p.225).
      byDv: { 10: 50, 13: 100, 15: 500, 17: 1000 },
      bed: 100,
      cryo: 100,
      therapy: { standard: 500, extreme: 1000, addiction: 1000 },
      // Installation surgery by the cyberware's typical installation (CRB p.226).
      install: { mall: 100, clinic: 500, hospital: 1000 }
    },
    options: {
      chargeOnFailure: true,
      destroyOnFailedInstall: true,
      humanityLoss: "roll",
      feesToActor: false
    }
  };
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const fee = (v, fallback) => Math.max(0, Math.round(num(v, fallback)));

/** Fill missing fields from defaults and coerce types, so templates and rules never see holes. */
export function normalizeClinic(raw, actor) {
  const base = defaultClinic(actor);
  const c = mergeObject(base, deepClone(raw ?? {}), { inplace: false, insertKeys: true });
  if (!FACILITIES.includes(c.facility)) c.facility = "clinic";
  if (!THEMES[c.theme]) c.theme = DEFAULT_THEME;
  for (const k of DOCTOR_SKILLS) c.doctor[k] = Math.max(0, Math.round(num(c.doctor[k], 12)));
  for (const k of SERVICES) c.services[k] = c.services[k] !== false;
  for (const dv of Object.keys(base.fees.byDv)) c.fees.byDv[dv] = fee(c.fees.byDv[dv], base.fees.byDv[dv]);
  c.fees.bed = fee(c.fees.bed, base.fees.bed);
  c.fees.cryo = fee(c.fees.cryo, base.fees.cryo);
  for (const k of THERAPIES) c.fees.therapy[k] = fee(c.fees.therapy[k], base.fees.therapy[k]);
  for (const k of FACILITIES) c.fees.install[k] = fee(c.fees.install[k], base.fees.install[k]);
  if (!["roll", "static"].includes(c.options.humanityLoss)) c.options.humanityLoss = "roll";
  for (const k of ["chargeOnFailure", "destroyOnFailedInstall", "feesToActor"]) c.options[k] = !!c.options[k];
  return c;
}

export function getRawClinic(actor) {
  return actor?.getFlag?.(MODULE_ID, CLINIC_FLAG) ?? null;
}

export function isClinic(actor) {
  return !!getRawClinic(actor)?.enabled;
}

export function getClinic(actor) {
  return normalizeClinic(getRawClinic(actor), actor);
}

export async function saveClinic(actor, clinic) {
  const clean = deepClone(clinic);
  clean.schema = CLINIC_SCHEMA;
  return actor.update({ [`flags.${MODULE_ID}.${CLINIC_FLAG}`]: clean });
}

/** Level of a facility or an installation: mall 0, clinic 1, hospital 2. Not applicable counts as mall. */
export function facilityRank(key) {
  const i = FACILITIES.indexOf(key);
  return i < 0 ? 0 : i;
}
