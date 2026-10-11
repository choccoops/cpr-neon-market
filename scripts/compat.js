/**
 * Compatibility layer.
 *
 * Foundry v12 still exposes many classes as globals; v13+ moves them under the
 * `foundry.*` namespace and the globals start emitting deprecation warnings
 * (and are removed a few versions later). Every lookup here prefers the
 * namespaced path and falls back to the v12 global, so the rest of the module
 * never touches a global that is on its way out.
 */

const ns = (path) => foundry.utils.getProperty(globalThis, path);

/**
 * Foundry v12 globals, by name. v12 declares its classes with top-level `class`
 * statements: global names a script can use, but not properties of globalThis, so
 * `globalThis.FilePicker` is undefined there. Each is read as a bare identifier
 * instead (which also picks up hosts that swap one out, like The Forge's FilePicker).
 */
const V12 = {
  FilePicker: () => (typeof FilePicker === "undefined" ? undefined : FilePicker),
  TextEditor: () => (typeof TextEditor === "undefined" ? undefined : TextEditor),
  AudioHelper: () => (typeof AudioHelper === "undefined" ? undefined : AudioHelper),
  renderTemplate: () => (typeof renderTemplate === "undefined" ? undefined : renderTemplate),
  loadTemplates: () => (typeof loadTemplates === "undefined" ? undefined : loadTemplates)
};
const v12 = (name) => globalThis[name] ?? V12[name]();

export const Compat = {
  get generation() {
    return Number(game.release?.generation ?? 12);
  },

  get ApplicationV2() {
    return foundry.applications.api.ApplicationV2;
  },

  get HandlebarsApplicationMixin() {
    return foundry.applications.api.HandlebarsApplicationMixin;
  },

  get DialogV2() {
    return foundry.applications.api.DialogV2;
  },

  get FilePicker() {
    return ns("foundry.applications.apps.FilePicker.implementation") ?? v12("FilePicker");
  },

  get TextEditor() {
    return ns("foundry.applications.ux.TextEditor.implementation") ?? v12("TextEditor");
  },

  get AudioHelper() {
    return ns("foundry.audio.AudioHelper") ?? v12("AudioHelper");
  },

  renderTemplate(path, data) {
    const fn = ns("foundry.applications.handlebars.renderTemplate") ?? v12("renderTemplate");
    return fn(path, data);
  },

  loadTemplates(paths) {
    const fn = ns("foundry.applications.handlebars.loadTemplates") ?? v12("loadTemplates");
    return fn(paths);
  },

  getDragEventData(event) {
    return this.TextEditor.getDragEventData(event);
  },

  async enrichHTML(content, options = {}) {
    if (!content) return "";
    return this.TextEditor.enrichHTML(content, options);
  },

  /** v12 hooks hand over jQuery for AppV1 apps; v13 AppV2 hooks hand over HTMLElement. */
  element(html) {
    if (!html) return null;
    if (html instanceof HTMLElement) return html;
    return html[0] ?? null;
  },

  /** Grid distance between two points in scene units, using the v12 grid API when present. */
  measureDistance(a, b) {
    const grid = canvas?.grid;
    if (grid?.measurePath) return grid.measurePath([a, b]).distance;
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    const size = grid?.size || canvas.dimensions?.size || 100;
    const units = canvas.scene?.grid?.distance ?? canvas.dimensions?.distance ?? 1;
    return (px / size) * units;
  },

  /** First active GM, the one who processes transactions. */
  get activeGM() {
    return game.users.activeGM ?? game.users.find((u) => u.isGM && u.active) ?? null;
  }
};
