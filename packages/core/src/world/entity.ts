import type { CmdSetSource } from "../command/cmdset.js";
import type { EventDraft } from "../command/pipeline.js";
import type { EntityState } from "../state/tree.js";

/**
 * The Entity interface and its hook families (spec/03 §7, ADR-0028).
 *
 * An Entity is a DYNAMIC OCCUPANT: something that holds mutable state (its
 * state lives in the one tree, spec/04 §1) and carries behaviour (these
 * hooks). M2 instantiates players only — NPCs are static presence, read
 * straight from room placement lists — but the interface is designed for
 * ANY entity: item containers, stateful NPCs, materialized rooms. The
 * kernel's completeness lives in these hooks, not in features (ADR-0027).
 *
 * Six families live here: the movement family (at_pre_move through
 * at_object_receive, M2-T1), the message receiver (at_msg_receive, M2-T3),
 * the say pair (at_pre_say / at_post_say, M2-T3), the transfer pairs
 * (at_pre_get/give/drop + at_post_* — the seams the future item system
 * rides, M2-T4), the creation two-layer (at_object_creation seeds code
 * defaults, at_object_post_creation lets JSON content override them, M2-T4)
 * and the dynamic cmdset hook (at_cmdset_get, M2-T4).
 *
 * Naming follows the Evennia convention the spec pins (spec/03 §7): `at_*`
 * hook, `at_pre_*` vetoable by returning an explicit false, `at_post_*`
 * after-the-fact notification, `announce_*` broadcast. A void return is NOT
 * a veto — only an explicit false aborts (the pipeline's at_pre_cmd rule).
 */

/**
 * WHY a move happens — engine semantics, fixed on day one (spec/03 §7.1):
 * without this field the same movement path can never again split its
 * narrative by cause.
 *
 *   teleport — system-driven relocation (login, quest, punishment)
 *   traverse — walking an exit
 *   get      — room → container (picking up)
 *   give     — entity → entity (handing over)
 *   drop     — container → room (putting down)
 */
export const MOVE_TYPES = ["teleport", "traverse", "get", "give", "drop"] as const;

export type MoveType = (typeof MOVE_TYPES)[number];

/** Everything a movement hook knows about one move. */
export interface MoveInfo {
  readonly entityId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly moveType: MoveType;
  /** The exit traversed, when the move is a traversal; absent otherwise. */
  readonly viaExitId?: string;
}

/**
 * What every movement hook runs against: the move, plus the emit port for
 * semantic events. Hooks never render — they emit EventDrafts, and the
 * caller (command pipeline, host) stamps seq/actorId.
 */
export interface MoveHookContext {
  readonly move: MoveInfo;
  emit(recipientId: string, draft: EventDraft): void;
}

/**
 * The announce hooks' context: additionally the receivers — the dynamic
 * occupants of the addressed location, ids ascending. Rendering is
 * per-receiver (non-goals B5): the SAME event reaches each receiver and the
 * renderer decides person and visibility — never render-then-broadcast.
 */
export interface AnnounceMoveContext extends MoveHookContext {
  readonly receivers: readonly string[];
}

/**
 * An entity: identity plus behaviour. All hooks are optional; the engine's
 * defaults (see createEntity) provide the announce pair, and a mover with
 * no pre hooks never vetoes. Container-side hooks fire when the FROM or TO
 * location is itself an entity (a container); rooms are content and carry
 * no hooks.
 */
