import { MODULE_ID } from "./constants.js";
import { Compat } from "./compat.js";

/**
 * Per-shop audio. Only one shop plays at a time on a client.
 * Everything is best-effort: an audio failure must never block a trade.
 */
export class ShopAudio {
  static #bgm = null;
  static #bgmSrc = null;
  static #ducked = new Map();

  static async start(shop) {
    this.duckScene();
    const src = shop.audio?.bgm;
    if (!src) return this.stopMusic();
    if (this.#bgm && this.#bgmSrc === src) return;
    await this.stopMusic();
    try {
      const sound = await Compat.AudioHelper.play(
        { src, volume: 0, loop: true, autoplay: true, channel: "music" },
        false
      );
      if (!sound) return;
      this.#bgm = sound;
      this.#bgmSrc = src;
      const target = Math.max(0, Math.min(1, Number(shop.audio.bgmVolume) || 0));
      await this.#fade(sound, target, 1200);
    } catch (err) {
      console.warn(`${MODULE_ID} | background music failed`, err);
    }
  }

  static async stop() {
    await this.stopMusic();
    this.restoreScene();
  }

  static async stopMusic() {
    const sound = this.#bgm;
    this.#bgm = null;
    this.#bgmSrc = null;
    if (!sound) return;
    try {
      await this.#fade(sound, 0, 800);
      sound.stop?.();
    } catch (err) {
      console.warn(`${MODULE_ID} | stopping background music failed`, err);
    }
  }

  static sfx(shop, slot) {
    const src = shop?.audio?.[slot];
    if (!src) return;
    const volume = Math.max(0, Math.min(1, Number(shop.audio.sfxVolume) || 0));
    try {
      Compat.AudioHelper.play({ src, volume, loop: false, autoplay: true, channel: "interface" }, false);
    } catch (err) {
      console.warn(`${MODULE_ID} | sfx "${slot}" failed`, err);
    }
  }

  /** Quiet whatever playlist tracks are running so the shop music reads clearly. */
  static duckScene() {
    const factor = Math.max(0, Math.min(1, Number(game.settings.get(MODULE_ID, "duckVolume")) ?? 0.2));
    for (const playlist of game.playlists?.playing ?? []) {
      for (const ps of playlist.sounds) {
        if (!ps.playing || !ps.sound || this.#ducked.has(ps.uuid)) continue;
        const original = ps.sound.volume ?? ps.volume ?? 1;
        this.#ducked.set(ps.uuid, { ps, original });
        this.#fade(ps.sound, original * factor, 800);
      }
    }
  }

  static restoreScene() {
    for (const { ps, original } of this.#ducked.values()) {
      if (ps.playing && ps.sound) this.#fade(ps.sound, original, 800);
    }
    this.#ducked.clear();
  }

  static async #fade(sound, volume, duration) {
    try {
      if (typeof sound.fade === "function") return await sound.fade(volume, { duration });
      sound.volume = volume;
    } catch (err) {
      try { sound.volume = volume; } catch { /* ignore */ }
    }
  }
}
