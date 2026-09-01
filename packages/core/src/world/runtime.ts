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
  /** The one state tree — mutated in place; serialization lands with M2-T5. */
  readonly state: WorldState;

  /**
   * Registers an entity: its hook-carrying instance plus its seed state
   * (id, location, empty flags) in the tree. The location must resolve to a
   * loaded room or an already-registered entity (an entity can BE a
   * location — that is how get/give/drop container moves will read). The
   * entity id must not collide with a room id: locations would be
   * ambiguous. Loading a saved tree and re-attaching instances is M2-T5's
   * path, not this one.
   */
  addEntity(entity: Entity, locationId: string): void;
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

  return {
    registry,
    state,
    addEntity(entity, locationId) {
      if (typeof entity.id !== "string" || entity.id === "") {
        throw new Error("world runtime: an entity with an empty id");
      }
      if (isRoom(entity.id)) {
        throw new Error(
          `world runtime: entity id "${entity.id}" collides with a room id — a location would be ambiguous`,
        );
      }
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
