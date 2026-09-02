# 03 · 世界模型

> **状态**：§1–§4 **内容侧已实现**（M1-T6：`schemas/rooms.schema.json` + `schemas/npcs.schema.json` + 首批内容（柳青镇 4 房间／3 人物／1 怪物）+ 引擎类型 `RoomEntry`／`ExitEntry`／`NpcEntry`（`packages/core/src/world/entry.ts`）+ 注册表加载期引用完整性 + 出口即命令全链路）；**§7 实体 hook 运行时已实现（M2-T1：`Entity` 接口 + 移动族 8 hook + `moveTo` + 引擎出厂穿行适配器 + 状态树种子，见 §7.3；M2-T2：`return_appearance` 纯组装 + `at_look` 可见性 + look 出厂适配器，见 §7.5；M2-T3：`at_msg_receive` 可否决 + `fromObj` 可空的广播原语 + `at_pre_say`／`at_post_say` 配对 + say 出厂适配器，见 §7.4；M2-T4：get／give／drop 转移配对 + creation 两层 + 动态 cmdset 接缝，见 §7.6）**；§5–§6（标签运行时、原型继承）**设计已定案**（见 §5.1／§6.1，ADR-0029／ADR-0030），**实现＝M3**。形态定案见 §4.2（ADR-0028）。
> **依据**：ADR-0016 §3、ADR-0021 §2、ADR-0022 §3（经 ADR-0024 §7 修正）、ADR-0022 §4、**ADR-0020 §社会层**、ADR-0025 §五、**ADR-0028**、xkx100 调研。

## 1. 集合划分

| 集合 | 内容 | 说明 |
|---|---|---|
| `rooms/` | 房间 | **空间层**：出口、进入文本、放置清单、规则 |
| `npcs/` | 人物 | 可交互实体（店家、掌门、路人）。战斗数值**引用** `monster/`，不复制 |
| `monster/` | 怪物 | **战斗数值 + 叙事形象** |
| `dungeon/` | 秘境 | **规则层**：分层、驻守、产出 |

**秘境（规则层）与房间（空间层）靠归属字段 `zoneId` 关联**，不是同一集合。
依据：ADR-0016 §3

## 2. 房间 = 四要素

借自 xkx100 的实证结论：

| 要素 | 说明 |
|---|---|
| **出口图节点** | 方向 → 目标房间 id 的有向边 |
| **描述文案** | 长描述，可内嵌实体存在的暗示 |
| **放置清单** | 实体 id → 数量；房间是「内容容器」 |
| **规则** | 门禁（如「少林山门禁女客」），**拒绝文案也是内容** |

**要点**：描述文本与数据互相印证——长描述里出现的元素（守门僧）必须真的在放置清单里。机械校验已落（2026-09-01）：`packages/core/tests/world-content.test.ts` 按**名匹配**做单向断言（描述含其名 ⇒ 放置含其 id；被 npc 引用的怪物不重复计名——它是战斗投影不是第二具身体）。子串匹配的已知局限：叙述性缺席（「原是货郎落脚处」）会误报，届时改写或加显式豁免。

## 3. 出口

- 独立实体，**不是房间的字段**（见 `02-command-layer.md` §4）
- 门禁与拒绝文案挂在出口上

### 3.1 落地形态（M1-T6）

出口以**命令实体 + 有向边**的形态落地：`ExitEntry extends CommandEntry`（方向词是它的 verbs、门禁与 `err_traverse` 文案挂在它身上、自声明 cmdset `exits` 与优先级 +101），另带 `direction`（同房唯一）与 `targetRoomId`（注册表校验解析）。出口文件物理上住在房间条目的 `exits[]` 数组里，但**身份是全局的**（exit id 即分发键，`registry.exit(id)` 可查）。落地细节见 `02-command-layer.md` §4.1。

## 4. 人物 vs 怪物

