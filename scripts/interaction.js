import { MODULE_ID } from "./constants.js";
import { Compat } from "./compat.js";
import { ShopSocket } from "./socket.js";
import { isShop } from "./shop-data.js";
import { ShopApp } from "./apps/shop-app.js";
import { ShopConfigApp } from "./apps/shop-config.js";
import { ClinicApp } from "./apps/clinic-app.js";
import { ClinicConfigApp } from "./apps/clinic-config.js";
import { isClinic } from "./clinic/clinic-data.js";

/** Actors that open something when a player interacts with them. */
const isVenue = (actor) => isShop(actor) || isClinic(actor);

/** Open what an actor offers: its clinic (which links to its store) if it has one, else its shop. */
const openVenue = (actor) => (isClinic(actor) ? ClinicApp.open(actor) : ShopApp.open(actor));

/**
 * All the ways a shop or clinic gets opened:
 *  - Token HUD button on a shopkeeper token (GM: settings + open; players: open when in range)
 *  - Actor sheet header button (GM)
 *  - Actor directory context menu (GM)
 *  - Interact keybinding (default G) near a shopkeeper token
 *  - GM "present to players" broadcast
 */
export const Interaction = {
  registerKeybindings() {
    game.keybindings.register(MODULE_ID, "interact", {
      name: "NEONMARKET.Keybinding.Interact",
      hint: "NEONMARKET.Keybinding.InteractHint",
      editable: [{ key: "KeyG" }],
      restricted: false,
      precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
      onDown: () => {
        const token = this.nearestShopToken();
        if (!token) {
          if (canvas?.tokens?.controlled?.length) ui.notifications.info(game.i18n.localize("NEONMARKET.UI.NoShopNearby"));
          return false;
        }
        openVenue(token.actor);
        return true;
      }
    });
  },

  registerHooks() {
    Hooks.on("renderTokenHUD", (hud, html) => this._onTokenHUD(hud, html));

    // Application v1 sheets (Foundry v12 and the current CPR system sheets).
    Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
      if (!game.user.isGM) return;
      buttons.unshift({
        label: game.i18n.localize("NEONMARKET.Clinic.SheetButton"),
        class: "neon-market-clinic-config",
        icon: "fa-solid fa-user-doctor",
        onclick: () => ClinicConfigApp.open(sheet.actor)
      });
      buttons.unshift({
        label: game.i18n.localize("NEONMARKET.UI.ShopButton"),
        class: "neon-market-config",
        icon: "fa-solid fa-store",
        onclick: () => ShopConfigApp.open(sheet.actor)
      });
    });

    // Application v2 sheets (core in v13+, and CPR once it migrates its sheets).
    Hooks.on("getHeaderControlsActorSheetV2", (sheet, controls) => {
      if (!game.user.isGM) return;
      controls.unshift({
        icon: "fa-solid fa-user-doctor",
        label: "NEONMARKET.Clinic.SheetButton",
        action: "neonMarketClinic",
        onClick: () => ClinicConfigApp.open(sheet.document ?? sheet.actor)
      });
      controls.unshift({
        icon: "fa-solid fa-store",
        label: "NEONMARKET.UI.ShopButton",
        action: "neonMarketConfigure",
        onClick: () => ShopConfigApp.open(sheet.document ?? sheet.actor)
      });
    });

    // Actor directory context menu: v12 name, then the v13+ name.
    const actorFrom = (li) => {
      const el = Compat.element(li);
      return game.actors.get(el?.dataset.documentId ?? el?.dataset.entryId);
    };
    const addContext = (_app, options) => {
      options.push({
        name: "NEONMARKET.Clinic.ConfigureClinic",
        icon: '<i class="fa-solid fa-user-doctor"></i>',
        condition: () => game.user.isGM,
        callback: (li) => {
          const actor = actorFrom(li);
          if (actor) ClinicConfigApp.open(actor);
        }
      });
      options.push({
        name: "NEONMARKET.UI.ConfigureShop",
        icon: '<i class="fa-solid fa-store"></i>',
        condition: () => game.user.isGM,
        callback: (li) => {
          const el = Compat.element(li);
          const id = el?.dataset.documentId ?? el?.dataset.entryId;
          const actor = game.actors.get(id);
          if (actor) ShopConfigApp.open(actor);
        }
      });
    };
    Hooks.on("getActorDirectoryEntryContext", addContext);
    Hooks.on("getActorContextOptions", addContext);
  },

  registerSocketEvents() {
    ShopSocket.on("present", async ({ shopUuid, userIds }) => {
      if (Array.isArray(userIds) && userIds.length && !userIds.includes(game.user.id)) return;
      const actor = await fromUuid(shopUuid);
      if (actor) ShopApp.open(actor);
    });
    ShopSocket.on("dismiss", ({ shopUuid }) => {
      ShopApp.instances.get(shopUuid)?.close();
    });
  },

  /** GM: open the shop on every connected player's screen. */
  present(actor, userIds = null) {
    if (!game.user.isGM) return;
    if (!isShop(actor)) ui.notifications.warn(game.i18n.localize("NEONMARKET.UI.PresentDisabled"));
    ShopSocket.emit("present", { shopUuid: actor.uuid, userIds });
    ui.notifications.info(game.i18n.format("NEONMARKET.UI.Presented", { name: actor.name }));
  },

  dismiss(actor) {
    if (!game.user.isGM) return;
    ShopSocket.emit("dismiss", { shopUuid: actor.uuid });
  },

  /** Controlled token that will do the talking: first controlled, else the user's character token. */
  actingToken() {
    const controlled = canvas?.tokens?.controlled?.[0];
    if (controlled) return controlled;
    const char = game.user.character;
    return char?.getActiveTokens?.()?.[0] ?? null;
  },

  inRange(from, to) {
    if (game.user.isGM && !from) return true;
    if (!from || !to) return false;
    const range = Number(game.settings.get(MODULE_ID, "interactRange")) || 0;
    if (range <= 0) return true;
    return Compat.measureDistance(from.center, to.center) <= range + 0.01;
  },

  nearestShopToken() {
    const from = this.actingToken();
    if (!from || !canvas?.tokens) return null;
    let best = null;
    let bestDist = Infinity;
    for (const t of canvas.tokens.placeables) {
      if (t === from || !t.actor || !isVenue(t.actor)) continue;
      if (!game.user.isGM && (t.document.hidden || !t.visible)) continue;
      const d = Compat.measureDistance(from.center, t.center);
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    return best && this.inRange(from, best) ? best : null;
  },

  _onTokenHUD(hud, html) {
    const token = hud.object;
    const actor = token?.actor;
    if (!actor) return;
    const root = Compat.element(html);
    const col = root?.querySelector(".col.right");
    if (!col) return;

    const shopOn = isShop(actor);
    const clinicOn = isClinic(actor);
    if (!game.user.isGM && !shopOn && !clinicOn) return;

    const make = (icon, tooltip, handler, extraClass = "") => {
      const btn = document.createElement(Compat.generation >= 13 ? "button" : "div");
      if (btn.tagName === "BUTTON") btn.type = "button";
      btn.className = `control-icon neon-market-hud ${extraClass}`;
      btn.dataset.tooltip = game.i18n.localize(tooltip);
      btn.setAttribute("aria-label", btn.dataset.tooltip);
      btn.innerHTML = `<i class="${icon}"></i>`;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        handler(ev);
      });
      col.appendChild(btn);
      return btn;
    };

    if (shopOn || game.user.isGM) {
      make("fa-solid fa-store", "NEONMARKET.UI.OpenShop", () => {
        if (!game.user.isGM && !this.inRange(this.actingToken(), token)) {
          return ui.notifications.warn(game.i18n.localize("NEONMARKET.UI.TooFar"));
        }
        ShopApp.open(actor);
      }, shopOn ? "" : "inactive");
    }
    if (clinicOn) {
      make("fa-solid fa-user-doctor", "NEONMARKET.Clinic.OpenClinic", () => {
        if (!game.user.isGM && !this.inRange(this.actingToken(), token)) {
          return ui.notifications.warn(game.i18n.localize("NEONMARKET.UI.TooFar"));
        }
        ClinicApp.open(actor);
      });
    }
    if (game.user.isGM) {
      make("fa-solid fa-sliders", "NEONMARKET.UI.ConfigureShop", () => ShopConfigApp.open(actor));
      make("fa-solid fa-briefcase-medical", "NEONMARKET.Clinic.ConfigureClinic", () => ClinicConfigApp.open(actor));
      if (shopOn) make("fa-solid fa-bullhorn", "NEONMARKET.UI.Present", () => this.present(actor));
    }
  }
};
