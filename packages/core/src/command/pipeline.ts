import type { Clock, Command, CommandResult, GameEvent, Rng } from "../types.js";
import { parseArgForm } from "./parser.js";
import type { ArgForm, VerbTable } from "./parser.js";

/**
 * The command pipeline (ADR-0023 §1a): four stages, run in order.
 *
 *   at_pre_cmd → parse → func → at_post_cmd
 *
 * The test harness drives these stages manually — it does NOT go through the
 * real dispatcher — so parsing and execution can be tested separately, or one
 * stage at a time. This module is that stage runner.
 */

/** One output call: a semantic event addressed to exactly one recipient. */
export interface Message {
  to: string;
  event: GameEvent;
}

/**
 * Collects emitted messages. The engine defines the sink shape; hosts and the
 * test harness provide the implementation (ADR-0023 §1c: the output sink is
 * an injected dependency, never a real terminal).
 */
export interface MessageSink {
  emit(message: Message): void;
}

/**
 * An event before the pipeline stamps it: the caller supplies the semantic
 * fields, the pipeline stamps seq and actorId (spec/01 §2.2, §5). Any extra
 * fields pass through untouched; a draft's own seq/actorId (if any) are
 * overwritten by the stamps.
 */
export interface EventDraft {
  type: string;
  [key: string]: unknown;
}

/**
 * What a command executes against. Everything nondeterministic is injected
 * (ADR-0023 §1c): clock, rng, world snapshot, and the output sink behind
 * emit(). `args` is set after the parse stage succeeds; earlier stages see
 * undefined.
 */
export interface CommandContext<W = unknown> {
  readonly command: Command;
  args: unknown;
  readonly world: W;
  readonly clock: Clock;
  readonly rng: Rng;
  emit(recipientId: string, event: EventDraft): void;
  /**
   * Vetoes the command from a pre-stage hook and returns `false` (so the
   * hook can return it directly). Records the refusal reason; the pipeline
   * emits the refusal event, not the hook.
   */
  veto(reason?: string): false;
  /**
   * Takes the next queued player input, FIFO (ADR-0023 §1d). Returns null
   * when the queue is empty. Evennia pops its input queue from the tail,
   * reversing the order — we consume from the head.
   */
  takeInput(): string | null;
}

/** Outcome of the parse stage. `ok: false` maps to the `invalid` failure. */
export type ParseOutcome = { ok: true; args: unknown } | { ok: false; reason: string };

/**
 * A command as executable behaviour. Verbs live in content data, not here —
 * a spec is identified by `key`; input is matched to specs by longest verb
 * match against the verb table (see parser.ts).
 */
export interface CommandSpec<W = unknown> {
  key: string;
  /**
   * Declarative argument form (spec/02 §1.2): the engine's parse stage cuts
   * the verb (via deps.verbs) and parses the remainder per this form. An
   * explicit `parse` hook, when present, takes precedence.
   */
  argForm?: ArgForm;
  /** Return explicitly `false` to veto (spec/03 §7: falsy aborts). */
  at_pre_cmd?(ctx: CommandContext<W>): boolean | void;
  /**
   * Parses input into args. Receives the FULL raw input, verb included —
   * unlike the argForm path, which gets the post-verb remainder — so a
   * custom hook cuts the verb itself. Absent means the engine parses
   * instead: argForm + deps.verbs when declared, otherwise the whole input
   * is the args (the pre-parser default kept for stage-by-stage tests).
   */
  parse?(ctx: CommandContext<W>, rawInput: string): ParseOutcome;
  func(ctx: CommandContext<W>): void;
  at_post_cmd?(ctx: CommandContext<W>): void;
}

/** The four injected dependencies a command run needs. */
export interface CommandDeps<W = unknown> {
  clock: Clock;
  rng: Rng;
  world: W;
  sink: MessageSink;
  /** Queued player inputs for interactive commands, consumed FIFO. */
  inputs?: string[];
  /**
   * The verbs available for this dispatch (the cmdset merge result). Required
   * when a spec declares `argForm` — the parse stage cuts the verb with it.
   */
  verbs?: VerbTable;
}

