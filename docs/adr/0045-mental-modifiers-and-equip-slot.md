# 心法修饰符与装配槽（C4）：ADR-0005 最小核两层填层＋消费点五点＋mental 槽＋jifa 分流

战斗/机制第四票（#59）按 2026-11-04～05 三轮访谈定案 D1–D15（owner 三句「同意」整体照准＋五轮全面审核批闭环〔12→9→4→4→5〕＋owner 消费点裁定「都按你说的来」——defense 入列/perTick 明示排除）与五轮落稿审核批、实现批裁定（C4-T1–T6，`.scratch/combat/C4-IMPL-DECISIONS.md`）落地：**心法装配＋ADR-0005 最小核两层首个真成员**——修饰符管线 `(base+Σflats)×(1+Σpercents)`（下限 0）自 C1 空退化形状态首次传真值、FlatModifier/PercentModifier 生产面首次真构造；**消费点五点**（attack/defense/dodge/maxHp/maxInternalForce——玩家属性读取进公式处全数过管线，perTick 冻结点明示排除）；**存档新槽 `mental?: string[]`**（照 martial 先例 SLOT_RULES 全套、上限 3、槽序无语义可排——与 martial「序即轮盘优先级、唯一不排的槽」相区分）；**复用激发/收招按 kind 分流双槽**（招式 4／心法 3 各自计数、错误面全复用——xkx 语料 jifa 本就同时激发招式与被动内功，零新造词）。立否三条件自评：**难逆**（存档新槽＋MartialEntry 改形＋character 表 mental 块＋schema if/then＋消费点五处接线——撤回波及存档/伤害公式/全部战斗面）／**会困惑**（「flat 为何加在乘数后基数上」「defense 为何入列而 perTick 排除」「心法槽为何可排而招式槽不排」无记录必读不懂）／**真权衡**（条件修饰符/乘法区/12 阶段/暴击/统一通道化等被否路线见 §Considered）——三条齐，立。

## Context

- **设计输入**：`.scratch/combat/C4-DECISIONS-WIP.md`（D1–D15＋五轮审核台账）、`C4-AC-AND-PINS.md`（票面底稿＝issue #59 body 逐字）、`C4-IMPL-DECISIONS.md`（C4-T1–T6 实现批裁定）；ADR-0041（C1 内核——T9 空退化形裁定）、ADR-0042（C2 会话）、ADR-0044（C3 招式——D1 kind 字段留位、装配槽可扩设计）；ADR-0005:14-15（最小核两层与判定标准）、ADR-0009 §10（引擎零认识 attr 键）、§21（玩家抗性＝条件修饰符——C5）。
- **票前承接钩子**：C1-T9「最小核两层空退化形……C4 修饰符票填层」（`combat-strike.test.ts` 两层算术钉子早钉、生产面恒空）；C3-D1「心法格随 C4 修饰符票」（装配槽模型设计成可扩）；C1-T11②「挂载时算定」（perTick 冻结的既有裁定——D11 排除论据）。
- **票前事实**：`aggregateModifiers` 零真成员调用（attack 落 damage.ts:280 既有调用点、恒传空）；defense/dodge/maxHp/maxInternalForce 四读取点无管线接入；martial 集合 kind 字段值中文「招式」（schema description 已写「招式｜心法」）；`config.character.schema.json` 顶层 `additionalProperties: false`（mental 块不开即 content:check 红）；check-content 第六道现规则只读 martial 块。

## Decision

（D1–D15 全文见 `.scratch/combat/C4-DECISIONS-WIP.md` §2；此处机制面与承接记录）

