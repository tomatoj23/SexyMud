/**
 * Platform-facing ports the engine depends on. Everything here is pure:
 * no DOM, no timers, no fetch. Hosts (web, mini-program, desktop) provide
 * the implementations (ADR-0002).
 */

export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
}

/** Deterministic random source, injected so simulations are reproducible. */
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

export type GameEvent =
  | { type: "activityStarted"; activityId: string; activityName: string }
  | { type: "activityStopped"; activityId: string; activityName: string }
  | {
      type: "resourcesAccrued";
      /** Resource amounts gained in this settlement. */
      amounts: Record<string, number>;
      /** Resource totals after applying the amounts. */
      totals: Record<string, number>;
      /** Number of completed activity cycles settled in this pass. */
      cycles: number;
      /** Seconds of elapsed time actually settled (capped at the offline maximum). */
      settledSeconds: number;
      /** True when elapsed time exceeded the activity's offline cap and was cut. */
      capped: boolean;
      timestamp: number;
    };

export type GameListener = (event: GameEvent) => void;
