import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import type { Calendar, CalendarRing, SettingsGroup, SettingsTable } from "../src/content/config.js";
import { createContentRegistry } from "../src/content/registry.js";
import { createGameTime, ringPeriod, segmentAt, segmentIndexAt } from "../src/time/calendar.js";
import { createTimeTuning } from "../src/time/tuning.js";
import { MINI_PACK_DIR, loadPack, packRegistry } from "./fixtures/mini-content-pack.js";

/**
 * Game-in-time as content (spec/04 §3, ADR-0032): the calendar is a pack
 * file, the engine only ever answers "which segment of which ring does this
 * tick land on", and a pack that forgot to ship one fails at first use
 * rather than inheriting somebody else's calendar.
 *
 * Synthetic rings drive the arithmetic (boundary, wrap, independence); the
 * real packs on disk drive the channel and the swap.
 */

const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../schemas");
const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../content");

function ring(id: string, segments: ReadonlyArray<readonly [string, number]>): CalendarRing {
  return { id, segments: segments.map(([segmentId, ticks]) => ({ id: segmentId, ticks })) };
}

function calendar(...rings: CalendarRing[]): Calendar {
  return { id: "calendar", rings };
}

/** Two independent rings: a 60-tick "day" of three, a 200-tick "year" of two. */
const twoRings = calendar(
  ring("day", [
    ["a", 10],
    ["b", 20],
    ["c", 30],
  ]),
  ring("year", [
    ["p", 100],
    ["q", 100],
  ]),
);

const readCalendar = (dir: string): Calendar =>
  JSON.parse(readFileSync(resolve(dir, "config", "calendar.json"), "utf8")) as Calendar;

describe("config.calendar.schema.json (spec/04 §3.2)", () => {
  const validate = new Ajv({ allErrors: true }).compile(
    JSON.parse(readFileSync(resolve(schemasDir, "config.calendar.schema.json"), "utf8")),
  );

  it("accepts the wuxia pack's calendar: a set of independent rings", () => {
    const data = readCalendar(contentDir);
    expect(validate(data)).toBe(true);
    expect(data.rings.map((each) => each.id)).toEqual(["day", "year"]);
  });

  it("accepts the mini pack's calendar — a second pack, a second calendar", () => {
    const data = readCalendar(MINI_PACK_DIR);
    expect(validate(data)).toBe(true);
    expect(data.rings.map((each) => each.id)).toEqual(["shift", "orbit"]);
  });

  it("is one ring SET, not a flat segment table (an extra axis is not a schema change)", () => {
    expect(validate(calendar(ring("day", [["a", 10]]), ring("year", [["p", 100]])))).toBe(true);
  });

  it("rejects an empty ring list, a ring with no segments and a zero-length segment", () => {
    expect(validate({ id: "calendar", rings: [] })).toBe(false);
    expect(validate(calendar({ id: "day", segments: [] }))).toBe(false);
    expect(validate(calendar(ring("day", [["a", 0]])))).toBe(false);
  });

  it("rejects tick counts that are negative, fractional or not numbers", () => {
    expect(validate(calendar(ring("day", [["a", -5]])))).toBe(false);
    expect(validate(calendar(ring("day", [["a", 1.5]])))).toBe(false);
    // A string is a shape the schema itself must reject (host-assembled data).
    expect(validate(calendar(ring("day", [["a", "10" as unknown as number]])))).toBe(false);
  });

  it("rejects an id that is not the file's own, and stray keys (structure is closed)", () => {
    expect(validate({ id: "settings", rings: [ring("day", [["a", 10]])] })).toBe(false);
    expect(validate({ id: "calendar", rings: [ring("day", [["a", 10]])], ticksPerDay: 100 })).toBe(
      false,
    );
    // A display name is the renderer's business — the engine keys off ids only.
    expect(
      validate(
        calendar({ id: "day", segments: [{ id: "a", ticks: 10, name: "x" }] } as unknown as CalendarRing),
      ),
    ).toBe(false);
  });

  it("cannot check uniqueness — that is the registry's job, not a gap in the schema", () => {
    // draft-07 has no `uniqueItemProperties`; the split is deliberate
    // (spec/04 §3.3): shape here, cross-value consistency at load.
    expect(
      validate(calendar(ring("day", [["a", 10]]), ring("day", [["b", 10]]))),
    ).toBe(true);
  });
});