1. **修饰符来源面（D2/D10）**：**纯心法常驻**（无条件修饰符——心法条目 `modifiers: [{ stat: <声明表键名>, flat?: number, percent?: number }, ...]` 产出 flat/percent 两层成员）；两层算术 `(base+Σflats)×(1+Σpercents)` 下限 0（`modifiers.ts` 现状零改动——成员是新的、管线不是）；percent 小数（0.1＝+10%）；**flat 加在乘数后基数上**（`(attack × multiplier + Σflats) × (1+Σpercents)`——attackMultiplier 先乘属 C3 既有语义「baseAttack＝attack×multiplier」，修饰符作用于「这一手的基数」）；条件修饰符全归 C5。
2. **消费点五点（D11 终稿，owner 裁定）**：原则＝**进战斗计算与上限判定的玩家属性，读取进公式处过管线**——①attack（玩家手 strikeDamage 操作数——primitives.ts 既有调用点传第四参）／②defense（npc 手防御操作数——npcStrike 调用点包 aggregate）／③dodge（playerDodgeChance 输入同接）／④maxHp（primaryResourceOf 的 max 读取＋regen applyRegen 主资源臂——bands 分母/战斗写点 clamp/死亡回满/regen 封顶全覆盖）／⑤maxInternalForce（applyRegen 副资源臂——secondaryResourceOf 的 max 不接：其消费方只用 current，接了给 affordable 判定喂修饰值＝越权）。**defense 入列论据**：stat 键域＝声明表键名、防御双键与 attack 同域（禁声明反须新造键域白名单机制）；attack/defense 同一公式两操作数；C5 stat-modifier 作用于防御的消费点即此处——现在开通道 C5 直接复用。**perTick 冻结点明示排除**：primitives.ts 挂载 `aggregateModifiers(amount)` 冻结 perTick 不计入清单——操作对象是效果条目 amount（content 数值）非玩家属性读取，系 C1-T11② 既有裁定的落点实现；计入破坏清单同质性与闭集性。**空成员恒等保证（值域非负限定）**：五点输入恒非负（声明表种子无负值路径；monster 侧不经五点），空成员 `max(0,x)≡x`——未装心法路径 C1–C3 既有断言零扰动。**ADR-0005:15 判定标准「战斗中不存在绕过修饰符直改属性的路径」按五点清单丈量**（C1-T9 兑现记录即本条）。
3. **mental 槽（D8＋C4-T2/T5）**：新存档槽 `mental?: string[]`（SLOT_RULES unfilled 行、畸形拒〔第十七类：数组＋每项非空字符串〕、v2 中途落地不开 v3、读档点 validateEquippedMentals 引用校验〔validateEquippedMartials 先例：条目可解析＋心法面＋∈ mental.known〕）；上限 3（CONTEXT:143——装配命令的法非存档形状法）；**槽序无语义、serializeWorld 键序升序可排**（attrs 升序先例——与 martial「序＝轮盘优先级、唯一不排的槽」相对）；卸下至空删槽（字节同形）；**上限夹逼沿用 F6 自愈律**（C4-T2：读取点用管线修饰后 max 做 ceiling、卸下不主动写低 current——高出上限的存量在下次写点自愈，「a save above a revised ceiling heals itself」同一语义事件）；死亡回满读修饰后 max（装着心法死→回满到当前生效上限）。
4. **条目归属与 schema 三处改形（D9＋C4-T1）**：**同集合 content/martial/、kind 区分**（C3-D1 设计意图兑现——另立新集合＝宣布心法不是武功、与 CONTEXT 词条群相悖，被否）；①id pattern 扩第二前缀 **`mnt-`**（心法条目不复用 mrt-——名不副实；与存档槽名 mental／TS 字段／character 表 mental 块全链同根，mrt-/martial 同根先例；cooldowns 裸键防撞论证同益）；②**if/then 按 kind 分 required**（kind＝「招式」→effects 必填＋禁 modifiers；kind＝「心法」→modifiers 必填＋禁 effects；顶层 required 去 effects 留 id/kind/name/tier——公共保留法下 tier 零动作）；③tier 1-4 心法同必填（纯内容品阶叙事、无事件消费——心法不产手、无 rank）；kind 写死 enum 两词（引擎按**形状**分流：entry.effects 存在＝招式、entry.modifiers 存在＝心法、both/neither 大声失败——与 schema if/then 判据同构、引擎零词汇〔faceDefenseOf 写死 external/internal 的教训倒转：形状而非拼写〕；enum 让未知 kind 在 content:check 即红，三层同步）；COLLECTIONS 不加行、`martialIdByName` 同名空间共享（匹配面＝两 known 清单并集、先招式后心法序——同名条目内容责任）。
5. **命令面（D12＋C4-T3）**：**复用激发/收招（jifa）、按 kind 分流**到心法槽（各自计数上限：招式 4／心法 3）；错误面全复用（err_alreadyEquipped/err_notEquipped/err_martialSlotFull 同码——词面随批中性化「这门功夫」系，errKey 码面不动）；**notInCombat 心法面同律继承**（复用同条目即继承同门禁——战斗中翻转常驻修饰符属战斗中改数值面，拒绝是默认安全侧）；unequip 搜两槽并集、删对应槽。
6. **呈现面（D12）**：hostCopy 装配确认行加**心法孪生键** `mentalEquippedLine/mentalUnequippedLine`（「你运起「××心法」，内息暗自流转。」／「你收了「××心法」，内息归于丹田。」——语料动词「运起」〔xkx/fengyun/xyj450 三系「$N运起××心法」〕）；**独立事件类型** mentalEquipped/mentalUnequipped（孪生键「独立键非可选槽」原则——非 martialEquipped 事件的可选槽）；payload 字段名 `martialId`（条目 id 的集合名）；**非 RenderCopy 第八键**（hostCopy 会话层措辞——spec/05 RenderCopy 键清单句不扩）。
7. **内容义务（D13＋C4-T4）**：3 条心法（`mnt-lq-001`「伏波心法」attack flat 5／`mnt-lq-002`「长风心法」attack percent 0.1／`mnt-lq-003`「吐纳心法」maxInternalForce flat 20——两层各有真成员＋上限半边；命名五系「××心法」四字格语料通例、三候选跨系零撞词、码头镇意象）＋character 表 **mental 块**（known/initialEquipped——与存档槽对称；**config.character schema 同步开**〔顶层 additionalProperties:false，不开即红——照 martial 块形、items pattern ^mnt-、maxItems 3〕）＋**registry 构建期引用校验第四面**（mental.known/initialEquipped 逐 id 对同一 martialsById——同集合防悬空）＋`assertCharacterTable` mental 块 shape 校验同款扩；新档预置 **1 条**（伏波心法 attack flat——AC「装心法→伤害行可见变化」由预置直接承载：基础拳 19→22）；check-content 第六道扩 `mental.initialEquipped ⊆ mental.known`（脚本门禁两块并检）。
8. **npc 侧边界（D5，校准口径）**：C4 对 npc 侧零改动＝**monster 侧无数值来源与公式形状不动**（npc 手 baseAttack 无修饰）；玩家防御操作数过管线是玩家侧成员、不违 D5；affinities 消费归 C7。
9. **不进本票（§3 被否精简）**：条件修饰符/抗性/效果抵抗（C5——condition 求值与 stat-modifier primitive 同生同灭）；乘法区（装备票——ADR-0005:15 字面）与 12 阶段（ADR-0009:26——多源修饰符时代再立）；暴击（C7 雷系签名——掷骰面不走两层聚合；C4 期间 isCrit 恒 false）；全 attrs 读取统一通道化（无消费者的提前设计，词缀/装备多源时代再收拢）；战斗文本先行（owner 已裁「文字问题先不管」）。

