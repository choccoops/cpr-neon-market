import { MODULE_ID, TEMPLATE_PATH } from "../constants.js";
import { CPR } from "../cpr-adapter.js";
import { ShopSocket } from "../socket.js";
import { formatEb } from "../shop-data.js";
import { venueLinks, openVenue, closeOtherVenues } from "../venues.js";
import { getTech, normalizeTech, VEHICLE_DAMAGE } from "../tech/tech-data.js";
import { nahApi, vasActive, timeText } from "../tech/tech-ops.js";
import {
  UPGRADES, INVENTION_KINDS, isGear, isVasVehicle, vasDamage, repairNeeds, repairPlan, repairFee, vasRepairPlan,
  upgradesFor, upgradePlan, fabricatePlan, chanceText, marketPrice, categoryOf
} from "../tech/tech-rules.js";
import { TUP_ICON, tupFits, tupVisible, tupInstallPlan, kitTup } from "../tech/tups.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));

const TABS = {
  repair: "fa-solid fa-toolbox",
  upgrade: "fa-solid fa-arrow-up-right-dots",
  tups: "fa-solid fa-microchip",
  fabricate: "fa-solid fa-industry",
  invent: "fa-solid fa-lightbulb"
};

/**
 * Full-screen tech shop: repairs, upgrades, fabrication and invention by the shop's Tech (Maker,
 * CRB p.147). Bookings go to the active GM, whose client rolls and applies them (tech-ops.js).
 */
