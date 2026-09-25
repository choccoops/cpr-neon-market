import { MODULE_ID, SOCKET_NAME, LIMITS } from "./constants.js";
import { Compat } from "./compat.js";

/**
 * A small request/response channel on top of game.socket.
 *
 * Players cannot write to a shop actor they do not own, so every trade is
 * sent to the active GM, who runs it (see transactions.js) and replies.
 * Handlers run through a single queue on the GM client so two players buying
 * the last item at the same moment cannot both succeed.
 */
export class ShopSocket {
  static #pending = new Map();
  static #handlers = new Map();
  static #events = new Map();
  static #queue = Promise.resolve();

  static init() {
    game.socket.on(SOCKET_NAME, (msg) => this.#onMessage(msg));
  }

  /** Register a GM-side operation handler: async (payload, user) => result. */
  static register(op, handler) {
    this.#handlers.set(op, handler);
  }

  /** Register a broadcast event handler run on every receiving client. */
  static on(event, handler) {
    this.#events.set(event, handler);
  }

  static emit(event, payload) {
    game.socket.emit(SOCKET_NAME, { kind: "event", event, payload, senderId: game.user.id });
  }

  /**
   * Ask the active GM to run an operation. If this client is the active GM it runs locally.
   * @returns {Promise<any>} the handler result; rejects with the handler's error message.
   */
  static async request(op, payload, { timeout } = {}) {
    const gm = Compat.activeGM;
    if (!gm) throw new Error(game.i18n.localize("NEONMARKET.Error.NoGM"));
    if (gm.isSelf) return this.#run(op, payload, game.user);

    const requestId = foundry.utils.randomID(16);
    const wait = timeout ?? (game.settings.get(MODULE_ID, "requireApproval") ? LIMITS.approvalTimeoutMs : LIMITS.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(game.i18n.localize("NEONMARKET.Error.Timeout")));
      }, wait);
      this.#pending.set(requestId, { resolve, reject, timer });
      game.socket.emit(SOCKET_NAME, {
        kind: "request",
        requestId,
        op,
        payload,
        senderId: game.user.id,
        gmId: gm.id
      });
    });
  }

  static #run(op, payload, user) {
    const handler = this.#handlers.get(op);
    if (!handler) return Promise.reject(new Error(`Unknown operation: ${op}`));
    const job = this.#queue.then(() => handler(payload, user));
    this.#queue = job.catch(() => null);
    return job;
  }

  static async #onMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.kind === "request") {
      if (msg.gmId !== game.user.id) return;
      const user = game.users.get(msg.senderId);
      let reply;
      try {
        if (!user) throw new Error("Unknown user");
        const result = await this.#run(msg.op, msg.payload, user);
        reply = { ok: true, result };
      } catch (err) {
        console.warn(`${MODULE_ID} | request "${msg.op}" from ${user?.name} failed:`, err);
        reply = { ok: false, error: err?.message ?? String(err), code: err?.code ?? null };
      }
      game.socket.emit(SOCKET_NAME, { kind: "response", requestId: msg.requestId, targetId: msg.senderId, ...reply });
      return;
    }

    if (msg.kind === "response") {
      if (msg.targetId !== game.user.id) return;
      const pending = this.#pending.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(msg.requestId);
      if (msg.ok) pending.resolve(msg.result);
      else {
        const err = new Error(msg.error);
        err.code = msg.code ?? null;
        pending.reject(err);
      }
      return;
    }

    if (msg.kind === "event") {
      const handler = this.#events.get(msg.event);
      if (handler) {
        try {
          await handler(msg.payload, game.users.get(msg.senderId));
        } catch (err) {
          console.error(`${MODULE_ID} | event "${msg.event}" failed`, err);
        }
      }
    }
  }
}
