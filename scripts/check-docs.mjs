// Docs consistency gate. Where scripts/check-content.mjs guards the CONTENT
// (data against schemas), this one guards the LIVING SPEC against itself.
//
// Why it exists: a rule in this repo tends to live in four places at once
// (spec/04 §0 glossary + its body, HANDBOOK's cheat-sheet, spec/00's status
// table, and AGENTS.md's map). Every one of the M4 review rounds found the
// same class of defect — a term or a number updated in three of them and left
// stale in the fourth. That is a structural defect, not an attention lapse:
// no amount of "read it again" fixes it, so it is scanned instead.
//
// Scope is deliberately the LIVING docs only:
//   docs/spec/**  docs/HANDBOOK.md  AGENTS.md  CONTEXT.md
//   docs/agents/content.md  docs/chinese-mud-concerns.md
// docs/adr/** is NOT scanned — an ADR is a decision LOG. It records what was
// decided on a date, superseded wording included; rewriting it would destroy
// the very history these rules protect. Supersession is recorded by the newer
// ADR and corrected in place in the spec, never by editing the old ADR.
// The two non-spec files joined the scan on #28: content.md is the content
// pipeline's authority (and quotes collection counts), chinese-mud-concerns.md
// IS the 43-item list its counts refer to — both were the SOURCE of number
// drift this gate could not see.
//
// Growing the scan EXPOSES existing violations, so the growth process is:
// add the files, run once with DOCS_CHECK_REPORT_ONLY=1 (violations print as
// warnings and the run exits 0), judge the scale, fix, then commit them as
// hard targets. The flag is that process, not an escape hatch — `pnpm check`
// never sets it.
//
// Four checks, all hard failures:
//   1. superseded wording (and the Clock × host-injection pairing),
//   2. "count" numbers with exactly one home, and totals that must match
//      reality (schema / collection / content / dimensions / concerns / tests),
//   3. ADR references that point at a file which does not exist, and ADR
//      totals that do not match the directory,
//   4. (implicit in 2–3) the docs agree with the directories they describe.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under `dir` whose name ends with `suffix`, recursively. */
function walkFiles(dir, suffix) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, suffix));
    else if (entry.endsWith(suffix)) out.push(full);
  }
  return out;
}

const targets = [
  ...walkFiles(join(root, "docs", "spec"), ".md"),
  join(root, "docs", "HANDBOOK.md"),
  join(root, "AGENTS.md"),
  join(root, "CONTEXT.md"),
  join(root, "docs", "agents", "content.md"),
  join(root, "docs", "chinese-mud-concerns.md"),
].sort();

/**
 * Report-only mode: violations print as warnings and the run exits 0. Used
 * when ADDING files to the scan above — see the header. Never set by
 * `pnpm check`.
 */
const reportOnly = process.env["DOCS_CHECK_REPORT_ONLY"] === "1";

/**
 * 1. Wording a later decision retired. Each entry names the current wording so
 * the failure message tells the fixer what to write, not just what to delete.
 *
 * `unless` exists because the spec legitimately *mentions* retired wording —
 * "已被 ADR-0032 覆盖：…不共用代码路径" is a correct sentence, not a
 * regression. A blacklist that flags its own correction notes gets muted on
 * sight, so the guard is part of the rule.
 *
 * The whitelist is DELIBERATELY narrow (#28): only explicit retirement
 * markers pass. It used to contain bare 旧／删／更宽／比「／同义, and one such
 * word anywhere on a line passed the WHOLE line — a fresh use of retired
 * wording riding next to a correction note went unseen (AGENTS.md's synonym
 * example was exactly that). A rule whose correction note needs a word the
 * whitelist lacks gets it in its OWN `unless`, never here.
 */
/** A line that NAMES retired wording in order to retire it is correct prose. */
const MENTIONS_LEGITIMATELY =
  /覆盖|已被|原写|不再|改为|废弃|superseded|retired|removed/;

