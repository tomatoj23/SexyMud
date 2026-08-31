# 内容层运行时契约：状态持久化边界、JSON 条件表达式、原型继承、按需时间推进

**第二批 Evennia 借鉴**，解决四个「内容如何与运行时相处」的问题：什么进存档、条件怎么声明、变体怎么复用、时间怎么推进。这些是 ADR-0016/0021 定下命令层与世界模型之后的**下一层地基**。

> **来源**：`D:\My_Projects\evennia-main`（Evennia）的 Attributes / Locks / Prototypes / Tags / Scripts / TickerHandler / OnDemandHandler / Exits / Objects / Help-System 等文档。**只取抽象，不取技术栈。**

## Context

ADR-0016 定了命令层与世界模型，ADR-0021 补了命令集合并与视角，但四个问题悬空：

1. **什么该进存档？** 存档一旦混入渲染缓存与会话态，ADR-0017 的「确定性 + 将来搬服务端」就会被污染。
2. **条件怎么声明？** 命令的可用性、出口的门禁、武功的学习前置——ADR-0016 只说了「前置条件是数据」，没说数据长什么样。
3. **内容变体怎么复用？** 「灰皮哥布林」「持矛萨满」这类组合会爆炸成笛卡尔积。
4. **时间怎么推进？** ADR-0016 定了心跳，但没定状态是「每 tick 遍历」还是「按需求值」。

## Decision

### 1. 状态持久化二分：只有 `db` 进存档

借鉴 Evennia 的 `.db` / `.ndb` 双命名空间，用**命名前缀强制作者声明这份数据活多久**：

| 命名空间 | 语义 | 是否进存档 |
|---|---|---|
| `db.*` | 持久状态：角色、资源、武功等级、物品、进度 | ✅ 进 JSON 存档，纳入版本化迁移链 |
| `ndb.*` | 非持久状态：渲染缓存、当前会话、已展开的文本、UI 态 | ❌ **绝不进存档**，重启即失 |

- **理由**：这条直接支撑 ADR-0017 的确定性——存档里只有真状态，重放与对拍才有意义。
- **配套规则（来自 Evennia 的 `autocreate=False` 语义）**：**未显式写入的字段不得落盘**。改内容默认值时，既有存档自动跟随，不会被旧默认值污染。这对 JSON 内容的长期演进极有价值。
- **约束升级**：ADR-0017 的「禁 `Math.random()`／`Date.now()`」扩展到——**`ndb` 里的值不允许被任何游戏逻辑读取**，只能是呈现层的缓存。

### 2. 条件表达式用 JSON 数组，不用字符串 DSL

Evennia 的 lockstring（`"traverse: attr_gt(strength, 50) or perm(Builder)"`）是字符串，**无法被 JSON Schema 校验**，与本项目「内容必须过 `content:check`」的硬门禁冲突。因此：

```json
{ "all": [ {"has_tag": "outdoors"}, {"attr_gte": ["strength", 50]} ],
  "any": [ {"has_flag": "sectMember"} ],
  "not": [ {"has_state": "wounded"} ] }
```

- 谓词是**通用且主题中立**的：`attr_gte` / `has_tag` / `has_flag` / `has_state` / `in_location` / `has_martial`。引擎只实现这些谓词，具体条件全是数据（硬标准 1）。
- **拒绝文案是数据**：条件不满足时输出条目自带 `err_*` 文案（Evennia 的 `err_traverse`）。这与 xkx100 的 `valid_learn`（「你的玉女心法不熟练，无法练黯然销魂掌」）是同一条原则——**拒绝也是一种叙事**。
- 适用的三处：命令的可用性（ADR-0016 §2）、出口的门禁（ADR-0021 §2）、武功的学习前置（ADR-0019）。
- **单机阶段**：`perm()`（多人权限）退化为 `has_flag` / `has_tag`；联网时再引入权限谓词，**函数签名不变**。

### 3. 内容原型与继承：变体靠继承，不靠复制

借鉴 Evennia 的 Prototypes：条目可声明 `prototypeKey`，并通过 `prototypeParent`（可多亲，从左到右优先）继承，逐键覆盖。

- **合并规则**：`attrs` 与 `tags` 是**互补合并**（仅同 key + category 覆盖），其余键整体替换。这条要抄准——否则继承会退化成纯覆盖，失去意义。
- **动态值**：Evennia 用 protfunc（`$random()`）生成动态值，**违反 ADR-0017 的确定性，禁止**。改为**显式白名单求值节点 + 引擎注入的种子化 RNG**，RNG 状态进存档。
- **M1 可先只做单亲或不做继承**，但 `prototypeKey` / `prototypeParent` 两个字段**第一天就预留**——字段是零成本，事后加才是灾难。

### 4. 标签纪律：key + category，且不带值

- 标签**不带值**；需要带值的一律用属性。这条纪律必须写明，否则标签会被滥用成第二个属性系统。
- 引擎维护 (key, category) 的倒排索引，支持「对所有带 `outdoors` 的房间施加天气」这类**跨内容批量查询**。
- 与 ADR-0008「标记位代替特殊类型」、ADR-0021「Zone 用标签而非目录」一脉相承。

