# 招式系统与手动释放（C3）：轮盘择式＋perform 插队＋装配槽＋内力/气血恢复＋玩家闪避＋防御分路＋冷却首消费者

战斗/机制第三票（#58）按 2026-11-03～04 三轮访谈定案 D1–D20（owner 三句「同意」整体照准＋四轮对抗审核全闭环，候选 22→18→10→9 收敛）与实现批裁定（C3-T1–T8，`.scratch/combat/C3-IMPL-DECISIONS.md`）落地：**节奏手按装配序轮盘择式**（冷却好＋内力足取第一个；两态回退——冷却所致＝全额基础、内力耗尽态＝attack×zeroCostAttackRatio 打折）、「施展 X」＝**插队手**（立即出手＋单调推进 playerNextStrikeTick——替代节奏里的下一手，临近则小幅推后＝插队代价）、激发/收招两条管理命令（notInCombat、上限 4、序即优先级）、**内力＋气血同一观察时补偿结算**（战斗内外无差别、离线照补——ADR-0016 白名单**字面成员**首次兑现）、玩家闪避掷（min(cap, base+dodge/(dodge+k))，掷中整击落空）、攻击按 source 分路吃双防御键（CONTEXT「内功伤害走内功防御，外功伤害走外功防御」兑现）、招式冷却＝**cooldowns 槽首个真消费者**。立否三条件自评：**难逆**（存档新槽＋CharacterTable 改形＋事件后补字段＋schema 三处同步——撤回波及存档/事件流/全部战斗面）／**会困惑**（「轮盘两态为何不同惩罚」「perform 为何推后下一手」「资源恢复为何盖跨度末 tick」无记录必读不懂）／**真权衡**（心法/等级系统/加权轮盘/UI 状态栏等被否路线见 §Considered）——三条齐，立。

## Context

- **设计输入**：`.scratch/combat/C3-DECISIONS-WIP.md`（D1–D20＋四轮审核台账）、`C3-AC-AND-PINS.md`（票面底稿＝issue #58 body 逐字）、`C3-IMPL-DECISIONS.md`（C3-T1–T8 实现批裁定）；ADR-0041（C1 内核）、ADR-0042（C2 会话与自动互打）；ADR-0016 §1（离线白名单字面含气血/内力恢复）；ADR-0009 §10（引擎零认识 attr 键）；ADR-0029 §5（维度闭合）。
- **票前承接钩子**：C1-T2/C2-D4「玩家闪避随 C3 资源体系来」；C1-D6 rank 占位「C3 武功票带值」与备选路径「C3 加字段时记兼容义务」；C2-D17③ spec/04 §4.2 手动释放半句留本票补；C2-D5 monster effects 收窄「改挂效果票/C3」——本访谈再推 C4 效果扩面票。
- **票前事实**：cooldowns 槽形状已钉但零真消费者（种子空表非条目写入）；`schemas/martial.schema.json` 放置期 draft（cooldownMs 毫秒病、prerequisites/sectId/textVariants 悬空引用）；`has_martial` 谓词已实装但 hasSkill facet 恒 false（无数据源）；cmd-rest 纯文案 hp 不回；monster schema `stats.internalDefense` 键在零消费。

## Decision

（D1–D20 全文见 `.scratch/combat/C3-DECISIONS-WIP.md` §2；此处机制面与承接记录）

