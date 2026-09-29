import type { Command, CommandResult } from "../types.js";
import type { TickClock } from "../clock.js";
import { observeDispatch } from "../clock.js";
import { effectiveNowTick, parseCommand, runCommand } from "./pipeline.js";
import type { CommandDeps, CommandSpec, Message } from "./pipeline.js";
import type { SettleRequest } from "../time/settle.js";

/**
 * The dispatch driver (spec/04 §4.1): THE one implementation of the
 * driver-side fixed four steps and the rules that come with them.
 *
 * Before this module the sequence was hand-copied in two places — the test
 * harness (`command/testing.ts`) and the host `Authority`
 * (`apps/web/src/game/localAuthority.ts`) — and O10's failure mode was built
 * into that arrangement: a copy that forgets one step freezes the world
 * SILENTLY (every time judgement stays self-consistent, the world just never
 * moves). Both callers are now thin adapters over this factory; the order and
 * the rules exist once, so "forgot the fourth step" cannot be typed.
 *
 * The sequence, for one command:
 *
 *   1. PRE-FLIGHT — `parseCommand`, only the parse stage. An input that
 *      cannot become a command answers `invalid` here: no advance, no mark
 *      move, nothing else runs.
 *   2. ADVANCE — `settle({ toTick, seq, actorId })`: the world reaches "now"
 *      before the command happens (spec/04 §4.3).
 *   3. DISPATCH — `runCommand`.
 *   4. OBSERVE — `observeDispatch` feeds the outcome back to the clock.
 *
 * The three rules, each with one home here:
 *
 *   - **Pre-flight iff there is an advance to protect.** No settle hook ⇒ no
 *     pre-flight, and the run's own parse answers ("no hook, no world to
 *     protect"). The quirk this preserves is real and deliberate: without the
 *     pre-flight, a broken input still runs the earlier pre-stages.
 *   - **`invalid` neither advances nor raises the mark.** On the pre-flight
 *     path nothing ran at all; on the no-hook path the observe step's
 *     whitelist is the guard (spec/04 §4.1's table).
 *   - **Settlement rides before the command's own output.** The advance runs
 *     before the dispatch, and every output channel composes through ONE
 *     ordering helper ({@link settlementFirst}) — "what happened while you
 *     were away" reads before "you go north" (ADR-0034 §4), and no exit gets
 *     to decide who comes first on its own.
 *
 * The mark's "now" reading (`deps.nowTick`) also lives only here: adapters
 * hand in deps WITHOUT it (the `Omit` below), so there is no second `max` to
 * drift from {@link effectiveNowTick}.
 *
 * The EXIT is the adapter's business and stays there: filtering settlement
 * messages by receiver and merging a message stream (the harness) versus
 * delivering one batch per consumed seq (the host `Authority`) are genuinely
 * different shapes. This factory returns the raw pieces — `result` plus the
 * raw settlement `Message`s — and never routes anything.
 */

/** What a driver is assembled from, once (D5: one factory closure). */
export interface DispatchDriverOptions<W> {
  /**
   * The driver-side high-water mark — the harness's `TestClock`, or the host
   * runtime's `clock`. The ONE "now" the sequence reads and raises.
   */
  clock: TickClock;
  /**
   * The advance hook (spec/04 §4.3): settles the world up to a tick and
   * returns the settlement messages. Absent means no-advance — the pre-flight
   * is then skipped too, because its only job is protecting this call.
   */
  settle?: (request: SettleRequest) => Message[];
}

/**
 * The outcome of one dispatch: the pipeline's result plus the raw settlement
 * messages of the advance that preceded it (empty when nothing advanced).
 */
export interface DispatchOutcome {
  result: CommandResult;
  settled: Message[];
}

/** A beat: advance without a command (ADR-0034 §5). */
export interface HeartbeatRequest {
  /** Where the world's "now" is now — supplied by the adapter from its clock. */
  toTick: number;
  /**
   * The caller's explicit seq, in the commands' own monotonic space — a beat
   * is not a forged system command and there is no second seq space.
   */
  seq: number;
}

