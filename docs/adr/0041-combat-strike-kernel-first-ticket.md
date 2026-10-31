# 一击结算内核（C1）：attrs 槽＋效果执行器＋伤害结算＋NPC 会话归属＋目标解析——引擎首个机制模块出厂

引擎在 #55 之前有命令层／世界层／时间调度但**零机制模块**（spec/01 §8 两条挂账：「六条契约已定义」缺效果半边、「机制模块不互相 import」无从验证）。战斗/机制第一票（#56，tracer bullet）按 2026-10-29 访谈定案 D1–D12＋至 2026-10-31 **十二轮**全面审核（成立 72 条全修、复核不成立 3 条留档、第十二轮零发现＝收敛）落地：**一条「打」命令走通「目标解析 → 效果执行 → 伤害结算 → 概率上毒 → 补偿结算毒跳 → NPC/玩家双向死亡 → 会话随档」全链**，毒是观察时补偿结算的首个真消费者（spec/04 §4.2/:421/:423 三条挂账随批收口）。T1/T7/T9 由 owner 裁定（2026-10-30，均按推荐），T2–T6/T8/T10/T11 实现期按票面推荐值落定（全表见 `.scratch/combat/IMPL-DECISIONS.md`）。立否三条件自评：**难逆**（两新状态槽进存档形状、事件联合从五扩八、effects schema 改名——撤回波及存档兼容与全部战斗调用面）／**会困惑**（「NPC 的 HP 为什么挂玩家实体」「毒为什么离线照跳」「反击为什么裸伤」无记录必读不懂）／**真权衡**（瞬态会话／心跳先行／单点结算函数等被否路线见 §Considered）——三条齐，立。

## Context

- **设计输入**：`docs/spec/00` 三条硬标准（引擎与内容分离——战斗是引擎机制、数值与文案是内容）；ADR-0009（`防御/(防御+K)` 减伤、事件字段面）；ADR-0011 §7（伤害档位）＋spec/01 §5.2「后补伤及存档与模拟器兼容性」；ADR-0016 §4（离线不自动战斗）；ADR-0005:14-15（修饰符管线先于战斗）；ADR-0028 §2（目标解析预留位）；ADR-0029（维度表封闭）；ADR-0034（两层推进/结算事件盖 dueTick）。决策工作稿 `.scratch/combat/`（DECISIONS-WIP＝访谈与审核台账、AC-AND-PINS＝票面底稿、IMPL-DECISIONS＝实现批裁量）。
- **票前事实**：状态树无数值槽（spec/04 §4.3 刻意拒开——「第一票＝attrs 的第一个设计者」）；`effects.schema.json` 毫秒字段与 tick 模型冲突且 content/effects/ 零条目（唯一零成本改名窗口）；`npc-lq-003`（孙彪）已声明 `monsterId` 但 `inn-lodger` 旗标全仓无授予途径（T1）；调度五原语已落但补偿结算无真消费者。
- **终态路线图（owner 2026-10-29）**：自动战斗＋手动释放技能；C1（本票）→ C2 战斗会话＋自动互打 → C3 招式＋手动释放（冷却首个真消费者）→ C4+（修饰符聚合/七系/战斗文本 13 槽）。C1 的手动一击＝终态最简内核，非抛弃式脚手架。

## Decision