/**
 * Reason code stamped when a hook vetoes without naming a reason. A semantic
 * code, not rendered text: the rendering layer maps codes to content-side
 * copy (spec/02 §5.4 — refusal wording is data).
 */
const DEFAULT_VETO_REASON = "vetoed";

/**
 * The parse stage (spec/02 §1): an explicit hook wins; otherwise the engine
 * parses — verb cut via the verb table, remainder per the declared argForm —
 * and the pre-parser default (whole input is the args) survives for
 * stage-by-stage tests that predate argForm.
 *
 * The verb is re-cut inside the stage even though the dispatcher already
 * matched it to pick this spec: the same deterministic table yields the same
 * result, and the commandKey guard turns a stale or mismatched dispatch into
 * an `invalid` result instead of silently running the wrong command.
 */
function parseStage<W>(
  spec: CommandSpec<W>,
  command: Command,
  deps: CommandDeps<W>,
  ctx: CommandContext<W>,
): ParseOutcome {
  if (spec.parse) {
    return spec.parse(ctx, command.raw);
  }
  if (spec.argForm === undefined) {
    return { ok: true, args: command.raw };
  }
  if (!deps.verbs) {
    // Wiring bug, not player input: a declared argForm is unusable without
    // the verb table, so this fails loudly instead of masquerading as
    // malformed input.
    throw new Error(
      `command "${spec.key}" declares argForm "${spec.argForm}" but no verb table was provided (deps.verbs)`,
    );
  }
  const match = deps.verbs.match(command.raw);
  if (!match.ok) {
    return { ok: false, reason: match.reason };
  }
  if (match.commandKey !== spec.key) {
    return { ok: false, reason: "verbMismatch" };
  }
  return parseArgForm(spec.argForm, match.rawArgs);
}

/**
 * Runs the four stages and returns the dispatch result.
 *
 * Failure semantics (spec/01 §4): a vetoed pre-stage returns `rejected` and
 * DOES consume the seq — the refusal is returned to the player as an event,
 * because it is game content rather than an error. A failed parse returns
 * `invalid` and consumes nothing. `transport` is never produced here: it
 * describes delivery failure below the engine boundary.
 */
export function runCommand<W>(spec: CommandSpec<W>, command: Command, deps: CommandDeps<W>): CommandResult {
  const events: GameEvent[] = [];
  let vetoReason: string | undefined;

  const ctx: CommandContext<W> = {
    command,
    args: undefined,
    world: deps.world,
    clock: deps.clock,
    rng: deps.rng,
    emit(recipientId, draft) {
      const event: GameEvent = { ...draft, seq: command.seq, actorId: command.actorId };
      events.push(event);
      deps.sink.emit({ to: recipientId, event });
    },
    veto(reason) {
      vetoReason = reason ?? DEFAULT_VETO_REASON;
      return false;
    },
    takeInput() {
      return deps.inputs?.shift() ?? null;
    },
  };

  if (spec.at_pre_cmd) {
    const pre = spec.at_pre_cmd(ctx);
    // spec/03 §7: a pre hook vetoes by returning an explicitly falsy value.
    // A void return (side-effect-only hook) proceeds — unlike Evennia, where
    // a truthy return silently skips the whole command with no feedback
    // (ADR-0024 §3). Our veto is an explicit rejected result plus a refusal
    // event back to the player.
    if (pre === false || vetoReason !== undefined) {
      const reason = vetoReason ?? DEFAULT_VETO_REASON;
      ctx.emit(command.actorId, { type: "commandRefused", reason });
      return { ok: false, seq: command.seq, kind: "rejected", reason };
    }
  }

  const outcome = parseStage(spec, command, deps, ctx);
  if (!outcome.ok) {
    return { ok: false, seq: command.seq, kind: "invalid", reason: outcome.reason };
  }
  ctx.args = outcome.args;

  spec.func(ctx);

  if (spec.at_post_cmd) {
    spec.at_post_cmd(ctx);
  }

  return { ok: true, seq: command.seq, events };
}
