/**
 * Just enough of Foundry and Cyberpunk RED to run the module's rules and service jobs outside
 * Foundry. Runs under Node (the release build) and under SpiderMonkey shells (cjs/gjs).
 * Importing this sets the globals, so import it before any module code.
 */

export const log = globalThis.print ?? ((...a) => console.log(...a));

const getProperty = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const setProperty = (o, p, v) => {
  const ks = p.split(".");
  const last = ks.pop();
  let t = o;
  for (const k of ks) t = t[k] ??= {};
  t[last] = v;
};
const hasProperty = (o, p) => getProperty(o, p) !== undefined;
const deepClone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
function mergeObject(a, b) {
  const out = deepClone(a);
  const merge = (t, s) => {
    for (const [k, v] of Object.entries(s ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && t[k] && typeof t[k] === "object") merge(t[k], v);
      else t[k] = v;
    }
  };
  merge(out, b);
  return out;
}

/** Dice results to hand out, in order. Tests push onto it before each roll. */
export const dice = [];
export const chat = [];
export const settings = { requireApproval: false, receiptMode: "private" };
export const dialogAnswers = [];

let n = 0;
globalThis.foundry = {
  utils: { getProperty, setProperty, hasProperty, deepClone, mergeObject, debounce: (f) => f, randomID: () => `id${++n}` },
  applications: {
    api: { DialogV2: { confirm: async () => true, wait: async () => dialogAnswers.shift() ?? null } },
    handlebars: { renderTemplate: async (path, data) => JSON.stringify(data) }
  }
};
globalThis.Hooks = { on() {}, once() {} };
globalThis.Handlebars = { escapeExpression: (s) => String(s) };
globalThis.ChatMessage = { create: async (d) => chat.push(d), getSpeaker: () => ({}) };
globalThis.Roll = class {
  constructor(f) { this.formula = f; }
  async evaluate() {
    if (!dice.length) throw new Error(`no dice queued for ${this.formula}`);
    this.total = dice.shift();
    return this;
  }
};
globalThis.Actor = class {};
globalThis.Item = class {};

export const gmUser = { id: "gm", name: "GM", isGM: true, isSelf: true };
export const player = { id: "p1", name: "Player", isGM: false };

const modules = new Map();
export function setModule(id, data) {
  modules.set(id, data);
}

globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d) => `${k}${d ? JSON.stringify(d) : ""}`, has: () => false, lang: "en" },
  settings: { get: (_m, k) => settings[k] },
  users: { activeGM: gmUser, filter: () => [gmUser] },
  user: gmUser,
  time: { worldTime: 86400 * 3 },
  actors: [],
  modules: { get: (id) => modules.get(id) }
};

class Coll extends Map {
  filter(fn) { return [...this.values()].filter(fn); }
  find(fn) { return [...this.values()].find(fn); }
  map(fn) { return [...this.values()].map(fn); }
  [Symbol.iterator]() { return this.values(); }
}

export class MockItem {
  constructor(data) {
    Object.assign(this, data);
    this.system ??= {};
    this.flags ??= {};
    this.effects = new Coll();
  }
  async delete() { this.parent.items.delete(this.id); }
  async update(changes) { for (const [k, v] of Object.entries(changes)) setProperty(this, k, v); }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  async setFlag(scope, key, v) { (this.flags[scope] ??= {})[key] = v; }
  async unsetFlag(scope, key) { delete this.flags[scope]?.[key]; }
}

export class MockActor extends Actor {
  constructor({ id, name, hp = [40, 40], humanity = [60, 60], body = 6, wealth = 5000, owner = true, flags = {} }) {
    super();
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.owner = owner;
    this.system = {
      derivedStats: { hp: { value: hp[0], max: hp[1], transactions: [] }, humanity: { value: humanity[0], max: humanity[1], transactions: [] }, deathSave: { penalty: 3 } },
      stats: { body: { value: body } },
      wealth: { value: wealth, transactions: [] },
      externalData: {}
    };
    this.items = new Coll();
    this.flags = flags;
  }
  get itemTypes() {
    const out = { criticalInjury: [], cyberware: [] };
    for (const i of this.items.values()) (out[i.type] ??= []).push(i);
    return out;
  }
  add(data) {
    const i = new MockItem({ ...data, parent: this, actor: this });
    this.items.set(i.id, i);
    return i;
  }
  testUserPermission() { return this.owner; }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  async setFlag(scope, key, v) { (this.flags[scope] ??= {})[key] = v; }
  async update(changes) { for (const [k, v] of Object.entries(changes)) setProperty(this, k, v); }
  async createEmbeddedDocuments(_t, list) { return list.map((d) => this.add({ id: `new${++n}`, ...d })); }
  async deleteEmbeddedDocuments(_t, ids) { for (const id of ids) this.items.delete(id); }
  async installItems(items) { for (const i of items) i.system.isInstalled = true; this.installed = items.map((i) => i.id); return true; }
  async loseHumanityValue(items, mode) { this.lostFor = items.map((i) => i.id); this.lossMode = mode; }
}

const docs = new Map();
globalThis.fromUuid = async (u) => docs.get(u) ?? null;
globalThis.fromUuidSync = (u) => docs.get(u) ?? null;
export function register(...actors) {
  docs.clear();
  for (const a of actors) docs.set(a.uuid, a);
}

/* ---------------------------------------- */
/*  Assertions                              */
/* ---------------------------------------- */

let fails = 0;
export function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
}
export async function throws(label, fn, match) {
  try {
    await fn();
    fails++;
    log(`FAIL ${label}: did not throw`);
  } catch (err) {
    const ok = err.message.includes(match);
    if (!ok) fails++;
    log(`${ok ? "ok  " : "FAIL"} ${label}: ${err.message}`);
  }
}
export function done(name) {
  log(fails ? `\n${name}: ${fails} FAILED` : `\n${name}: all passed`);
  if (fails && globalThis.process) globalThis.process.exitCode = 1;
}

/** Import a module file relative to the repo root (works in Node and SpiderMonkey shells). */
const ROOT = import.meta.url.replace(/tests\/helpers\/foundry\.mjs$/, "");
export const load = (path) => import(`${ROOT}${path}`);
