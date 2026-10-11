import { MODULE_ID, TEMPLATE_PATH, THEMES, LAYOUTS, PRICE_TIERS, SPEECH_KEYS, LABEL_KEYS, SFX_SLOTS } from "../constants.js";
import { Compat } from "../compat.js";
import { CPR } from "../cpr-adapter.js";
import { ShopApp } from "./shop-app.js";
import {
  getShop, saveShop, makeEntry, newId, normalizeEntry, worldSellRate, formatEb, buyPrice
} from "../shop-data.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { deepClone, getProperty, setProperty, debounce } = foundry.utils;

/**
 * GM-only editor for one shop. Works on a draft copy; nothing is written
 * until "Save". Edits stream into an open preview shop as you type.
 */
export class ShopConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Map();

  constructor(actor, options = {}) {
    super({ id: `${MODULE_ID}-config-${actor.uuid.replaceAll(".", "-")}`, ...options });
    this.actor = actor;
    this.draft = getShop(actor);
    this.activeTab = "identity";
    this.dirty = false;
    this.#pushPreview = debounce(() => this.#sendPreview(), 120);
  }

  #pushPreview;

  static DEFAULT_OPTIONS = {
    classes: ["neon-market", "nm-config"],
    tag: "div",
    window: {
      title: "NEONMARKET.Config.Title",
      icon: "fa-solid fa-store",
      resizable: true
    },
    position: { width: 900, height: 760 },
    actions: {
      tab: ShopConfigApp.#onTab,
      addCategory: ShopConfigApp.#onAddCategory,
      removeCategory: ShopConfigApp.#onRemoveCategory,
      moveCategory: ShopConfigApp.#onMoveCategory,
      removeItem: ShopConfigApp.#onRemoveItem,
      moveItem: ShopConfigApp.#onMoveItem,
      importInventory: ShopConfigApp.#onImportInventory,
      pickFile: ShopConfigApp.#onPickFile,
      testSound: ShopConfigApp.#onTestSound,
      clearBuyback: ShopConfigApp.#onClearBuyback,
      resetSpeech: ShopConfigApp.#onResetSpeech,
      preview: ShopConfigApp.#onPreview,
      openShop: ShopConfigApp.#onOpenShop,
      save: ShopConfigApp.#onSave
    }
  };

  static PARTS = {
    body: {
      template: `${TEMPLATE_PATH}/shop-config.hbs`,
      scrollable: [".nm-config-pane"]
    }
  };

  static open(actor) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("NEONMARKET.Error.GMOnly"));
    let app = this.instances.get(actor.uuid);
    if (!app) {
      app = new this(actor);
      this.instances.set(actor.uuid, app);
    }
    app.render({ force: true });
    return app;
  }

  get title() {
    return `${game.i18n.localize("NEONMARKET.Config.Title")}: ${this.actor.name}`;
  }

  /* ---------------------------------------- */
  /*  Context                                 */
  /* ---------------------------------------- */

  async _prepareContext() {
    const d = this.draft;
    const pct = (v) => (v === null || v === undefined || v === "" ? "" : Math.round(Number(v) * 100));

    const themeGroups = Object.entries(LAYOUTS).map(([layout, lbl]) => ({
      label: game.i18n.localize(lbl),
      themes: Object.entries(THEMES)
        .filter(([, t]) => t.layout === layout)
        .map(([key, t]) => ({ key, label: game.i18n.localize(t.label), selected: key === d.theme }))
    }));

    const tiers = [
      { key: "", label: game.i18n.localize("NEONMARKET.Config.TierAuto") },
      ...PRICE_TIERS.map((t) => ({ key: t.key, label: game.i18n.localize(t.label) }))
    ];

    const categories = d.categories.map((cat, ci) => ({
      ...cat,
      index: ci,
      first: ci === 0,
      last: ci === d.categories.length - 1,
      items: cat.items.map((entry, ii) => ({
        ...entry,
        index: ii,
        first: ii === 0,
        last: ii === cat.items.length - 1,
        originalName: entry.itemData.name,
        img: entry.itemData.img,
        type: CPR.typeLabel(entry.itemData.type),
        market: CPR.lotPrice(entry.itemData),
        lot: CPR.lotAmount(entry.itemData) > 1 ? CPR.lotAmount(entry.itemData) : null,
        upgraded: !!entry.itemData.flags?.cprInstallTree?.length,
        finalPrice: formatEb(buyPrice(entry, d)),
        sellRatePct: pct(entry.sellRate),
        tierOptions: tiers.map((t) => ({ ...t, selected: t.key === (entry.tier ?? "") }))
      }))
    }));

    const tabs = ["identity", "style", "catalog", "audio", "trade"].map((key) => ({
      key,
      label: game.i18n.localize(`NEONMARKET.Config.Tab.${key}`),
      active: this.activeTab === key
    }));

    return {
      d,
      tabs,
      tab: Object.fromEntries(tabs.map((t) => [t.key, t.active])),
      dirty: this.dirty,
      themeGroups,
      layouts: Object.entries(LAYOUTS).map(([key, lbl]) => ({ key, label: game.i18n.localize(lbl), selected: d.layout === key })),
      speech: SPEECH_KEYS.map((key) => ({
        key,
        label: game.i18n.localize(`NEONMARKET.Config.Speech.${key}`),
        value: d.speech[key] ?? ""
      })),
      labelRows: LABEL_KEYS.map((key) => ({
        key,
        placeholder: game.i18n.localize(`NEONMARKET.Label.${key}`),
        value: d.labels[key] ?? ""
      })),
      categories,
      itemCount: d.categories.reduce((n, c) => n + c.items.length, 0),
      sfx: SFX_SLOTS.map((key) => ({
        key,
        label: game.i18n.localize(`NEONMARKET.Config.Sfx.${key}`),
        value: d.audio[key] ?? ""
      })),
      sellRatePct: pct(d.trade.sellRate),
      worldSellRatePct: Math.round(worldSellRate() * 100),
      finite: d.trade.fundsMode === "finite",
      wallet: d.trade.fundsMode === "wallet",
      actorHasWallet: CPR.hasWealth(this.actor),
      actorWallet: CPR.hasWealth(this.actor) ? formatEb(CPR.getWealth(this.actor)) : null,
      isVendor: this.actor.type === "container",
      buybackCount: d.buyback.length
    };
  }

  /* ---------------------------------------- */
  /*  Rendering and input binding             */
  /* ---------------------------------------- */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    for (const input of root.querySelectorAll("[data-path]")) {
      const evt = input.matches("input[type=text], input[type=search], textarea, input[type=color], input[type=range]") ? "input" : "change";
      input.addEventListener(evt, (ev) => this.#onField(ev));
    }

    for (const zone of root.querySelectorAll("[data-drop-category]")) {
      zone.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        zone.classList.add("drag-over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
      zone.addEventListener("drop", (ev) => {
        zone.classList.remove("drag-over");
        this.#onDrop(ev, zone.dataset.dropCategory);
      });
    }
  }

  #coerce(input) {
    const type = input.dataset.dtype ?? "String";
    const raw = input.type === "checkbox" ? input.checked : input.value;
    switch (type) {
      case "Boolean": return !!raw;
      case "Number": return raw === "" ? 0 : Number(raw);
      case "NumberOrNull": return raw === "" ? null : Number(raw);
      case "Percent": return raw === "" ? null : Math.max(0, Math.min(100, Number(raw))) / 100;
      default: return String(raw);
    }
  }

  #onField(ev) {
    const input = ev.currentTarget;
    const path = input.dataset.path;
    const value = this.#coerce(input);
    setProperty(this.draft, path, value);
    this.dirty = true;
    this.element.querySelector(".nm-config-dirty")?.classList.add("visible");

    if (path === "theme") {
      const t = THEMES[value];
      if (t) {
        this.draft.identity.accent = t.accent;
        this.draft.identity.accent2 = t.accent2;
        this.draft.layout = t.layout;
      }
      this.render();
    } else if (path === "trade.fundsMode" || path.startsWith("categories.")) {
      if (ev.type === "change") this.render();
    }
    this.#pushPreview();
  }

  #touch() {
    this.dirty = true;
    this.render();
    this.#pushPreview();
  }

  #sendPreview() {
    const app = ShopApp.instances.get(this.actor.uuid);
    if (app?.preview) app.setDraft(deepClone(this.draft));
  }

  async #onDrop(event, categoryId) {
    event.preventDefault();
    const data = Compat.getDragEventData(event);
    if (!data) return;
    let cat = this.draft.categories.find((c) => c.id === categoryId);
    if (!cat) {
      cat = { id: newId(), name: game.i18n.localize("NEONMARKET.Default.Category"), items: [] };
      this.draft.categories.push(cat);
    }

    const items = [];
    if (data.type === "Item" && data.uuid) {
      const item = await fromUuid(data.uuid);
      if (item) items.push(item);
    } else if (data.type === "Folder" && data.uuid) {
      const folder = await fromUuid(data.uuid);
      if (folder?.type === "Item") {
        const contents = folder.contents?.length ? folder.contents : [];
        for (const doc of contents) {
          // Compendium folders hold index entries; resolve them to full documents.
          const item = doc.uuid && !(doc instanceof Item) ? await fromUuid(doc.uuid) : doc;
          if (item) items.push(item);
        }
      }
    }

    let skipped = 0;
    for (const item of items) {
      if (!CPR.isListable(item)) {
        skipped++;
        continue;
      }
      cat.items.push(makeEntry(item));
    }
    if (skipped) ui.notifications.info(game.i18n.format("NEONMARKET.Config.Skipped", { n: skipped }));
    if (items.length) this.#touch();
  }

  /* ---------------------------------------- */
  /*  Actions                                 */
  /* ---------------------------------------- */

  static #onTab(event, target) {
    this.activeTab = target.dataset.tab;
    this.render();
  }

  static #onAddCategory() {
    this.draft.categories.push({
      id: newId(),
      name: game.i18n.format("NEONMARKET.Config.NewCategory", { n: this.draft.categories.length + 1 }),
      items: []
    });
    this.#touch();
  }

  static async #onRemoveCategory(event, target) {
    const idx = Number(target.dataset.index);
    const cat = this.draft.categories[idx];
    if (!cat) return;
    if (cat.items.length) {
      const ok = await Compat.DialogV2.confirm({
        classes: ["neon-market-dialog"],
        window: { title: game.i18n.localize("NEONMARKET.Config.RemoveCategory") },
        content: `<p>${game.i18n.format("NEONMARKET.Config.RemoveCategoryConfirm", { name: Handlebars.escapeExpression(cat.name), n: cat.items.length })}</p>`,
        rejectClose: false
      });
      if (!ok) return;
    }
    this.draft.categories.splice(idx, 1);
    this.#touch();
  }

  static #onMoveCategory(event, target) {
    const idx = Number(target.dataset.index);
    const to = idx + Number(target.dataset.dir);
    const cats = this.draft.categories;
    if (to < 0 || to >= cats.length) return;
    [cats[idx], cats[to]] = [cats[to], cats[idx]];
    this.#touch();
  }

  static #onRemoveItem(event, target) {
    const cat = this.draft.categories[Number(target.dataset.category)];
    cat?.items.splice(Number(target.dataset.index), 1);
    this.#touch();
  }

  static #onMoveItem(event, target) {
    const cat = this.draft.categories[Number(target.dataset.category)];
    if (!cat) return;
    const idx = Number(target.dataset.index);
    const to = idx + Number(target.dataset.dir);
    if (to < 0 || to >= cat.items.length) return;
    [cat.items[idx], cat.items[to]] = [cat.items[to], cat.items[idx]];
    this.#touch();
  }

  /** Copy the host actor's own priced items into a new category, grouping duplicates into stock. */
  static #onImportInventory() {
    const groups = new Map();
    for (const item of this.actor.items) {
      if (!CPR.isListable(item) || CPR.isInstalled(item) || CPR.getMarketPrice(item) <= 0) continue;
      let lot = 1;
      let count = 1;
      if (CPR.isStackable(item)) {
        const amount = CPR.getAmount(item);
        if (amount < 1) continue;
        lot = CPR.defaultLot(item);
        count = Math.floor(amount / lot);
        if (count < 1) {
          lot = amount;
          count = 1;
        }
      }
      // Upgraded items keep their own listing so their upgrades stay attached.
      const key = CPR.hasInstalled(item) ? `id::${item.id}` : `${item.type}::${item.name}::${lot}`;
      const g = groups.get(key);
      if (g) g.stock += count;
      else groups.set(key, { item, stock: count, lot });
    }
    if (!groups.size) return ui.notifications.info(game.i18n.localize("NEONMARKET.Config.NothingToImport"));
    const items = [...groups.values()].map(({ item, stock, lot }) => {
      const entry = makeEntry(item);
      entry.stock = Math.max(0, stock);
      if (CPR.isStackable(entry.itemData)) entry.itemData.system.amount = lot;
      return normalizeEntry(entry);
    });
    this.draft.categories.push({ id: newId(), name: game.i18n.localize("NEONMARKET.Config.ImportedCategory"), items });
    ui.notifications.info(game.i18n.format("NEONMARKET.Config.Imported", { n: items.length }));
    this.#touch();
  }

  static #onPickFile(event, target) {
    const path = target.dataset.target;
    const FP = Compat.FilePicker;
    const picker = new FP({
      type: target.dataset.type ?? "image",
      current: getProperty(this.draft, path) || "",
      callback: (file) => {
        setProperty(this.draft, path, file);
        this.#touch();
      }
    });
    picker.render(true);
  }

  static #onTestSound(event, target) {
    const src = getProperty(this.draft, target.dataset.target);
    if (!src) return;
    const volume = target.dataset.target === "audio.bgm" ? this.draft.audio.bgmVolume : this.draft.audio.sfxVolume;
    Compat.AudioHelper.play({ src, volume: Number(volume) || 0.5, loop: false, autoplay: true, channel: "interface" }, false);
  }

  static async #onClearBuyback() {
    const ok = await Compat.DialogV2.confirm({
      classes: ["neon-market-dialog"],
      window: { title: game.i18n.localize("NEONMARKET.Config.ClearBuyback") },
      content: `<p>${game.i18n.localize("NEONMARKET.Config.ClearBuybackConfirm")}</p>`,
      rejectClose: false
    });
    if (!ok) return;
    this.draft.buyback = [];
    this.#touch();
  }

  static #onResetSpeech() {
    for (const k of SPEECH_KEYS) this.draft.speech[k] = game.i18n.localize(`NEONMARKET.Speech.${k}`);
    this.#touch();
  }

  static #onPreview() {
    ShopApp.open(this.actor, { preview: true, draft: deepClone(this.draft) });
    setTimeout(() => this.bringToFront?.(), 50);
  }

  static async #onOpenShop() {
    if (this.dirty) await ShopConfigApp.#onSave.call(this);
    ShopApp.open(this.actor, { preview: false });
  }

  static async #onSave() {
    await saveShop(this.actor, this.draft);
    this.dirty = false;
    ui.notifications.info(game.i18n.format("NEONMARKET.Config.Saved", { name: this.draft.identity.name }));
    this.render();
  }

  async close(options = {}) {
    if (this.dirty && !options.force) {
      const ok = await Compat.DialogV2.confirm({
        classes: ["neon-market-dialog"],
        window: { title: game.i18n.localize("NEONMARKET.Config.Unsaved") },
        content: `<p>${game.i18n.localize("NEONMARKET.Config.UnsavedConfirm")}</p>`,
        rejectClose: false
      });
      if (!ok) return this;
    }
    return super.close(options);
  }

  _onClose(options) {
    super._onClose?.(options);
    ShopConfigApp.instances.delete(this.actor.uuid);
    const app = ShopApp.instances.get(this.actor.uuid);
    if (app?.preview) app.close();
  }
}