1. **驱动模型（D1）**：命令驱动一来一回——一条「打」＝一次玩家攻击＋一次 NPC 立即反击（反击是临时语义，C2 被按节奏出手取代；保留以验证双向结算与玩家死亡路径）。
2. **NPC 可变状态归属（D2）**：**战斗会话挂玩家实体新槽 `combat`**、随档持久（读档可续战、NPC 死亡跨档）。NPC 不进状态树（不动摇 ADR-0028 静态在场）；已知债务：HP 归属随多目标/多人票再正。瞬态方案被 CONTEXT.md「非持久状态游戏逻辑不得读取」词条排除。
3. **attrs 槽（D3）**：`EntityState.attrs: Record<string, number>`，走 `SLOT_RULES`（缺席→`{}`、畸形拒〔第十四类〕；照 tags 先例 **v2 内中途落地、不开 v3**）；键规范序归 `serializeWorld` 规范序清单（「not a row」）。**角色模型声明表**进 `content/config/character.json`（属性键清单＋初值＋主资源键对＋死亡阈值＋一击操作数通道 attackAttr/defenseAttr/element/source——T4/T10：攻击键是玩家→NPC 主方向无条件操作数、防御键为 C2 双向公式声明占位）；**引擎不认识任何具体键**（ADR-0009 §10）。新档种子 `seedCharacterAttrs`（宿主在 startNewGame 调）；attr 条件 facet（attr_gte 谓词）同批接通。
4. **效果执行器（D9/T11）**：`src/effects/`＝**契约侧**（`entry.ts` 条目形状＋`modifiers.ts` 修饰符最小核＋`registry.ts` primitive 注册表，照 PredicateRegistry 先例：重名抛错、可注入）；实现住消费侧（`combat/primitives.ts` 的 `instant-damage`／`damage-over-time` 注册进表）——**effects/ 零机制 import，六条契约「机制模块不互相 import」首验通过**（spec/01 §8 随批勾选）。T11 全按推荐：①(a) instant-damage＝**触发**一击结算、条目 `amount` 闲置留位；②DoT 跳伤挂载时算定入记账 `dot.perTick`（跳时不再读条目数值；每跳值＝条目 `amount` 过修饰符核）；③schema 补 `maxPulses` 声明；④毒终止走 `tickIntervalTicks × maxPulses`（`durationTicks` 归 stat-modifier 族、DoT 不读）。`effects.schema.json` 三字段 tick 化改名（durationMs→durationTicks／tickMs→tickIntervalTicks／cooldownMs→cooldownTicks）。命令条目扩 `effects` 引用字段（三处同步），注册表加载期校验悬空引用（照 npc→monsterId 先例）；`COLLECTIONS` 加 effects 行（声明表不豁免三处同步，spec/06:21 原文）。
5. **伤害结算（D5/T2/T9/T10）**：`max(1, round(attack × (1 − defense/(defense + K))))`，K＝`settings.combat.defenseK`（缺键大声失败，O3 律）；闪避＝monster `stats.dodge` 单值概率直接消费（`rng.next() < dodge` ⇒ 0 伤，注入 Rng 同种子重放同结果）；**NPC 反击＝裸伤直取 `stats.attack`**（不走公式、不吃玩家防御、玩家不掷闪避——T2/T10 合成「反击完全不吃玩家侧成长」，玩家闪避随 C3 资源体系来）。**结算形态（T9 owner 裁定）＝ADR-0005 最小核两层空退化形**：`aggregateModifiers(base, flats, percents)` 管线结构在、C1 无词缀两层恒空——**0005 字面被遵守、无覆盖关系**（战斗每个数字都过这唯一管线，无旁路；C4 修饰符票填层）。
6. **毒（DoT，D4/T8）**：`chance` 概率挂载；跳伤＝**观察时补偿结算完整语义**（`floor((nowTick−startTick)/interval)` 补齐、`maxPulses` 上限、跨命令与**跨离线**同路）；毒实例记账 `dot: { effectId, startTick, applied, perTick }` 随 combat 槽落档（`effectId`＝读档续毒的条目回溯键，interval/maxPulses 不落盘）；dotTick 事件 tick 盖**本跳 dueTick**（`startTick + k×interval`，spec/01 §5.0）；跳满 maxPulses 即清记账（T11④）；一次补齐中途中途 HP≤0 即止、剩余 pulses 作废（T8）；**重复挂载不重挂**（审查批补裁：`maxPulses` 是一场中毒的总上限不是每击上限，重挂不重置跳数不刷新起点）。⚠️ **对 ADR-0016 §1 的覆盖记录**：毒离线照跳（可致死、产事件）是对「离线只补资源与基础熟练度」白名单的**第一次扩充**——按 ADR-0032→0016 §4 的覆盖惯例记录于此（spec/04 :423 已随批改写）；「不自动战斗、不推层、不产掉落」不变——毒跳是状态结算不是替你打怪。
7. **死亡（D7/T6）**：NPC HP≤0 → death 事件＋会话 `targetDead` 标记＋再打 `rejected`（customCode `targetDead`，err_* 先例文案）；玩家 HP≤ 死亡阈值 → death 事件＋主资源回满＋`moveTo` 传送回声明起始房（宣告随移动事件）＋**清除整个 combat 会话**（含毒记账与 NPC 死亡标记——T6：「孙彪也缓过来了」，语义最简）。
8. **事件三臂（D6，AC7）**：`strike`／`dotTick`／`death` 进 `EngineEvent` 封闭联合（五型扩八型；factory 三枚、`isEngineEvent` 收窄）。字段第一天全量：strike 带伤害/剩余气血**档名**（damageBand 四值/lifeBand 五值——档名取 dimensions 既有词汇、**数值边界**进 `content/config/combat-tiers.json` 区间表〔分母基准＝受击者 maxHp〕，不另立第二处档名真相）、isDodge、isCrit〔恒 false〕、element、source、**`rank?` 可选占位**（C1 恒缺省、C3 带值——以占位消解「后补伤兼容」红线）；dotTick 带 effectId/targetId/damage/双档名/pulsesApplied/pulsesTotal；death 带 deceasedId/kind/cause。**渲染缝随本票收口**（spec/05:26「渲染缝随机制模块票」兑现）：renderEvent 三臂分派＋`RenderCopy` 扩六个固定模板键——**文案承载（T7 owner 裁定）＝宿主固定模板**（C1 极简面住 apps/web、与 #48 Q5「文案题材词住宿主」同向；C4 战斗文本票迁内容侧）。五型口径活文档 8 处随批改写（spec/05×3＋spec/01×3＋HANDBOOK×2）。
9. **目标解析（AC/ADR-0028 §2 预留位兑现）**：`world/target.ts` 的 `resolveNpcTarget(registry, roomId, ref)`——`TargetRef` → 同房间 NPC 实体（静态在场清单直读、name 全等、ordinal 1 基）；失败两码 noMatch/notCombatant。**cmd-strike 三项检查（同房间/声明 monsterId/未死）走执行段拒绝**（`CommandRejection`＋`err_*` 定位文案，照 traversal 的 enter 门先例）——谓词模型对树中玩家 subject 求值、无目标位，不为此扩展「目标侧求值上下文」机制（condition.schema 白名单零扩展）。func 归属＝引擎出厂适配器 `strikeSpec`（traversal/look/say 同族）。
10. **给标途径（T1 owner 裁定）**：内容侧最小改动——新命令 `cmd-lodge`（住店/投宿/lodge）＋引擎通用适配器 `grantFlagSpec(entry, flag)`（幂等给旗标＋`customEvent("flagGranted")`——扩展臂、flag 词随宿主绑定表「换包换表」）＋宿主会话层消费事件出 hostCopy 行（enterText 直出同族；**门禁与「后院只供住店客人」叙事零改动**）。
11. **效果单向（D12）**：C1 玩家→NPC 单向；monster 条目的 `effects` 引用留而不消费（C2 怪物才用自己的效果表）。combat 槽按**会话**命名与形状设计（D11：C2 在同一槽长节奏字段，不推倒改名）。
12. **宿主接线**：命令 tick 接 `HostClock`（web `tickSeconds: 2`——毒按真实时间跳）；游戏会话 harness 桥接 runtime 时钟（`testClockOver`，单一「现在」）＋settle 层接 `createDotSettleHandler`；战斗模板词面进 hostCopy。

