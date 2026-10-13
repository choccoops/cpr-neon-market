import { facilityRank } from "./clinic-data.js";

const { getProperty } = foundry.utils;

/**
 * Cyberpunk RED healing rules, as data. Page numbers are the Core Rulebook's.
 * Everything here reads documents and returns plain values; nothing writes.
 */

/** Stabilization DV by wound state (p.222). */
export const STABILIZE_DV = { lightlyWounded: 10, seriouslyWounded: 13, mortallyWounded: 15 };

/** Installation surgery DV by the cyberware's typical installation (p.226). */
export const INSTALL_DV = { mall: 13, clinic: 15, hospital: 17 };

/** Cryotank operation (p.353). */
export const CRYO_DV = 13;

/** Therapies (p.230): Medical Tech DV and the Humanity regained on success. */
export const THERAPY = {
  standard: { dv: 15, regain: "2d6" },
  extreme: { dv: 17, regain: "4d6" },
  addiction: { dv: 15, regain: null }
};

/** A therapy takes one week (p.229). */
export const THERAPY_NIGHTS = 7;

/* ---------------------------------------- */
/*  Patients                                */
/* ---------------------------------------- */

export function hp(actor) {
  return {
    value: Math.trunc(Number(getProperty(actor, "system.derivedStats.hp.value")) || 0),
    max: Math.trunc(Number(getProperty(actor, "system.derivedStats.hp.max")) || 0)
  };
}

export function humanity(actor) {
  return {
    value: Math.trunc(Number(getProperty(actor, "system.derivedStats.humanity.value")) || 0),
    max: Math.trunc(Number(getProperty(actor, "system.derivedStats.humanity.max")) || 0)
  };
}

export function body(actor) {
  return Math.max(0, Math.trunc(Number(getProperty(actor, "system.stats.body.value")) || 0));
}

/** CPR's own wound state when it has one, otherwise worked out from HP the same way (p.220). */
export function woundState(actor) {
  const state = actor?.getWoundState?.() ?? getProperty(actor, "system.derivedStats.currentWoundState");
  if (state && state !== "invalidState") return state;
  const { value, max } = hp(actor);
  if (value < 1) return "mortallyWounded";
  if (value < Math.ceil(max / 2)) return "seriouslyWounded";
  if (value < max) return "lightlyWounded";
  return "notWounded";
}

export function injuries(actor) {
  return actor?.itemTypes?.criticalInjury ?? actor?.items?.filter((i) => i.type === "criticalInjury") ?? [];
}

/* ---------------------------------------- */
/*  Fees                                    */
/* ---------------------------------------- */

/** Hospital fee for a procedure of this DV: the highest table row at or below it (p.225). */
export function feeForDv(clinic, dv) {
  const rows = Object.keys(clinic.fees.byDv).map(Number).sort((a, b) => a - b);
  let price = clinic.fees.byDv[rows[0]];
  for (const row of rows) if (dv >= row) price = clinic.fees.byDv[row];
  return price;
}

/* ---------------------------------------- */
/*  Checks                                  */
/* ---------------------------------------- */

/**
 * Chance that base + 1d10 beats the DV, with CPR criticals: a 10 adds a second d10,
 * a 1 subtracts one (p.130). Ties fail (p.129).
 */
export function chance(base, dv) {
  let wins = 0;
  for (let first = 1; first <= 10; first++) {
    if (first === 1 || first === 10) {
      for (let second = 1; second <= 10; second++) {
        const total = base + first + (first === 10 ? second : -second);
        if (total > dv) wins += 1;
      }
    } else if (base + first > dv) {
      wins += 10;
    }
  }
  return wins / 100;
}

/** Roll base + 1d10 against a DV, CPR style. Returns the rolls too, so the chat card can carry them. */
export async function rollCheck(base, dv) {
  const first = await new Roll("1d10").evaluate();
  const rolls = [first];
  let crit = 0;
  if (first.total === 10 || first.total === 1) {
    const second = await new Roll("1d10").evaluate();
    rolls.push(second);
    crit = first.total === 10 ? second.total : -second.total;
  }
  const total = base + first.total + crit;
  return { base, dv, die: first.total, crit, total, success: total > dv, rolls };
}

/**
 * The doctor's best way to do a procedure. Each candidate is a skill and a DV;
 * the one with the best odds wins. Skills the doctor lacks (base 0) are skipped.
 */
function best(clinic, candidates) {
  const usable = candidates
    .filter((c) => c.dv > 0 && (Number(clinic.doctor[c.skill]) || 0) > 0)
    .map((c) => ({ ...c, base: clinic.doctor[c.skill], chance: chance(clinic.doctor[c.skill], c.dv) }));
  usable.sort((a, b) => b.chance - a.chance || a.dv - b.dv);
  return usable[0] ?? null;
}

/** Surgery needs at least a clinic: malls don't have surgeons (p.110). */
function surgeryHere(clinic) {
  return facilityRank(clinic.facility) >= facilityRank("clinic");
}

