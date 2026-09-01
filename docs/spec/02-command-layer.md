# 02 · 命令层

> **状态**：§1 解析**已实现**（M1-T2：最长动词匹配 + `argForm` 声明式参数，`packages/core/src/command/parser.ts`）；§2 命令是内容**已实现**（M1-T5：`schemas/commands.schema.json` + `content/commands/` 首批条目 + `CommandEntry`／`commandSetSources`／`commandSpecFromEntry`（`packages/core/src/command/entry.ts`）+ `ContentRegistry`（`packages/core/src/content/registry.ts`））；§3 命令集合并**已实现**（M1-T4：多源合并栈 + 四种 mergetype，`packages/core/src/command/cmdset.ts`）；§4 出口即命令**已实现**（M1-T6：`ExitEntry extends CommandEntry`（`packages/core/src/world/entry.ts`）+ `schemas/rooms.schema.json` 出口子实体 + 首批内容经注册表走全链路）；§5 前置条件**已实现**（M1-T3：递归求值器 + 谓词注册表 + `schemas/condition.schema.json`，`packages/core/src/conditions.ts`）；其余（§6 玩家层别名、§7 意图、§8 IME）**待实现**。
> **依据**：ADR-0016 §2、ADR-0021 §1/§2/§4、ADR-0024 §1/§3、ADR-0022 §2（经 **ADR-0024 §8** 修正）、ADR-0025 §六。
> （注：ADR-0024 的 **§7 修正的是 ADR-0022 §3**（原型继承），**§8 修正的是 ADR-0022 §2**（条件表达式）。本文件只涉及后者。）

## 1. 解析：最长动词匹配（不分词）

### 1.1 为什么不能抄 Evennia

Evennia 的 `cmdparser.py` 只有 205 行，做的是 `strip → 空则 [] → startswith 前缀匹配`。引号、转义、`=` 切分、switch、通配符全在 `MuxCommand` 层，**靠空格分词**实现。

**中文没有空格。这条路走不通。**

### 1.2 我们的方案

1. 从输入串开头匹配**最长的已注册动词**
2. 余下部分**整体**作为参数串
3. 参数串的解析由命令条目的 `argForm` 声明，不是全局解析器

**别名按长度降序匹配（长优先）** —— 防「笑」吃掉「笑傲江湖」这类子串冲突。这条借自 Evennia（它的别名就是长度降序）。

**不引入分词库。** MUD 命令的语法空间是受限的，最长匹配更可预测、可测试。

### 1.3 中文消歧

Evennia 用 `name-N` 后缀（且其 docstring 写 `2-ball`、代码只认后缀，是文档与代码不一致）。中文改用「第 N 个 X」／「X·N」，作为 `argForm` 的取值枚举。

**已落地取值**（M1-T2，引擎类型 `ArgForm`）：`none`（无参数）／`text`（自由文本）／`target`（裸名，默认第 1 个）／`target-ordinal`（接受「第 N 个 X」）／`target-index`（接受「X·N」）。两个消歧形态均兼容裸名（序数默认 1）；序数接受阿拉伯数字（含全角）与中文数词（一～九十九、两＝2），零与百以上拒绝。解析产物是 `TargetRef { noun, ordinal }` ——**只做形态解析**，名词指向哪个实体由命令条目的目标解析规则决定（ADR-0016）。动词与参数串之间的空白（含全角空格）是分隔符语法，不计入参数串；参数串除首尾空白外**不再做任何切分**。

依据：ADR-0024 §1

## 2. 命令是内容

`content/commands/` 每条目一 JSON 文件。条目自带：
- `verbs[]`（中文 + 英文缩写并列，如 `["打","杀","attack","kill"]`）
- `argForm`（参数形态枚举）
- `cmdset`（归属哪个命令集）、`priority`、`mergetype`
- 前置条件（条件表达式）
- `err_*` 拒绝文案

**引擎自己不认识任何动词。** 加命令 = 加内容文件。

### 2.1 落地形态（M1-T5）

