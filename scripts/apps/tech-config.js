import { MODULE_ID, TEMPLATE_PATH, THEMES } from "../constants.js";
import { Compat } from "../compat.js";
import { CPR } from "../cpr-adapter.js";
import { formatEb } from "../shop-data.js";
import { TechApp } from "./tech-app.js";
import { getTech, saveTech, TECH_SKILLS, MAKER, TECH_SERVICES, CATEGORIES, VEHICLE_DAMAGE } from "../tech/tech-data.js";
import { marketPrice, categoryOf } from "../tech/tech-rules.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { deepClone, getProperty, setProperty, debounce, randomID } = foundry.utils;
const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));

/** Skill items the Tech's check bases are read from (all TECH skills), and the Maker abilities. */
const SKILL_NAMES = {
  basicTech: "Basic Tech",
  cybertech: "Cybertech",
  electronics: "Electronics/Security Tech",
  weaponstech: "Weaponstech",
  landVehicle: "Land Vehicle Tech",
  seaVehicle: "Sea Vehicle Tech",
  airVehicle: "Air Vehicle Tech"
};
const MAKER_NAMES = { field: "Field Expertise", upgrade: "Upgrade Expertise", fabrication: "Fabrication Expertise", invention: "Invention Expertise" };

const tierKey = (c) => c.charAt(0).toUpperCase() + c.slice(1);

/**
 * GM-only editor for one tech shop. Works on a draft copy; nothing is written until "Save".
 * Edits stream into an open preview as you type.
 */
