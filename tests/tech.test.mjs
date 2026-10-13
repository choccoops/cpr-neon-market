import { dice, MockActor, register, eq, throws, done, load, player, setModule, dialogAnswers } from "./helpers/foundry.mjs";

const T = await load("scripts/tech/tech-rules.js");
const D = await load("scripts/tech/tech-data.js");
const { TechOps } = await load("scripts/tech/tech-ops.js");
const MODULE = "cpr-neon-market";
const NAH = "cpr-neon-at-home";
const VAS = "mmutons-cyberpunk-red-vas";

// Neon At Home's API: record what the shop asks it to do.
const nahCalls = [];
setModule(NAH, {
  active: true,
  api: {
    setCondition: async (actor, itemId, condition, opts) => {
      nahCalls.push([actor.id, itemId, condition, opts]);
      const item = actor.items.get(itemId);
      item.flags[NAH] = { item: { condition, malfunction: null } };
    }
  }
});

/* ---------- rules ---------- */

const tech = D.normalizeTech({ skills: { basicTech: 12, cybertech: 13, electronics: 11, weaponstech: 14, landVehicle: 12, seaVehicle: 0, airVehicle: 10 }, maker: { field: 2, upgrade: 3, fabrication: 1, invention: 2 } }, null);
eq("categories by price", [0, 10, 20, 50, 100, 500, 1000, 5000, 20000].map(T.categoryOf),
  ["cheap", "cheap", "everyday", "costly", "premium", "expensive", "veryExpensive", "luxury", "superLuxury"]);
eq("repair DVs by category (p.140)", ["cheap", "costly", "premium", "expensive", "veryExpensive", "luxury"].map((c) => T.WORK[c].dv), [9, 13, 17, 21, 24, 29]);

const pistol = { name: "Heavy Pistol", type: "weapon", system: { price: { market: 100 }, handsReq: 1, quality: "standard", concealable: { concealable: false } } };
eq("weapons are Weaponstech", T.kindOf(pistol), "weapon");
eq("Neon At Home's kind override wins", T.kindOf({ ...pistol, flags: { [NAH]: { item: { maint: { kind: "electronics" } } } } }), "electronics");
eq("an AV is an air vehicle", T.kindOf({ name: "AV-4", type: "vehicle", system: {} }), "vehicleAir");

const damaged = { ...pistol, flags: { [NAH]: { item: { condition: "damaged" } } } };
eq("Damaged gear needs repair", T.repairNeeds(damaged).condition, "damaged");
eq("hidden damage stays hidden", T.repairNeeds({ ...pistol, flags: { [NAH]: { item: { condition: "damaged", hidden: true } } } }), null);
eq("Neon At Home off: nothing to repair", T.repairNeeds(damaged, { nah: false }), null);
eq("beyond repair is flagged", T.repairNeeds({ ...pistol, flags: { [NAH]: { item: { condition: "dbr" } } } }).beyondRepair, true);
const jacket = { name: "Light Armorjack", type: "armor", system: { price: { market: 100 }, bodyLocation: { sp: 11, ablation: 3 }, headLocation: { sp: 0, ablation: 0 } } };
eq("ablated armor needs repair", T.repairNeeds(jacket).ablation, 3);

const rp = T.repairPlan(tech, damaged);
eq("pistol repair: Weaponstech 14 + Field 2 vs DV17, a day", [rp.skill, rp.base, rp.dv, rp.time], ["weaponstech", 16, 17, "1d"]);
eq("labor for a Premium repair", T.repairFee(tech, rp), 50);
eq("vehicle repair by damage", [T.repairPlan(tech, { name: "Truck", type: "vehicle", system: {} }, { vehicleDamage: "minor" }).dv, T.VEHICLE_WORK.destroyed.dv], [9, 17]);
eq("no sea skill, no sea repair", T.repairPlan(tech, { name: "Speedboat", type: "vehicle", system: {} }), null);

