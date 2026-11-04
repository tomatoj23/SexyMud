import {
  assembleWorld,
  chunkOutput,
  collectMeta,
  commandSetSources,
  combatTraversalSpec,
  COMBAT_ESCAPE_EVENT,
  createCommandHarness,
  createCombatSettleHandler,
  createDueBucket,
  createEntity,
  createGameTime,
  createSeededRng,
  createSettler,
  createWorldRuntime,
  equipSpec,
  grantFlagSpec,
  guardNotInCombat,
  lineOf,
  lookSpec,
  MARTIAL_EQUIPPED_EVENT,
  MARTIAL_UNEQUIPPED_EVENT,
  performSpec,
  renderEvent,
  RESOURCE_REGEN_EVENT,
  resolve,
  resumeCombatSession,
  sanitizePlayerInput,
  saySpec,
  seedCharacterAttrs,
  serializeWorld,
  strikeSpec,
  testClockOver,
  unequipSpec,
  validateEquippedMartials,
  verbTableFrom,
} from "@sexymud/core";
import type {
  CallOutcome,
  CommandBinding,
  CommandEntry,
  CommandHarness,
  CommandSpec,
  DueBucket,
  Message,
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
import type { HostClock } from "./hostClock.js";
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

/**
 * The host's input-length cap (spec/05 §8.1: the cap's VALUE is the host's,
 * the strip's categories are the engine's). One command line's worth, held
 * generous — a say line wants room to breathe, a command never needs this
 * much.
 */
export const MAX_INPUT_LENGTH = 200;

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
 *
 * #56 adds the strike (the engine's combat adapter — the tracer bullet's
 * own kernel behaviour) and the lodge check-in (the engine's generic flag
 * adapter; the flag WORD is this pack's, and it rides here with the table —
 * "换包换表", the same law as the copy table). #58 adds the perform cast and
 * the equip/unequip pair — the engine's combat adapters, the pack's verbs.
 */
export const DEFAULT_FACTORY_ADAPTERS: readonly FactoryAdapter[] = [
  { commandId: "cmd-look", spec: lookSpec },
  { commandId: "cmd-say", spec: saySpec },
  { commandId: "cmd-strike", spec: (entry) => strikeSpec(entry) },
  { commandId: "cmd-lodge", spec: (entry) => grantFlagSpec(entry, "inn-lodger") },
  { commandId: "cmd-perform", spec: (entry) => performSpec(entry) },
  { commandId: "cmd-equip", spec: (entry) => equipSpec(entry) },
  { commandId: "cmd-unequip", spec: (entry) => unequipSpec(entry) },
];

/**
 * The BASE strike's effect chain (#57, #58 D15): the settle handler's
 * scheduled hands walk this chain whenever the WHEEL falls back to the base
 * strike — and the typed opening hand walks the same one. Martial hands
 * walk their ENTRY's chain instead; the id travels with this host's binding
 * table (the adapters above name the same entry); a pack swap swaps both.
 */
const strikeEffects = (pack: LoadedPack): readonly string[] =>
  pack.registry.command("cmd-strike").effects ?? [];

