import {
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
      const world = pack.registry.world;
      if (world === undefined) {
        throw new Error(
          "game session: the pack declares no world table — content/config/world.json (issue #49)",
        );
      }
      playerName = rawName.trim() || copy.defaultPlayerName;
      render = { ...pack.render, names: { ...pack.render.names, player: playerName } };

      runtime = createWorldRuntime({ registry: pack.registry });
      // Seed 1, the same default the command harness itself starts at: the
      // tracer bullet rolls no dice, and a deterministic stream keeps two
      // identical sessions identical (ADR-0017). #52's save loop carries
      // rngState from here on.
      rng = createSeededRng(1);
      bucket = createDueBucket({
        // Nothing in the tracer bullet arms a due item; a firing without an
        // owner is a wiring bug to be heard, not an event to be swallowed.
        fire: () => {
          throw new Error("game session: a due item fired with no handler wired");
        },
      });
      runtime.addEntity(createEntity("player"), world.startRoomId);
      harness = createCommandHarness<WorldRuntime>({
        world: { live: runtime },
        receivers: ["player"],
        session: { rng, due: bucket },
        // Re-merged every dispatch, never cached (#38): the sources follow
        // the actor's CURRENT room, exactly as a real host's do.
        verbs: ({ world, actorId }) => {
          const { sources } = dispatchTable(world.locationOf(actorId));
          return sources;
        },
        access: { subjectOf: (world, id) => world.subjectOf(id) },
      });

      // World guidance, first beat: the start room's enterText straight out
      // of content data as an output line — no event, no new event type
      // (Q7). The room's look follows immediately.
      const enterText = pack.registry.room(world.startRoomId).enterText;
      if (enterText !== undefined && enterText !== "") {
        emit([lineOf([{ text: enterText, style: "plain" }])]);
      }
      // The automatic look runs through the SAME binding table and harness —
      // the opening screen is produced by the ordinary command chain.
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
