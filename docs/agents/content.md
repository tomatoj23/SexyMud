# Content pipeline: `content/` 目录与批量写入约定

游戏内容全部以 JSON 文件存放在 `content/`，以 JSON Schema 校验为硬门禁。修改内容的 AI agent 必须遵守本约定。

## 目录结构

```
content/
├── config/           # 结构性配置：activities、resources、dimensions、settings 等
│                     #   （曲线、槽位、维度表、阈值——引擎零写死数量的载体）
│                     #   ⚠️ realms（境界序列）已随 ADR-0019 删除；造诣是纯显示层
├── effects/          # 效果定义：primitive 组合条目（武功/怪物/层主共用）
├── martial/          # 武功（招式 + 心法），字段 kind 区分
├── equipment/        # 装备基件与词缀池
├── beast/            # 兽（随从栏内容，一系一只）：修饰符 + 叙事片段；获取走 sect exchange 兑换，
│                     #   不走掉落管线（ADR-0013）
├── monster/          # 怪物
├── dungeon/          # 秘境与层配置（规则层：分层 / 驻守 / 产出）
├── rooms/            # 房间（空间层：出口 / 进入文本 / 常驻实体引用）
│                     #   按 zoneId 归属秘境，与 dungeon 是规则层与空间层的分工（ADR-0016）
├── npcs/             # 人物：世界中可交互实体（外观称呼 / 对话 / 行为）
│                     #   战斗数值引用 monster/ 条目，不复制（ADR-0016）
├── commands/         # 命令表：动词 / 别名 / 参数形态 / 前置条件 / 拒绝文案
│                     #   全是数据，引擎只做通用解析与分发，不认识任何动词（ADR-0016）
├── herb/             # 药材
├── pill/             # 丹方与丹药
├── sect/             # 门派
├── event/            # 奇遇事件文本
├── combat-text/      # 战斗文本模板（13 槽位）与后果词库（5 维分池）
├── lore/             # 世界观长文本（Markdown）：故事背景、势力关系等
└── style-guide.md    # 文风指南：叙事字段必须遵守
schemas/              # 与 content/ 一一对应的 JSON Schema（含 config/）
assets/               # 美术资产（MVP 允许为空）
├── icons/<集合>/<id>.png
└── portraits/<集合>/<id>.png
```

> ⚠️ `rooms/` `npcs/` 是 ADR-0016（2026-09-01）新增的两个集合，**Schema 与 id 规则尚未定稿（M1 工作）**。**定稿前不得写入条目**——否则绕开 `content:check` 硬门禁，属违规。`commands/` **已定稿**（M1-T5，`schemas/commands.schema.json`），字段约定见下文「命令集合」节。

## 硬性规则

- **id 一经发布不可变更**：资产路径、存档引用都依赖它。条目集合命名格式 `<集合缩写>-<门派/区域>-<序号>`，如 `mrt-hs-001`（华山招式 1）、`mon-sy-014`（山魈 14）；**config 集合豁免序号段**，用 `<类别>-<序号>` 或语义名（如 `act-practice`、`res-experience`）；**commands 集合同理用语义名**（`cmd-look`、`cmd-rest`——命令是全局的，无门派/区域归属），**文件名 = 条目 id**。id 只用小写字母、数字、连字符。
- 每个条目必须通过对应 Schema 校验后才能提交。校验命令：`corepack pnpm content:check`。
- 叙事字段（`description`、事件文本等）必须遵守 `content/style-guide.md` 的武侠语体；世界背景类长文写入 `content/lore/*.md`。
- 资产不内嵌 base64、不写绝对路径；引用走约定路径，确需覆盖时用条目的 `art` 字段（相对 `assets/` 的路径）。
- 禁止修改 `schemas/` 下的定义来迁就一次内容写入；Schema 变更是独立决策，需同步 `core` 校验器与编辑器表单。

## 条目字段约定

通用字段（各集合按需使用，Schema 为准）：

