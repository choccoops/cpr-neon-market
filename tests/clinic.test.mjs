import { dice, chat, MockActor, register, eq, throws, done, load, player } from "./helpers/foundry.mjs";

const R = await load("scripts/clinic/clinic-rules.js");
const D = await load("scripts/clinic/clinic-data.js");
const { ClinicOps } = await load("scripts/clinic/clinic-ops.js");
const MODULE = "cpr-neon-market";

/* ---------- rules ---------- */

const clinic = D.normalizeClinic({ facility: "clinic", doctor: { firstAid: 10, paramedic: 14, surgery: 16, medicalTech: 12, cybertech: 0 } }, null);
eq("default fees by DV", clinic.fees.byDv, { 10: 50, 13: 100, 15: 500, 17: 1000 });
eq("bad facility falls back", D.normalizeClinic({ facility: "moon" }, null).facility, "clinic");
eq("negative fee clamps", D.normalizeClinic({ fees: { bed: -5 } }, null).fees.bed, 0);
eq("fees by DV", [10, 13, 15, 17, 21].map((dv) => R.feeForDv(clinic, dv)), [50, 100, 500, 1000, 1000]);

eq("chance base 5 vs DV10", R.chance(5, 10), 0.5);
eq("chance base 10 vs DV10 (only a natural 1 loses)", R.chance(10, 10), 0.9);
eq("chance base 30 vs DV10", R.chance(30, 10), 1);
dice.push(10, 4);
eq("crit success", await R.rollCheck(5, 15).then((r) => [r.total, r.success]), [19, true]);
dice.push(1, 6);
eq("crit failure", await R.rollCheck(14, 10).then((r) => [r.total, r.success]), [9, false]);
dice.push(5);
eq("tie fails", (await R.rollCheck(10, 15)).success, false);

const hpActor = (value, max) => ({ system: { derivedStats: { hp: { value, max } } } });
eq("wound states", [[0, 40], [19, 40], [39, 40], [40, 40]].map(([v, m]) => R.woundState(hpActor(v, m))),
  ["mortallyWounded", "seriouslyWounded", "lightlyWounded", "notWounded"]);

const brokenArm = { name: "Broken Arm", system: { quickFix: { type: "paramedic", dvFirstAid: 0, dvParamedic: 13 }, treatment: { type: "paramedicSurgery", dvParamedic: 15, dvSurgery: 13 } } };
const lostArm = { name: "Dismembered Arm", system: { quickFix: { type: "notApplicable" }, treatment: { type: "surgery", dvSurgery: 17 } } };
eq("treatment picks the better odds", [R.treatmentPlan(clinic, brokenArm).skill, R.treatmentPlan(clinic, brokenArm).dv], ["surgery", 13]);
eq("no quick fix for a lost arm", R.quickFixPlan(clinic, lostArm), null);
const mall = D.normalizeClinic({ facility: "mall", doctor: clinic.doctor }, null);
eq("mall can't do surgery", R.treatmentPlan(mall, lostArm), null);
eq("clinic can't install hospital cyberware", R.installPlan(clinic, { system: { installLocation: "hospital" } }), null);
eq("not applicable installs as mall", R.installPlan(clinic, { system: { installLocation: "notApplicable" } }).dv, 13);

/* ---------- procedures ---------- */

function setup(overrides = {}, patientOpts = {}) {
  const clinicActor = new MockActor({ id: "doc", name: "Doc", wealth: 0 });
  clinicActor.flags[MODULE] = { clinic: foundry.utils.mergeObject({ enabled: true, facility: "clinic", doctor: clinic.doctor }, overrides) };
  const patient = new MockActor({ id: "pc", name: "V", ...patientOpts });
  register(clinicActor, patient);
  return { clinicActor, patient };
}
const run = (kind, patient, clinicActor, params = {}, user = player) =>
  ClinicOps.run({ kind, patientUuid: patient.uuid, clinicUuid: clinicActor.uuid, params }, user);