## Considered Options

（被否路线全文见 `.scratch/combat/DECISIONS-WIP.md` §3 与票面 §待定清单）

- **战斗状态全瞬态**：被 CONTEXT.md「非持久状态游戏逻辑不得读取」排除。
- **心跳自动战斗进第一票**：会话生命周期/逃逸/intent 是 C2 正菜；终态已由路线图锁定。
- **玩家 HP 夹 1 濒死保底**：打不死怪也死不了的死循环。
- **即时减益替代 DoT**：:421/:423 两挂账继续悬空，第二票翻烧饼更贵。
- **12 阶段管线骨架现在立＋单点结算函数**：T9 裁定**最小核两层空退化形**取代单点函数——遵守 ADR-0005 字面（「战斗代码从第一行起走修饰符管线」），无覆盖关系要记。
- **NPC 被打即动态进树**：「双重在场呈现」是后续票的量；HP 归属债务随多目标/多人票再正（D2）。
- **「目标侧谓词求值上下文」机制扩展**：C1 用执行段拒绝即足（解析产物即检查输入）；谓词模型不动、白名单零扩展——机制缝路线实现批裁定。
- **战斗文案住内容侧**：T7 owner 裁定宿主固定模板（C1 极简面；C4 迁内容侧）。

## Consequences

- 存档形状新增两可选槽（attrs/combat，v2 内中途落地）＋事件联合扩三臂＋effects schema 改名——**全部属「本版本内」演进**，旧档零迁移照读（缺即空/无战斗）。
- spec 升级随批完成：spec/01（§5 八型＋§6 目录树 combat/＋§8 两行勾选）、spec/02（§1.4 目标解析）、spec/04（§1.4 两槽＋:421/:423 收口＋ADR-0016 §1 覆盖记录）、spec/05（渲染缝收口）、spec/06（23 schema/config 七类/effects 激活）、spec/00＋HANDBOOK（计数收口）、CONTEXT（新术语）。
- 已知债务：HP 归属挂玩家侧（多目标/多人票正）；反击立即出手（C2 节奏化）；战斗文本六模板住宿主（C4 迁内容侧）；`instant-damage` 的 `amount` 闲置留位（内容 authored 平衡伤害的票再定角色）；`settings.combat` 其余组（dodge 递减模型等）C3+ 随消费者落地。
