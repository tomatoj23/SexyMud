import { defaultPredicateRegistry, evaluateCondition } from "../conditions.js";
import type { PredicateRegistry } from "../conditions.js";
import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandRejection, CommandSpec } from "../command/pipeline.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The look behaviour (spec/03 §7.5–§7.6, ADR-0028 §2): the engine's factory
 * look adapter and the two functions beneath it. Looking is a KERNEL
 * behaviour, shipped by the engine and driven by the world runtime plus the
 * content registry — a host binds lookSpec() to the cmd-look content entry
 * and a minimal world needs zero host-side game code. The injection seam
 * stays open: a host with special behaviour still passes its own func.
 *
 * Three layers, each with a fixed contract:
 *
 *   returnAppearance — the PURE assembly (a return_* function: returns
 *                      data, emits nothing, writes nothing). It is where
 *                      static presence (a room's placement list, read
 *                      straight from content) meets dynamic occupancy (the
 *                      state tree's positions) — the two halves of "who is
 *                      here" join nowhere else (ADR-0028 §1).
 *   atLook           — the visibility check lives HERE, never in the
 *                      command (spec/03 §7.6): an explicit "look" gate on
 *                      the room's preconditions decides whether the viewer
 *                      perceives the room at all.
 *   lookSpec         — the factory adapter: a content command entry bound
 *                      to the kernel behaviour through the same
 *                      commandSpecFromEntry assembly as every command.
 */

/** One exit as an appearance reports it: the edge's identity, direction label and verbs. */
export interface ExitDigest {
  readonly exitId: string;
  readonly direction: string;
  readonly verbs: readonly string[];
}

/** One entry of static presence: a placed content entity and how many of it the room holds. */
export interface StaticPresence {
  readonly id: string;
  readonly count: number;
}

/**
 * The assembled appearance of one room for one viewer (spec/03 §7.5): the
 * room's signboard and long description, its exits, and who is here through
 * BOTH presence channels — placement (content truth) and occupancy (state
 * truth). Pure data, not an event: name and description are content reads,
 * so hosts and renderers consume this directly (a room panel); the adapter's
 * EVENT projects only the semantic skeleton — ids and lists, never rendered
 * text (spec/01 §5.1).
 */
export interface RoomAppearance {
  readonly roomId: string;
  readonly name: string;
  readonly description: string;
  readonly exits: readonly ExitDigest[];
  readonly staticPresence: readonly StaticPresence[];
  /**
   * The dynamic occupants of the room besides the viewer, ids ascending —
   * the state tree's answer to "who else is here". The viewer is excluded
   * on purpose: a look answers what surrounds the viewer, and per-receiver
   * rendering turns each occupant into a name, never "you see yourself".
   */
  readonly occupants: readonly string[];
}

/**
 * return_appearance (spec/03 §7.5): the appearance assembly as a PURE
 * return — zero messages, zero writes, deterministic over (registry, tree,
 * room, viewer). Static presence is the placement list direct-read (NPCs are
 * not materialized, ADR-0028 §1); dynamic occupancy is the tree's position
 * index. An unknown roomId throws through the registry — a wiring bug, not
 * play.
 */
export function returnAppearance(
  runtime: WorldRuntime,
  roomId: string,
  viewerId: string,
): RoomAppearance {
  const room = runtime.registry.room(roomId);
  return {
    roomId: room.id,
    name: room.name,
    description: room.description,
    exits: room.exits.map((exit) => ({
      exitId: exit.id,
      direction: exit.direction,
      verbs: [...exit.verbs],
    })),
    staticPresence: (room.objects ?? []).map((placement) => ({
      id: placement.id,
      count: placement.count,
    })),
    occupants: runtime.occupantsOf(roomId).filter((id) => id !== viewerId),
  };
}

/** at_look's outcome: the assembled appearance, or the errKey locating the veil's copy. */
export type LookOutcome =
  | { readonly ok: true; readonly appearance: RoomAppearance }
  | { readonly ok: false; readonly errKey: "err_look" };

/**
 * at_look (spec/03 §7.6): the visibility check belongs HERE, not in the
 * command. A room may declare an explicit "look" gate among its
 * preconditions — perceiving the room is conditional (a dark cellar, a
 * glamour). The gate is OPT-IN: a room without a "look" key is visible to
 * whoever is there, and the rules' `default` does NOT govern look — default
 * expresses ENTRY policy (deny-by-default rooms), and letting it answer look
 * would darken every gated room for its own occupants. Evennia's view lock
 * works the same way: open unless declared.
 *
 * Visible ⇒ the pure appearance assembly; veiled ⇒ the errKey ("err_look")
 * that locates the room's refusal copy. Either way at_look emits nothing —
 * the adapter owns the emit port.
 */
export function atLook(
  runtime: WorldRuntime,
  roomId: string,
  viewerId: string,
  predicates: PredicateRegistry = defaultPredicateRegistry,
): LookOutcome {
  if (!runtime.isRoom(roomId)) {
    // Wiring-bug-shaped today: M2 players live in rooms, and looking inside
    // entity containers is the materialization ticket's business.
    throw new Error(
      `at_look: "${roomId}" is not a room — looking inside entity containers lands with materialization`,
    );
  }
  const room = runtime.registry.room(roomId);
  const veil = room.preconditions?.["look"];
  if (veil !== undefined && !evaluateCondition(veil, runtime.subjectOf(viewerId), predicates)) {
    return { ok: false, errKey: "err_look" };
  }
  return { ok: true, appearance: returnAppearance(runtime, roomId, viewerId) };
}

/**
 * The engine's factory look adapter (ADR-0028 §2): bind this to the look
 * command's content entry and `call()` runs the whole chain — verb table,
 * parse, this func. The behaviour:
 *
 *   1. atLook decides visibility (spec/03 §7.6) — the check is in the look
 *      behaviour, never in the command layer.
 *   2. Veiled ⇒ a CommandRejection whose commandRefused event carries the
 *      semantics that LOCATE the copy: commandKey (the command), accessType
 *      "look" and errKey (the room's err_look field), roomId (the room that
 *      veiled). The engine never words the refusal; the seq is consumed.
 *   3. Visible ⇒ ONE appearance event to the looker only: roomId, the exit
 *      list, static presence and dynamic occupancy. Room name, long
 *      description and every entity name stay in content data, reached by
 *      id through the registry — the event carries zero rendered text
 *      (spec/01 §5.1), and person stance (you / he / she) is the renderer's
 *      business per receiver.
 *
 * accessType "use" is the command collection's fixed gate vocabulary
 * (content.md) — the same way traversalSpec asks exits' "traverse" and
 * rooms' "enter"; "look" joins that fixed set as the rooms collection's
 * visibility word (opt-in gate, see atLook).
 */
export function lookSpec(entry: CommandEntry): CommandSpec<WorldRuntime> {
  if (entry.argForm !== "none") {
    // Wiring bug, not play: the kernel look behaviour looks at the actor's
    // current room and takes no arguments — an entry with an argument form
    // belongs to a different behaviour (target resolution is not M2's).
    throw new Error(
      `lookSpec: entry "${entry.id}" declares argForm "${entry.argForm}" — the kernel look behaviour takes no arguments`,
    );
  }
  return commandSpecFromEntry<WorldRuntime>(entry, {
    accessType: "use",
    func: (ctx) => {
      const runtime = ctx.world;
      const viewerId = ctx.command.actorId;
      const roomId = runtime.locationOf(viewerId);

      const look = atLook(runtime, roomId, viewerId, ctx.predicates);
      if (!look.ok) {
        ctx.emit(viewerId, {
          type: "commandRefused",
          reason: "notVisible",
          commandKey: entry.id,
          accessType: "look",
          errKey: look.errKey,
          roomId,
        });
        const rejection: CommandRejection = { kind: "rejected", reason: "notVisible" };
        return rejection;
      }

      const appearance = look.appearance;
      ctx.emit(viewerId, {
        type: "appearance",
        roomId: appearance.roomId,
        exits: appearance.exits,
        staticPresence: appearance.staticPresence,
        occupants: appearance.occupants,
      });
    },
  });
}