- **人物**回答「是谁」，**怪物**回答「多能打」
- 人物引用 `monsterId`，**不复制数值**——避免双处维护
- **NPC 敬称随玩家的造诣档位变化**（后生 → 少侠 → 前辈…），敬称是一张内容表条目，不是引擎逻辑。依据：ADR-0020 §4（社会层反馈）

### 4.1 落地形态（M1-T6）

`schemas/npcs.schema.json` ＋ 引擎 `NpcEntry`（`packages/core/src/world/entry.ts`）：人物只带 `id`／`name`／`description`（回答「是谁」）与可选 `monsterId`（战斗数值引用）——**schema 上没有任何战斗数值字段的容身之处**（`additionalProperties: false`），「不复制」是结构性保证而非约定。是否可触发战斗 = 是否声明 `monsterId`；首批三人物中店家与货郎无之、护院孙彪引用 `mon-lq-001`（注册表校验引用存在性）。人物自身不带位置——站在哪里由房间放置清单决定（房间是内容容器）。敬称档位表待社会层票。

### 4.2 实体模型（M2 定案，ADR-0028）

- **动态占用**（运行时实体）：持有可变状态的实体——M2 只有玩家（位置在状态树）；走 `Entity` 接口 ＋ hook 运行时
- **静态在场**：NPC 不物化，外观组装直读放置清单；`count > 1` 的确定性实例 id 难题随战斗/物品才真实
- `Entity` 接口为将来物化留位（物品、需要状态的 NPC）；`at_object_creation` 两层的首个真实消费者是那张票
- 事件接收者集合 = 房内**动态占用**（静态在场不消费事件）；`return_appearance` 是静态在场与动态占用的汇合点

## 5. 标签纪律

- 标签 **维度 + 键**，**不带值**（需要带值用属性）
- Evennia 的 tag `data` 是**全局的、最后写入者赢**，是反模式
- 引擎维护 `(维度, 键)` 倒排索引，支持跨内容批量查询（「所有带 `outdoors` 的房间施加天气」）
- **归属字段化，不做目录分层**（`zoneId` / `sectId` / `regionId`）
- 标签与**标记位**并存、互不取代：标记位回答「有没有」，标签回答「归在哪一类」

依据：ADR-0008、ADR-0021 §5、ADR-0025 §二、**ADR-0029**

### 5.1 落地形态（M3）

- **形状唯一** `{ <维度>: [<键>…] }`（ADR-0029 §1）：维度名与键取值由 `content/config/dimensions.json` **封闭**——但**封闭由注册表执行、schema 只管形状**（维度名 lowerCamelCase、键列表非空去重）：主机传了维度表就硬校验、没传就跳过，故「不在维度表里的维度写不进内容」以**拿到维度表**为前提。`equipment` 的 `string[]` 孤例改齐。第二分量叫**维度**，不叫 `category`（与 CONTEXT.md「归属」的禁用词撞）。
- **两侧都住**：内容条目 → 注册表内建倒排索引 `byTag(dimension, key) → id[]`，覆盖**所有带 tags 的实体**——**四个集合的条目 ＋ 出口**（**定案 2026-09-02，答 #15 的边界提问**：连出口一起索引。依据：出口 id 全局唯一、与条目 id 是**同一个 id 空间**（出口 id 即分发键，spec/02 §4），混排不会撞；M3-T1 已为出口开了 schema 口子〔出口即命令〕，只写不查等于留一个死字段。引擎不认识集合，只认带 tags 的实体）；运行时实体 → `EntityState` 加 `tags` 槽（与 `flags` 并列），`subjectOf` 据此回答 `hasTag`——`hasTag` 由**桩**（恒 `false`）变真实现，`has_tag` 谓词第一次有真实数据可读。
- **并集那条缝**：「自身 ∪ 其内容条目」**接缝先行、合成驱动**（M2-T4 先例）。今天只有玩家是动态占用、而玩家没有内容条目，这一半**无真实消费者**，等物化票（物品、有状态的 NPC）缝合。
- **内容条目侧也分两层**：`tags`（有维度、进索引）与 `flags`（裸布尔、不进索引）。`spec/06` 的 `tags: ['quest']` 改 `flags: ['quest']`——它的语义是**布尔判断**不是归类。
- **维度表随包、由主机传入**：传了就硬校验，**没传就跳过**；`byTag` 不依赖维度表（索引按 `(维度, 键)` 建，不需要知道哪些维度合法）。`element`（字段取值池，含 `none`）与 `elementTag`（标签维度）不合并，子集校验留 `content:check` 待办。
- **测试**：接缝 1 `tests/content-registry.test.ts`（合成条目：形状与取值校验、索引查询、维度非法、缺维度表时跳过、规范序）＋ 接缝 2 `call()` 全链路（合成一个挂 `has_tag` 门禁的出口，直接往状态树写/删标签，断言放行/拒绝与语义事件——照 look 票「执灯可见」直接写 `flags` 的先例）。
- **落地（M3-T1，#14）**：`tags`／`flags`／`prototypeKey`／`prototypeParent` 作为**条目通用字段**落成两处——`schemas/common.schema.json`（唯一定义，14 个条目集合 `$ref` 引用）与引擎 `EntryCommon`（`packages/core/src/content/entry.ts`，各条目类型 `extends` 它）；第三处同步在 `docs/agents/content.md` 的「条目字段约定」。schema 只管**形状**（维度名 lowerCamelCase、键列表非空且去重、四字段一律可选——唯一例外是 `equipment` 词缀的 `tags` 必填——且只在**实体层**：条目带，**出口**也带〔出口即命令，类型与 schema 必须一致〕，`objects[]` 放置清单项不带），**取值**封闭与原型展平是下面两票的事。形状本身的守卫是 `tests/tags-prototype-schema.test.ts`（逐集合一条用例）。

