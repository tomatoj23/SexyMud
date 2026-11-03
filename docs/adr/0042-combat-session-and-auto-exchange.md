# 战斗会话与自动互打（C2）：节奏对＋观察时补偿结算战斗变体＋读档条件重起＋逃逸＋声明式门禁＋主动攻击

战斗/机制第二票（#57）按 2026-10-31～11-01 四轮访谈定案 D1–D17（含审计批衍生裁定与七轮对抗审核全闭环）落地：**「打 X」从手动一击转为开战命令**——第一手立即结算（C1 手感保留）、会话转入自动互打，双方按各自间隔在观察点补偿结算中出手，NPC 的手从「立即裸伤反击」转为双向公式按节奏；死即清整场会话；战斗中移动＝逃逸；命令可声明战斗内门禁；主动怪在玩家进房时开战。立否三条件自评：**难逆**（combat 槽加节奏对、strikeSpec 语义反转、C1 四项断言面改写、内容新字段——撤回波及存档与全部战斗面）／**会困惑**（「读档为什么欠手不补而毒照跳」「同 tick 谁先出手」「逃逸成功但门没开算什么」无记录必读不懂）／**真权衡**（到期桶调度／心跳通道扩实体层／「合」概念等被否路线见 §Considered）——三条齐，立。

## Context

- **设计输入**：`.scratch/combat/C2-DECISIONS-WIP.md`（D1–D17＋七轮审核台账）、`C2-AC-AND-PINS.md`（票面）、`C2-IMPL-DECISIONS.md`（C2-T1–T9 实现批裁定）；ADR-0041（C1 内核与承接三项 F2/F4/F6）；ADR-0016 §1/§4（离线不自动战斗）；ADR-0032（一个推进函数两个跨度）；ADR-0034（两层推进、结算事件盖 dueTick、心跳无 actor）。
- **票前事实**：C1 的 NPC 立即反击是声明过的临时语义（0041 Decision 1）；毒已走观察时补偿结算（首个真消费者）；生产链路无周期心跳定时器（heartbeat 通道只推世界层）；事件联合八型封闭；`session.ts:15` 注释宣称毒跑在「every heartbeat」与实况不符（C2 实现批顺带收正）。
- **终态路线图（owner 2026-10-29）**：自动战斗＋手动释放技能——普通攻击自动化正是终态形态，手动插队是 C3 招式 perform 的位。

## Decision

