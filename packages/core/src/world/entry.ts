import type { AccessRules } from "../conditions.js";
import type { CommandEntry } from "../command/entry.js";

/**
 * World entries as CONTENT (spec/03 §1–§4, ADR-0016 §3, ADR-0021 §2): rooms,
 * exits and npcs arrive as data, exactly like commands did (M1-T5). The
 * engine knows these SHAPES and nothing about any particular world — the
 * village, its direction words and its people are all content. What the
 * engine adds around them is load-time referential integrity (the content
 * registry) and the adapters that turn an exit into a dispatchable command.
 *
 * Three-way sync (spec/06 §4): these types mirror schemas/rooms.schema.json
 * and schemas/npcs.schema.json field-for-field, and docs/agents/content.md
 * documents the field contract for content authors. Changing one means
 * changing all three.
 */

/**
 * An exit is an INDEPENDENT ENTITY, not a plain room field (spec/02 §4,
 * ADR-0021 §2): it registers itself as a command. That is literal here —
 * ExitEntry extends CommandEntry, so an exit carries the full command shape
 * (its direction words are its verbs, its gate and refusal copy hang on it,
 * its cmdset membership and merge priority are data like any other
 * command's) and flows through the same grouping (commandSetSources) and
 * spec assembly (commandSpecFromEntry) as command entries. What it adds is
 * the edge: direction and target room.
 *
 * Exits sit in their room's file, but their ids are global: an exit id is a
 * dispatch key (the verb table maps direction words onto it) and the refusal
 * event carries it as commandKey so the renderer can look the exit up and
 * read its err_* copy.
 */
export interface ExitEntry extends CommandEntry {
  /**
   * The edge's direction label — the canonical name of the directed edge
   * "direction → target room" (spec/03 §2), distinct from the verbs players
   * may type. Within one room, directions must be unique (the registry
   * enforces it): the direction IS the edge's key. The value set is a
   * content-pack convention (this pack uses Chinese direction words), not
   * engine vocabulary.
   */
  readonly direction: string;
  /**
   * The edge's target: another room's id. The registry validates at load
   * that every target resolves — a dangling edge is a broken world graph,
   * and it must fail loudly at startup, not when a player walks into it.
   */
  readonly targetRoomId: string;
}

/** One placed entity in a room's placement list (spec/03 §2): id → count. */
export interface PlacementEntry {
  /**
   * The placed entity's content id (an npc, a monster, later an item...).
   * The registry validates that it resolves against the loaded collections —
   * a room is a CONTENT CONTAINER, and its contents must exist.
   */
  readonly id: string;
  /** How many of this entity the room holds (two of the same bandit, ...). */
  readonly count: number;
}

/**
 * A room: the four elements of the xkx100 finding (spec/03 §2) — the exit
 * graph, the description copy, a placement list and rules — all as data.
 * The engine has no room runtime yet (the entity/movement hooks of spec/03
 * §7 are a later milestone); rooms land as content first, so the world a
 * host assembles is already validated, connected and dispatchable.
 */
export interface RoomEntry {
  /**
   * Content id, immutable once released. Rooms follow the pack's
   * `<collection>-<area>-<seq>` id convention (content.md); the file name is
   * the id.
   */
  readonly id: string;
  /** Short title (the room's signboard). */
  readonly name: string;
  /**
   * The long description (four elements: description copy). May embed hints
   * that entities are present — and every such element must actually sit in
   * the placement list: description text and data corroborate each other
   * (spec/03 §2). Copy follows content/style-guide.md.
   */
  readonly description: string;
  /**
   * The entry text (ADR-0021 §2): what the player reads on stepping in — a
   * narrative beat distinct from the lookable long description. Copy follows
   * content/style-guide.md.
   */
  readonly enterText: string;
  /**
   * The exit graph (four elements: exit graph nodes): each exit an
   * independent entity with its own identity, verbs, gate and refusal copy.
   * Directions are unique within the room; exit ids are unique across the
   * whole world (registry-enforced). A dead end declares an empty array
   * explicitly.
   */
  readonly exits: readonly ExitEntry[];
  /**
   * The placement list (four elements: the placement list): the room is a
   * content container. Entity ids resolve against the loaded collections at
   * load time. Omitted or empty = an empty room.
   */
  readonly objects?: readonly PlacementEntry[];
  /**
   * Room rules (four elements: rules): the gate map for the room itself —
   * what the host asks when ENTERING ("enter"), and — for the look
   * behaviour — whether a viewer PERCEIVES the room at all ("look", an
   * opt-in gate: absent means visible to whoever is there, and `default`
   * does not govern it, spec/03 §7.5). The room collection's accessType
   * vocabulary: "enter" / "look" per content.md, as opposed to the gate on
   * an exit, which guards traversal. Omitted = no gate. Refusal copy is
   * err_enter / err_look / err_default on this entry.
   */
  readonly preconditions?: AccessRules;
  /**
   * Refusal copy, keyed `err_<accessType>` and `err_default` (spec/02 §5.4)
   * — for rooms, the room's own enter and look gates. The engine's refusal
   * event only carries the errKey that locates these fields.
   */
  readonly [errKey: `err_${string}`]: string | undefined;
  /**
   * Membership in a dungeon (the RULE layer): rooms are the SPACE layer and
   * associate with dungeon/ entries by this field, not by directory nesting
   * (ADR-0016 §3). Open-world rooms omit it.
   */
  readonly zoneId?: string;
}

/**
 * An npc answers "who is it" (spec/03 §4): an interactable world entity —
 * shopkeeper, passerby, sect master. An npc that can also fight REFERENCES
 * its combat numbers by monsterId instead of copying them: the monster
 * collection answers "how hard does it hit", and a single source of truth
 * means no double maintenance (the reason ADR-0008 once rejected an npc
 * collection at all). Accordingly this shape carries no combat fields
 * whatsoever, and whether an npc can trigger a fight is exactly whether it
 * declares a monsterId.
 *
 * WHERE an npc stands is not part of the npc: rooms are the content
 * containers, and a room's placement list references the npc (spec/03 §2).
 */
export interface NpcEntry {
  /** Content id, immutable once released; the file name is the id. */
  readonly id: string;
  /** The persona's appearance name (what players see and target). */
  readonly name: string;
  /** Narrative description, style-guide bound. */
  readonly description: string;
  /**
   * The combat-numbers reference (spec/03 §4): a monster entry's id. The
   * registry validates it resolves when monsters are loaded. Declared ⇒ the
   * npc can trigger a fight; omitted ⇒ a non-combat figure (shopkeeper,
   * passerby). NEVER copy combat values here — reference, don't duplicate.
   */
  readonly monsterId?: string;
}