1. **轮盘＝装配序优先级（D6/D15）**：节奏手到点＝`selectStrikePlan`（`combat/martial.ts`——引擎机制，宿主只供基础链内容通道）取装配序第一个「冷却好＋内力足」的已装招式；**不掷 rng**（确定性好测）；intent 三层＝指令（perform）＞装配序（策略配置最小化身——调序＝收招再激发，不开新配置存档面）＞条目自带（暂无权重字段）。**两态区分**（一轮审核 #3 定案）：冷却所致的全不可用＝**全额**基础攻击（现状链，不是惩罚态）；**内力耗尽态**（实现批 C3-T1 细则：装配清单非空且无任何已装招式 cost ≤ 当前内力）＝基础攻击 **×zeroCostAttackRatio**；空装配清单＝恒全额（无招式者非耗尽）。
2. **招式手＝StrikePlan 进共享 blow（D15）**：`combat/blow.ts` 的 `playerBlow` 收**招式描述**（effects/source/element/martialId?/rank?/attackMultiplier/cost/cooldownTicks?）——开战手（基础面，C1 手感逐字保留）、轮盘手、perform 手共用同一条编排；cost 扣减与 cooldown 挂载在掷闪避**之前**（手已花出去——毒概率同律）；`EffectExecutionContext` 加可选 `strike` 面（缺省＝基础攻击自身：乘数 1、表内 source/element——C1/C2 算术逐位不变）。
3. **perform＝插队式（D5/D14）**：「施展 X」（`combat/performSpec`，argForm＝**text 复用**——招式名匹配是战斗域逻辑、不扩 ArgForm 枚举）＝立即出手一手＝**替代**节奏里的下一手：`playerNextStrikeTick = max(现值, now＋间隔)`（实现批 C3-T1 裁「推进」单调读——原下一手很远时不提前、很近时小幅推后，防乱拳连点代价即此）；设主招式式不做（状态位免进存档）。四拒绝面全 err_*：非战斗（err_notInCombat）/未装配/冷却未好/内力不足。
4. **martial 条目字段面（D10/D11/D12）**：schema 放置期 draft 重设计——`cooldownMs→cooldownTicks`（删「冷却中出招权重归零」加权轮盘旧句）；删 `prerequisites`（等级票回来再回）、`sectId/lineageId`（门派无票不预承诺）、`textVariants`（引 C4 才有的 combat-text 悬空引用）；留 kind（心法挂修饰符票、字段位可扩）；`costs.internalForce` 改纯数值 `cost`（缺省 0——扣哪键由玩家声明表定，条目不写死资源键名）；威力＝**attackMultiplier**（缺省 1，`baseAttack = attack × multiplier` 进公式；效果条目 amount 继续闲置——C1-T11 缝合先例）；**冷却两级设计位**：条目 `cooldownTicks`（出手挂 `cooldowns[mrt-id] = now + cooldownTicks`，手动/自动同律、未声明＝无冷却、基础攻击不挂——**cooldowns 槽首个真消费者**）与 effects primitive 的 `cooldownTicks`（留而不动，持续效果族将来设计位）；cooldowns 键＝martial id 裸键（`mrt-` 前缀天然防撞）。
5. **内力模型＋耗尽（D7/D18）**：内力键对声明位＝character 表 `secondaryResource: {current, max}` 照 primaryResource 先例（引擎零认识具体键、cost 扣键与回复上限键从声明读）；回复＝`settings.combat.internalForce.regenPerTick`（封闭组既有键零 schema 改动）；`zeroCostAttackRatio` 消费（「输出下降但不归零」义务兑现）。
6. **资源恢复＝同一补偿结算（D4/D7/C3-T8）**：内力＋气血（`regenResources`，并入 `createCombatSettleHandler` 排战斗段后——C2-T4「同一 handler 内统一调度」同款裁定，SettlerOptions.entity 单注册槽不加并列槽）；战斗内外无差别、**离线照补带上限**（ADR-0016 白名单**字面成员**首次兑现——与 #56 毒跳的「白名单第一次扩充」不同类，见 ADR-0041）；主资源速率＝`settings.time.primaryRegenPerTick`（time 开放组新键、**角色名键**非 attr 名键——引擎不知「hp」，readDefenseK 先例）；事件＝扩展臂 `resourceRegen`（每键每观察跨度至多一条、带 amount、**tick 盖跨度末 toTick**——连续回复无离散 dueTick 锚，C3-T8 裁）、delta=0 不发；attrs 写精确浮点。
7. **玩家闪避（D8）**：attrs 加 dodge 键＋`character.strike.defenseAttrs` 同族声明通道 **`strike.dodgeAttr`**（实现批补裁——引擎零认识 attr 键〔ADR-0009 §10〕，票面 AC11 清单未列系疏漏）；概率 `min(cap, base + dodge/(dodge+k))`（settings `dodge{base,cap,k}` 组消费）；P>0 才掷（零概率不消费骰流——monster dodge 先例的零面宽限）；掷中＝**整击落空**（F2 编排层对称——npcStrike 编排内掷、命中才扣血）；玩家打 NPC 掷 NPC dodge 不变。
8. **防御双键＋NPC 手分路（D17——D9 承载）**：character 表 strike 组 `defenseAttr`（单键）改 **`defenseAttrs: {external, internal}`**（source 值做键、与 dimensions source 维度对齐；attrs 种子补 internalDefense）；NPC 手＝monster 条目**顶层** source（缺省 external 先例）选玩家对应防御键进公式＋掷玩家闪避；招式手＝martial 条目 source 选 monster `stats.externalDefense/internalDefense`（`faceDefenseOf`——两字段查表、未知词大声；`MonsterCombatFace` 补 internalDefense 读数；mon-lq-001 补声明〔值 0〕）。character.json 是内容非存档——改形零兼容动作。
9. **装配与已学（D13）**：「已学」＝内容声明（character 表 `martial: {known, initialEquipped}`——无运行时学习途径；`initialEquipped ⊆ known` 由 check-content.mjs 跨字段规则校验〔draft-07 表达不了包含关系〕；两清单 id 可解性＝注册表构建期校验〔npc→monsterId 先例的内容侧半边〕）；存档**新槽 `martial?: string[]`**（已装 id、**上限 4 是装配命令的法非存档形状法**、序即优先级）；SLOT_RULES unfilled 第三行（缺＝无已装、每手基础攻击）、畸形拒（第十六类：数组＋每项非空字符串）；**卸下至空＝删槽**（字节同形先 #58 记录）；引用完整性＝读档点 `validateEquippedMartials` 大声解析＋选招/装配点迟到断言（resumeCombatSession 对 targetNpcId 先例）；新档种子写 initialEquipped（continueGame 空 attrs 重播种路径同益）；**激发/收招拆两条命令**（反义动词方向无从辨）、均 notInCombat、匹配＝精确名（C3-T5）、重复装＝err_alreadyEquipped（调序＝收招再激发）。
10. **呈现面（D16/C3-T3/C3-T4）**：strike 事件补 **`martialId?: string`**（招式手带值、基础攻击恒缺省——**后补字段记兼容义务**：旧事件流重放不携它、新流仅招式手携它，对旧回放零破坏；spec/01 §5.2 红线「后补会伤及存档与模拟器兼容性」的兑现记录即本 ADR）；**rank 占位兑现**＝本票带值（品阶维度 quality 的英文键——tier 经 combat-tiers `quality` 带读出，damageBand 键先例；两事分记：rank 补位与 martialId 后补不混）；hostCopy **双模板键** `strikeHitMartial`（单模板可选槽被否——两种行读法不同、空槽模板两头凑不成词）；招式名经宿主建 martialId→name 表随 render 注入（#50 Q6 渲染器零注册表读不变）；资源回复可见性＝`resourceRegen` 扩展臂＋宿主词面；**UI 状态栏（hp/内力常驻显示）非目标**（宿主 UI 票，系本票命名、路线图现无此名目——与 D2 进度票、D3 效果扩面票同记**届时补路线图**义务）。
11. **不进本票（§3 被否精简）**：心法（被动修饰符——C4 修饰符票，装配槽可扩）；武功等级/熟练度/学习/解锁（进度系统另立票，prerequisites 随之回来）；monster effects（挂 **C4 效果扩面票**——C2-D5「效果票/C3 承接」就此再推并定名；death cause 已含 dot、玩家毒杀路径不遗失）；auto 轮盘加权随机（掷 rng 破坏确定性好测性）；玩家显式策略配置面（装配序即优先级）；效果条目 amount 激活（数值面归招式层）；ArgForm 扩招式名形态（text 复用）；cooldowns 键带前缀（mrt- 自带）。