- `prerequisites`：先修条件（学此武功的前置），值是**单个条件表达式**（`schemas/condition.schema.json` 根定义：递归 `{all/any/not}` + 谓词，**不用字符串 DSL**）。
- `preconditions`：门禁映射 `{ "default": <条件>, "<accessType>": <条件表达式> }`（`condition.schema.json#/definitions/accessRules`，spec/02 §5）。`default` 是所问 accessType 无表达式时求值的**完整条件**（布尔即直白策略位，`false` = 缺省拒绝最常用）；accessType 词汇表由各集合自定（命令 `use`、出口 `traverse`、学习 `learn`）。
- `err_*`：拒绝文案，键名 = `err_` + accessType（默认门拒绝时渲染层读 `err_default`，可省略）。**拒绝也是一种叙事**：引擎只报告读哪个字段（`commandRefused` 事件携带 `errKey`），文案本体永远在条目数据里，引擎零文案。
- `masters`：门派条目的师父字段（`sect.masters`）。MVP 只留字段、无实际内容（可教武功池与贡献规则后续填充）；"学习武功"流程带条件检查点，做拜师门槛不动流程、只改配置。
- `sectId` / `regionId`：条目的**门派归属** / **区域归属**，校验器据此检查覆盖与连通。
- `tags`：标签集。**优先用标签表达语义，不建特殊类型**——例如纯叙事道具就是普通条目加 `tags:["quest"]` 且价值归零；战斗相关条目用**对象形态** `{ "moveTag": [...], "elementTag": [...] }` 做维度键，取值来自 config 维度表（见「combat-text 与效果」）。
- `effects`：效果引用列表（`["eff-xxx"]`），指向 `content/effects/` 的效果定义条目；效果 = primitive 组合（候选集限定 **13 项**，见 `docs/engine-reservations.md` §3），武功/怪物/层主共用。
- `progression`：仅用于生产活动（采集、炼丹等），内容侧只放**等级参数** `maxLevel`（等级上限）与 `xpPerCycle`（每次产出获得的经验）。**玩家的当前等级与经验是运行时状态，存于存档，不写进内容条目**。等级与战力门槛（`powerMin`）共同决定可进入的采集区。
- `rates`：活动直接产出的资源列表；**产出为物品（如药材）的活动可为空数组**，此时产出由物品表定义。

## 命令集合（content/commands/，M1-T5 已定稿）

每条命令一个 JSON 文件（文件名 = id），**引擎不认识任何动词，加命令 = 加内容文件**（spec/02 §2）。字段（`schemas/commands.schema.json` ／ 引擎 `CommandEntry`（`packages/core/src/command/entry.ts`）与本节三处同步）：

- `id`：语义名 `cmd-<语义名>`（如 `cmd-look`、`cmd-rest`），**即分发键**（cmdset 成员与动词表都引用它）。
- `verbs[]`：触发动词，**中文与英文缩写并列**（如 `["看","瞧","look","l"]`）——这是内容层别名层；玩家层别名存存档（spec/02 §6）。同一数组内长短别名可共存（解析按最长动词匹配）。
- `argForm`：参数形态枚举 `none`／`text`／`target`／`target-ordinal`／`target-index`（引擎 `ArgForm`，spec/02 §1.2）。
- `cmdset`＋`priority`＋`mergetype`：归属命令集（合并源名，如 `character`／`session`／`room`）与该集的合并规则。**合并规则属于命令集**：同一 `cmdset` 的所有条目必须声明一致的 `priority` 与 `mergetype`（省略 = `Union`），`ContentRegistry` 分组（`commandSetSources`）对不一致抛错。
- `preconditions`：门禁映射（`condition.schema.json#/definitions/accessRules`）。**命令集合的 accessType 词汇表：`use`**——宿主装配 `CommandSpec` 时以 `commandSpecFromEntry(entry, { accessType: "use", func })` 传入；省略字段 = 无门禁。
- `err_use`／`err_default`：拒绝文案（键名 = `err_` + accessType），可省略；文案遵守 style-guide（第二人称「你」、古典白话）。

引擎侧读法：宿主加载 JSON → `createContentRegistry({ commands })`（重复 id 抛错）→ `commandSetSources(registry.commands)`（按 cmdset 分组）→ `mergeCmdSets` → `verbEntries()` 即动词表。**引擎 src/ 永不 import 内容 JSON**。

命名语汇（写内容时必须遵守，详见 `CONTEXT.md`）：

- 武功**品阶**：下乘 / 中乘 / 上乘 / 绝学
- 装备**稀有度**：寻常 / 精良 / 罕见 / 绝世
- **造诣 / 显示档位**（数值→造诣描述，由 config `displayTiers` 区间表推导，不写死在条目里）：**50 档**（完整列表见 `docs/research/xkx100-kungfu-combat.md` §5.1）；代表性档位：不堪一击 / 初窥门径 / 驾轻就熟 / 炉火纯青 / 出神入化 / 返璞归真。**造诣是纯显示层，不产生任何门槛**（ADR-0019）