/** Damage to cyberware that replaced a body part is fixed with Cybertech at the listed DV (p.223). */
function asCybertech(candidates) {
  const dvs = candidates.map((c) => c.dv).filter((dv) => dv > 0);
  return dvs.length ? [{ skill: "cybertech", dv: Math.min(...dvs) }] : [];
}

/** How the clinic would Quick Fix this injury, or null if it can't (p.221). */
export function quickFixPlan(clinic, injury, { cyber = false } = {}) {
  const q = injury.system?.quickFix ?? {};
  let candidates = [];
  if (q.type === "firstAidParamedic") candidates = [{ skill: "firstAid", dv: q.dvFirstAid }, { skill: "paramedic", dv: q.dvParamedic }];
  else if (q.type === "paramedic") candidates = [{ skill: "paramedic", dv: q.dvParamedic }];
  if (cyber) candidates = asCybertech(candidates);
  const plan = best(clinic, candidates.map((c) => ({ ...c, dv: Number(c.dv) || 0 })));
  if (!plan) return null;
  // Injuries whose Treatment is "Quick Fix" are healed for good by one (p.221).
  return { ...plan, permanent: injury.system?.treatment?.type === "quickFix" };
}

/** How the clinic would Treat this injury, or null if it can't (p.221). */
export function treatmentPlan(clinic, injury, { cyber = false } = {}) {
  const t = injury.system?.treatment ?? {};
  let candidates = [];
  if (t.type === "paramedicSurgery") {
    candidates = [{ skill: "paramedic", dv: t.dvParamedic }];
    if (surgeryHere(clinic)) candidates.push({ skill: "surgery", dv: t.dvSurgery });
  } else if (t.type === "surgery" && surgeryHere(clinic)) {
    candidates = [{ skill: "surgery", dv: t.dvSurgery }];
  }
  if (cyber) candidates = asCybertech(candidates);
  return best(clinic, candidates.map((c) => ({ ...c, dv: Number(c.dv) || 0 })));
}

export function stabilizePlan(clinic, actor) {
  const dv = STABILIZE_DV[woundState(actor)];
  if (!dv) return null;
  return best(clinic, [{ skill: "firstAid", dv }, { skill: "paramedic", dv }]);
}

export function cryoPlan(clinic) {
  return best(clinic, [{ skill: "medicalTech", dv: CRYO_DV }]);
}

export function therapyPlan(clinic, kind) {
  const t = THERAPY[kind];
  return t ? best(clinic, [{ skill: "medicalTech", dv: t.dv }]) : null;
}

/* ---------------------------------------- */
/*  Cyberware                               */
/* ---------------------------------------- */

export function installLocation(item) {
  const loc = item?.system?.installLocation;
  return INSTALL_DV[loc] ? loc : "mall";
}

/** Cyberware this patient carries but hasn't had put in. Upgrades inside other items are excluded. */
export function installable(actor) {
  return (actor?.itemTypes?.cyberware ?? []).filter((i) => !i.system?.isInstalled && !i.system?.core);
}

export function installPlan(clinic, item) {
  const loc = installLocation(item);
  if (facilityRank(loc) > facilityRank(clinic.facility)) return null;
  return best(clinic, [{ skill: "surgery", dv: INSTALL_DV[loc] }]);
}

/**
 * Where a piece of cyberware can go, mirroring CPRActor.installCyberware: the actor itself
 * for foundational cyberware, otherwise an installed foundational piece of the same type
 * (or an option inside one, like a chipware socket) with room for it.
 */
export function installTargets(actor, item) {
  if (item.system?.isFoundational) return [{ id: actor.id, name: actor.name, isActor: true }];
  const foundations = actor.itemTypes.cyberware.filter((cw) =>
    cw.system.isInstalled && cw.system.isFoundational && cw.system.type === item.system.type);
  const targets = [];
  for (const base of foundations) {
    const fits = (doc) => doc.system.installedItems?.allowed !== false
      && (doc.system.installedItems?.allowedTypes ?? []).includes(item.type)
      && (typeof doc.availableInstallSlots !== "function" || doc.availableInstallSlots() >= (item.system.size ?? 1));
    // Like CPR, the foundational piece itself is always offered; installItems() checks its slots.
    targets.push({ id: base.id, name: base.name });
    let ids = [...(base.system.installedItems?.list ?? [])];
    while (ids.length) {
      const next = [];
      for (const id of ids) {
        const child = actor.items.get(id);
        if (!child?.system?.installedItems) continue;
        if (child.system.installedItems.allowed && fits(child)) targets.push({ id: child.id, name: child.name });
        next.push(...(child.system.installedItems.list ?? []));
      }
      ids = next;
    }
  }
  return targets;
}

/** The cyberware being installed plus any cyberware already inside it: all of it costs Humanity. */
export function humanityItems(item) {
  const inside = typeof item.recursiveGetAllInstalledItems === "function"
    ? item.recursiveGetAllInstalledItems().filter((i) => i.type === "cyberware")
    : [];
  return [item, ...inside];
}