- **条目形态**（`schemas/commands.schema.json` ＝ 引擎 `CommandEntry` ＝ `docs/agents/content.md` 命令集合节，三处同步）：`id`（语义名，即分发键，文件名 = id）／`verbs[]`（中英并列）／`argForm`（§1.2 枚举）／`cmdset`＋`priority`＋`mergetype`（归属与合并规则）／`preconditions`（`condition.schema.json#/definitions/accessRules`）／`err_*` 拒绝文案。
- **`ContentRegistry`**（`packages/core/src/content/registry.ts`）：引擎读内容的唯一通道——宿主加载并解析 JSON 后交给它；加载时强制引用完整性（重复 id、未知 id 查询抛错，ADR-0003 分层：完整 Schema 校验归 `content:check`，注册表不做重复实现）。`commands` 按 id 升序，使下游装配跨进程确定（ADR-0024 §2）。
- **分组**（`commandSetSources`）：条目按 `cmdset` 折叠成合并源。合并规则属于集，不属于单条命令——同 cmdset 的条目 `priority`／`mergetype` 不一致即抛错。
- **装配**（`commandSpecFromEntry`）：`id`→`key`、`argForm`→解析段、`preconditions`→access 门禁。**询问的 accessType 由宿主传入**（词汇表是内容侧约定：命令 `use`，见 content.md），引擎只携带不拥有；条目带门禁而未给 accessType = 装配 bug，大声抛错。执行体（func）由宿主注入（效果管线落地前）。
- **首批条目**（`content/commands/`）：`cmd-look`（看/瞧/望/look/l，none）、`cmd-say`（说/喊/say，text）、`cmd-examine`（端详/打量/examine，target-ordinal）、`cmd-rest`（歇/歇息/rest，none + `not has_state wounded` 门禁 + `err_use` 文案）。加命令 = 加 JSON 文件，经 `call()` 全真实路径跑通（`packages/core/tests/commands-content.test.ts`）。

## 3. 命令集合并（cmdset merge stack）

可用命令**不是一张固定表**，而是每次输入时**多源合并**的结果（借自 Evennia 的 CmdSet）：

| 源 | 优先级 | 提供什么 |
|---|---|---|
| 会话 | −20 | 清屏、字体等客户端相关 |
| 玩家 | −10 | 别名、设置 |
| 角色 | 0 | 武功、装备、状态 |
| 携带物 | 0 | 「读 秘籍」等 |
| **所在地（房间）** | 0 | 「参拜 佛像」等 |
| 周围物件 | 0 | 「推开 窗」等 |
| **出口** | **+101** | 方向词，**永远可用** |

合并规则（每条命令集自带，全是内容字段）：
- `mergetype`：`Union`（默认）／ `Intersect` ／ `Replace` ／ `Remove`
- `priority`：整数，按优先级分组、组内两两合并，再按优先级升序合并

**为什么必须是内容而非引擎逻辑**：加一个「黑屋里 `look` 变摸黑」= 加一条命令集条目 + 一条 condition，引擎零改动。

依据：ADR-0021 §1

### 3.1 落地形态（M1-T4）

- **纯函数折叠**（`packages/core/src/command/cmdset.ts`）：`mergeCmdSets(sources)` 把各源按 `priority` **稳定升序排序**后自左向右折叠到**空累积器**上——「按优先级分组、组内两两合并、再按优先级升序合并」就是这个折叠；同优先级组内**输入顺序即合并顺序**，后者压前者。引擎无缓存、无源概念词汇、无魔法数（七个源槽位与 +101 都是内容侧约定）。
- **incoming 的 mergetype 生效**（借 Evennia：A 并入 B，A 的合并规则适用；同优先级时后来者胜）。空种子使四种算子**全然**（total）：单独一个 Remove／Intersect 集合过滤不到任何东西——它的命令是过滤清单，不是供给。
- **四种算子**：`Union`（默认；同键**整体替换** payload 含 verbs）／`Intersect`（只留双方共有的键，取 incoming 版本）／`Replace`（丢弃累积结果）／`Remove`（纯过滤器，不添加任何命令）。
- **合并顺序 = 最后引入顺序**：跨键动词冲突归**后合并者**所有——合并栈在到达分发前解决动词归属（`parser.ts` 的契约：`createVerbTable` 遇跨键同名动词会抛错，合并产物不再有歧义）。这就是出口源（+101，高于一切常规源）**永远可用**的机制：它最后合并，下方任何源都无法遮蔽或滤掉它的方向词。
- **接入解析器**：合并产物 `verbEntries()` 即动词表来源，是 `createVerbTable` 的直接输入（`deps.verbs`）；测试骨架新增 `cmdsets` 选项演示接入（与 `verbs` 互斥），真实宿主每次输入时按地点重组源列表后自行调用。确定性（ADR-0024 §2）：同一输入列表必得同一合并结果。