## 6. 原型继承

条目可带 `prototypeKey` 与多亲 `prototypeParent`（左→右优先，自身 > 最右父 > … > 最左父）。

**合并规则**：
- **只有 `attrs` 与 `tags` 互补合并**（**同维度 + 同键**才覆盖），其余键**整体替换**
- 这条已被 Evennia 源码确认是对的

**三处必须补的（否则会踩坑）**：

| 项 | 说明 |
|---|---|
| **归一化** | Evennia 在合并**前**跑 `homogenize_prototype`：`aliases` 强制成 list、tags 补 3 元组、attrs 补 4 元组、`None` → `[]`/`""`。我们的 JSON Schema **必须就要求规范形态** |
| **环检测** | Evennia 源码明说「we don't check for infinite recursion here」。**`content:check` 必须加原型环检测** |
| **`prototypeKey` 禁止继承** | Evennia 用 `uninherited` 强制回写，子体若无该键会被覆盖成 `None` |

⚠️ **动态值**：Evennia 的 protfunc（`$random()`）**违反确定性**——改为种子化白名单求值节点。
⚠️ 合并非纯函数（原地改 dict），我们要保证**可复现的输出顺序**。

依据：ADR-0022 §3、ADR-0024 §7、**ADR-0030**

### 6.1 落地形态（M3）

