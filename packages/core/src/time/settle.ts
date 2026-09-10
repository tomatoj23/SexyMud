import { assertTick } from "../clock.js";
import type { TickClock } from "../clock.js";
import type { Message } from "../command/pipeline.js";
import type { EventDraft } from "../command/pipeline.js";
import type { WorldState } from "../state/tree.js";
import type { GameEvent } from "../types.js";

/**
 * The ONE advance function (spec/04 §4.2, ADR-0032 §4, ADR-0034).
 *
 * Online heartbeat, offline catch-up and the due bucket are NOT three
 * mechanisms: they are three SPANS of this one call. A heartbeat is a span of
 * a few ticks, offline catch-up is a span of a hundred thousand, and a due
 * bucket is whatever falls inside the span being settled.
 *
 * The advance is TWO-LAYERED (ADR-0034 §1–§2), and that split is the whole
 * reason offline catch-up can exist at all:
 *
 * - **World layer** — due buckets, one-shot world events. Settled to the
 *   high-water mark on every command that reached execution, once, no matter
 *   how many entities exist.
 * - **Entity layer** — compensation settlement, offline catch-up. Settled for
 *   THIS command's actor only, from that entity's own `lastSeenTick`.
 *
 * ⚠️ The entity layer is actor-only, NOT "everyone present": present ≠ online.
 * Advancing the whole room would let one player's activity eat another's
 * offline budget, and the second player's catch-up would no longer happen on
 * the command they came back with. If every entity advanced with every
 * command, `lastSeenTick` would be pinned to `nowTick` and every offline span
 * would be zero.
 *
 * M4 lands the MECHANISM and the SEAM, not a real consumer: the state tree
 * has no numeric slot worth catching up today, and opening `attrs` now would
 * promise a shape nobody has designed (the same reason §4.1 refuses to build
 * a named effect table for the due bucket). Both layers therefore take one
 * injected handler; tests drive them with SYNTHETIC consumers, after the
 * precedent of `entity-seams.test.ts` and the still-empty `derived` table.
 */

/** One advance covers the half-open interval `[fromTick, toTick)`. */
export interface SettleSpan {
  readonly fromTick: number;
  readonly toTick: number;
}

/**
 * A settlement event BEFORE the settler stamps it — with the one field the
 * framework cannot know: `tick`, the tick this event is FOR.
 *
 * A due item that should have fired at 300 but is only caught up at 1000
 * carries **300** (ADR-0034 §3). Stamping the catch-up tick instead would
 * make event order depend on which player logged in first, and replay would
 * stop being deterministic — the exact thing ADR-0024 §2 seals off.
 */
export type SettleDraft = EventDraft & { tick: number };

/** Where a settlement event goes: the handler decides, the engine delivers. */
export type SettleEmitter = (to: string, event: SettleDraft) => void;

/** The world layer's consumer: due buckets, one-shot world events. */
export type WorldSettleHandler = (span: SettleSpan, emit: SettleEmitter) => void;

/** The entity layer's consumer: compensation settlement, offline catch-up. */
export type EntitySettleHandler = (entityId: string, span: SettleSpan, emit: SettleEmitter) => void;

export interface SettleRequest {
  /**
   * Settle the world up to (not including) this tick. A value below the
   * high-water mark changes nothing — the mark never decreases.
   */
  toTick: number;
  /**
   * The seq settlement events borrow (ADR-0034 §4): they are produced by no
   * input of their own, so they ride the command that triggered the advance
   * and keep "seq N = every event of the Nth command" undiluted. Sorted
   * BEFORE that command's own events, because the world reaches "now" before
   * the command happens: a player returning after three days reads what
   * happened first, then "you go north".
   */
  seq: number;
  /**
   * The actor whose entity layer is settled — ONLY theirs. It also names the
   * actor stamped on the settlement events, exactly as the pipeline stamps
   * the command's own events. Absent means a HOST HEARTBEAT (ADR-0034 §5):
   * no actor, so the world layer runs alone and its events carry none.
   * A heartbeat is never disguised as a system command with an empty
   * `actorId`; the caller supplies a seq from the command stream instead.
   */
  actorId?: string;
}

export interface SettlerOptions {
  /** The one state tree — `lastSeenTick` is read and written in place. */
  state: WorldState;
  /**
   * The driver's high-water mark (spec/04 §2.2). It IS the tick the world
   * layer is settled to: settling moves it, so there is no second
   * "lastSettledTick" to drift away from it (ADR-0034 §1).
   */
  clock: TickClock;
  /** The world-layer consumer. Absent today: the seam, no consumer yet. */
  world?: WorldSettleHandler;
  /** The entity-layer consumer. Absent today: the seam, no consumer yet. */
  entity?: EntitySettleHandler;
}

export interface Settler {
  /** Advances both layers and returns the settlement events, in order. */
  settleTo(request: SettleRequest): Message[];
}

/**
 * A heartbeat's or world event's actor: none. `GameEvent.actorId` is
 * required, so "no actor" is an empty string.
 *
 * ⚠️ This is NOT the `actorId: ""` ADR-0034 §5 refuses: that was a forged
 * SYSTEM COMMAND, and none is forged here — a heartbeat sets no command at
 * all, it is a settle without an actor. A command without an actor would
 * dilute what "command" means; an event without one is just an event nobody
 * did.
 */
const NO_ACTOR = "";

export function createSettler(options: SettlerOptions): Settler {
  const { state, clock } = options;
  return {
    settleTo(request) {
      assertTick(request.toTick, "settleTo.toTick");
      const messages: Message[] = [];
      /**
       * `seq` and `actorId` are stamped by the framework; `tick` is the
       * draft's own, and it is the ONE field a settlement event must not get
       * wrong — so it is validated as a tick even though the type already
       * demands it (a number read out of a payload is still a number).
       */
      const emitter = (fallbackActorId: string): SettleEmitter =>
        (to, draft) => {
          assertTick(draft.tick, "settle event tick");
          const event: GameEvent = { ...draft, seq: request.seq, actorId: fallbackActorId };
          messages.push({ to, event });
        };

      // Resolved BEFORE anything moves: a bad request must leave the world
      // exactly as it was, clock included.
      const actor =
        request.actorId === undefined ? undefined : state.entities[request.actorId];
      if (request.actorId !== undefined && actor === undefined) {
        // Wiring bug, not play: an advance was asked for an entity the world
        // has never seen.
        throw new Error(`settle: unknown entity id "${request.actorId}"`);
      }

      // The world layer's start IS the high-water mark, and settling raises
      // that very mark: one number, written once, no parallel truth.
      const worldFromTick = clock.nowTick();
      const toTick = clock.observe(request.toTick);
      if (toTick > worldFromTick) {
        options.world?.(
          { fromTick: worldFromTick, toTick },
          emitter(request.actorId ?? NO_ACTOR),
        );
      }

      if (actor !== undefined) {
        const fromTick = actor.lastSeenTick;
        const settledTo = Math.max(fromTick, toTick);
        if (settledTo > fromTick) {
          options.entity?.(actor.id, { fromTick, toTick: settledTo }, emitter(actor.id));
        }
        // Written by the ENGINE, never by the host: "when was this entity
        // last settled" is a fact about the world, and a host clock that
        // wrote it would smuggle its own notion of time in (ADR-0034 §2).
        actor.lastSeenTick = settledTo;
      }

      return messages;
    },
  };
}
