import { MODULE_ID, FLAG_KEY, THEMES, PRICE_TIERS, LABEL_KEYS, SPEECH_KEYS, SFX_SLOTS } from "./constants.js";
import { CPR } from "./cpr-adapter.js";

const { mergeObject, deepClone, getProperty } = foundry.utils;

export const SCHEMA_VERSION = 1;

export function newId() {
  return foundry.utils.randomID(12);
}

/** A complete shop configuration with every field present. */
export function defaultShop(actor) {
  const theme = THEMES.neon;
  return {
    schema: SCHEMA_VERSION,
    enabled: false,
    layout: "character",
    theme: "neon",
    identity: {
      name: actor?.name ?? game.i18n.localize("NEONMARKET.Default.ShopName"),
      subtitle: game.i18n.localize("NEONMARKET.Default.Subtitle"),
      owner: actor?.name ?? "",
      slogan: game.i18n.localize("NEONMARKET.Default.Slogan"),
      art: actor?.img ?? "",
      background: "",
      accent: theme.accent,
      accent2: theme.accent2
    },
    speech: Object.fromEntries(SPEECH_KEYS.map((k) => [k, game.i18n.localize(`NEONMARKET.Speech.${k}`)])),
    labels: Object.fromEntries(LABEL_KEYS.map((k) => [k, ""])),
    categories: [],
    buyback: [],
    audio: {
      bgm: "",
      bgmVolume: 0.5,
      sfxVolume: 0.8,
      ...Object.fromEntries(SFX_SLOTS.map((k) => [k, ""]))
    },
    trade: {
      markup: 0,
      allowSell: true,
      sellRate: null,
      buyback: true,
      fundsMode: "unlimited",
      funds: 0
    }
  };
}

/** Fill any missing fields from defaults and coerce types, so templates never see holes. */
export function normalizeShop(raw, actor) {
  const shop = mergeObject(defaultShop(actor), deepClone(raw ?? {}), { inplace: false, insertKeys: true });
  if (!THEMES[shop.theme]) shop.theme = "neon";
  if (!["character", "grid"].includes(shop.layout)) shop.layout = THEMES[shop.theme].layout;
  shop.categories = Array.isArray(shop.categories) ? shop.categories : [];
  for (const cat of shop.categories) {
    cat.id ||= newId();
    cat.name ||= game.i18n.localize("NEONMARKET.Default.Category");
    cat.items = Array.isArray(cat.items) ? cat.items.filter((e) => e?.itemData) : [];
    for (const entry of cat.items) normalizeEntry(entry);
  }
  shop.buyback = Array.isArray(shop.buyback) ? shop.buyback.filter((e) => e?.itemData) : [];
  shop.trade.markup = Number(shop.trade.markup) || 0;
  shop.trade.funds = Math.max(0, Math.floor(Number(shop.trade.funds) || 0));
  if (!["unlimited", "finite", "wallet"].includes(shop.trade.fundsMode)) shop.trade.fundsMode = "unlimited";
  if (shop.trade.sellRate === "" || shop.trade.sellRate === undefined) shop.trade.sellRate = null;
  return shop;
}

export function normalizeEntry(entry) {
  entry.id ||= newId();
  entry.name ??= "";
  entry.price = entry.price === "" || entry.price === undefined ? null : entry.price;
  entry.discount = clamp(Number(entry.discount) || 0, 0, 100);
  entry.stock = Number.isFinite(Number(entry.stock)) ? Math.trunc(Number(entry.stock)) : -1;
  entry.tier ??= "";
  entry.sellRate = entry.sellRate === "" || entry.sellRate === undefined ? null : entry.sellRate;
  return entry;
}

export function makeEntry(item) {
  return normalizeEntry({
    id: newId(),
    sourceUuid: item.uuid ?? "",
    itemData: CPR.snapshot(item),
    name: "",
    price: null,
    discount: 0,
    stock: -1,
    tier: "",
    sellRate: null
  });
}

export function getRawShop(actor) {
  return actor?.getFlag?.(MODULE_ID, FLAG_KEY) ?? null;
}

export function isShop(actor) {
  return !!getRawShop(actor)?.enabled;
}

export function getShop(actor) {
  return normalizeShop(getRawShop(actor), actor);
}