describe("createContentRegistry (the config channel)", () => {
  it("takes a calendar and hands the validated table back out (one copy, not two)", () => {
    const registry = createContentRegistry({}, { calendar: twoRings });
    expect(registry.calendar).toBe(twoRings);
  });

  it("takes a settings table and hands it back out", () => {
    const settings: SettingsTable = { time: { regenPerTick: 3 } };
    const registry = createContentRegistry({}, { settings });
    expect(registry.settings).toBe(settings);
  });

  it("skips every check when no table is handed over — presence is what opts in", () => {
    const registry = createContentRegistry({});
    expect(registry.calendar).toBeUndefined();
    expect(registry.settings).toBeUndefined();
  });

  it("throws on a ring id declared twice — rings are looked up by id", () => {
    expect(() =>
      createContentRegistry({}, { calendar: calendar(ring("day", [["a", 10]]), ring("day", [["b", 10]])) }),
    ).toThrow(/declares ring "day" twice/);
  });

  it("throws on a segment id declared twice inside one ring", () => {
    expect(() =>
      createContentRegistry({}, { calendar: calendar(ring("day", [["a", 10], ["a", 20]])) }),
    ).toThrow(/ring "day" declares segment "a" twice/);
  });

  it("allows the same segment id in DIFFERENT rings (rings are independent)", () => {
    expect(() =>
      createContentRegistry({}, { calendar: calendar(ring("day", [["a", 10]]), ring("year", [["a", 10]])) }),
    ).not.toThrow();
  });

  it("throws on a tick count that is zero, negative or fractional", () => {
    for (const ticks of [0, -5, 1.5]) {
      expect(() =>
        createContentRegistry({}, { calendar: calendar(ring("day", [["a", ticks]])) }),
      ).toThrow(/positive integer/);
    }
  });

  it("throws on a ring with no segments and on a calendar with no rings", () => {
    expect(() =>
      createContentRegistry({}, { calendar: calendar({ id: "day", segments: [] }) }),
    ).toThrow(/declares no segments/);
    expect(() => createContentRegistry({}, { calendar: calendar() })).toThrow(/declares no rings/);
  });

  it("throws on a settings group that is not an object", () => {
    expect(() =>
      createContentRegistry({}, { settings: { time: 3 as unknown as Record<string, unknown> } }),
    ).toThrow(/settings group "time" must be an object/);
  });

  it("does not require a `time` group — needing one is the engine's business, not the loader's", () => {
    expect(() => createContentRegistry({}, { settings: { combat: {} } })).not.toThrow();
  });
});

describe("game time: f(ring, tick) → segment (spec/04 §3.1)", () => {
  it("derives the period from the segments — there is no second number to keep in sync", () => {
    expect(ringPeriod(twoRings.rings[0]!)).toBe(60);
    expect(ringPeriod(twoRings.rings[1]!)).toBe(200);
  });

  it("walks half-open intervals: the last tick of a segment is still in it", () => {
    const day = twoRings.rings[0]!;
    expect([0, 9].map((tick) => segmentIndexAt(day, tick))).toEqual([0, 0]);
    expect([10, 29].map((tick) => segmentIndexAt(day, tick))).toEqual([1, 1]);
    expect([30, 59].map((tick) => segmentIndexAt(day, tick))).toEqual([2, 2]);
  });

  it("wraps at the period — one modulo, no `if start < end` to get wrong", () => {
    const day = twoRings.rings[0]!;
    expect(segmentAt(day, 59).id).toBe("c");
    expect(segmentAt(day, 60).id).toBe("a");
    expect(segmentAt(day, 61).id).toBe("a");
    expect(segmentAt(day, 70).id).toBe("b");
    expect(segmentAt(day, 60 * 7 + 45).id).toBe("c");
  });

  it("evaluates every ring independently — one tick, several axes", () => {
    const time = createGameTime(twoRings);
    expect(time.ringIds).toEqual(["day", "year"]);
    expect([time.segmentOf("day", 150).id, time.segmentOf("year", 150).id]).toEqual(["c", "q"]);
    expect(time.segmentOf("day", 150).id).not.toBe(time.segmentOf("year", 150).id);
  });

  it("switches segments across a ring boundary in both directions", () => {
    const time = createGameTime(twoRings);
    expect([199, 200, 300].map((tick) => time.segmentOf("year", tick).id)).toEqual(["q", "p", "q"]);
  });

  it("rejects a ring with no segments — there is no period to divide by", () => {
    expect(() => ringPeriod({ id: "day", segments: [] })).toThrow(/period of 0/);
  });

  it("refuses a calendar that declares one ring id twice (a silent axis loss)", () => {
    expect(() =>
      createGameTime(calendar(ring("day", [["a", 10]]), ring("day", [["b", 20]]))),
    ).toThrow(/declares ring "day" twice/);
  });

  it("throws on a tick that is not a non-negative safe integer", () => {
    const day = twoRings.rings[0]!;
    expect(() => segmentIndexAt(day, -1)).toThrow(/non-negative safe integer/);
    expect(() => segmentIndexAt(day, 1.5)).toThrow(/non-negative safe integer/);
  });

  it("reads the shipped wuxia calendar: twelve day segments, four year segments", () => {
    const time = createGameTime(readCalendar(contentDir));
    expect(time.periodOf("day")).toBe(14400);
    expect(time.periodOf("year")).toBe(5184000);
    expect(time.segmentOf("day", 0).id).toBe("zi");
    expect(time.segmentOf("day", 1200).id).toBe("chou");
    expect(time.segmentOf("day", 14399).id).toBe("hai");
    expect(time.segmentOf("day", 14400).id).toBe("zi");
  });

  it("fails loudly at first use when no calendar was loaded — no default calendar", () => {
    const time = createGameTime(undefined);
    expect(() => time.segmentOf("day", 0)).toThrow(/no calendar was loaded/);
    expect(() => time.periodOf("day")).toThrow(/no calendar was loaded/);
    expect(() => time.ringIds).toThrow(/no calendar was loaded/);
  });

  it("fails loudly on a ring the pack does not declare (and names the ones it does)", () => {
    const time = createGameTime(twoRings);
    expect(() => time.segmentOf("hour", 0)).toThrow(/unknown ring "hour".*day, year/);
  });
});

