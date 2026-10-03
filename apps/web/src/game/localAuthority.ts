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
  collectMeta,
  createDispatchDriver,
  createSettler,
  resolve,
  serializeWorld,
  settlementFirst,
  verbTableFrom,
} from "@sexymud/core";
import type { HostClock } from "./hostClock.js";

/**
 * `LocalAuthority` — the local-first `Authority` (ADR-0017, spec/01 §3): the
 * side that DRIVES the world in production. It is the host counterpart of the
 * test harness (`createCommandHarness`), and like it, it is a thin adapter
 * over the dispatch driver (`command/driver.ts`, spec/04 §4.1): the fixed
 * four steps and their rules live THERE, once (ADR-0038). What stays here is
 * the front and the back of it: the source recipe and the bindings handed to
 * the engine's one resolve (`command/resolve.ts` — which spec does this input
 * name, and the `invalid` answer that consumes no seq), and the exit behind
 * (one delivery per consumed seq).
 *
 * ⚠️ Nothing here sequences a dispatch by hand: forgetting one of the steps
 * freezes the world SILENTLY (O10's failure mode), and "the order exists once"
 * is the whole point of the driver.
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
   * Command behaviours by dispatch key — the bound behaviour (bindSpec,
   * `command/resolve.ts`) in its already-built form, kept beside
   * the verb sources (an entry's `verbs` are content, its `func` is code;
   * `commandSpecFromEntry` is where the two halves meet).
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

  // One driver per Authority (D5: one factory closure). The advance hook is
  // the settler's own function, injected as a value — the four steps
  // themselves are the driver's business.
  const driver = createDispatchDriver<WorldRuntime>({
    clock: runtime.clock,
    settle: (request) => settler.settleTo(request),
  });

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
  const verbTableFor = (actorId: string) => verbTableFrom(options.cmdsetsOf(actorId));

  const dispatchNow = (command: Command): CommandResult => {
    const table = verbTableFor(command.actorId);
    // The resolve step is the engine's one (`command/resolve.ts`: match →
    // lookup → bind the behaviour). The recipe (which sources) and the
    // bindings (which behaviour per key) stay with this adapter; the driver
    // takes the resolved spec. A player's typo — empty input, unknown verb —
    // is answered HERE as an `invalid`, before anything settles (it must not
    // fast-forward the world, spec/04 §4.1); a matched key nobody bound
    // behaviour to is resolve's wiring error, loud as a throw.
    const outcome = resolve(command.raw, table, specs);
    if (!outcome.ok) {
      return { ok: false, seq: command.seq, kind: "invalid", reason: outcome.reason };
    }
    // What the execution stage said, in order. Recipient routing rides the
    // `Message` (spec/05 output pipeline, not built yet); the subscriber
    // stream is the semantic journal, so only the events are kept here.
    const emitted: GameEvent[] = [];
    const deps = {
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

    // The four steps and their rules run in the driver (spec/04 §4.1): this
    // adapter never sequences a dispatch by hand.
    const { result, settled } = driver.dispatch(command, outcome.spec, deps);

    // The exit (AC4): one batch per CONSUMED seq — `ok`, `rejected`, a
    // heartbeat — even when it carries no events. `invalid` consumes no seq
    // and produces no delivery, which is exactly what makes the seq line
    // contiguous for gap detection (spec/01 §3): an empty batch means "seq N
    // happened and said nothing", a missing batch means "seq N never
    // happened".
    //
    // The ok result's events already carry the settlement events in front
    // (the driver's ordering — "what happened while you were away" reads
    // before "you go north", ADR-0034 §4). On a rejection the refusal events
    // are what the sink saw, and they ride AFTER the settlement — the result
    // shape carries no events field (spec/01 §4).
    const settlement = settled.map((message) => message.event);
    if (result.ok) {
      deliver(result.events, command.seq);
      return result;
    }
    if (result.kind === "rejected") {
      deliver(settlementFirst(settlement, emitted), command.seq);
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
      // The beat is the driver's no-command entry (D3): advance + raise the
      // mark, world layer only. `toTick` comes from the host clock HERE —
      // the driver reads no wall clock of its own.
      const settled = driver.heartbeat({ toTick: hostClock.nowTick(), seq });
      const events = settled.map((message) => message.event);
      deliver(events, seq);
      return events;
    },
    snapshot(): Promise<Snapshot> {
      // O9/ADR-0033 §2: the scalars ride beside the tree, and `collectMeta`
      // is the face that reads the three off the live bundle (#37) — the mark
      // from the side that drives the world, the stream's exported state, the
      // armed items. `serializeWorld` rejects a non-tick `nowTick` loudly. The
      // items come from THE bucket — the one that armed and fires them — so
      // a save can never write `due: []` over live fuses.
      return Promise.resolve(serializeWorld(runtime.state, collectMeta({ runtime, rng, bucket })));
    },
  };
}
