# 03 · 世界模型

> **状态**：§1–§4 **内容侧已实现**（M1-T6：`schemas/rooms.schema.json` + `schemas/npcs.schema.json` + 首批内容（柳青镇 4 房间／3 人物／1 怪物）+ 引擎类型 `RoomEntry`／`ExitEntry`／`NpcEntry`（`packages/core/src/world/entry.ts`）+ 注册表加载期引用完整性 + 出口即命令全链路）；**§7 实体 hook 运行时已实现（M2-T1：`Entity` 接口 + 移动族 8 hook + `moveTo` + 引擎出厂穿行适配器 + 状态树种子，见 §7.3；M2-T2：`return_appearance` 纯组装 + `at_look` 可见性 + look 出厂适配器，见 §7.5）**；§5–§6（标签运行时、原型继承）**待实现**＝**M3**。形态定案见 §4.2（ADR-0028）。
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

- 标签 **key + category**，**不带值**（需要带值用属性）
- Evennia 的 tag `data` 是**全局的、最后写入者赢**，是反模式
- 引擎维护 `(key, category)` 倒排索引，支持跨内容批量查询（「所有带 `outdoors` 的房间施加天气」）
- **归属字段化，不做目录分层**（`zoneId` / `sectId` / `regionId`）

依据：ADR-0008、ADR-0021 §5、ADR-0025 §二

## 6. 原型继承

条目可带 `prototypeKey` 与多亲 `prototypeParent`（左→右优先，自身 > 最右父 > … > 最左父）。

**合并规则**：
- **只有 `attrs` 与 `tags` 互补合并**（同 key + category 才覆盖），其余键**整体替换**
- 这条已被 Evennia 源码确认是对的

**三处必须补的（否则会踩坑）**：

| 项 | 说明 |
|---|---|
| **归一化** | Evennia 在合并**前**跑 `homogenize_prototype`：`aliases` 强制成 list、tags 补 3 元组、attrs 补 4 元组、`None` → `[]`/`""`。我们的 JSON Schema **必须就要求规范形态** |
| **环检测** | Evennia 源码明说「we don't check for infinite recursion here」。**`content:check` 必须加原型环检测** |
| **`prototypeKey` 禁止继承** | Evennia 用 `uninherited` 强制回写，子体若无该键会被覆盖成 `None` |

⚠️ **动态值**：Evennia 的 protfunc（`$random()`）**违反确定性**——改为种子化白名单求值节点。
⚠️ 合并非纯函数（原地改 dict），我们要保证**可复现的输出顺序**。

依据：ADR-0022 §3、ADR-0024 §7

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
- **`WorldRuntime`**（`packages/core/src/world/runtime.ts`）：ContentRegistry ＋ 状态树 ＋ hook 载体实例三合一；`occupantsOf` 按 id 升序（确定性）；`subjectOf` 从树状态构造条件主题（flags/location 真实回答，未落地槽位答「无」）。
- **穿行适配器 `traversalSpec`**（`packages/core/src/world/traverse.ts`，引擎出厂，ADR-0028 §3）：出口 traverse 门禁（管线 access 段）→ 目标房 enter 门禁（`checkAccess`，事件带 `roomId` 定位房间文案）→ `moveTo("traverse")`。两道门禁拒绝均 `rejected` ＋ `commandRefused` 语义事件；执行段拒绝通道见 spec/02 §4.1。
- **测试**：`tests/entity-move.test.ts`（合成内容：hook 次序／三否决点／零门禁／逐接收者／状态树／响亮失败）＋ `tests/traversal-chain.test.ts`（真实内容：柳青镇全链路、第二假玩家多接收者、异房不收、两道门禁文案来自 JSON、确定性重放）。

### 7.5 落地形态（M2-T2：看）

- **`returnAppearance`**（`packages/core/src/world/look.ts`）：`return_*` 律——纯返回、零消息、零写入。外观组装 = 房名／长描述（注册表内容读）＋ 出口清单（id／方向／verbs）＋ 静态在场（放置清单**直读**，ADR-0028 §1）＋ 动态占用（`occupantsOf` 升序、**剔除观者**——「看」回答观者周围有谁，不回答观者自己）。它是静态在场与动态占用两条在场通道的**唯一汇合点**（宿主可直接消费：房间面板）。
- **`atLook`**：可见性检查在**这里**，不在命令里（§7 第 6 项）。房间 preconditions 可声明**显式** `look` 键（感知该房间是否有条件——黑暗、幻象）；**缺省即对在场者可见，`default` 不管辖 look**——default 表达进入策略，若回填 look，每个缺省拒绝的房间都会对自己的住客变黑（Evennia 的 view 锁同样是「不声明即开放」）。拒绝返回 `errKey`（= `err_look`），不发事件；房间集合的 accessType 词汇表由此扩为 `enter`／`look`（与出口 `traverse` 同类：集合固定词汇，非题材词）。
- **`lookSpec` 出厂适配器**（ADR-0028 §2）：`cmd-look` 内容条目经 `commandSpecFromEntry` 绑定引擎行为（argForm 非 none 的大声抛错——带参的看是另一种行为），`call()` 全链路。可见 → 向观者发**一条** `appearance` 语义事件：roomId／出口清单／静态在场清单／动态占用清单——房名、长描述、实体名字全部留在内容数据（渲染层按 id 经注册表取，与 `err_*` 文案同律），事件零已渲染文本（spec/01 §5.1）；人称立场（你／他）归渲染层；look 是观者的私有感知，同房他人不收事件（与移动播报相反）。不可见 → `rejected`（seq 已消耗）+ `commandRefused` 事件（`reason: "notVisible"`——与门禁拒绝的 `accessDenied` 分立，感知失败与准入拒绝是两类玩家体验；`commandKey`／`accessType: "look"`／`errKey`／`roomId` 定位文案）。
- **测试**：`tests/look-behavior.test.ts`（真实内容：大堂双假玩家 + 掌柜的放置；后院孙彪（放置）与假玩家（状态树）同场——汇合点；`look` 英文动词走同一分发；合成遮蔽房（无灯不可见、执灯可见、同一会话内揭幕）；`default: false` 不使房间对住客变黑；零文本断言（事件串不含房名／描述／NPC 名／`err_look` 文案）；确定性重放）。

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
- [ ] 标签**不带值**；归属用字段不用目录分层（schema 侧随各集合落地时执行；`(key, category)` 倒排索引是运行时能力，待实体系统）
- [ ] 原型合并：`attrs`/`tags` 互补，其余整体替换
- [ ] `content:check` 有**原型环检测**
- [ ] `prototypeKey` 不参与继承
- [x] 移动 hook 带 **`moveType`**——M2-T1 已落：`MOVE_TYPES` 五值枚举，`MoveInfo` 进每个 hook
- [x] 移动入口**不做权限检查**（外置）——M2-T1 已落：`moveTo` 零门禁；穿行适配器编排 traverse → enter → moveTo（ADR-0028 §3）
- [x] `return_appearance` **纯返回不发消息**——M2-T2 已落：`returnAppearance` 纯组装（静态在场直读 × 状态树占用），`at_look` 内做可见性（显式 `look` 门禁，缺省可见）
- [ ] `at_object_post_creation` 存在，让 JSON 赢过代码默认值
- [x] 消息**按接收者逐一遍历发射**（引擎侧）——M2-T1 已落：announce 逐接收者逐事件（`departed`／`arrived`，含移动者本人）；渲染层的按观者渲染仍是 spec/05 的事
