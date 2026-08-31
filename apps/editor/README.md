# @sexymud/editor

内容编辑器占位包。编辑器**不进 MVP**：内容生产走 agent 管线（`docs/agents/content.md`）+ `content:check` 硬门禁；本包仅保留 workspace 位置。

将来实现时遵循：

- 表单与校验由 `schemas/` 的 JSON Schema 驱动，无独立数据模型
- 读写目标永远是 `content/` 下的 JSON 文件（与手改、agent 修改同一数据源）
- 保存前必须通过 `corepack pnpm content:check`