const SUPERSEDED = [
  {
    term: "进入执行段",
    unless: /更宽|比「|旧|原/,
    reason:
      "高水位的限定语是「非 `invalid` 的命令（`ok`／`rejected`）」—— 被门禁／at_pre_cmd 在 parse 之前拒掉的 rejected 也算（spec/04 §0、§2.2、§4.1）",
  },
  {
    term: "不共用代码路径",
    unless: /覆盖|已被|原写|旧|不再/,
    reason:
      "已被 ADR-0032 覆盖：双时钟降级为「同一个推进函数的两个跨度」；被保留的那一半是语义隔离（离线只补资源与基础熟练度）",
  },
  {
    term: "CommandDeps.clock",
    unless: /删|改为|不再/,
    reason: "已删除（ADR-0031，#20）；命令依赖里现在是 `deps.nowTick`",
  },
  {
    // The Evennia attribute namespace (`db.*` / `ndb.*`). Matched by pattern,
    // not by one substring: `db.` alone would fire inside `ndb.` and inside
    // any lowercase `…db.` word; `n?db` catches both spellings and only them
    // (never the nonexistent `nb.`), the lookbehind keeps `…leveldb.` out.
    term: "`db.*`／`ndb.*`",
    pattern: /(?<![A-Za-z])n?db\.[*a-zA-Z]/,
    unless: /不采用|勿用|勿再称|已废|废弃|丢弃|覆盖|已被|不再/,
    reason:
      "Evennia 的属性命名空间，本作不采用（CONTEXT.md「状态持久化」）：typed 状态对象 + `derived` 标记，没有 `db`／`ndb` 命名空间",
  },
];

/**
 * 1b. Pairings: a term that is fine alone but stale next to another. The
 * `unless` guard keeps the legitimate negations ("不再是宿主注入的依赖")
 * from firing — a blacklist that flags its own corrections gets muted.
 */
const PAIRINGS = [
  {
    name: "Clock × 宿主注入/宿主实现",
    all: [/Clock/, /宿主注入|宿主实现|宿主提供的依赖|宿主提供/],
    unless: /不再|不再是|已不|翻转|旧|原写|覆盖/,
    reason:
      "Clock 已翻转（ADR-0031）：它是引擎对外暴露的高水位读数，宿主只负责产生 tick 并放进 Command",
  },
];

/**
 * 2a. Counts with exactly one home. A number that describes the repo's current
 * state is asserted ONCE and everywhere else points at it — duplicated counts
 * are how "21 文件／463 用例" survived a release. (A count that can be checked
 * against reality, like the schema or ADR totals, gets 2b instead: state it
 * freely, but state it TRUE.)
 */
const COUNTS = [
  {
    name: "测试规模（文件／用例）",
    // The combined form AND either half alone: "509 用例" with no file count
    // beside it used to slip past, which made the one-home rule rewordable.
    match: (line) =>
      /\d+\s*(?:个)?(?:测试)?文件\s*[／/|]\s*\d+\s*用例/.test(line) ||
      /\d+\s*用例/.test(line) ||
      /\d+\s*个测试文件/.test(line),
    onlyIn: "docs/HANDBOOK.md",
    reason: "只在 HANDBOOK「当前事实」维护；别处写「见 HANDBOOK 当前事实」",
  },
];

const SCHEMA_DIR = join(root, "schemas");
const schemaCount = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(".schema.json")).length;

/**
 * 2b. Every number a reader quotes about the repo's current state, checked
 * against the directory or file it describes (#28 — the schema total used to
 * be the only one; collection / content / dimensions / concerns / test-file
 * counts drifted unchecked, and two of them drifted FROM files this gate did
 * not even scan). Only phrases that can only mean the TOTAL are matched — a
 * scoped fact ("余 5 条待评估", "config/`（4 个 JSON") names a subset and is
 * left alone, otherwise the rule would train everyone to ignore it.
 *
 * Per-file case counts ("tests/x.test.ts` N 例") are deliberately NOT checked:
 * vitest counts loop-generated cases (13 `it(` lines can run 77), so no
 * mechanical check here would be honest. Their guard is the 关票 grep
 * checklist plus hand verification on 复查 rounds.
 */
/** 条目集合 = the entry schemas that all `$ref` common.schema.json (a prose mention in a schema's description does not count). */
const entryCollectionCount = readdirSync(SCHEMA_DIR)
  .filter((name) => name.endsWith(".schema.json") && name !== "common.schema.json")
  .filter((name) =>
    /"\$ref"\s*:\s*"[^"]*common\.schema\.json/.test(readFileSync(join(SCHEMA_DIR, name), "utf8")),
  ).length;