- **加载期展平，在注册表内**（ADR-0030 §1–§2）：顺序 = **`id` 去重 → 展平 → 引用完整性校验**。顺序不是审美——继承来的 `exits`、放置清单、`monsterId` **也必须被引用校验**，否则「把字段放进原型」就是绕过校验的后门。主机侧做展平则 M2-T6 的「同一装配路径」从**结构保证**退化成**纪律**。
- **同集合内继承**，不跨集合；原型条目**塞在被继承的集合里**，不开 `prototypes/` 集合（形状差别为零，只是多一个 `prototypeKey`）。
- **`prototypeKey` 的值 = 条目 `id`**（schema 表达不了，由注册表校验）；继承引用写 `prototypeParent: [<父条目 id>]`。展平结果**剥掉 `prototypeParent`**（已消费的指令）、**保留 `prototypeKey`**（条目的属性）→ **没自己声明 `prototypeKey` 的条目展平后就没有它，也就不可被继承**：构造性保证，不是约定。
- **合并律**：`tags`（及 `attrs`）**互补合并**，其余键**整体替换**；多亲左→右优先（自身 > 最右父 > … > 最左父）。合并后数组**字典序升序 + 去重**（顺序不承载语义；否掉「按维度表顺序」——表顺序会变，会破坏「同内容同字节」）。
- **`attrs` 不进 schema**（ADR-0030 §7）：展平器按与 `tags` 同律实现其互补合并（规则对称、成本近零），但 schema 不开口子——`additionalProperties: false` 加上一个没有读写方的字段，等于提前承诺一个还没设计的形状。由**合成测试**行使（测试数据是裸对象，不经 schema）。
- **环检测双保险**：`content:check`（离线，内容作者提前发现）＋ 注册表展平时（运行时，**不信任输入**）。环是**引用**性质（ADR-0003 分层），两边都管。
- **归一化交给 schema**（直接要求规范形态），加载期不做 Evennia 那种 `homogenize_prototype`。
- **测试**：接缝 1 `tests/content-registry.test.ts`（合成条目：合并律、多亲优先级、字典序、自环/二环/长环/菱形非环、`prototypeKey` ≠ `id`、引用未声明者、展平后不含 `prototypeParent`）＋ 迷你包（**真实继承链**，经同一装配路径）。`content:check` 的环检测沿既有先例**不新增单元测试**（四道检查都没有）。
- **落地（M3-T1，#14）**：`prototypeKey`／`prototypeParent` 与 `tags`／`flags` 一起进 `schemas/common.schema.json`（见 §5.1 落地条）：四个字段是**同一份实体层契约**的两半（条目带，出口也带——出口即命令），14 个条目集合统一引用，一律**可选**。schema 表达不了的三件事（`prototypeKey` 是否等于本条目 id、父是否声明过原型、是否成环）留给注册表展平（#16）与 `content:check` 环检测（#19）。

## 7. ★ 实体 hook：第一天必须定对的九项

读完 Evennia 141KB 的 `objects.py` 提炼。这九项**后期改造成本极高**：

1. **移动三元组**：`at_pre_move`（可否决）→ `announce_move_from`（旧位置）→ `announce_move_to` + `at_post_move`（新位置），外加容器侧 `at_pre_object_leave` / `at_pre_object_receive` / `at_object_leave` / `at_object_receive`。**必须带 `moveType` 字符串**（teleport / traverse / get / give / drop）——没有它，后期无法在同一条移动路径上分流叙事。
2. **`move_to` 不做权限检查**（Evennia 源码明说）——锁检查外置，否则每个 hook 都得补一遍。
3. **消息渲染必须按接收者逐一遍历** —— 若做成「先渲染成字符串再群发」，中文的「你／他／她／它」与按观者的可见性差异**永远补不回来**。
4. **`at_msg_receive` 可否决 + `fromObj` 可为 None** —— 把「谁在听／谁能被屏蔽」做成一等公民。
5. **`return_appearance` 必须是纯返回、不发消息** —— 这是确定性引擎的核心边界。
6. **`at_look` 内部做可见性检查**，而不是在命令里。
7. **`at_pre_get/give/drop/say` 的 pre 可否决 + post 通知配对** —— 中文 MUD 的社交叙事全挂在这四个上。
8. **`at_object_creation` vs `at_object_post_creation` 两层**：前者是默认值，后者让 **JSON 内容覆盖默认值**。**顺序错了，JSON 内容永远赢不了代码默认值。**
9. **动态命令集时机**（等价 Evennia 的 `at_cmdset_get`）—— 出口靠它把自己变成命令，实体状态变化时按需重建可用动作。

### 7.3 落地形态（M2-T1）

