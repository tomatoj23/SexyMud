import type { EventDraft } from "../command/pipeline.js";
import type { CreationHookContext } from "./entity.js";
import type { Entity } from "./entity.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The creation two-layer seam (spec/03 §7.8, M2-T4): createObject registers
 * an entity into the world and runs the two creation layers, IN THAT ORDER —
 *
 *   at_object_creation        layer one: the CODE defaults, seeded onto the
 *                              entity's fresh tree state
 *   at_object_post_creation   layer two: the JSON CONTENT applied over them
 *
 * The order is the whole contract. Reverse it and the code defaults land
 * after the content, overwriting it — JSON content could never win, and
 * every content pack would ship its values into a black hole. Layer two
 * runs with the defaults already visible in the state, so an override is a
 * decision made in full knowledge of what it overrides.
 *
 * Seams first (issue #10): the engine guarantees the two layers and their
 * order, nothing more. WHAT the content is — which fields, from which
 * entry — is the host's affair today; the materialization ticket (items,
 * stateful NPCs) will turn "apply this content entry's data" into an engine
 * factory built on this same seam, and the first real consumers arrive with
 * it. A save-loading path does NOT come through here: adoption replays a
 * tree, it does not create entities (M2-T5's business, not creation's).
 */

/**
 * The emit port: how the creation layers' events leave the engine. Creation
 * announces nothing by default — an objectCreated event or a spawn flourish
 * is a hook's choice, never the orchestration's (the caller owns stamping,
 * the same seam as every ports type; independently named because creation is
 * its own concept, the way MovePorts and TransferPorts are — say reuses
 * MessagePorts instead, the established split in this family).
 */
export interface CreationPorts {
  emit(recipientId: string, draft: EventDraft): void;
}

/** One creation: the hook-carrying instance, and where it starts existing. */
export interface CreationRequest {
  readonly entity: Entity;
  readonly locationId: string;
}

/**
 * createObject — register the entity (addEntity: hook instance + seed state
 * in the tree, position resolvable or it throws loudly — a wiring bug, not
 * play), then run the two creation layers against that state. Neither layer
 * vetoes: creation has no refusal semantics, only seeding order. Returns
 * nothing — the state lives in the tree and every query reads it there.
 */
export function createObject(
  runtime: WorldRuntime,
  request: CreationRequest,
  ports: CreationPorts,
): void {
  runtime.addEntity(request.entity, request.locationId);
  // addEntity wrote the seed state in the same breath as the instance —
  // the lookup cannot miss; the non-null assertion documents that pairing.
  const state = runtime.state.entities[request.entity.id]!;
  const hookContext: CreationHookContext = {
    entityId: request.entity.id,
    state,
    emit: ports.emit,
  };

  request.entity.at_object_creation?.(hookContext);
  request.entity.at_object_post_creation?.(hookContext);
}