export interface Entity {
  readonly id: string;
  /** Mover side: vetoable before anything happens. */
  at_pre_move?(ctx: MoveHookContext): boolean | void;
  /** Mover side: announce the departure to the OLD location's occupants. */
  announce_move_from?(ctx: AnnounceMoveContext): void;
  /** Mover side: announce the arrival to the NEW location's occupants. */
  announce_move_to?(ctx: AnnounceMoveContext): void;
  /** Mover side: after-the-fact notification, post-relocation. */
  at_post_move?(ctx: MoveHookContext): void;
  /** Container side: the entity acting as the FROM location vetoes the departure. */
  at_pre_object_leave?(ctx: MoveHookContext): boolean | void;
  /** Container side: the entity acting as the TO location vetoes the reception. */
  at_pre_object_receive?(ctx: MoveHookContext): boolean | void;
  /** Container side: after the occupant left. */
  at_object_leave?(ctx: MoveHookContext): void;
  /** Container side: after the occupant arrived. */
  at_object_receive?(ctx: MoveHookContext): void;
  /**
   * Receiver side (spec/03 §7.4): veto THIS message by returning an
   * explicitly false — that one receiver hears nothing, everyone else
   * unaffected. "Who is listening / who can be muted" is a first-class
   * citizen of the engine, not an afterthought: muting, deafness effects
   * and distance filters all hang on this one hook. Runs once per
   * receiver, inside broadcastMessage (see message.ts) — say delivers
   * through it today; other broadcast paths (the movement announcements)
   * emit per-receiver on their own for now and may join that seam in a
   * later ticket.
   */
  at_msg_receive?(ctx: MsgReceiveContext): boolean | void;
  /** Speaker side (spec/03 §7.7's say half): vetoable before anything is broadcast. */
  at_pre_say?(ctx: SayHookContext): boolean | void;
  /** Speaker side (spec/03 §7.7's say half): after-the-fact notification, post-broadcast. */
  at_post_say?(ctx: SayHookContext): void;
  /**
   * Transferred-entity side (spec/03 §7.7's get half, M2-T4): THIS entity is
   * about to be picked up. Vetoable before the movement chain runs — the
   * behaviour-level refusal ("too heavy to lift") precedes at_pre_move and
   * everything beneath it.
   */
  at_pre_get?(ctx: GetHookContext): boolean | void;
  /** Transferred-entity side: after the pickup completed (post-move notification). */
  at_post_get?(ctx: GetHookContext): void;
  /**
   * Transferred-entity side (spec/03 §7.7's give half, M2-T4): THIS entity is
   * about to be handed from one entity to another. The two parties' own
   * vetoes are the movement chain's container hooks (at_pre_object_leave on
   * the giver, at_pre_object_receive on the receiver) — three refusal points
   * around one handover.
   */
  at_pre_give?(ctx: GiveHookContext): boolean | void;
  /** Transferred-entity side: after the handover completed. */
  at_post_give?(ctx: GiveHookContext): void;
  /**
   * Transferred-entity side (spec/03 §7.7's drop half, M2-T4): THIS entity is
   * about to be put down at its holder's location.
   */
  at_pre_drop?(ctx: DropHookContext): boolean | void;
  /** Transferred-entity side: after the entity was put down. */
  at_post_drop?(ctx: DropHookContext): void;
  /**
   * Creation layer one (spec/03 §7.8, M2-T4): seed the CODE defaults onto the
   * entity's fresh tree state. Runs first, inside createObject — the whole
   * point of the two-layer seam is that whatever happens next can override.
   */
  at_object_creation?(ctx: CreationHookContext): void;
  /**
   * Creation layer two (spec/03 §7.8, M2-T4): apply the JSON CONTENT over the
   * code defaults. Runs second, after at_object_creation — reverse the order
   * and content can never win over the defaults. Today the host applies its
   * content here; the materialization ticket (items, stateful NPCs) turns
   * that application into an engine factory, on this same seam.
   */
  at_object_post_creation?(ctx: CreationHookContext): void;
  /**
   * The dynamic cmdset hook (spec/03 §7.9, Evennia's at_cmdset_get, M2-T4):
   * asked ON EVERY DISPATCH, with the entity's live state and the host's
   * assembled base sources in hand — return the adjusted sources (filtered,
   * extended, reordered: a silenced entity drops verbs, an empowered one
   * gains them). A void return passes the base sources through untouched.
   * The engine keeps no cache: state changes surface on the next dispatch.
   */
  at_cmdset_get?(ctx: CmdsetHookContext): readonly CmdSetSource[] | void;
}

/**
 * What at_msg_receive sees (spec/03 §7.4): the message's semantic payload
 * plus the sender, when there is one. fromEntityId is deliberately nullable
 * — a system message (an ambient shift, a server notice) has no sender
 * entity, and Evennia's from_obj=None marks exactly the same case. Muting
 * decisions get the full context: draft (zero rendered text), who it is
 * from, and which receiver is being asked (the hook runs per receiver).
 */
export interface MsgReceiveContext {
  /** The message's semantic payload — never rendered text (spec/01 §5.1). */
  readonly draft: EventDraft;
  /** The sending entity's id, or undefined for a senderless system message. */
  readonly fromEntityId: string | undefined;
  /** The receiver being asked — the hook runs once per receiver. */
  readonly receiverId: string;
}

/**
 * What every say-family hook runs against (spec/03 §7.7's say half): who
 * speaks, where, what — plus the emit port, so a hook may emit its own
 * semantic events (the movement family's MoveHookContext carries the same
 * seam). Hooks never render; they emit EventDrafts and the caller stamps
 * seq/actorId.
 */
