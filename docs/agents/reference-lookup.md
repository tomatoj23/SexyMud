# Reference lookup: 上游源码查证纪律

> 适用对象：本项目开发过程中的一切 LLM/agent/人。查证对象：`D:\My_Projects\Reference_Documents`（13 个上游项目 HEAD 快照，**只读**）。版本事实基准日 2026-09-29。

## 口诀（四句，可作注入摘要）

**现状问实装，上游问参考库，版本问 registry，领域问 spec。**
**先定年代，再限子树，引用带三件套。**
**库只读，写库＝事故。**
**查不到就写「查不到」，不留无出处断言。**

## 语义权威序（答什么问题用什么源）

| 你要回答的问题 | 权威源（按序） | 禁忌 |
|---|---|---|
| 「我装的这个版本怎么表现」（现状语义） | ① `node_modules` 实装代码/类型 ② 同版参考库文档 | ❌ 拿不同大版的库源码当现状 |
| 「上游为什么这么设计／将来怎么变」 | 参考库源码/CHANGELOG/migration（注明是 HEAD 快照） | ❌ 声称这就是现状行为 |
| 「哪个版本是最新／发布了没有」 | npm registry / 官网 | ❌ 拿库树版本号当发布事实（树可含未发布 dev 版） |
| 「引擎/游戏该怎么设计」 | `docs/spec/` > `docs/adr/` > `docs/research/`（Evennia/xkx100） | ❌ 到工具链库里找领域答案 |
| 「项目自己的约定/口径」 | `AGENTS.md`、`docs/spec/`、`CONTEXT.md` | ❌ 以上游惯例覆盖本项目约定 |

**混用即漂移事故源**：库是 HEAD 快照、项目锁旧版，跨大版引用语义必错位。

## 触发器（何时开库／何时别开）

**开库**（T1–T5）：
- **T1 行为溯源/排障**：第三方报错、警告、怪行为需查「上游为何如此」。
- **T2 升级影响评估**：列 breaking change、找迁移指南。
- **T3 同版查证**：库树与项目**同大版**时（如 ajv 8.20.0／husky 9.1.7），库文档可直接引为现状补充。
- **T4 写定案/ADR/规格**：需引用上游行为、机制出处（配置为什么长这样）。
- **T5 离线文档**：断网或官方文档不可及，库内 `docs/` 顶替。

**别开**：通用 TS/JS 知识（直接答）；项目领域设计（走 spec/research）；单纯查版本号（走 registry）；已在 `node_modules` 能直接读到的现状语义（实装优先，不必绕库）。

## 查证五步（每次都走）

1. **定归属**：先用「语义权威序」判断这个问题该不该开库、开哪棵树。不该开就停。
2. **定年代**：读树内版本标记定快照版本（`package.json` 的 version／`src/node_version.h`／`CHANGELOG` 头部／`ReactVersions.js` 等），与项目实装版本比对，得出结论的「版本差标签」：`同版可引`／`跨 N 个大版，仅升级参考`／`未发布 HEAD`。
3. **限子树**：`ls` 定位目标包目录与 `docs/`，grep 一律限定子树（如 `Reference_Documents/pnpm-main/pnpm11`）；**禁全库扫**（15.6 万文件）；巨型目录（`node-main/deps`、`cpython-main`、`electron-main/build` 等）默认排除。
4. **采信**：同版→可引为现状补充；跨版→只答「上游/将来」，现状回 `node_modules`；版本事实→回 registry 交叉核实。
5. **落笔**：引用写三件套，结论写版本差标签。

## 引用三件套（任何落盘材料里引库必带）

```
Reference_Documents/<树>/<路径>:<行号>（快照 <版本>，项目 <版本>，<版本差标签>）
```

**正例**：
- `Reference_Documents/pnpm-main/pnpm11/building/commands/src/policy/approveBuilds.ts:36（快照 pnpm 12.8.1 树含 pnpm11 线，项目 pnpm 11.24.0，同线可引）`
- `Reference_Documents/vite-main/docs/guide/migration.md:16（快照 8.3.1，项目 7.3.6，跨一个大版，仅升级参考）`

**反例**（常见错法）：
- ❌ 「vitest mock 语义见 vitest-main 源码」——无行号、无版本、跨两个大版（5.0.2 vs 3.2.7）当现状引。
- ❌ 「TypeScript 的类型推断按……」引 TS 树——树是 7.x Go 移植，与项目 5.9.3 漂移最大，现状问题必须回 node_modules。
- ❌ 「最新 pnpm 是 12.8.1（pnpm-main）」——库树版本≠发布事实，须 registry 核实（实测 12.8.1 就高于 npm latest 12.6.0）。

## 速查表（按树，路径为该树内相对路径）

| 树 | 现状可引？ | 高价值落点 | 陷阱 |
|---|---|---|---|
| `ajv-master` | ✅ 同版 8.20.0 | `docs/strict-mode.md`、`docs/json-schema.md`、`docs/options.md` | 无 |
| `husky-main` | ✅ 同版 9.1.7 | `docs/zh/`（中文）、`docs/troubleshoot.md` | 无 |
| `pnpm-main` | △ 双栈树 | `pnpm11/`（项目在用工具源码）、`AGENTS.md`（v11 修 bug／v12 新特性政策） | npm 部分是 v12 Rust，版本号高于线上 |
| `vite-main` | ❌ 跨一版（8.3.1） | `docs/guide/migration.md`（v7→v8）、`docs/config/`、`playground/` | Rolldown 时代语义≠项目 7.x |
| `vitest-main` | ❌ 跨两版（5.0.2） | `docs/guide/migration/index.md`（4→5）、`docs/api/`、`test/README.md`（测试分池） | 现状 API 回 node_modules |
| `react-main` | △ 跨 minor（19.3.0） | `CHANGELOG.md`（19.3 新特性/兼容性） | 19.2.8 无条目，补丁史查不到 |
| `vite-plugin-react-main` | ❌ 跨一版（6.1.1） | `CHANGELOG.md`、`playground/` | 无 docs/，行为看源码 |
| `node-main` | ❌ 快照 27 非 LTS | `doc/changelogs/CHANGELOG_V24.md`（项目在用线！）、`doc/api/`（v27 口径） | 27 是奇数 Current 线，勿当 LTS |
| `TypeScript-main` | ❌ 7.x Go 移植 | 仅类型系统疑难杂症源码查证 | **漂移最大，最不宜当现状依据** |
| `electron-main`／`pandoc-main`／`cpython-main`／`pytest-main` | — | 不检索 | 项目无关（ADR-0018 否决 Electron 等） |

## 红线（违者即事故）

1. **`Reference_Documents` 只读**：禁写入/修改/删除/移动/安装/构建/git 操作。生成的任何材料写到别处（本项目 `.scratch/` 或按票面落点）。
2. **禁全库 grep**：限定子树，防噪音与超时。
3. **禁无出处断言**：引库必带三件套；查不到就写「查不到，需外链补」，不猜。
4. **禁库版本当发布事实**：版本号一律 registry/官网核实。