### 5. 时间推进：按需求值，不轮询

借鉴 Evennia 的 **OnDemandHandler** 而非 TickerHandler：

- 状态推进建模为**纯函数** `f(startTick, nowTick) → stage`，**只在被观察时求值**，不为每个对象挂定时器。
- 这与 ADR-0017 的确定性天然契合；**时间源必须是引擎 tick 计数，不是 `Date.now()`**（后者已被 ADR-0017 禁止）。
- TickerHandler 式的**订阅心跳**只保留给真正的全局事件（如每 N tick 刷新驻守敌人）。
- Evennia 的 Script（无游戏内存在、可挂定时器、可附着实体的状态容器）在本作里就是 JSON 的 `systems: [...]`，不需要代码类型。

### 6. 移动是叙事流钩子链

借鉴 Evennia 的 Exits 流程：`at_pre_move → at_pre_leave → announce_move_from → 移动 → announce_move_to → at_post_move`。

- 每个钩子都是**一次可插入的叙事输出点**，正好喂 ADR-0006 定的滚动文字流。
- 失败时回退到 `err_traverse` 字段，**拒绝文案是内容数据，不是引擎字符串**。

### 7. 展示模板由内容提供，引擎不带默认文案

借鉴 Objects 的 `appearance_template`（`{header}{name}{desc}{exits}{characters}{things}{footer}`）：房间展示 = 模板 + 可覆写的取字段钩子。

- ⚠️ **红线**：模板里的**默认文案必须留空、由内容提供**。否则「Exits:」「You see:」这类英文词会渗进引擎，直接违反硬标准 1。
- React 客户端渲染由组件负责，引擎只给模板占位符与字段值。

### 8. 输出行的两条安全原则

- **可点击命令只能来自引擎／内容侧，绝不能来自玩家输入**。Evennia 的 Clickable-Links（`|lc给土匪1000金|lt点击看我的身世|le`）演示了钓鱼攻击，在 React 里同样成立。
- **样式不得承载唯一信息**，且必须有**无样式回退**（Evennia Colors 的原则）。语义样式名（ADR-0018）同样适用。

## 记录：明确不借的

| Evennia 的 | 不借的理由 |
|---|---|
| **Typeclasses**（用 Python 类表达实体类型） | 与「全部数据为 JSON」直接对立。改用 JSON 的 `type` 字段 + 行为注册表 |
| **协议层 / OOB / Inputfuncs / GMCP** | 整层是 telnet/SSH 适配。唯一可偷的一格：`commandtuple = (name, args, kwargs)` 这个与传输无关的统一消息三元组——**命令上行用它，事件下行用 `{ type, payload }`，现在定死，搬服务端零改动** |
| **Accounts / Sessions / Puppeting** | 单机优先，无账号、无多会话、无 puppet 概念 |
| **Async-Process（Twisted 异步）** | 与「引擎完全确定性」矛盾 |
| **Inline-Functions / FuncParser**（`$func()` 内嵌脚本） | 无法被 JSON Schema 校验，且是通往软编码失控的路 |
| **Batch Code Processor**（执行任意 Python 构建世界） | 与三条硬标准全面冲突 |
| **EvMore / EvTable / EvEditor**（分页器、表格、行编辑器） | React 有原生能力，抄它们反而添乱 |
| **Channels / Msg** | 单机无意义；若日后多人，Msg 的 `senders/receivers/header/hide_from` 是干净模型，可回头抄 |

## Considered Options

- **照搬 lockstring 字符串条件**：被否——无法被 JSON Schema 校验，与 `content:check` 硬门禁冲突。改用 JSON 数组。
- **每 tick 遍历所有对象推进状态**：被否——O(n) 且把「未观察到的状态」也算了一遍，与按需求值的纯函数模型相比无优势。
- **全量继承（attrs/tags 也整体覆盖）**：被否——失去「补一条标签」的能力，继承退化成复制。
- **用 Typeclasses 那样的代码类型表达实体**：被否——硬标准 1。

## Consequences

- **存档契约收紧**：`ndb` 前缀是硬约束，写进引擎纯度测试的检查项（逻辑层不得读取 `ndb`）。
- **引擎新增两个通用件**：条件谓词求值器（约 6~8 个谓词）、原型继承解析器。**都是主题中立的通用代码**。
- **schema 需补字段**：`prototypeKey` / `prototypeParent` / `err_*` 文案字段 / 条件表达式的 JSON Schema（`{all,any,not}` + 谓词白名单，schema 写死谓词名是允许的——谓词是引擎能力，不是内容）。
- **ADR-0017 的确定性要求扩展到求值节点**：原型里的动态值也必须种子化、可重放。
- **图鉴 / 帮助系统**（借鉴 Evennia Help-System 的子主题与模糊搜索）：武学、门派、人物的百科是内容驱动 JSON 的完美用例。**中文模糊匹配需自建**（Lunr 对中文不友好，用子串 + 拼音首字母索引）。这条是内容设计，不是引擎决策，随 `content/` 落地时做。
