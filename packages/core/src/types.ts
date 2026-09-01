/**
 * Platform-facing ports and the engine's external contract.
 *
 * Everything here is pure: no platform API, no theme vocabulary, no hardcoded
 * quantities. Hosts (web, mini-program, desktop, server) provide the
 * implementations.
 *
 * This file is the contract layer described in docs/spec/01-engine-contract.md
 * and the six cross-cutting contracts it lists (§7).
 */

/**
 * Monotonic engine tick counter.
 *
 * NOT milliseconds, and never derived from a wall clock. The engine advances
 * by ticks; anything time-based is computed from this counter so the same
 * command sequence always produces the same result (ADR-0017).
 */
export interface Clock {
  nowTick(): number;
}

/** Seeded deterministic random source. The seed lives in the save. */
export interface Rng {
  next(): number;
}

export interface Snapshot<T = unknown> {
  version: number;
  data: T;
}

export interface SaveStore {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
}

export interface Command {
  /** Monotonic, assigned by the caller. Used for ordering, dedup and replay. */
  seq: number;
  /**
   * Explicit actor — never inferred from ambient "current character" state.
   * Retrofitting this later means changing every call site and reducer
   * signature (ADR-0025 §1.1).
   */
  actorId: string;
  /** Raw player input, before parsing. */
  raw: string;
}

/**
 * Three failure classes with different retry semantics (ADR-0025 §1.2):
 * - `rejected`: the engine legitimately refused (not enough resource, gate
 *   closed). The seq IS consumed; the refusal is returned to the player as an
 *   event, because it is game content rather than an error.
 * - `invalid`: malformed or unparseable. seq NOT consumed.
 * - `transport`: not delivered. seq NOT consumed; safe to retry.
 */
export type DispatchFailure =
  | { kind: "rejected"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "transport"; reason: string };

/**
 * Dispatch outcome for one command. `seq` identifies which command this
 * result answers (spec/01 §2.2): on `rejected` the seq IS consumed — an
 * event carrying it was emitted — while on `invalid`/`transport` no event
 * with that seq ever reaches the stream, so the caller knows it may reissue.
 */
export type CommandResult =
  | { ok: true; seq: number; events: GameEvent[] }
  | ({ ok: false; seq: number } & DispatchFailure);
/**
 * A single engine occurrence.
 *
 * Pure semantics — NEVER rendered text. Rendering happens outside the engine
 * boundary, per receiver, so that a Chinese reader sees the second-person
 * pronoun where an observer sees a name (ADR-0006, docs/spec/05-output-pipeline.md).
 */
export interface GameEvent {
  seq: number;
  type: string;
  actorId: string;
  [key: string]: unknown;
}

export interface EventMeta {
  /** Inclusive seq range covered by this delivery, for gap detection. */
  fromSeq: number;
  toSeq: number;
}

export type GameListener = (events: GameEvent[], meta: EventMeta) => void;

/**
 * The authority over world state.
 *
 * The UI knows only this interface, never the implementation — swapping a
 * local authority for a remote one must not change a line of engine code
 * (ADR-0017, ADR-0025 §1).
 */
export interface Authority {
  dispatch(command: Command): Promise<CommandResult>;
  subscribe(listener: GameListener): () => void;
  snapshot(): Promise<Snapshot>;
}