eq("upgrades for a standard one-handed pistol", T.upgradesFor(pistol), ["simplify", "conceal", "quality", "exoticSlot", "exoticAmmo", "invented"]);
const arm = { name: "Cyberarm", type: "cyberware", system: { type: "cyberArm", isInstalled: false, humanityLoss: { roll: "2d6", static: 7 }, installedItems: { slots: 4, allowed: true }, price: { market: 500 } } };
eq("cyberarm can lose Humanity Loss and gain a slot", T.upgradesFor(arm).slice(0, 3), ["humanity", "slot", "simplify"]);
eq("1d6 Humanity Loss can't be lowered", T.upgradesFor({ ...arm, system: { ...arm.system, humanityLoss: { roll: "1d6" } } }).includes("humanity"), false);
eq("one Maker upgrade per item", T.upgradesFor({ ...pistol, flags: { [MODULE]: { maker: { upgrade: "quality" } } } }), []);
eq("lower formula", ["2d6", "2d6+1", "3d6-1"].map((f) => T.lowerHumanityFormula(f, 3)), ["2d6-3", "2d6-2", "3d6-4"]);
const up = T.upgradePlan(tech, arm);
eq("upgrade a 500eb cyberarm: Cybertech 13 + 3 vs DV21, 500eb materials", [up.base, up.dv, up.materials, up.fee], [16, 21, 500, 200]);

eq("fabrication materials one category lower", [[100, "premium"], [500, "expensive"], [10, "cheap"], [20000, "superLuxury"]].map(([p, c]) => T.fabricationMaterials(p, c)), [50, 100, 5, 10000]);
const fp = T.fabricatePlan(tech, { itemData: pistol });
eq("fabricate a pistol", [fp.base, fp.dv, fp.materials, fp.fee], [15, 17, 50, 50]);

const vas = { name: "Thorton Mackinaw", flags: { core: { sheetClass: `${VAS}.VehicleSheet` }, [VAS]: { positions: [{ skills: "Drive Land Vehicle, Evasion" }] } } };
eq("VAS vehicle detected, land", [T.isVasVehicle(vas), T.vasKind(vas)], [true, "vehicleLand"]);
eq("VAS air by pilot skill", T.vasKind({ name: "Car", flags: { [VAS]: { positions: [{ skills: "Pilot Air Vehicle" }] } } }), "vehicleAir");

/* ---------- jobs ---------- */

function setup(overrides = {}) {
  const shop = new MockActor({ id: "shop", name: "Torch", wealth: 0 });
  shop.flags[MODULE] = { tech: foundry.utils.mergeObject({ enabled: true, skills: tech.skills, maker: tech.maker }, overrides) };
  const customer = new MockActor({ id: "pc", name: "V" });
  register(shop, customer);
  return { shop, customer };
}
const run = (kind, customer, shop, params = {}, user = player) =>
  TechOps.run({ kind, customerUuid: customer.uuid, shopUuid: shop.uuid, params }, user);

