import { MODULE_ID, TEMPLATE_PATH, LIMITS } from "../constants.js";
import { Compat } from "../compat.js";
import { CPR } from "../cpr-adapter.js";
import { ShopAudio } from "../audio.js";
import { ShopSocket } from "../socket.js";
import {
  getShop, normalizeShop, buyPrice, basePrice, entryName, sellPrice, buysItem, shopFunds, tierFor, label, formatEb
} from "../shop-data.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Full-screen themed shop. One instance per shop actor per client.
 * In preview mode it renders an unsaved draft from the editor and never trades.
 */
export class ShopApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, ShopApp>} */
  static instances = new Map();

  constructor(shopActor, { preview = false, draft = null, ...options } = {}) {
    super({ id: `${MODULE_ID}-shop-${shopActor.uuid.replaceAll(".", "-")}`, ...options });
    this.shopActor = shopActor;
    this.preview = preview;
    this.draft = draft;
    this.state = {
      mode: "buy",
      category: "all",
      focus: null,
      qty: 1,
      cart: [],
      search: "",
      speechKey: "greeting",
      buyerUuid: CPR.defaultBuyer()?.uuid ?? null,
      busy: false
    };
    this._lastSpeech = null;
    this._opened = false;
  }

  static DEFAULT_OPTIONS = {
    classes: ["neon-market", "nm-app"],
    tag: "div",
    window: { frame: false, positioned: false },
    actions: {
      close: ShopApp.#onClose,
      setMode: ShopApp.#onSetMode,
      setCategory: ShopApp.#onSetCategory,
      focus: ShopApp.#onFocus,
      qtyUp: ShopApp.#onQtyUp,
      qtyDown: ShopApp.#onQtyDown,
      addToCart: ShopApp.#onAddToCart,
      removeFromCart: ShopApp.#onRemoveFromCart,
      checkout: ShopApp.#onCheckout,
      sell: ShopApp.#onSell,
      configure: ShopApp.#onConfigure
    }
  };

  static PARTS = {
    shop: {
      template: `${TEMPLATE_PATH}/shop.hbs`,
      scrollable: [".nm-list", ".nm-detail-body", ".nm-cart-lines"]
    }
  };

  /* ---------------------------------------- */
  /*  Opening                                 */
  /* ---------------------------------------- */

  static open(actor, options = {}) {
    if (!actor) return null;
    for (const [uuid, app] of this.instances) {
      if (uuid !== actor.uuid) app.close();
    }
    let app = this.instances.get(actor.uuid);
    if (app) {
      if (options.preview !== undefined) app.preview = options.preview;
      if (options.draft) app.draft = options.draft;
    } else {
      app = new this(actor, options);
      this.instances.set(actor.uuid, app);
    }
    app.render({ force: true });
    return app;
  }

  /** Re-render any open shop affected by a change to this actor (shop or buyer). */
  static refreshFor(actor) {
    for (const app of this.instances.values()) {
      if (app.shopActor.uuid === actor.uuid || app.state.buyerUuid === actor.uuid) app.render();
    }
  }

  get shop() {
    return this.draft ? normalizeShop(this.draft, this.shopActor) : getShop(this.shopActor);
  }

  get buyer() {
    return this.state.buyerUuid ? fromUuidSync(this.state.buyerUuid) : null;
  }

  setDraft(draft) {
    this.draft = draft;
    if (this.rendered) this.render();
  }

  /* ---------------------------------------- */
  /*  Context                                 */
  /* ---------------------------------------- */

  async _prepareContext(options) {
    const shop = this.shop;
    const buyer = this.buyer;
    const wealth = buyer ? CPR.getWealth(buyer) : 0;
    const L = (k) => label(shop, k);
    const s = this.state;
    const allowSell = shop.trade.allowSell && game.settings.get(MODULE_ID, "playersCanSell");
    const allowBuyback = shop.trade.buyback && shop.buyback.length > 0;

    if (s.mode === "sell" && !allowSell) s.mode = "buy";
    if (s.mode === "buyback" && !allowBuyback) s.mode = "buy";
    if (s.category !== "all" && !shop.categories.some((c) => c.id === s.category)) s.category = "all";

    const cart = this.#buildCart(shop, wealth);
    const listings = this.#buildListings(shop, buyer, wealth, cart);
    const focus = await this.#buildFocus(shop, buyer, listings, cart);

    const modes = [
      { key: "buy", label: L("buy"), icon: "fa-solid fa-cart-shopping", active: s.mode === "buy" }
    ];
    if (allowSell) modes.push({ key: "sell", label: L("sell"), icon: "fa-solid fa-hand-holding-dollar", active: s.mode === "sell" });
    if (allowBuyback) modes.push({ key: "buyback", label: L("buyback"), icon: "fa-solid fa-rotate-left", active: s.mode === "buyback", count: shop.buyback.length });

    const categories = [
      { id: "all", name: L("all"), active: s.category === "all", count: shop.categories.reduce((n, c) => n + c.items.length, 0) },
      ...shop.categories.map((c) => ({ id: c.id, name: c.name, active: s.category === c.id, count: c.items.length }))
    ];

    const id = shop.identity;
    const bg = id.background ? `--nm-bg-image:url("${id.background}");` : "";
    const style = `--nm-accent:${id.accent};--nm-accent-2:${id.accent2};${bg}`;

    const speech = shop.speech[s.speechKey] || shop.speech.greeting || "";

    return {
      shop,
      identity: id,
      style,
      rootClass: `theme-${shop.theme} layout-${shop.layout}${this.preview ? " is-preview" : ""}${s.busy ? " is-busy" : ""}`,
      isCharacter: shop.layout === "character",
      isGrid: shop.layout === "grid",
      isGM: game.user.isGM,
      preview: this.preview,
      closedBanner: !shop.enabled && game.user.isGM && !this.preview,
      labels: {
        buy: L("buy"), sell: L("sell"), buyback: L("buyback"), cart: L("cart"), checkout: L("checkout"),
        total: L("total"), balance: L("balance"), outOfStock: L("outOfStock"), all: L("all")
      },
      modes,
      showCategories: s.mode === "buy",
      categories,
      listings,
      emptyText: this.#emptyText(shop),
      focus,
      cart,
      mode: s.mode,
      isBuyMode: s.mode === "buy",
      isSellMode: s.mode === "sell",
      search: s.search,
      speech,
      buyer: buyer ? { name: buyer.name, img: buyer.img, wealth: formatEb(wealth) } : null,
      buyers: CPR.buyerCandidates().map((a) => ({ uuid: a.uuid, name: a.name, selected: a.uuid === s.buyerUuid })),
      funds: shopFunds(shop, this.shopActor) === null ? null : formatEb(shopFunds(shop, this.shopActor)),
      showTiers: game.settings.get(MODULE_ID, "showPriceTiers")
    };
  }

  #matchesSearch(name) {
    const q = this.state.search.trim().toLowerCase();
    return !q || name.toLowerCase().includes(q);
  }

  #buildListings(shop, buyer, wealth, cart) {
    const s = this.state;
    const out = [];

    if (s.mode === "buy") {
      for (const cat of shop.categories) {
        if (s.category !== "all" && s.category !== cat.id) continue;
        for (const entry of cat.items) {
          const name = entryName(entry);
          if (!this.#matchesSearch(name)) continue;
          const price = buyPrice(entry, shop);
          const list = basePrice(entry);
          const key = `catalog:${cat.id}:${entry.id}`;
          const inCart = cart.lines.find((l) => l.key === key)?.qty ?? 0;
          const tier = tierFor(list, entry.tier);
          out.push({
            key,
            source: "catalog",
            categoryId: cat.id,
            entryId: entry.id,
            name,
            img: entry.itemData.img,
            type: CPR.typeLabel(entry.itemData.type),
            price: formatEb(price),
            perBox: CPR.lotAmount(entry.itemData) > 1 ? CPR.lotAmount(entry.itemData) : null,
            upgraded: !!entry.itemData.flags?.cprInstallTree?.length,
            listPrice: price !== list ? formatEb(list) : null,
            discount: entry.discount || 0,
            stock: entry.stock,
            finiteStock: entry.stock >= 0,
            outOfStock: entry.stock === 0,
            lowStock: entry.stock > 0 && entry.stock <= 3,
            tierKey: tier.key,
            tierLabel: game.i18n.localize(tier.label),
            affordable: wealth >= price,
            inCart,
            focused: s.focus?.key === key
          });
        }
      }
    } else if (s.mode === "buyback") {
      for (const b of shop.buyback) {
        if (!this.#matchesSearch(b.itemData.name)) continue;
        const key = `buyback:${b.id}`;
        const tier = tierFor(CPR.getMarketPrice(b.itemData));
        out.push({
          key,
          source: "buyback",
          entryId: b.id,
          name: b.itemData.name,
          img: b.itemData.img,
          type: CPR.typeLabel(b.itemData.type),
          price: formatEb(b.price),
          amount: CPR.isStackable(b.itemData) ? CPR.getAmount(b.itemData) : null,
          upgraded: !!b.itemData.flags?.cprInstallTree?.length,
          soldBy: b.soldBy,
          tierKey: tier.key,
          tierLabel: game.i18n.localize(tier.label),
          affordable: wealth >= b.price,
          inCart: cart.lines.some((l) => l.key === key) ? 1 : 0,
          focused: s.focus?.key === key
        });
      }
    } else if (s.mode === "sell" && buyer) {
      const items = buyer.items
        .filter((i) => CPR.isSellable(i) && buysItem(i, this.shopActor))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (!this.#matchesSearch(item.name)) continue;
        const key = `sell:${item.id}`;
        const stack = CPR.isStackable(item);
        const value = sellPrice(item, stack ? CPR.getAmount(item) : 1, shop, this.shopActor);
        const tier = tierFor(CPR.getMarketPrice(item));
        out.push({
          key,
          source: "sell",
          itemId: item.id,
          name: item.name,
          img: item.img,
          type: CPR.typeLabel(item.type),
          price: formatEb(value),
          amount: stack ? CPR.getAmount(item) : null,
          upgraded: CPR.hasInstalled(item),
          tierKey: tier.key,
          tierLabel: game.i18n.localize(tier.label),
          affordable: true,
          focused: s.focus?.key === key
        });
      }
    }
    return out;
  }

  #buildCart(shop, wealth) {
    const lines = [];
    let total = 0;
    this.state.cart = this.state.cart.filter((row) => {
      if (row.source === "buyback") {
        const b = shop.buyback.find((x) => x.id === row.entryId);
        if (!b) return false;
        lines.push({ key: `buyback:${b.id}`, name: b.itemData.name, img: b.itemData.img, qty: 1, price: formatEb(b.price) });
        total += b.price;
        return true;
      }
      const cat = shop.categories.find((c) => c.id === row.categoryId);
      const entry = cat?.items.find((e) => e.id === row.entryId);
      if (!entry) return false;
      const unit = buyPrice(entry, shop);
      lines.push({ key: `catalog:${cat.id}:${entry.id}`, name: entryName(entry), img: entry.itemData.img, qty: row.qty, price: formatEb(unit * row.qty) });
      total += unit * row.qty;
      return true;
    });
    const buyer = this.buyer;
    return {
      lines,
      count: lines.reduce((n, l) => n + l.qty, 0),
      empty: !lines.length,
      total: formatEb(total),
      totalValue: total,
      after: formatEb(wealth - total),
      overBudget: total > wealth,
      canCheckout: !!buyer && lines.length > 0 && total <= wealth && !this.state.busy
    };
  }

  async #buildFocus(shop, buyer, listings, cart) {
    const s = this.state;
    if (!s.focus) return null;
    const listing = listings.find((l) => l.key === s.focus.key);
    if (!listing) {
      s.focus = null;
      return null;
    }

    let itemLike;
    let maxQty = LIMITS.maxQty;
    let stepLabel = null;
    if (listing.source === "catalog") {
      const cat = shop.categories.find((c) => c.id === listing.categoryId);
      const entry = cat.items.find((e) => e.id === listing.entryId);
      itemLike = entry.itemData;
      if (entry.stock >= 0) maxQty = Math.max(0, entry.stock - (listing.inCart || 0));
      if (CPR.lotAmount(itemLike) > 1) stepLabel = game.i18n.format("NEONMARKET.UI.PackOf", { n: CPR.lotAmount(itemLike) });
    } else if (listing.source === "buyback") {
      itemLike = shop.buyback.find((b) => b.id === listing.entryId).itemData;
      maxQty = listing.inCart ? 0 : 1;
    } else {
      itemLike = buyer.items.get(listing.itemId);
      if (CPR.isStackable(itemLike) && !CPR.hasInstalled(itemLike)) {
        maxQty = CPR.getAmount(itemLike);
        stepLabel = game.i18n.format("NEONMARKET.UI.OfN", { n: maxQty });
      } else maxQty = 1;
    }
    s.qty = Math.max(1, Math.min(s.qty, Math.max(1, maxQty)));

    let description = "";
    try {
      description = await Compat.enrichHTML(CPR.description(itemLike), { secrets: false, relativeTo: this.shopActor });
    } catch {
      description = "";
    }

    let lineValue;
    if (listing.source === "sell") {
      const units = CPR.isStackable(itemLike) ? (CPR.hasInstalled(itemLike) ? CPR.getAmount(itemLike) : s.qty) : 1;
      lineValue = sellPrice(itemLike, units, shop, this.shopActor);
    } else if (listing.source === "buyback") {
      lineValue = Number(shop.buyback.find((b) => b.id === listing.entryId).price) || 0;
    } else {
      const entry = shop.categories.find((c) => c.id === listing.categoryId).items.find((e) => e.id === listing.entryId);
      lineValue = buyPrice(entry, shop) * s.qty;
    }

    return {
      ...listing,
      description,
      stats: CPR.statLines(itemLike),
      qty: s.qty,
      maxQty,
      canStep: maxQty > 1,
      stepLabel,
      lineTotal: formatEb(lineValue),
      soldOut: maxQty <= 0,
      canAdd: listing.source !== "sell" && maxQty > 0 && !this.state.busy,
      canSell: listing.source === "sell" && maxQty > 0 && !this.state.busy
    };
  }

  #emptyText(shop) {
    if (this.state.search) return game.i18n.localize("NEONMARKET.UI.NoMatches");
    if (this.state.mode === "sell") {
      return this.buyer ? game.i18n.localize("NEONMARKET.UI.NothingToSell") : game.i18n.localize("NEONMARKET.UI.PickBuyer");
    }
    if (!shop.categories.length) return game.i18n.localize("NEONMARKET.UI.EmptyShop");
    return game.i18n.localize("NEONMARKET.UI.EmptyCategory");
  }

  /* ---------------------------------------- */
  /*  Rendering                               */
  /* ---------------------------------------- */

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this.element.setAttribute("tabindex", "-1");
    this.element.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !ev.target.closest("input, select, textarea")) {
        ev.preventDefault();
        ev.stopPropagation();
        this.close();
      }
    });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (this._pendingFlash) {
      const shell = root.querySelector(".nm-shell");
      shell?.classList.add(`flash-${this._pendingFlash}`);
      this._pendingFlash = null;
    }

    root.querySelector("select[name=buyer]")?.addEventListener("change", (ev) => {
      this.state.buyerUuid = ev.currentTarget.value || null;
      this.state.cart = [];
      this.state.focus = null;
      this.render();
    });

    const search = root.querySelector("input[name=search]");
    if (search) {
      search.addEventListener("input", foundry.utils.debounce((ev) => {
        this.state.search = ev.target.value;
        this._restoreSearchFocus = true;
        this.render();
      }, 200));
      if (this._restoreSearchFocus) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
        this._restoreSearchFocus = false;
      }
    }

    this.#typeSpeech(context.speech);

    if (!this._opened) {
      this._opened = true;
      ShopAudio.start(context.shop);
      ShopAudio.sfx(context.shop, "open");
      root.focus({ preventScroll: true });
    }
  }

  /** Typewriter effect for the speech bubble; skipped when the user prefers reduced motion. */
  #typeSpeech(text) {
    const el = this.element.querySelector("[data-speech]");
    if (!el) return;
    if (text === this._lastSpeech) {
      el.textContent = text;
      return;
    }
    this._lastSpeech = text;
    clearInterval(this._typer);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !text) {
      el.textContent = text;
      return;
    }
    let i = 0;
    el.textContent = "";
    this._typer = setInterval(() => {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(this._typer);
    }, 18);
  }

  say(key) {
    this.state.speechKey = key;
  }

  sfx(slot) {
    ShopAudio.sfx(this.shop, slot);
  }

  async _preClose(options) {
    await super._preClose?.(options);
    clearInterval(this._typer);
  }

  _onClose(options) {
    super._onClose?.(options);
    if (ShopApp.instances.get(this.shopActor.uuid) === this) ShopApp.instances.delete(this.shopActor.uuid);
    if (!ShopApp.instances.size) ShopAudio.stop();
  }

  /* ---------------------------------------- */
  /*  Actions                                 */
  /* ---------------------------------------- */

  static #onClose() {
    this.close();
  }

  static #onSetMode(event, target) {
    const mode = target.dataset.mode;
    if (mode === this.state.mode) return;
    this.state.mode = mode;
    this.state.focus = null;
    this.state.qty = 1;
    this.sfx("page");
    this.render();
  }

  static #onSetCategory(event, target) {
    const id = target.dataset.category;
    if (id === this.state.category) return;
    this.state.category = id;
    this.state.focus = null;
    this.state.qty = 1;
    this.sfx("page");
    this.render();
  }

  static #onFocus(event, target) {
    const key = target.dataset.key;
    if (this.state.focus?.key === key) return;
    this.state.focus = { key };
    this.state.qty = 1;
    this.say("select");
    this.sfx("select");
    this.render();
  }

  static #onQtyUp(event, target) {
    const max = Number(target.dataset.max) || 1;
    this.state.qty = Math.min(max, this.state.qty + (event.shiftKey ? 10 : 1));
    this.render();
  }

  static #onQtyDown(event) {
    this.state.qty = Math.max(1, this.state.qty - (event.shiftKey ? 10 : 1));
    this.render();
  }

  static #onAddToCart() {
    const key = this.state.focus?.key;
    if (!key) return;
    const [source, a, b] = key.split(":");
    const cart = this.state.cart;
    if (source === "buyback") {
      if (!cart.some((r) => r.source === "buyback" && r.entryId === a)) cart.push({ source, entryId: a, qty: 1 });
    } else {
      const row = cart.find((r) => r.source === "catalog" && r.categoryId === a && r.entryId === b);
      if (row) row.qty = Math.min(LIMITS.maxQty, row.qty + this.state.qty);
      else cart.push({ source: "catalog", categoryId: a, entryId: b, qty: this.state.qty });
    }
    this.state.qty = 1;
    this.sfx("select");
    this.render();
  }

  static #onRemoveFromCart(event, target) {
    const key = target.dataset.key;
    this.state.cart = this.state.cart.filter((r) => {
      const k = r.source === "buyback" ? `buyback:${r.entryId}` : `catalog:${r.categoryId}:${r.entryId}`;
      return k !== key;
    });
    this.render();
  }

  static async #onCheckout() {
    if (this.state.busy) return;
    const shop = this.shop;
    const buyer = this.buyer;
    if (this.preview) return ui.notifications.info(game.i18n.localize("NEONMARKET.UI.PreviewNoTrade"));
    if (!buyer) return ui.notifications.warn(game.i18n.localize("NEONMARKET.UI.PickBuyer"));
    const cart = this.#buildCart(shop, CPR.getWealth(buyer));
    if (!cart.lines.length) return;
    if (cart.overBudget) {
      this.say("noFunds");
      this.sfx("error");
      return this.render();
    }

    const rows = cart.lines.map((l) => `<li>${Handlebars.escapeExpression(l.name)} &times; ${l.qty} &mdash; ${l.price}</li>`).join("");
    const ok = await Compat.DialogV2.confirm({
      window: { title: label(shop, "checkout") },
      content: `<p>${game.i18n.format("NEONMARKET.UI.ConfirmBuy", { actor: Handlebars.escapeExpression(buyer.name), total: cart.total, after: cart.after })}</p><ul class="nm-confirm-list">${rows}</ul>`,
      rejectClose: false
    });
    if (!ok) return;

    await this.#trade("buy", {
      buyerUuid: buyer.uuid,
      shopUuid: this.shopActor.uuid,
      cart: this.state.cart.map((r) => ({ ...r }))
    }, () => {
      this.state.cart = [];
      this.state.focus = null;
      this.say("purchase");
    });
  }

  static async #onSell() {
    if (this.state.busy) return;
    const buyer = this.buyer;
    const key = this.state.focus?.key;
    if (this.preview) return ui.notifications.info(game.i18n.localize("NEONMARKET.UI.PreviewNoTrade"));
    if (!buyer || !key?.startsWith("sell:")) return;
    const itemId = key.split(":")[1];
    const item = buyer.items.get(itemId);
    if (!item) return;
    const shop = this.shop;
    const stack = CPR.isStackable(item);
    const units = stack ? (CPR.hasInstalled(item) ? CPR.getAmount(item) : this.state.qty) : 1;
    const qty = units;
    const payout = sellPrice(item, units, shop, this.shopActor);

    const ok = await Compat.DialogV2.confirm({
      window: { title: label(shop, "sell") },
      content: `<p>${game.i18n.format("NEONMARKET.UI.ConfirmSell", {
        actor: Handlebars.escapeExpression(buyer.name), item: Handlebars.escapeExpression(item.name), qty: units, total: formatEb(payout)
      })}</p>${CPR.hasInstalled(item) ? `<p>${game.i18n.localize("NEONMARKET.UI.SellWithUpgrades")}</p>` : ""}${item.system?.hasAmmoLoaded ? `<p>${game.i18n.localize("NEONMARKET.UI.SellUnloads")}</p>` : ""}`,
      rejectClose: false
    });
    if (!ok) return;

    await this.#trade("sell", {
      sellerUuid: buyer.uuid,
      shopUuid: this.shopActor.uuid,
      items: [{ itemId, qty }]
    }, () => {
      this.state.focus = null;
      this.say("sell");
    });
  }

  static #onConfigure() {
    if (!game.user.isGM) return;
    game.modules.get(MODULE_ID).api.configure(this.shopActor);
  }

  async #trade(op, payload, onSuccess) {
    this.state.busy = true;
    this.render();
    try {
      const result = await ShopSocket.request(op, payload);
      onSuccess?.(result);
      this.sfx("purchase");
      this.#flash("success");
    } catch (err) {
      ui.notifications.warn(err.message);
      if (err.code === "noFunds") this.say("noFunds");
      this.sfx("error");
      this.#flash("error");
    } finally {
      this.state.busy = false;
      if (this.rendered) this.render();
    }
  }

  /** Queue a one-shot flash; applied on the next render because the part is re-drawn. */
  #flash(kind) {
    this._pendingFlash = kind;
  }
}
