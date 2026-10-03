import type {
  Command,
  CommandResult,
  CustomEventDraft,
  EngineEvent,
  GameEvent,
  Rng,
} from "../types.js";
import type { ConditionSubject, PredicateRegistry } from "../conditions.js";
import { createSeededRng } from "../rng.js";
import { createTickClock } from "../clock.js";
import type { TickClock } from "../clock.js";
import { createDispatchDriver, settlementFirst } from "./driver.js";
import type { CommandSpec, Message } from "./pipeline.js";
import type { SettleRequest } from "../time/settle.js";
import type { DueBucket } from "../time/due.js";
import type { VerbTable } from "./parser.js";
import type { CmdSetSource } from "./cmdset.js";
import { verbTableFrom } from "./resolve.js";

/**
 * The command test harness (ADR-0023 §1). `call()` drives one command through
 * the dispatch driver — the ONE implementation of the driver-side four steps
 * (spec/04 §4.1, ADR-0038) — and shapes the harness's exit, so every command
 * gets at least one `call()` case asserting its output sequence.
 *
 * The injected dependencies: the tick clock (the engine's high-water mark,
 * which the harness owns between calls), output sink (collector), world
 * fixture (deep-copied per call), RNG seed — the one Evennia never had, its
 * dice rolls are unseeded — and an explicit receiver list.
 *
 * One assembly per harness (issue #36, spec/02 §3 + spec/04 §2.2): the
 * clock, the RNG stream, the advance hook and the verb table are assembled
 * ONCE, and `call` carries nothing but input — the session's streams (rng,
 * seq) live here, so a per-dispatch verb-source change must not restart
 * them.
 */

/**
 * A tick clock the test controls. It stands in for the host that *produces*
 * ticks plus the high-water mark the engine reads back (ADR-0031).
 *
 * ⚠️ `advance()` no longer means "advance the engine's now". The engine's now
 * IS the commands: `advance()` moves the tick the NEXT command will carry.
 */
export interface TestClock extends TickClock {
  /** The tick the next command will carry unless the call overrides it. */
  nextTick(): number;
  /** Moves that default tick forward (or back) by `ticks`. */
  advance(ticks: number): void;
}

export function createTestClock(startTick = 0): TestClock {
  const clock = createTickClock(startTick);
  let pending = startTick;
  return {
    nowTick: () => clock.nowTick(),
    observe(tick) {
      // Later default calls continue from the high-water mark, so an
      // explicitly backwards tick does not drag the following ones back.
      pending = clock.observe(tick);
      return pending;
    },
    nextTick: () => pending,
    advance(ticks) {
      pending += ticks;
    },
  };
}

/**
 * The input side of one command (issue #36): who typed what, and when. The
 * harness owns the `seq` counter — it is the session's, not the call's.
 */
export interface CommandInput {
  /** The raw line the player typed. */
  raw: string;
  /** Defaults to "actor-1". */
  actorId?: string;
  /**
   * The engine tick this command happens at (ADR-0031). Defaults to the
   * harness's next tick — move it with `harness.clock.advance()`.
   */
  tick?: number;
  /** Queued player inputs for interactive flows (ADR-0023 §1d). */
  inputs?: readonly string[];
}

export interface HarnessOptions<W> {
  /**
   * The world (spec/04 §2.2). Bare `W` is pure-object mode (default): deep-copied per call,
   * no transaction rollback — each call runs on a fresh fixture. `{ live: W }`
   * is live mode: passed by reference every call, so state a command mutates
   * (a move) is visible to the next call — how a host drives a world runtime
   * across a session. A runtime cannot be deep-copied at all (structuredClone
   * drops its hook-carrying entity instances), so runtime worlds always run
   * live. The wrapper is exactly one key, `live`.
   */
  world: W | { live: W };
  /**
   * Explicitly declared receivers (ADR-0023 §1f). Output to any other
   * recipient is discarded — omitting a receiver omits its checks.
   */
  receivers: readonly string[];
  /**
   * The verb table the engine's parse stage cuts against (spec/02 §3) — specs declaring
   * `argForm` match their input here, so `call()` runs the full chain — raw
   * input, verb cut, argForm parse, func. Three forms:
   *
   * - a pre-built {@link VerbTable} (build raw entries with `createVerbTable`,
   *   where a conflicting registration throws);
   * - cmdset sources ({@link CmdSetSource}), merged once per harness — a
   *   conflicting registration fails at harness creation, not mid-session;
   * - a RESOLVER over those sources, the per-dispatch form (issue #36): it is
   *   called once per `call()` with that call's world and actor — sources
   *   change with location — and its result is re-merged through
   *   `verbTableFrom` EVERY dispatch, never cached (#38: the source recipe
   *   stays with the caller, the merge never accumulates).
   */
  verbs?:
    | VerbTable
    | readonly CmdSetSource[]
    | ((ctx: { world: W; actorId: string }) => readonly CmdSetSource[]);
  /**
   * The session's streams and advance, assembled once (issue #36): the clock,
   * the RNG stream, the advance hook and the due bucket. All optional —
   * omitted, the harness starts its own clock at tick 0 and its own seeded
   * stream at seed 1.
   *
   * Pass a pre-built `clock` (and build a settler from it) to wire an advance
   * hook that reads the very clock the harness drives: clock first, settler
   * from it, hook as a plain function — the construction order needs no
   * delayed assignment.
   */
  session?: {
    clock?: TestClock;
    rng?: Rng;
    /**
     * The advance hook (spec/04 §4.3): when present, EVERY call settles the
     * world before the command runs — the harness is the side that drives the
     * world, so this is where the two-layer advance is driven from in tests.
     *
     * Because an `invalid` input must not advance the world, a harness with
     * this hook pre-flights the parse stage: an input that cannot become a
     * command returns `invalid` without ever calling the hook (and without
     * raising the high-water mark). A harness WITHOUT the hook skips the
     * pre-flight, because there is no world to protect.
     */
    settle?: (request: SettleRequest) => Message[];
    /**
     * The due bucket a called command may arm (spec/04 §4.5, §6 O8) — the
     * harness passes it straight through. Absent, a command that schedules
     * fails loudly instead of losing the item.
     */
    due?: DueBucket;
  };
  /**
   * Access gates (spec/02 §5): the condition subject builder for gated specs
   * and the predicate registry (defaults to the engine's built-ins). Required
   * subject only when a called spec declares an access gate — the world is
   * deep-copied per call (bare-world mode), so the subject is always derived
   * from that call's world.
   */
  access?: {
    subjectOf?: (world: W, actorId: string) => ConditionSubject;
    predicates?: PredicateRegistry;
  };
}

