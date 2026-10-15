import { dice, chat, MockActor, register, eq, throws, done, load, player, dialogAnswers } from "./helpers/foundry.mjs";

const U = await load("scripts/tech/tups.js");
const D = await load("scripts/tech/tech-data.js");
const { TechOps } = await load("scripts/tech/tech-ops.js");
const MODULE = "cpr-neon-market";
const VAS = "mmutons-cyberpunk-red-vas";
const L = (k) => k;

/* ---------- rules ---------- */

const skills = { basicTech: 12, cybertech: 13, electronics: 11, weaponstech: 14, landVehicle: 12, seaVehicle: 0, airVehicle: 10 };
const maker = { field: 2, upgrade: 3, fabrication: 1, invention: 2 };
const tech = D.normalizeTech({ skills, maker }, null);

eq("heat by d10", [1, 3, 4, 6, 7, 8, 9, 10].map((n) => U.heatFor(n)), ["mild", "mild", "medium", "medium", "hot", "hot", "extraHot", "diablo"]);
eq("heat capped at the shop's hottest", [U.heatFor(10, "hot"), U.heatFor(2, "hot")], ["hot", "mild"]);
eq("heat sets Cost #2 and DV (DLC thermometer)", D.HEATS.map((h) => [D.HEAT[h].cost, D.HEAT[h].dv]), [[100, 17], [500, 21], [1000, 24], [5000, 29], [10000, 29]]);
const hot = D.normalizeTup({ name: "Overpressure", heat: "hot", fits: "ranged" });
eq("a TUp starts at its heat's price and DV", [hot.cost, hot.dv, hot.install, hot.kit], [1000, 24, true, true]);
eq("a TUp needs a name", D.normalizeTup({ name: " " }), null);

const pistol = { name: "Heavy Pistol", type: "weapon", system: { price: { market: 100 }, isRanged: true } };
const knife = { name: "Knife", type: "weapon", system: { price: { market: 50 }, isRanged: false } };
const arm = { name: "Cyberarm", type: "cyberware", system: { type: "cyberArm", price: { market: 500 } } };
eq("ranged TUp fits a pistol, not a knife", [U.tupFits(hot, pistol), U.tupFits(hot, knife)], [true, false]);
eq("cyberlimb TUp fits a cyberarm", U.tupFits(D.normalizeTup({ name: "x", fits: "cyberlimb" }), arm), true);
eq("one upgrade per item", U.tupFits(hot, { ...pistol, flags: { [MODULE]: { maker: { upgrade: "quality" } } } }), false);
const car = { name: "Mackinaw", flags: { [VAS]: { positions: [{ skills: "Drive Land Vehicle" }] } } };
eq("vehicle TUps go on VAS vehicles", [U.tupFits(D.normalizeTup({ name: "x", fits: "vehicle" }), car, { vas: true }), U.tupFits(hot, car, { vas: true })], [true, false]);

let p = U.tupInstallPlan(tech, hot, pistol);
eq("install in a 100eb pistol: Cost #1 100 + Cost #2 1000 + half as labor, a day, no check", [p.cost1, p.cost2, p.labor, p.materials, p.time, p.check], [100, 1000, 550, 1100, "1d", null]);
p = U.tupInstallPlan(tech, hot, pistol, { kit: true });
eq("with a kit: no Cost #2, same labor", [p.cost2, p.labor, p.materials], [0, 550, 100]);
p = U.tupInstallPlan({ ...tech, options: { ...tech.options, tupAutoSuccess: false } }, hot, pistol);
eq("checks on: Weaponstech 14 + Upgrade 3 vs DV24", [p.check.skill, p.check.base, p.check.dv], ["weaponstech", 17, 24]);
eq("minimum labor", U.tupInstallPlan({ ...tech, tupFees: { laborPercent: 50, minimum: 600 } }, hot, pistol).labor, 600);
p = U.inventTupPlan(tech, "ranged", "mild");
eq("inventing a mild TUp: Weaponstech + Invention vs DV17, Premium labor", [p.base, p.dv, p.fee, p.time], [16, 17, 50, "1d"]);

/* ---------- stock generator ---------- */

{
  const t = D.normalizeTech({ skills, maker, generator: { count: 2, maxHeat: "hot" }, tups: [{ name: "Mine", source: "custom" }, { name: "Old", key: "glowSights", source: "rolled" }] }, null);
  dice.push(1, 1, 10, 1);
  const r = await U.rollStock(t, { replace: true }, L);
  eq("reroll keeps custom stock, rolls a mild and a capped hot", r.tups.map((x) => [x.name, x.heat, x.source]), [
    ["Mine", "medium", "custom"],
    ["NEONMARKET.Tup.Table.chromeEtching.Name", "mild", "rolled"],
    ["NEONMARKET.Tup.Table.blastPlates.Name", "hot", "rolled"]
  ]);
  dice.push(1, 1);
  const again = await U.rollStock({ ...t, tups: r.tups }, { count: 1 }, L);
  eq("no duplicates: the next mild is picked from what's left", again.added[0].key, "glowSights");
  dice.push(2, 1, 5, 2);
  const restocked = await TechOps.restock(t, { count: 2 });
  eq("restock posts a GM-only card with the rolls", [restocked.added.length, chat.at(-1).whisper, chat.at(-1).rolls.length], [2, ["gm"], 4]);
}