## 4. 出口即命令

出口**不是房间的一个字段，是独立实体**。它把自己注册成命令——「北」「n」「north」「往北走」都是它的 `verbs`。

- 门禁挂在出口上，**拒绝文案是内容字段**
- 中文 MUD 要点：方向词必须支持中文（北／南／东／西／上／下／进／出）与英文缩写并列

### 4.1 落地形态（M1-T6）

- **出口 = 命令 + 边**：引擎类型 `ExitEntry extends CommandEntry`（`packages/core/src/world/entry.ts`）——出口携带全套命令字段（verbs／argForm（恒 `none`）／cmdset／priority／mergetype／preconditions／`err_*`），另加 `direction`（边的方向标签，同房内唯一）与 `targetRoomId`。出口经**同一条装配路径**进入分发：`commandSetSources(exits)` 分组、`commandSpecFromEntry(exit, { accessType: "traverse", func })` 装配（穿行行为由宿主注入）。
- **「永远可用」是数据**：出口自声明 cmdset（本包约定 `exits`）与优先级（**+101**，高于一切常规源）——机制即 §3.1 的合并顺序（最后合并、无人能遮蔽），引擎零魔法数。
- **门禁与文案**：出口 `preconditions`（`condition.schema.json#/definitions/accessRules`）词汇表 **traverse**；拒绝时 `commandRefused` 事件带 `commandKey`（= 出口 id）+ `errKey`（`err_traverse`／`err_default`），渲染层经 `registry.exit(id)` 回头取文案——事件绝不含已渲染文本（§5.4）。
- **注册表完整性**（`packages/core/src/content/registry.ts`）：出口 id 全局唯一（重复抛错）、同房 direction 不得重复、`targetRoomId` 必须解析到已加载房间——悬空的边在加载期即败。
- **首批内容**：`content/rooms/` 柳青镇 4 房间（镇口→街市→客栈大堂→后院），大堂北出口带 `has_flag inn-lodger` 门禁 + `err_traverse` 文案，后院房间带 `default: false` 的 enter 门禁（缺省拒绝 + 住客例外，spec/03 §2 的「规则」要素实例）；全链路测试 `packages/core/tests/world-content.test.ts`（「北」/「n」/「north」/「往北走」均分发到出口命令；无旗标被拒、文案来自 JSON；低优先级 Remove 滤不掉方向词）。

依据：ADR-0021 §2、ADR-0024 记录

## 5. 前置条件：JSON 递归表达式

**不用字符串 DSL**（Evennia 的 lockstring 无法被 JSON Schema 校验，与 `content:check` 硬门禁冲突）。

每个节点**恰有一个键**——组合器（`all`/`any`/`not`）或谓词名；裸布尔是退化叶子。组合器子节点可再嵌组合器（§5.1）：

```json
{
  "any": [
    { "all": [ { "has_tag": "outdoors" }, { "attr_gte": ["strength", 50] } ] },
    { "not": [ { "has_state": "wounded" } ] }
  ]
}
```

（= 「在户外且力量≥50」或「未受伤」。ADR-0022 §2 早期示例的三键单对象形态已废——单键节点才使嵌套文法无歧义。）

### 5.1 ⚠️ 必须允许递归嵌套

Evennia 文法是**扁平**的 `f1 AND f2 OR f3`（优先级来自 Python：`and` 紧于 `or`）。若 `{all, any, not}` 只允许两层，**无法表达 `a AND b OR c`** —— 表达力反而更弱。

**必须允许 `all`/`any`/`not` 内部递归嵌套节点**（JSON Schema 用 `$ref` 自引用）。

### 5.2 外层结构

- **外层是 `Map<accessType, expr>` 并保留 `default`**（accessType 缺失时的返回值）。`default` 是**完整条件**：布尔即直白策略位（`false` = 缺省拒绝，最常用），也可是任意表达式（如「未声明的类型须有 member 旗标」）。

### 5.3 谓词是引擎能力，不是内容

谓词名（`attr_gte` / `has_tag` / `has_flag` / `has_state` / `in_location` / `has_martial`）**写死在 schema 里是允许的**——它们是引擎提供的能力，不是题材词。

### 5.4 `err_*` 是净增益

Evennia 的锁系统**根本没有** `err_*`（`access()` 只返回 bool；只有 Exit 的 `err_traverse` 是遍历失败处手工读的）。我们把它做成一等数据字段——**拒绝也是一种叙事**。