- **`Entity` 接口 ＋ `createEntity`**（`packages/core/src/world/entity.ts`）：移动族 8 hook（移动侧 `at_pre_move`／`announce_move_from`／`announce_move_to`／`at_post_move` ＋ 容器侧 `at_pre_object_leave`／`at_pre_object_receive`／`at_object_leave`／`at_object_receive`）全部按任意实体设计；引擎默认行为只有两个 announce（逐接收者发语义事件 `departed`／`arrived`），无默认否决。位置（`locationId`）可为房间 id **或实体 id**（实体即容器——get/give/drop 的去向），容器 hook 只在位置是实体时触发（房间是内容，无 hook）。
- **`moveType` 五值**（`MOVE_TYPES`）：teleport／traverse／get／give／drop——引擎语义枚举，`MoveInfo` 携带它进每个 hook。
- **`moveTo`**（`packages/core/src/world/move.ts`）：纯 hook 编排（否决点全部先于播报）＋唯一的位置写点，**零权限检查**（§7 第 2 项落点确认）。否决返回 `{ok: false, stage}`，stage 是语义码（哪个 hook 拒绝）。
- **`WorldRuntime`**（`packages/core/src/world/runtime.ts`）：ContentRegistry ＋ 状态树 ＋ hook 载体实例三合一；`occupantsOf` 按 id 升序（确定性）；`subjectOf` 从树状态构造条件主题（flags/location 真实回答，未落地槽位答「无」）。两条注册路径：`addEntity`（**创建**——注册＋种子状态进树，跑 creation 两层的是 `createObject`）与 `attachEntity`（**恢复**——树已有状态，只重挂实例，位置须仍能解析，顺序无关；M2-T5）。
- **穿行适配器 `traversalSpec`**（`packages/core/src/world/traverse.ts`，引擎出厂，ADR-0028 §3）：出口 traverse 门禁（管线 access 段）→ 目标房 enter 门禁（`checkAccess`，事件带 `roomId` 定位房间文案）→ `moveTo("traverse")`。两道门禁拒绝均 `rejected` ＋ `commandRefused` 语义事件；执行段拒绝通道见 spec/02 §4.1。
- **测试**：`tests/entity-move.test.ts`（合成内容：hook 次序／三否决点／零门禁／逐接收者／状态树／响亮失败）＋ `tests/traversal-chain.test.ts`（真实内容：柳青镇全链路、第二假玩家多接收者、异房不收、两道门禁文案来自 JSON、确定性重放）。

### 7.4 落地形态（M2-T3：说）

- **`broadcastMessage`**（`packages/core/src/world/message.ts`）：`at_msg_receive` 的**唯一消费入口**——「谁在听／谁能被屏蔽」一等公民的引擎侧落实（§7 第 4 项）。对同位置**动态占用**（升序）逐一遍历：每个接收者的 `at_msg_receive` 先跑——**显式 false 仅屏蔽该接收者**，其余不受影响；未屏蔽者各得**一条**语义事件。`fromEntityId`（即 Evennia 的 `fromObj` 语义）**可空**：系统消息（环境变化、公告）无发送者，屏蔽决策仍在完整语境（draft／发送者／接收者）下运行。静态在场不消费事件（ADR-0028 §1）；位置不可解析＝装配 bug，**大声抛错**而非静默空广播。容器（实体位置）同样可广播——get/give/drop 的言语场景（箱中说悄悄话）无需新原语。
- **`Entity` 三 hook**（`packages/core/src/world/entity.ts`）：`at_msg_receive`（接收侧，可屏蔽）＋ `at_pre_say`／`at_post_say`（说者侧配对，§7 第 7 项的 say 部分：pre **显式 false 否决**整场广播 + post 广播后通知）。缺省行为＝不屏蔽、不否决、无通知——与移动族「无 pre hook 从不否决」同律；三者的 context 类型与移动族同居 `entity.ts`。
- **`say`**（`packages/core/src/world/say.ts`）：编排（`moveTo` 的言语对应物）——`at_pre_say`（否决点**先于一切投递**）→ `broadcastMessage`（`say` 事件带足语境：`speakerId`／`text`／`locationId`，**说者含在接收者内**——逐接收者渲染把同一事件读成「你」与名字，与移动播报同律）→ `at_post_say`。**零权限检查**（门禁归命令管线，与 §7.2 同源）。说的 `text` 是玩家输入**原样透传**（会话数据，回放与存档需要完整语境），不是渲染叙事——人称立场（你／他）归渲染层。
- **`saySpec` 出厂适配器**（ADR-0028 §2）：`cmd-say` 内容条目经 `commandSpecFromEntry` 绑定（argForm 非 `text` 抛错），`call()` 全链路。`at_pre_say` 否决 → `rejected` + `commandRefused{reason:"sayVetoed", commandKey, stage:"at_pre_say"}`——与 `moveVetoed`（移动 hook 否决）／`notVisible`（look 可见性）同构的**执行段拒绝**。
- **测试**：`tests/say-behavior.test.ts`（合成世界：hook 次序 pre→逐接收筛→post、三否决/屏蔽路径、`fromEntityId` 为空的系统消息、容器内广播、响亮失败；真实内容：大堂双假玩家各一条 + 异房第三者零事件、静态在场（掌柜的）不消费、英文动词同分发、零已渲染文本（text 原样、无「说道」「你说」）、确定性重放）。