/* ---------- jobs ---------- */

function setup(overrides = {}) {
  const shop = new MockActor({ id: "shop", name: "Tweakers", wealth: 0 });
  shop.flags[MODULE] = { tech: foundry.utils.mergeObject({ enabled: true, skills, maker, tups: [{ id: "t1", name: "Overpressure", heat: "hot", fits: "ranged", effect: "+1d6 damage." }] }, overrides) };
  const customer = new MockActor({ id: "pc", name: "V" });
  register(shop, customer);
  return { shop, customer };
}
const run = (kind, customer, shop, params = {}, user = player) =>
  TechOps.run({ kind, customerUuid: customer.uuid, shopUuid: shop.uuid, params }, user);

{
  const { shop, customer } = setup();
  const gun = customer.add({ id: "gun", ...pistol, system: { ...pistol.system, description: { value: "<p>Stock.</p>" } } });
  const r = await run("tupInstall", customer, shop, { tupId: "t1", itemId: "gun" });
  eq("installed: no roll, Cost #1 + #2 + labor charged", [r.success, customer.system.wealth.value], [true, 5000 - 1650]);
  eq("recorded as the item's upgrade, written into its description", [gun.flags[MODULE].maker.upgrade, gun.flags[MODULE].maker.tup.name, gun.system.description.value.startsWith("<p><strong>")], ["invented", "Overpressure", true]);
  await throws("only one upgrade per item", () => run("tupInstall", customer, shop, { tupId: "t1", itemId: "gun" }), "DoesntFit");
}
{
  const { shop, customer } = setup();
  customer.add({ id: "knife", ...knife });
  await throws("doesn't fit", () => run("tupInstall", customer, shop, { tupId: "t1", itemId: "knife" }), "DoesntFit");
}
{
  const { shop, customer } = setup();
  await run("tupKit", customer, shop, { tupId: "t1" });
  const kit = customer.items.find((i) => U.kitTup(i));
  eq("kit bought for Cost #2", [customer.system.wealth.value, kit.type, U.kitTup(kit).name, kit.system.price.market], [4000, "gear", "Overpressure", 1000]);
  customer.add({ id: "gun", ...pistol });
  await run("tupInstall", customer, shop, { kitItemId: kit.id, itemId: "gun" });
  eq("kit installed: Cost #1 + labor, kit used up", [customer.system.wealth.value, customer.items.has(kit.id)], [4000 - 650, false]);
}
{
  const { shop, customer } = setup({ tups: [{ id: "t1", name: "Overpressure", heat: "hot", fits: "ranged", kit: false }] });
  await throws("Tech doesn't sell this kit", () => run("tupKit", customer, shop, { tupId: "t1" }), "Gone");
}
{
  const { shop, customer } = setup({ tups: [{ id: "t1", name: "Secret", heat: "hot", fits: "ranged", onlyFor: "Actor.someoneElse" }] });
  customer.add({ id: "gun", ...pistol });
  await throws("exclusive to another customer", () => run("tupInstall", customer, shop, { tupId: "t1", itemId: "gun" }), "Gone");
}
{
  const { shop, customer } = setup({ options: { tupAutoSuccess: false } });
  customer.add({ id: "gun", ...pistol });
  dice.push(1, 3);
  const r = await run("tupInstall", customer, shop, { tupId: "t1", itemId: "gun" });
  eq("checks on: failed install costs nothing", [r.success, customer.system.wealth.value], [false, 5000]);
}
{
  const { shop, customer } = setup();
  dialogAnswers.push({ heat: "hot", fits: "ranged" });
  dice.push(9);
  const r = await run("invent", customer, shop, { name: "Smart Choke", inventionKind: "upgrade", description: "A shotgun choke that tightens on the target." });
  const tup = shop.flags[MODULE].tech.tups.at(-1);
  eq("invented upgrade goes on sale, exclusive to the customer", [r.success, tup.name, tup.heat, tup.fits, tup.source, tup.onlyFor], [true, "Smart Choke", "hot", "ranged", "invented", "Actor.pc"]);
  eq("Very Expensive invention labor", customer.system.wealth.value, 4600);
}

done("tups");
