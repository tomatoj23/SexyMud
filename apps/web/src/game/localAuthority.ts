import type {
  Authority,
  CmdSetSource,
  Command,
  CommandResult,
  CommandSpec,
  DueBucket,
  EntitySettleHandler,
  EventMeta,
  GameEvent,
  GameListener,
  Message,
  PredicateRegistry,
  Rng,
  Snapshot,
  WorldRuntime,
} from "@sexymud/core";
import {
  createSettler,
  createVerbTable,
  effectiveNowTick,
  mergeCmdSets,
  observeDispatch,
  parseCommand,
  runCommand,
  serializeWorld,
} from "@sexymud/core";
import type { HostClock } from "./hostClock.js";

/**
 * `LocalAuthority` — the local-first `Authority` (ADR-0017, spec/01 §3): the
 * side that DRIVES the world in production. It is the host counterpart of the
 * test harness (`createCommandHarness`), running the same fixed four steps
 * (spec/04 §4.1):
 *
 *   1. PRE-FLIGHT — parse only. An input that cannot become a command returns
 *      `invalid` and the world is not advanced at all.
 *   2. SETTLE — `settleTo` up to the "now" this command sees: world layer
 *      first, then THIS actor's entity layer (spec/04 §4.3).
 *   3. DISPATCH — `runCommand`.
 *   4. OBSERVE — `observeDispatch` raises the high-water mark, and the
 *      settlement events ride in front of the command's own events.
 *
 * ⚠️ `runCommand` reports no "now" back — the mark moves through
 * `observeDispatch` and nowhere else (spec/04 §6 O10, option (b)). Forgetting
 * it would freeze the world silently, so the step lives here, once.
 *
 * Everything time-shaped is injected: the tick a command carries is built by
 * the caller from the {@link HostClock}, and a heartbeat names its own seq.
 */

export interface LocalAuthorityOptions {
  /** The live world — its `clock` IS the high-water mark (spec/04 §2.2). */
  runtime: WorldRuntime;
  /** The seeded random stream; its state travels through `snapshot()`. */
  rng: Rng;
  /**
   * The host clock: wall → tick. Heartbeats read it; commands carry what the
   * caller read from it.
   */
  hostClock: HostClock;
  /**
   * Command behaviours by dispatch key — bound beside the verb sources (an
   * entry's `verbs` are content, its `func` is code; `commandSpecFromEntry`
   * is where the two halves meet).
   */
  specs: ReadonlyMap<string, CommandSpec<WorldRuntime>>;
  /**
   * What this actor can do RIGHT NOW, assembled per dispatch and never cached
   * (spec/03 §7.9): a stun lands and the very next dispatch's action set
   * reflects it.
   */
  cmdsetsOf(actorId: string): readonly CmdSetSource[];
  /**
   * The ONE due bucket — arming, firing and saving are the same object, so a
   * fuse armed before going away cannot be lost by the save boundary
   * (spec/04 §4.5: "the player saves, the player comes back, and there is no
   * bomb" is the scenario the bucket exists to prevent). Required rather
   * than optional on purpose: a host that could save `due: []` while another
   * bucket holds live items would reintroduce exactly that loss, and the
   * type cannot see two buckets. A host with no delayed effects passes one
   * it never arms.
   */
  bucket: DueBucket;
  /**
   * The entity layer's consumer (spec/04 §4.3). M4 has no real one yet — the
   * state tree has no numeric slot worth catching up — so tests register a
   * synthetic consumer here to measure the offline span.
   */
  entity?: EntitySettleHandler;
  /** Predicate registry for access gates; defaults to the engine's built-ins. */
  predicates?: PredicateRegistry;
}

/**
 * The host's `Authority`, plus the one thing the interface cannot name: a
 * heartbeat is advance WITHOUT a command (spec/04 §4.2, ADR-0034 §5).
 */
export interface LocalAuthority extends Authority {
  /**
   * Advances the world layer alone, to the wall clock's current tick.
   *
   * The caller supplies the `seq` EXPLICITLY, from the same monotonic counter
   * the commands use — a heartbeat is not a forged system command with an
   * empty `actorId`, and there is no second seq space to gap-detect against.
   */
  heartbeat(seq: number): GameEvent[];
}

