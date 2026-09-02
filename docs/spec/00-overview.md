# 00 · 总览

> **本目录是「活规格」（living spec），不是决策日志。** ADR 记录「当时为什么这么定」（历史，追加不改）；本目录记录「**当前系统是什么**」（现状，随时更新）。两者冲突时，**以本目录为准** —— 因为 ADR 之间的覆盖关系是网状的，而本目录是收敛后的结果。
> 每条规格都标注**状态**（待实现 / 已实现）与**依据**（指向 ADR）。

## 一句话定位

**中文优先（Chinese-first）的确定性文字 MUD 引擎**，武侠是它装载的第一套内容包。

## 三条支柱

| 支柱 | 含义 | 为什么是差异化 |
|---|---|---|
| **中文是一等公民** | 中文的输入、显示、叙事、检索不是适配层，是设计起点 | Evennia 的 CJK 支持只有 24 行且几乎没被调用；xkx100 有中文实践但无工程抽象 |
| **确定性** | 禁 `Math.random()`／`Date.now()`／定时器；时间走注入的 tick 计数，随机走注入的种子 | 两个参照物**结构上做不到**（Evennia 全栈墙钟 + 异步） |
| **内容即数据** | 全部 JSON + JSON Schema 硬门禁；引擎零题材词、零硬编码数量 | Evennia 是「代码 + DB」，xkx100 是「LPC 文件即一切」 |

## 能力光谱与扩展模型

### 光谱两端

| | 内容 |
|---|---|
| **最小 MUD**（不可再精简） | 有房间与出口、能移动、能看描述、有实体、命令进 → 文本出 |
| **复杂 MUD**（接近承载上限） | 上述 + 战斗 + 武学技能 + 经济 + 生产 + 任务剧情 + NPC AI/对话 + 派系声望 + 时间季节 + 天气 + 玩家组织 + 领地 + PvP + 排行榜成就 + 权限工具 |

Evennia 自己承认它的默认状态就是最小端——「empty but fully functional social game」，建房间、走、聊天。**它刻意不做战斗，正是因为一旦做进核心就锁死用法。**

**关键观察**：这些东西的**组合是任意的**，但**地基是共用的**——都需要实体、命令、事件、状态、时间、持久化。所以真正的架构问题不是「要不要模块化」，而是**地基该有多厚**。

### 三层模型（不是「核心 + 插件」）

| 层 | 内容 | 可选性 |
|---|---|---|
| **内核** | 实体、位置与移动、命令、事件、时间、持久化 | **必需，且必须完备** |
| **契约**（六条） | 效果／条件／事件／状态／命令／时间 | 必需，**是模块化的真正载体** |
| **机制模块** | 战斗、经济、生产、任务、技能… | **可选** |

- **最小 MUD** = 内核 + 零个机制模块（它已经能玩：走、看、说）
- **复杂 MUD** = 内核 + N 个机制模块，模块间**通过契约交互，不互相 import**

### 内核要「完备」，不是「最小」

这个区分很要紧：

| | 含义 |
|---|---|
| **最小** | 能跑就行，缺的以后加 |
| **完备** | 该有的概念都有（**尤其 hook**），但每个做到最简 |

举例：移动的最小实现是 `go <方向>`；**完备但最简**的实现是「带 `moveType` 的原子操作 + 一组 hook」。后者不复杂，但 hook 让上层能挂东西；前者以后改起来要动所有调用点。

**内核的完备性体现在 hook 上，不体现在功能上** —— 见 `03-world-model.md` §7 那九项。

### 模块化的载体是**契约**，不是**切块**

| 做法 | 复杂度 |
|---|---|
| 把功能切成块，块间直接互调 | **N²** 调用网（每个模块都认识其他模块） |
| 用契约交互 | **N**（每个模块只认识契约） |

**战斗模块不需要 import 技能模块**：技能通过「效果契约」影响战斗数值，战斗通过「事件契约」通知技能（"命中了" → 加熟练度）。两者都不知道对方存在。

六条契约见 `01-engine-contract.md` §7。

### 现在不做插件系统

扩展靠**契约**，不靠插件加载器。理由与「何时该做」见 `08-non-goals.md` A7。
一句话：**先做对，再拆开**——而不是先拆开再填。

## 引擎 / 内容的边界

```
引擎（packages/core）              内容（content/）
─────────────────────             ──────────────
命令解析与合并        ←── 读取 ──   commands/（动词、别名、参数形态、前置）
世界模型与 hook       ←── 读取 ──   rooms/ npcs/ dungeon/ monster/
状态、时间、调度      ←── 读取 ──   config/（settings / policy / dimensions）
效果与条件求值        ←── 读取 ──   effects/ martial/ equipment/
事件流（纯语义 JSON） ──── 产出 ──→  （不产出文本）
                                   combat-text/（文本模板与词库）

宿主（apps/*）                     内容（content/）
──────────────                     ──────────────
渲染事件 → 文本 ────── 读取 ──→     combat-text/（模板 + 槽位 + 词库）
TerminalView 实现                   style-guide.md（文风约束）
```

