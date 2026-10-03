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
 *   → createSeededRng(meta.rngState) → attachEntity × N → bucket.restore(meta.due)
 *
 * — and until this module the checklist lived only in prose and in tests that
 * assembled it by hand (two of them, in two different orders). A hand
 * checklist can forget a step, and a forgotten step fails SILENTLY: miss
 * `bucket.restore` and the armed bomb simply vanishes; miss `attachEntity` and
 * the world plays until someone asks for a hook. So the checklist becomes one
 * entry, and forgetting a step becomes structurally impossible (D1 — the same
 * bargain as the dispatch driver (#35): a convention becomes structure). The
 * ×N is guarded the same way: every entity the restore brought back must come
 * with its instance, or the entry refuses — a half-rebuilt world is one that
 * plays until someone asks THAT entity for a hook.
 *
 * ⚠️ What this deliberately does NOT do is pin an ORDER. The data dependencies
 * force almost all of it (`restoreWorld` must precede `attachEntity`; the
 * runtime eats its output) and the one choice they leave free — which entity
 * attaches first — was never a fact worth asserting (a carried entity may be
 * attached before its carrier; `attachEntity`'s location check is
 * order-independent on purpose). The order is this module's implementation
 * detail; the COMPLETENESS is the contract. The ONE thing the sequence is
 * chosen for is the failure path: `bucket.restore` runs LAST, so a load that
 * throws mid-way never touches the host's live fuses — the bucket is the only
 * caller-owned mutable piece here, and it changes only on success (spec/04
 * §1.4: loud failure, no half-interpreted state).
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
   * `restoreWorld` documents: restore replays, it does not create). The entry
   * CHECKS the count: a restored entity with no instance is refused here, not
   * at its first hook call (a partial world assembles by hand — the primitives
   * stay legal).
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
 * throws (`restoreWorld`), a malformed due item throws (`bucket.restore`), a
 * location that no longer resolves or a missing instance throws
 * (`attachEntity` / the count check — content drift fails loudly, no
 * half-interpreted world). Whatever fails, the caller's own pieces come back
 * untouched: the live bucket is restored LAST, so a load that died never
 * disarmed the host's fuses.
 */
export function assembleWorld(options: AssembleWorldOptions): AssembledWorld {
  const { state, meta } = restoreWorld(options.snapshot, options.restore);
  const runtime = createWorldRuntime({
    registry: options.registry,
    state,
    nowTick: meta.nowTick,
  });
  const rng = createSeededRng(meta.rngState);
  const attached = new Set<string>();
  for (const entity of options.entities) {
    runtime.attachEntity(entity);
    attached.add(entity.id);
  }
  // The ×N is counted, not just looped: a restored entity whose instance the
  // host forgot to rebuild would play until someone asks IT for a hook — the
  // silent death the checklist exists to prevent (D1). The hand path stays
  // free to attach any subset; only this entry is whole.
  const missing = Object.keys(state.entities).filter((id) => !attached.has(id));
  if (missing.length > 0) {
    throw new Error(
      `assemble world: restored entities with no hook instance: ${missing.join(", ")} — rebuild every entity before assembling (a partial world assembles by hand)`,
    );
  }
  // LAST, and on purpose: `bucket.restore` replaces the pending set, and this
  // bucket is the one caller-owned mutable piece. It changes only once the
  // whole world is together — a load that died above left the host's fuses
  // armed (spec/04 §1.4: loud failure, no half-interpreted state).
  options.bucket.restore(meta.due);
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
