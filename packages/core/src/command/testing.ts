import type { Command, CommandResult, GameEvent } from "../types.js";
import { createSeededRng } from "../rng.js";
import { runCommand } from "./pipeline.js";
import type { CommandSpec, Message } from "./pipeline.js";
import { createVerbTable } from "./parser.js";
import type { VerbEntry } from "./parser.js";

/**
 * The command test harness (ADR-0023 §1). `call()` manually drives the four
 * stages and returns the recorded output, so every command gets at least one
 * `call()` case asserting its output sequence.
 *
 * The five injected dependencies: clock (tick counter), output sink
 * (collector), world fixture (deep-copied per call), RNG seed — the one
 * Evennia never had, its dice rolls are unseeded — and an explicit receiver
 * list.
 */

/** A clock the test controls: fixed until advanced. */
export interface TestClock {
  nowTick(): number;
  advance(ticks: number): void;
}

export function createTestClock(startTick = 0): TestClock {
  let tick = startTick;
  return {
    nowTick: () => tick,
    advance(ticks) {
      tick += ticks;
    },
  };
}

export interface HarnessOptions<W> {
  /** Pure-object world snapshot; deep-copied per call (no transaction rollback). */
  world: W;
  /**
   * Explicitly declared receivers (ADR-0023 §1f). Output to any other
   * recipient is discarded — omitting a receiver omits its checks.
   */
  receivers: string[];
  /** RNG seed. Fixed default so every harness is reproducible. */
  seed?: number;
  /** Starting engine tick. */
  nowTick?: number;
  /**
   * Verb entries for the engine's parse stage: specs declaring `argForm`
   * match their input against this table, so `call()` runs the full chain —
   * raw input, verb cut, argForm parse, func. Built once per harness, so a
   * conflicting registration fails at harness creation, not mid-session.
   */
  verbs?: readonly VerbEntry[];
}

export interface CallOptions {
  /** Defaults to a harness-local counter starting at 1. */
  seq?: number;
  /** Defaults to "actor-1". */
  actorId?: string;
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
  const clock = createTestClock(options.nowTick ?? 0);
  const receiverSet = new Set(options.receivers);
  // One RNG stream per harness: a session replays as a command sequence, so
  // identical inputs at different points must roll different values.
  const rng = createSeededRng(options.seed ?? 1);
  const verbs = options.verbs ? createVerbTable(options.verbs) : undefined;
  let nextSeq = 1;

  return {
    clock,
    call(spec, input, callOptions = {}) {
      const command: Command = {
        seq: callOptions.seq ?? nextSeq++,
        actorId: callOptions.actorId ?? "actor-1",
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
        clock,
        rng,
        world: structuredClone(options.world),
        sink,
        inputs: [...(callOptions.inputs ?? [])],
        verbs,
      });
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
