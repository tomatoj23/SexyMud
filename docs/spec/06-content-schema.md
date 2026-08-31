# 06 · 内容集合与 Schema

> **状态**：`content:check` 管线**已实现**；16 个 schema **需随本规格重估**（放置期设计）。
> **依据**：ADR-0003、ADR-0008、ADR-0025 记录（配置三分法）、`docs/agents/content.md`（内容管线权威）。

## 1. 集合

`content/` 下 16 个集合 + `config/`。**每个条目一个 JSON 文件**。

| | | |
|---|---|---|
| `commands/` | `rooms/` | `npcs/` |
| `martial/` | `equipment/` | `effects/` |
| `monster/` | `dungeon/` | `beast/` |
| `herb/` | `pill/` | `sect/` |
| `event/` | `combat-text/` | |
| `config/` | 结构性配置（每集合一文件） | |

⚠️ `commands/`、`rooms/`、`npcs/` 三个集合的 schema **待 M1 补**（见 `00-overview.md` 当前状态）。

## 2. 硬规则

| 规则 | 说明 |
|---|---|
| **id 一经发布不可变更** | 资产路径、存档引用都依赖它 |
| **条目集合命名** | `<集合缩写>-<门派/区域>-<序号>`，如 `mrt-hs-001`（华山招式 1） |
| **config 集合豁免序号段** | 用 `<类别>-<序号>` 或语义名，如 `act-practice`、`res-experience` |
| **id 只用小写字母、数字、连字符** | |
| **归属字段化，不做目录分层** | `zoneId` / `sectId` / `regionId` |
| **标记位代替特殊类型** | 纯叙事道具 = 普通条目 + `tags:["quest"]` + 价值归零 |

依据：`docs/agents/content.md`

## 3. `content:check` 硬门禁

```
corepack pnpm content:check
```

- 自动发现 `content/` 下全部 JSON，按目录约定映射到 `schemas/`：
  - `content/<集合>/<条目>.json` → `schemas/<集合>.schema.json`
  - `content/config/<名>.json` → `schemas/config.<名>.schema.json`
- 退出码即结果

⚠️ **不得用 `npm run` 调用** —— 违反硬标准 3（ADR-0007）。

### 3.1 已知缺口

- **只从 content 侧枚举，从不遍历 schemas/** —— 13 个 schema 永远不被校验（孤儿 schema 静默通过）
- `config.settings.schema.json` 的 `additionalProperties: {}` 无约束，写错键名不会被拦

依据：ADR-0003、第三轮子代理审计

## 4. Schema 三处同步

改一个 schema 必须同步三处：
1. `schemas/*.schema.json`
2. 引擎 `packages/core` 的类型
3. `docs/agents/content.md`（字段约定）

## 5. ⚠️ draft-07 约束

本项目用 **JSON Schema draft-07**（ajv 严格模式）。**2019-09+ 的关键字不可用**：

| 想要 | 用 | 不要用 |
|---|---|---|
| 条件必填 | `dependencies: { "rates": ["cycleSeconds"] }` | ~~`dependentRequired`~~ |
| 递归结构 | `$ref` 自引用 | — |

（我实测踩过：`dependentRequired` 会让 ajv 报 `strict mode: unknown keyword`，`content:check` 直接挂掉）

## 6. 配置三分法

| 类 | 内容 | 放哪 |
|---|---|---|
| **STRUCTURE** | 装配图：模块路径、typeclass、cmdset | **不进** settings，用 `$ref` 指向内容 |
| **TUNING** | 数字：战斗/成长/经济/上限/时长/节流 | **进** `content/config/settings.json` |
| **POLICY** | 决策：权限层级、多会话模式、默认策略 | **另开** `content/config/policy.json` |

### 6.1 `settings.json` 首发建议 9 类

`combat` / `progression` / `derivedStats` / `economy` / `rng` / `caps` / `time` / `newPlayerDefaults` / `throttles`

### 6.2 三条硬规则

1. **禁止用 `null` 表示「无限」**（Evennia 用 `None`/`0`/负数三种方式，极不一致）→ 用 `{"unlimited": true}`
2. **时间值单位写进键名**（`cooldownSeconds`）
3. **每组加 `formula` 字段**存公式表达式 —— 让数值与公式同处一地（这正是 Evennia 缺失、而我们「零硬编码」目标需要的）

依据：ADR-0025 记录

## 7. 引擎预留清单

`condition` 维度、`targetSelector`、效果 primitive 穷举（13 项）、装备影响穷举 —— 见 `docs/engine-reservations.md`。

**原则**：清单里每一项都是**枚举池的一个取值**，加一项 = 加内容，不动引擎。

## 8. 自检清单

- [ ] 每个条目是独立 JSON 文件，id 符合规则
- [ ] 归属用**字段**不用目录分层
- [ ] 改 schema 后**三处同步**（schemas / core 类型 / content.md）
- [ ] 只使用 **draft-07** 关键字
- [ ] 用 `corepack pnpm content:check` 调用（不用 `npm run`）
- [ ] settings 里没有模块路径 / typeclass / cmdset（那是 STRUCTURE）
- [ ] 没有用 `null` 表示「无限」
- [ ] 时间相关键名带单位
- [ ] 新增内容跑过 `content:check` 且全绿
