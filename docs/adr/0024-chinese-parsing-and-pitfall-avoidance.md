# 中文解析与避坑：自研命令解析器、确定性检查清单、原型与条件的边界修正

**第四批 Evennia 借鉴（源码级）**。核心结论是：**有些东西不能抄**。Evennia 的解析器按空格分词，中文没有空格；它的 `.call()` 有三处真实缺陷；它的 CJK 支持几乎不存在。本文同时修正 ADR-0022 的原型与条件表达式设计。

> **来源**：`evennia/commands/cmdparser.py`、`commands/command.py`、`commands/cmdhandler.py`、`commands/cmdsethandler.py`、`utils/test_resources.py`、`prototypes/spawner.py`、`prototypes/prototypes.py`、`locks/lockfuncs.py`、`locks/lockhandler.py`、`utils/evmore.py`、`utils/ansi.py`、`utils/utils.py`（`display_len`）、`game_template/`。

## Context

前三批借鉴的都是在文档层就能看清的抽象。第四批下到源码，发现四类问题：

1. **Evennia 的命令解析器依赖空格**——中文命令没有空格，抄不了。
2. **`.call()` 的实现有三处真缺陷**，朴素移植会把 bug 一起搬过来。
3. **CJK 支持几乎不存在**：全仓只有一个 24 行的 `display_len()`，而且**几乎没有被调用**。
4. **原型的合并与条件的表达力**有源码级细节，我们的简化规则会在这几处出错。

## Decision

### 1. 命令解析器必须自研：改用最长动词匹配

Evennia 的 `cmdparser.py` 只有 205 行，做的是：`strip` → 空则 `[]` → **`startswith` 前缀匹配**。它明确**不做**引号、转义、`=` 切分、switch、通配符、`all`——这些全在 `MuxCommand` 层，**靠空格分词**实现。

**中文没有空格，这条路走不通。** 改为：

- **最长动词匹配**：从输入串开头匹配**最长的已注册动词**，其余部分整体作为参数串。（这条借鉴 Evennia 的别名按长度降序匹配——长优先，防止「笑」吃掉「笑傲江湖」这种子串冲突。）
- **参数串的解析由命令条目自己声明**（`commands[].argForm`），不是全局解析器。引擎只做「切出动词 + 交出余串」。
- **中文消歧**：Evennia 用 `name-N` 后缀（且其 docstring 写 `2-ball`、代码只认后缀，是文档与代码不一致）。中文改用「第 N 个 X」／「X·N」形式，写进 `argForm` 的取值枚举。
- **不引入分词库**：MUD 命令的语法空间是受限的，最长动词匹配 + 声明式参数形态足够，且比分词更可预测、可测试。

### 2. 确定性检查清单（测试骨架必带）

从 Evennia 源码里提取的**非确定性来源**，测试环境必须逐条封死：

| 来源 | Evennia 的做法／问题 | 我们的处理 |
|---|---|---|
| 时间 | `utils.delay` 用墙钟 | 注入 `Clock`；**延时回调队列也必须走注入时钟**，否则战斗回合顺序仍不确定 |
| 延时回调 | `deferLater(reactor, …)` | 同上，做成显式的待处理事件队列 |
| 全局缓存 | `_PARSE_CACHE`／`_CMDSET_MERGE_CACHE`／`_COMMAND_NESTING` 多处 | 每个用例结束后**显式清全部缓存**，不只是对象缓存 |
| 缓存键 | `_CMDSET_MERGE_CACHE` 用 `id(cset)` 做键，**无失效逻辑**，对象回收后 id 复用会返回陈旧结果 | **禁止用对象标识做缓存键**；改用内容哈希 + 显式失效 |
| 集合迭代顺序 | 大量 `list(set(...))`，Python 字符串哈希受 `PYTHONHASHSEED` 随机化影响，等长别名的相对顺序跨进程不稳定 | 所有排序**显式化**（长度降序 + 字典序），并让 schema 校验能覆盖 |
| 自增 ID | 测试断言里出现 `#1`，顺序相关 | ID 计数器每个用例重置 |
| 世界回滚 | 靠 Django 事务回滚 | **自己深拷贝／重建 fixture**，无 IO |
| 随机 | 无种子 | 注入 `Rng`，种子进存档（ADR-0023 §1d） |