**铁律**：引擎**永不 import 内容数据**，只通过 `ContentRegistry` 取。内容里的题材词（秘境／造诣／门派／练功）**不得出现在引擎源码中**——由 `engine-purity` 测试强制。

## 三条验收标准（可测）

1. **题材中立**：引擎源码搜不到任何题材词。→ 已有纯度测试，**已达标**。
2. **换内容不改代码**：换一套非武侠内容包，引擎不改一行代码即可运行。→ **已机械验证**（`packages/core/tests/mini-content-pack.test.ts` + `packages/core/tests/fixtures/mini-pack/`：非武侠迷你包经**同一装配路径**跑通走／看／说，含门禁拒绝路径；柳青镇与迷你包两套夹具在同一测试文件族中共存且互不渗漏）。
3. **中文无损**：中文输入、显示、折行、检索在**所有端**（Web／小程序／APK）一致且正确。→ 待实现。

## 文档地图（怎么读）

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| `00-overview.md` | 本文 | 每次开工前 |
| `01-engine-contract.md` | 对外契约：端口、命令、事件、seq | 写引擎任何代码前 |
| `02-command-layer.md` | 命令层 | 做命令系统前 |
| `03-world-model.md` | 世界与实体 | 做世界系统前 |
| `04-state-and-time.md` | 状态、存档、时间、调度 | 做状态与时间前 |
| `05-output-pipeline.md` | 渲染与多端输出 | 做输出层前 |
| `06-content-schema.md` | 内容集合与 schema | 写任何内容条目前 |
| `07-chinese-layer.md` | 中文层摘要 | 涉及中文处理时 |
| **`08-non-goals.md`** | **明确不做的事** | **每次做设计决策前，必读** |

配套（非本目录）：
- `docs/adr/` — 决策历史（30 篇）
- `docs/chinese-mud-concerns.md` — 中文特有问题全景（35 条，5 条待定）
- `CONTEXT.md` — **武侠内容包**术语词典（作用域：内容层，不是引擎）
- `content/style-guide.md` — 叙事文风约束

## 当前状态（诚实版）

