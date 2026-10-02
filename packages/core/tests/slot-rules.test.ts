import { describe, expect, it } from "vitest";
import {
  fillAbsentSlots,
  fillMigrationDefaults,
  SLOT_RULES,
  validateSlots,
} from "../src/state/slot-rules.js";
import type { SlotRuleTable, SlotValidator } from "../src/state/slot-rules.js";

/**
 * The slot table's own contract (issue #40, spec/04 §1.4): one row declares
 * a slot's absence policy, kind check and migration-recorded default, and
 * the three readers' halves (validateSlots / fillAbsentSlots /
 * fillMigrationDefaults) take their fields off it. The engine's consumers
 * hand these steps the module table — the table itself is not injectable
 * (`DERIVED_ENTITY_KEYS` law).
 *
 * The drill is the point of the shape: a slot the engine has never heard of
 * connects to all three readers by adding ONE row.
 */

const label = (slot: string) => `entity "player-1".${slot}`;

describe("one row, three readers (the add-a-slot drill)", () => {
  it("connects a brand-new slot to all three reader halves — one row, zero hand-edits", () => {
    // `morale` stands in for the future `attrs` slot (spec/04 §4.1 refuses
    // to open that one early): a row, and every reader lights up. Nothing
    // outside the table knows the slot exists.
    const isCount: SlotValidator = (value, what) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`snapshot: ${what} is not a non-negative safe integer`);
      }
    };
    const rules: SlotRuleTable<"lastSeenTick" | "morale"> = {
      lastSeenTick: SLOT_RULES.entity.lastSeenTick,
      morale: { absent: { default: 3, migrate: true }, validate: isCount },
    };

    // readSaveData's half: absence passes silently, malformation is answered.
    expect(() => validateSlots({}, rules, label)).not.toThrow();
    expect(() => validateSlots({ morale: 7 }, rules, label)).not.toThrow();
    expect(() => validateSlots({ morale: "high" }, rules, label)).toThrow(
      /entity "player-1"\.morale is not a non-negative safe integer/,
    );

    // restoreWorld's half: the declared default fills the absence. Both
    // migrating rows fill from the SAME one declaration the migration reads
    // (AC5) — the two fill sites cannot drift apart.
    expect(fillAbsentSlots({}, rules)).toEqual({ lastSeenTick: 0, morale: 3 });
    expect(fillAbsentSlots({ lastSeenTick: 777, morale: 9 }, rules)).toEqual({
      lastSeenTick: 777,
      morale: 9,
    });

    // migrations' half: absence is recorded — and a fact is never overwritten.
    expect(fillMigrationDefaults({}, rules)).toEqual({ lastSeenTick: 0, morale: 3 });
    expect(fillMigrationDefaults({ lastSeenTick: 777 }, rules)).toEqual({ morale: 3 });
    expect(fillMigrationDefaults({ lastSeenTick: 777, morale: 9 }, rules)).toEqual({});
  });

  it("hands out a FRESH default per fill — two absences never share one object", () => {
    // The default is declared once (AC5) but copied per fill: two records
    // missing `tags` must not read and write the same `{}`, or one entity's
    // tag write would land in every other restored entity.
    const first = fillAbsentSlots({}, SLOT_RULES.entity);
    const second = fillAbsentSlots({}, SLOT_RULES.entity);
    expect(first.tags).toEqual({});
    expect(first.tags).not.toBe(second.tags);
    expect(first.cooldowns).not.toBe(second.cooldowns);
    const firstDue = fillAbsentSlots({}, SLOT_RULES.world).due;
    const secondDue = fillAbsentSlots({}, SLOT_RULES.world).due;
    expect(firstDue).toEqual([]);
    expect(firstDue).not.toBe(secondDue);
    expect(fillMigrationDefaults({}, SLOT_RULES.world).due).not.toBe(
      fillMigrationDefaults({}, SLOT_RULES.world).due,
    );
  });

  it("a required row's kind check doubles as its presence check — same error class as always", () => {
    // "flags is a list of strings", and absent is neither: the validator
    // answers a missing required slot with the error class it has always
    // produced, so `absent: "required"` needs no second presence rule.
    expect(() => validateSlots({}, SLOT_RULES.entity, label)).toThrow(
      /entity "player-1"\.locationId is not a non-empty string/,
    );
    expect(() => validateSlots({ locationId: "room-a" }, SLOT_RULES.entity, label)).toThrow(
      /entity "player-1"\.flags is not a list of strings/,
    );
    // A required row's PRESENT value rides along in the resolved view too:
    // `WorldMeta` is built from fillAbsentSlots' object alone, so a row may
    // not go missing from it.
    expect(fillAbsentSlots({ locationId: "room-a" }, SLOT_RULES.entity).locationId).toBe(
      "room-a",
    );
  });
});
