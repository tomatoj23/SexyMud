import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The check-refs anchoring pin (#54): the gate anchors its repo root on
 * the script's OWN file, not the runner's cwd. Before #54, running the
 * script from a package directory resolved every scan root against that
 * cwd, swept ZERO markdown files, and still exited 0 printing 「缺件 0」 —
 * a silent false green the AC's 「且非空」 closes. The pin runs the script
 * twice, once from the repo root and once from a package directory, and
 * demands the SAME, NON-EMPTY sweep.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = resolve(repoRoot, "scripts", "check-refs.mjs");

const run = (cwd: string): string =>
  execFileSync(process.execPath, [script], { cwd, encoding: "utf8" });

describe("check-refs anchors on the script's place, not the runner's cwd (#54)", () => {
  it("repo root and package directory sweep the same NON-EMPTY set", () => {
    const fromRoot = run(repoRoot);
    const fromPackage = run(resolve(repoRoot, "packages", "core"));

    // Identical full output (same sweep, same hits, same missing count) —
    // the printed relative paths are ROOT-relative in both runs.
    expect(fromPackage).toBe(fromRoot);

    // NOT the false green: the sweep must actually cover markdown files.
    const swept = Number(/扫 (\d+) 个 md/.exec(fromRoot)?.[1] ?? "0");
    expect(swept).toBeGreaterThan(0);
  });
});
