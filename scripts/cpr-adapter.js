import { MODULE_ID, SYSTEM_ID, UNSELLABLE_TYPES } from "./constants.js";

const { getProperty, hasProperty, deepClone } = foundry.utils;

/**
 * Everything that knows about the Cyberpunk RED - CORE data model lives here.
 * Verified against the CPR v0.92.4 source (datamodels, cpr-actor.js, cpr-container-sheet.js).
 * Each accessor checks that the path exists before using it, so a future
 * system release that renames a field degrades to "no data" instead of
 * throwing in the middle of a trade.
 */
export const CPR = {
  get isActive() {
    return game.system.id === SYSTEM_ID;
  },

  /* ---------------------------------------- */
  /*  Wealth (eurobucks)                      */
  /* ---------------------------------------- */

  /** Characters and container actors carry a wealth ledger in CPR 0.92; mooks do not. */
  hasWealth(actor) {
    return !!actor
      && hasProperty(actor, "system.wealth.value")
      && Array.isArray(getProperty(actor, "system.wealth.transactions"));
  },

  getWealth(actor) {
    return Math.floor(Number(getProperty(actor, "system.wealth.value")) || 0);
  },

  /**
   * Change an actor's eurobucks and record it in the CPR wealth ledger.
   *
   * CPR's own deltaLedgerProperty() fires actor.update() without awaiting it, so a
   * caller can't tell when the change has landed. For an all-or-nothing trade we
   * need to await it, so this writes the same ledger entry the system writes
   * (CPR.ledger.increaseSentence / decreaseSentence, "reason - user") and awaits the update.
   *
   * @param {Actor} actor
   * @param {number} delta - positive to add, negative to spend
   * @param {string} reason - what the eurobucks were for
   * @param {string} [userName] - who made the trade, appended as the system does
   */
  async changeWealth(actor, delta, reason, userName = game.user.name) {
    if (!Math.trunc(Number(delta) || 0)) return;
    if (!this.hasWealth(actor)) throw new Error(game.i18n.format("NEONMARKET.Error.NoWealth", { name: actor.name }));
    await this.changeLedger(actor, "wealth", delta, reason, userName);
  },

  /**
   * Change any CPR ledger property (wealth, derivedStats.hp, derivedStats.humanity) and record
   * it the way CPRActor.deltaLedgerProperty does, but awaited. Returns the change actually made,
   * which is smaller than asked when `max` caps it.
   */
  async changeLedger(actor, prop, delta, reason, userName = game.user.name, { max = null } = {}) {
    const before = Math.trunc(Number(getProperty(actor, `system.${prop}.value`)) || 0);
    let total = before + Math.trunc(Number(delta) || 0);
    if (max !== null) total = Math.min(total, Math.max(before, max));
    const change = total - before;
    if (!change) return 0;
    const key = change > 0 ? "CPR.ledger.increaseSentence" : "CPR.ledger.decreaseSentence";
    const sentence = game.i18n.has(key)
      ? game.i18n.format(key, { property: prop, amount: Math.abs(change), total })
      : `${prop} ${change > 0 ? "increased" : "decreased"} by ${Math.abs(change)} to ${total}`;
    const transactions = deepClone(getProperty(actor, `system.${prop}.transactions`) ?? []);
    transactions.push([sentence, userName ? `${reason} - ${userName}` : reason]);
    await actor.update({ [`system.${prop}.value`]: total, [`system.${prop}.transactions`]: transactions });
    return change;
  },

  /* ---------------------------------------- */
  /*  Prices                                  */
  /* ---------------------------------------- */

  /** The number printed in the book and stored on the item (system.price.market). */
  getMarketPrice(itemLike) {
    return Math.max(0, Math.round(Number(getProperty(itemLike, "system.price.market")) || 0));
  },

  /**
   * Ammunition other than grenades and rockets is priced per 10 rounds (CRB p.344).
   * This mirrors CPRContainerSheet's purchase and sell code exactly.
   */
  isPricedPerTen(itemLike) {
    const variety = getProperty(itemLike, "system.variety");
    return itemLike?.type === "ammo" && variety !== "grenade" && variety !== "rocket";
  },

  /** Eurobucks for a single unit (one round, one drug dose, one item). May be fractional. */
  unitPrice(itemLike) {
    const market = this.getMarketPrice(itemLike);
    return this.isPricedPerTen(itemLike) ? market / 10 : market;
  },

  /* ---------------------------------------- */
  /*  Stacks                                  */
  /* ---------------------------------------- */

  /** Only the stackable mixin (ammo, clothing, drug, gear) has system.amount. */
  isStackable(itemLike) {
    const amount = getProperty(itemLike, "system.amount");
    return amount !== undefined && amount !== null && !Number.isNaN(Number(amount));
  },

  getAmount(itemLike) {
    return Math.max(0, Math.floor(Number(getProperty(itemLike, "system.amount")) || 0));
  },

  /** Units delivered by one purchase of a listing: the listing's own amount (a box of 10 rounds, one jacket). */
  lotAmount(itemLike) {
    return this.isStackable(itemLike) ? Math.max(1, this.getAmount(itemLike)) : 1;
  },

  /** A sensible lot when turning an actor's stack into a listing: a box of 10 for per-ten ammo, else 1. */
  defaultLot(itemLike) {
    return this.isPricedPerTen(itemLike) ? 10 : 1;
  },

  /** Market price of one purchase of this listing, before shop markup and discount. */
  lotPrice(itemLike) {
    return Math.round(this.unitPrice(itemLike) * this.lotAmount(itemLike));
  },

  /* ---------------------------------------- */
  /*  Installed items (upgrades, options)     */
  /* ---------------------------------------- */

  /** isInstalled is a getter on CPR's installable schema, so it only works on live documents. */
  isInstalled(item) {
    return !!getProperty(item, "system.isInstalled");
  },

  hasInstalled(item) {
    return (getProperty(item, "system.installedItems.list") ?? []).length > 0;
  },

  isCore(itemLike) {
    return !!getProperty(itemLike, "system.core");
  },

  /** Can a listing be made from this item at all? */
  isListable(itemLike) {
    return !!itemLike && !UNSELLABLE_TYPES.has(itemLike.type) && !this.isCore(itemLike);
  },

  isSellable(item) {
    if (!this.isListable(item)) return false;
    if (this.isInstalled(item)) return false;
    if (this.getMarketPrice(item) <= 0) return false;
    if (this.isStackable(item) && this.getAmount(item) < 1) return false;
    return true;
  },

  /**
   * Strip loaded ammunition out of an install tree. CPR carries an empty ammo stack plus
   * the magazine count along with a transferred weapon; a shop sells weapons unloaded.
   */
  _pruneTree(tree) {
    if (!Array.isArray(tree)) return [];
    return tree
      .filter((o) => o?.type !== "ammo")
      .map((o) => {
        const copy = deepClone(o);
        if (copy.flags?.cprInstallTree) {
          copy.flags.cprInstallTree = this._pruneTree(copy.flags.cprInstallTree);
          const ids = copy.flags.cprInstallTree.map((c) => c._id);
          if (hasProperty(copy, "system.installedItems.list")) copy.system.installedItems.list = ids;
          if (!ids.length) delete copy.flags.cprInstallTree;
        }
        if (hasProperty(copy, "system.magazine.value")) copy.system.magazine.value = 0;
        return copy;
      });
  },

  /**
   * Turn an item document into the data we keep in a shop listing.
   * Installed upgrades are kept the way CPR's own container shop keeps them:
   * as object data in flags.cprInstallTree, with installedItems.list left non-empty
   * so CPRActor.createEmbeddedDocuments rebuilds them on the new owner.
   */
  snapshot(item) {
    const data = typeof item.toObject === "function" ? item.toObject() : deepClone(item);
    delete data._id;
    delete data.folder;
    delete data.sort;
    delete data.ownership;
    delete data._stats;
    data.flags ??= {};

    let tree = [];
    if (item.isEmbedded && this.hasInstalled(item) && typeof item.createInstalledObjectData === "function") {
      try {
        tree = this._pruneTree(item.createInstalledObjectData());
      } catch (err) {
        console.warn(`${MODULE_ID} | could not read installed items of ${item.name}`, err);
      }
    }
    if (tree.length) {
      data.flags.cprInstallTree = tree;
      data.system.installedItems.list = tree.map((o) => o._id);
    } else {
      delete data.flags.cprInstallTree;
      if (hasProperty(data, "system.installedItems.list")) data.system.installedItems.list = [];
    }
    if (hasProperty(data, "system.installedItems.usedSlots") && !tree.length) data.system.installedItems.usedSlots = 0;
    if (hasProperty(data, "system.magazine.value")) data.system.magazine.value = 0;
    if (typeof getProperty(data, "system.equipped") === "string") data.system.equipped = "owned";
    return data;
  },

  /** Every item that goes with this one when it leaves an actor (upgrades, options), minus shared ammo stacks. */
  installedChildren(item) {
    if (!this.hasInstalled(item) || typeof item.recursiveGetAllInstalledItems !== "function") return [];
    try {
      return item.recursiveGetAllInstalledItems().filter((c) => c.type !== "ammo");
    } catch {
      return [];
    }
  },

  /* ---------------------------------------- */
  /*  Container vendors                       */
  /* ---------------------------------------- */

  /** A CPR container actor's vendor settings for one item type, if it has them. */
  vendorConfig(actor, type) {
    if (actor?.type !== "container") return null;
    return getProperty(actor, `system.vendor.itemTypes.${type}`) ?? null;
  },

  /* ---------------------------------------- */
  /*  Display                                 */
  /* ---------------------------------------- */

  typeLabel(type) {
    const key = CONFIG.Item?.typeLabels?.[type] ?? `TYPES.Item.${type}`;
    if (game.i18n.has(key)) return game.i18n.localize(key);
    return type ? type.charAt(0).toUpperCase() + type.slice(1) : "";
  },

  _cprLabel(key, fallback) {
    return key && game.i18n.has(key) ? game.i18n.localize(key) : this.titleCase(fallback);
  },

  /** Short, readable stat chips for the detail pane. Paths match the CPR 0.92 datamodels. */
  statLines(itemLike) {
    const s = itemLike?.system ?? {};
    const out = [];
    const push = (label, value) => {
      if (value === undefined || value === null || value === "" || value === 0 || value === "0") return;
      out.push({ label: game.i18n.localize(label), value: String(value) });
    };
    switch (itemLike?.type) {
      case "weapon":
        push("NEONMARKET.Stat.Damage", s.damage);
        push("NEONMARKET.Stat.ROF", s.rof);
        push("NEONMARKET.Stat.Magazine", s.magazine?.max);
        push("NEONMARKET.Stat.Hands", s.handsReq);
        push("NEONMARKET.Stat.Quality", s.quality && this._cprLabel(`CPR.global.itemQuality.${s.quality}`, s.quality));
        push("NEONMARKET.Stat.Concealable", s.concealable?.concealable ? game.i18n.localize("Yes") : null);
        break;
      case "armor":
        push("NEONMARKET.Stat.BodySP", s.bodyLocation?.sp);
        push("NEONMARKET.Stat.HeadSP", s.headLocation?.sp);
        push("NEONMARKET.Stat.ShieldHP", s.shieldHitPoints?.max);
        push("NEONMARKET.Stat.Penalty", s.penalty);
        break;
      case "cyberware": {
        const hl = s.humanityLoss;
        push("NEONMARKET.Stat.HumanityLoss", hl ? [hl.roll, hl.static ? `(${hl.static})` : ""].filter(Boolean).join(" ") : null);
        if (s.installLocation && s.installLocation !== "notApplicable") {
          push("NEONMARKET.Stat.Install", this._cprLabel(`CPR.global.cyberwareInstall.${s.installLocation}`, s.installLocation));
        }
        push("NEONMARKET.Stat.Slots", s.installedItems?.slots);
        break;
      }
      case "ammo":
        push("NEONMARKET.Stat.Variety", s.variety && this.titleCase(s.variety));
        push("NEONMARKET.Stat.AmmoType", s.type && this.titleCase(s.type));
        break;
      case "vehicle":
        push("NEONMARKET.Stat.SDP", s.sdp);
        push("NEONMARKET.Stat.Seats", s.seats);
        push("NEONMARKET.Stat.Speed", s.speedCombat);
        break;
      case "program":
        push("NEONMARKET.Stat.Class", s.class && this.titleCase(s.class));
        push("NEONMARKET.Stat.Size", s.size);
        break;
      case "cyberdeck":
        push("NEONMARKET.Stat.Slots", s.installedItems?.slots);
        push("NEONMARKET.Stat.Quality", s.quality && this._cprLabel(`CPR.global.itemQuality.${s.quality}`, s.quality));
        break;
      default:
        break;
    }
    if (this.isStackable(itemLike) && this.lotAmount(itemLike) > 1) {
      push("NEONMARKET.Stat.PerPurchase", this.lotAmount(itemLike));
    }
    return out;
  },

  titleCase(str) {
    return String(str)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (c) => c.toUpperCase());
  },

  description(itemLike) {
    const d = getProperty(itemLike, "system.description");
    if (typeof d === "string") return d;
    return d?.value ?? "";
  },

  /* ---------------------------------------- */
  /*  Actors                                  */
  /* ---------------------------------------- */

  /** Actors this user can trade for: owned, and carrying a eurobuck wallet. */
  buyerCandidates(user = game.user) {
    const seen = new Map();
    const add = (actor) => {
      if (!actor || actor.type === "container" || !this.hasWealth(actor)) return;
      if (!user.isGM && !actor.testUserPermission(user, "OWNER")) return;
      seen.set(actor.uuid, actor);
    };
    for (const t of canvas?.tokens?.controlled ?? []) add(t.actor);
    add(user.character);
    for (const a of game.actors) {
      if (a.type !== "character") continue;
      if (user.isGM ? a.hasPlayerOwner : a.testUserPermission(user, "OWNER")) add(a);
    }
    return [...seen.values()];
  },

  defaultBuyer(user = game.user) {
    return this.buyerCandidates(user)[0] ?? null;
  }
};