export interface GameSessionOptions {
  readonly pack: LoadedPack;
  readonly store: SaveStore;
  /** The terminal geometry the chunker folds at — inputs, never constants. */
  readonly viewport: Viewport;
  readonly copy: HostCopy;
  readonly adapters?: readonly FactoryAdapter[];
  /** The command id the automatic look dispatches (world guidance, #48 D4). */
  readonly autoLookCommandId?: string;
  /**
   * The wall→tick translator (#56): each submitted command carries the tick
   * it reads HERE, so the world's "now" follows the wall clock and a poison
   * armed at one command catches up on the next. Absent, commands run at the
   * high-water mark they find (the pre-#56 behaviour — tests that never
   * advance the wall).
   */
  readonly hostClock?: HostClock;
  /**
   * The idle-combat heartbeat's period in milliseconds (#57 C2-T7): with a
   * host clock wired, the session advances the standing fight on THIS timer
   * so an idle player reads the hands live (the "standing in a fight while
   * idle" obligation). Default 1000; the beat is idempotent at a standing
   * wall, so a period finer than the pack's tick is harmless.
   */
  readonly heartbeatMs?: number;
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
  /**
   * One manual heartbeat (#57 C2-T7): advances the standing fight to the
   * wall's now and renders what came due — the same chain the automatic
   * timer drives, exposed for hosts and tests that keep their own clock.
   */
  heartbeat(): Promise<void>;
  /** Stops the automatic heartbeat timer — the 「回标题」 path's cleanup. */
  dispose(): void;
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
    // The §8.1 gate serves EVERY player-written line that enters the
    // engine, the name included (#54 复核 F2): the name rides into the
    // render's name table AND the saved entity state, so control/format
    // code points in it would outlive the session in the save. Same order
    // as the command leg: trim (full-width spaces are Zs, not Cc) then the
    // gate, then the host default for what empties out.
    const cleaned = sanitizePlayerInput((raw ?? "").trim(), MAX_INPUT_LENGTH);
    playerName = cleaned || copy.defaultPlayerName;
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
    // ONE "now": the harness's clock face bridges the runtime's own mark
    // (#56), so the dispatches, the settler and the status line all read
    // the same number — and the advance settles the poison and the fight's
    // hands with it (#57: one scheduler, due-tick order).
    const settler = createSettler({
      state: live.runtime.state,
      clock: live.runtime.clock,
      entity: createCombatSettleHandler(live.runtime, {
        rng: live.rng,
        baseEffects: strikeEffects(pack),
      }),
    });
    harness = createCommandHarness<WorldRuntime>({
      world: { live: live.runtime },
      receivers: ["player"],
      session: {
        clock: testClockOver(live.runtime.clock),
        rng: live.rng,
        due: live.bucket,
        settle: (request) => settler.settleTo(request),
      },
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
      // The entry's own notInCombat declaration wraps its spec (#57 D7):
      // the gate table rides with the content, the wrapper rides with the
      // binding — an entry without the field wraps to itself.
      bindings.set(entry.id, () => guardNotInCombat(entry, adapter.spec(entry)));
    }
    for (const exit of room.exits) {
      // The combat-bearing traversal (#57): the escape roll before the move,
      // the proactive edge after it — the pure adapter stands in for packs
      // without fights.
      bindings.set(exit.id, () => combatTraversalSpec(exit));
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

  /** One message batch settled: render → fold/chunk → status → autosave — the dispatch and the heartbeat share it. */
  const settleMessages = async (messages: readonly Message[]): Promise<void> => {
    const lines: OutputLine[] = [];
    for (const message of messages) {
      if (message.to !== "player") continue;
      // A granted flag's event is an extension arm, and the C1 rendering
      // seam renders the engine's arms only (#56 T1) — the SESSION words
      // the grant from the host's copy, the enterText family.
      if (message.event.type === "flagGranted") {
        lines.push(lineOf([{ text: copy.flagGrantedLine, style: "plain" }]));
        continue;
      }
      // The escape's two outcomes ride the same extension-arm precedent
      // (#57 C2-T5): the event is semantic, the words are this host's.
      if (message.event.type === COMBAT_ESCAPE_EVENT) {
        const outcomeKind = (message.event as { outcome?: string }).outcome;
        lines.push(
          lineOf([
            {
              text:
                outcomeKind === "escaped"
                  ? copy.escapeOkLine
                  : copy.escapeFailLine,
              style: "plain",
            },
          ]),
        );
        continue;
      }
      // The equip/unequip confirmations (#58 D13): the id rides the event,
      // the name comes out of the registry — the SESSION words both, the
      // flagGranted family.
      if (
        message.event.type === MARTIAL_EQUIPPED_EVENT ||
        message.event.type === MARTIAL_UNEQUIPPED_EVENT
      ) {
        const martialId = (message.event as { martialId?: string }).martialId;
        // The engine's own event always carries the id; an absent one is a
        // wiring miss the throwing getter names — no silent "" fallback.
        const name = pack.registry.martial(martialId!).name;
        lines.push(
          lineOf([
            {
              text:
                message.event.type === MARTIAL_EQUIPPED_EVENT
                  ? copy.martialEquippedLine(name)
                  : copy.martialUnequippedLine(name),
              style: "plain",
            },
          ]),
        );
        continue;
      }
      // The regeneration line (#58 D16②/C3-T4): one event per resource per
      // observation span, worded by the attr key this host's pack declares.
      if (message.event.type === RESOURCE_REGEN_EVENT) {
        const fields = message.event as { resource?: string; amount?: number };
        // The engine's own event always carries both; an absent one is a
        // wiring miss the copy line's own fallbacks surface — no silent
        // "" / 0 stand-ins (the martialEquipped arm's law, same batch).
        lines.push(
          lineOf([
            {
              text: copy.regenLine(fields.resource!, fields.amount!),
              style: "plain",
            },
          ]),
        );
        continue;
      }
      lines.push(...renderEvent(message.event, { observerId: "player" }, render));
    }
    emit(lines);
    onStatus(statusPanel());
    await autosave();
  };

  /** One harness dispatch, settled. */
  const settle = (outcome: CallOutcome) => settleMessages(outcome.messages);

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

  /**
   * One dispatch's visible failure line (#56 audit): the engine's wiring
   * failures are loud ON PURPOSE (a pack without its combat tables, an
   * unseeded save), and "loud" must not reach the player as a frozen
   * terminal — the command channel catches, says one line, and the next
   * input still works. The save-failure line's own family.
   */
  const dispatchFailedLine = (): OutputLine =>
    lineOf([{ text: copy.submitFailed, style: "danger" }]);

  /**
   * The idle-combat heartbeat (#57 C2-T7): one actor-bearing beat through
   * the SAME harness, settle chain and autosave a command rides — the
   * standing fight advances to the wall's now and the idle player reads
   * the hands live. No wall clock wired means no beat to take (the pre-C2
   * tests' world); a standing wall settles an empty span and changes
   * nothing, which is what makes the automatic timer harmless in jsdom.
   */
  const heartbeat = async (): Promise<void> => {
    if (runtime === undefined || harness === undefined) return;
    const tick = options.hostClock?.nowTick();
    if (tick === undefined) return;
    try {
      await settleMessages(harness.beat({ tick, actorId: "player" }));
    } catch {
      // The submit channel's own family (#56 audit): a wiring failure in
      // the beat is one visible line, never an unhandled rejection.
      emit([dispatchFailedLine()]);
    }
  };

  // The automatic timer: the moment a wall clock is wired, the standing
  // fight stops waiting for the player's next input. dispose() clears it —
  // the 「回标题」 path's one cleanup duty.
  const heartbeatTimer =
    options.hostClock === undefined
      ? undefined
      : setInterval(() => void heartbeat(), options.heartbeatMs ?? 1000);

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
      // The character model rides the attrs slot (#56 AC2): a new game
      // seeds the declared keys over the fresh empty map. A pack without a
      // table stays empty-handed — the first strike's operands then fail
      // loudly, the engine's own wiring answer.
      const character = pack.registry.character;
      if (character !== undefined) {
        seedCharacterAttrs(runtime.state.entities["player"]!, character);
      }
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
      // save (#52 AC3), and the two must never share a verdict. The peek
      // therefore judges drift ONLY: a payload that does not even carry a
      // well-formed data/entities shape — or a player record that is not an
      // object — is passed through UNTOUCHED, so the engine's corruption
      // verdict is the one that fires (spec/04 §1.4; saveText's D3: the two
      // layers name their own damage) — never a TypeError off this peek,
      // never this session's own words.
      const payload = snapshot.data;
      const entities =
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? (payload as SaveDataV2).entities
          : undefined;
      const mapOk =
        typeof entities === "object" && entities !== null && !Array.isArray(entities);
      let toLoad = snapshot;
      let fellBack = false;
      if (mapOk) {
        const savedPlayer = entities["player"];
        if (savedPlayer === undefined) {
          // A well-formed entities map with no player row is unusable HERE —
          // this game's saves always carry the player. A wiring bug to be
          // heard, not damage (the map itself already passed the shape gate).
          throw new Error("game session: the save carries no player entity — nothing to resume");
        }
        if (typeof savedPlayer === "object" && savedPlayer !== null && !Array.isArray(savedPlayer)) {
          const savedRoom = savedPlayer.locationId;
          if (
            typeof savedRoom === "string" &&
            savedRoom !== "" &&
            !pack.registry.rooms.some((room) => room.id === savedRoom)
          ) {
            fellBack = true;
            // Loaded saves are construction data: the relocation is a plain
            // rewrite of the record (the same right a host has over initial
            // placement), on a COPY — the store's object is never touched.
            toLoad = {
              ...snapshot,
              data: {
                ...(payload as SaveDataV2),
                entities: {
                  ...entities,
                  player: { ...savedPlayer, locationId: world.startRoomId },
                },
              },
            };
          }
        }
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
      // A pre-#56 save predates the attrs slot entirely (its absence reads
      // as the empty map, the slot's own law) — seed the character model
      // over the EMPTY map only: a save that carried attrs keeps every
      // value it carried (a mid-fight hp is data, not a default), and a
      // fight would otherwise die on the first strike's missing operands
      // with nothing on screen (the engine's loud failure is for wiring,
      // not for a player who merely owns an old save).
      const resumedState = assembled.runtime.state.entities["player"]!;
      const characterTable = pack.registry.character;
      if (
        characterTable !== undefined &&
        Object.keys(resumedState.attrs).length === 0
      ) {
        seedCharacterAttrs(resumedState, characterTable);
      }
      // The load-point rhythm restart (#57 D3): a mid-fight save's owed
      // hands are never settled — an expired next-strike resets to the
      // wall's now + the interval, a still-future one keeps its place, a
      // C1-era session without rhythm data is seeded. The wall's now is
      // read HERE (the one true reading); without a host clock the world's
      // own mark stands in (tests that never move the wall).
      resumeCombatSession(
        assembled.runtime.state,
        pack.registry,
        options.hostClock?.nowTick() ?? assembled.runtime.clock.nowTick(),
      );
      // The equipped slot's load-point reference check (#58 D13): a save's
      // equipped ids must resolve against the CURRENT pack's martial
      // collection and known list — content drift answers here, loudly,
      // never as a silently uncastable hand mid-fight.
      validateEquippedMartials(assembled.runtime.state, pack.registry);
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
      // The §8.1 gate (#54): the line is REBUILT before the engine may see
      // it — control/format code points dropped (an embedded newline rode
      // into an output line and forged an extra visible one, the #51
      // finding), then capped at the host's limit. A line that empties out
      // here joins the empty-input path: it settles nothing, saves nothing.
      const clean = sanitizePlayerInput(trimmed, MAX_INPUT_LENGTH);
      if (clean === "") return;
      const actorId = "player";
      const { sources, bindings } = dispatchTable(runtime.locationOf(actorId));
      const outcome = resolve(clean, verbTableFrom(sources), bindings);
      if (!outcome.ok) {
        // resolve's classification is the engine's; the WORDS are the host's
        // (spec/01 §4) — and an invalid input settles nothing, so no save.
        emit([lineOf([{ text: copy.unknownCommand(clean), style: "plain" }])]);
        return;
      }
      // The command carries the WALL clock's tick when a translator is
      // wired (#56): the world's "now" follows real time, so a poison
      // armed at one command catches up at the next. A wiring failure
      // inside the dispatch surfaces as ONE visible line, never an
      // unhandled rejection freezing the terminal.
      const tick = options.hostClock?.nowTick();
      try {
        await settle(
          harness.call(
            outcome.spec,
            tick === undefined ? { raw: clean, actorId } : { raw: clean, actorId, tick },
          ),
        );
      } catch {
        emit([dispatchFailedLine()]);
      }
    },
    async heartbeat() {
      await heartbeat();
    },
    dispose() {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
      }
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