export class TechApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, TechApp>} */
  static instances = new Map();

  constructor(shopActor, { preview = false, draft = null, ...options } = {}) {
    super({ id: `${MODULE_ID}-tech-${shopActor.uuid.replaceAll(".", "-")}`, ...options });
    this.shopActor = shopActor;
    this.preview = preview;
    this.draft = draft;
    this.techState = {
      tab: "repair",
      focus: null,
      vehicleDamage: "major",
      upgrade: {},
      tupMode: {},
      tupTarget: {},
      note: "",
      invention: { name: "", kind: "gear", description: "" },
      speech: null,
      customerUuid: CPR.defaultBuyer()?.uuid ?? null,
      busy: false
    };
    this._lastSpeech = null;
    this._opened = false;
  }

  static DEFAULT_OPTIONS = {
    classes: ["neon-market", "nm-app", "nm-tech-app"],
    tag: "div",
    window: { frame: false, positioned: false },
    actions: {
      close: TechApp.#onClose,
      setMode: TechApp.#onSetTab,
      focus: TechApp.#onFocus,
      book: TechApp.#onBook,
      openVenue: TechApp.#onOpenVenue,
      configure: TechApp.#onConfigure
    }
  };

  static PARTS = {
    tech: {
      template: `${TEMPLATE_PATH}/tech.hbs`,
      scrollable: [".nm-list", ".nm-detail-body"]
    }
  };

  static open(actor, options = {}) {
    if (!actor) return null;
    closeOtherVenues(this.instances.get(actor.uuid));
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

  /** Re-render any open tech shop affected by a change to this actor (the shop, the customer or their vehicle). */
  static refreshFor(actor) {
    for (const app of this.instances.values()) {
      if (app.shopActor.uuid === actor.uuid || app.techState.customerUuid === actor.uuid || isVasVehicle(actor)) app.render();
    }
  }

  get tech() {
    return this.draft ? normalizeTech(this.draft, this.shopActor) : getTech(this.shopActor);
  }

  get customer() {
    return this.techState.customerUuid ? fromUuidSync(this.techState.customerUuid) : null;
  }

  setDraft(draft) {
    this.draft = draft;
    if (this.rendered) this.render();
  }

  /** VAS vehicles this customer's players own (the GM sees those of whoever plays the customer). */
  #vehicles(customer) {
    if (!vasActive() || !customer) return [];
    const players = game.users.filter((u) => !u.isGM && customer.testUserPermission(u, "OWNER"));
    return game.actors.filter((a) => isVasVehicle(a) && (game.user.isGM
      ? players.some((u) => a.testUserPermission(u, "OWNER"))
      : a.testUserPermission(game.user, "OWNER")));
  }

  /* ---------------------------------------- */
  /*  Context                                 */
  /* ---------------------------------------- */

  async _prepareContext() {
    const tech = this.tech;
    const customer = this.customer;
    const s = this.techState;

    const tabs = Object.entries(TABS)
      .filter(([key]) => tech.services[key])
      .map(([key, icon]) => ({ key, icon, label: L(`NEONMARKET.Tech.Tab.${key}`), active: s.tab === key }));
    if (!tabs.some((t) => t.key === s.tab)) s.tab = tabs[0]?.key ?? "repair";
    for (const t of tabs) t.active = t.key === s.tab;

    const wealth = customer && CPR.hasWealth(customer) ? CPR.getWealth(customer) : 0;
    const rows = customer ? this.#rows(tech, customer, wealth) : [];
    const row = rows.find((r) => r.key === s.focus) ?? null;
    if (!row) s.focus = null;

    const id = tech.identity;
    const bg = id.background ? `--nm-bg-image:url("${id.background}");` : "";
    return {
      tech,
      identity: { name: id.name, subtitle: id.subtitle, owner: id.tech, slogan: L("NEONMARKET.Tech.Slogan"), art: id.art },
      style: `--nm-accent:${id.accent};--nm-accent-2:${id.accent2};${bg}`,
      rootClass: `theme-${tech.theme} layout-character nm-clinic nm-tech${this.preview ? " is-preview" : ""}${s.busy ? " is-busy" : ""}`,
      isGM: game.user.isGM,
      preview: this.preview,
      closedBanner: !tech.enabled && game.user.isGM && !this.preview,
      venueLinks: this.preview ? [] : venueLinks(this.shopActor, "tech"),
      modes: tabs,
      rows,
      emptyText: customer ? L(`NEONMARKET.Tech.Empty.${s.tab}${s.tab === "repair" && !nahApi() ? "NoNah" : ""}`) : L("NEONMARKET.Tech.PickCustomer"),
      focus: row && this.#detail(tech, customer, row, wealth),
      speech: s.speech ?? id.greeting,
      customer: customer && { name: customer.name, img: customer.img, wealth: CPR.hasWealth(customer) ? formatEb(wealth) : null },
      customers: CPR.buyerCandidates().map((a) => ({ uuid: a.uuid, name: a.name, selected: a.uuid === s.customerUuid }))
    };
  }

  #row(base, plan, fee, materials, wealth) {
    const total = Math.max(0, Math.round(fee ?? 0)) + Math.max(0, Math.round(materials ?? 0));
    return {
      ...base,
      plan,
      fee: Math.round(fee ?? 0),
      materials: Math.round(materials ?? 0),
      total,
      price: total > 0 ? formatEb(total) : L("NEONMARKET.Clinic.Free"),
      affordable: total <= wealth,
      chance: plan ? chanceText(plan) : null,
      meta: plan ? L("NEONMARKET.Tech.CheckMeta", { skill: L(`NEONMARKET.Tech.Skill.${plan.skill}`), dv: plan.dv }) : base.meta ?? "",
      focused: this.techState.focus === base.key
    };
  }

  #needsText(needs) {
    const parts = [];
    if (needs.condition) parts.push(L(`NEONMARKET.Tech.Condition.${needs.condition}`));
    if (needs.malfunction) parts.push(L("NEONMARKET.Tech.Condition.malfunction"));
    if (needs.ablation) parts.push(L("NEONMARKET.Tech.Condition.ablation", { n: needs.ablation }));
    if (needs.shield) parts.push(L("NEONMARKET.Tech.Condition.shield", { n: needs.shield }));
    return parts.join(" · ");
  }

  #rows(tech, customer, wealth) {
    const s = this.techState;
    const out = [];
    const nah = !!nahApi();
    const owners = [customer, ...this.#vehicles(customer)];

    if (s.tab === "repair") {
      for (const owner of owners) {
        const vas = owner !== customer;
        if (vas) {
          const damage = vasDamage(owner);
          if (damage) {
            const plan = vasRepairPlan(tech, owner, damage.level);
            out.push(this.#row({
              key: `vehicle:${owner.uuid}`, kind: "vehicle", actorUuid: owner.uuid, img: owner.img, name: owner.name,
              sub: `${L(`NEONMARKET.Tech.Damage.${damage.level}`)} · ${L("NEONMARKET.Tech.Sdp", { value: damage.hp.value, max: damage.hp.max })}`,
              damage, timeText: timeText(plan), blocked: plan ? null : L("NEONMARKET.Tech.Error.NoSkill")
            }, plan, tech.fees.vehicle[damage.level], 0, wealth));
          }
        }
        for (const item of owner.items) {
          const needs = repairNeeds(item, { nah });
          if (!needs) continue;
          const vehicleDamage = needs.condition === "destroyed" ? "destroyed" : s.vehicleDamage;
          const plan = needs.beyondRepair ? null : repairPlan(tech, item, { vehicleDamage });
          out.push(this.#row({
            key: `repair:${owner.uuid}:${item.id}`, kind: "repair", actorUuid: owner.uuid, itemId: item.id, img: item.img,
            name: vas ? `${item.name} (${owner.name})` : item.name, sub: this.#needsText(needs),
            needs, isVehicleItem: item.type === "vehicle" && needs.condition !== "destroyed", timeText: timeText(plan),
            blocked: needs.beyondRepair ? L("NEONMARKET.Tech.Error.BeyondRepair", { item: item.name }) : plan ? null : L("NEONMARKET.Tech.Error.NoSkill")
          }, plan, plan ? repairFee(tech, plan) : 0, 0, wealth));
        }
      }
    } else if (s.tab === "upgrade") {
      for (const owner of owners) {
        const vas = owner !== customer;
        const docs = vas ? [owner, ...owner.items.filter((i) => isGear(i))] : customer.items.filter((i) => isGear(i));
        for (const doc of docs) {
          const isActor = doc === owner && vas;
          const options = upgradesFor(doc, { vas: isActor });
          if (!options.length) continue;
          const key = `upgrade:${owner.uuid}:${isActor ? "" : doc.id}`;
          const chosen = options.includes(s.upgrade[key]) ? s.upgrade[key] : options[0];
          const plan = upgradePlan(tech, doc, { vas: isActor });
          out.push(this.#row({
            key, kind: "upgrade", actorUuid: owner.uuid, itemId: isActor ? null : doc.id, img: doc.img,
            name: vas && !isActor ? `${doc.name} (${owner.name})` : doc.name,
            sub: L("NEONMARKET.Tech.UpgradeCount", { n: options.length }),
            options, chosen, timeText: timeText(plan), blocked: plan ? null : L("NEONMARKET.Tech.Error.NoSkill")
          }, plan, plan?.fee, plan?.materials, wealth));
        }
      }
    } else if (s.tab === "tups") {
      const gm = game.user.isGM;
      const offers = tech.tups.filter((t) => (t.install || t.kit) && tupVisible(t, customer, { gm })).map((tup) => ({ tup, key: `tup:${tup.id}` }));
      const kits = customer.items.filter((i) => kitTup(i)).map((kit) => ({ tup: kitTup(kit), kit, key: `kit:${kit.id}` }));
      for (const { tup, kit, key } of [...kits, ...offers]) {
        const modes = kit ? ["install"] : ["install", "kit"].filter((m) => tup[m]);
        const mode = modes.includes(s.tupMode[key]) ? s.tupMode[key] : modes[0];
        const heat = L(`NEONMARKET.Tup.Heat.${tup.heat}`);
        const base = {
          key, tup, kitItemId: kit?.id ?? null, tupId: kit ? null : tup.id, img: kit?.img ?? TUP_ICON,
          name: kit ? L("NEONMARKET.Tup.YourKit", { name: tup.name }) : tup.name,
          sub: [heat, L(`NEONMARKET.Tup.Fits.${tup.fits}`), tup.onlyFor ? L("NEONMARKET.Tup.Exclusive", { name: tup.inventedFor || "?" }) : null].filter(Boolean).join(" · "),
          modes, mode, meta: L("NEONMARKET.Tup.Meta", { dv: tup.dv })
        };
        if (mode === "kit") {
          out.push(this.#row({ ...base, kind: "tupKit" }, null, 0, tup.cost, wealth));
          continue;
        }
        const targets = this.#tupTargets(tup, owners, customer);
        const target = targets.find((t) => t.value === s.tupTarget[key]) ?? targets[0];
        const plan = target ? tupInstallPlan(tech, tup, target.doc, { vas: target.vas, kit: !!kit }) : null;
        out.push(this.#row({
          ...base, kind: "tupInstall", targets, target, install: plan, actorUuid: target?.actorUuid, itemId: target?.itemId,
          timeText: plan ? timeText(plan) : null,
          blocked: !target ? L("NEONMARKET.Tup.NoTarget", { fits: L(`NEONMARKET.Tup.Fits.${tup.fits}`) }) : plan ? null : L("NEONMARKET.Tech.Error.NoSkill")
        }, plan?.check ?? null, plan?.labor ?? 0, plan?.materials ?? 0, wealth));
      }
    } else if (s.tab === "fabricate") {
      for (const bp of tech.blueprints) {
        const plan = fabricatePlan(tech, bp);
        out.push(this.#row({
          key: `fabricate:${bp.id}`, kind: "fabricate", blueprintId: bp.id, img: bp.itemData.img, name: bp.itemData.name,
          sub: `${CPR.typeLabel(bp.itemData.type)} · ${L(`NEONMARKET.Tier.${tierKey(bp.category || categoryOf(marketPrice(bp.itemData)))}`)}`,
          blueprint: bp, timeText: timeText(plan), blocked: plan ? null : L("NEONMARKET.Tech.Error.NoSkill")
        }, plan, plan?.fee, plan?.materials, wealth));
      }
    } else if (s.tab === "invent") {
      out.push(this.#row({ key: "invent", kind: "invent", icon: "fa-solid fa-lightbulb", name: L("NEONMARKET.Tech.Invent.Row"), sub: L("NEONMARKET.Tech.Invent.RowSub") }, null, 0, 0, wealth));
      out[0].price = L("NEONMARKET.Tech.Invent.GmPrices");
    }
    return out;
  }

  /** Items (and VAS vehicles) this TUp could be installed in: the customer's and their vehicles'. */
  #tupTargets(tup, owners, customer) {
    const out = [];
    for (const owner of owners) {
      const vas = owner !== customer;
      if (vas && tupFits(tup, owner, { vas: true })) out.push({ value: `${owner.uuid}|`, label: owner.name, doc: owner, vas: true, actorUuid: owner.uuid, itemId: null });
      for (const item of owner.items) {
        if (!tupFits(tup, item)) continue;
        out.push({ value: `${owner.uuid}|${item.id}`, label: vas ? `${item.name} (${owner.name})` : item.name, doc: item, vas: false, actorUuid: owner.uuid, itemId: item.id });
      }
    }
    return out;
  }

  #detail(tech, customer, row, wealth) {
    const s = this.techState;
    const detail = {
      ...row,
      rule: L(`NEONMARKET.Tech.Rule.${row.kind}`),
      check: row.plan ? L("NEONMARKET.Tech.CheckLine", {
        skill: L(`NEONMARKET.Tech.Skill.${row.plan.skill}`), base: row.plan.base, dv: row.plan.dv, chance: row.chance
      }) : null,
      breakdown: row.materials ? L("NEONMARKET.Tech.Breakdown", { materials: formatEb(row.materials), labor: formatEb(row.fee) }) : null,
      failNote: row.plan ? L(tech.options.chargeOnFailure && row.fee > 0 ? "NEONMARKET.Tech.FailCharged" : "NEONMARKET.Tech.FailFree") : null,
      canBook: !row.blocked && row.total <= wealth && !s.busy
    };
    if (row.kind === "vehicle") {
      const d = row.damage;
      detail.lines = [
        L("NEONMARKET.Tech.Sdp", { value: d.hp.value, max: d.hp.max }),
        ...d.armor.map((a) => L("NEONMARKET.Tech.Condition.plating", { item: a.name })),
        ...(d.glass.length ? [L("NEONMARKET.Tech.Condition.glass", { n: d.glass.length })] : []),
        ...d.injuries.map((i) => i.name)
      ];
    }
    if (row.isVehicleItem) {
      detail.damageOptions = VEHICLE_DAMAGE.filter((k) => k !== "destroyed").map((k) => ({ key: k, label: L(`NEONMARKET.Tech.Damage.${k}`), selected: k === s.vehicleDamage }));
    }
    if (row.kind === "upgrade") {
      detail.upgradeOptions = row.options.map((k) => ({ key: k, label: L(`NEONMARKET.Tech.Upgrade.${k}`), selected: k === row.chosen }));
      detail.upgradeHint = L(`NEONMARKET.Tech.UpgradeHint.${row.chosen}`);
      detail.needsNote = !UPGRADES[row.chosen].auto;
      detail.note = s.note;
      if (detail.needsNote && !s.note.trim()) detail.canBook = false;
    }
    if (row.kind === "tupInstall" || row.kind === "tupKit") {
      const tup = row.tup;
      detail.effect = tup.effect;
      detail.heatLine = L("NEONMARKET.Tup.HeatLine", { heat: L(`NEONMARKET.Tup.Heat.${tup.heat}`), cost: formatEb(tup.cost), dv: tup.dv });
      if (row.modes.length > 1) detail.tupModes = row.modes.map((m) => ({ key: m, label: L(`NEONMARKET.Tup.Mode.${m}`), selected: m === row.mode }));
      if (row.kind === "tupInstall") {
        if (row.targets.length) detail.tupTargets = row.targets.map((t) => ({ value: t.value, label: t.label, selected: t === row.target }));
        if (row.install) {
          detail.breakdown = L(row.kitItemId ? "NEONMARKET.Tup.BreakdownKit" : "NEONMARKET.Tup.Breakdown", {
            cost1: formatEb(row.install.cost1), cost2: formatEb(row.install.cost2), labor: formatEb(row.install.labor)
          });
          if (!row.plan) detail.check = L("NEONMARKET.Tup.AutoSuccess");
        }
      } else {
        detail.breakdown = L("NEONMARKET.Tup.KitBreakdown", { cost: formatEb(tup.cost) });
      }
    }
    if (row.kind === "fabricate") {
      detail.stats = CPR.statLines(row.blueprint.itemData);
      detail.inventedFor = row.blueprint.inventedFor ?? null;
    }
    if (row.kind === "invent") {
      detail.invention = {
        ...s.invention,
        kinds: [...Object.keys(INVENTION_KINDS), "upgrade"].map((k) => ({ key: k, label: L(`NEONMARKET.Tech.Kind.${k}`), selected: k === s.invention.kind }))
      };
      detail.canBook = !s.busy && !!s.invention.name.trim() && !!s.invention.description.trim();
    }
    if (row.total > wealth && !row.blocked) detail.blocked = L("NEONMARKET.Clinic.CantAfford", { price: row.price });
    return detail;
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
    const s = this.techState;
    if (this._pendingFlash) {
      root.querySelector(".nm-shell")?.classList.add(`flash-${this._pendingFlash}`);
      this._pendingFlash = null;
    }
    const on = (sel, evt, fn) => root.querySelector(sel)?.addEventListener(evt, fn);
    on("select[name=customer]", "change", (ev) => {
      s.customerUuid = ev.currentTarget.value || null;
      s.focus = null;
      this.render();
    });
    on("select[name=vehicleDamage]", "change", (ev) => {
      s.vehicleDamage = ev.currentTarget.value;
      this.render();
    });
    on("select[name=tupMode]", "change", (ev) => {
      s.tupMode[s.focus] = ev.currentTarget.value;
      this.render();
    });
    on("select[name=tupTarget]", "change", (ev) => {
      s.tupTarget[s.focus] = ev.currentTarget.value;
      this.render();
    });
    on("select[name=upgrade]", "change", (ev) => {
      s.upgrade[s.focus] = ev.currentTarget.value;
      this.render();
    });
    // Typed text is kept in state without re-rendering, so focus and the caret stay put.
    on("input[name=note]", "input", (ev) => {
      s.note = ev.currentTarget.value;
      this.#syncBook(!!s.note.trim());
    });
    for (const field of ["name", "description"]) {
      on(`[name=invention-${field}]`, "input", (ev) => {
        s.invention[field] = ev.currentTarget.value;
        this.#syncBook(!!s.invention.name.trim() && !!s.invention.description.trim());
      });
    }
    on("select[name=invention-kind]", "change", (ev) => {
      s.invention.kind = ev.currentTarget.value;
    });
    this.#typeSpeech(context.speech);
    if (!this._opened) {
      this._opened = true;
      root.focus({ preventScroll: true });
    }
  }

  #syncBook(ok) {
    const btn = this.element.querySelector("[data-action=book]");
    if (btn) btn.disabled = !ok || this.techState.busy;
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
    if (TechApp.instances.get(this.shopActor.uuid) === this) TechApp.instances.delete(this.shopActor.uuid);
  }

  /* ---------------------------------------- */
  /*  Actions                                 */
  /* ---------------------------------------- */

  static #onClose() {
    this.close();
  }

  static #onSetTab(event, target) {
    const tab = target.dataset.mode;
    if (tab === this.techState.tab) return;
    this.techState.tab = tab;
    this.techState.focus = tab === "invent" ? "invent" : null;
    this.render();
  }

  static #onFocus(event, target) {
    const key = target.dataset.key;
    if (key === this.techState.focus) return;
    this.techState.focus = key;
    this.techState.note = "";
    this.render();
  }

  static #onOpenVenue(event, target) {
    openVenue(this.shopActor, target.dataset.venue);
  }

  static #onConfigure() {
    if (!game.user.isGM) return;
    game.modules.get(MODULE_ID).api.configureTech(this.shopActor);
  }

  static async #onBook() {
    const s = this.techState;
    if (s.busy || !s.focus) return;
    if (this.preview) return ui.notifications.info(game.i18n.localize("NEONMARKET.Tech.PreviewNoBooking"));
    const customer = this.customer;
    if (!customer) return ui.notifications.warn(L("NEONMARKET.Tech.PickCustomer"));
    const tech = this.tech;
    const row = this.#rows(tech, customer, CPR.hasWealth(customer) ? CPR.getWealth(customer) : 0).find((r) => r.key === s.focus);
    if (!row || row.blocked) return;

    const name = row.kind === "invent" ? s.invention.name.trim() : row.name;
    const ok = await foundry.applications.api.DialogV2.confirm({
      classes: ["neon-market-dialog"],
      window: { title: tech.identity.name },
      content: `<p>${L(row.kind === "invent" ? "NEONMARKET.Tech.ConfirmInvent" : "NEONMARKET.Tech.Confirm", {
        actor: Handlebars.escapeExpression(customer.name), job: Handlebars.escapeExpression(name), price: row.price
      })}</p>${row.plan ? `<p>${L("NEONMARKET.Clinic.ConfirmOdds", { chance: row.chance })}</p>` : ""}`,
      rejectClose: false
    });
    if (!ok) return;

    const kind = row.kind;
    const params = {
      actorUuid: row.actorUuid,
      itemId: row.itemId,
      vehicleDamage: s.vehicleDamage,
      upgrade: row.chosen,
      note: s.note,
      blueprintId: row.blueprintId,
      tupId: row.tupId,
      kitItemId: row.kitItemId,
      name: s.invention.name,
      inventionKind: s.invention.kind,
      description: s.invention.description
    };
    s.busy = true;
    this.render();
    try {
      const result = await ShopSocket.request("tech", { kind, customerUuid: customer.uuid, shopUuid: this.shopActor.uuid, params }, { timeout: 300_000 });
      s.speech = L(result.success ? "NEONMARKET.Tech.Speech.Success" : "NEONMARKET.Tech.Speech.Failure");
      if (result.success && kind === "invent") s.invention = { name: "", kind: "gear", description: "" };
      s.focus = kind === "invent" ? "invent" : null;
      s.note = "";
      this._pendingFlash = result.success ? "success" : "error";
    } catch (err) {
      ui.notifications.warn(err.message);
      if (err.code === "noFunds") s.speech = L("NEONMARKET.Tech.Speech.NoFunds");
      this._pendingFlash = "error";
    } finally {
      s.busy = false;
      if (this.rendered) this.render();
    }
  }
}

/** "veryExpensive" → "VeryExpensive", the tier label key. */
function tierKey(cat) {
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}
