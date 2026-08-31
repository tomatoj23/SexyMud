# IdleRPG 手册（统一总览）

武侠放置 RPG（对标 Melvor Idle）。进度主轴 = 境界突破；特色 = 门派/流派二分 + 装备 × 武功构筑。
本文件是**索引与速查**，定案细节以权威文档为准。

## 权威与文档地图

| 文件 | 作用 | 状态 |
|---|---|---|
| `CONTEXT.md` | 术语词典（40+ 词条 + Avoid 表） | ✅ 权威（最高） |
| `docs/agents/content.md` | `content/` 目录、id 规则、字段约定、批量工作流 | ✅ 权威 |
| `docs/adr/0001`–`0015` | 15 个架构决策 | ✅ 权威 |
| `content/style-guide.md` | 叙事文风硬约束 | ✅ 权威 |
| `docs/design-spec-BRIEF.md` | 设计规格（Round 1–24 收口；含 50 档完整列表、引擎预留清单、兽/门派/成长等未落 ADR 的设计） | ✅ **兜底权威（最低优先级）** |
| `AGENTS.md` | agent 环境、技能、管线入口 | ✅ |
| `docs/agents/domain.md` | 工程技能如何消费本仓库文档（含 monorepo 路径规范） | ✅ |
| `docs/agents/issue-tracker.md` | Issues 走 GitHub（`gh` CLI） | ✅ |
| `schemas/` | JSON Schema（17 个，13 集合全覆盖）；`content:check` 已实际执行其中 config 4 类 | 🚧 其余集合随内容落地启用 |
| `docs/research/` | 竞品研究与生图提示词 | 参考 |
| `docs/design/`、`docs/archive/` | ⚠️ 废弃 / 归档，不作依据 | — |

**冲突处置顺序**：`CONTEXT.md`（术语）／ `content.md`（内容管线）> `docs/adr/` > `content/style-guide.md`（文风）> `docs/design-spec-BRIEF.md`（**兜底**：仅当内容只见于该文档时才以其为准；任何冲突以前者优先）。

## 三条硬标准

1. **引擎与内容完全分离**：引擎零题材词汇、零写死数量；境界序列、槽数、维度表、阈值等结构性配置只在 `content/config/`。
2. **面向未来**：修饰符聚合引擎、带完整语境的事件流、版本化存档迁移、Schema 三处同步（core／编辑器／`content.md`）、`content:check` 硬门禁——第一天做对；MVP 只控制系统数量，不降低架构完备度。
3. **依赖环境自包含**：`corepack pnpm`（版本由根 `package.json` 的 `packageManager` 锁定）、包缓存在项目内 `.pnpm-store/`；禁止 `npm i -g`、改全局 PATH、升级宿主机 Node（ADR-0007）。

## 核心定案速查

| 域 | 定案 | 出处 |
|---|---|---|
| 境界 | 不入流 → 三流 → 二流 → 一流 → 绝顶 → 宗师（6）；修为主要来自闭关 | `CONTEXT.md` |
| 显示档位 | **50 档**（区间表 `displayTiers` 映射），落 `content/config/`；「超凡入圣」「天人合一」豁免禁修仙词 | `CONTEXT.md`／BRIEF §10.2 |
| 伤害模型 | 兵刃层（恒有、受外功防御减）+ 系别层（× 系别系数）；方式（内功/外功）× 系别（七系 + 无属性）= 2×8；玩家抗性 = 条件修饰符（非属性） | ADR-0009 |
| 内力 | 持续回复 + 稳态 DPS 离线 O(1)；耗尽 → 零消耗基础攻击；代价"在另一维度付账" | ADR-0010 |
| 战斗文本 | 13 槽位 `{attacker}` 语法；模板 = 片段序列（3–7 段）；后果词库 5 维分池；三层门控；motion 是**动词**的属性 | ADR-0011 |
| 秘境与掉落 | 定时波次（难度涌现）；四参数在 config；掉落 8 步管线（**稀有度是因、词条数是果**）；底材分层 + 倾向标签化 | ADR-0012 |
| 装备 | **7 槽**（兵/冠/甲/腕/腰/裤/靴）+ 独立随从栏（兽）；稀有度四档；MVP 底材 42 个（约 294 项） | `CONTEXT.md`／BRIEF §9、§13 |
| 呈现 | 对峙式视觉层 + MUD 式叙事层；`core` 只吐结构化事件，不感知题材 | ADR-0006 |
| 构筑 | 掉落驱动（底材 × 稀有度 × 词缀阶位）；流派由标签联动涌现 | ADR-0005 |
| 内容管线 | `content/` 13 个集合 + `config/`（结构性配置）；每条目一 JSON 文件；id 一经发布不可变更 | `content.md` |
| 兽 | 本质是装备（修饰符 + 叙事片段），不是战斗单位；七系各一只**机制放大器**；独立随从栏不占 7 槽；数据在独立 `beast/` 集合（第 13 集合），获取走 sect `exchange` 兑换 | ADR-0013 |
| 门派 | 武功池 + 缺省系别 + 生产加成三件套；脉是武功池标签、非身份选择；已学武功与门派解耦 | ADR-0014 |
| 成长与反馈 | 突破偏向选择替代天赋树；纪录 + 叙事分档补中频反馈；专精靠词缀涌现 | ADR-0015 |

## MVP 范围（BRIEF §13）

门派 3 ／ 秘境 3 ／ 兽 2 ／ 底材 42 ／ 词缀池 20+ 条 × 3 阶 ／ 招式 4 · 心法 3 ／ primitive 9 个使用 + 2 个注册 ／ 出招调制器 4 ／ 内力最小形态 ／ 只做闪避（不做招架/格挡）

**明确不做**：任务体系、知识/生活技能、独立 NPC 集合、换派偷师、突破失败（走火入魔）、招架/格挡、`itemLevel`（ADR-0008、BRIEF §13）

## 当前状态

- ✅ 术语词典、文风指南、内容管线约定、**15 个 ADR**、BRIEF 审计遗留清零（§12.6）
- ✅ **Schema 17 个**：13 个集合全覆盖（`config` 拆 6 类 + effects / martial / equipment / beast / monster / dungeon / herb / pill / sect / event / combat-text）；`lore/` 是 Markdown，由 `style-guide.md` 约束，无 JSON schema
- ✅ 兽数据归属已定：独立 `beast/` 集合（第 13 集合），获取走 sect `exchange` 贡献兑换（ADR-0013）
- 🚧 `content/` 条目填充：config 已有 realms / resources / activities / settings 四个最小文件（dimensions、display-tiers 待补），其余 12 集合待生产（见 issue #17）
- ✅ **Monorepo tracer bullet 已落地（issue #2）**：`packages/core`（纯 TS 引擎门面 `createGame`，注入 content/save/clock/rng）+ `apps/web`（React + Vite 壳，本地存档、刷新不丢）+ `apps/editor` 占位；三测试套件（门面行为 / 存档迁移 / 引擎纯度）；版本化存档 v1 + 迁移链骨架
- ✅ **`content:check` 最小形态已落地**：`scripts/check-content.mjs` 自动发现 `content/` 下全部 JSON 并按目录约定映射 Schema 校验，退出码即结果（当前覆盖 config 4 文件）；完整化（交叉引用 / 连通性）见 issue #3
- ⏸ 待决：奇遇形态未定（`event/` 仅有最小骨架；形态未定的概念不进术语表）
