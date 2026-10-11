import { MODULE_ID, LIMITS } from "./constants.js";
import { Compat } from "./compat.js";
import { CPR } from "./cpr-adapter.js";
import { ShopSocket } from "./socket.js";
import {
  getShop, saveShop, buyPrice, findEntry, entryName, sellPrice, buysItem, shopFunds, formatEb, newId
} from "./shop-data.js";

const { deepClone } = foundry.utils;

/**
 * Transactions run only on the active GM client.
 *
 * Every step that changes the world pushes an inverse onto an undo stack.
 * If any later step throws, the stack is replayed in reverse, so a trade
 * either lands completely (eurobucks, items, stock, shop cash) or not at all.
 */
export class Transactions {
  static init() {
    ShopSocket.register("buy", (payload, user) => this.buy(payload, user));
    ShopSocket.register("sell", (payload, user) => this.sell(payload, user));
  }

  /* ---------------------------------------- */
  /*  Buy                                     */
  /* ---------------------------------------- */

  static async buy({ buyerUuid, shopUuid, cart }, user) {
    const { buyer, shopActor } = await this.#resolve(buyerUuid, shopUuid, user);
    const original = getShop(shopActor);
    if (!original.enabled && !user.isGM) throw new Error(game.i18n.localize("NEONMARKET.Error.ShopClosed"));
    if (!Array.isArray(cart) || !cart.length) throw new Error(game.i18n.localize("NEONMARKET.Error.EmptyCart"));

    const working = deepClone(original);
    const lines = [];
    let total = 0;

    for (const row of cart) {
      const qty = Math.min(LIMITS.maxQty, Math.max(1, Math.floor(Number(row.qty) || 1)));
      if (row.source === "buyback") {
        const idx = working.buyback.findIndex((b) => b.id === row.entryId);
        if (idx < 0) throw new Error(game.i18n.localize("NEONMARKET.Error.ItemGone"));
        const [entry] = working.buyback.splice(idx, 1);
        const price = Math.max(0, Math.round(Number(entry.price) || 0));
        lines.push({ name: entry.itemData.name, itemData: entry.itemData, qty: 1, units: CPR.lotAmount(entry.itemData), price, exactUnits: true });
        total += price;
        continue;
      }
      const { entry } = findEntry(working, row.categoryId, row.entryId);
      if (!entry) throw new Error(game.i18n.localize("NEONMARKET.Error.ItemGone"));
      if (entry.stock >= 0) {
        if (entry.stock < qty) {
          throw new Error(game.i18n.format("NEONMARKET.Error.NotEnoughStock", { name: entryName(entry), stock: entry.stock }));
        }
        entry.stock -= qty;
      }
      const unit = buyPrice(entry, working);
      const itemData = deepClone(entry.itemData);
      if (entry.name?.trim()) itemData.name = entry.name.trim();
      const units = CPR.isStackable(itemData) ? CPR.lotAmount(itemData) * qty : qty;
      lines.push({ name: itemData.name, itemData, qty, units, price: unit * qty, exactUnits: false });
      total += unit * qty;
    }

    const wealth = CPR.getWealth(buyer);
    if (wealth < total) {
      const err = new Error(game.i18n.format("NEONMARKET.Error.NotEnoughFunds", {
        name: buyer.name, total: formatEb(total), wealth: formatEb(wealth)
      }));
      err.code = "noFunds";
      throw err;
    }

    await this.#approve(user, "buy", { buyer, shop: original, lines, total });

    const shopName = original.identity.name;
    const summary = this.#summary(lines);
    if (working.trade.fundsMode === "finite") working.trade.funds += total;

    const undo = [];
    try {
      if (total > 0) {
        await CPR.changeWealth(buyer, -total, game.i18n.format("NEONMARKET.Ledger.Bought", { items: summary, shop: shopName }), user.name);
        undo.push(() => CPR.changeWealth(buyer, total, game.i18n.localize("NEONMARKET.Ledger.Rollback"), user.name));
        if (working.trade.fundsMode === "wallet" && CPR.hasWealth(shopActor)) {
          await CPR.changeWealth(shopActor, total, game.i18n.format("NEONMARKET.Ledger.ShopSold", { items: summary, actor: buyer.name }), user.name);
          undo.push(() => CPR.changeWealth(shopActor, -total, game.i18n.localize("NEONMARKET.Ledger.Rollback"), user.name));
        }
      }
      for (const line of lines) undo.push(await this.#grant(buyer, line, shopName));
      await saveShop(shopActor, working);
      undo.push(() => saveShop(shopActor, original));
    } catch (err) {
      await this.#rollback(undo);
      throw err;
    }

    await this.#receipt({ kind: "buy", user, actor: buyer, shop: original, lines, total });
    return { total, balance: CPR.getWealth(buyer) };
  }

  /* ---------------------------------------- */
  /*  Sell                                    */
  /* ---------------------------------------- */

  /**
   * @param {object} payload
   * @param {Array<{itemId: string, qty: number}>} payload.items - qty is in units (rounds, pieces); ignored for non-stackables
   */
  static async sell({ sellerUuid, shopUuid, items }, user) {
    const { buyer: seller, shopActor } = await this.#resolve(sellerUuid, shopUuid, user);
    const original = getShop(shopActor);
    if (!original.enabled && !user.isGM) throw new Error(game.i18n.localize("NEONMARKET.Error.ShopClosed"));
    if (!original.trade.allowSell || !game.settings.get(MODULE_ID, "playersCanSell")) {
      throw new Error(game.i18n.localize("NEONMARKET.Error.NotBuying"));
    }
    if (!Array.isArray(items) || !items.length) throw new Error(game.i18n.localize("NEONMARKET.Error.NothingToSell"));

    const working = deepClone(original);
    const lines = [];
    let total = 0;
    const seen = new Set();

    for (const row of items) {
      if (seen.has(row.itemId)) continue;
      seen.add(row.itemId);
      const item = seller.items.get(row.itemId);
      if (!item || !CPR.isSellable(item)) throw new Error(game.i18n.localize("NEONMARKET.Error.CannotSell"));
      if (!buysItem(item, shopActor)) {
        throw new Error(game.i18n.format("NEONMARKET.Error.TypeNotBought", { type: CPR.typeLabel(item.type) }));
      }
      const children = CPR.installedChildren(item);
      let units = null;
      if (CPR.isStackable(item)) {
        const have = CPR.getAmount(item);
        // A stack carrying upgrades leaves whole; plain stacks can be split.
        units = children.length ? have : Math.min(have, Math.max(1, Math.floor(Number(row.qty) || 1)));
      }
      const price = sellPrice(item, units ?? 1, working, shopActor);
      lines.push({ item, children, name: item.name, qty: units ?? 1, units, price });
      total += price;
    }

    const funds = shopFunds(working, shopActor);
    if (funds !== null && funds < total) {
      throw new Error(game.i18n.format("NEONMARKET.Error.ShopBroke", { funds: formatEb(funds) }));
    }

    await this.#approve(user, "sell", { buyer: seller, shop: original, lines, total });

    const shopName = original.identity.name;
    const summary = this.#summary(lines);
    if (working.trade.fundsMode === "finite") working.trade.funds -= total;

    const undo = [];
    try {
      for (const line of lines) {
        const { item } = line;
        // Put loaded rounds back in the ammo stack first; the stack stays with the seller.
        if (item.system?.hasAmmoLoaded && typeof item.unload === "function") await item.unload();

        if (working.trade.buyback) {
          const itemData = CPR.snapshot(item);
          if (line.units !== null) itemData.system.amount = line.units;
          working.buyback.unshift({ id: newId(), itemData, price: line.price, soldBy: seller.name, soldAt: Date.now() });
        }

        const remaining = line.units === null ? 0 : CPR.getAmount(item) - line.units;
        if (line.units !== null && remaining > 0) {
          const before = CPR.getAmount(item);
          await item.update({ "system.amount": remaining });
          undo.push(() => item.update({ "system.amount": before }));
        } else {
          const docs = [item, ...line.children];
          const data = docs.map((d) => d.toObject());
          await seller.deleteEmbeddedDocuments("Item", docs.map((d) => d.id));
          undo.push(() => seller.createEmbeddedDocuments("Item", data, { keepId: true, createInstalled: false, CPRsplitStack: true }));
        }
      }
      working.buyback = working.buyback.slice(0, LIMITS.maxBuyback);

      if (total > 0) {
        await CPR.changeWealth(seller, total, game.i18n.format("NEONMARKET.Ledger.Sold", { items: summary, shop: shopName }), user.name);
        undo.push(() => CPR.changeWealth(seller, -total, game.i18n.localize("NEONMARKET.Ledger.Rollback"), user.name));
        if (working.trade.fundsMode === "wallet" && CPR.hasWealth(shopActor)) {
          await CPR.changeWealth(shopActor, -total, game.i18n.format("NEONMARKET.Ledger.ShopBought", { items: summary, actor: seller.name }), user.name);
          undo.push(() => CPR.changeWealth(shopActor, total, game.i18n.localize("NEONMARKET.Ledger.Rollback"), user.name));
        }
      }
      await saveShop(shopActor, working);
      undo.push(() => saveShop(shopActor, original));
    } catch (err) {
      await this.#rollback(undo);
      throw err;
    }

    await this.#receipt({ kind: "sell", user, actor: seller, shop: original, lines, total });
    return { total, balance: CPR.getWealth(seller) };
  }

  /* ---------------------------------------- */
  /*  Helpers                                 */
  /* ---------------------------------------- */

  static async #resolve(actorUuid, shopUuid, user) {
    const buyer = await fromUuid(actorUuid);
    const shopActor = await fromUuid(shopUuid);
    if (!(buyer instanceof Actor) || !(shopActor instanceof Actor)) {
      throw new Error(game.i18n.localize("NEONMARKET.Error.BadActor"));
    }
    if (!user.isGM && !buyer.testUserPermission(user, "OWNER")) {
      throw new Error(game.i18n.localize("NEONMARKET.Error.NotOwner"));
    }
    if (!CPR.hasWealth(buyer)) throw new Error(game.i18n.format("NEONMARKET.Error.NoWealth", { name: buyer.name }));
    if (buyer.uuid === shopActor.uuid) throw new Error(game.i18n.localize("NEONMARKET.Error.SelfTrade"));
    return { buyer, shopActor };
  }