export interface CallOutcome {
  result: CommandResult;
  /**
   * Messages to declared receivers, in call order, for this call only.
   * Settlement messages come FIRST: the world reaches "now" before the
   * command happens (ADR-0034 §4).
   */
  messages: Message[];
}

export interface CommandHarness<W> {
  readonly clock: TestClock;
  /**
   * Drives one command — the spec under test plus its input and nothing else
   * (issue #36: the input descriptor is the whole call surface; a string is
   * the shorthand for `{ raw }`).
   */
  call(spec: CommandSpec<W>, input: string | CommandInput): CallOutcome;
}

/**
 * The `{ live: W }` wrapper is exactly one key; anything else is the bare
 * fixture. Checked structurally so a plain world never needs a tag.
 */
function liveWrapperOf<W>(world: W | { live: W }): { value: W; byRef: boolean } {
  if (
    typeof world === "object" &&
    world !== null &&
    Object.hasOwn(world, "live") &&
    Object.keys(world).length === 1
  ) {
    return { value: (world as { live: W }).live, byRef: true };
  }
  return { value: world as W, byRef: false };
}

/** The source list is the array form of the verb input; a table is not. */
function isCmdSetSources(
  source: VerbTable | readonly CmdSetSource[],
): source is readonly CmdSetSource[] {
  return Array.isArray(source);
}

/** The resolver form's per-dispatch table — re-merged every call, never cached. */
function resolvedTableOf<W>(
  source: HarnessOptions<W>["verbs"],
  ctx: { world: W; actorId: string },
): VerbTable | undefined {
  return typeof source === "function" ? verbTableFrom(source(ctx)) : undefined;
}

/**
 * The channels issue #36 retired. TypeScript's excess-property check only
 * guards OBJECT LITERALS — a stale key riding a wider variable would compile
 * and then be silently ignored, which is a wiring bug in disguise. So the
 * retired names fail loudly even when the type checker looked the other way.
 */
const RETIRED_OPTIONS = ["cmdsets", "liveWorld", "seed", "nowTick"] as const;

function assertNoRetiredOptions(options: object): void {
  for (const key of RETIRED_OPTIONS) {
    if (Object.hasOwn(options, key)) {
      throw new Error(
        `harness options: "${key}" was retired by issue #36 ` +
          `(world: { live: W } / session: { clock, rng } / verbs)`,
      );
    }
  }
}

