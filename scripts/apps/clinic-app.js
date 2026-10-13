import { MODULE_ID, TEMPLATE_PATH } from "../constants.js";
import { CPR } from "../cpr-adapter.js";
import { ShopSocket } from "../socket.js";
import { formatEb, isShop } from "../shop-data.js";
import { ShopApp } from "./shop-app.js";
import { getClinic, normalizeClinic, THERAPIES } from "../clinic/clinic-data.js";
import { ClinicOps } from "../clinic/clinic-ops.js";
import {
  hp, humanity, body, woundState, injuries, feeForDv, stabilizePlan, quickFixPlan, treatmentPlan, cryoPlan,
  therapyPlan, installPlan, installTargets, installLocation, installable, THERAPY, THERAPY_NIGHTS, STABILIZE_DV
} from "../clinic/clinic-rules.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TABS = {
  care: { icon: "fa-solid fa-kit-medical", services: ["stabilize", "quickFix", "treatment"] },
  recovery: { icon: "fa-solid fa-bed-pulse", services: ["rest", "cryo"] },
  therapy: { icon: "fa-solid fa-brain", services: ["therapy"] },
  cyberware: { icon: "fa-solid fa-microchip", services: ["install"] }
};

/**
 * Full-screen ripperdoc clinic or hospital. The patient picks a procedure; the request goes
 * to the active GM, whose client rolls for the doctor and applies the result (clinic-ops.js).
 * In preview mode it renders an unsaved draft from the editor and books nothing.
 */