## Considered Options

（被否路线全文见 `.scratch/combat/C4-DECISIONS-WIP.md` §3）

- **一张大票五束全收**（票面爆掉——C3 后 core 923 例，单票 +37 已重票）vs 定序 C4 修饰符→C5 效果扩面→C6 战斗文本→C7 七系→C8 战报（文本票在七系前——验收判据依赖词库）。
- **条件修饰符进 C4**（需要 condition 求值＝半个 C5 提前进）vs 纯常驻（管线的第一个成员从最简来源起）。
- **另立心法集合**（＝宣布心法不是武功）vs 同集合 kind 区分（C3-D1 字段位兑现）。
- **xsf- 拼音前缀**（与引擎词汇 mental 不同根）vs mnt-（存档槽/TS 字段/character 表全链一个词根——mrt-/martial 同根先例）。
- **引擎写死中文 kind 词分流**（违 CJK 红线——engine-purity 扫描即红）vs 形状分流（effects/modifiers 存在性——与 schema if/then 同构、零词汇）。
- **卸下心法立即夹逼 current**（新机制）vs F6 自愈（读取点 ceiling、存量下次写点自愈——「内容改上限」与「卸心法」同一语义事件同一律）。
- **perTick 计入消费点清单**（破坏同质性〔属性读取 vs 效果数值算定〕与闭集性〔算定点随 primitive 增长〕）vs 明示排除（C1-T11② 既有裁定）。
- **mental 事件挂 martialEquipped 可选槽**（两种行读法凑一槽）vs 独立孪生事件（「独立键非可选槽」——strikeHitMartial 第七键原则）。

