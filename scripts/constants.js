export const MODULE_ID = "cpr-neon-market";
export const SYSTEM_ID = "cyberpunk-red-core";
export const FLAG_KEY = "shop";
export const SOCKET_NAME = `module.${MODULE_ID}`;
export const TEMPLATE_PATH = `modules/${MODULE_ID}/templates`;

/** Two layout families. Any theme can run on either, but each theme has a home layout. */
export const LAYOUTS = {
  character: "NEONMARKET.Layout.Character",
  grid: "NEONMARKET.Layout.Grid"
};

/**
 * Eight themes, four per layout family. Themes are pure CSS (see styles/neon-market.css);
 * the key becomes a `theme-<key>` class on the shop root.
 */
export const THEMES = {
  neon: { label: "NEONMARKET.Theme.Neon", layout: "character", accent: "#ff2a6d", accent2: "#05d9e8" },
  corpo: { label: "NEONMARKET.Theme.Corpo", layout: "character", accent: "#c8a24a", accent2: "#e9edf2" },
  street: { label: "NEONMARKET.Theme.Street", layout: "character", accent: "#ffd400", accent2: "#e4322b" },
  nomad: { label: "NEONMARKET.Theme.Nomad", layout: "character", accent: "#e8813a", accent2: "#8fb3a3" },
  terminal: { label: "NEONMARKET.Theme.Terminal", layout: "grid", accent: "#39ff88", accent2: "#b6ffcf" },
  netmarket: { label: "NEONMARKET.Theme.NetMarket", layout: "grid", accent: "#9d4dff", accent2: "#00e5ff" },
  ripperdoc: { label: "NEONMARKET.Theme.Ripperdoc", layout: "grid", accent: "#1fb5a8", accent2: "#d9304f" },
  fixer: { label: "NEONMARKET.Theme.Fixer", layout: "grid", accent: "#f0a830", accent2: "#d8d2c4" }
};

/**
 * Cyberpunk RED core price categories (CRB p.339). Used as the "rarity" display tier.
 * `max` is inclusive; the last tier catches everything above.
 */
export const PRICE_TIERS = [
  { key: "cheap", max: 10, label: "NEONMARKET.Tier.Cheap" },
  { key: "everyday", max: 20, label: "NEONMARKET.Tier.Everyday" },
  { key: "costly", max: 50, label: "NEONMARKET.Tier.Costly" },
  { key: "premium", max: 100, label: "NEONMARKET.Tier.Premium" },
  { key: "expensive", max: 500, label: "NEONMARKET.Tier.Expensive" },
  { key: "veryExpensive", max: 1000, label: "NEONMARKET.Tier.VeryExpensive" },
  { key: "luxury", max: 5000, label: "NEONMARKET.Tier.Luxury" },
  { key: "superLuxury", max: Infinity, label: "NEONMARKET.Tier.SuperLuxury" }
];

/** Per-shop sound effect slots. */
export const SFX_SLOTS = ["open", "select", "page", "purchase", "error"];

/** Speech bubble lines the clerk can say. */
export const SPEECH_KEYS = ["greeting", "select", "purchase", "sell", "noFunds", "farewell"];

/** Theme label overrides a GM can rename per shop. */
export const LABEL_KEYS = ["buy", "sell", "buyback", "cart", "checkout", "total", "balance", "outOfStock", "all"];

/** CPR item types that never appear in a shop's sell list. */
export const UNSELLABLE_TYPES = new Set(["skill", "role", "criticalInjury", "netarch"]);

/** Hard caps that keep a single request from doing something silly. */
export const LIMITS = {
  maxQty: 99,
  maxCopies: 20,
  maxBuyback: 40,
  requestTimeoutMs: 30_000,
  approvalTimeoutMs: 180_000
};