## Considered Options

（被否路线全文见 `.scratch/combat/C3-DECISIONS-WIP.md` §3）

- **perform 设主招式式**（设完还得等＋「主招式」状态位进存档）vs 插队式（一手就是一手、重排单调推进）。
- **轮盘加权随机/权重配置**（丰富度归 C4 战斗文本票；掷 rng 破坏确定性）vs 装配序优先级（最小化身、零新存档面）。
- **资源恢复只做内力**（「打完永远残血」体验缺口留下票）vs 内力＋气血一起（同一 handler 边际成本低——取后者）。
- **内力仅战斗内回复**（违 ADR-0016 白名单字面——离线照补本就允许）。
- **回复 handler 并列新注册槽**（SettlerOptions 加第二 entity 槽＝改引擎形状）vs 并入 createCombatSettleHandler（C2-T4「同一 handler 内统一调度」同款裁定——取并入）。
- **hostCopy 单模板可选槽**（空槽模板两头凑不成词）vs 双模板键（strikeHitMartial 新键——取双键，spec/05 计数六→七随批改）。
- **冷却上轮盘惩罚态**（「全不可用→打折」混冷却与耗尽两种成因——一轮审核 #3 拆两态：冷却所致＝全额）。
- **D13 加载期校验引 npc→monsterId 先例**（该先例是内容→内容；存档→内容的既有先例实为 resumeCombatSession 读档点——二轮审核 #3 改引）。

