import type { EventDraft } from "../command/pipeline.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The message delivery seam (spec/03 §7.4, M2-T3): at_msg_receive is a
 * first-class citizen — "who is listening / who can be muted" is engine
 * structure, not an afterthought. This module is that structure's home:
 * broadcastMessage is THE delivery primitive that walks a location's
 * dynamic occupants one receiver at a time, asking each receiver's
 * at_msg_receive before emitting. say rides on it; other broadcast paths
 * (the movement announcements, ambient systems) may join the same seam in
 * later tickets so that muting works uniformly — today they emit
 * per-receiver on their own, and muting applies to what goes through here.
 *
 * Static presence never receives (ADR-0028 §1): a room's placement list is
 * content, not listeners — only the state tree's dynamic occupancy answers
 * "who hears this".
 */

/**
 * The emit port: how a delivered message leaves the engine. The caller owns
 * the stamping — the command pipeline stamps seq/actorId, a host driving a
 * system broadcast stamps whatever its event stream needs. (Structurally the
 * same seam as moveTo's MovePorts; named here because message delivery is
 * its own concept, with more consumers than movement.)
 */
export interface MessagePorts {
  emit(recipientId: string, draft: EventDraft): void;
}

/** One broadcast request: where, what, and — optionally — from whom. */
export interface BroadcastRequest {
  /**
   * The location whose dynamic occupants are the receivers: a room id or an
   * entity id (a container's insides hear what is said inside it). Must
   * resolve; an unresolvable id is a wiring bug and throws loudly.
   */
  readonly locationId: string;
  /**
   * The message's semantic payload — zero rendered text (spec/01 §5.1). The
   * SAME draft reaches every un-muted receiver; per-receiver rendering is
   * the renderer's business (non-goals B5), never render-then-broadcast.
   */
  readonly draft: EventDraft;
  /**
   * fromObj (spec/03 §7.4): the sending entity, when there is one. A
   * system message (ambient shift, server notice) has no sender — leave
   * this undefined and every receiver's at_msg_receive sees exactly that:
   * the mute decision runs on the full context either way.
   */
  readonly fromEntityId?: string;
}

/**
 * Delivers one semantic message to a location's dynamic occupants, one
 * receiver at a time (spec/03 §7.4): each receiver's at_msg_receive runs
 * first — an explicitly false return mutes THAT receiver alone, everyone
 * else unaffected — and only un-muted receivers get the emission. Receiver
 * order is occupantsOf's ascending id order, so the delivery sequence is
 * deterministic (ADR-0024 §2).
 */
export function broadcastMessage(
  runtime: WorldRuntime,
  request: BroadcastRequest,
  ports: MessagePorts,
): void {
  const { locationId, draft, fromEntityId } = request;
  if (!runtime.isRoom(locationId) && runtime.containerEntityOf(locationId) === undefined) {
    // Wiring bug, not play: a typo'd location would otherwise broadcast to
    // nobody in complete silence.
    throw new Error(
      `broadcastMessage: location "${locationId}" is neither a loaded room nor a registered entity`,
    );
  }
  for (const receiverId of runtime.occupantsOf(locationId)) {
    // addEntity creates the hook carrier and the tree state together, so
    // every occupant resolves — entity() here cannot throw.
    const receiver = runtime.entity(receiverId);
    const muted = receiver.at_msg_receive?.({ draft, fromEntityId, receiverId }) === false;
    if (!muted) {
      ports.emit(receiverId, draft);
    }
  }
}
