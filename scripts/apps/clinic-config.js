import { MODULE_ID, TEMPLATE_PATH, THEMES } from "../constants.js";
import { Compat } from "../compat.js";
import { ClinicApp } from "./clinic-app.js";
import {
  getClinic, saveClinic, FACILITIES, DOCTOR_SKILLS, SERVICES, THERAPIES
} from "../clinic/clinic-data.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { deepClone, getProperty, setProperty, debounce } = foundry.utils;

/** Skill items (and Medtech role abilities) the doctor's check bases are read from, all TECH-based. */
const SKILL_SOURCES = {
  firstAid: { skill: "First Aid" },
  paramedic: { skill: "Paramedic" },
  cybertech: { skill: "Cybertech" },
  surgery: { ability: "Surgery Skill" },
  medicalTech: { ability: "Medical Tech Skill" }
};

/**
 * GM-only editor for one clinic. Works on a draft copy; nothing is written until "Save".
 * Edits stream into an open preview clinic as you type.
 */
export class ClinicConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Map();

  constructor(actor, options = {}) {
    super({ id: `${MODULE_ID}-clinic-config-${actor.uuid.replaceAll(".", "-")}`, ...options });
    this.actor = actor;
    this.draft = getClinic(actor);
    this.activeTab = "identity";
    this.dirty = false;
    this.#pushPreview = debounce(() => this.#sendPreview(), 120);
  }

  #pushPreview;

  static DEFAULT_OPTIONS = {
    classes: ["neon-market", "nm-config", "nm-clinic-config"],
    tag: "div",
    window: {
      title: "NEONMARKET.Clinic.Config.Title",
      icon: "fa-solid fa-user-doctor",
      resizable: true
    },
    position: { width: 760, height: 720 },
    actions: {
      switchTab: ClinicConfigApp.#onSwitchTab,
      pickFile: ClinicConfigApp.#onPickFile,
      readDoctor: ClinicConfigApp.#onReadDoctor,
      resetFees: ClinicConfigApp.#onResetFees,
      preview: ClinicConfigApp.#onPreview,
      openClinic: ClinicConfigApp.#onOpenClinic,
      save: ClinicConfigApp.#onSave
    }
  };

  static PARTS = {
    body: {
      template: `${TEMPLATE_PATH}/clinic-config.hbs`,
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
    return `${game.i18n.localize("NEONMARKET.Clinic.Config.Title")}: ${this.actor.name}`;
  }

  /* ---------------------------------------- */
  /*  Context                                 */
  /* ---------------------------------------- */

  async _prepareContext() {
    const d = this.draft;
    const L = (k) => game.i18n.localize(k);
    const tabs = ["identity", "doctor", "fees", "options"].map((key) => ({
      key, label: L(`NEONMARKET.Clinic.Config.Tab.${key}`), active: key === this.activeTab
    }));
    return {
      d,
      tabs,
      tab: Object.fromEntries(tabs.map((t) => [t.key, t.active])),
      dirty: this.dirty,
      themes: Object.entries(THEMES).map(([key, t]) => ({ key, label: L(t.label), selected: key === d.theme })),
      facilities: FACILITIES.map((key) => ({ key, label: L(`NEONMARKET.Clinic.Facility.${key}`), selected: key === d.facility })),
      skills: DOCTOR_SKILLS.map((key) => ({ key, label: L(`NEONMARKET.Clinic.Skill.${key}`), value: d.doctor[key] })),
      services: SERVICES.map((key) => ({ key, label: L(`NEONMARKET.Clinic.Service.${key}`), checked: d.services[key] })),
      dvFees: Object.keys(d.fees.byDv).map((dv) => ({ dv, value: d.fees.byDv[dv] })),
      therapyFees: THERAPIES.map((key) => ({ key, label: L(`NEONMARKET.Clinic.Therapy.${key}`), value: d.fees.therapy[key] })),
      installFees: FACILITIES.map((key) => ({ key, label: L(`NEONMARKET.Clinic.Facility.${key}`), value: d.fees.install[key] })),
      humanityModes: ["roll", "static"].map((key) => ({ key, label: L(`NEONMARKET.Clinic.Config.Humanity.${key}`), selected: d.options.humanityLoss === key }))
    };
  }

  /* ---------------------------------------- */
  /*  Rendering and input binding             */
  /* ---------------------------------------- */

  _onRender(context, options) {
    super._onRender?.(context, options);
    for (const input of this.element.querySelectorAll("[data-path]")) {
      const evt = input.matches("input[type=text], textarea, input[type=color]") ? "input" : "change";
      input.addEventListener(evt, (ev) => this.#onField(ev));
    }
  }

  #coerce(input) {
    const raw = input.type === "checkbox" ? input.checked : input.value;
    switch (input.dataset.dtype) {
      case "Boolean": return !!raw;
      case "Number": return raw === "" ? 0 : Math.max(0, Math.round(Number(raw) || 0));
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
    const app = ClinicApp.instances.get(this.actor.uuid);
    if (app?.preview) app.setDraft(deepClone(this.draft));
  }

  /* ---------------------------------------- */
  /*  Actions                                 */
  /* ---------------------------------------- */

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

  /** Fill the doctor's check bases from this actor: TECH + skill, or TECH + Medtech ability rank. */
  static #onReadDoctor() {
    const actor = this.actor;
    const tech = Math.trunc(Number(getProperty(actor, "system.stats.tech.value")) || 0);
    const role = actor.itemTypes?.role?.find((r) => (r.system?.abilities ?? []).some((a) => a.name === "Surgery Skill"));
    let found = 0;
    for (const [key, src] of Object.entries(SKILL_SOURCES)) {
      let level = null;
      if (src.skill) {
        const skill = actor.items.find((i) => i.type === "skill" && i.name === src.skill);
        if (skill) level = Math.trunc(Number(skill.system?.level) || 0);
      } else if (role) {
        const ability = role.system.abilities.find((a) => a.name === src.ability);
        if (ability) level = Math.trunc(Number(ability.rank) || 0);
      }
      if (level === null) continue;
      this.draft.doctor[key] = level > 0 ? tech + level : 0;
      found++;
    }
    if (!found) return ui.notifications.warn(game.i18n.format("NEONMARKET.Clinic.Config.NoSkillsFound", { name: actor.name }));
    ui.notifications.info(game.i18n.format("NEONMARKET.Clinic.Config.SkillsRead", { n: found, name: actor.name }));
    this.#touch();
  }

  static #onResetFees() {
    const fresh = getClinic(null);
    this.draft.fees = deepClone(fresh.fees);
    this.#touch();
  }

  static #onPreview() {
    ClinicApp.open(this.actor, { preview: true, draft: deepClone(this.draft) });
    setTimeout(() => this.bringToFront?.(), 50);
  }

  static async #onOpenClinic() {
    if (this.dirty) await ClinicConfigApp.#onSave.call(this);
    ClinicApp.open(this.actor, { preview: false });
  }

  static async #onSave() {
    await saveClinic(this.actor, this.draft);
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
    ClinicConfigApp.instances.delete(this.actor.uuid);
    const app = ClinicApp.instances.get(this.actor.uuid);
    if (app?.preview) app.close();
  }
}