1. **「打」＝开战（D2）**：第一手立即结算＋会话转自动互打；战斗中再「打」同目标拒（`customCode("inCombat")`——自动互打已在替你出手）、换目标拒（`targetLocked`，C1-T3 聚焦维持）；NPC 首手＝开战 tick＋其间隔（D10——C1 立即反击就此取代）。停战三径：NPC 死／玩家死（C1-T6 不变）／逃逸。
2. **节奏对（D13/C1-D11 兑现）**：combat 槽同槽加 `playerNextStrikeTick`/`npcNextStrikeTick`（**同进同出**：成对校验、一有一无＝畸形拒〔第十五类扩面〕；双双缺席＝无节奏数据——C1 旧档零迁移照读）；**间隔不落盘**（C2-T8：回溯声明表，毒 effectId 同构）——玩家＝`character.strikeIntervalTicks`（**必填**声明位，角色模型装配图性质；结算时直读，AC10）、NPC＝monster `stats.attackIntervalTicks`（**可选＋引擎缺省字面量 2**——「未声明 source 按 external」先例）。
3. **观察时补偿结算的战斗变体（D3/AC2）**：观察点＝**命令边界单点＋宿主带 actor 心跳**（毒同路现状＋C2-T7 接线）；`createCombatSettleHandler` **单调度器**把双方的手与毒的跳排上同一条时间线（C2-T4：并列两 handler 的 emit 按注册序不按 dueTick 序——交错补齐只有单循环能守）——按 dueTick 升序结算、每手事件盖 dueTick、**同 tick 玩家先手**（D9）→ NPC 手 → 毒跳（实现批补裁：两律的排序面）；NPC 死其同 tick 手与后续跳取消（与 D6 原子一致）。
4. **离线挂起＝读档条件重起（D3/AC3）**：`resumeCombatSession`（host 在 continueGame 读档点调用，基准＝读档时刻宿主墙 tick）：缺字段→种子 now＋间隔；`next≤now`→重置 now＋间隔（**欠手一律不补**——ADR-0016「不自动战斗」由读档点承载）；`next>now`→保留（短离线不越界惩罚）；**毒照补**（毒是状态结算、战斗是替你打怪——两律不混，白名单只有毒一员不变）。同进程 idle 的大跨度按在线补齐（「在线挂机照打」的字面；心跳只是让玩家实时看到，不是结算的前提）。
5. **宿主心跳接线（C2-T7）**：**周期定时器＋带 actor 推进**（非心跳通道扩实体层——无 actor 是 ADR-0034 §5 的设计而非缺陷）：harness 加 `beat`（共用命令 seq 单调空间）＋gameSession `heartbeat()`/自动 `setInterval`/`dispose()`；墙不动时 beat 幂等零事件。
6. **NPC 出手公式化（D4/D5）**：`max(1, round(attack × (1 − 玩家防御/(玩家防御+K))))`——monster `stats.attack` × 玩家 `defenseAttr` 键值（C1 声明占位兑现）；**玩家闪避不掷**（无数值来源，C3 资源体系来）；**NPC 出手＝纯公式无效果**（monster effects 消费收窄改挂效果票/C3——C1-D12 被 D5 收窄）。
7. **闪避上提编排层（F2/AC5）**：dodge 判定从 instant-damage primitive 上提为**一击整体的编排层属性**（`combat/blow.ts` 共享函数：编排掷、闪避即短路整条效果链）——对双方统一：玩家打 NPC 掷 NPC dodge（不变）、NPC 打玩家不掷；C1 已知债（闪避拳仍可挂毒、每拳约 1.75% 边角）随批消除。
8. **死会话（D6/F4）**：NPC 死即清**整场会话**（毒记账随清——C1-T6 玩家死清会话的 NPC 侧对称）；换目标自然消解；再打同名＝开新战满血（开战路径复用、零新增状态位）；**「无尸体」成正式语义**（尸体/掉落 C4+ 再引入）；C1 旧档的 `targetDead:true` 由读档/首观察/strike 三处迟到清理（validator 保留字段——旧档照读是回归红线）。
9. **逃逸三件（D11/AC7）**：战斗中移动＝掷 `settings.combat.escapeChance`（全局常数，defenseK 同族概率调参）；失败＝留战斗＋玩家 `nextStrikeTick` 推一间隔（花一手时间）＋扩展臂事件 `combatEscape(pinned)`（宿主词面，flagGranted 先例）；成功＝**即清会话**（掷成功＝脱战，其后移动被 enter gate 拒＝已脱战但未挪窝，两个事实各自成立）＋照常移动；无战斗移动零变化（不读逃逸键）。落点 `combatTraversalSpec`（逃逸掷→内层 traversal→进房 proactive 边沿），宿主绑定表换绑，纯 `traversalSpec` 保留。
10. **命令门禁（D7/AC8）**：commands schema 可选字段 **`notInCombat: true`**（缺省允许）；引擎执行段查 combat 槽拒绝（`guardNotInCombat` 包装器＋`CommandRejection`＋`err_inCombat` 文案先例）；**门禁表随内容包走**（引擎不硬编码命令清单——硬编码表被否）。范围：rest/lodge 禁（内容声明）、say/examine/look 允许、移动＝逃逸通道（非禁）、strike 重复＝拒绝（D2）。
11. **主动攻击（D14/AC9）**：monster 条目顶层可选布尔 `proactive`（缺省 false 零行为变化；C2-T1：顶层〔行为声明，source 同族〕＋定名 proactive）；玩家**移动进房**边沿检查房内静态在场清单**首个** proactive 怪自动开战（复用开战路径）；**开战者第一手立即**（NPC 手即开战宣告，零新事件型；玩家手自间隔起算——玩家开战手 D2 的对称）；会话占用不触发；逃逸入主动房再开战（连环房）；**三种非移动落房路径不触发**（C2-T3 裁移动命令执行段尾挂点：死亡传送／读档落房／startNewGame 新档——复活不被袭、读档不袭〔与 D3 相容〕、新档不被袭）；「巡逻/追击/呼救」其余自主行为＝非目标。
12. **F6 clamp（D8/AC11）**：结算路径单点 `clampedHp(hp, maxHp)`——NPC `targetHp` 写点（primitive/毒跳）与玩家 hp 写点（NPC 手）各调；内容改数值后旧档续战不溢出、每次结算自愈（不迁移、不记档）。
13. **「回合」措辞收口（D17）**：「回合」词族技术措辞**禁用**（指称失真两读皆立：指心跳则与出手不对应、指出手则双方间隔无共同边界）；CONTEXT 心跳/闪避/Avoid 三处随批改写；`check-docs.mjs` SUPERSEDED 加「战斗回合」「每回合」两词（门禁防未来新写，现存 :117/:236 人工钉——owner 裁 B）。**覆盖记录**：ADR-0016×4／ADR-0020×3／ADR-0024×1 的「回合」措辞随本 ADR 退休（日志不追改）；ADR-0020「合」×4＋HANDBOOK:63 计数示例换口径归 **C4+ 战报票**（D1 分工，两分工不混）。

