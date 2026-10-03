import { createSeededRng } from "../rng.js";
import type { ContentRegistry } from "../content/registry.js";
import type { DueBucket } from "../time/due.js";
import type { Rng, Snapshot } from "../types.js";
import type { Entity } from "../world/entity.js";
import { createWorldRuntime } from "../world/runtime.js";
import type { WorldRuntime } from "../world/runtime.js";
import { restoreWorld } from "./snapshot.js";
import type { RestoreOptions, WorldMeta } from "./snapshot.js";

/**
 * The load path's ONE entry (`assembleWorld`) and the save path's symmetric
 * face (`collectMeta`), living together on purpose (#37, spec/04 §1.5): they
 * are the two halves of one round trip. The entry takes a snapshot apart into
 * a live world; the collection face reads a live world back into the scalars
 * `serializeWorld` takes.
 *
 * Loading a save is five steps —
 *
 *   restoreWorld(snapshot) → createWorldRuntime({ registry, state, nowTick })
 *   → createSeededRng(meta.rngState) → bucket.restore(meta.due)
 *   → attachEntity × N
 *
 * — and until this module the checklist lived only in prose and in tests that
 * assembled it by hand (two of them, in two different orders). A hand
 * checklist can forget a step, and a forgotten step fails SILENTLY: miss
 * `bucket.restore` and the armed bomb simply vanishes; miss `attachEntity` and
 * the world plays until someone asks for a hook. So the checklist becomes one
 * entry, and forgetting a step becomes structurally impossible (D1 — the same
 * bargain as the dispatch driver (#35): a convention becomes structure).
 *
 * ⚠️ What this deliberately does NOT do is pin an ORDER. The sequence above is
 * what the data dependencies force (`restoreWorld` must precede
 * `attachEntity`; the runtime eats its output) and the one choice it leaves
 * free — which entity attaches first — was never a fact worth asserting (a
 * carried entity may be attached before its carrier; `attachEntity`'s
 * location check is order-independent on purpose). The order is this module's
 * implementation detail; the COMPLETENESS is the contract.
 *
 * The red line is additive (D2, AC3): `restoreWorld`/`serializeWorld` are
 * untouched, and the hand path stays legal — `snapshot.test.ts` still
 * hand-assembles and still runs. This entry is the road, not a toll gate, and
 * O9's answer stands: the scalars travel through `WorldMeta`, never through
 * `WorldState`.
 */

/**
 * The three live pieces a host drives a world with — everything `collectMeta`
 * reads and everything `assembleWorld` hands back. A host that assembled by
 * hand has exactly this shape too, so the collection face takes it NARROWLY:
 * the entry's full return (`AssembledWorld`, with its `meta`) is a bundle,
 * never the other way around.
 */
export interface WorldBundle {
  /** The live world; its `clock` IS the high-water mark (spec/04 §2.2). */
  runtime: WorldRuntime;
  /** The live stream; `getState()` is what the save carries (ADR-0033 §1). */
  rng: Rng;
  /**
   * THE live due bucket — the one that arms and fires (spec/04 §4.5). One per
   * world, for the same reason `LocalAuthority` demands one: a save that read
   * a different bucket than the one holding live fuses would write `due: []`
   * over them.
   */
  bucket: DueBucket;
}

/** What `assembleWorld` hands back: the live bundle plus the scalars it was restored from. */
export interface AssembledWorld extends WorldBundle {
  /**
   * The `WorldMeta` `restoreWorld` read out of the save (O9): handed back so a
   * caller can inspect what was loaded without re-reading the snapshot. It is
   * a RECORD of the load, not the live values — a world that has played since
   * answers through `collectMeta`, never through this field.
   */
  meta: WorldMeta;
}

export interface AssembleWorldOptions {
  /** The save to replay — any version the migration chain can walk. */
  snapshot: Snapshot;
  /** Immutable content the restored world answers against; the host's. */
  registry: ContentRegistry;
  /**
   * THE live due bucket. The entry restores `meta.due` INTO this very object
   * and hands it back in the bundle — it does not create one, because the
   * `fire` handler is the host's to own (spec/04 §6 O8) and a second bucket
   * would lose the fuses.
   */
  bucket: DueBucket;
  /**
   * The hook-carrying instances the host rebuilt — one per restored entity.
   * The host rebuilds (it owns the constructors) and the entry loops
   * `attachEntity` over them; core stays free of construction (the same split
   * `restoreWorld` documents: restore replays, it does not create).
   */
  entities: Iterable<Entity>;
  /** Passed straight through to `restoreWorld` (`recomputeDerived` and any future knob). */
  restore?: RestoreOptions;
}

/**
 * assembleWorld — a snapshot back into a live, playable world in one call.
 * Runs the five-step checklist above; returns the bundle plus the scalars the
 * save carried.
 *
 * Every loud failure of the steps it wraps stays loud here: a corrupt save
 * throws (`restoreWorld`), a location that no longer resolves throws
 * (`attachEntity` — content drift fails loudly, no half-interpreted world).
 */
export function assembleWorld(options: AssembleWorldOptions): AssembledWorld {
  const { state, meta } = restoreWorld(options.snapshot, options.restore);
  const runtime = createWorldRuntime({
    registry: options.registry,
    state,
    nowTick: meta.nowTick,
  });
  const rng = createSeededRng(meta.rngState);
  options.bucket.restore(meta.due);
  for (const entity of options.entities) {
    runtime.attachEntity(entity);
  }
  return { runtime, rng, bucket: options.bucket, meta };
}

/**
 * collectMeta — the three world scalars, read off a LIVE bundle for
 * `serializeWorld(state, meta)` (D3). The save path's answer to the entry.
 *
 * It reads the bundle's current faces and never a remembered `meta`: a bundle
 * that has played since it was assembled reports what it is NOW (which is why
 * the parameter is the narrow `WorldBundle`, not the entry's return type).
 * The scalars land exactly where O9 put them — beside the tree — and the
 * write-side guard and canonical order stay `serializeWorld`'s business
 * (collection collects; the serializer decides the bytes).
 */
export function collectMeta(world: WorldBundle): WorldMeta {
  return {
    nowTick: world.runtime.clock.nowTick(),
    rngState: world.rng.getState(),
    due: world.bucket.snapshot(),
  };
}
