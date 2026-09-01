import type { EventDraft } from "../command/pipeline.js";

/**
 * The Entity interface and the movement hook family (spec/03 §7, ADR-0028).
 *
 * An Entity is a DYNAMIC OCCUPANT: something that holds mutable state (its
 * state lives in the one tree, spec/04 §1) and carries behaviour (these
 * hooks). M2 instantiates players only — NPCs are static presence, read
 * straight from room placement lists — but the interface is designed for
 * ANY entity: item containers, stateful NPCs, materialized rooms. The
 * kernel's completeness lives in these hooks, not in features (ADR-0027).
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
