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

/**
 * The parser's Chinese GRAMMAR charset (spec/07 §0: mechanism in engine,
 * word lists in content): the disambiguation markers, the katakana middle
 * dot, the Chinese numerals — plus the corner brackets used to quote input
 * forms in doc comments. The scan covers only word-carrying CJK blocks
 * (CJK punctuation/kana, ext-A, unified and compatibility ideographs,
 * full-width forms): Latin-1 symbols and dashes (§, —) are established
 * comment conventions in this repo, not content. Any other CJK char in
 * src/ — a verb, a theme word, a fixture noun — is content leaking into
 * the engine (issue #2 acceptance: 引擎源码里搜不到任何动词).
 */
const GRAMMAR_CHARSET = new Set("第个・一二两三四五六七八九十「」");

const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/** Every word-carrying CJK char in `text` that is not grammar. */
export function scanNonGrammarCjk(text: string): string[] {
  const seen = new Set(text.match(CJK_PATTERN) ?? []);
  return [...seen].filter((char) => !GRAMMAR_CHARSET.has(char));
}

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

  it("contains no CJK beyond the parser grammar charset (verbs are data)", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(srcDir)) {
      for (const char of scanNonGrammarCjk(readFileSync(file, "utf8"))) {
        offenders.push(`${file}: ${char} (U+${char.charCodeAt(0).toString(16)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("goes red on a deliberately violating fixture", () => {
    const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/purity-violations.ts");
    const fixtureText = readFileSync(fixturePath, "utf8");
    const offenders = scanText(fixtureText);
    expect(offenders.theme).toContain("闭关");
    expect(offenders.theme).toContain("修为");
    expect(offenders.platform).toContain("window");
    expect(offenders.platform).toContain("localStorage");
    expect(offenders.platform).toContain("setTimeout");
    expect(scanNonGrammarCjk(fixtureText)).toContain("闭");
  });
});
