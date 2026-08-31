import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Hard-standard guard (ADR-0004 + issue #2): the engine must be totally
 * separated from the content layer and from the host platform.
 * - No theme vocabulary may appear anywhere in core source; theme belongs in
 *   content files and host UI copy.
 * - No platform API may be referenced; hosts provide Clock/SaveStore/Rng.
 * The scanner lives in the test suite (not src/) because the pattern tables
 * themselves contain the vocabulary being banned.
 */

const THEME_PATTERN =
  /修为|闭关|境界|宗师|绝顶|不入流|秘籍|丹|秘境|装备|武器|招式|心法|门派|洗练|分解|江湖|武侠|奇遇|采集|炼丹|武功|流派|贡献|品阶|下乘|中乘|上乘|绝学|稀有度|寻常|精良|罕见|绝世|词缀|底材|丹方|药材/g;

const PLATFORM_PATTERN =
  /\bwindow\b|\bdocument\b|\blocalStorage\b|\bsessionStorage\b|\bnavigator\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\bDate\.now\b|\bperformance\.|\bprocess\.|\bglobalThis\b|\bMath\.random\b/g;

export interface PurityOffenders {
  theme: string[];
  platform: string[];
}

export function scanText(text: string): PurityOffenders {
  return {
    theme: text.match(THEME_PATTERN) ?? [],
    platform: text.match(PLATFORM_PATTERN) ?? [],
  };
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("engine purity (ADR-0004)", () => {
  it("contains no theme vocabulary in core source", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(srcDir)) {
      for (const word of scanText(readFileSync(file, "utf8")).theme) {
        offenders.push(`${file}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contains no platform API references in core source", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(srcDir)) {
      for (const word of scanText(readFileSync(file, "utf8")).platform) {
        offenders.push(`${file}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("goes red on a deliberately violating fixture", () => {
    const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/purity-violations.ts");
    const offenders = scanText(readFileSync(fixturePath, "utf8"));
    expect(offenders.theme).toContain("闭关");
    expect(offenders.theme).toContain("修为");
    expect(offenders.platform).toContain("window");
    expect(offenders.platform).toContain("localStorage");
    expect(offenders.platform).toContain("setTimeout");
  });
});