{
  const { clinicActor, patient } = setup({}, { hp: [-3, 40] });
  dice.push(5);
  const r = await run("stabilize", patient, clinicActor);
  eq("stabilize: charged, 1 HP, penalty reset", [r.success, patient.system.wealth.value, patient.system.derivedStats.hp.value, patient.system.derivedStats.deathSave.penalty], [true, 4500, 1, 0]);
  eq("chat card carries the roll", chat.at(-1).rolls.length, 1);
}
{
  const { clinicActor, patient } = setup({}, { hp: [-3, 40] });
  dice.push(1, 3);
  const r = await run("stabilize", patient, clinicActor);
  eq("failed stabilize still charged by default", [r.success, patient.system.wealth.value], [false, 4500]);
  const s2 = setup({ options: { chargeOnFailure: false } }, { hp: [-3, 40] });
  dice.push(1, 3);
  await run("stabilize", s2.patient, s2.clinicActor);
  eq("no charge on failure when off", s2.patient.system.wealth.value, 5000);
}
{
  const { clinicActor, patient } = setup({}, { hp: [-3, 40], wealth: 100 });
  await throws("can't afford", () => run("stabilize", patient, clinicActor), "NotEnoughFunds");
}
{
  const { clinicActor, patient } = setup();
  const arm = patient.add({ id: "inj1", name: "Broken Arm", type: "criticalInjury", system: brokenArm.system });
  dice.push(6);
  await run("quickFix", patient, clinicActor, { injuryId: "inj1" });
  eq("quick fix flags the injury for today", arm.getFlag(MODULE, "quickFix")?.day, 3);
  dice.push(6);
  await run("treatment", patient, clinicActor, { injuryId: "inj1" });
  eq("treatment removes it", patient.items.has("inj1"), false);
}
{
  const { clinicActor, patient } = setup({}, { hp: [20, 40] });
  await run("rest", patient, clinicActor, { days: 2 });
  eq("bed rest heals BODY a day", patient.system.derivedStats.hp.value, 32);
  dice.push(5);
  await run("cryo", patient, clinicActor, { days: 1 });
  eq("cryotank heals double, capped", patient.system.derivedStats.hp.value, 40);
}
{
  const { clinicActor, patient } = setup({}, { humanity: [40, 50] });
  dice.push(7, 12);
  await run("therapy", patient, clinicActor, { therapy: "standard" });
  eq("therapy regains up to max", patient.system.derivedStats.humanity.value, 50);
}
{
  const { clinicActor, patient } = setup();
  patient.add({ id: "cw1", name: "Cyberarm", type: "cyberware", system: { installLocation: "clinic", isFoundational: true, isInstalled: false } });
  dice.push(5);
  await run("install", patient, clinicActor, { itemId: "cw1" });
  eq("install through CPR, Humanity rolled", [patient.installed, patient.lossMode], [["cw1"], "roll"]);
  const s2 = setup();
  s2.patient.add({ id: "cw2", name: "Cyberarm", type: "cyberware", system: { installLocation: "clinic", isFoundational: true, isInstalled: false } });
  dice.push(1, 3);
  await run("install", s2.patient, s2.clinicActor, { itemId: "cw2" });
  eq("failed install destroys the cyberware", s2.patient.items.has("cw2"), false);
  const s3 = setup();
  s3.patient.add({ id: "cw3", name: "Cyberarm", type: "cyberware", system: { installLocation: "clinic", isFoundational: true, isInstalled: false } });
  s3.patient.installItems = async () => false;
  dice.push(9);
  await throws("an install that won't fit", () => run("install", s3.patient, s3.clinicActor, { itemId: "cw3" }), "InstallFailed");
  eq("is refunded", s3.patient.system.wealth.value, 5000);
}
{
  const { clinicActor, patient } = setup();
  const inj = patient.add({ id: "inj9", name: "Concussion", type: "criticalInjury", system: {}, flags: { [MODULE]: { quickFix: { day: 2, effects: [] } } } });
  game.actors = [patient];
  await ClinicOps.expireQuickFixes();
  eq("yesterday's quick fix expires", inj.getFlag(MODULE, "quickFix"), undefined);
}

done("clinic");
