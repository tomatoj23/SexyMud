# 引擎纯度审计（换内容演练）

> 🧊 **本文是 2026-09-01 的一次性快照，不是现状。** 其中的数字（如「6 个源文件」「16 个 schema」「config 3 个文件」）在清零提交 `6a36674` 之后已失效，仅作决策依据保留。**当前状态请看 `docs/spec/00-overview.md`。**

> **日期**：2026-09-01
> **目的**：验证 ADR-0026 的验收标准第 2 条——**换一套非武侠内容包，引擎不改一行代码即可运行**。
> **方法**：审计 `packages/core/src`（6 个源文件）实际读取了 `content/` 的哪些字段，判断每个耦合是「题材耦合」还是「领域耦合」。
> **性质**：一次性审计证据，非规格、非决策。

## 结论

| 验收标准 | 结果 |
|---|---|
| 1. 题材中立（引擎无题材词） | ✅ **通过** |
| 2. 换内容不改代码 | ❌ **不通过** |
| 3. 中文无损 | N/A（未实现） |

**一句话**：引擎通过了「词汇」检验，但**没通过「领域」检验**——它读的是一套**放置游戏的世界模型**，不是中立的 MUD 模型。

## 事实

### 引擎实际读取的内容

`GameContentConfig` 只有两个字段：`activities` 与 `resources`。也就是说：

- **引擎只读 `content/config/activities.json` 与 `resources.json` 两个文件**
- 16 个集合中，**只有 `config/` 有内容**，其余 15 个集合**没有任何条目**
- 16 个 schema 中，**只有 3 个被 `content:check` 实际执行**，其余 13 个从未被校验

### 读取的字段

```
activity.id / .name
activity.rates[].resourceId / .amountPerCycle
activity.cycleSeconds          ← 周期产出
activity.offlineCapHours       ← 离线上限
resource.id / .name
```

## 五处耦合

### C1 · 领域耦合：周期产出 + 离线上限（`cycleSeconds` / `offlineCapHours`）

`createGame.ts:60-61` 直接基于这两个字段计算：

```ts
const cycleMs = (activity?.cycleSeconds ?? 0) * 1000;
const capMs = activity?.offlineCapHours != null ? activity.offlineCapHours * 3_600_000 : Infinity;
```

这是**挂机循环**的本体：**开始活动 → 按周期累积 → 离线上限截断**。MUD 不需要这套模型——MUD 的产出来自玩家的指令，不是时间的流逝。

**性质**：领域耦合（不是题材耦合）。换任何非放置游戏都用不上。
**判定**：**清零**。

### C2 · 领域耦合：`Clock` 是墙钟毫秒，不是 tick 计数

同上两行直接把秒/小时换算成**毫秒**，而 `apps/web` 的实现是 `{ now: () => Date.now() }`。

这与 ADR-0016 §4（心跳是固定步长 tick）和 ADR-0025 §1（`Clock.nowTick()` 是 tick 计数）**直接冲突**。

**性质**：违反已定的引擎契约。
**判定**：**清零重写**（`Clock` 改为 tick 计数）。

### C3 · 文档与实现矛盾：`settings.json` 引擎完全不读

`schemas/config.settings.schema.json` 自称是「公式常数、上限、倍率、默认策略的唯一载体」，但 `GameContentConfig` 里**根本没有 settings**，且 `content/config/settings.json` 是空壳（只有 `{"id":"settings"}`）。

**性质**：虚假承诺（文档说有，实现没有）。
**判定**：随清零一并修正（按 `docs/spec/06-content-schema.md` §6 的三分法重建）。

### C4 · 校验缺口：13 个 schema 从未被执行

`scripts/check-content.mjs` **只从 content 侧枚举**，从不遍历 `schemas/`。因此「有 schema 无内容」永远静默通过——`config.dimensions.json`、`config.display-tiers.json` 缺失无人报警。

**性质**：门禁缺口。
**判定**：**保留管线**，补一项：反向扫描孤儿 schema 并告警。

### C5 · 状态模型：`GameStateV1` 是放置状态

```ts
{ resources: Record<string, number>; activeActivityId: string | null; lastSettleTimestamp: number }
```

字段围绕「正在挂哪个活动、上次结算到什么时候」。MUD 状态应该是「角色在哪、身上有什么、会什么」。

**性质**：领域耦合。
**判定**：**清零重写**（按 `docs/spec/04-state-and-time.md`）。

## 应该保留的（与领域无关，是资产）

| 资产 | 为什么留 |
|---|---|
| `engine-purity` 测试 | 会真实报错，是硬标准 1 的机械保障 |
| `content:check` 管线 + ajv 配置 | 与领域无关；只需补 C4 的反向扫描 |
| `ContentRegistry` 引用完整性检查 | 通用能力（未知 id 大声失败） |
| 版本化存档迁移链骨架 | `SAVE_VERSION` + `migrations` 表，通用 |
| pnpm monorepo + 依赖自包含 | 硬标准 3 的落地 |
| `apps/web` React 壳 | 宿主骨架 |

## 对「清零」的结论

**审计支持清零**，但精确地说是：

> **清掉领域模型（`content/types.ts`、`engine/`、`save/migrations.ts` 的 `GameStateV1`、`activities`/`resources` 配置语义），保留工程基础设施（测试、校验、迁移骨架、monorepo）。**

理由（由审计直接得出）：
1. 引擎的**形状**是放置的形状（C1、C5），不是词汇问题——改不掉，只能重写
2. 引擎已经**违反了自己后来的契约**（C2：Clock 应为 tick），补丁式修改等于在错误抽象上叠新抽象
3. 内容侧几乎空白（15/16 集合无内容），没有需要迁移的内容资产
4. 但基础设施（C4 的管线、纯度测试、迁移链）与领域无关，价值完整

## 建议的执行顺序

1. 按 `docs/spec/` 重写引擎（从命令层开始，见 `docs/spec/02-command-layer.md`）
2. 保留并补强工程基础设施（C4 反向扫描）
3. 内容按新的 `06-content-schema.md` 重估 schema
4. 每完成一个子系统，跑 `docs/spec/` 对应文件的自检清单