## Consequences

- **C1/C3 承接记录**：C1-T9「C4 修饰符票填层」兑现（生产面首传真值、FlatModifier/PercentModifier 首次真构造——`combat-strike.test.ts` 两层算术钉子早钉、本票接上生产链）；C3-D1「心法格随 C4（装配槽可扩）」兑现；**ADR-0005:15 判定标准按五点清单丈量**的兑现记录即本 ADR Decision 2。
- **C1/C2/C3 破坏性三项随批落地**（票面清单）：①既有 e2e 伤害断言面重钉（预置 attack flat 心法——C3-D20④「重钉断言面」先例：透骨指 45→50〔(30×1.5+5)〕、开碑劲 38→41、耗尽态 9→13、开拳 19→22；AC12 全路例 escape 步长 3→1 tick——新伤害下孙彪活不过 3-tick 逃逸跨度）；②存档回归红线保持（旧档无 mental 槽照读、零迁移——SLOT_RULES unfilled）；③martial schema 三处改形存量零迁移（4 招式仍合法：effects 本必填、id 仍 mrt-、tier 已填）。
- **存档面**：新槽 `mental?: string[]`（SLOT_RULES unfilled＋第十七类畸形＋EntityRecord Omit 例外＋serializeWorld 升序排键〔与 martial 不排相对〕）；C3 旧档零迁移照读；e2e 全链（预置→开战 22→收招卸下→19 回归→删槽字节稳定→旧档照读续战）。
- **引擎面**：`combat/mental.ts` 新文件（slotKindOf 形状分流/equippedMentalModifiers 按 stat 分组〔每调用现算——装卸即时生效即 D11「strike attack 即时生效」的机制保证〕/validateEquippedMentals）；MartialEntry.effects 变可选＋`modifiers?: ModifierDecl[]` 新类型（registry 引用校验 `effects ?? []`）；npcStrike 三键接线＋primaryResourceOf 可选第三参（mental map）＋applyRegen max 接线；equip/unequip 分流改形＋MENTAL_* 事件与常量；slot-rules/snapshot/tree 三件随槽扩展；index.ts 导出面扩。
- **内容面**：3 心法条目（content/martial/ 同集合）＋character.json mental 块（预置 mnt-lq-001）＋cmd-equip/cmd-unequip err 词面中性化（errKey 不动）。
- **schema 三处同步**：martial.schema（pattern ^(mrt|mnt)-/if-then 按 kind 分 required/kind enum 两词/modifiers 字段）、config.character（mental 块）、content.md；check-content.mjs 第六道两块并检。
- **测试**：core 新增 combat-mental.test.ts 24 例（两层真成员与 stat 分组/五点消费各例〔22/24/8/12→闪避/dodge 曲线/300/60〕/空恒等/slotKindOf 大声面/jifa 分流与双上限/notInCombat/槽位六例〔升序/删键/旧档/畸形/读档三漂/往返〕）＋C3 e2e 断言面重钉；web 新增 combat-c4-e2e 2 例（AC11/AC12 全链：预置 22→刀兵未歇→收招 19 回归→删槽→激发孪生行；C3 档删 mental 键照读续战）。core 947/web 340＋typecheck＋三道门禁全绿。
- **spec 升级随批**：spec/04（§1.4 mental 新槽＋serializeWorld 键序句＋§5 自检）、spec/01（空退化形口径句两处）、spec/02（适配器 kind 分流）、spec/06（martial 改形＋mental 块＋计数 4→7）、spec/00（ADR 行）、CONTEXT（心法/修饰符词条扩写＋出招来源整条重写）、content.md（心法写作节）、HANDBOOK（六道叙述＋计数 36 JSON/71 文件 46＋25/C4 台账行）＋AGENTS 计数 44→45 四处。
- **已知债务**：条件修饰符/灼烧/效果抵抗（C5）；战斗文本词库（C6）；七系签名与暴击（C7）；战报（C8）；全 attrs 读取统一通道化（装备/词缀多源时代）；CONTEXT 词条群的 C4 旧票名六处已随批改口（C6/C5）。
