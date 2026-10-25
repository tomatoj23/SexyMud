import {
  assembleWorld,
  chunkOutput,
  collectMeta,
  commandSetSources,
  createCommandHarness,
  createDueBucket,
  createEntity,
  createGameTime,
  createSeededRng,
  createWorldRuntime,
  lineOf,
  lookSpec,
  renderEvent,
  resolve,
  saySpec,
  serializeWorld,
  traversalSpec,
  verbTableFrom,
} from "@sexymud/core";
import type {
  CallOutcome,
  CommandBinding,
  CommandEntry,
  CommandHarness,
  CommandSpec,
  DueBucket,
  OutputLine,
  RenderContent,
  Rng,
  SaveDataV2,
  SaveStore,
  Viewport,
  WorldRuntime,
} from "@sexymud/core";
import { createTerminalView } from "../ui/terminalView.js";
import type { StatusPanel, TerminalView } from "../ui/terminalView.js";
import type { HostCopy } from "./hostCopy.js";
import type { LoadedPack } from "./pack.js";

/**
 * The web host's game session (#51): the tracer bullet's whole live side —
 * title screen in, world guidance, the command walk (走/看/说), the folded
 * and chunked output, the status line and the autosave. It plays HOST the
 * way the core tests do (traversal-chain): a live WorldRuntime driven
 * through the engine's ONE command harness, with the host owning exactly
 * the three things the engine leaves to it —
 *
 *   the binding table   one "command id → factory behaviour" map (#48 D12;
 *                       look/say/traversal are the engine's factory adapters,
 *                       and swapping the pack swaps this table, never the
 *                       engine)
 *   the render feed     the injected content face built by the loader,
 *                       plus the player's DISPLAY name merged in at start
 *                       (actor id is the fixed `player`, #48 D4)
 *   the host words      unknown-command line, save-failure line (Q5)
 *
 * World guidance (#48 D4): a new game lands on the pack's declared start
 * room; the enterText goes out as a host-authored OUTPUT LINE — straight
 * from content data, NOT through an event (Q7: the closed union stays
 * closed) — and one automatic look through the same harness and the same
 * binding table walks the full chain (event → render → fold → chunk), so
 * the very first screen the player reads is the screen every command
 * produces. Autosave runs after EVERY settled command (#48 D10): the
 * snapshot is the engine's serializeWorld over the live bundle.
 *
 * The save loop's other half (#52) is continueGame below: the snapshot back
 * into a live world through the engine's ONE assembly entry (assembleWorld,
 * #37), the player stood back where the save left them — the start room and
 * one host line of notice when the saved room has left the pack (content
 * drift, never a corruption verdict) — and the same automatic look as the
 * opening screen. The display name rides the payload both ways (tree state,
 * #52 AC4): written at startNewGame, read back at continueGame, defaulted
 * HERE when an old save predates the field.
 */

/** One row of the host's binding table: a command id and its factory adapter. */
export interface FactoryAdapter {
  /** The content command entry this adapter claims (its dispatch key). */
  readonly commandId: string;
  readonly spec: (entry: CommandEntry) => CommandSpec<WorldRuntime>;
}

/**
 * The shipped pack's table. Commands WITHOUT a factory adapter (examine,
 * rest) deliberately ride OUT of the dispatch table — `resolve` treats a
 * matched key nobody bound as a wiring bug and throws, so the honest shape
 * is a table that offers only what it can run; their input reads as an
 * unknown command until their behaviour tickets land.
 */
export const DEFAULT_FACTORY_ADAPTERS: readonly FactoryAdapter[] = [
  { commandId: "cmd-look", spec: lookSpec },
  { commandId: "cmd-say", spec: saySpec },
];

export interface GameSessionOptions {
  readonly pack: LoadedPack;
  readonly store: SaveStore;
  /** The terminal geometry the chunker folds at — inputs, never constants. */
  readonly viewport: Viewport;
  readonly copy: HostCopy;
  readonly adapters?: readonly FactoryAdapter[];
  /** The command id the automatic look dispatches (world guidance, #48 D4). */
  readonly autoLookCommandId?: string;
  /** Rendered, folded and chunked output, ready for the terminal window. */
  readonly onOutput: (chunks: readonly (readonly OutputLine[])[]) => void;
  /** The status line's new face, after every settled dispatch. */
  readonly onStatus: (panel: StatusPanel) => void;
}