describe("time tuning: settings.time (spec/04 §6 O3)", () => {
  it("reads a number the group carries", () => {
    expect(createTimeTuning({ time: { regenPerTick: 3 } }).number("regenPerTick")).toBe(3);
  });

  it("throws when the table is missing, and when the `time` group is missing (缺组失败)", () => {
    expect(() => createTimeTuning(undefined).number("regenPerTick")).toThrow(/"time" group/);
    expect(() => createTimeTuning({ combat: {} }).number("regenPerTick")).toThrow(/"time" group/);
  });

  it("throws when the group lacks the key — and never invents a default (缺键由消费者失败)", () => {
    expect(() => createTimeTuning({ time: { regenPerTick: 3 } }).number("cooldownTicks")).toThrow(
      /no numeric key "cooldownTicks"/,
    );
    expect(() => createTimeTuning({ time: {} }).number("regenPerTick")).toThrow(
      /no numeric key "regenPerTick"/,
    );
  });

  it("treats a null `time` group as missing instead of crashing on it", () => {
    expect(() => createTimeTuning({ time: null as unknown as SettingsGroup }).number("regenPerTick")).toThrow(
      /"time" group/,
    );
  });

  it("throws on a key that is present but not a number", () => {
    expect(() => createTimeTuning({ time: { regenPerTick: "3" } }).number("regenPerTick")).toThrow(
      /no numeric key/,
    );
  });

  it("does not throw until a number is asked for (a pack with no settings still loads)", () => {
    expect(() => createTimeTuning(undefined)).not.toThrow();
  });
});

describe("swap the directory, swap the calendar (ADR-0032 §3)", () => {
  it("loads each pack's own calendar through the same assembly path", () => {
    const wuxia = packRegistry(contentDir).calendar;
    const mini = packRegistry(MINI_PACK_DIR).calendar;
    expect(wuxia?.rings.map((each) => each.id)).toEqual(["day", "year"]);
    expect(mini?.rings.map((each) => each.id)).toEqual(["shift", "orbit"]);
  });

  it("shares no ring id and no segment id with the other pack", () => {
    const ids = (each: Calendar | undefined): string[] =>
      (each?.rings ?? []).flatMap((one) => [one.id, ...one.segments.map((part) => part.id)]);
    const wuxia = new Set(ids(packRegistry(contentDir).calendar));
    const mini = new Set(ids(packRegistry(MINI_PACK_DIR).calendar));
    expect([...mini].filter((id) => wuxia.has(id))).toEqual([]);
  });

  it("answers the same tick differently under the two calendars", () => {
    const tick = 5000;
    const wuxia = createGameTime(loadPack(contentDir).calendar).segmentOf("day", tick).id;
    const mini = createGameTime(loadPack(MINI_PACK_DIR).calendar).segmentOf("shift", tick).id;
    expect(wuxia).not.toBe(mini);
    expect(mini).toBe("day-watch");
  });
});