## Consequences

- **C1/C2 承接记录**：C1-D6 rank 占位兑现（本票带值）；C1-D6 备选路径「C3 加字段时记兼容义务」兑现（martialId? 后补可选位、基础攻击恒缺省——spec/01 §5.2 红线的执行范式）；C1-T2/C2-D4 玩家闪避兑现（D8）；C2-D17③ spec/04 §4.2 手动释放半句随批补；C2-D5 monster effects **再推** C4 效果扩面票（定名，届时补路线图）。
- **C1/C2 破坏性六项随批落地**（票面清单）：测试改写面三处（宿主接线 effects→baseEffects 改名＋core 夹具 defenseAttrs 改形＋core 断言）、character.json `defenseAttr→defenseAttrs`、strike 事件 martialId?、hostCopy strikeHitMartial（C2 e2e 断言面重钉——C1 续战例按 D20④ 择「重钉断言面」：轮盘手 45〔D9 分路数〕＋玩家闪避掷中＋回复 15 行）、settings formula 串随公式面改写；**C1/C2 存档继续可读（回归红线）**——martial 槽缺席＝空轮盘照读零迁移、cooldowns 既有槽首消费者零迁移。
- **存档面**：新槽 `martial?: string[]`（SLOT_RULES unfilled 第三行＋第十六类畸形＋EntityRecord Omit 例外＋serialize 序原样保留〔唯一不排的槽——序即优先级〕）；C2 旧档（有 attrs 无 martial）零迁移照读。
- **内容面**：4 招式条目（外功直伤〔无冷却/低耗/×1.2/tier1〕、内功直伤〔D9 分路验收〕、带毒〔eff-poison-fist 复用〕、大招〔高耗/长冷却/×2.0〕）＋三条命令（cmd-perform「施展」＋cmd-equip「激发/jifa」＋cmd-unequip「收招」）＋character（secondaryResource/martial/defenseAttrs/dodgeAttr/attrs 新键）＋settings（dodge 组/internalForce 组/time.primaryRegenPerTick＋formula 串）＋combat-tiers（quality 品阶带维度）＋mon-lq-001（stats.internalDefense: 0）。
- **schema 三处同步**：martial.schema 重设计激活（NOTE→正向映射）、config.character（defenseAttrs/secondaryResource/martial 位/dodgeAttr）、commands 零枚举扩（text 复用）＋content.md；check-content.mjs 扩 `initialEquipped ⊆ known` 跨字段规则（第六道检查——门禁头注释计数随批升）。
- **引擎面**：COLLECTIONS 第七行 MARTIALS（effect 与 exit 之间）＋`martial(id)` getter＋类型导出；`has_martial` facet 数据源接通（known 清单读注册表）；`MonsterCombatFace` 补 internalDefense；npcStrike ports 补 rng（玩家闪避掷）。
- **spec 升级随批**：spec/04（§1.4 新槽四处＋§4.2 手动释放半句与资源恢复句＋§4.6 cooldowns 首消费者改写＋§5 自检 :421/:423）、spec/01（strike 面 martialId?＋rank 兑现两记＋combat/ 目录树三文件）、spec/02（perform/装配适配器＋has_martial 数据源）、spec/05（RenderCopy 第七键 strikeHitMartial）、spec/06（martial 集合激活＋新落 4→5/放置期 10→9/待重估 15→14——总数 23 不变，schema 文件本就存在）、spec/00（:150 计数＋:112 ADR 行）、CONTEXT（招式/内力/出招来源/闪避四词条）、HANDBOOK/AGENTS 计数（ADR 43→44 四处）。
- **已知债务**：心法格与修饰符（C4）；武功等级/学习（另立票）；monster effects（C4 效果扩面票）；战斗文本变体与丰富度（C4 战斗文本票）；UI 状态栏（宿主 UI 票）；D2/D3/D16③ 三笔「届时补路线图」义务挂本 ADR。
