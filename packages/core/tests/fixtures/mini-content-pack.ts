import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandEntry } from "../../src/command/entry.js";
import { createContentRegistry } from "../../src/content/registry.js";
import type {
  ContentRegistry,
  DimensionTable,
  MonsterRecord,
} from "../../src/content/registry.js";
import type { NpcEntry, RoomEntry } from "../../src/world/entry.js";
import type { Calendar, SettingsTable } from "../../src/content/config.js";

/**
 * The second content pack (issue #12, spec/00 acceptance criterion 2):
 * 「换一套非武侠内容，引擎不改一行代码」. acceptance criterion 2 becomes
 * mechanical only if a SECOND, non-wuxia pack actually runs, so this fixture
 * is a whole pack on disk — one JSON file per entry, filename = id, exactly
 * the shapes `schemas/` gates — and NOT a TypeScript object graph: the point
 * is the loading path, not the data.
 *
 * The theme is a near-orbit lighthouse station. Deliberately nothing a wuxia
 * pack would own: the direction words are 前/后/内/外 rather than 北/南/东/西,
 * the look command is `cmd-scan`（环视）, the say command is `cmd-broadcast`
 * （通话）— different ids, different verbs, same engine adapters.
 *
 * The loaders below are pack-agnostic on purpose: the shipped wuxia pack
 * (`content/`) and this one go through the SAME function, so "swap the pack"
 * is literally "swap the directory".
 */

/** The mini pack's root: commands/ rooms/ npcs/ config/ underneath, as in content/. */
export const MINI_PACK_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "mini-pack",
);

/**
 * One collection, one JSON file per entry (content.md). Missing directories
 * are simply absent collections — a pack loads what it has, and the registry
 * is what decides whether the references still resolve.
 */
function readCollection(rootDir: string, name: string): string[] {
  const dir = join(rootDir, name);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => readFileSync(join(dir, fileName), "utf8"));
}

/**
 * The pack's dimensions table (config/dimensions.json), when it declares one.
 *
 * It travels WITH the pack: which dimensions exist is the pack's business and
 * the engine never imports one (ADR-0029 §5, spec/03 §5.1), so the loader
 * that finds rooms/ finds config/ too and hands the table to the registry —
 * "swap the pack" swaps the vocabulary tags are closed against. A pack with
 * no such file loads with no table, and the closure is then skipped, exactly
 * as it is for a host that declines to pass one.
 */
/**
 * Any config table a pack declares (`config/<name>.json`), by name. The
 * calendar travels with the pack for the same reason the dimensions table
 * does (ADR-0032 §3): it IS the pack's calendar, so "swap the directory"
 * swaps the calendar too — the lighthouse station does not answer questions
 * about shichen. A pack with no such file loads with none, and the engine
 * side then fails loudly the first time anyone asks for the time.
 */