export function createCommandHarness<W>(options: HarnessOptions<W>): CommandHarness<W> {
  assertNoRetiredOptions(options);
  // The high-water mark lives on the side that drives the world — here, the
  // harness (spec/04 §2.2). The pipeline stays a pure function of its inputs.
  const clock = options.session?.clock ?? createTestClock(0);
  const receiverSet = new Set(options.receivers);
  const { value: world, byRef: worldIsLive } = liveWrapperOf(options.world);
  // One RNG stream per harness: a session replays as a command sequence, so
  // identical inputs at different points must roll different values.
  const rng = options.session?.rng ?? createSeededRng(1);
  const source = options.verbs;
  // The static forms merge once here: a conflicting registration fails at
  // harness creation, not mid-session. The resolver form merges per dispatch
  // — that is its whole point.
  const staticTable: VerbTable | undefined =
    source === undefined || typeof source === "function"
      ? undefined
      : isCmdSetSources(source)
        ? verbTableFrom(source)
        : source;
  let nextSeq = 1;

  // One driver per harness (D5: one factory closure). The four steps and
  // their rules live THERE (spec/04 §4.1, ADR-0038); this file is the exit:
  // it decides who is a receiver and what the recorded output looks like.
  const driver = createDispatchDriver<W>({ clock, settle: options.session?.settle });

  return {
    clock,
    call(spec, input) {
      if (typeof input === "object" && Object.hasOwn(input, "seq")) {
        // Same species as the retired options: a non-literal descriptor can
        // carry a stale `seq` past the checker, and silently dropping it
        // would hide the migration. The harness owns the counter (issue #36).
        throw new Error(
          "harness call: seq is harness-owned (issue #36) — drop it from the input descriptor",
        );
      }
      const descriptor = typeof input === "string" ? { raw: input } : input;
      const command: Command = {
        seq: nextSeq++,
        actorId: descriptor.actorId ?? "actor-1",
        tick: descriptor.tick ?? clock.nextTick(),
        raw: descriptor.raw,
      };
      const messages: Message[] = [];
      const sink = {
        emit(message: Message) {
          if (receiverSet.has(message.to)) {
            messages.push(message);
          }
        },
      };
      const callWorld = worldIsLive ? world : structuredClone(world);
      const deps = {
        rng,
        world: callWorld,
        sink,
        inputs: [...(descriptor.inputs ?? [])],
        verbs: staticTable ?? resolvedTableOf(source, { world: callWorld, actorId: command.actorId }),
        subjectOf: options.access?.subjectOf,
        predicates: options.access?.predicates,
        due: options.session?.due,
      };
      const { result, settled } = driver.dispatch(command, spec, deps);
      // The harness's exit (AC4): settlement messages to declared receivers
      // ride BEFORE the command's own sink messages — the player reads "what
      // happened while you were away" first. The result's events are already
      // ordered by the driver.
      return {
        result,
        messages: settlementFirst(
          settled.filter((message) => receiverSet.has(message.to)),
          messages,
        ),
      };
    },
  };
}

/**
 * True when every field of `expected` equals the matching field of `actual`,
 * recursing into objects and arrays. The event analogue of Evennia's prefix
 * matching (ADR-0023 §1b): expected messages pin only the fields the test
 * cares about, so semantic extra fields (a damage roll, a tier) don't make
 * tests brittle.
 */
function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (typeof expected !== "object" || expected === null) {
    return expected === actual;
  }
  if (typeof actual !== "object" || actual === null) {
    return false;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((element, index) => matchesSubset(element, actual[index]))
    );
  }
  return Object.keys(expected).every((key) =>
    matchesSubset(
      (expected as Record<string, unknown>)[key],
      (actual as Record<string, unknown>)[key],
    ),
  );
}

/**
 * The recursive subset an expectation may pin (ADR-0023 §1b): every level —
 * an arm field, a digest entry — names only what the test cares about. The
 * type twin of `matchesSubset` below; a shallow `Partial` would force tests
 * to pin nested digests in full, which is a different assertion than the one
 * the matcher runs.
 *
 * Two known departures from the matcher, both LOUD (they throw, never pass
 * silently): arrays — the type allows any length, the matcher demands equal
 * length element-wise; and an explicitly-`undefined` value key — the type
 * allows it, the matcher's `undefined === undefined` semantics read it as
 * "must be absent". The twin is the subset SPIRIT, not a proof.
 */
export type EventSubset<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly EventSubset<Item>[]
    : { [K in keyof T]?: EventSubset<T[K]> };

/**
 * Prefix-matching expectation (ADR-0023 §1b): pin only the fields the test
 * cares about — extra semantic fields on the recorded message are tolerated.
 *
 * An engine-event expectation is a recursive subset of its arm (fields are
 * therefore spell-checked); a synthetic/host expectation goes through
 * `customEvent()`, which is branded so `Partial` cannot swallow the brand and
 * let any literal claim to be the extension arm.
 */
export type ExpectedEvent = EventSubset<EngineEvent> | CustomEventDraft;

export interface ExpectedMessage {
  to?: string;
  event?: ExpectedEvent;
}

/**
 * Asserts a recorded message sequence (ADR-0023 §1b + §1e): ordered
 * subset-match per message AND equal counts — prefix matching alone would
 * let an extra wrong message slip through silently.
 *
 * Deliberately framework-free (plain throws), so content packs can use it
 * under any test runner.
 */
export function expectMessageSequence(
  actual: readonly Message[],
  expected: ReadonlyArray<ExpectedMessage>,
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `expected ${expected.length} message(s) but recorded ${actual.length}`,
    );
  }
  for (const [index, expectedMessage] of expected.entries()) {
    const recorded = actual[index];
    if (recorded === undefined || !matchesSubset(expectedMessage, recorded)) {
      throw new Error(
        `message ${index} does not match the expected subset:\n` +
          `  expected: ${JSON.stringify(expectedMessage)}\n` +
          `  recorded: ${recorded === undefined ? "nothing" : JSON.stringify(recorded)}`,
      );
    }
  }
}