| 部分 | 状态 |
|---|---|
| monorepo、`content:check`、引擎纯度测试、存档迁移链骨架 | ✅ 可用 |
| `apps/web` React 壳 | ✅ 可用（占位，等待命令层） |
| 引擎领域模型（放置遗留） | ✅ **已清零**（`6a36674`） |
| **端口与契约**（Clock/Rng/SaveStore/Authority、Command、GameEvent、三类失败） | ✅ **已落**（`packages/core/src/types.ts`） |
| 命令测试骨架 + 最小分发管线（M1-T1） | ✅ **已落**（`packages/core/src/command/`） |
| 中文解析器：最长动词匹配 + `argForm`（M1-T2） | ✅ **已落**（`packages/core/src/command/parser.ts`） |
| 条件表达式：递归求值器 + 谓词注册表 + 门禁映射（M1-T3） | ✅ **已落**（`packages/core/src/conditions.ts` + `schemas/condition.schema.json`） |
| 命令集合并栈：多源合并 + 四种 mergetype（M1-T4） | ✅ **已落**（`packages/core/src/command/cmdset.ts`） |
| commands/ 内容集合 + `ContentRegistry`（M1-T5） | ✅ **已落**（`schemas/commands.schema.json` + `content/commands/` 首批 4 条 + `command/entry.ts` + `content/registry.ts`；加命令 = 加 JSON 文件） |
| rooms/ + npcs/ 世界集合 + 出口即命令（M1-T6） | ✅ **已落**（`schemas/rooms.schema.json` + `schemas/npcs.schema.json` + 柳青镇首批内容（4 房间／3 人物／1 怪物）+ `world/entry.ts`（`ExitEntry extends CommandEntry`）+ 注册表加载期引用完整性；「北」经合并栈→动词表→`call()` 全链路跑通，门禁拒绝文案来自内容 JSON） |
| 实体运行时 + 移动全链路（M2-T1） | ✅ **已落**（`Entity` 接口 + 移动族 8 hook + `moveType` 五值 + `moveTo`（零权限检查）+ `WorldRuntime` + 状态树种子（`state/tree.ts`）+ 引擎出厂穿行适配器 `traversalSpec`（traverse → enter → moveTo）；announce 逐接收者；柳青镇全链路含两道门禁拒绝路径，第二假玩家多接收者场景机械验证（`tests/entity-move.test.ts` + `tests/traversal-chain.test.ts`）；执行段拒绝通道 `CommandRejection` 进管线） |
| 看行为：`return_appearance` + `at_look` + look 出厂适配器（M2-T2） | ✅ **已落**（`world/look.ts`：纯外观组装——静态在场（放置清单直读）×动态占用（状态树）的唯一汇合点；可见性检查在 `atLook` 内——房间**显式** `look` 门禁（缺省可见，`default` 不管辖 look）；`lookSpec` 绑定 `cmd-look` 经 `call()` 全链路；`appearance` 事件＝roomId／出口清单／静态在场清单／动态占用清单，零已渲染文本；`tests/look-behavior.test.ts`） |
| 说行为：`at_msg_receive` + say 出厂适配器（M2-T3） | ✅ **已落**（`world/message.ts`：`broadcastMessage` 逐接收者投递原语——`at_msg_receive` 显式 false 仅屏蔽该接收者，`fromEntityId`（fromObj）可空（系统消息路径）；`world/say.ts`：`say` 编排（`at_pre_say` 可否决 → 广播（说者含在接收者内）→ `at_post_say`）+ `saySpec` 绑定 `cmd-say` 经 `call()` 全链路；`say` 事件＝speakerId／text／locationId，零已渲染文本，文本为玩家输入原样透传（会话数据非渲染叙事）；`tests/say-behavior.test.ts`） |
| 接缝补全：转移配对 + creation 两层 + 动态 cmdset（M2-T4） | ✅ **已落**（`world/transfer.ts`：`getObject`／`giveObject`／`dropObject`——`at_pre_get/give/drop` 行为级否决包 `moveTo` 外（先于移动链）+ `at_post_*` 配对，give 三方否决（被给实体＋给者＋收者），moveType 随播报；`world/creation.ts`：`createObject` 两层——`at_object_creation` 代码默认值 → `at_object_post_creation` JSON 内容覆盖，顺序即契约；`world/cmdset.ts`：`assembleSources`——`at_cmdset_get` 逐分发重组基准源（语境给防御拷贝，调整即返回），实体状态变化下一次分发动作集即变，引擎零缓存；全合成驱动 `tests/entity-seams.test.ts`，无物品系统依赖——首个真实消费者是物化票） |
| 快照 v1：状态树序列化 + 迁移链往返（M2-T5） | ✅ **已落**（`state/snapshot.ts`：`serializeWorld`／`restoreWorld`——载荷即状态树（非平行结构），只加版本戳／`derived` 切分／规范序（同世界＝同字节）；`state/derived.ts`：`derived` 一张表同时驱动快照类型与序列化排除，加载后逐实体 `recompute`（表今日为空，首个消费者＝修饰符系统）；`WorldRuntime.attachEntity`：**恢复＝重放树＋重挂实例，不走 `createObject`**（creation 两层不跑，否则代码默认值覆盖存档），挂载顺序无关、内容漂移大声失败；`SAVE_VERSION` 保持 1、迁移链机制就绪但为空；NPC **构造性不入档**（静态在场＝内容真相）；`tests/snapshot.test.ts`） |
| 非武侠迷你内容包：验收标准 2 首次机械化（M2-T6） | ✅ **已落**（`tests/fixtures/mini-pack/`：近轨灯塔站，3 房间／4 出口／2 命令／1 人物，方向词 前/后/内/外，`cmd-scan`（环视）绑 `lookSpec`、`cmd-broadcast`（通话）绑 `saySpec`、出口绑 `traversalSpec`——**引擎零改动**，换包只换目录 + 宿主的「命令 id → 出厂行为」绑定表；`tests/mini-content-pack.test.ts`：走／看／说全链路 + 主控室 enter 门禁拒绝（文案来自迷你包 JSON）+ 零武侠词 + 柳青镇/迷你包 id 空间不交、词汇互不渗漏；迷你包同样通过 `schemas/` 校验） |
| 标签与原型 · T1：四字段 schema 与类型落地（M3-T1） | ✅ **已落**（`schemas/common.schema.json` 是四个条目通用字段（`tags`／`flags`／`prototypeKey`／`prototypeParent`）的**唯一定义**，14 个条目集合统一 `$ref` 引用；引擎侧 `packages/core/src/content/entry.ts` 的 `EntryCommon`（各条目类型 `extends` 它）；`docs/agents/content.md` 同步——**三处同步**（spec/06 §4）。标签形状**只有一种** `{ <维度>: [<键>…] }`，`equipment` 词缀的裸 `string[]` 孤例已改齐；schema 只管**形状**（维度名 lowerCamelCase、键列表非空去重、四字段一律可选且只在**实体层**：条目带、出口也带，`objects[]` 放置清单项不带），取值封闭**（#15 已落）**与展平**（#16 已落）**。`tests/tags-prototype-schema.test.ts` 逐集合一条用例；既有 15 个内容文件一个 tags 都没写，全部照过） |
| 标签与原型 · T2：内容侧标签倒排索引 + 维度校验（M3-T2） | ✅ **已落**（`packages/core/src/content/registry.ts`：`createContentRegistry(content, options)` 内建 `(维度, 键)` 倒排索引 → **`byTag(维度, 键) → id[]`**，覆盖**所有带 tags 的实体**——四个集合的条目 **＋ 出口**（出口不在集合里，显式遍历 `exitsById`；出口 id 与条目 id 同空间、混排按 id 升序），结果 **id 升序、跨集合合并**；维度表由主机**可选**传入 `options.dimensions`——**传了就硬校验**（未知维度／越界键大声失败）、**没传就跳过**，`byTag` **不依赖**维度表；`flags` 不进索引。`tests/content-registry.test.ts` 合成条目驱动 11 例：跨集合合并、出口混排、一维度多键／一键多维度、空结果、`flags` 不可倒排、未知维度／越界键大声失败、没表时跳过、装载顺序无关）；follow-up：四个集合与出口的 id 收进**同一个唯一性空间**，跨集合重名在加载期大声失败（报错点名两侧类型），此前 `byTag` 会把重名的两个实体静默并成一行 |
| 标签与原型 · T3：原型展平（M3-T3） | ✅ **已落**（`packages/core/src/content/prototype.ts`：`flattenCollection` 展平器，由注册表在 **id 去重之后、引用完整性之前**按集合调用——继承来的 `exits`／放置清单／`monsterId` 与 `tags` 一样要过校验与索引；合并律＝`tags`／`attrs` 互补合并（合并后字典序升序 + 去重）、其余键整体替换，多亲左→右、自身最后；展平结果剥掉 `prototypeParent`、只留自身声明的 `prototypeKey` ⇒ 未声明者不可被继承；加载期大声失败四种：`prototypeKey` ≠ 本条目 id、跨集合引用、父未声明 `prototypeKey`、成环（菱形不是环）；**没有 `prototypeParent` 的条目原样穿过**——今天所有内容都是这一类。`tests/content-registry.test.ts` 合成条目驱动 17 例）。⚠️ 两处未落：`content:check` 的离线环检测尚无票认领；出口的 `prototype*` 仍无消费者（`rooms.schema.json` 把 `exits` 定为必填，故 schema 合法内容不会继承出口） |
| 输出管线、中文层其余部分，及状态模型余下部分（时间／调度＝ M4） | ❌ 未实现（规格已定，见各文件） |
| 14 个 schema | ⚠️ 放置期设计，需随本规格重估（`monster.schema.json` 已随 `mon-lq-001` 进入编译，重估仍未做）。**限定语**：`schemas/` 现共 **19 个** = 2 个被引用库（`condition`／`common`）+ 3 个新落集合（`commands`／`rooms`／`npcs`）+ `config` 三类 + **11 个**放置期集合；「14」= 19 − 2 库 − 3 新落（口径不同、数字都对，别去统一它们） |