## Considered Options

（被否路线全文见 `.scratch/combat/C2-DECISIONS-WIP.md` §3）

- **「合」概念**（机制单位/叙事计数两读皆弃，owner 原话「本来就不在，以后也不用考虑」）。
- **「打」保持手动一击／新命令 fight 开战**：终态＝自动战斗＋手动释放；手动插队是 C3 的位。
- **到期桶做出手调度**：世界层离线照爆违 ADR-0016；O8 通道＝命令布雷；桶＝一次性效果形状、持续会话非其形。
- **新原语 tick 循环**：spec/04 砍 per-object timer 既定方针。
- **NPC 出手裸伤延续／掷玩家闪避**：defenseAttr 占位本意即本票兑现；玩家闪避无数值来源。
- **monster effects 对称最小面进 C2**：改挂效果票/C3（D5 收窄 C1-D12）。
- **死会话保留至显式收手／可换目标替换**：前者新命令＋新状态位；后者是死即清的复杂化。
- **门禁引擎硬编码表／preconditions 谓词扩**：门禁表随内容包走才合引擎与内容分离；扩谓词与「白名单零扩展」收敛方向相反。
- **节奏数值进全局 settings**：实体差异面≠全局常数。
- **CombatSession 节奏字段必填**：C1 旧档 present 而无节奏→同版本旧档拒读，太粗暴。
- **同 tick NPC 先手／并行双死**：玩家先手＝开战手自然延伸；双死与死即清原子性相抵。
- **逃逸无代价／保留会话挂脱战位**：无限连试、会话状态机多一个暂停位。
- **proactive 预埋 schema 位不消费**：spec/04 §4.3 不预承诺方针——与 C1-D12「位已在、消费后置」不同形。
- **心跳通道扩实体层**：无 actor 是 ADR-0034 §5 的设计（非伪造系统命令），扩它＝语义回潮；择周期定时器＋带 actor 推进（C2-T7）。

## Consequences

- C1 产物改写四项随批落地（票面破坏性清单①–④）：尸体拒绝路径不可达（再打＝新战）、NPC 反击裸伤→公式（15→12 级断言）、反击立即→按节奏（e2e 三例时序断言改写——第二例整例专钉「第一手不再立即反击」）、闪避拳挂毒边角消除；**C1 存档继续可读（回归红线，零迁移）**——节奏对缺席走种子路径、targetDead 迟到清理。
- 内容面：cmd-strike 文案（err_inCombat 新增＋err_targetLocked 去「另一人」）、cmd-rest/cmd-lodge 声明 `notInCombat`、character.json 加必填 `strikeIntervalTicks`、settings 加 `escapeChance`＋formula 串收口（「对头反击＝裸伤」旧口径随双向公式改写）、mon-lq-001 加间隔、**新怪 mon-lq-002（proactive 泼皮）＋新 npc-lq-004＋新房 room-lq-005 镇北破庙**（街市北面可达、无 flag 门——AC9 内容义务；孙彪不加 proactive 以免动 C1 e2e 断言）。
- spec 升级随批：spec/02（notInCombat＋combatTraversalSpec）、spec/04（§1.4 节奏对＋§4.2 战斗变体与驱动模型句＋:421/:423 收口＋第十五类扩面）、spec/06（escapeChance＋间隔归属＋内容计数）、CONTEXT（一击/心跳/闪避改写＋战斗会话/开战/逃逸/主动攻击新词条＋Avoid 收词）、HANDBOOK/spec/00 计数；check-docs 加「战斗回合」「每回合」（本 ADR 为退休依据）。
- 已知债务：围攻多目标（多只主动怪取首个——多目标票）；HP 归属挂玩家侧（C1-D2 债维持）；monster effects 消费（效果票/C3）；手动插队（C3 perform）；战报计数口径（C4+，含 ADR-0020「合」示例与 HANDBOOK:63 的换词义务——D1 分工）。