function readConfig<T>(rootDir: string, name: string): T | undefined {
  const file = join(rootDir, "config", `${name}.json`);
  if (!existsSync(file)) {
    return undefined;
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readDimensions(rootDir: string): DimensionTable | undefined {
  return readConfig<DimensionTable>(rootDir, "dimensions");
}

/** The four collections a host hands the registry, plus the pack's raw text. */
export interface LoadedPack {
  readonly commands: readonly CommandEntry[];
  readonly rooms: readonly RoomEntry[];
  readonly npcs: readonly NpcEntry[];
  readonly monsters: readonly MonsterRecord[];
  /** The pack's own dimensions table (config/dimensions.json), when it has one. */
  readonly dimensions?: DimensionTable;
  /** The pack's own calendar (config/calendar.json), when it has one. */
  readonly calendar?: Calendar;
  /** The pack's own tuning numbers (config/settings.json), when it has one. */
  readonly settings?: SettingsTable;
  /**
   * Every file's raw JSON text, concatenated. A pack's theme lives in its
   * copy as much as in its verbs, so the "no other pack's vocabulary" scan
   * reads the data too, not only the event stream.
   */
  readonly text: string;
}

export function loadPack(rootDir: string): LoadedPack {
  const commandTexts = readCollection(rootDir, "commands");
  const roomTexts = readCollection(rootDir, "rooms");
  const npcTexts = readCollection(rootDir, "npcs");
  const monsterTexts = readCollection(rootDir, "monster");
  const configTexts = readCollection(rootDir, "config");
  return {
    commands: commandTexts.map((text) => JSON.parse(text) as CommandEntry),
    rooms: roomTexts.map((text) => JSON.parse(text) as RoomEntry),
    npcs: npcTexts.map((text) => JSON.parse(text) as NpcEntry),
    monsters: monsterTexts.map((text) => JSON.parse(text) as MonsterRecord),
    dimensions: readDimensions(rootDir),
    calendar: readConfig<Calendar>(rootDir, "calendar"),
    settings: readConfig<SettingsTable>(rootDir, "settings"),
    text: [...commandTexts, ...roomTexts, ...npcTexts, ...monsterTexts, ...configTexts].join("\n"),
  };
}

/**
 * The one assembly path every host walks: files → registry. Referential
 * integrity (dangling exits, placements, monsterIds, duplicate ids) is part
 * of it, and it is pack-neutral — the same call loads the wuxia pack.
 */
export function packRegistry(rootDir: string): ContentRegistry {
  const pack = loadPack(rootDir);
  return createContentRegistry(
    {
      commands: pack.commands,
      rooms: pack.rooms,
      npcs: pack.npcs,
      monsters: pack.monsters,
    },
    // The config tables travel WITH the pack (ADR-0029 §5, ADR-0032 §3): the
    // same loader that finds rooms/ finds config/, so swapping the directory
    // swaps the tag vocabulary AND the calendar AND the tuning numbers. A
    // pack with none hands over `undefined`, and the corresponding checks are
    // then skipped — missing tables fail at first USE, not here.
    { dimensions: pack.dimensions, calendar: pack.calendar, settings: pack.settings },
  );
}

/**
 * What a pack OWNS, as strings: its verbs, its direction words, its display
 * names and its ids. The engine knows none of these; a pack is exactly the
 * set of them, which is what makes "does pack A leak into pack B's session"
 * a mechanical question instead of a judgement call.
 *
 * ASCII verbs (the English abbreviations) are excluded: single letters like
 * "n" or "e" are substrings of half the JSON in any transcript, so they
 * would match everything and prove nothing. Ids are kept in their own
 * bucket — lowercase ASCII, but a pack's id IS its identity.
 */
export interface PackVocabulary {
  /** Theme-bearing strings the CJK test kept: verbs, directions, names. */
  readonly words: readonly string[];
  /** Entry ids: commands, rooms, exits, npcs, monsters. */
  readonly ids: readonly string[];
}

const CJK = /[\u4e00-\u9fff]/;

export function packVocabulary(registry: ContentRegistry): PackVocabulary {
  const words = new Set<string>();
  const ids = new Set<string>();
  const addWord = (word: string): void => {
    if (CJK.test(word)) {
      words.add(word);
    }
  };

  for (const command of registry.commands) {
    ids.add(command.id);
    command.verbs.forEach(addWord);
  }
  for (const room of registry.rooms) {
    ids.add(room.id);
    addWord(room.name);
    for (const exit of room.exits) {
      ids.add(exit.id);
      addWord(exit.direction);
      exit.verbs.forEach(addWord);
    }
  }
  for (const npc of registry.npcs) {
    ids.add(npc.id);
    addWord(npc.name);
  }
  for (const monster of registry.monsters) {
    ids.add(monster.id);
  }

  return { words: [...words].sort(), ids: [...ids].sort() };
}

/** Every string of `vocabulary` that occurs in `haystack` — the leakage list. */
export function foundIn(haystack: string, vocabulary: PackVocabulary): string[] {
  return [...vocabulary.words, ...vocabulary.ids].filter((word) => haystack.includes(word));
}