const contentJsonCount = walkFiles(join(root, "content"), ".json").length;
const dimensionCount = Object.keys(
  JSON.parse(readFileSync(join(root, "content", "config", "dimensions.json"), "utf8")),
).length;
/** chinese-mud-concerns.md rows: `| A1 |` … `| **G8** |`. */
const concernsCount = readFileSync(join(root, "docs", "chinese-mud-concerns.md"), "utf8")
  .split(/\r?\n/)
  .filter((line) => /^\| {0,2}\*{0,2}[A-G]\d+/.test(line)).length;
const testFileCount = [
  ...walkFiles(join(root, "packages"), ".test.ts"),
  ...walkFiles(join(root, "apps"), ".test.ts"),
].length;

const REALITIES = [
  {
    name: "schema 总数",
    unit: "个 schema",
    actual: schemaCount,
    patterns: [
      /(\d+)\s*个\s*schema/gi,
      /schema[s]?\s*\**(\d+)\s*个/gi,
      /schema[^。\n]{0,14}共\s*\**(\d+)/gi,
      /共\s*\**(\d+)[^。\n]{0,14}schema/gi,
    ],
  },
  {
    name: "条目集合数",
    unit: "个条目集合",
    actual: entryCollectionCount,
    patterns: [/(\d+)\s*个条目集合/g, /(\d+)\s*个集合(?=[^。\n]{0,14}\$?ref)/g],
  },
  {
    name: "内容 JSON 数",
    unit: "个 JSON",
    actual: contentJsonCount,
    patterns: [/(\d+)\s*个\s*\*{0,2}JSON/gi],
    // "`config/`（4 个 JSON" scopes to the config/ SUBDIRECTORY — only an
    // unscoped "N 个 JSON" means the whole content set.
    scoped: (line, match) => /config[^\n]{0,8}$/.test(line.slice(0, match.index)),
  },
  {
    name: "维度数",
    unit: "个维度",
    actual: dimensionCount,
    // (?!表): "三个维度表" counts TABLES — a different fact entirely.
    patterns: [/(\d+)\s*个?维度(?!表)/g],
  },
  {
    name: "中文清单条数",
    unit: "条",
    actual: concernsCount,
    // 全景 / 问题清单 / 中文清单 are THE list; "自检清单 19 条" names another
    // list entirely and must not be compared against it. The number-first
    // form allows only whitespace/emphasis between 条 and 清单 — "3 条内容清单"
    // names a different list and must not slip in through the gap.
    patterns: [
      /(?:全景|(?:问题|中文)清单)\s*[（(]?\s*(?:共\s*|总计\s*)?(\d+)\s*条/g,
      /(\d+)\s*条[\s*]{0,4}(?:问题|中文)?[\s*]{0,2}清单/g,
    ],
  },
  {
    name: "测试文件数",
    unit: "个测试文件",
    actual: testFileCount,
    patterns: [/(\d+)\s*个测试文件/g],
  },
];

function checkRealities(line) {
  const hits = [];
  for (const reality of REALITIES) {
    for (const pattern of reality.patterns) {
      for (const match of line.matchAll(pattern)) {
        if (reality.scoped?.(line, match)) continue;
        const claimed = Number(match[1]);
        if (claimed !== reality.actual) {
          hits.push({
            text: `${claimed} ${reality.unit}`,
            reason: `${reality.name}与实际不符（现有 ${reality.actual} ${reality.unit}）；若指的不是总数，改写措辞`,
          });
        }
      }
    }
  }
  return hits;
}

/** 3. A reference to an ADR that does not exist: drift, or a typo'd number. */
const ADR_DIR = join(root, "docs", "adr");
const adrNumbers = new Set(
  readdirSync(ADR_DIR)
    .filter((name) => /^(\d{4})-.*\.md$/.test(name))
    .map((name) => name.slice(0, 4)),
);
const adrCount = adrNumbers.size;

/**
 * "docs/adr/（35 篇决策历史）"、"35 个架构决策"、"35 个 ADR" — the total is
 * asserted in several spellings, and the count regex used to only catch the
 * one with 篇 right after the number (#28). Scoped counts name a subset —
 * "那 4 篇 ADR"、"散落在 8 个 ADR 的 …" — and are left alone: the two forms
 * where the number LEADS get a prefix-window scope check, the two where the
 * noun leads have no scoped spelling to confuse them with.
 *
 * ORDINALS are a third spelling this table must not read as a total:
 * "ADR-0035（第 35 篇）" names ONE ADR by its position, yet its number sits
 * before 篇 exactly like a total claim. Left unchecked, every "第 N 篇" is a
 * landmine that detonates the moment the NEXT ADR lands (#29 复查: it already
 * forced two historical rewordings to survive 0036). The 第 marker
 * disambiguates — a real total is written 「N 篇决策历史」/「共 N 篇」 and never
 * carries 第 — so `claimTotal` skips ordinals via the digits' own position
 * (match.index may point at "adr" or "共", not at the number).
 */
const ADR_COUNT_PATTERNS = [
  /(?:共|总计)?\s*\*{0,2}(\d+)\*{0,2}\s*篇决策历史/g,
  /adr[^\n]{0,16}?\*{0,2}(\d+)\*{0,2}\s*篇/gi,
];
const ADR_COUNT_PATTERNS_LEADING = [
  /\*{0,2}(\d+)\*{0,2}\s*个架构决策/g,
  /\*{0,2}(\d+)\*{0,2}\s*个\s*\*{0,2}ADR/gi,
];
const ADR_SCOPE_MARKER = /那|散落|其中|其余|另有|几篇|数篇|上述/;

function checkAdrReferences(lines, relative) {
  const hits = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/ADR-(\d{4})/g)) {
      if (!adrNumbers.has(match[1])) {
        hits.push({
          line: index + 1,
          text: `ADR-${match[1]}`,
          reason: `docs/adr/ 里没有 ${match[1]} 号 ADR（现有 ${adrCount} 篇）`,
        });
      }
    }
    const claimTotal = (match) => {
      const claimed = Number(match[1]);
      if (claimed !== adrCount) {
        hits.push({
          line: index + 1,
          text: `${claimed} 篇/个`,
          reason: `ADR 篇数与实际不符（docs/adr/ 现有 ${adrCount} 篇）`,
        });
      }
    };
    /** "第 N 篇" is an ordinal naming one ADR, never a claim about the total. */
    const isOrdinal = (match) => {
      const digitsAt = match.index + match[0].lastIndexOf(match[1]);
      return /第\s*$/.test(line.slice(Math.max(0, digitsAt - 4), digitsAt));
    };
    for (const pattern of ADR_COUNT_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        if (isOrdinal(match)) continue;
        claimTotal(match);
      }
    }
    for (const pattern of ADR_COUNT_PATTERNS_LEADING) {
      for (const match of line.matchAll(pattern)) {
        // A subset marker right before the number means a scoped count.
        const before = line.slice(Math.max(0, match.index - 8), match.index);
        if (ADR_SCOPE_MARKER.test(before)) continue;
        claimTotal(match);
      }
    }
  });
  return hits;
}