### 3. 不要照抄 `.call()` 的三处实现缺陷

Evennia 的 `test_resources.py` 里：

- **输入队列用 `pop()` 从尾部取**（`test_resources.py:468`）——多元素时顺序是反的；且 `ret = ret.send(inp)` 把生成器变量覆盖成了 yield 出来的值，第二轮 `next(ret)` 直接崩。全仓库**没有任何多元素 inputs 的测试**，即这条路径实际只支持 0/1 个输入。**我们用队列 `shift()`，且只 `send` 不重赋值。**
- **`at_pre_cmd` 返回真值会静默跳过整段**（`:460`），`at_post_cmd` 也不跑。语义是"中止"，但没有任何记录——**测试会绿着通过却什么都没执行**。我们改为返回显式的 `aborted` 标志并断言。
- **无条件的正则 `_RE_STRIP_EVMENU`**（`:52`）会吃掉以 `| `／`--`／`+` 开头的正文行。中文武侠文本若用这类符号做装饰会被破坏。**我们不做无条件剥离。**

另有两条要补的（已并入 ADR-0023 §1e/§1f）：**必须同时断言消息条数**（前缀匹配会漏掉多吐的错消息）；**多接收者必须显式列出**（战斗播报是多目标的，漏列等于漏检）。

### 4. CJK 显示宽度：范围比预想大

Evennia 全仓唯一的宽度感知代码是 `utils/utils.py` 的 `display_len()`（约 24 行）：用 `east_asian_width`，`W`/`F` 记 2、其余记 1。它：

- **不处理**组合符与变体选择符（应记 0）、emoji ZWJ 序列、控制字符；
- **几乎没有被调用**——`evmore.py`、`ansi.py`、`text2html.py`、`evmenu.py` 全部没用它，`wrap()`/`crop()`/`pad()`/`justify()` 都是字符计数。

**两条推论**：

1. 我们要写的**不止是 wcwidth 函数**，还要覆盖零宽与组合符；
2. **必须把它注入切块器本身**——Evennia 正是漏了这一步（它的 `evmore` 纯按行数切，`justify=True` 时用裸 `len(line)`）。

### 5. 输出分块要重放未闭合的样式 span

`ANSIString` 是这轮唯一值得照搬的**机制**（不是它的 ANSI 语法）：维护 token 数组 + 平行的「可见字符索引」；切块时把可见偏移反查回 `(token_index, intra_offset)`，并在每个分块首尾**重开所有未闭合的 style span / 补闭合**（Evennia 的规则是"重放切片区间内被打断的转义码"）。

这条直接适用于 ADR-0018 的 `OutputLine` 分块与小程序端的缓冲上限裁剪。

### 6. 命令实例每次 dispatch 新建，不复用

Evennia 的 `Command` 实例**跨调用复用**（`command.py:40-42`：实例上的 kwarg 会残留给后续使用；`retain_instance` 在多人下会 cross-talk）。我们**每次 dispatch 构造新实例**，避免隐式状态。

## 修正：ADR-0022 的两处设计

### 7. 原型继承的三处修正

源码确认：递归遍历 `prototype_parent`（左→右），**只有 `attrs` 与 `tags` 有专用合并器**，其余键一律整体替换——**我们的规则是对的**。但有三处会踩坑：