### 7.5 落地形态（M2-T2：看）

- **`returnAppearance`**（`packages/core/src/world/look.ts`）：`return_*` 律——纯返回、零消息、零写入。外观组装 = 房名／长描述（注册表内容读）＋ 出口清单（id／方向／verbs）＋ 静态在场（放置清单**直读**，ADR-0028 §1）＋ 动态占用（`occupantsOf` 升序、**剔除观者**——「看」回答观者周围有谁，不回答观者自己）。它是静态在场与动态占用两条在场通道的**唯一汇合点**（宿主可直接消费：房间面板）。
- **`atLook`**：可见性检查在**这里**，不在命令里（§7 第 6 项）。房间 preconditions 可声明**显式** `look` 键（感知该房间是否有条件——黑暗、幻象）；**缺省即对在场者可见，`default` 不管辖 look**——default 表达进入策略，若回填 look，每个缺省拒绝的房间都会对自己的住客变黑（Evennia 的 view 锁同样是「不声明即开放」）。拒绝返回 `errKey`（= `err_look`），不发事件；房间集合的 accessType 词汇表由此扩为 `enter`／`look`（与出口 `traverse` 同类：集合固定词汇，非题材词）。
- **`lookSpec` 出厂适配器**（ADR-0028 §2）：`cmd-look` 内容条目经 `commandSpecFromEntry` 绑定引擎行为（argForm 非 none 的大声抛错——带参的看是另一种行为），`call()` 全链路。可见 → 向观者发**一条** `appearance` 语义事件：roomId／出口清单／静态在场清单／动态占用清单——房名、长描述、实体名字全部留在内容数据（渲染层按 id 经注册表取，与 `err_*` 文案同律），事件零已渲染文本（spec/01 §5.1）；人称立场（你／他）归渲染层；look 是观者的私有感知，同房他人不收事件（与移动播报相反）。不可见 → `rejected`（seq 已消耗）+ `commandRefused` 事件（`reason: "notVisible"`——与门禁拒绝的 `accessDenied` 分立，感知失败与准入拒绝是两类玩家体验；`commandKey`／`accessType: "look"`／`errKey`／`roomId` 定位文案）。
- **测试**：`tests/look-behavior.test.ts`（真实内容：大堂双假玩家 + 掌柜的放置；后院孙彪（放置）与假玩家（状态树）同场——汇合点；`look` 英文动词走同一分发；合成遮蔽房（无灯不可见、执灯可见、同一会话内揭幕）；`default: false` 不使房间对住客变黑；零文本断言（事件串不含房名／描述／NPC 名／`err_look` 文案）；确定性重放）。

### 7.6 落地形态（M2-T4：接缝补全）

**接缝先行、合成驱动**（issue #10）：三块 hook 结构落地，无物品系统——首个真实消费者是物化票（物品、需要状态的 NPC），届时零改形。

