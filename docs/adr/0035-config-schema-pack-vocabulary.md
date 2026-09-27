# config schema 只管形状与非空，包词汇契约随包走

`config.dimensions.schema.json` 的 `required` 名单点名武侠包的 10 个维度，`config.display-tiers.schema.json` 的 `required: ["martialTiers"]` 加表名封闭点名武侠包的两套表。schema 是引擎/管线资产（一个目录一份 schema，ADR-0003），点名内容包词汇有三个后果：第二套包的表只能按 schema 的「形状」那一半校验（`mini-content-pack.test.ts` 被迫显式剥离 `required` 才绿，spec/00「迷你包同样通过 `schemas/` 校验」只在剥离之后成立）；迷你包进不了 `content:check`（搬进 `content/` 即红）⇒ 离线原型环检测永远零输入；验收标准 2「换一套内容包，引擎不改一行代码」名实不符。`label` 描述还把档位词的出处强制到 xkx100 §5.1 原表——同病。

## Context

- spec/03 §5.1 早已写明「封闭由注册表执行、schema 只管形状」；ADR-0004 定「schema 不写死枚举」；ADR-0029 §5 定「维度表随内容包走、传了才校验、没传跳过」。schema 的 `required` 包专名名单与这些决策相反，是实现期的偏离。
- 但那份名单确实是今天唯一的「表项齐全」防线：`content/` 至今零 tags，封闭校验零输入；`elements` 拼成 `element` 这类错误今天照样过 `content:check`。直接删掉 `required` = 把一道真闸门换成没有。
- #27 摆出三选项并要求先定案：(a) 从 schema 移除 `required`、语义改由注册表/装载器在加载期校验；(b) 每套内容包各配一份 dimensions／display-tiers schema；(c) `required` 换成与包无关的约束（如「至少一个维度」），保住「空表不算一张表」。

## Decision

取 **(c) 吸收 (a)**（2026-09-27）：

1. **schema 只管形状 + 「空表不算一张表」**：两个 config schema 的 `required` 包专名清单删除，换成 `minProperties: 1`；维度表再加维度名 lowerCamelCase、键列表非空去重，显示档位表再加表名 lowerCamelCase、每表至少一档、档位项固定形状。**包词汇（维度名、表名、档位词）一个都不进 schema**。
2. **语义归注册表封闭（加载期）**：「内容引用了表里没有的维度／越界键」大声失败（ADR-0029 §5 已有）——它就是 (a) 要求的**等价加载期校验**，词汇闸门在**引用完整性**上；红路径测试双侧钉住（第二包误用武侠维度、武侠包自己拼错维度／表漏被引用维度）。
3. **防护口径从「名单完整性」换成「引用完整性」，残余如实记录**：表里声明但内容尚未引用的维度若丢失，包无关机制**无人报警**，直到有内容引用它——包无关 schema 的原理性边界。
4. **显示档位是内容包的能力、不是引擎的需求**（#27 AC4 二选一取 (ii)）：包可以**不落** `display-tiers.json`（迷你包就没有）；落了文件则至少一张表、每表至少一档。档位词纪律归内容包文档（`content/style-guide.md`）。
5. **包词汇契约归包文档**：10 个维度的语义 → `docs/agents/content.md`「维度键」（schema 三处同步的第三处）；「档位名不得杜撰」已在 style-guide 与 CONTEXT.md。
6. **id 印记不取**：维度表／显示档位表保持纯映射形态 `{ <维度>: [<键>…] }`，不照 calendar/settings 加 `{"id": …}` 戳。
7. **#27 两条 AC 措辞的落实读法**（留档）：「两个文件在**不删 required** 的前提下通过 `content:check`」「迷你包用**完整 schema（含 required）**校验通过」——落实为**「不删表项、不删闸门、零剥离」**：schema 的约束存活（非空闸门 + 形状，只是不再点名包词汇），测试用**整份**出厂 schema、无剥离。按字面要求 `required` 关键字原样存活与票面 (c) 的定义（「`required` 换成与包无关的约束」）及「迷你包过完整 schema」互相矛盾；唯一能让关键字存活的 id 印记路线已否决（见上）。内容侧的实际改动只有一处：`display-tiers.json` 移除零长度占位 `"professionTiers": []`（空数组不是内容，见 Consequences）；`dimensions.json` 一字不动。

## Considered Options

- **(a) 纯形状（连非空闸门也拆）**：被否——白丢「空表不算一张表」这道真闸门；(c) 与它的差别只在这道闸门上。
- **(b) 每包一份 schema**：被否——两份 schema 易漂移、维护成本高；与管线「一个目录一份 schema」的映射冲突（迷你包要进 `content:check` 就得另带 schema 根）；per-pack `required` 与 spec/03 §5.1「schema 只管形状」矛盾。
- **裁武侠表迁就 schema**（删 `quality`／`martialTiers` 等表项）：被否——问题在 schema 点名，不在表；裁表伤内容。
- **id 印记路线**（照 calendar/settings 给两个 schema 加 `required: ["id"]`，让 `required` 关键字存活）：被否——① 维度表的形状就是标签形状本身（ADR-0029 §1「形状唯一」，`DimensionTable` ＝ tags 的键空间），加戳打破这面镜子，注册表封闭还要给 `id` 开例外；② 「空表」得写成 `minProperties: 2`（戳 + 至少一维度），绕；③ 自识别价值为零（`config/<名>.json` 文件名即类型）。calendar／settings 是**有内层结构**的表（rings／分组），戳贴得上；映射型表贴不上。
- **给迷你包编一张自己的 display-tiers 表（AC4 的 (i)）**：被否——显示档位零引擎消费者，编表是杜撰内容、证明不了机械性质；「schema 放行异种表」由合成用例钉住即可。

## Consequences

- 两个 config schema 改为**包无关**。`content/config/dimensions.json` **一字不动**；`display-tiers.json` 移除零长度占位 `"professionTiers": []`——「空表不算一张表」一以贯之，空数组不是内容，「生产称谓 16 档待补」住在 `docs/agents/content.md` 与 HANDBOOK。
- 迷你包的维度表过**整份**出厂 schema，`mini-content-pack.test.ts` 的 `const { required, ...shapeOnly } = ...` 剥离逻辑删除；「第二套包误用武侠维度」的反向用例保持有效，另补武侠侧红路径把「接住」钉成双侧。
- 迷你包进 `content:check` 的先决条件解除（「`content:check` 扫不扫测试夹具」是范围问题，另议）。
- 落点：`docs/spec/06-content-schema.md` §6.3、`docs/spec/03-world-model.md` §5.1／§6.1、`docs/agents/content.md`「维度键」与显示档位条目。
- **已知空缺**：条件表达式（`has_tag` 实参）里的维度引用不在封闭范围（只走条目 `tags`）——**在本决策之前就如此**（旧 `required` 也只管表不管条件），非本决策引入，留待后续。

规格落点：`docs/spec/06-content-schema.md` §6.3、`docs/spec/03-world-model.md` §5.1／§6.1。
