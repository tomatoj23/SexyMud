#!/usr/bin/env node
// 参考库引用格式 lint（L7）：扫落盘文档里的 Reference_Documents/ 引用，验「引用三件套」。
// 用法：REPORT_ONLY=1 node scripts/check-refs.mjs   —— 只报不拦（新目标先跑这个估规模）
//       node scripts/check-refs.mjs                 —— 硬门禁（缺件即退出码 1）
// 三件套格式（见 docs/agents/reference-lookup.md）：
//   Reference_Documents/<树>/<路径>:<行号>（快照 X，项目 Y，版本差标签）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN = ["docs", ".scratch", "AGENTS.md", "CONTEXT.md"];
const CITE = /Reference_Documents[\\/][^\s）)】\]，。；;：:]+:\d+/g;
const THREE = /（快照 [^，]+，项目 [^，]+，[^）]+）/;

const files = [];
function walk(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (name === "node_modules") continue;
      walk(join(p, name));
    }
  } else if (p.endsWith(".md")) {
    files.push(p);
  }
}
for (const s of SCAN) walk(join(ROOT, s));

const reportOnly = process.env.REPORT_ONLY === "1";
let bad = 0;
let cites = 0;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const ms = line.match(CITE);
    if (!ms) return;
    cites += ms.length;
    if (!THREE.test(line)) {
      bad++;
      console.log(`${relative(ROOT, f)}:${i + 1}  引用缺三件套: ${ms[0]}`);
    }
  });
}
console.log(
  `check-refs: 扫 ${files.length} 个 md，命中 ${cites} 处引用，缺件 ${bad} 处${reportOnly ? "（REPORT_ONLY，不拦）" : ""}`,
);
if (!reportOnly && bad > 0) process.exit(1);