export interface GameSession {
  /** World guidance: land a new game and play the opening (look included). */
  startNewGame(name: string): Promise<void>;
  /**
   * The save loop's resume half (#52): load the slot, rebuild the live world
   * from the snapshot, and stand the player where the save left them — the
   * start room with one line of notice when the saved room has left the pack
   * (never a corruption verdict: content drift and payload damage are
   * different troubles, and damage stays the load path's loud business).
   */
  continueGame(): Promise<"resumed" | "no-save">;
  /** One player input through the full chain, autosaved after settlement. */
  submit(raw: string): Promise<void>;
  /** The player's display name (the actor id is the fixed `player`). */
  playerName(): string;
  status(): StatusPanel;
}

export function createGameSession(options: GameSessionOptions): GameSession {
  const { pack, store, viewport, copy, onOutput, onStatus } = options;
  const adapters = options.adapters ?? DEFAULT_FACTORY_ADAPTERS;
  const autoLookId = options.autoLookCommandId ?? "cmd-look";
  const gameTime = createGameTime(pack.registry.calendar);
  const hourRingKnown =
    pack.registry.calendar !== undefined && gameTime.ringIds.includes(copy.hourRingId);

  let runtime: WorldRuntime | undefined;
  let rng: Rng | undefined;
  let bucket: DueBucket | undefined;
  let harness: CommandHarness<WorldRuntime> | undefined;
  let render: RenderContent = pack.render;
  let playerName = copy.defaultPlayerName;

  /** The pack's world table, or the honest refusal — both openings need it. */
  const requireWorldTable = () => {
    const world = pack.registry.world;
    if (world === undefined) {
      throw new Error(
        "game session: the pack declares no world table — content/config/world.json (issue #49)",
      );
    }
    return world;
  };

  /**
   * The player's display name applied — trimmed, defaulted, and merged into
   * the render voice (#48 D4: a display field, never an id). The default is
   * the HOST's word (Q5); the name reaches the payload as tree state, never
   * as a render-side-only fact (#52).
   */
  const applyPlayerName = (raw: string | undefined): void => {
    playerName = (raw ?? "").trim() || copy.defaultPlayerName;
    render = { ...pack.render, names: { ...pack.render.names, player: playerName } };
  };

  /** The live due bucket, armed the same way on every opening path. */
  const openBucket = (): DueBucket =>
    createDueBucket({
      // Nothing in the tracer bullet arms a due item; a firing without an
      // owner is a wiring bug to be heard, not an event to be swallowed.
      fire: () => {
        throw new Error("game session: a due item fired with no handler wired");
      },
    });

  /** The harness over the live world — one wiring, every opening path. */
  const wireHarness = (live: { runtime: WorldRuntime; rng: Rng; bucket: DueBucket }): void => {
    harness = createCommandHarness<WorldRuntime>({
      world: { live: live.runtime },
      receivers: ["player"],
      session: { rng: live.rng, due: live.bucket },
      // Re-merged every dispatch, never cached (#38): the sources follow
      // the actor's CURRENT room, exactly as a real host's do.
      verbs: ({ world, actorId }) => {
        const { sources } = dispatchTable(world.locationOf(actorId));
        return sources;
      },
      access: { subjectOf: (world, id) => world.subjectOf(id) },
    });
  };

  /**
   * One automatic look through the same binding table and harness — the
   * opening screen on BOTH paths (a new arrival reads it after the
   * enterText; a returning player reads it as the where-am-I screen).
   */
  const runAutoLook = async (): Promise<void> => {
    if (harness === undefined) {
      throw new Error("game session: no harness wired — an opening went wrong");
    }
    const adapter = adapters.find((row) => row.commandId === autoLookId);
    if (adapter === undefined) {
      throw new Error(
        `game session: the binding table has no adapter for "${autoLookId}" — world guidance needs the look behaviour`,
      );
    }
    await settle(harness.call(adapter.spec(pack.registry.command(autoLookId)), {
      raw: "look",
      actorId: "player",
    }));
  };

  /** The binding table + verb sources for one dispatch (this room's exits). */
  const dispatchTable = (roomId: string) => {
    const room = pack.registry.room(roomId);
    const bound: CommandEntry[] = [];
    const bindings = new Map<string, CommandBinding<WorldRuntime>>();
    for (const adapter of adapters) {
      // An id the pack does not carry fails loudly here — the table travels
      // with the pack ("换包换表"), and a stale table is a wiring bug.
      const entry = pack.registry.command(adapter.commandId);
      bound.push(entry);
      bindings.set(entry.id, () => adapter.spec(entry));
    }
    for (const exit of room.exits) {
      bindings.set(exit.id, () => traversalSpec(exit));
    }
    return {
      sources: [...commandSetSources(bound), ...commandSetSources(room.exits)],
      bindings,
    };
  };

  const statusPanel = (): StatusPanel => {
    if (runtime === undefined) return { roomName: "", hourLabel: undefined };
    const roomId = runtime.locationOf("player");
    const roomName = pack.registry.room(roomId).name;
    // The hour is a pure function of the tick over the pack's calendar
    // (#48 D13); a pack without this host's hour ring shows no hour at all
    // rather than a guessed one. The WORD rides with the segment
    // (`label`, owner ruling 2026-10-25 / #51 D2 — the pack's vocabulary,
    // the same law as a room's `name`); absent label falls back to the raw
    // id, the honest key.
    let hourLabel: string | undefined;
    if (hourRingKnown) {
      const segment = gameTime.segmentOf(copy.hourRingId, runtime.clock.nowTick());
      hourLabel = segment.label ?? segment.id;
    }
    return { roomName, hourLabel };
  };

  /**
   * Every line that reaches the window goes through here — the engine's
   * chunker, at the host-fed geometry (#51 AC3): the host-authored lines
   * (enterText, prompts) fold exactly like the rendered event lines, so no
   * output bypasses the pipeline.
   */
  const emit = (lines: readonly OutputLine[]): void => {
    if (lines.length > 0) {
      onOutput(chunkOutput(lines, viewport));
    }
  };

  /** One harness dispatch, settled: render → fold/chunk → status → autosave. */
  const settle = async (outcome: CallOutcome) => {
    const lines: OutputLine[] = [];
    for (const message of outcome.messages) {
      if (message.to !== "player") continue;
      lines.push(...renderEvent(message.event, { observerId: "player" }, render));
    }
    emit(lines);
    onStatus(statusPanel());
    await autosave();
  };

  const autosave = async (): Promise<void> => {
    if (runtime === undefined || rng === undefined || bucket === undefined) return;
    try {
      await store.save(serializeWorld(runtime.state, collectMeta({ runtime, rng, bucket })));
    } catch {
      // Visible, not silent: a save that quietly failed is progress lost
      // twice (the player believes it landed).
      emit([lineOf([{ text: copy.saveFailed, style: "danger" }])]);
    }
  };

  return {
    async startNewGame(rawName) {
      if (runtime !== undefined) throw new Error("game session: a game has already started");
      const world = requireWorldTable();
      applyPlayerName(rawName);

      runtime = createWorldRuntime({ registry: pack.registry });
      // Seed 1, the same default the command harness itself starts at: the
      // tracer bullet rolls no dice, and a deterministic stream keeps two
      // identical sessions identical (ADR-0017). The save loop (#52) carries
      // rngState from here on.
      rng = createSeededRng(1);
      bucket = openBucket();
      runtime.addEntity(createEntity("player"), world.startRoomId);
      // The name rides the tree (#52): serializeWorld carries it into every
      // autosave, and 「继续」 reads it back out of the payload — a display
      // field the engine stores and never words a default for.
      runtime.state.entities["player"]!.name = playerName;
      wireHarness({ runtime, rng, bucket });

      // World guidance, first beat: the start room's enterText straight out
      // of content data as an output line — no event, no new event type
      // (Q7). The room's look follows immediately.
      const enterText = pack.registry.room(world.startRoomId).enterText;
      if (enterText !== undefined && enterText !== "") {
        emit([lineOf([{ text: enterText, style: "plain" }])]);
      }
      await runAutoLook();
    },
    async continueGame() {
      if (runtime !== undefined) throw new Error("game session: a game has already started");
      const snapshot = await store.load();
      if (snapshot === null) return "no-save";
      const world = requireWorldTable();

      // The room check runs BEFORE assembly, on the raw payload: restoreWorld
      // (inside assembleWorld) validates and throws there, so content drift
      // needs its answer first — a room that left the pack is NOT a corrupt
      // save (#52 AC3), and the two must never share a verdict. A
      // locationId that is not even a plausible id is left for the loud
      // path: this peek judges drift, never damage.
      const data = snapshot.data as SaveDataV2;
      const savedPlayer = data.entities["player"];
      if (savedPlayer === undefined) {
        throw new Error("game session: the save carries no player entity — nothing to resume");
      }
      let toLoad = snapshot;
      let fellBack = false;
      if (
        typeof savedPlayer.locationId === "string" &&
        savedPlayer.locationId !== "" &&
        !pack.registry.rooms.some((room) => room.id === savedPlayer.locationId)
      ) {
        fellBack = true;
        // Loaded saves are construction data: the relocation is a plain
        // rewrite of the record (the same right a host has over initial
        // placement), on a COPY — the store's object is never touched.
        toLoad = {
          ...snapshot,
          data: {
            ...data,
            entities: {
              ...data.entities,
              player: { ...savedPlayer, locationId: world.startRoomId },
            },
          },
        };
      }

      bucket = openBucket();
      const assembled = assembleWorld({
        snapshot: toLoad,
        registry: pack.registry,
        bucket,
        entities: [createEntity("player")],
      });
      runtime = assembled.runtime;
      rng = assembled.rng;
      // The name rides back out of the payload; absent (an old save) reads
      // the HOST's default — 「少侠」 is this host's word, never the engine's
      // (Q5, the `name` slot's unfilled row). The applied name is stamped
      // back onto the tree, so the very next autosave carries it: an old
      // nameless save LEARNS the name it is played under.
      applyPlayerName(assembled.runtime.state.entities["player"]!.name);
      assembled.runtime.state.entities["player"]!.name = playerName;
      wireHarness(assembled);

      if (fellBack) {
        emit([lineOf([{ text: copy.saveRoomGone, style: "plain" }])]);
      }
      await runAutoLook();
      return "resumed";
    },
    async submit(raw) {
      if (runtime === undefined || harness === undefined) {
        throw new Error("game session: no game has started — call startNewGame first");
      }
      const trimmed = raw.trim();
      if (trimmed === "") return;
      const actorId = "player";
      const { sources, bindings } = dispatchTable(runtime.locationOf(actorId));
      const outcome = resolve(trimmed, verbTableFrom(sources), bindings);
      if (!outcome.ok) {
        // resolve's classification is the engine's; the WORDS are the host's
        // (spec/01 §4) — and an invalid input settles nothing, so no save.
        emit([lineOf([{ text: copy.unknownCommand(trimmed), style: "plain" }])]);
        return;
      }
      await settle(harness.call(outcome.spec, { raw: trimmed, actorId }));
    },
    playerName() {
      return playerName;
    },
    status() {
      return statusPanel();
    },
  };
}

/**
 * The App-level assembly (#51): one session wired to one terminal view —
 * the session's chunked output and status into the view's append/set
 * faces, the view's command channel into the session's submit.
 */
export function createPlayableSession(
  options: Omit<GameSessionOptions, "onOutput" | "onStatus">,
): { session: GameSession; view: TerminalView } {
  const view = createTerminalView();
  const session = createGameSession({
    ...options,
    onOutput: (chunks) => view.appendOutput(chunks.flat()),
    onStatus: (panel) => view.setStatus(panel),
  });
  view.onCommand((raw) => {
    void session.submit(raw);
  });
  return { session, view };
}
