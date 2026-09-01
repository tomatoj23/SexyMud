import type { Clock, Command, CommandResult, GameEvent, Rng } from "../types.js";

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
 * a spec is identified by `key`; how input is matched to specs (longest verb
 * match) arrives with the parser and the content registry.
 */
export interface CommandSpec<W = unknown> {
  key: string;
  /** Return explicitly `false` to veto (spec/03 §7: falsy aborts). */
  at_pre_cmd?(ctx: CommandContext<W>): boolean | void;
  /**
   * Parses the raw input into args. Absent means "whole input is the args"
   * — the real verb-matching parser replaces this default.
   */
  parse?(ctx: CommandContext<W>, rawArgs: string): ParseOutcome;
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
}

/**
 * Reason code stamped when a hook vetoes without naming a reason. A semantic
 * code, not rendered text: the rendering layer maps codes to content-side
 * copy (spec/02 §5.4 — refusal wording is data).
 */
const DEFAULT_VETO_REASON = "vetoed";

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

  const outcome = spec.parse ? spec.parse(ctx, command.raw) : { ok: true as const, args: command.raw };
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
