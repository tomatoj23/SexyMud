import type {
  CommandEntry,
  ContentRegistryOptions,
  ContentRegistry,
  EffectEntry,
  NpcEntry,
  RenderContent,
  RoomEntry,
} from "@sexymud/core";
import { createContentRegistry } from "@sexymud/core";
import type { HostCopy } from "./hostCopy.js";

/**
 * The content pack loader (#51): parsed JSON files in, a validated registry
 * plus the RENDERER's injected content face out. The directory convention is
 * the same one `content:check` maps (spec/06): `commands/ rooms/ npcs/
 * monster/` are entry collections, `config/` holds the named tables
 * (`world`, `calendar`, `settings`, `dimensions`).
 *
 * Split from the session on purpose: the loader is pure over its inputs —
 * the browser feed (a vite glob over `content/`, eager) and the test feed
 * (files read off disk, the core tests' own precedent) both hand the SAME
 * parsed map to the SAME function, so the two paths cannot drift. The
 * engine sees none of this: it gets a registry it can check, never a
 * directory (ADR-0003).
 *
 * The RenderContent face is built HERE, mechanically, out of registry data
 * (#50 Q6: the host builds the copy face, the renderer reads no registry):
 * names/descriptions/enterTexts straight off entries, and the errCopy table
 * by folding every `err_*` field onto its dispatch key — an exit's key also
 * carries its TARGET room's enter face, because an enter-gate refusal names
 * the EXIT as commandKey while the copy lives on the ROOM (traverse.ts:
 * commandKey = exit.id, errKey = err_enter).
 */

/** The loaded pack: the registry plus the renderer's injected face. */
export interface LoadedPack {
  readonly registry: ContentRegistry;
  /**
   * The renderer's content face — complete EXCEPT the player's display
   * name, which only exists once a game starts; the session merges it in
   * (the actor id is fixed `player`, the name is a display field, #48 D4).
   */
  readonly render: RenderContent;
}

/** The registry's config-table options, keyed by config file name. */
const CONFIG_FILES = {
  "calendar.json": "calendar",
  "settings.json": "settings",
  "dimensions.json": "dimensions",
  "world.json": "world",
  "character.json": "character",
  "combat-tiers.json": "combatTiers",
} as const;

/** Entry-collection directory names → the registry option they feed. */
const COLLECTION_DIRS = {
  commands: "commands",
  rooms: "rooms",
  npcs: "npcs",
  monster: "monsters",
  effects: "effects",
} as const;

/** `…/content/<rel>` → `<rel>`, tolerating a path that is already relative. */
function relativeToContentRoot(path: string): string {
  const mark = path.lastIndexOf("content/");
  return mark === -1 ? path : path.slice(mark + "content/".length);
}

/** The `err_*` fields of one entry, as the errCopy row for its dispatch key. */
function errFieldsOf(entry: object): Record<string, string> {
  const row: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith("err_") && typeof value === "string") {
      row[key] = value;
    }
  }
  return row;
}

export function loadPack(
  files: Readonly<Record<string, unknown>>,
  copy: HostCopy,
): LoadedPack {
  const commands: CommandEntry[] = [];
  const rooms: RoomEntry[] = [];
  const npcs: NpcEntry[] = [];
  const monsters: { id: string }[] = [];
  const effects: EffectEntry[] = [];
  const config: Record<string, unknown> = {};
  for (const [path, parsed] of Object.entries(files)) {
    const [dir, fileName] = relativeToContentRoot(path).split("/");
    if (dir === undefined || fileName === undefined) {
      throw new Error(`pack loader: "${path}" does not sit inside a content/ collection`);
    }
    if (dir === "config") {
      const key = CONFIG_FILES[fileName as keyof typeof CONFIG_FILES];
      if (key === undefined) {
        // A config file no registry table consumes yet (display-tiers) —
        // its ticket adds the row above when the consumer lands.
        continue;
      }
      config[key] = parsed;
      continue;
    }
    const option = COLLECTION_DIRS[dir as keyof typeof COLLECTION_DIRS];
    if (option === undefined) {
      throw new Error(`pack loader: "${path}" sits in no known content collection`);
    }
    if (option === "commands") commands.push(parsed as CommandEntry);
    else if (option === "rooms") rooms.push(parsed as RoomEntry);
    else if (option === "npcs") npcs.push(parsed as NpcEntry);
    else if (option === "effects") effects.push(parsed as EffectEntry);
    else monsters.push(parsed as { id: string });
  }

  const registry = createContentRegistry(
    { commands, rooms, npcs, monsters, effects },
    {
      calendar: config.calendar as ContentRegistryOptions["calendar"],
      settings: config.settings as ContentRegistryOptions["settings"],
      dimensions: config.dimensions as ContentRegistryOptions["dimensions"],
      world: config.world as ContentRegistryOptions["world"],
      character: config.character as ContentRegistryOptions["character"],
      combatTiers: config.combatTiers as ContentRegistryOptions["combatTiers"],
    },
  );

  const names: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const enterTexts: Record<string, string> = {};
  const errCopy: Record<string, Readonly<Record<string, string>>> = {};
  for (const npc of registry.npcs) {
    names[npc.id] = npc.name;
  }
  for (const room of registry.rooms) {
    names[room.id] = room.name;
    descriptions[room.id] = room.description;
    if (room.enterText !== undefined && room.enterText !== "") {
      enterTexts[room.id] = room.enterText;
    }
    for (const exit of room.exits) {
      names[exit.id] = exit.direction;
      // An enter-gate refusal names the exit as commandKey while the copy
      // lives on the TARGET room — so the target's enter face rides onto the
      // exit's key, under the exit's own copy (the traverse gate is checked
      // first, so the exit's words win a colliding err_default).
      const target = registry.room(exit.targetRoomId);
      errCopy[exit.id] = { ...errFieldsOf(target), ...errFieldsOf(exit) };
    }
  }
  for (const command of registry.commands) {
    errCopy[command.id] = errFieldsOf(command);
  }

  return {
    registry,
    render: {
      copy: copy.render,
      names,
      descriptions,
      enterTexts,
      errCopy,
      reasonCopy: copy.reasonCopy,
    },
  };
}
