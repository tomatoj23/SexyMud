# AGENTS.md

## Start here

> 🎯 **本项目是「一个中文优先的确定性文字 MUD 引擎」+「一个武侠内容包」**（ADR-0026）。三条硬标准（引擎与内容分离／面向未来／依赖自包含）是**产品定义**，不是开发习惯。写任何代码前先问：这属于引擎还是内容？

**开工路径**：
1. **`docs/spec/00-overview.md`** —— 一页纸定位（引擎 + 内容包的边界、三条验收标准）。
2. **`docs/spec/08-non-goals.md`** —— **明确不做的事。做设计决策前必读。**
3. 再按要做的子系统读 `docs/spec/01`~`07`，每份末尾有自检清单。

**归档/历史**：`docs/HANDBOOK.md`（总览与定案速查）· `docs/adr/`（26 篇决策历史）· `docs/chinese-mud-concerns.md`（中文问题全景）· `docs/engine-purity-audit.md`（耦合审计）。

> ⚠️ **ADR 是决策日志，不是当前规格。** ADR 之间有网状覆盖关系（0025 修订 0017、0024 修正 0022 与 0023）。**冲突时以 `docs/spec/` 为准。**

## Environment（硬性标准）

依赖环境必须完全自包含于本项目，**禁止改动本机任何已有环境**：

- 禁止 `npm install -g`、`corepack enable`、修改全局 PATH/shim/配置、升级宿主机 Node
- 包管理器用 `corepack pnpm`（版本由根 `package.json` 的 `packageManager` 锁定）；包缓存在项目内 `.pnpm-store/`（见 `pnpm-workspace.yaml`）
- 新依赖只进 workspace 的 dependencies/devDependencies；pnpm 要求审批构建脚本时逐个审慎添加
- 详见 `docs/adr/0007-project-isolated-dependency-environment.md`

## Agent skills

### Issue tracker

Issues live in the repo's GitHub Issues, accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Content pipeline

Game content lives as JSON files under `content/`, validated by JSON Schema (`corepack pnpm content:check`). Batch edits by agents must follow `docs/agents/content.md` and the style guide at `content/style-guide.md`.

> **Note**: `corepack pnpm content:check` is the committed pipeline contract (ADR-0003); the script (`scripts/check-content.mjs`, landed with issue #2) auto-discovers every JSON under `content/` and validates it against `schemas/` by directory convention — currently the three `config/` files. Schemas for collections without content yet remain design drafts.
> **Authoritative docs (descending precedence)**: `CONTEXT.md` (glossary) / `docs/agents/content.md` (content pipeline) > `docs/adr/` > `content/style-guide.md` (writing style) > `docs/engine-reservations.md` (**reference / lowest**: a design inventory, not a decision).
> `docs/design-spec-BRIEF.md`, `docs/archive/`, `docs/design/` were **deleted on 2026-09-01** (idle-game era, stale after the MUD pivot). Don't reference them; recover with `git checkout 79bd991 -- docs/design-spec-BRIEF.md docs/archive/` if ever needed.