### 5.5 落地形态（M1-T3）

- **节点单键**：每个节点恰有一个键——组合器（`all`/`any`/`not`）或谓词名；裸布尔是退化叶子（某 accessType 直白放行/拒绝）。`not` 语义 = **无一为真**（单子节点即普通否定）。
- **求值器与注册表**（`packages/core/src/conditions.ts`）：`evaluateCondition(expr, subject, registry)` 纯函数递归求值；谓词求值**只走注册表**（`createPredicateRegistry`，重名抛错），内置六谓词读 `ConditionSubject` 主题中立侧面（`attr`/`hasTag`/`hasFlag`/`hasState`/`locationId`/`hasSkill`——引擎定义问题，内容/宿主回答答案）。宿主以 `deps.subjectOf` 从世界+actor 构造 subject，以 `deps.predicates` 注入扩展注册表。
- **管线接入**：`CommandSpec.access = { rules, accessType }` 在 `at_pre_cmd` **之前**求值（可用性先于情境否决）。拒绝产出 `rejected` + `commandRefused` 事件，事件只带语义（`commandKey`/`accessType`/`errKey`），渲染层按 `errKey` 读条目的 `err_*` 字段取文案——事件绝不含已渲染文本（spec/01 §5.1）。
- **schema**（`schemas/condition.schema.json`，draft-07 `$ref` 自引用）：根 = 单表达式（武功先修用）；`#/definitions/accessRules` = 门禁映射（commands/exits 用）。它是**被引用库**，不映射任何 content/ 集合，其合法性由 `packages/core/tests/conditions-schema.test.ts` 编译验证（含跨文件 `$ref` 消费者测试）。

依据：ADR-0022 §2、ADR-0024 §8、ADR-0025 记录

## 6. 别名：两层

| 层 | 归属 | 例子 |
|---|---|---|
| **内容层** | `commands[].verbs[]`，全局，所有人可用 | 「打」「杀」「attack」指向同一命令 |
| **玩家层** | 存档字段（nicks），个人自设，支持模板 | `alias 买 $1 = 从 掌柜 买 $1` |

**中文输入成本高于英文（尤其移动端），个人别名是刚需，不是锦上添花。**
依据：ADR-0021 §4

## 7. 意图（action dict）

一次动作的可序列化描述：`{ "key": "attack", "target": "mon-014" }`。

- 它**同时是存档格式与将来的网络格式**
- 意图与结算分离，中间那条边界就是这个结构

依据：ADR-0025 §六（借自 EvAdventure）

## 8. 自检清单

- [x] 解析器用**最长动词匹配**，没有引入分词库（M1-T2 已落，`parser.ts`）
- [x] 别名按**长度降序**匹配（M1-T2 已落：长度降序 + 字典序，跨进程稳定）
- [x] 引擎源码里搜不到任何动词（动词全在 `content/commands/`）——src 侧由 `engine-purity` 文法字符集守卫，内容侧 M1-T5 已落：动词经注册表→合并栈→动词表进入分发，引擎零动词
- [x] 命令集是**多源合并**，不是单表查询（M1-T4 已落：`cmdset.ts` 纯函数折叠，四种 mergetype，合并产物即动词表来源）
- [x] 出口是**独立实体**，方向词是它的 `verbs`，优先级最高（M1-T6 已落：`ExitEntry extends CommandEntry`，经同一合并栈与装配路径进入分发；+101 与 cmdset 名是内容数据，引擎零魔法数）
- [x] 条件表达式 schema **允许递归嵌套**（M1-T3 已落：`schemas/condition.schema.json`，`$ref` 自引用无深度限制）
- [x] 外层是 `Map<accessType, expr>` 且有 `default`（M1-T3 已落：`#/definitions/accessRules` + `checkAccess`）
- [x] 拒绝文案 `err_*` 是数据字段，不是引擎字符串（M1-T3 已落：事件携带 `errKey`，文案在条目数据，引擎零文案；M1-T5 首批条目含 `err_use` 实例）
- [x] 每条命令的 `verbs` 里中文与英文缩写并列（M1-T5 已落：首批条目全部并列，`commands-content.test.ts` 机械校验每条目中英双形）
- [ ] 别名两层（内容层 + 玩家层存档）——内容层已落（M1-T5 `verbs[]`），玩家层 nicks 待存档模型
- [ ] 输入组件处理 **IME 合成事件**：合成期间按 Enter 不提交半成品拼音（G3）