1. **归一化步骤不能省**。Evennia 在合并**前**先跑 `homogenize_prototype`：`aliases` 强制成 list、tags 补成 3 元组、attrs 补成 4 元组、`None` → `[]`/`""`、非保留键收进 attrs。**我们的 JSON Schema 必须就要求规范形态**（或在加载时做等价归一化），否则合并语义不明确。
2. **必须自己做环检测**。源码明确写着「we don't check for infinite recursion here」。**`content:check` 要加原型环检测。**
3. **`prototypeKey` 禁止继承**。Evennia 用 `uninherited` 强制回写，子体若无该键会被覆盖成 `None`。我们直接禁止继承它。
4. 附带：合并**不是纯函数**（原地改 dict），attrs/tags 输出顺序 = 插入顺序。我们要保证可复现的输出顺序。

### 8. 条件表达式必须允许递归嵌套

Evennia 的 lockstring 文法是**扁平**的 `f1 AND f2 OR f3`（优先级来自 Python：`and` 紧于 `or`）。我们的 `{all, any, not}` 若只允许两层，**无法表达 `a AND b OR c`**。

- **必须允许 `all` / `any` / `not` 内部递归嵌套节点**，否则表达力反而低于 lockstring。
- **外层是 `Map<accessType, expr>`**（对应 lockstring 的分号分段：`edit:…; use:…`）。
- **保留 `default`**（accessType 缺失时的返回值）。
- **`err_*` 是新增能力，不是损失**：Evennia 的锁系统**根本没有** `err_*`（`access()` 只返回 bool；只有 Exit 的 `err_traverse` 是在遍历失败处手工读取的）。我们把它做成一等数据字段，是净增益。

## 记录：项目结构与扩展点

- **引擎永不直接 import 内容**。Evennia 把内容（`world/`）作为兄弟包，靠 settings 里的**字符串路径**注册（`PROTOTYPE_MODULES`、`FILE_HELP_ENTRY_MODULES`）。这与我们的 `content/` + Registry 同构。
- **settings 用「只覆盖要改的」模式**，不复制默认值——避免锁死上游更新。
- Evennia `game_template/server/conf/` 有 15 个扩展点。我们对应的需要：**谓词注册表**（≈lockfuncs）、**解析器**（必须可替换）、**同名消歧**（≈at_search）、**UI→引擎输入**（≈inputfuncs）、**生命周期钩子**（≈at_server_startstop）。可跳过：mssp、serversession、web_plugins。
- ⚠️ 它那 15 个扩展点里有 **4 个「发货即禁用」**（at_search / cmdparser / serversession / inlinefuncs），新手改了不生效。**我们的扩展点要么默认启用，要么在文档里写清楚如何启用。**

## 记录：Evennia 自己的坑（我们不做同样的事）

| 坑 | 说明 |
|---|---|
| EvMenu 对断线／超时**零处理** | 菜单对象会一直挂在 `ndb` 上泄漏 |
| `text2html` 有注入面 | 不转义引号（属性注入）、`convert_urls` 只转第一个 URL 就 return、inverse+双 truecolor 分支会 `UnboundLocalError` |
| `lockfuncs.py` 里 `objtag` **定义了两次** | 后者覆盖前者——死代码／真 bug |
| spawner 的 `exec` 列表可执行任意代码 | 我们禁（ADR-0022 §3） |
| `cache_lock_bypass` 有陈旧风险 | 源码自己注明「账号分配给角色后需重跑」 |
| `_CMDSET_MERGE_CACHE` 无失效逻辑 | 见 §2 |

## Consequences

- **M1 新增工作量**：自研中文解析器（最长动词匹配 + 声明式参数形态）。这是不可避免的——英文 MUD 的分词假设在中文下不成立。
- **`content:check` 新增一项**：原型继承环检测。
- **条件表达式的 JSON Schema 改为递归结构**（`$ref` 自引用），比两层结构复杂，但换来等价表达力。
- **测试骨架要带 §2 的完整检查清单**，否则确定性会在看不见的地方漏掉。
- **CJK 宽度函数 + 注入切块器**，且要覆盖零宽与组合符，不只是 W/F。