/**
 * Rule 3 of the four-step sequence (spec/04 §4.1): settlement output ranks
 * BEFORE the command's own — the player reads "what happened while you were
 * away" first (ADR-0034 §4). Every output channel composes through THIS
 * function, so the ranking has exactly one home: the exits decide WHAT to
 * compose (receiver filtering, sink capture, batch shape — AC4, each exit
 * keeps its own) but never WHO comes first. A hand-rolled `[own, settled]`
 * concat in an adapter would re-implement the rule and invert it silently.
 */
export function settlementFirst<T>(
  settled: readonly T[],
  own: readonly T[],
): T[] {
  return [...settled, ...own];
}

export interface DispatchDriver<W> {
  /**
   * Runs the four steps for one command. `deps` carries everything the
   * pipeline needs EXCEPT `nowTick` — the driver reads that from its own
   * clock, so the effective "now" (`max(mark, command.tick)`) has exactly one
   * computation.
   */
  dispatch(
    command: Command,
    spec: CommandSpec<W>,
    deps: Omit<CommandDeps<W>, "nowTick">,
  ): DispatchOutcome;
  /**
   * Advances WITHOUT a command: the world layer alone (no `actorId` — nobody
   * is acting), then the mark moves to `toTick`. Returns the raw settlement
   * messages for the adapter's exit.
   */
  heartbeat(request: HeartbeatRequest): Message[];
}

export function createDispatchDriver<W>(
  options: DispatchDriverOptions<W>,
): DispatchDriver<W> {
  const { clock, settle } = options;
  return {
    dispatch(command, spec, deps) {
      // The one "now" reading: both the pre-flight and the real run see the
      // same number, and the advance targets it (via effectiveNowTick).
      const fullDeps = { ...deps, nowTick: clock.nowTick() };
      let settled: Message[] = [];
      if (settle !== undefined) {
        // 1. Pre-flight — parse stage only (spec/04 §4.1). A malformed input
        // must not fast-forward the world, so it is answered HERE, before
        // anything settles and before any pre-stage hook runs.
        const parsed = parseCommand(spec, command, fullDeps);
        if (!parsed.ok) {
          return {
            result: { ok: false, seq: command.seq, kind: "invalid", reason: parsed.reason },
            settled: [],
          };
        }
        // 2. Advance — the same "now" the command will see, from the same one
        // function. The parse stage runs twice by design (pre-flight + the
        // real run), which is why it must be PURE: an impure parse that
        // passed the pre-flight and then failed would leave the world settled
        // for an `invalid` result — unreachable under that contract.
        settled = settle({
          toTick: effectiveNowTick(fullDeps.nowTick, command),
          seq: command.seq,
          actorId: command.actorId,
        });
      }
      // 3. Dispatch.
      const result = runCommand(spec, command, fullDeps);
      // 4. Observe: the whitelist guard — only a command that reached the
      // execution stage moves the mark (`ok`/`rejected`, never `invalid`),
      // and on the no-advance path this is the only thing raising it.
      observeDispatch(clock, command, result);
      // Rule 3: settlement events ride the command's seq and sit in FRONT of
      // its events — one ranking, one home (see {@link settlementFirst}). Only
      // an `ok` result carries an events field; a rejection's refusal is what
      // the sink saw (spec/01 §4).
      const withSettlement = result.ok
        ? {
            ...result,
            events: settlementFirst(
              settled.map((message) => message.event),
              result.events,
            ),
          }
        : result;
      return { result: withSettlement, settled };
    },
    heartbeat({ toTick, seq }) {
      // No command, so no pre-flight and no observe step: the beat IS the
      // advance. No `actorId` means the world layer alone.
      const settled = settle?.({ toTick, seq }) ?? [];
      // The advance IS the mark raise (spec/04 §4.2) — and here the two must
      // not be forgotten as one either: the mark follows the host's "now"
      // even when nothing is hooked up to advance (a beat that raises nothing
      // is the silent freeze again).
      // AFTER the settle call: an advance measures its span from the mark it
      // found, and `settleTo` raises the mark itself — this second observe is
      // a no-op there, and the whole raise on the no-advance path.
      clock.observe(toTick);
      return settled;
    },
  };
}