## combat-text 与效果

### 槽位（13 个，一律平等）

**语法 = `{attacker}` 英文花括号**（非 xkx 的 `$N/$n/$w/$l`；已删 `{动词}` 与 xkx 代词）。槽位分两组，分组仅为理解方便，schema 不分两类：

- 填空变量 9：`{attacker}` `{defender}` `{move}` `{weapon}` `{defenderWeapon}` `{limb}` `{damage}` `{consequence}` `{elementFlavor}`
- 修饰片段 4：`{opening}` `{moveIntro}` `{weaponAction}` `{verb}`

约束：`{elementFlavor}` 无属性时填**中性词，不可为空串**（否则产生"，，"）；招式名出现时用「」括起（「白虹贯日」）。

**模板 = 片段序列**（条目自声明 `segments` 数组，可变长度：下乘 3 段／中乘 4 段／上乘 5-6 段／绝学 7 段）。示例：

```text
{opening}{attacker}{moveIntro}「{move}」，{weaponAction}{elementFlavor}，
{weapon}{verb}{defender}的{limb}，{consequence}。
```

### 动词 → motion 推导链

**motion 4 值**：`thrust`（刺）／`sweep`（扫）／`chop`（劈）／`grapple`（拿）。motion 是**动词的属性**，不是招式的属性——招式不自带 motion：

```text
动词抽取 = 招式声明 ∩ 兵器动词池 → 抽到 {verb} → 取该动词的 motion
source    = 招式声明（内功/外功）
后果词库  = motion × source × 伤害档 × 剩余生命档 × 系别
```

- 兵器类型决定动词池：剑→刺/点/撩/抹/扫/劈，刀→劈/砍/斩/削，棍→扫/砸/抡/戳，拳掌→拍/击/推/按
- 推论：剑招（外功）只有 thrust/sweep/chop 画面，不会出现"拍飞"或"气血倒流"；「气血倒流」只属于内功招式（source 覆盖 motion）
- 引擎做的只是"在一个被过滤的集合里随机"；搭配表（动词→motion、动词→部位白名单）是**内容不是引擎逻辑**

### 后果词库分池（5 维）

后果词库分池依据 = **伤害档（轻/中/重/濒死）× 剩余生命档（满/多/半/少/危）× 作用方式（内功/外功）× motion（4 值）× 系别**，档内词条风格一致；键的取值集见 `content/config/dimensions.json`。

门控三条（详见 `content/style-guide.md`，四档一视同仁）：① 致命部位仅当 伤害档 ∈ {重, 濒死} 且 剩余生命档 ∈ {少, 危}；② 兵器类型决定动词池；③ 先定节奏档（急/缓/稳），各片段只从同档池抽。

### 维度键

- 条目 `tags` 用**对象形态**：`{ "moveTag": ["sword"], "elementTag": ["fire"] }`
- `condition.dimension` 的取值来自 `content/config/dimensions.json`（维度表）；引擎只做**键取值 + 集合求交**，永不 parse 字符串
- 加维度 / 加取值 = 加 config 表项，不动引擎

### 效果定义（`content/effects/`）

- 效果定义 = **primitive 组合**条目：`{ "id": "eff-xxx", "primitives": [...] }`
- 候选集限定 ✅ 的 **13 项**（16 项穷举排除 连击 / 护盾 / 位移，见 `docs/engine-reservations.md` §3）；MVP 先用其中 9 个 + 另注册 2 个
- 武功/怪物/**层主**（秘境每层驻守主怪）通过 `effects: [...]` 引用；层主带机制 = 用现有 primitive 组合，不新增引擎能力

## 批量生成工作流

1. 明确目标集合与数量（如"给 3 个秘境共 30 只怪物补 description"）。
2. 读取该集合现有条目与 `content/style-guide.md`，保持语体一致。
3. 写入/修改条目 JSON（每条目一文件，保持既有 id 不动）。
4. 运行 `corepack pnpm content:check`，全部通过才算完成；报错必须修复而不是跳过校验。
5. 汇报变更清单（新增/修改的 id 列表），便于人工抽查。

## 批量数值调整

平衡性批量调整（如"全部中乘武功攻击 +10%"）优先使用编辑器的表格视图多选操作；用 agent 做时，必须在汇报中列出调整前后数值对照表，并同样通过 `content:check`。
