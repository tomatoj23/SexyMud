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
// docs/adr/** is NOT scanned — an ADR is a decision LOG. It records what was
// decided on a date, superseded wording included; rewriting it would destroy
// the very history these rules protect. Supersession is recorded by the newer
// ADR and corrected in place in the spec, never by editing the old ADR.
//
// Three checks, all hard failures:
//   1. superseded wording (and the Clock × host-injection pairing),
//   2. "count" numbers that must have exactly one home,
//   3. ADR references that point at a file which does not exist.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function listMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listMarkdown(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const targets = [
  ...listMarkdown(join(root, "docs", "spec")),
  join(root, "docs", "HANDBOOK.md"),
  join(root, "AGENTS.md"),
  join(root, "CONTEXT.md"),
].sort();

/**
 * 1. Wording a later decision retired. Each entry names the current wording so
 * the failure message tells the fixer what to write, not just what to delete.
 *
 * `unless` exists because the spec legitimately *mentions* retired wording —
 * "已被 ADR-0032 覆盖：…不共用代码路径" is a correct sentence, not a
 * regression. A blacklist that flags its own correction notes gets muted on
 * sight, so the guard is part of the rule.
 */
/** A line that merely NAMES retired wording ("已被 ADR-0032 覆盖：…") is correct prose. */
const MENTIONS_LEGITIMATELY = /覆盖|已被|原写|旧|不再|删|改为|更宽|比「|superseded|retired|removed/;

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
    match: (line) => /\d+\s*(?:个)?(?:测试)?文件\s*[／/|]\s*\d+\s*用例/.test(line),
    onlyIn: "docs/HANDBOOK.md",
    reason: "只在 HANDBOOK「当前事实」维护；别处写「见 HANDBOOK 当前事实」",
  },
];

const SCHEMA_DIR = join(root, "schemas");
const schemaCount = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(".schema.json")).length;

/**
 * 2b. Totals that must match reality. Only phrases that can only mean the
 * TOTAL are matched — "14 个条目集合 $ref 引用它" is a scoped fact and is
 * left alone, otherwise the rule would train everyone to ignore it.
 */
const TOTAL_PATTERNS = [
  /(\d+)\s*个\s*schema/i,
  /schema[s]?\s*\**(\d+)\s*个/i,
  /schema[^。\n]{0,14}共\s*\**(\d+)/i,
  /共\s*\**(\d+)[^。\n]{0,14}schema/i,
];

function checkTotals(line) {
  const claimed = [];
  for (const pattern of TOTAL_PATTERNS) {
    for (const match of line.matchAll(new RegExp(pattern.source, "gi"))) {
      claimed.push(Number(match[1]));
    }
  }
  return claimed.filter((value) => value !== schemaCount);
}

/** 3. A reference to an ADR that does not exist: drift, or a typo'd number. */
const ADR_DIR = join(root, "docs", "adr");
const adrNumbers = new Set(
  readdirSync(ADR_DIR)
    .filter((name) => /^(\d{4})-.*\.md$/.test(name))
    .map((name) => name.slice(0, 4)),
);
const adrCount = adrNumbers.size;

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
    // "docs/adr/（34 篇决策历史）" — the total, asserted in several files.
    for (const match of line.matchAll(/(?:共|总计)?\s*\*{0,2}(\d+)\*{0,2}\s*篇决策历史|adr[^\n]{0,16}?\*{0,2}(\d+)\*{0,2}\s*篇/g)) {
      const claimed = Number(match[1] ?? match[2]);
      if (claimed !== adrCount) {
        hits.push({
          line: index + 1,
          text: `${claimed} 篇`,
          reason: `ADR 篇数与实际不符（docs/adr/ 现有 ${adrCount} 篇）`,
        });
      }
    }
  });
  return hits;
}

let violations = 0;
const report = (relative, line, text, reason) => {
  violations += 1;
  console.error(`DOCS    ${relative}:${line} 「${text}」— ${reason}`);
};

for (const file of targets) {
  const relative = file.slice(root.length + 1).replace(/\\/g, "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of SUPERSEDED) {
      if (!line.includes(rule.term)) continue;
      const unless = [MENTIONS_LEGITIMATELY, rule.unless]
        .map((pattern) => pattern?.source)
        .filter(Boolean)
        .join("|");
      if (new RegExp(unless).test(line)) continue;
      report(relative, index + 1, rule.term, rule.reason);
    }
    for (const wrong of checkTotals(line)) {
      report(
        relative,
        index + 1,
        `schema 总数 ${wrong}`,
        `与 schemas/ 不符（现有 ${schemaCount} 个 schema）；若指的不是总数，改写措辞`,
      );
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

if (violations > 0) {
  console.error(`\ndocs:check FAILED — ${violations} violation(s) across ${targets.length} file(s)`);
  process.exit(1);
}
console.log(
  `OK      docs: ${targets.length} file(s) scanned, ${adrCount} ADR(s) present, 0 violation(s)`,
);
