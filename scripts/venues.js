import { MODULE_ID } from "./constants.js";
import { isShop } from "./shop-data.js";
import { isClinic } from "./clinic/clinic-data.js";
import { isTech } from "./tech/tech-data.js";

/**
 * The three things an actor can be: a store, a clinic and a tech shop, in any combination.
 * Windows reach each other through the module API, so no app imports another.
 */
export const VENUES = {
  clinic: { icon: "fa-solid fa-user-doctor", label: "NEONMARKET.Venue.clinic", is: isClinic, open: "openClinic", configure: "configureClinic", app: "ClinicApp" },
  tech: { icon: "fa-solid fa-screwdriver-wrench", label: "NEONMARKET.Venue.tech", is: isTech, open: "openTech", configure: "configureTech", app: "TechApp" },
  shop: { icon: "fa-solid fa-store", label: "NEONMARKET.Venue.shop", is: isShop, open: "open", configure: "configure", app: "ShopApp" }
};

/** The other venues this actor runs, for header buttons. */
export function venueLinks(actor, except) {
  return Object.entries(VENUES)
    .filter(([key, v]) => key !== except && v.is(actor))
    .map(([key, v]) => ({ key, icon: v.icon, label: game.i18n.localize(v.label) }));
}

export function isVenue(actor) {
  return Object.values(VENUES).some((v) => v.is(actor));
}

export function openVenue(actor, key) {
  const v = VENUES[key];
  return v ? game.modules.get(MODULE_ID).api[v.open](actor) : null;
}

/** What an interaction opens first: clinic, then tech shop, then store (each links to the others). */
export function primaryVenue(actor) {
  return Object.keys(VENUES).find((key) => VENUES[key].is(actor)) ?? null;
}

/** One full-screen venue at a time: close every open one except `keep`. */
export function closeOtherVenues(keep) {
  const apps = game.modules.get(MODULE_ID).api?.apps ?? {};
  for (const v of Object.values(VENUES)) {
    for (const app of apps[v.app]?.instances?.values() ?? []) if (app !== keep) app.close();
  }
}

/**
 * GM: one entry point to an actor's store, clinic and tech shop settings. Asks which one,
 * showing whether each is open, then opens its editor.
 */
export async function chooseVenueSettings(actor) {
  if (!actor || !game.user.isGM) return null;
  const api = game.modules.get(MODULE_ID).api;
  const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));
  const order = ["shop", "clinic", "tech"];
  const key = await foundry.applications.api.DialogV2.wait({
    classes: ["neon-market-dialog", "neon-market-chooser"],
    window: { title: L("NEONMARKET.Venue.ChooseTitle", { name: actor.name }), icon: "fa-solid fa-city" },
    content: `<p class="hint">${L("NEONMARKET.Venue.ChooseHint")}</p>`,
    buttons: order.map((k) => ({
      action: k,
      icon: VENUES[k].icon,
      label: `${L(`NEONMARKET.Venue.Settings.${k}`)} · ${L(VENUES[k].is(actor) ? "NEONMARKET.Venue.On" : "NEONMARKET.Venue.Off")}`,
      callback: () => k
    })),
    rejectClose: false
  });
  return key ? api[VENUES[key].configure](actor) : null;
}