let violations = 0;
const report = (relative, line, text, reason) => {
  if (reportOnly) {
    console.warn(`DOCS ?  ${relative}:${line} 「${text}」— ${reason}`);
    return;
  }
  violations += 1;
  console.error(`DOCS    ${relative}:${line} 「${text}」— ${reason}`);
};

for (const file of targets) {
  const relative = file.slice(root.length + 1).replace(/\\/g, "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of SUPERSEDED) {
      const hit = rule.pattern ? rule.pattern.test(line) : line.includes(rule.term);
      if (!hit) continue;
      // Each pattern keeps its own shape and flags — no source-splicing.
      if (MENTIONS_LEGITIMATELY.test(line) || rule.unless?.test(line)) continue;
      report(relative, index + 1, rule.term, rule.reason);
    }
    for (const hit of checkRealities(line)) {
      report(relative, index + 1, hit.text, hit.reason);
    }
    for (const rule of PAIRINGS) {
      if (!rule.all.every((pattern) => pattern.test(line))) continue;
      if (rule.unless.test(line)) continue;
      report(relative, index + 1, rule.name, rule.reason);
    }
    for (const rule of COUNTS) {
      if (relative === rule.onlyIn) continue;
      if (rule.match(line)) report(relative, index + 1, rule.name, rule.reason);
    }
  });

  for (const hit of checkAdrReferences(lines, relative)) {
    report(relative, hit.line, hit.text, hit.reason);
  }
}

if (reportOnly) {
  console.log(
    `WARN    docs: ${targets.length} file(s) scanned in REPORT-ONLY mode — violations above are warnings, none failed the run`,
  );
  process.exit(0);
}
if (violations > 0) {
  console.error(`\ndocs:check FAILED — ${violations} violation(s) across ${targets.length} file(s)`);
  process.exit(1);
}
console.log(
  `OK      docs: ${targets.length} file(s) scanned, ${adrCount} ADR(s) present, 0 violation(s)`,
);