export class TechConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Map();

  constructor(actor, options = {}) {
    super({ id: `${MODULE_ID}-tech-config-${actor.uuid.replaceAll(".", "-")}`, ...options });
    this.actor = actor;
    this.draft = getTech(actor);
    this.activeTab = "identity";
    this.dirty = false;
    this.#pushPreview = debounce(() => this.#sendPreview(), 120);
  }

  #pushPreview;

  static DEFAULT_OPTIONS = {
    classes: ["neon-market", "nm-config", "nm-tech-config"],
    tag: "div",
    window: {
      title: "NEONMARKET.Tech.Config.Title",
      icon: "fa-solid fa-screwdriver-wrench",
      resizable: true
    },
    position: { width: 780, height: 720 },
    actions: {
      switchTab: TechConfigApp.#onSwitchTab,
      pickFile: TechConfigApp.#onPickFile,
      readTech: TechConfigApp.#onReadTech,
      removeBlueprint: TechConfigApp.#onRemoveBlueprint,
      preview: TechConfigApp.#onPreview,
      openTech: TechConfigApp.#onOpenTech,
      save: TechConfigApp.#onSave
    }
  };

  static PARTS = {
    body: {
      template: `${TEMPLATE_PATH}/tech-config.hbs`,
      scrollable: [".nm-config-pane"]
    }
  };

  static open(actor) {
    if (!game.user.isGM) return ui.notifications.warn(L("NEONMARKET.Error.GMOnly"));
    let app = this.instances.get(actor.uuid);
    if (!app) {
      app = new this(actor);
      this.instances.set(actor.uuid, app);
    }
    app.render({ force: true });
    return app;
  }

  get title() {
    return `${L("NEONMARKET.Tech.Config.Title")}: ${this.actor.name}`;
  }

  async _prepareContext() {
    const d = this.draft;
    const tabs = ["identity", "tech", "fees", "blueprints", "options"].map((key) => ({
      key, label: L(`NEONMARKET.Tech.Config.Tab.${key}`), active: key === this.activeTab
    }));
    return {
      d,
      tabs,
      tab: Object.fromEntries(tabs.map((t) => [t.key, t.active])),
      dirty: this.dirty,
      themes: Object.entries(THEMES).map(([key, t]) => ({ key, label: L(t.label), selected: key === d.theme })),
      skills: TECH_SKILLS.map((key) => ({ key, label: L(`NEONMARKET.Tech.Skill.${key}`), value: d.skills[key] })),
      maker: MAKER.map((key) => ({ key, label: L(`NEONMARKET.Tech.Maker.${key}`), value: d.maker[key] })),
      services: TECH_SERVICES.map((key) => ({ key, label: L(`NEONMARKET.Tech.Service.${key}`), checked: d.services[key] })),
      labor: CATEGORIES.map((key) => ({ key, label: L(`NEONMARKET.Tier.${tierKey(key)}`), value: d.fees.labor[key] })),
      vehicle: VEHICLE_DAMAGE.map((key) => ({ key, label: L(`NEONMARKET.Tech.Damage.${key}`), value: d.fees.vehicle[key] })),
      blueprints: d.blueprints.map((b, index) => {
        const price = marketPrice(b.itemData);
        return {
          index,
          id: b.id,
          name: b.itemData.name,
          img: b.itemData.img,
          type: CPR.typeLabel(b.itemData.type),
          price: formatEb(price),
          inventedFor: b.inventedFor ?? null,
          categories: [
            { key: "", label: L("NEONMARKET.Tech.Config.CategoryAuto", { cat: L(`NEONMARKET.Tier.${tierKey(categoryOf(price))}`) }), selected: !b.category },
            ...CATEGORIES.map((c) => ({ key: c, label: L(`NEONMARKET.Tier.${tierKey(c)}`), selected: c === b.category }))
          ]
        };
      })
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    for (const input of root.querySelectorAll("[data-path]")) {
      const evt = input.matches("input[type=text], textarea, input[type=color]") ? "input" : "change";
      input.addEventListener(evt, (ev) => this.#onField(ev));
    }
    const zone = root.querySelector("[data-drop-blueprint]");
    if (zone) {
      zone.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        zone.classList.add("drag-over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
      zone.addEventListener("drop", (ev) => {
        zone.classList.remove("drag-over");
        this.#onDrop(ev);
      });
    }
  }

  #onField(ev) {
    const input = ev.currentTarget;
    const path = input.dataset.path;
    const raw = input.type === "checkbox" ? input.checked : input.value;
    const value = input.dataset.dtype === "Boolean" ? !!raw
      : input.dataset.dtype === "Number" ? Math.max(0, Math.round(Number(raw) || 0))
        : String(raw);
    setProperty(this.draft, path, value);
    this.dirty = true;
    this.element.querySelector(".nm-config-dirty")?.classList.add("visible");
    if (path === "theme" && THEMES[value]) {
      this.draft.identity.accent = THEMES[value].accent;
      this.draft.identity.accent2 = THEMES[value].accent2;
      this.render();
    }
    this.#pushPreview();
  }

  #touch() {
    this.dirty = true;
    this.render();
    this.#pushPreview();
  }

  #sendPreview() {
    const app = TechApp.instances.get(this.actor.uuid);
    if (app?.preview) app.setDraft(deepClone(this.draft));
  }

  /** Items or item folders dropped on the blueprint list become blueprints. */
  async #onDrop(event) {
    event.preventDefault();
    const data = Compat.getDragEventData(event);
    if (!data?.uuid) return;
    const items = [];
    if (data.type === "Item") {
      const item = await fromUuid(data.uuid);
      if (item) items.push(item);
    } else if (data.type === "Folder") {
      const folder = await fromUuid(data.uuid);
      if (folder?.type === "Item") {
        for (const doc of folder.contents ?? []) {
          const item = doc.uuid && !(doc instanceof Item) ? await fromUuid(doc.uuid) : doc;
          if (item) items.push(item);
        }
      }
    }
    let added = 0;
    for (const item of items) {
      if (!CPR.isListable(item)) continue;
      this.draft.blueprints.push({ id: randomID(12), sourceUuid: item.uuid ?? "", itemData: CPR.snapshot(item), category: "" });
      added++;
    }
    if (items.length > added) ui.notifications.info(L("NEONMARKET.Config.Skipped", { n: items.length - added }));
    if (added) this.#touch();
  }

  static #onSwitchTab(event, target) {
    this.activeTab = target.dataset.tab;
    this.render();
  }

  static #onPickFile(event, target) {
    const path = target.dataset.target;
    const FP = Compat.FilePicker;
    new FP({
      type: target.dataset.type ?? "image",
      current: getProperty(this.draft, path) || "",
      callback: (file) => {
        setProperty(this.draft, path, file);
        this.#touch();
      }
    }).render(true);
  }

  /** Fill the Tech's check bases from this actor: TECH + skill, and the Tech role's Maker ranks. */
  static #onReadTech() {
    const actor = this.actor;
    const tech = Math.trunc(Number(getProperty(actor, "system.stats.tech.value")) || 0);
    let found = 0;
    for (const [key, name] of Object.entries(SKILL_NAMES)) {
      const skill = actor.items.find((i) => i.type === "skill" && i.name === name);
      if (!skill) continue;
      const level = Math.trunc(Number(skill.system?.level) || 0);
      this.draft.skills[key] = level > 0 ? tech + level : 0;
      found++;
    }
    const role = actor.items.find((i) => i.type === "role" && (i.system?.abilities ?? []).some((a) => a.name === "Field Expertise"));
    if (role) {
      for (const [key, name] of Object.entries(MAKER_NAMES)) {
        const ability = role.system.abilities.find((a) => a.name === name);
        if (ability) {
          this.draft.maker[key] = Math.trunc(Number(ability.rank) || 0);
          found++;
        }
      }
    }
    if (!found) return ui.notifications.warn(L("NEONMARKET.Clinic.Config.NoSkillsFound", { name: actor.name }));
    ui.notifications.info(L("NEONMARKET.Clinic.Config.SkillsRead", { n: found, name: actor.name }));
    this.#touch();
  }

  static async #onRemoveBlueprint(event, target) {
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index)) return;
    this.draft.blueprints.splice(index, 1);
    this.#touch();
  }

  static #onPreview() {
    TechApp.open(this.actor, { preview: true, draft: deepClone(this.draft) });
    setTimeout(() => this.bringToFront?.(), 50);
  }

  static async #onOpenTech() {
    if (this.dirty) await TechConfigApp.#onSave.call(this);
    TechApp.open(this.actor, { preview: false });
  }

  static async #onSave() {
    await saveTech(this.actor, this.draft);
    this.dirty = false;
    ui.notifications.info(L("NEONMARKET.Config.Saved", { name: this.draft.identity.name }));
    this.render();
  }

  async close(options = {}) {
    if (this.dirty && !options.force) {
      const ok = await Compat.DialogV2.confirm({
        classes: ["neon-market-dialog"],
        window: { title: L("NEONMARKET.Config.Unsaved") },
        content: `<p>${L("NEONMARKET.Config.UnsavedConfirm")}</p>`,
        rejectClose: false
      });
      if (!ok) return this;
    }
    return super.close(options);
  }

  _onClose(options) {
    super._onClose?.(options);
    TechConfigApp.instances.delete(this.actor.uuid);
    const app = TechApp.instances.get(this.actor.uuid);
    if (app?.preview) app.close();
  }
}