  static #summary(lines) {
    const text = lines.map((l) => (l.qty > 1 ? `${l.name} x${l.qty}` : l.name)).join(", ");
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }

  /**
   * Put purchased items on the actor and return an undo function.
   *
   * Stackables (ammo, clothing, drugs, gear) merge into an existing stack of the same
   * name and type, like CPR's automaticallyStackItems. Anything carrying installed
   * upgrades is created through CPRActor.createEmbeddedDocuments with its default
   * context, which rebuilds the upgrades from flags.cprInstallTree.
   */
  static async #grant(actor, line, shopName) {
    const data = deepClone(line.itemData);
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.source`, shopName);
    const carriesUpgrades = !!data.flags?.cprInstallTree?.length;

    if (CPR.isStackable(data)) {
      const units = Math.max(1, line.units);
      const existing = carriesUpgrades ? null : actor.items.find((i) =>
        i.type === data.type && i.name === data.name && CPR.isStackable(i) && !CPR.hasInstalled(i) && !CPR.isInstalled(i));
      if (existing) {
        const before = CPR.getAmount(existing);
        await existing.update({ "system.amount": before + units });
        return () => existing.update({ "system.amount": before });
      }
      data.system.amount = units;
      return this.#create(actor, [data]);
    }

    const copies = Math.min(LIMITS.maxCopies, Math.max(1, line.qty));
    return this.#create(actor, Array.from({ length: copies }, () => deepClone(data)));
  }

  static async #create(actor, dataList) {
    const created = (await actor.createEmbeddedDocuments("Item", dataList)).filter((d) => d instanceof Item);
    const ids = new Set();
    for (const doc of created) {
      ids.add(doc.id);
      for (const child of CPR.installedChildren(doc)) ids.add(child.id);
    }
    return () => actor.deleteEmbeddedDocuments("Item", [...ids].filter((id) => actor.items.has(id)));
  }

  static async #rollback(undo) {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (err) {
        console.error(`${MODULE_ID} | rollback step failed`, err);
      }
    }
  }

  static async #approve(user, kind, { buyer, shop, lines, total }) {
    if (user.isGM || !game.settings.get(MODULE_ID, "requireApproval")) return;
    const rows = lines.map((l) => `<li>${Handlebars.escapeExpression(l.name)} &times; ${l.qty} &mdash; ${formatEb(l.price)}</li>`).join("");
    const key = kind === "buy" ? "NEONMARKET.Approval.Buy" : "NEONMARKET.Approval.Sell";
    const ok = await Compat.DialogV2.confirm({
      classes: ["neon-market-dialog"],
      window: { title: game.i18n.localize("NEONMARKET.Approval.Title") },
      content: `<p>${game.i18n.format(key, { user: user.name, actor: buyer.name, shop: shop.identity.name, total: formatEb(total) })}</p><ul>${rows}</ul>`,
      rejectClose: false
    });
    if (!ok) throw new Error(game.i18n.localize("NEONMARKET.Error.Denied"));
  }

  static async #receipt({ kind, user, actor, shop, lines, total }) {
    const mode = game.settings.get(MODULE_ID, "receiptMode");
    if (mode === "none") return;
    const content = await Compat.renderTemplate(`modules/${MODULE_ID}/templates/chat-receipt.hbs`, {
      kind,
      isBuy: kind === "buy",
      shopName: shop.identity.name,
      owner: shop.identity.owner,
      accent: shop.identity.accent,
      theme: shop.theme,
      actorName: actor.name,
      lines: lines.map((l) => ({ name: l.name, qty: l.units ?? l.qty, price: formatEb(l.price) })),
      total: formatEb(total),
      balance: formatEb(CPR.getWealth(actor))
    });
    const data = { content, speaker: ChatMessage.getSpeaker({ actor }) };
    if (mode === "private") {
      const owners = game.users.filter((u) => u.isGM || actor.testUserPermission(u, "OWNER")).map((u) => u.id);
      data.whisper = [...new Set([...owners, user.id])];
    }
    await ChatMessage.create(data);
  }
}
