# AGENTS.md

## Start here

**先读 `docs/HANDBOOK.md`** —— 统一总览：文档地图与权威层级、三条硬标准、核心定案速查（境界 / 显示档位 / 伤害模型 / 内力 / 战斗文本 / 秘境与掉落 / 装备槽 / 内容管线）、MVP 范围与当前状态。读完再按需进各专项文档。

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

Game content lives as JSON files under `content/`, validated by JSON Schema (`npm run content:check`). Batch edits by agents must follow `docs/agents/content.md` and the style guide at `content/style-guide.md`.

> **Note**: `corepack pnpm content:check` is the committed pipeline contract (ADR-0003); the script (`scripts/check-content.mjs`, landed with issue #2) auto-discovers every JSON under `content/` and validates it against `schemas/` by directory convention — currently the four `config/` files. Schemas for collections without content yet remain design drafts.
> `docs/design/` is **deprecated** early exploration docs (visual direction only) — do not read or maintain it.
> **Authoritative docs (descending precedence)**: `CONTEXT.md` (glossary) / `docs/agents/content.md` (content pipeline) > `docs/adr/` > `content/style-guide.md` (writing style) > `docs/design-spec-BRIEF.md` (**fallback / lowest**: defer to it only when the content exists nowhere else; on any conflict the higher-precedence doc wins).
