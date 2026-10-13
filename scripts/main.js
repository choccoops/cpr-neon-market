import { MODULE_ID, SYSTEM_ID, TEMPLATE_PATH, FLAG_KEY } from "./constants.js";
import { Compat } from "./compat.js";
import { ShopSocket } from "./socket.js";
import { Transactions } from "./transactions.js";
import { Interaction } from "./interaction.js";
import { ShopApp } from "./apps/shop-app.js";
import { ShopConfigApp } from "./apps/shop-config.js";
import { ClinicApp } from "./apps/clinic-app.js";
import { ClinicConfigApp } from "./apps/clinic-config.js";
import { ClinicOps } from "./clinic/clinic-ops.js";
import { getShop, saveShop, isShop } from "./shop-data.js";
import { CLINIC_FLAG, getClinic, saveClinic, isClinic } from "./clinic/clinic-data.js";

function registerSettings() {
  const s = (key, data) => game.settings.register(MODULE_ID, key, { scope: "world", config: true, ...data });

  s("defaultSellRate", {
    name: "NEONMARKET.Settings.SellRate.Name",
    hint: "NEONMARKET.Settings.SellRate.Hint",
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: 0.5
  });
  s("playersCanSell", {
    name: "NEONMARKET.Settings.PlayersCanSell.Name",
    hint: "NEONMARKET.Settings.PlayersCanSell.Hint",
    type: Boolean,
    default: true
  });
  s("requireApproval", {
    name: "NEONMARKET.Settings.RequireApproval.Name",
    hint: "NEONMARKET.Settings.RequireApproval.Hint",
    type: Boolean,
    default: false
  });
  s("interactRange", {
    name: "NEONMARKET.Settings.InteractRange.Name",
    hint: "NEONMARKET.Settings.InteractRange.Hint",
    type: Number,
    range: { min: 0, max: 30, step: 1 },
    default: 4
  });
  s("receiptMode", {
    name: "NEONMARKET.Settings.Receipt.Name",
    hint: "NEONMARKET.Settings.Receipt.Hint",
    type: String,
    choices: {
      public: "NEONMARKET.Settings.Receipt.Public",
      private: "NEONMARKET.Settings.Receipt.Private",
      none: "NEONMARKET.Settings.Receipt.None"
    },
    default: "private"
  });
  s("showPriceTiers", {
    name: "NEONMARKET.Settings.ShowTiers.Name",
    hint: "NEONMARKET.Settings.ShowTiers.Hint",
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "duckVolume", {
    name: "NEONMARKET.Settings.Duck.Name",
    hint: "NEONMARKET.Settings.Duck.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: 0.2
  });
}

Hooks.once("init", () => {
  registerSettings();
  Interaction.registerKeybindings();
  Interaction.registerHooks();

  Compat.loadTemplates([
    `${TEMPLATE_PATH}/shop.hbs`,
    `${TEMPLATE_PATH}/shop-config.hbs`,
    `${TEMPLATE_PATH}/chat-receipt.hbs`,
    `${TEMPLATE_PATH}/parts/stage.hbs`,
    `${TEMPLATE_PATH}/parts/nav.hbs`,
    `${TEMPLATE_PATH}/parts/listing.hbs`,
    `${TEMPLATE_PATH}/parts/detail.hbs`,
    `${TEMPLATE_PATH}/parts/cart.hbs`,
    `${TEMPLATE_PATH}/clinic.hbs`,
    `${TEMPLATE_PATH}/clinic-config.hbs`,
    `${TEMPLATE_PATH}/chat-clinic.hbs`
  ]);

  const api = {
    /** Open a shop for the current user. Accepts an Actor, Token, TokenDocument or UUID. */
    open: async (target, options) => ShopApp.open(await resolveActor(target), options),
    /** GM: open the shop editor. */
    configure: async (target) => ShopConfigApp.open(await resolveActor(target)),
    /** GM: open the shop on every connected player's screen (or only the listed user ids). */
    present: async (target, userIds) => Interaction.present(await resolveActor(target), userIds),
    /** GM: close the shop on every player's screen. */
    dismiss: async (target) => Interaction.dismiss(await resolveActor(target)),
    getShop: async (target) => getShop(await resolveActor(target)),
    setShop: async (target, data) => saveShop(await resolveActor(target), data),
    isShop,
    /** Open a ripperdoc clinic or hospital for the current user. */
    openClinic: async (target, options) => ClinicApp.open(await resolveActor(target), options),
    /** GM: open the clinic editor. */
    configureClinic: async (target) => ClinicConfigApp.open(await resolveActor(target)),
    getClinic: async (target) => getClinic(await resolveActor(target)),
    setClinic: async (target, data) => saveClinic(await resolveActor(target), data),
    isClinic,
    apps: { ShopApp, ShopConfigApp, ClinicApp, ClinicConfigApp }
  };
  game.modules.get(MODULE_ID).api = api;
});

Hooks.once("ready", () => {
  ShopSocket.init();
  Transactions.init();
  ClinicOps.init();
  Interaction.registerSocketEvents();

  if (game.system.id !== SYSTEM_ID && game.user.isGM) {
    ui.notifications.warn(game.i18n.format("NEONMARKET.Error.WrongSystem", { system: game.system.title }));
  }
});

/* ------------------------------------------ */
/*  Keep open shops in sync                   */
/* ------------------------------------------ */

Hooks.on("updateActor", (actor, changes) => {
  const shopChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG_KEY}`)
    || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=${FLAG_KEY}`);
  const walletChanged = foundry.utils.hasProperty(changes, "system.wealth");
  if (shopChanged || walletChanged) ShopApp.refreshFor(actor);
  const clinicChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${CLINIC_FLAG}`)
    || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=${CLINIC_FLAG}`);
  if (clinicChanged || walletChanged || foundry.utils.hasProperty(changes, "system.derivedStats")
    || foundry.utils.hasProperty(changes, "system.stats")) ClinicApp.refreshFor(actor);
});

for (const hook of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, (item) => {
    if (item.parent instanceof Actor) {
      ShopApp.refreshFor(item.parent);
      ClinicApp.refreshFor(item.parent);
    }
  });
}

Hooks.on("canvasTearDown", () => {
  for (const app of ShopApp.instances.values()) app.close();
  for (const app of ClinicApp.instances.values()) app.close();
});

async function resolveActor(target) {
  if (!target) return null;
  if (target instanceof Actor) return target;
  if (typeof target === "string") {
    const doc = await fromUuid(target);
    return doc instanceof Actor ? doc : doc?.actor ?? null;
  }
  return target.actor ?? null;
}
