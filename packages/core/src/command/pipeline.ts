import type { Clock, Command, CommandResult, GameEvent, Rng } from "../types.js";
import { checkAccess, defaultPredicateRegistry } from "../conditions.js";
import type { AccessGate, ConditionSubject, PredicateRegistry } from "../conditions.js";
import { parseArgForm } from "./parser.js";
import type { ArgForm, VerbTable } from "./parser.js";
/**
 * The command pipeline (ADR-0023 §1a): four stages, run in order.
 *
 *   at_pre_cmd → parse → func → at_post_cmd
 *
 * A spec-declared access gate (spec/02 §5) runs before them all — availability
 * ("may this actor use this command at all") precedes contextual vetoing.
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
  /**
   * The predicate registry condition evaluation resolves through — the
   * access gate here, and any gate an execution stage checks itself (the
   * engine's traversal adapter asks the target room's enter gate with it,
   * so host-extended predicates apply uniformly). Defaults to the engine's
   * built-ins.
   */
  readonly predicates: PredicateRegistry;
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
 * The execution stage's refusal: a legitimate mid-execution failure — a
 * gate beyond the entry's own (the target room's enter gate, the look
 * behaviour's visibility gate), a movement hook veto, a missing target.
 * Same class as an access denial (spec/01 §4): `rejected`, the seq IS
 * consumed, and the refusal is game content.
 *
 * The refusing func HAS ALREADY emitted its refusal event(s) with full
 * semantics — the executor owns the context (commandKey, errKey, ids) and
 * the pipeline does not word a second, generic one. This differs from
 * at_pre_cmd vetoes deliberately: pre-stage hooks are policy checks
 * without execution context, so the pipeline words those; an executor
 * that just checked a gate knows exactly which entry's copy to name.
 */
export type CommandRejection = { kind: "rejected"; reason: string };

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
  /**
   * Access gate (spec/02 §5): checked before at_pre_cmd. A denial is a
   * `rejected` result whose commandRefused event carries the semantics that
   * LOCATE the entry's err_* copy (commandKey, accessType, errKey) — the
   * engine never words refusals (spec/02 §5.4, spec/01 §5.1).
   */
  access?: AccessGate;
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
  /**
   * The execution stage. Returns void when the command ran, or a
   * {@link CommandRejection} when it legitimately refused mid-execution —
   * the refusal is then a rejected result and at_post_cmd does not run.
   * On rejection the func has already emitted its refusal event(s); see
   * {@link CommandRejection}.
   */
  func(ctx: CommandContext<W>): void | CommandRejection;
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
  /**
   * Builds the condition subject for access gates from the world and the
   * acting entity. Required when a spec declares an access gate: the engine
   * has no entity model, so it cannot guess this mapping.
   */
  subjectOf?: (world: W, actorId: string) => ConditionSubject;
  /** Predicate registry for access gates; defaults to the engine's built-ins. */
  predicates?: PredicateRegistry;
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
    predicates: deps.predicates ?? defaultPredicateRegistry,
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

  if (spec.access) {
    if (!deps.subjectOf) {
      // Wiring bug, not player input: a declared gate is unevaluable without
      // a subject, so this fails loudly instead of silently granting access.
      throw new Error(
        `command "${spec.key}" declares an access gate but no subject provider was given (deps.subjectOf)`,
      );
    }
    const check = checkAccess(
      spec.access.rules,
      spec.access.accessType,
      deps.subjectOf(deps.world, command.actorId),
      deps.predicates ?? defaultPredicateRegistry,
    );
    if (!check.ok) {
      // Semantic only: commandKey + errKey locate the entry's err_* copy; the
      // renderer reads the text from data — refusal is narrative, and the
      // data words it (spec/02 §5.4).
      ctx.emit(command.actorId, {
        type: "commandRefused",
        reason: "accessDenied",
        commandKey: spec.key,
        accessType: check.accessType,
        errKey: check.errKey,
      });
      return { ok: false, seq: command.seq, kind: "rejected", reason: "accessDenied" };
    }
  }

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

  const rejection = spec.func(ctx);
  if (rejection !== undefined) {
    // The execution stage refused and has already worded its refusal as
    // semantic events; the pipeline carries the failure class only. Like
    // every rejected result, the seq is consumed (spec/01 §4).
    return { ok: false, seq: command.seq, ...rejection };
  }

  if (spec.at_post_cmd) {
    spec.at_post_cmd(ctx);
  }

  return { ok: true, seq: command.seq, events };
}
