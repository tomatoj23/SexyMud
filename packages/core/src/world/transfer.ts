import type { EventDraft } from "../command/pipeline.js";
import type { DropHookContext, GetHookContext, GiveHookContext } from "./entity.js";
import { moveTo } from "./move.js";
import type { MoveVetoStage } from "./move.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The transfer behaviours (spec/03 §7.7's transfer half, M2-T4): get / give /
 * drop — the three movements of possession, each a thin behaviour-layer
 * sandwich AROUND moveTo. Seams first, features later (issue #10): there is
 * no item system yet, so these take explicit ids and do no target
 * resolution, no permission checks, no inventory bookkeeping — the command
 * layer gates, a future item system decides, and these orchestrations carry
 * only the HOOK ORDER that later cannot be retrofitted:
 *
 *   at_pre_get/give/drop  (transferred entity, veto — precedes the movement
 *                          chain, so a refusal costs nothing)
 *   moveTo("get"/"give"/"drop")  — M2-T1's full chain: at_pre_move, the two
 *                          container vetoes (the getter / the giver / the
 *                          receiver / the dropper — whichever ends are
 *                          entities), the announces, the position write,
 *                          at_post_move. The announcements carry the
 *                          moveType, so a renderer words "picked up"
 *                          differently from "walked away" with zero engine
 *                          changes (spec/03 §7.1's payoff).
 *   at_post_get/give/drop (transferred entity, after the fact)
 *
 * Evennia's default get/give/drop commands follow exactly this shape
 * (at_pre_* → move_to → at_get/give/drop); the difference is ours runs the
 * per-receiver semantic-event discipline throughout.
 *
 * The veto stages are the union of the behaviour-level hook and whatever
 * the movement chain beneath can refuse — a container's refusal surfaces
 * here as a failed transfer with the refusing stage named.
 */

/**
 * The emit port: how hooks' events leave the engine (the caller owns the
 * stamping — structurally the same seam as MovePorts / MessagePorts, named
 * here because a transfer is its own concept).
 */
export interface TransferPorts {
  emit(recipientId: string, draft: EventDraft): void;
}

/** One pickup: which entity, picked up by whom. */
export interface GetRequest {
  readonly entityId: string;
  readonly getterId: string;
}

/** One handover: which entity, from whom, to whom. */
export interface GiveRequest {
  readonly entityId: string;
  readonly giverId: string;
  readonly receiverId: string;
}

/** One putdown: which entity, put down by whom (at the dropper's location). */
export interface DropRequest {
  readonly entityId: string;
  readonly dropperId: string;
}

/** Where a pickup aborted: the behaviour hook, or the movement chain beneath. */
export type GetVetoStage = "at_pre_get" | MoveVetoStage;
/** Where a handover aborted: the behaviour hook, or the movement chain beneath. */
export type GiveVetoStage = "at_pre_give" | MoveVetoStage;
/** Where a putdown aborted: the behaviour hook, or the movement chain beneath. */
export type DropVetoStage = "at_pre_drop" | MoveVetoStage;

export type GetResult = { ok: true } | { ok: false; stage: GetVetoStage };
export type GiveResult = { ok: true } | { ok: false; stage: GiveVetoStage };
export type DropResult = { ok: true } | { ok: false; stage: DropVetoStage };

/**
 * get — the pickup orchestration: at_pre_get (the transferred entity's veto,
 * before anything happens) → moveTo("get") into the getter (an entity IS the
 * destination — locations and containers are the same concept) → at_post_get.
 * Zero permission checks: whether the getter may take this, whether the
 * object is reachable, is the command layer's gate, never re-checked here
 * (the moveTo rule, spec/03 §7.2).
 */
export function getObject(
  runtime: WorldRuntime,
  request: GetRequest,
  ports: TransferPorts,
): GetResult {
  const entity = runtime.entity(request.entityId);
  const fromLocationId = runtime.locationOf(request.entityId);
  const hookContext: GetHookContext = {
    entityId: request.entityId,
    getterId: request.getterId,
    fromLocationId,
    emit: ports.emit,
  };

  if (entity.at_pre_get?.(hookContext) === false) {
    return { ok: false, stage: "at_pre_get" };
  }

  const move = moveTo(
    runtime,
    { entityId: request.entityId, toLocationId: request.getterId, moveType: "get" },
    ports,
  );
  if (!move.ok) {
    return move;
  }

  entity.at_post_get?.(hookContext);
  return { ok: true };
}

/**
 * give — the handover orchestration: at_pre_give (the transferred entity's
 * veto) → moveTo("give") from the giver to the receiver (both entities, so
 * the movement chain asks each side's container hooks — the giver may refuse
 * to part with it, the receiver to accept it) → at_post_give. Three refusal
 * points around one handover, each naming its own stage.
 */
export function giveObject(
  runtime: WorldRuntime,
  request: GiveRequest,
  ports: TransferPorts,
): GiveResult {
  const entity = runtime.entity(request.entityId);
  const hookContext: GiveHookContext = {
    entityId: request.entityId,
    giverId: request.giverId,
    receiverId: request.receiverId,
    emit: ports.emit,
  };

  if (entity.at_pre_give?.(hookContext) === false) {
    return { ok: false, stage: "at_pre_give" };
  }

  const move = moveTo(
    runtime,
    { entityId: request.entityId, toLocationId: request.receiverId, moveType: "give" },
    ports,
  );
  if (!move.ok) {
    return move;
  }

  entity.at_post_give?.(hookContext);
  return { ok: true };
}

/**
 * drop — the putdown orchestration: at_pre_drop (the transferred entity's
 * veto) → moveTo("drop") to the DROPPER'S location (wherever the dropper
 * stands — a room, or another container: dropping inside a chest drops into
 * the chest) → at_post_drop. Whether the dropper actually holds the entity
 * is a command-layer gate; this orchestration moves what it is told to move.
 */
export function dropObject(
  runtime: WorldRuntime,
  request: DropRequest,
  ports: TransferPorts,
): DropResult {
  const entity = runtime.entity(request.entityId);
  const toLocationId = runtime.locationOf(request.dropperId);
  const hookContext: DropHookContext = {
    entityId: request.entityId,
    dropperId: request.dropperId,
    toLocationId,
    emit: ports.emit,
  };

  if (entity.at_pre_drop?.(hookContext) === false) {
    return { ok: false, stage: "at_pre_drop" };
  }

  const move = moveTo(
    runtime,
    { entityId: request.entityId, toLocationId, moveType: "drop" },
    ports,
  );
  if (!move.ok) {
    return move;
  }

  entity.at_post_drop?.(hookContext);
  return { ok: true };
}