export function createLocalAuthority(options: LocalAuthorityOptions): LocalAuthority {
  const { runtime, rng, hostClock, specs, bucket } = options;
  const settler = createSettler({
    state: runtime.state,
    clock: runtime.clock,
    world: bucket.settle,
    entity: options.entity,
  });
  const listeners = new Set<GameListener>();

  /**
   * One delivery per CONSUMED seq — `ok`, `rejected`, a heartbeat — even when
   * it carries no events. `invalid` consumes no seq and produces no delivery,
   * which is exactly what makes the seq line contiguous for gap detection
   * (spec/01 §3): an empty batch means "seq N happened and said nothing", a
   * missing batch means "seq N never happened".
   *
   * ⚠️ Delivery runs AFTER the world has moved and the seq is spent: a
   * listener that throws fails the dispatch promise, but the command HAS
   * run. A caller must never answer a thrown dispatch by reissuing the seq —
   * that would execute the command twice (a render bug is a wiring bug; fix
   * the wiring, not the world).
   */
  const deliver = (events: GameEvent[], seq: number): void => {
    if (listeners.size === 0) return;
    const meta: EventMeta = { fromSeq: seq, toSeq: seq };
    for (const listener of listeners) {
      listener(events, meta);
    }
  };

  /** The per-dispatch verb table: assembled now, discarded after this call. */
  const verbTableFor = (actorId: string) =>
    createVerbTable(mergeCmdSets(options.cmdsetsOf(actorId)).verbEntries());

  const dispatchNow = (command: Command): CommandResult => {
    const table = verbTableFor(command.actorId);
    // What the execution stage said, in order. Recipient routing rides the
    // `Message` (spec/05 output pipeline, not built yet); the subscriber
    // stream is the semantic journal, so only the events are kept here.
    const emitted: GameEvent[] = [];
    const deps = {
      nowTick: runtime.clock.nowTick(),
      rng,
      world: runtime,
      sink: {
        emit(message: Message) {
          emitted.push(message.event);
        },
      },
      verbs: table,
      subjectOf: (world: WorldRuntime, actorId: string) => world.subjectOf(actorId),
      predicates: options.predicates,
      due: bucket,
    };

    // 1. Pre-flight: which spec does this input name, and can it parse? An
    // input that cannot become a command must not fast-forward the world
    // (spec/04 §4.1) — so it is answered here, before anything settles.
    const match = table.match(command.raw);
    if (!match.ok) {
      return { ok: false, seq: command.seq, kind: "invalid", reason: match.reason };
    }
    const spec = specs.get(match.commandKey);
    if (spec === undefined) {
      // Wiring bug, not play: a verb routed to a key nobody bound behaviour
      // to. Loud, like every unbound seam here.
      throw new Error(
        `local authority: no spec bound to command key "${match.commandKey}" (verb "${match.verb}")`,
      );
    }
    const parsed = parseCommand(spec, command, deps);
    if (!parsed.ok) {
      return { ok: false, seq: command.seq, kind: "invalid", reason: parsed.reason };
    }

    // 2. Settle — the same "now" the command will see, from the same one
    // function. Settlement events come back in delivery order. The parse
    // stage runs twice by design (pre-flight + the real run), which is why
    // it must be PURE (spec/04 §4.1): an impure parse that passed the
    // pre-flight and then failed would leave the world settled for an
    // `invalid` result — unreachable under that contract, exactly as in the
    // test harness.
    const settled = settler.settleTo({
      toTick: effectiveNowTick(deps.nowTick, command),
      seq: command.seq,
      actorId: command.actorId,
    });

    // 3. Dispatch.
    const result = runCommand(spec, command, deps);

    // 4. Observe: only a command that reached the execution stage moves the
    // world's high-water mark (spec/04 §4.1).
    observeDispatch(runtime.clock, command, result);

    // Settlement events ride the command's seq and sit in FRONT of its own
    // events: "what happened while you were away" reads before "you go north"
    // (ADR-0034 §4). On a rejection the refusal events are what the sink saw —
    // the result shape carries no events field (spec/01 §4).
    const settlement = settled.map((message) => message.event);
    if (result.ok) {
      const events = [...settlement, ...result.events];
      deliver(events, command.seq);
      return { ...result, events };
    }
    if (result.kind === "rejected") {
      // The refusal events already went through the sink; a rejection's
      // result shape carries no events field (spec/01 §4).
      deliver([...settlement, ...emitted], command.seq);
    }
    return result;
  };

  return {
    dispatch(command) {
      // async by contract (ADR-0017); the local run is synchronous and a
      // wiring error stays loud as a rejected promise.
      return Promise.resolve().then(() => dispatchNow(command));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    heartbeat(seq) {
      const settled = settler.settleTo({ toTick: hostClock.nowTick(), seq });
      const events = settled.map((message) => message.event);
      deliver(events, seq);
      return events;
    },
    snapshot(): Promise<Snapshot> {
      // O9/ADR-0033 §2: the scalars ride beside the tree — the mark from the
      // side that drives the world, the stream's exported state, the armed
      // items. `serializeWorld` rejects a non-tick `nowTick` loudly. The
      // items come from THE bucket — the one that armed and fires them — so
      // a save can never write `due: []` over live fuses.
      return Promise.resolve(
        serializeWorld(runtime.state, {
          nowTick: runtime.clock.nowTick(),
          rngState: rng.getState(),
          due: bucket.snapshot(),
        }),
      );
    },
  };
}