export interface SayHookContext {
  readonly speakerId: string;
  readonly locationId: string;
  readonly text: string;
  emit(recipientId: string, draft: EventDraft): void;
}

/**
 * What the get-family hooks see (spec/03 §7.7's get half): the transferred
 * entity (the hook's host), who picks it up — the move's destination IS the
 * getter — and where it lies right now, plus the emit port (a hook may emit
 * its own semantic events, the same seam every hook family carries).
 */
export interface GetHookContext {
  readonly entityId: string;
  readonly getterId: string;
  readonly fromLocationId: string;
  emit(recipientId: string, draft: EventDraft): void;
}

/**
 * What the give-family hooks see (spec/03 §7.7's give half): the
 * transferred entity plus BOTH parties — give is the one transfer with a
 * second hand. The movement's from/to are the giver and the receiver
 * themselves (entities as containers).
 */
export interface GiveHookContext {
  readonly entityId: string;
  readonly giverId: string;
  readonly receiverId: string;
  emit(recipientId: string, draft: EventDraft): void;
}

/**
 * What the drop-family hooks see (spec/03 §7.7's drop half): the
 * transferred entity, who puts it down, and where it lands — the dropper's
 * own location, whatever that is (a room, or another container: dropping
 * while inside a chest drops into the chest).
 */
export interface DropHookContext {
  readonly entityId: string;
  readonly dropperId: string;
  readonly toLocationId: string;
  emit(recipientId: string, draft: EventDraft): void;
}

/**
 * What both creation layers see (spec/03 §7.8): the entity's state in the
 * tree, WRITABLE — seeding that state is creation's entire job. Layer one
 * (at_object_creation) writes code defaults; layer two
 * (at_object_post_creation) applies JSON content over them. The emit port
 * lets either layer announce (an objectCreated event, a spawn flourish).
 */
export interface CreationHookContext {
  readonly entityId: string;
  state: EntityState;
  emit(recipientId: string, draft: EventDraft): void;
}

/**
 * What at_cmdset_get sees (spec/03 §7.9): the entity's live state — flags
 * and location read from the tree, the facets state-driven filtering needs —
 * plus the base sources the host assembled for this dispatch (content
 * commands, this room's exits). The hook returns adjusted sources or void
 * for "as assembled"; see assembleSources (world/cmdset.ts), the seam's
 * single entry point.
 */
export interface CmdsetHookContext {
  readonly entityId: string;
  readonly locationId: string;
  readonly flags: readonly string[];
  readonly sources: readonly CmdSetSource[];
}

/** The hook surface without identity — what createEntity overrides. */
export type EntityHooks = Omit<Entity, "id">;

/** The semantic shape of one movement announcement, shared by both directions. */
function announceDraft(type: "departed" | "arrived", move: MoveInfo): EventDraft {
  return {
    type,
    entityId: move.entityId,
    fromLocationId: move.fromLocationId,
    toLocationId: move.toLocationId,
    moveType: move.moveType,
    viaExitId: move.viaExitId,
  };
}

/**
 * Builds one of the engine's default announcements: the same semantic
 * event, emitted once per receiver — the occupants of the addressed room,
 * mover included (per-receiver rendering makes the same event read as
 * "you" for the mover and as a name for everyone else).
 */
function defaultAnnounce(type: "departed" | "arrived"): (ctx: AnnounceMoveContext) => void {
  return (ctx) => {
    const draft = announceDraft(type, ctx.move);
    for (const receiver of ctx.receivers) {
      ctx.emit(receiver, draft);
    }
  };
}

/** The default departure announcement. */
const defaultAnnounceMoveFrom = defaultAnnounce("departed");

/** The default arrival announcement. */
const defaultAnnounceMoveTo = defaultAnnounce("arrived");

/**
 * Builds an entity with the engine's default behaviour: both announce hooks
 * emit per-receiver semantic events; no pre hooks (a default entity never
 * vetoes). `overrides` replace hooks one by one — tests and hosts use this
 * to observe or veto movement, future materialized entity kinds to vary
 * behaviour wholesale. The player is the first consumer; nothing here is
 * player-specific.
 */
export function createEntity(id: string, overrides: Partial<EntityHooks> = {}): Entity {
  return {
    id,
    announce_move_from: defaultAnnounceMoveFrom,
    announce_move_to: defaultAnnounceMoveTo,
    ...overrides,
  };
}
