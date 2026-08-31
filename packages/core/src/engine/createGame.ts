import type { ContentRegistry } from "../content/registry.js";
import { migrateSnapshot, SAVE_VERSION, type GameStateV1 } from "../save/migrations.js";
import type { Clock, GameEvent, GameListener, Rng, SaveStore, Snapshot } from "../types.js";

export interface Game {
  /** Subscribe to the engine event stream. Returns an unsubscribe function. */
  subscribe(listener: GameListener): () => void;
  currentRealm(): { id: string; index: number; name: string };
  progress(): { resourceId: string; current: number; required: number };
  resourceAmount(resourceId: string): number;
  activeActivity(): { id: string; name: string } | null;
  startActivity(activityId: string): void;
  stopActivity(): void;
  /**
   * Settle time-based accrual up to the clock's current time. A single gap is
   * capped at the activity's content-defined offline maximum, which is what
   * makes long offline gaps safe while short online ticks are untouched.
   * Only whole cycles settle; partial-cycle time carries over unless the
   * offline cap cuts the gap (a capped gap discards its remainder).
   */
  sync(): void;
  snapshot(): Snapshot<GameStateV1>;
}

export interface CreateGameOptions {
  content: ContentRegistry;
  save: SaveStore;
  clock: Clock;
  rng: Rng;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

interface EngineOptions {
  content: ContentRegistry;
  clock: Clock;
  rng: Rng;
}

function buildGame(options: EngineOptions, state: GameStateV1): Game {
  const { content, clock } = options;
  // rng participates from the combat/loot slices onward; the facade contract
  // keeps it injectable from day one so those slices stay deterministic.
  void options.rng;
  const listeners = new Set<GameListener>();

  // Restored states must reference entries that still exist in content.
  content.realm(state.realmId);
  if (state.activeActivityId != null) content.activity(state.activeActivityId);

  function emit(event: GameEvent): void {
    for (const listener of listeners) listener(event);
  }

  function sync(): void {
    const now = clock.now();
    const elapsedMs = now - state.lastSettleTimestamp;
    if (elapsedMs <= 0) return;

    const activity = state.activeActivityId != null ? content.activity(state.activeActivityId) : null;
    const cycleMs = (activity?.cycleSeconds ?? 0) * 1000;
    const capMs = activity?.offlineCapHours != null ? activity.offlineCapHours * 3_600_000 : Infinity;
    const settledMs = Math.min(elapsedMs, capMs);
    const cycles = cycleMs > 0 ? Math.floor(settledMs / cycleMs) : 0;

    // Each rate's amountPerCycle is granted once per completed cycle.
    // (Weighted per-cycle picks for multi-output production activities
    // arrive with the production slice; the accrual seam stays the same.)
    const amounts: Record<string, number> = {};
    if (cycles > 0 && activity) {
      for (const rate of activity.rates ?? []) {
        const perCycle = rate.amountPerCycle ?? 0;
        amounts[rate.resourceId] = round6((amounts[rate.resourceId] ?? 0) + perCycle * cycles);
      }
      for (const [resourceId, amount] of Object.entries(amounts)) {
        state.resources[resourceId] = round6((state.resources[resourceId] ?? 0) + amount);
      }
    }

    if (settledMs < elapsedMs) {
      // Gap exceeded the offline cap: everything beyond the cap is discarded
      // so the same span of time is never settled twice. The sub-cycle
      // remainder inside the capped span goes with it — keeping it pending
      // would re-arm the cap on the next sync and double-settle.
      state.lastSettleTimestamp = now;
    } else {
      // Consume whole cycles; partial-cycle time stays pending for the next
      // sync. With no cyclable activity, idle time is consumed in full.
      state.lastSettleTimestamp += cycleMs > 0 ? cycles * cycleMs : settledMs;
    }

    const totals: Record<string, number> = {};
    for (const resourceId of Object.keys(amounts)) {
      totals[resourceId] = state.resources[resourceId] ?? 0;
    }

    emit({
      type: "resourcesAccrued",
      amounts,
      totals,
      cycles,
      settledSeconds: round6(settledMs / 1000),
      capped: settledMs < elapsedMs,
      timestamp: now,
    });
  }

  return {
    subscribe(listener: GameListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Realm advancement (spending the accumulated progression resource to
    // move to the next realm) lands with the progression slice; until then
    // accrual may exceed the current requirement.
    currentRealm() {
      const realm = content.realm(state.realmId);
      return { id: realm.id, index: realm.index, name: realm.name };
    },

    progress() {
      const realm = content.realm(state.realmId);
      const resourceId = content.realmProgressResourceId;
      return {
        resourceId,
        current: round6(state.resources[resourceId] ?? 0),
        required: realm.cultivationRequired,
      };
    },

    resourceAmount(resourceId: string): number {
      return round6(state.resources[resourceId] ?? 0);
    },

    activeActivity() {
      if (state.activeActivityId == null) return null;
      const activity = content.activity(state.activeActivityId);
      return { id: activity.id, name: activity.name };
    },

    startActivity(activityId: string): void {
      const activity = content.activity(activityId); // throws on unknown id
      if (state.activeActivityId === activityId) return;
      sync(); // settle pending cycles for the previous activity first
      state.activeActivityId = activityId;
      emit({ type: "activityStarted", activityId, activityName: activity.name, timestamp: clock.now() });
    },

    stopActivity(): void {
      if (state.activeActivityId == null) return;
      sync(); // settle pending cycles before the activity goes idle
      const previous = state.activeActivityId;
      const activity = content.activity(previous);
      state.activeActivityId = null;
      emit({ type: "activityStopped", activityId: previous, activityName: activity.name, timestamp: clock.now() });
    },

    sync,

    snapshot(): Snapshot<GameStateV1> {
      return { version: SAVE_VERSION, data: structuredClone(state) };
    },
  };
}

/**
 * The single behavioral seam of the engine: content + save + clock/rng go in,
 * state + structured events come out. Loads and migrates the versioned
 * snapshot from the save store (fresh state when the store is empty), then
 * hands control to the host, which drives sync() ticks.
 */
export async function createGame(options: CreateGameOptions): Promise<Game> {
  const snapshot = await options.save.load();
  let state: GameStateV1;
  if (snapshot == null) {
    state = {
      realmId: options.content.startingRealmId,
      resources: {},
      activeActivityId: null,
      lastSettleTimestamp: options.clock.now(),
    };
  } else {
    state = migrateSnapshot<GameStateV1>(snapshot);
    // A save from a clock ahead of ours must not accrue from the future.
    state.lastSettleTimestamp = Math.min(state.lastSettleTimestamp, options.clock.now());
  }
  return buildGame(options, state);
}