**下一步**：~~M2 最小可玩世界运行时（走/看/说，六张 tracer 票，形态见 ADR-0028）~~（**六票全关**）→ **M3 标签与原型（spec/03 §5.1／§6.1）—— 设计已定案（ADR-0029／ADR-0030），已拆六票（#14–#19，规格快照 #13）；T1 四字段 schema 与类型落地（**#14 已关，3c4a470**）→ T2 内容侧标签（`byTag` 倒排索引 + 维度表硬校验，**#15 已关，2776306**）→ T3 原型展平（合并律／多亲优先级／环检测，**#16 已关，e83a064**）** → M4 时间与调度（spec/04 §2–§4，战斗前夜）。每完成一个子系统，跑该文件末尾的自检清单。

> 引擎源文件：`types.ts`（端口与契约）、`index.ts`（导出面）、`rng.ts`、`save/migrations.ts`、`command/pipeline.ts`（四段管线 + access 门禁）、`command/testing.ts`（测试骨架）、`command/parser.ts`（中文解析器）、`command/cmdset.ts`（命令集合并栈）、`command/entry.ts`（命令内容契约：条目 → 源 → spec）、`world/entry.ts`（世界内容契约：房间／出口／人物条目，出口即命令）、`content/registry.ts`（ContentRegistry）、`content/entry.ts`（条目通用字段契约：tags／flags／prototypeKey／prototypeParent，schema 侧对应 `schemas/common.schema.json`）、`content/prototype.ts`（加载期原型展平：合并律、多亲优先级、环检测）、`conditions.ts`（条件求值与谓词注册表）。这是刻意的——**先定契约，再长能力**。
