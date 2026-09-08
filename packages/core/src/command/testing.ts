import type { Command, CommandResult, GameEvent } from "../types.js";
import type { ConditionSubject, PredicateRegistry } from "../conditions.js";
import { createSeededRng } from "../rng.js";
import { createTickClock, observeDispatch } from "../clock.js";
import type { TickClock } from "../clock.js";
import { runCommand } from "./pipeline.js";
import type { CommandSpec, Message } from "./pipeline.js";
import { createVerbTable } from "./parser.js";
import type { VerbEntry } from "./parser.js";
import { mergeCmdSets } from "./cmdset.js";
import type { CmdSetSource } from "./cmdset.js";

/**
 * The command test harness (ADR-0023 §1). `call()` manually drives the four
 * stages and returns the recorded output, so every command gets at least one
 * `call()` case asserting its output sequence.
 *
 * The injected dependencies: the tick clock (the engine's high-water mark,
 * which the harness owns between calls), output sink (collector), world
 * fixture (deep-copied per call), RNG seed — the one Evennia never had, its
 * dice rolls are unseeded — and an explicit receiver list.
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

export interface HarnessOptions<W> {
  /**
   * The world. Pure-object mode (default): deep-copied per call, no
   * transaction rollback — each call runs on a fresh fixture. Live mode
   * (`liveWorld: true`): passed by reference every call, so state a command
   * mutates (a move) is visible to the next call — how a host drives a
   * world runtime across a session. A runtime cannot be deep-copied at all
   * (structuredClone drops its hook-carrying entity instances), so runtime
   * worlds always run live.
   */
  world: W;
  /**
   * Explicitly declared receivers (ADR-0023 §1f). Output to any other
   * recipient is discarded — omitting a receiver omits its checks.
   */
  receivers: string[];
  /** RNG seed. Fixed default so every harness is reproducible. */
  seed?: number;
  /**
   * Starting engine tick: the initial high-water mark and the tick the first
   * command carries (spec/04 §2.2). The harness owns it from then on.
   */
  nowTick?: number;
  /**
   * Verb entries for the engine's parse stage: specs declaring `argForm`
   * match their input against this table, so `call()` runs the full chain —
   * raw input, verb cut, argForm parse, func. Built once per harness, so a
   * conflicting registration fails at harness creation, not mid-session.
   */
  verbs?: readonly VerbEntry[];
  /**
   * Command-set sources (spec/02 §3) merged into the parse-stage verb
   * table — the merge product IS the verb table source. Mutually exclusive
   * with `verbs`. Merged once per harness (static like `verbs`); hosts that
   * merge per input, because sources change with location, call
   * mergeCmdSets themselves and pass deps.verbs per dispatch.
   */
  cmdsets?: readonly CmdSetSource[];
  /**
   * Builds the condition subject for access-gated specs (spec/02 §5); passed
   * through to the pipeline deps. Required only when a called spec declares
   * an access gate — the world is deep-copied per call, so the subject is
   * always derived from that call's world.
   */
  subjectOf?: (world: W, actorId: string) => ConditionSubject;
  /** Predicate registry for access gates; defaults to the engine's built-ins. */
  predicates?: PredicateRegistry;
  /** Live-world mode: share the world by reference across calls. Default false. */
  liveWorld?: boolean;
}

export interface CallOptions {
  /** Defaults to a harness-local counter starting at 1. */
  seq?: number;
  /** Defaults to "actor-1". */
  actorId?: string;
  /**
   * The engine tick this command happens at (ADR-0031). Defaults to the
   * harness's next tick — move it with `harness.clock.advance()`.
   */
  tick?: number;
  /** Queued player inputs for interactive flows (ADR-0023 §1d). */
  inputs?: string[];
}

export interface CallOutcome {
  result: CommandResult;
  /** Messages to declared receivers, in call order, for this call only. */
  messages: Message[];
}

export interface CommandHarness<W> {
  readonly clock: TestClock;
  call(spec: CommandSpec<W>, input: string, options?: CallOptions): CallOutcome;
}

export function createCommandHarness<W>(options: HarnessOptions<W>): CommandHarness<W> {
  // The high-water mark lives on the side that drives the world — here, the
  // harness (spec/04 §2.2). runCommand stays a pure function of its inputs.
  const clock = createTestClock(options.nowTick ?? 0);
  const receiverSet = new Set(options.receivers);
  // One RNG stream per harness: a session replays as a command sequence, so
  // identical inputs at different points must roll different values.
  const rng = createSeededRng(options.seed ?? 1);
  if (options.verbs !== undefined && options.cmdsets !== undefined) {
    // Wiring bug, not a data problem: two verb-table sources disagree about
    // which table a call parses against.
    throw new Error("harness options: pass either verbs or cmdsets, not both");
  }
  const verbs = options.verbs
    ? createVerbTable(options.verbs)
    : options.cmdsets
      ? createVerbTable(mergeCmdSets(options.cmdsets).verbEntries())
      : undefined;
  let nextSeq = 1;

  return {
    clock,
    call(spec, input, callOptions = {}) {
      const command: Command = {
        seq: callOptions.seq ?? nextSeq++,
        actorId: callOptions.actorId ?? "actor-1",
        tick: callOptions.tick ?? clock.nextTick(),
        raw: input,
      };
      const messages: Message[] = [];
      const sink = {
        emit(message: Message) {
          if (receiverSet.has(message.to)) {
            messages.push(message);
          }
        },
      };
      const result = runCommand(spec, command, {
        nowTick: clock.nowTick(),
        rng,
        world: options.liveWorld ? options.world : structuredClone(options.world),
        sink,
        inputs: [...(callOptions.inputs ?? [])],
        verbs,
        subjectOf: options.subjectOf,
        predicates: options.predicates,
      });
      // Only a command that reached the execution stage moves the world
      // (spec/04 §4.1): an invalid input must not fast-forward it.
      observeDispatch(clock, command, result);
      return { result, messages };
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
 * Prefix-matching expectation (ADR-0023 §1b): pin only the fields the test
 * cares about — extra semantic fields on the recorded message are tolerated.
 */
export interface ExpectedMessage {
  to?: string;
  event?: Partial<GameEvent>;
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