- **转移三配对 `getObject`／`giveObject`／`dropObject`**（`packages/core/src/world/transfer.ts`，§7 第 7 项的 get/give/drop 部分）：薄行为层**包在 `moveTo` 外**——`at_pre_get/give/drop`（被转移实体的行为级否决，**先于整条移动链**，拒绝零成本）→ `moveTo("get"/"give"/"drop")`（M2-T1 全链：`at_pre_move`、容器双侧否决、播报、位置写点、`at_post_move`）→ `at_post_get/give/drop`（事后通知）。与 say 的 pre/广播/post 三明治同构；Evennia 默认 get/give/drop 命令正是此形。**三方否决结构**：give 的一次交接被三个 hook 环绕——被给实体（`at_pre_give`）＋ 给者（`at_pre_object_leave`，M2-T1 容器 hook）＋ 收者（`at_pre_object_receive`）；get/drop 各两方。veto stage 报行为 hook 名或透传移动链 stage。目标解析（`get 剑` → 实体 id）**不随本票**——编排收显式 id，「拿得着吗」归命令层门禁（`moveTo` 零权限律的同一推导）。播报即引擎默认 announce 事件、`moveType` 随行——渲染层按因分流叙事零引擎改动（§7 第 1 项的回报兑现）。
- **creation 两层 `createObject`**（`packages/core/src/world/creation.ts`，§7 第 8 项）：`addEntity`（注册＋种子状态进树，位置不可解析大声抛）→ `at_object_creation`（**第一层：代码默认值**，写树状态）→ `at_object_post_creation`（**第二层：JSON 内容覆盖**——post 层运行时默认值已可见，覆盖是有语境的决定）。**顺序即契约**：反了 JSON 永远赢不了代码默认值。本票引擎只保证两层与顺序；「内容是什么形状」归宿主（测试用合成 JSON 数据在 post 层应用），物化票把「应用内容条目」做成出厂能力挂同一接缝。存档加载**不走** createObject——恢复是重放树不是创建（M2-T5 已落：`restoreWorld` 重建树 → `attachEntity` 重挂实例，creation 两层不跑）。creation 无否决语义（只有播种顺序），失败＝wiring 抛错。
- **动态 cmdset `assembleSources`**（`packages/core/src/world/cmdset.ts`，§7 第 9 项，等价 Evennia `at_cmdset_get`）：宿主组装基准源（内容命令＋本房出口）→ 过**实体的 `at_cmdset_get`**（语境：实体活状态 flags/location 的**拷贝**——只读不写，状态变化是效果系统的事，本缝只反应）→ 返回调整后源（过滤／增补／重排：静默滤动词、赋能加命令）。**时机即契约**：源**逐分发**重组、引擎零缓存（Evennia `_CMDSET_MERGE_CACHE` 是已记录的坑，spec/08）——实体状态变化（往树里写个 flag）→ 下一次分发的可用动作集即变，无需任何 API 调用或事件。void 返回＝基准源**原引用**透传（无 hook 实体零成本）。分工：宿主组基准、`at_cmdset_get` 调整、`mergeCmdSets`（command/cmdset.ts 纯合并）折叠——assemble 是「实体状态驱动的组装」，feed merge。
- **测试**：`tests/entity-seams.test.ts`（全合成：三缝 hook 全链次序／三 pre 各自显式 false 否决与 void 放行／容器否决透传且 post 不跑／默认 announce 带 moveType 的三接收者事件／give 三方、drop 到丢者位置、响亮失败；creation 两层次序／JSON 赢过代码默认值／未覆盖处保留默认值／注册即查询可见／hook 可发事件／无 hook 正常／非法位置抛；cmdset 语境供给（基准源＋活状态）／**状态变化下一次 dispatch 即变**（invalid:unknownVerb → 恢复）／hook 可增源不只滤／无 hook 原引用透传／确定性／未知实体抛）。

### 命名约定（照抄，高度一致且好用）

