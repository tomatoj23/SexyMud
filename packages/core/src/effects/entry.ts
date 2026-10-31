import type { EntryCommon } from "../content/entry.js";

/**
 * An effect entry as CONTENT (spec/06, #56): a named combination of
 * primitives — the ONE vocabulary martial arts, monsters and commands
 * reference (`effects: ["eff-…"]`), never copies of numbers. The engine
 * knows this SHAPE and the primitive TYPE IDS it ships implementations for;
 * it never hardcodes the type enum (ADR-0004's extension room — the schema
 * writes no closed list either).
 *
 * Three-way sync (spec/06 §4): this type mirrors schemas/effects.schema.json
 * field-for-field, and docs/agents/content.md documents the field contract.
 * The schema's tick-named duration fields are the #56 rename
 * (durationMs→durationTicks, tickMs→tickIntervalTicks, cooldownMs→
 * cooldownTicks) — the millisecond-era names conflicted with the tick time
 * model (ADR-0031/0032), and content/effects/ being empty was the one
 * zero-cost opening for it.
 */
export interface EffectEntry extends EntryCommon {
  /** Content id, immutable once released; the file name is the id. */
  readonly id: string;
  /**
   * The primitive combination (at least one). Execution walks them in order;
   * each primitive's TYPE names the engine implementation to run (see
   * effects/registry.ts), the rest of its fields are that implementation's
   * parameters.
   */
  readonly primitives: readonly EffectPrimitive[];
  /** Narrative text, style-guide bound; the UI consumes it, the engine never reads it. */
  readonly description?: string;
}

/**
 * One primitive of an effect entry: a `type` plus that type's parameters.
 * Deliberately OPEN beyond the fields the shipped implementations read —
 * `maxPulses` and friends are declared in the schema, and a future primitive
 * type brings its own parameters without a type change here (the registry
 * looks implementations up by id, the shape never enumerates them).
 */
export interface EffectPrimitive {
  /** The primitive type id — the key the engine's registry resolves. */
  readonly type: string;
  /** The target-selection mode (single/all/adjacent/…); the engine treats it as data. */
  readonly targetSelector?: string;
  /** One-shot damage: the entry TRIGGERS the strike settlement (T11①(a)); this static number is unused in C1. For damage-over-time it is the per-pulse damage, frozen into the instance ledger at application (T11②). */
  readonly amount?: number;
  /** Pulses between applications of a damage-over-time primitive. */
  readonly tickIntervalTicks?: number;
  /** The semantic pulse ceiling of a damage-over-time primitive (not a performance guard, spec/04 §4.2). */
  readonly maxPulses?: number;
  /** Probability of the primitive applying, 0..1. */
  readonly chance?: number;
  readonly [key: string]: unknown;
}