export async function saveShop(actor, shop) {
  const clean = deepClone(shop);
  clean.schema = SCHEMA_VERSION;
  return actor.update({ [`flags.${MODULE_ID}.${FLAG_KEY}`]: clean });
}

/* ------------------------------------------ */
/*  Pricing                                   */
/* ------------------------------------------ */

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function entryName(entry) {
  return entry.name?.trim() || entry.itemData?.name || "";
}

export function basePrice(entry) {
  const override = entry.price;
  if (override !== null && override !== undefined && override !== "" && Number.isFinite(Number(override))) {
    return Math.max(0, Number(override));
  }
  return CPR.lotPrice(entry.itemData);
}

/** Final price of one purchase of a listing, after the shop markup and the item discount. */
export function buyPrice(entry, shop) {
  const markup = 1 + (Number(shop.trade.markup) || 0) / 100;
  const discount = 1 - clamp(Number(entry.discount) || 0, 0, 100) / 100;
  return Math.max(0, Math.round(basePrice(entry) * markup * discount));
}

export function worldSellRate() {
  return clamp(Number(game.settings.get(MODULE_ID, "defaultSellRate")) || 0, 0, 1);
}

/**
 * Rate the shop pays when a character sells an item. First match wins:
 *  1. a listing of the same item (name and type) with its own sell rate,
 *  2. the shop's sell rate,
 *  3. the host actor's CPR vendor percentage for that item type (container actors),
 *  4. the world default.
 */
export function sellRateFor(itemLike, shop, shopActor = null) {
  for (const cat of shop.categories) {
    for (const entry of cat.items) {
      if (entry.sellRate === null || entry.sellRate === undefined || entry.sellRate === "") continue;
      if (entry.itemData?.type === itemLike.type && entry.itemData?.name === itemLike.name) {
        return clamp(Number(entry.sellRate) || 0, 0, 1);
      }
    }
  }
  if (shop.trade.sellRate !== null && shop.trade.sellRate !== undefined && shop.trade.sellRate !== "") {
    return clamp(Number(shop.trade.sellRate) || 0, 0, 1);
  }
  const vendor = CPR.vendorConfig(shopActor, itemLike.type);
  if (vendor && Number.isFinite(Number(vendor.purchasePercentage))) {
    return clamp(Number(vendor.purchasePercentage) / 100, 0, 1);
  }
  return worldSellRate();
}

/** Whether this shop will buy this kind of item. Honors a CPR container vendor's per-type switch. */
export function buysItem(itemLike, shopActor) {
  const vendor = CPR.vendorConfig(shopActor, itemLike.type);
  return !(vendor && vendor.isPurchasing === false);
}

/** Eurobucks the shop pays for `units` of an item (units = rounds or pieces; 1 for non-stackables). */
export function sellPrice(itemLike, units, shop, shopActor = null) {
  const n = CPR.isStackable(itemLike) ? Math.max(0, units) : 1;
  return Math.floor(CPR.unitPrice(itemLike) * n * sellRateFor(itemLike, shop, shopActor));
}

/**
 * Cash the shop has to pay characters with, or null when unlimited.
 * "finite" tracks cash inside the shop settings; "wallet" uses the host actor's own eurobucks ledger.
 */
export function shopFunds(shop, shopActor) {
  if (shop.trade.fundsMode === "finite") return shop.trade.funds;
  if (shop.trade.fundsMode === "wallet") return CPR.hasWealth(shopActor) ? CPR.getWealth(shopActor) : 0;
  return null;
}

export function tierFor(price, override) {
  if (override) {
    const t = PRICE_TIERS.find((p) => p.key === override);
    if (t) return t;
  }
  return PRICE_TIERS.find((t) => price <= t.max) ?? PRICE_TIERS.at(-1);
}

export function label(shop, key) {
  const custom = getProperty(shop, `labels.${key}`);
  return custom?.trim() || game.i18n.localize(`NEONMARKET.Label.${key}`);
}

export function formatEb(n) {
  const value = Math.round(Number(n) || 0);
  return `${value.toLocaleString(game.i18n.lang)}eb`;
}

/** Find a listing by category and entry id. */
export function findEntry(shop, categoryId, entryId) {
  const category = shop.categories.find((c) => c.id === categoryId);
  const entry = category?.items.find((e) => e.id === entryId);
  return { category, entry };
}
