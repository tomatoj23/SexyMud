import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The host half of the engine-purity boundary (spec/04 §2.1, ADR-0031).
 *
 * The ENGINE's ban on `Date.now()` / `Math.random()` is already mechanical
 * (packages/core/tests/engine-purity.test.ts covers `packages/core/src/`).
 * This one pins the complementary claim the host side makes: translating the
 * wall clock into a tick happens in EXACTLY ONE place — `game/hostClock.ts` —
 * and the game glue rolls no unseeded randomness (the save's `rngState` is
 * the only stream, ADR-0033). A second wall reading would be a second "now"
 * to disagree with the translator, and a stray `Math.random()` would break
 * replay without failing anything.
 *
 * Scope is `apps/web/src/game/` — the game glue. The UI shell above it
 * legitimately schedules heartbeats and formats output; it is not where
 * world time is decided. The scanner lives in the test suite (not src/)
 * because the pattern table itself contains the vocabulary being banned.
 */

/** Wall-clock reads AND unseeded randomness: both break determinism. */
const NONDETERMINISM_PATTERN = /\bDate\.now\b|\bnew\s+Date\b|\bperformance\.|\bMath\.random\b/g;

/** The translator owns the one wall read; everything else must ask it. */
const ALLOWED: ReadonlyArray<{ file: string; pattern: RegExp }> = [
  { file: "hostClock.ts", pattern: /\bDate\.now\b/ },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const gameDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/game");

describe("host purity (ADR-0031, spec/04 §2.3)", () => {
  it("reads the wall clock (and rolls no randomness) outside the translator — nowhere", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(gameDir)) {
      const name = file.slice(gameDir.length + 1).replace(/\\/g, "/");
      const text = readFileSync(file, "utf8");
      for (const hit of text.match(NONDETERMINISM_PATTERN) ?? []) {
        const allowed = ALLOWED.some((entry) => entry.file === name && entry.pattern.test(hit));
        if (!allowed) offenders.push(`${name}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the translator is real — it does read the wall clock", () => {
    // A vacuous pass would be worse than no guard: if hostClock.ts ever stops
    // being the translator (a refactor moves the read elsewhere and empties
    // this file), the scan above stays green — so its existence is asserted.
    const text = readFileSync(join(gameDir, "hostClock.ts"), "utf8");
    expect(text).toMatch(/\bDate\.now\b/);
  });
});
