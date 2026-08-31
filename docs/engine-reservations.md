# 引擎预留清单

> **来源**：从 `docs/design-spec-BRIEF.md` §11 提取（该文件其余部分为放置游戏时期规格，MUD 转向后已失准，于 2026-09-01 删除）。
> **定位**：**设计清单，不是 ADR**。效力低于 `docs/adr/`，仅供设计 `content/effects/`、`content/martial/` 条目与 `condition` 维度时对齐枚举池。
> **原则**：清单里的每一项都应是**枚举池的一个取值**，加一项 = 加内容，不动引擎（ADR-0004）。

## 1. `condition` 维度（必须可扩展）

```
element（系别）/ source（内功|外功）/ moveId（招式）/ moveTier（品阶）
targetState（目标状态）/ sectId（门派）/ lineageId（脉）/ equippedTag（装备标签）
/ equippedSet（套装）
```

只要 condition 维度可扩展，「强化特定武功」这类需求永远不用改引擎。

> **待补（MUD 转向后新增的候选维度）**：`roomId`（所在地）／ `zoneId`（区域）／ `timeOfDay`（昼夜）／ `weaponType`（兵器）／ `stance`（姿态）。这些是 MUD 独有情境，ADR-0021 的命令集合并会用到。

## 2. `targetSelector`

单体 ／ 全体 ／ 相邻 ／ 随机 N 个 ／ 除主目标外。

三来源优先级：**玩家指令 > 玩家策略配置（存档）> 招式自带（内容）**。

> 注：第一优先级原为「实时点击」，MUD 无点击，改为玩家指令（ADR-0016 的 manual-source 优先）。

## 3. 武学效果穷举（16 项）

| # | 效果 | primitive |
|---|---|---|
| 1 | 造成伤害 | `instant-damage` |
| 2 | 持续伤害 | `damage-over-time` |
| 3 | 增益 / 减益 | `stat-modifier` |
| 4 | 控制 | `action-lock` |
| 5 | 破防 | `armor-modifier` |
| 6 | 闪避修正 | `dodge-modifier` |
| 7 | 频率修正 | `rate-modifier` |
| 8 | 暴击修正 | `crit-modifier` |
| 9 | 治疗 / 回复 | `heal` |
| 10 | 吸血 / 吸内 | `instant-damage` + `heal` |
| 11 | 反伤 | `instant-damage`（target = 攻击者） |
| 12 | 溅射 | `instant-damage`（targetSelector = 相邻） |
| 13 | 连击 | ⚠️ 需「重复执行」能力，待确认 |
| 14 | 驱散 | `dispel` |
| 15 | 护盾 | ⚠️ 可归入 `stat-modifier`，但有「吸收量」语义，可能需独立 |
| 16 | 位移 / 位置 | 未涉及（战斗是否有位置概念未定） |

**心法可提供**：常驻数值加成 ／ 条件加成 ／ 被动触发 ／ **改变机制行为**（如「灼烧不再衰减」——与兽的放大器模型同构）。

> **与 ADR-0020 的关系**：第 2、4、5、7、8 项正是七系结构签名的实现基础（节奏／控制／档位跃迁／频次／事件触发）。

## 4. 装备影响穷举（12 项）

| # | 影响 | 状态 |
|---|---|---|
| 1 | 数值加成（攻/防/生命） | ✅ |
| 2 | 系别加成 | ✅ |
| 3 | 定向强化（某招式 +X%） | ✅ |
| 4 | **机制改变**（「你的中毒会传染」） | ✅ 即兽的放大器模型，可推广 |
| 5 | 触发效果（当 X 时 Y） | ✅ trigger + condition |
| 6 | 内功/外功偏向 | ✅ `source` 维度 |
| 7 | **套装效果**（集齐 N 件） | ✅ 需 `equippedSet` 维度 |
| 8 | 负面词缀 | ⚠️ modifier 支持负值，随时可加 |
| 9 | 装备特效（击杀回血） | ✅ |
| 10 | 耐久 / 损耗 | ❌ 不做 |
| 11 | 洗练（重随单条词缀） | ✅ |
| 12 | 升级 / 强化 | ⚠️ ADR-0005 未提，与 socket 同族 |

## 5. 战斗形态

**1vN 支持，1v1 为特例**。限时/生存、Boss 特殊机制、PvP 未涉及。