{
  const { shop, customer } = setup();
  customer.add({ id: "gun", ...damaged, flags: { [NAH]: { item: { condition: "destroyed", malfunction: { table: "weapon" } } } } });
  dice.push(5);
  const r = await run("repair", customer, shop, { itemId: "gun" });
  eq("repair through Neon At Home", [r.success, nahCalls.at(-1)], [true, ["pc", "gun", "", { cause: "" }]]);
  eq("labor charged", customer.system.wealth.value, 4950);
}
{
  const { shop, customer } = setup();
  customer.add({ id: "gun", ...damaged });
  dice.push(1, 5);
  const r = await run("repair", customer, shop, { itemId: "gun" });
  eq("failed repair: nothing charged by default", [r.success, customer.system.wealth.value], [false, 5000]);
}
{
  const { shop, customer } = setup();
  customer.add({ id: "dbr", ...pistol, flags: { [NAH]: { item: { condition: "dbr" } } } });
  await throws("beyond repair", () => run("repair", customer, shop, { itemId: "dbr" }), "BeyondRepair");
}
{
  const { shop, customer } = setup();
  const vest = customer.add({ id: "vest", ...jacket, system: { ...jacket.system, bodyLocation: { sp: 11, ablation: 3 } } });
  customer.system.externalData.currentArmorBody = { id: "vest", value: 8, max: 11 };
  dice.push(6);
  await run("repair", customer, shop, { itemId: "vest" });
  eq("armor SP restored, worn SP synced", [vest.system.bodyLocation.ablation, customer.system.externalData.currentArmorBody.value], [0, 11]);
}
{
  const { shop, customer } = setup();
  const car = new MockActor({ id: "car", name: "Mackinaw", hp: [10, 50], flags: { core: { sheetClass: `${VAS}.VehicleSheet` }, [VAS]: { positions: [{ id: "d", skills: "Drive Land Vehicle", bulletproofGlass: true, glassHp: 2, glassHpMax: 10 }] } } });
  car.add({ id: "plate", name: "Plating", type: "armor", system: { bodyLocation: { sp: 13, ablation: 4 } } });
  car.add({ id: "crit", name: "Engine Damage", type: "criticalInjury", system: {} });
  register(shop, customer, car);
  eq("vehicle at 10/50 SDP is Major damage", T.vasDamage(car).level, "major");
  dice.push(5);
  const r = await run("vehicle", customer, shop, { actorUuid: car.uuid });
  eq("vehicle repaired to perfect", [r.success, car.system.derivedStats.hp.value, car.items.get("plate").system.bodyLocation.ablation, car.flags[VAS].positions[0].glassHp, car.items.has("crit")], [true, 50, 0, 10, false]);
  eq("Major vehicle labor", customer.system.wealth.value, 4900);
  car.owner = false;
  car.system.derivedStats.hp.value = 1;
  await throws("someone else's vehicle", () => run("vehicle", customer, shop, { actorUuid: car.uuid }), "NotOwner");
}
{
  const { shop, customer } = setup();
  const gun = customer.add({ id: "gun", ...pistol });
  dice.push(9);
  await run("upgrade", customer, shop, { itemId: "gun", upgrade: "quality" });
  eq("Excellent quality, upgrade recorded", [gun.system.quality, gun.flags[MODULE].maker.upgrade], ["excellent", "quality"]);
  eq("materials + labor for a Premium upgrade", customer.system.wealth.value, 5000 - 100 - 50);
  await throws("only one upgrade", () => run("upgrade", customer, shop, { itemId: "gun", upgrade: "conceal" }), "CantUpgrade");
}
{
  const { shop, customer } = setup();
  const cw = customer.add({ id: "arm", ...arm });
  dice.push(9, 4);
  await run("upgrade", customer, shop, { itemId: "arm", upgrade: "humanity" });
  eq("Humanity Loss lowered by the 1d6", [cw.system.humanityLoss.roll, cw.system.humanityLoss.static], ["2d6-4", 3]);
}
{
  const { shop, customer } = setup();
  customer.add({ id: "gun", ...pistol });
  await throws("narrative upgrades need a description", () => run("upgrade", customer, shop, { itemId: "gun", upgrade: "exoticAmmo" }), "NeedNote");
}
{
  const { shop, customer } = setup({ blueprints: [{ id: "bp1", itemData: pistol }] });
  dice.push(1, 2);
  let r = await run("fabricate", customer, shop, { blueprintId: "bp1" });
  eq("failed fabrication: materials kept, nothing made", [r.success, customer.system.wealth.value, customer.items.size], [false, 5000, 0]);
  dice.push(8);
  r = await run("fabricate", customer, shop, { blueprintId: "bp1" });
  eq("fabricated, materials + labor charged", [r.success, customer.system.wealth.value, customer.items.size], [true, 4900, 1]);
}
{
  const { shop, customer } = setup();
  dialogAnswers.push("expensive");
  dice.push(9);
  const r = await run("invent", customer, shop, { name: "Smart Knuckles", inventionKind: "weapon", description: "Brass knuckles that ping your Agent." });
  const bp = shop.flags[MODULE].tech.blueprints.at(-1);
  eq("invention becomes a blueprint", [r.success, bp.itemData.name, bp.itemData.type, bp.category, bp.itemData.system.price.market], [true, "Smart Knuckles", "weapon", "expensive", 500]);
  eq("invention labor", customer.system.wealth.value, 4800);
  dialogAnswers.push(null);
  await throws("GM turns an idea down", () => run("invent", customer, shop, { name: "Perpetual motion", description: "x" }), "Denied");
}
{
  const { shop, customer } = setup({ enabled: false });
  customer.add({ id: "gun", ...damaged });
  await throws("closed shop", () => run("repair", customer, shop, { itemId: "gun" }), "Closed");
}

done("tech");
