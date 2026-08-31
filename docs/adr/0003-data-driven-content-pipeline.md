# 数据驱动内容管线：JSON + Schema、本地编辑器、agent 写入约定

> ⚠️ **2026-09-01 更新**：文中出现的 **`npm run content:check` 一律改为 `corepack pnpm content:check`** —— 见 ADR-0007（依赖环境自包含）与 `docs/spec/06-content-schema.md` §4。用 `npm run` 属违规。
>
> 其余仍然有效：JSON + JSON Schema 硬门禁（`content:check` 退出码即结果）、每条目一文件、agent 批量工作流。

游戏内容（武功、装备、怪物、丹方、秘境、门派、奇遇、世界文本）全部数据化，不写死在代码里。决策内容：

1. **存储**：`content/` 目录，每个条目一个 JSON 文件，每个集合一份 JSON Schema。`core` 包加载时强制校验，不合法内容直接报错。编辑器表单由 Schema 自动生成，AI agent 产出以 Schema 校验为硬门禁。
2. **编辑器**：Monorepo 内的开发期本地编辑器（`apps/editor`），dev server 提供文件读写 API。表单视图（逐条）+ 表格视图（集合平铺，支持多选批量数值调整、文本批量替换）。内容永远是 git 里的 JSON 文件，编辑器/手改/agent 三者操作同一数据源。
3. **agent 写入约定**：`docs/agents/content.md` 定义目录结构、id 规则、批量生成工作流（写入 → `npm run content:check` 校验）；叙事文风由 `content/style-guide.md` 约束。
4. **美术资产前瞻**：条目必须有稳定 `id`；资产按约定路径引用（`assets/icons/<集合>/<id>.png`、`assets/portraits/<集合>/<id>.png`），JSON 可用 `art` 字段覆盖；加载器找不到资产时返回按 id 哈希的程序化占位符。MVP 零美术可跑，后期补图零代码改动。

## Considered Options

- YAML / TS 配置文件：agent 程序化批量修改与 Schema 校验工具链弱于 JSON，否。
- 内容存云端数据库：与 git 工作流、编辑器离线使用、agent 文件级操作冲突，否。
- 独立桌面编辑器：后期可做，MVP 不必。
- 资产引用写死在条目里且无占位符：后期美术接入会全面返工，否——故采用约定路径 + 占位符兜底。

## Consequences

- 所有内容条目的 `id` 一旦发布即不可变（资产路径、存档引用都依赖它），重命名等于破坏性变更。
- Schema 变更需同步三处：`core` 校验器、编辑器表单、`docs/agents/content.md` 的字段说明。
- `npm run content:check` 是内容进入 git 的必要条件（CI / pre-commit 可挂）。
- **校验分层**（2026-08 修订）：JSON Schema 校验由管线门禁 `content:check`（构建/CI）执行；引擎 `ContentRegistry` 在加载时强制引用完整性（未知引用、重复 id 即抛错）。即"不合法内容报错"由两层共同保证，不在 core 内重复实现完整 Schema 校验。
