import { assertTick } from "../clock.js";
import type { EventDraft } from "../command/pipeline.js";
import type { SettleEmitter, SettleSpan } from "./settle.js";

/**
 * The due bucket (spec/04 §4.5, ADR-0032 §5): the ONE primitive that cannot
 * be degraded into a pure function.
 *
 * A delayed explosion is a side effect — there is no `f(tick)` that answers
 * "did it go off", because going off CHANGES the world. Everything else in
 * scheduling was made a pure function on purpose (the pulses formula, stage
 * evaluation, the calendar), but this one cannot be. That has a consequence
 * the design has to pay for: **it must be storable**, because a closure is
 * not. If the bucket lived in a closure, a delayed explosion would silently
 * vanish on reload — the bomb is armed, the player saves, the player comes
 * back, and there is no bomb.
 *
 * So the payload is OPAQUE DATA: `{ dueTick, payload }`. The engine never
 * interprets a payload, never sorts by it, never looks inside it. What the
 * payload MEANS is the host's business, delivered through one injected
 * handler (O8) — exactly as `subjectOf` keeps the engine from guessing what
 * an entity is.
 *
 * The bucket is GLOBAL and flat (spec/04 §6 O4): there is no index by room,
 * area or entity, and there will not be one. "The bomb in this room" is a
 * payload that happens to carry a room id — not a query the engine answers.
 *
 * Its cost is O(due items), never O(ticks) (§4.4): a settle walks the pending
 * items once, however many ticks the span covers.
 */

/** One armed item: WHEN it goes off, and WHAT — the engine knows only when. */
export interface DueItem {
  /** The tick this fires at; also the tick its event is stamped with. */
  readonly dueTick: number;
  /** Opaque to the engine: whatever the host's handler needs to act. */
  readonly payload: unknown;
}

/**
 * An event for a due item, with `tick` deliberately UNAVAILABLE: the engine
 * stamps it — the item's own `dueTick`. `never` rather than "ignored", so a
 * handler that tries is told at compile time instead of being silently
 * overridden. That is ADR-0034 §3 made structural rather than a rule somebody
 * has to remember: an item due at 300 but only noticed at 1000 says 300,
 * because writing 1000 would make event order depend on which player logged
 * in first.
 */
export type DueEvent = EventDraft & { tick?: never };

/** Emits one event for a due item. */
export type DueEmitter = (to: string, event: DueEvent) => void;

/** What a due item DOES. Injected by the host (spec/04 §6 O8). */
export type DueHandler = (item: DueItem, emit: DueEmitter) => void;

export interface DueBucketOptions {
  /**
   * Turns a payload into events. Required, and injected rather than read from
   * a registry: the engine has no idea what a payload means, and a command
   * that reached into the content registry for it would break both "deps are
   * explicit" and "the engine reads no content".
   */
  fire: DueHandler;
}

/**
 * The scheduling half a command sees (§6 O8). Deliberately NARROW: a command
 * may arm something, it may not disarm, inspect or fire anything — firing is
 * the settle's job, and reading pending items is nobody's but the host's.
 */
export interface DueScheduler {
  schedule(dueTick: number, payload: unknown): void;
}

export interface DueBucket extends DueScheduler {
  /**
   * The world-layer consumer for `createSettler` (spec/04 §4.1): fires every
   * item due by the tick being settled TO, in ascending `dueTick` order.
   */
  settle(span: SettleSpan, emit: SettleEmitter): void;
  /**
   * Pending items, ascending by dueTick — the save's shape (§4.5), and
   * canonical for the same reason a save's other collections are: two equal
   * worlds write the same bytes (ADR-0024 §2).
   */
  snapshot(): DueItem[];
  /** Replaces the pending set: the load path. Malformed items fail loudly. */
  restore(items: readonly DueItem[]): void;
}

/**
 * An item whose due tick has already passed is OVERDUE, not lost: it fires at
 * the next settle and its event carries the tick it was DUE. That is the same
 * case ADR-0034 §3 describes ("due at 300, noticed at 1000"), so no special
 * rule is needed for it — the lower bound of the span is simply not a gate.
 */
export function createDueBucket(options: DueBucketOptions): DueBucket {
  let items: DueItem[] = [];

  const readItems = (raw: readonly DueItem[]): DueItem[] =>
    raw.map((item, index) => {
      if (typeof item !== "object" || item === null) {
        throw new Error(`due bucket: item ${index} is not an object`);
      }
      // A tick that is not a tick would make ordering meaningless, and a
      // non-finite due tick would never compare as due again (NaN < x is
      // false for every x) — the item would arm forever. Wiring, not play.
      assertTick(item.dueTick, `due bucket: item ${index}.dueTick`);
      return { dueTick: item.dueTick, payload: item.payload };
    });

  return {
    schedule(dueTick, payload) {
      assertTick(dueTick, "due bucket: schedule dueTick");
      // Appended, not inserted: ordering happens at fire time, and a stable
      // sort keeps insertion order for items sharing one dueTick — the
      // stable order §4.5 promises.
      items = [...items, { dueTick, payload }];
    },
    settle(span, emit) {
      // `dueTick <= toTick`, not `<`: the tick being settled TO is NOW, and
      // "is it due yet?" reads `now >= due` here exactly as a cooldown does
      // (cooldown.ts). The span `[fromTick, toTick)` says what ELAPSED; it
      // does not say the tick at its end has not arrived.
      const fired = items
        .filter((item) => item.dueTick <= span.toTick)
        .sort((left, right) => left.dueTick - right.dueTick);
      if (fired.length === 0) {
        return;
      }
      // Snapshot the set BEFORE firing: a handler that arms a follow-up item
      // (a chain of explosions) must not have it fired by the settle that is
      // already running — it belongs to the next span.
      const gone = new Set(fired);
      items = items.filter((item) => !gone.has(item));
      for (const item of fired) {
        options.fire(item, (to, event) => emit(to, { ...event, tick: item.dueTick }));
      }
    },
    snapshot() {
      // Sorted here, not at restore: whatever order items were armed in, the
      // save's bytes are one thing (the `flags` precedent).
      return items
        .map((item) => ({ dueTick: item.dueTick, payload: item.payload }))
        .sort((left, right) => left.dueTick - right.dueTick);
    },
    restore(raw) {
      // Resolved in full BEFORE anything is replaced: a corrupt save must not
      // leave the bucket half-loaded.
      items = readItems(raw).sort((left, right) => left.dueTick - right.dueTick);
    },
  };
}
