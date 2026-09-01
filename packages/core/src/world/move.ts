import type { EventDraft } from "../command/pipeline.js";
import type { MoveHookContext, MoveInfo, MoveType } from "./entity.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * moveTo — the movement orchestration (spec/03 §7.1/§7.2, ADR-0028 §3):
 * the full hook chain and the position write, with ZERO permission checks.
 * Gates are the caller's business: the traversal adapter runs the exit's
 * traverse gate and the target room's enter gate BEFORE calling this, so a
 * teleport at login needs no gate and a future "give" can gate differently
 * — without every hook re-checking anything (the reason Evennia keeps
 * move_to lock-free).
 *
 * The chain, in order (all veto points precede all announcements):
 *
 *   at_pre_move (mover, veto)
 *   at_pre_object_leave (from container, veto)      } container hooks fire
 *   at_pre_object_receive (to container, veto)      } only when the location
 *   announce_move_from (to the old room's occupants) } is itself an entity;
 *   at_object_leave (from container)                 } rooms are content
 *   --- the position write (the tree's one choke point)
 *   announce_move_to (to the new room's occupants)
 *   at_object_receive (to container)
 *   at_post_move (mover)
 */

/** One move request: who, where to, why. */
export interface MoveRequest {
  readonly entityId: string;
  readonly toLocationId: string;
  readonly moveType: MoveType;
  /** The exit traversed, when the move is a traversal. */
  readonly viaExitId?: string;
}

/**
 * The emit port: how hooks' announcements leave the engine. The caller owns
 * stamping — the command pipeline stamps seq/actorId, a host driving a
 * system teleport stamps whatever its event stream needs.
 */
export interface MovePorts {
  emit(recipientId: string, draft: EventDraft): void;
}

/** Where a move aborted: which vetoable hook refused. */
export type MoveVetoStage = "at_pre_move" | "at_pre_object_leave" | "at_pre_object_receive";

export type MoveResult = { ok: true } | { ok: false; stage: MoveVetoStage };

export function moveTo(runtime: WorldRuntime, request: MoveRequest, ports: MovePorts): MoveResult {
  // Both halves of the entity — the hook carrier and the tree state — must
  // exist; addEntity creates them together, so divergence is a wiring bug.
  const entity = runtime.entity(request.entityId);
  const entityState = runtime.state.entities[request.entityId];
  if (entityState === undefined) {
    throw new Error(`moveTo: entity "${request.entityId}" has no state in the tree`);
  }
  const fromLocationId = entityState.locationId;
  const toLocationId = request.toLocationId;

  const toContainer = runtime.containerEntityOf(toLocationId);
  if (toContainer === undefined && !runtime.isRoom(toLocationId)) {
    throw new Error(
      `moveTo: target location "${toLocationId}" is neither a loaded room nor a registered entity`,
    );
  }
  const fromContainer = runtime.containerEntityOf(fromLocationId);

  const move: MoveInfo = {
    entityId: request.entityId,
    fromLocationId,
    toLocationId,
    moveType: request.moveType,
    ...(request.viaExitId !== undefined ? { viaExitId: request.viaExitId } : {}),
  };
  const hookContext: MoveHookContext = { move, emit: ports.emit };

  // Veto points first — an aborted move emits nothing and moves nobody.
  if (entity.at_pre_move?.(hookContext) === false) {
    return { ok: false, stage: "at_pre_move" };
  }
  if (fromContainer?.at_pre_object_leave?.(hookContext) === false) {
    return { ok: false, stage: "at_pre_object_leave" };
  }
  if (toContainer?.at_pre_object_receive?.(hookContext) === false) {
    return { ok: false, stage: "at_pre_object_receive" };
  }

  entity.announce_move_from?.({
    ...hookContext,
    receivers: runtime.occupantsOf(fromLocationId),
  });
  fromContainer?.at_object_leave?.(hookContext);

  // THE position write of a MOVE: the single place a location changes
  // through movement, so every query (occupancy, subjects) reads the same
  // truth the moment it happens. Direct state assignment remains available
  // to construction only (initial placement, loaded saves) — that is data,
  // not movement, and never announces.
  entityState.locationId = toLocationId;

  entity.announce_move_to?.({
    ...hookContext,
    receivers: runtime.occupantsOf(toLocationId),
  });
  toContainer?.at_object_receive?.(hookContext);
  entity.at_post_move?.(hookContext);

  return { ok: true };
}