| 前缀 | 含义 |
|---|---|
| `at_*` | hook |
| `at_pre_*` | **可否决**（返回**显式 `false`** 中止；void 副作用返回＝继续——与管线 `at_pre_cmd` 同律，防 Evennia「真值静默跳过」坑） |
| `at_post_*` | 事后通知 |
| `announce_*` | 广播文本专用 hook |
| `return_*` | **返回数据给调用者，不发消息** |
| `basetype_*` | 引擎内部一次性装配，不覆盖 |

依据：ADR-0025 §五

## 8. 自检清单

- [x] 房间四要素齐全（出口图 / 描述 / 放置清单 / 规则）——M1-T6 已落：schema 承载四要素（规则 = 房间 `preconditions`（enter）+ 出口门禁），首批内容全部具实
- [x] 出口是独立实体，方向词是它的命令（M1-T6 已落：`ExitEntry extends CommandEntry`，`02-command-layer.md` §4.1）
- [x] 人物引用怪物数值，**没有复制**（M1-T6 已落：npcs schema 结构性禁止战斗数值字段，`monsterId` 引用经注册表校验）
- [ ] 标签**不带值**（形状 `{<维度>: [键…]}`，取值由维度表封闭、**由注册表**硬校验，schema 只管形状）；归属用字段不用目录分层
- [ ] `(维度, 键)` 倒排索引可跨内容批量查询（注册表 `byTag`，覆盖所有带 tags 的**实体**：条目 ＋ **出口**，id 升序混排）
- [ ] 内容条目侧 `tags` 与 `flags` 两层并存；`flags` 不进索引、不可批量查询
- [ ] 运行时实体有 `tags` 槽，`hasTag` 不再是桩；「自身 ∪ 内容条目」的并集接缝已就位（合成驱动）
- [ ] 原型合并：`attrs`/`tags` 互补，其余整体替换；合并后**字典序升序 + 去重**
- [ ] 展平在**加载期、注册表内**，顺序为 `id 去重 → 展平 → 引用完整性校验`
- [ ] `content:check` 有**原型环检测**；注册表展平时也防环（双保险）
- [ ] `prototypeKey` 不参与继承；展平结果**不含 `prototypeParent`**
- [x] 移动 hook 带 **`moveType`**——M2-T1 已落：`MOVE_TYPES` 五值枚举，`MoveInfo` 进每个 hook
- [x] 移动入口**不做权限检查**（外置）——M2-T1 已落：`moveTo` 零门禁；穿行适配器编排 traverse → enter → moveTo（ADR-0028 §3）
- [x] `return_appearance` **纯返回不发消息**——M2-T2 已落：`returnAppearance` 纯组装（静态在场直读 × 状态树占用），`at_look` 内做可见性（显式 `look` 门禁，缺省可见）
- [x] `at_msg_receive` **可否决 + `fromObj` 可空**——M2-T3 已落：`broadcastMessage` 逐接收者过筛（显式 false 仅屏蔽该接收者），`fromEntityId` 可空（系统消息路径有测试）
- [x] `at_pre_get/give/drop` pre 可否决 + post 配对——M2-T4 已落：三编排包 `moveTo` 外（`at_pre_*` 先于移动链、`at_post_*` 随后），逐缝测试在 `tests/entity-seams.test.ts`
- [x] `at_object_post_creation` 存在，让 JSON 赢过代码默认值——M2-T4 已落：`createObject` 两层（creation 默认值 → post 应用内容），顺序即契约（JSON 赢有测试）
- [x] 动态命令集时机（等价 `at_cmdset_get`）——M2-T4 已落：`assembleSources` 逐分发重组、零缓存，实体状态变化下一次分发即变（合成测试）
- [x] 消息**按接收者逐一遍历发射**（引擎侧）——M2-T1 已落：announce 逐接收者逐事件（`departed`／`arrived`，含移动者本人）；M2-T3：say 经 `broadcastMessage` 同律逐接收者（含说者，各过 `at_msg_receive`）；渲染层的按观者渲染仍是 spec/05 的事
