import type { ContentRegistry } from "../content/registry.js";
import type { ConditionSubject } from "../conditions.js";
import type { EntityState, WorldState } from "../state/tree.js";
import type { Entity } from "./entity.js";

/**
 * The world runtime (ADR-0028): the live object a host dispatches against.
 * It joins three things —
 *
 *   the ContentRegistry   (immutable content: rooms, exits, npcs)
 *   the state tree        (spec/04 §1: dynamic occupants' mutable state)
 *   entity instances      (hook carriers; state is data, behaviour is code)
 *
 * and answers the queries the engine's own behaviours need: who occupies a
 * location, which entity (if any) IS a location's container, and what a
 * given entity looks like as a condition subject. The engine's factory
 * adapters (traversal today, look/say next) run against this interface;
 * hosts may drive it directly for system actions (teleports).
 */
export interface WorldRuntime {
  readonly registry: ContentRegistry;
  /** The one state tree — mutated in place; serialized by state/snapshot.ts. */
  readonly state: WorldState;

  /**
   * Registers an entity: its hook-carrying instance plus its seed state
   * (id, location, empty flags) in the tree. The location must resolve to a
   * loaded room or an already-registered entity (an entity can BE a
   * location — that is how get/give/drop container moves read). The entity
   * id must not collide with a room id: locations would be ambiguous.
   * CREATION's entry point — a restored save goes through the tree plus
   * attachEntity instead (M2-T5).
   */
  addEntity(entity: Entity, locationId: string): void;
  /**
   * THE LOAD PATH (M2-T5): re-attaches a hook-carrying instance to a state
   * the tree ALREADY holds, because a restored save adopted a whole tree.
   * No creation layer runs here — restore replays a tree, it does not
   * create (running at_object_creation on load would overwrite saved state
   * with code defaults). The tree must hold the state (restoreWorld first),
   * and the saved location must still resolve to a loaded room or to
   * another entity's state; that second check is order-independent on
   * purpose, so a carried entity may be attached before its carrier.
   */
  attachEntity(entity: Entity): void;
  /** The hook-carrying instance; unknown ids throw (wiring bug, not play). */
  entity(id: string): Entity;
  /** The entity's location, from the tree; unknown ids throw. */
  locationOf(id: string): string;
  /**
   * Dynamic occupants of a location, ids ascending — deterministic whatever
   * order entities were added in (ADR-0024 §2). Static presence (NPCs on a
   * room's placement list) is NOT here: it never consumes events
   * (ADR-0028).
   */
  occupantsOf(locationId: string): readonly string[];
  /**
   * The entity acting as this location's container, when the location names
   * a registered entity; rooms yield undefined (content, no hooks).
   */
  containerEntityOf(locationId: string): Entity | undefined;
  /** Whether the id names a room in the registry. */
  isRoom(locationId: string): boolean;
  /**
   * The entity as a condition subject (spec/02 §5.3): the engine's default
   * answers, read from the tree. Flags and location answer truly; the
   * facets whose slots have not landed yet (attrs, tags, states, skills)
   * answer "none" and grow in with their systems.
   */
  subjectOf(id: string): ConditionSubject;
}

export interface WorldRuntimeOptions {
  registry: ContentRegistry;
  /** A previously saved tree to adopt; default a fresh empty one. */
  state?: WorldState;
}

export function createWorldRuntime(options: WorldRuntimeOptions): WorldRuntime {
  const { registry } = options;
  const state: WorldState = options.state ?? { entities: {} };
  const instances = new Map<string, Entity>();

  const isRoom = (locationId: string): boolean =>
    registry.rooms.some((room) => room.id === locationId);

  const unknownEntity = (id: string): Error =>
    new Error(`world runtime: unknown entity id "${id}"`);

  const resolvableLocation = (locationId: string): boolean =>
    instances.has(locationId) || isRoom(locationId);

  /**
   * A location read back from a SAVE: a loaded room, or an entity whose
   * state the tree already holds — whether or not that entity's instance has
   * been attached yet, so attaching in any order works.
   */
  const resolvableRestoredLocation = (locationId: string): boolean =>
    isRoom(locationId) || state.entities[locationId] !== undefined;

  /** What is true of ANY instance's id, creation or restore alike. */
  const assertUsableId = (entity: Entity): void => {
    if (typeof entity.id !== "string" || entity.id === "") {
      throw new Error("world runtime: an entity with an empty id");
    }
    if (isRoom(entity.id)) {
      throw new Error(
        `world runtime: entity id "${entity.id}" collides with a room id — a location would be ambiguous`,
      );
    }
  };

  return {
    registry,
    state,
    addEntity(entity, locationId) {
      assertUsableId(entity);
      if (instances.has(entity.id) || state.entities[entity.id] !== undefined) {
        throw new Error(`world runtime: entity id "${entity.id}" added twice`);
      }
      if (!resolvableLocation(locationId)) {
        throw new Error(
          `world runtime: location "${locationId}" is neither a loaded room nor a registered entity`,
        );
      }
      instances.set(entity.id, entity);
      const entityState: EntityState = { id: entity.id, locationId, flags: [] };
      state.entities[entity.id] = entityState;
    },
    attachEntity(entity) {
      assertUsableId(entity);
      if (instances.has(entity.id)) {
        throw new Error(`world runtime: entity "${entity.id}" is attached twice`);
      }
      const entityState = state.entities[entity.id];
      if (entityState === undefined) {
        throw new Error(
          `world runtime: entity "${entity.id}" has no state in the tree — adopt a restored tree before attaching instances`,
        );
      }
      if (!resolvableRestoredLocation(entityState.locationId)) {
        throw new Error(
          `world runtime: restored entity "${entity.id}" sits in "${entityState.locationId}", which is neither a loaded room nor a state in the tree`,
        );
      }
      instances.set(entity.id, entity);
    },
    entity(id) {
      const found = instances.get(id);
      if (found === undefined) {
        throw unknownEntity(id);
      }
      return found;
    },
    locationOf(id) {
      const found = state.entities[id];
      if (found === undefined) {
        throw unknownEntity(id);
      }
      return found.locationId;
    },
    occupantsOf(locationId) {
      return Object.values(state.entities)
        .filter((entityState) => entityState.locationId === locationId)
        .map((entityState) => entityState.id)
        .sort();
    },
    containerEntityOf(locationId) {
      return instances.get(locationId);
    },
    isRoom,
    subjectOf(id) {
      const entityState = state.entities[id];
      if (entityState === undefined) {
        throw unknownEntity(id);
      }
      return {
        // Facets whose state slots have not landed yet answer "none" — they
        // turn on with their systems (tags M3, attrs/states/skills later).
        attr: () => undefined,
        hasTag: () => false,
        hasFlag: (flag) => entityState.flags.includes(flag),
        hasState: () => false,
        locationId: () => entityState.locationId,
        hasSkill: () => false,
      };
    },
  };
}