export class ClinicApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, ClinicApp>} */
  static instances = new Map();

  constructor(clinicActor, { preview = false, draft = null, ...options } = {}) {
    super({ id: `${MODULE_ID}-clinic-${clinicActor.uuid.replaceAll(".", "-")}`, ...options });
    this.clinicActor = clinicActor;
    this.preview = preview;
    this.draft = draft;
    this.clinicState = {
      tab: "care",
      focus: null,
      days: 1,
      cyber: false,
      stay: false,
      targetId: null,
      speech: null,
      patientUuid: CPR.defaultBuyer()?.uuid ?? null,
      busy: false
    };
    this._lastSpeech = null;
    this._opened = false;
  }

  static DEFAULT_OPTIONS = {
    classes: ["neon-market", "nm-app", "nm-clinic-app"],
    tag: "div",
    window: { frame: false, positioned: false },
    actions: {
      close: ClinicApp.#onClose,
      setMode: ClinicApp.#onSetTab,
      focus: ClinicApp.#onFocus,
      qtyUp: ClinicApp.#onDaysUp,
      qtyDown: ClinicApp.#onDaysDown,
      book: ClinicApp.#onBook,
      openStore: ClinicApp.#onOpenStore,
      configure: ClinicApp.#onConfigure
    }
  };

  static PARTS = {
    clinic: {
      template: `${TEMPLATE_PATH}/clinic.hbs`,
      scrollable: [".nm-list", ".nm-detail-body"]
    }
  };

  /* ---------------------------------------- */
  /*  Opening                                 */
  /* ---------------------------------------- */

  static open(actor, options = {}) {
    if (!actor) return null;
    for (const app of ShopApp.instances.values()) app.close();
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

  /** Re-render any open clinic affected by a change to this actor (clinic or patient). */
  static refreshFor(actor) {
    for (const app of this.instances.values()) {
      if (app.clinicActor.uuid === actor.uuid || app.clinicState.patientUuid === actor.uuid) app.render();
    }
  }

  get clinic() {
    return this.draft ? normalizeClinic(this.draft, this.clinicActor) : getClinic(this.clinicActor);
  }

  get patient() {
    return this.clinicState.patientUuid ? fromUuidSync(this.clinicState.patientUuid) : null;
  }

  setDraft(draft) {
    this.draft = draft;
    if (this.rendered) this.render();
  }

  /* ---------------------------------------- */
  /*  Context                                 */
  /* ---------------------------------------- */

  async _prepareContext() {
    const clinic = this.clinic;
    const patient = this.patient;
    const s = this.clinicState;
    const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));

    const tabs = Object.entries(TABS)
      .filter(([, t]) => t.services.some((k) => clinic.services[k]))
      .map(([key, t]) => ({ key, icon: t.icon, label: L(`NEONMARKET.Clinic.Tab.${key}`), active: s.tab === key }));
    if (!tabs.some((t) => t.key === s.tab)) s.tab = tabs[0]?.key ?? "care";
    for (const t of tabs) t.active = t.key === s.tab;

    const wealth = patient && CPR.hasWealth(patient) ? CPR.getWealth(patient) : 0;
    const rows = patient ? this.#rows(clinic, patient, wealth) : [];
    const focus = rows.find((r) => r.key === s.focus) ?? null;
    if (!focus) s.focus = null;

    const id = clinic.identity;
    const bg = id.background ? `--nm-bg-image:url("${id.background}");` : "";
    const h = patient ? hp(patient) : null;
    const hum = patient ? humanity(patient) : null;
    const state = patient ? woundState(patient) : null;

    return {
      clinic,
      identity: { name: id.name, subtitle: id.subtitle, owner: id.doctor, slogan: L(`NEONMARKET.Clinic.Facility.${clinic.facility}`), art: id.art },
      style: `--nm-accent:${id.accent};--nm-accent-2:${id.accent2};${bg}`,
      rootClass: `theme-${clinic.theme} layout-character nm-clinic${this.preview ? " is-preview" : ""}${s.busy ? " is-busy" : ""}`,
      isGM: game.user.isGM,
      preview: this.preview,
      closedBanner: !clinic.enabled && game.user.isGM && !this.preview,
      hasStore: isShop(this.clinicActor),
      modes: tabs,
      rows,
      emptyText: this.#emptyText(clinic, patient, s.tab),
      focus: focus && this.#detail(clinic, patient, focus, wealth),
      speech: s.speech ?? id.greeting,
      patient: patient && {
        name: patient.name,
        img: patient.img,
        hp: `${h.value}/${h.max}`,
        hpLow: h.value < Math.ceil(h.max / 2),
        state: this.#stateLabel(state),
        humanity: `${hum.value}/${hum.max}`,
        wealth: CPR.hasWealth(patient) ? formatEb(wealth) : null
      },
      patients: CPR.buyerCandidates().map((a) => ({ uuid: a.uuid, name: a.name, selected: a.uuid === s.patientUuid }))
    };
  }

  #stateLabel(state) {
    const key = `CPR.global.woundState.${state}`;
    return game.i18n.has(key) ? game.i18n.localize(key) : game.i18n.localize(`NEONMARKET.Clinic.Wound.${state}`);
  }

  /** One row per procedure on the active tab, priced, with the doctor's odds. */
  #rows(clinic, patient, wealth) {
    const s = this.clinicState;
    const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));
    const out = [];
    const push = (row) => {
      const fee = Math.max(0, Math.round(row.fee ?? 0));
      out.push({
        ...row,
        fee,
        price: fee > 0 ? formatEb(fee) : L("NEONMARKET.Clinic.Free"),
        affordable: fee <= wealth,
        chance: row.plan ? `${Math.round(row.plan.chance * 100)}%` : null,
        meta: row.plan ? L("NEONMARKET.Clinic.CheckMeta", { skill: L(`NEONMARKET.Clinic.Skill.${row.plan.skill}`), dv: row.plan.dv }) : row.meta ?? "",
        focused: s.focus === row.key
      });
    };
    const opt = { cyber: s.cyber };

    if (s.tab === "care") {
      if (clinic.services.stabilize) {
        const state = woundState(patient);
        const plan = stabilizePlan(clinic, patient);
        push({
          key: "stabilize", kind: "stabilize", icon: "fa-solid fa-heart-pulse",
          name: L("NEONMARKET.Clinic.Service.stabilize"),
          sub: this.#stateLabel(state),
          plan, fee: plan ? feeForDv(clinic, plan.dv) : 0,
          blocked: !STABILIZE_DV[state] ? L("NEONMARKET.Clinic.Error.NotWounded", { name: patient.name }) : !plan ? L("NEONMARKET.Clinic.Error.NoSkill") : null
        });
      }
      for (const injury of injuries(patient)) {
        const fixed = ClinicOps.isQuickFixed(injury);
        if (clinic.services.quickFix) {
          const plan = quickFixPlan(clinic, injury, opt);
          push({
            key: `quickFix:${injury.id}`, kind: "quickFix", injuryId: injury.id, img: injury.img,
            name: `${L("NEONMARKET.Clinic.Service.quickFix")}: ${injury.name}`,
            sub: fixed ? L("NEONMARKET.Clinic.QuickFixedToday") : L(`NEONMARKET.Clinic.Location.${injury.system?.location ?? "body"}`),
            plan, fee: plan ? feeForDv(clinic, plan.dv) : 0,
            blocked: fixed ? L("NEONMARKET.Clinic.QuickFixedToday") : !plan ? L("NEONMARKET.Clinic.Error.NoQuickFix", { injury: injury.name }) : null
          });
        }
        if (clinic.services.treatment && injury.system?.treatment?.type !== "quickFix") {
          const plan = treatmentPlan(clinic, injury, opt);
          push({
            key: `treatment:${injury.id}`, kind: "treatment", injuryId: injury.id, img: injury.img,
            name: `${L("NEONMARKET.Clinic.Service.treatment")}: ${injury.name}`,
            sub: L(`NEONMARKET.Clinic.Location.${injury.system?.location ?? "body"}`),
            plan, fee: plan ? feeForDv(clinic, plan.dv) : 0,
            blocked: !plan ? L("NEONMARKET.Clinic.Error.NoTreatment", { injury: injury.name }) : null
          });
        }
      }
    } else if (s.tab === "recovery") {
      const h = hp(patient);
      const blocked = h.value < 1 ? L("NEONMARKET.Clinic.Error.StabilizeFirst", { name: patient.name })
        : h.value >= h.max ? L("NEONMARKET.Clinic.Error.NotWounded", { name: patient.name }) : null;
      if (clinic.services.rest) {
        push({
          key: "rest", kind: "rest", icon: "fa-solid fa-bed",
          name: L("NEONMARKET.Clinic.Service.rest"),
          perDay: L("NEONMARKET.Clinic.PricePerDay", { price: formatEb(clinic.fees.bed) }),
          sub: L("NEONMARKET.Clinic.PerDay", { n: body(patient) }),
          meta: L("NEONMARKET.Clinic.NoRoll"),
          fee: clinic.fees.bed * s.days, blocked
        });
      }
      if (clinic.services.cryo) {
        const plan = cryoPlan(clinic);
        push({
          key: "cryo", kind: "cryo", icon: "fa-solid fa-snowflake",
          name: L("NEONMARKET.Clinic.Service.cryo"),
          perDay: L("NEONMARKET.Clinic.PricePerDay", { price: formatEb(clinic.fees.cryo) }),
          sub: L("NEONMARKET.Clinic.PerDay", { n: body(patient) * 2 }),
          plan, fee: clinic.fees.cryo * s.days,
          blocked: blocked ?? (!plan ? L("NEONMARKET.Clinic.Error.NoSkill") : null)
        });
      }
    } else if (s.tab === "therapy" && clinic.services.therapy) {
      const hum = humanity(patient);
      for (const kind of THERAPIES) {
        const plan = therapyPlan(clinic, kind);
        const full = kind !== "addiction" && hum.value >= hum.max;
        push({
          key: `therapy:${kind}`, kind: "therapy", therapy: kind, icon: kind === "addiction" ? "fa-solid fa-pills" : "fa-solid fa-brain",
          name: L(`NEONMARKET.Clinic.Therapy.${kind}`),
          sub: THERAPY[kind].regain ? L("NEONMARKET.Clinic.Regain", { formula: THERAPY[kind].regain }) : L("NEONMARKET.Clinic.AddictionSub"),
          plan, fee: clinic.fees.therapy[kind] + (s.stay ? clinic.fees.bed * THERAPY_NIGHTS : 0),
          blocked: full ? L("NEONMARKET.Clinic.Error.FullHumanity", { name: patient.name }) : !plan ? L("NEONMARKET.Clinic.Error.NoSkill") : null
        });
      }
    } else if (s.tab === "cyberware" && clinic.services.install) {
      for (const item of installable(patient)) {
        const loc = installLocation(item);
        const plan = installPlan(clinic, item);
        const targets = installTargets(patient, item);
        push({
          key: `install:${item.id}`, kind: "install", itemId: item.id, img: item.img,
          name: item.name,
          sub: `${L(`NEONMARKET.Clinic.Facility.${loc}`)} · ${L("NEONMARKET.Clinic.HumanityLoss", { loss: item.system?.humanityLoss?.roll ?? "0" })}`,
          plan, fee: clinic.fees.install[loc], targets,
          blocked: !plan ? L("NEONMARKET.Clinic.Error.WrongFacility", { item: item.name, need: L(`NEONMARKET.Clinic.Facility.${loc}`) })
            : !targets.length ? L("NEONMARKET.Clinic.Error.NoFoundation", { item: item.name }) : null
        });
      }
    }
    return out;
  }

  #detail(clinic, patient, row, wealth) {
    const s = this.clinicState;
    const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));
    const detail = {
      ...row,
      rule: L(`NEONMARKET.Clinic.Rule.${row.therapy ?? row.kind}`),
      showDays: row.kind === "rest" || row.kind === "cryo",
      days: s.days,
      showCyber: row.kind === "quickFix" || row.kind === "treatment",
      cyber: s.cyber,
      showStay: row.kind === "therapy",
      stay: s.stay,
      stayPrice: formatEb(clinic.fees.bed * THERAPY_NIGHTS),
      check: row.plan ? L("NEONMARKET.Clinic.CheckLine", {
        skill: L(`NEONMARKET.Clinic.Skill.${row.plan.skill}`), base: row.plan.base, dv: row.plan.dv, chance: row.chance
      }) : null,
      failNote: row.plan && clinic.options.chargeOnFailure && row.fee > 0 ? L("NEONMARKET.Clinic.ChargedOnFailure") : null,
      canBook: !row.blocked && (row.fee <= wealth) && !s.busy && !!patient
    };
    if (row.kind === "install") {
      const targets = row.targets ?? [];
      if (!targets.some((t) => t.id === s.targetId)) s.targetId = targets[0]?.id ?? null;
      detail.targets = targets.length > 1 ? targets.map((t) => ({ ...t, selected: t.id === s.targetId })) : null;
      detail.target = targets.length === 1 ? targets[0].name : null;
      if (clinic.options.destroyOnFailedInstall) detail.failNote = [detail.failNote, L("NEONMARKET.Clinic.DestroyNote")].filter(Boolean).join(" ");
    }
    if (row.fee > wealth && !row.blocked) detail.blocked = L("NEONMARKET.Clinic.CantAfford", { price: row.price });
    return detail;
  }

  #emptyText(clinic, patient, tab) {
    if (!patient) return game.i18n.localize("NEONMARKET.Clinic.PickPatient");
    return game.i18n.localize(`NEONMARKET.Clinic.Empty.${tab}`);
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
      root.querySelector(".nm-shell")?.classList.add(`flash-${this._pendingFlash}`);
      this._pendingFlash = null;
    }
    root.querySelector("select[name=patient]")?.addEventListener("change", (ev) => {
      this.clinicState.patientUuid = ev.currentTarget.value || null;
      this.clinicState.focus = null;
      this.render();
    });
    root.querySelector("select[name=target]")?.addEventListener("change", (ev) => {
      this.clinicState.targetId = ev.currentTarget.value || null;
    });
    for (const [name, key] of [["cyber", "cyber"], ["stay", "stay"]]) {
      root.querySelector(`input[name=${name}]`)?.addEventListener("change", (ev) => {
        this.clinicState[key] = ev.currentTarget.checked;
        this.render();
      });
    }
    this.#typeSpeech(context.speech);
    if (!this._opened) {
      this._opened = true;
      root.focus({ preventScroll: true });
    }
  }

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
      el.textContent = text ?? "";
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

  async _preClose(options) {
    await super._preClose?.(options);
    clearInterval(this._typer);
  }

  _onClose(options) {
    super._onClose?.(options);
    if (ClinicApp.instances.get(this.clinicActor.uuid) === this) ClinicApp.instances.delete(this.clinicActor.uuid);
  }

  /* ---------------------------------------- */
  /*  Actions                                 */
  /* ---------------------------------------- */

  static #onClose() {
    this.close();
  }

  static #onSetTab(event, target) {
    const tab = target.dataset.mode;
    if (tab === this.clinicState.tab) return;
    this.clinicState.tab = tab;
    this.clinicState.focus = null;
    this.render();
  }

  static #onFocus(event, target) {
    const key = target.dataset.key;
    if (key === this.clinicState.focus) return;
    this.clinicState.focus = key;
    this.clinicState.days = 1;
    this.render();
  }

  static #onDaysUp(event) {
    this.clinicState.days = Math.min(30, this.clinicState.days + (event.shiftKey ? 7 : 1));
    this.render();
  }

  static #onDaysDown(event) {
    this.clinicState.days = Math.max(1, this.clinicState.days - (event.shiftKey ? 7 : 1));
    this.render();
  }

  static #onOpenStore() {
    const actor = this.clinicActor;
    this.close();
    ShopApp.open(actor);
  }

  static #onConfigure() {
    if (!game.user.isGM) return;
    game.modules.get(MODULE_ID).api.configureClinic(this.clinicActor);
  }

  static async #onBook() {
    const s = this.clinicState;
    if (s.busy || !s.focus) return;
    if (this.preview) return ui.notifications.info(game.i18n.localize("NEONMARKET.Clinic.PreviewNoBooking"));
    const patient = this.patient;
    if (!patient) return ui.notifications.warn(game.i18n.localize("NEONMARKET.Clinic.PickPatient"));
    const clinic = this.clinic;
    const row = this.#rows(clinic, patient, CPR.hasWealth(patient) ? CPR.getWealth(patient) : 0).find((r) => r.key === s.focus);
    if (!row || row.blocked) return;

    const ok = await foundry.applications.api.DialogV2.confirm({
      classes: ["neon-market-dialog"],
      window: { title: clinic.identity.name },
      content: `<p>${game.i18n.format("NEONMARKET.Clinic.Confirm", {
        actor: Handlebars.escapeExpression(patient.name), procedure: Handlebars.escapeExpression(row.name), price: row.price
      })}</p>${row.plan ? `<p>${game.i18n.format("NEONMARKET.Clinic.ConfirmOdds", { chance: row.chance })}</p>` : ""}`,
      rejectClose: false
    });
    if (!ok) return;

    s.busy = true;
    this.render();
    try {
      const result = await ShopSocket.request("clinic", {
        kind: row.kind,
        patientUuid: patient.uuid,
        clinicUuid: this.clinicActor.uuid,
        params: { injuryId: row.injuryId, itemId: row.itemId, targetId: s.targetId, therapy: row.therapy, days: s.days, cyber: s.cyber, stay: s.stay }
      }, { timeout: 180_000 });
      s.speech = game.i18n.localize(result.success ? "NEONMARKET.Clinic.Speech.Success" : "NEONMARKET.Clinic.Speech.Failure");
      s.focus = null;
      this._pendingFlash = result.success ? "success" : "error";
    } catch (err) {
      ui.notifications.warn(err.message);
      if (err.code === "noFunds") s.speech = game.i18n.localize("NEONMARKET.Clinic.Speech.NoFunds");
      this._pendingFlash = "error";
    } finally {
      s.busy = false;
      if (this.rendered) this.render();
    }
  }
}
