# 不能后补的地基：actorId 与事件契约、实体 hook 清单、调度原语集、输入加固

**第五批 Evennia 借鉴（源码级 + 完整示例游戏级）**。这一轮的目标不是找新特性，而是**找出哪些东西现在不做、将来就补不回来**。结论是九件事，其中四件属于「改一次要动所有调用点」的级别。

> **来源**：`evennia/objects/objects.py`（141KB 实体能力面）、`contrib/tutorials/evadventure/`（完整示例游戏）、`scripts/`（调度器）、`utils/gametime.py`、`server/session.py`+`serversession.py`、`typeclasses/attributes.py`+`tags.py`、`settings_default.py`（62KB 配置面）、`web/static/webclient/js/`、`utils/ansi.py`（输入加固）、110 个测试文件的分布。

## Context

前四批借鉴的都是抽象。这一轮读源码与一个完整示例游戏后，发现一类更贵的问题：**有些决定当下看是可选的，但将来改要动所有调用点**。典型如「命令里带不带 actorId」——不带的话，将来支持多角色/观战/回放时，每个 reducer 签名都要改。

## Decision

### 一、`Authority` 契约补强（修订 ADR-0017）

Evennia 为多连接付出的最大代价，是它**把连接状态和游戏状态存在同一个 Session 对象里**（`session.py:33-35` 自己承认「much of the same information must be stored in both places」）。我们只要守住三条，将来换 `RemoteAuthority` 时引擎一行都不用改。

**1. 每条命令必须携带 `actorId`（最贵的一项，今天做）**

不要依赖「当前角色」这种隐含上下文。Evennia 用 `puid` 做四级间接（`sessid → account → puid → puppet`），代价是 `at_sync` 里那条绕过所有 hook 与权限检查的静默重连分支。**我们今天就把 actor 显式化**，将来支持多角色、观战、回放都不用改接口。

**2. 事件侧也要有 `seq`，且 `CommandResult` 区分三类失败**

现在只有命令带 `seq`，结果侧没有——这样就做不了幂等去重与乱序重组。补：

| 失败类型 | 含义 | 是否消耗 seq | 重试语义 |
|---|---|---|---|
| `rejected` | 引擎**合法地**拒绝（内力不足、前置不满足） | **已消耗** | 不重试，作为事件返回给玩家 |
| `invalid` | 格式错误／无法解析 | 未消耗 | 不重试，报错 |
| `transport` | 未送达 | 未消耗 | **可重试** |

三类的重试语义完全不同，混在一起会让 `RemoteAuthority` 无法正确实现 ack/重传。

**3. `GameEvent` 绝不含已渲染文本**

Evennia 在线上传输的是**已渲染的字符串**（`data_out` 的 `text` 字段）。它为此付出了巨大的历史包袱：多端要各自解析 ANSI，本地化无从下手，多端适配锁死在转义码上。

**我们的 `GameEvent` 必须是纯语义 JSON**（谁、对谁、做了什么、结果档位），渲染推迟到 `TerminalView`。这条已经在 ADR-0006/0018 里定了，**此处只是确认：不要因为它"看起来更省事"而退回去。**

**4. 订阅回调收 `(events, meta)`，`meta` 含 seq 范围**——让 UI 能做间隙检测与重放。

### 二、不需要 attribute handler（修订 ADR-0022 §1）

Evennia 的 `AttributeHandler` 有**一千多行缓存机器**（`_cache` / `_catcache` / `_cache_complete` 三标志、`SaverMutable` 代理、后端抽象）。读完后结论是：**我们不需要它**。

那一整层是在为 **SQL ↔ Python 的阻抗失配**买单：隐藏 SQL、隐藏 pickle、惰性加载、可替换后端、嵌套可变体的原地写回。我们**四项都没有**——内存 JSON 快照、原生 JSON 值、整体驻留、无数据库。

我们该要的是四样：

1. **按 schema 定义的 typed 状态对象**（这就是「编译期 AttributeProperty」，且不可绕过——Evennia 自己在 `attributes.py:304` 抱怨过 `.db` 访问会绕过校验钩子）。
2. **版本化迁移链**——这是**我们相对 Evennia 的优势**：它的 `db_value` 是 pickle blob，永不迁移，只能靠 `swap_typeclass(clean_attributes=True)` 删光重来。
3. **加载时构建一次的内存倒排索引**，用于跨实体的反向查询（哪些 NPC 属于「青城派」）。不要运行时惰性查询 + 失效——快照整体在内存，**没有「陈旧」这个概念，缓存层纯属负债**。
4. **一个薄访问门面仅为可读性**，不承载任何缓存/失效职责。

**保留 `db`/`ndb` 的精神，丢弃它的 API**：明确区分「进快照的」与「派生的／可重算的」，后者标 `derived`，序列化时排除、加载后重算。但**不要给它一个长得一样、却会在重启时静默清空的 API**（`models.py:512` 那句「those would get lost!」就是判决）。

⚠️ **反模式警告**：tag 上的 `data` 字段是**全局的、最后写入者赢**（`tags.py:500-504`），因为 data 不参与唯一性约束。想给单个实体带值就用属性，不要用 tag 的 data。

### 三、调度最小原语集（修订 ADR-0022 §5）

读完四个调度器，答案是**六个原语，可砍到四个**：

| 原语 | 覆盖的需求 |
|---|---|
| **Clock**（唯一 tick 计数器） | 取代一切墙钟 |
| **纯 stage 求值** `f(startTick, nowTick, stages)` | 门几 tick 后重锁、作物 4 阶段、技能还有多久好 |
| **观察时补偿结算** | 毒每 3 tick 跳 5 次：`pulses = min(floor(dt/interval), 5) - applied` |
| **到期桶** `Map<dueTick, cb[]>` | 延迟爆炸等一次性事件 |
| **区域 tick**（`tick % interval === phase` 的分组订阅） | 天气、区域驻守刷新等**必须主动推送**的 |
| **on-change 钩子** | 字段变更触发，与 tick 完全解耦 |

**「观察时补偿结算」是本轮最妙的发现**：它把「每 3 tick 的定时器」**降级成纯函数**——不需要注册、不需要存储、不需要回调，只在被观察时一次性把欠的跳数补齐并写回 `applied`。

**明确不需要**：Script 实体、per-object timer、线程、async/await、任何墙钟。
⚠️ Evennia 的 OnDemand **自己也依赖墙钟**（`gametime.runtime()` 用 `time.time()`），且 `stage` 回调「**is not guaranteed to be called**」——我们改成纯函数后这两个问题都不存在。

### 四、游戏内时间 = tick 的纯函数（新增）

Evennia 的 gametime 极简：真实时间 × `TIME_FACTOR`。对我们来说，**时间缩放因子就是 tick 频率本身**，所以连这一层都不需要。

```
TICKS_PER_HOUR / TICKS_PER_DAY / DAYS_PER_YEAR   （常量）
hour     = floor((nowTick % TICKS_PER_DAY) / TICKS_PER_HOUR)
shichen  = ...                                    // 时辰
ke       = ...                                    // 刻（子时三刻 = (0, 3)）
season   = SEASONS[floor(nowTick / TICKS_PER_DAY) % DAYS_PER_YEAR]
nextDueTick(hour) = ...                           // 投进到期桶
```

- 全部是 `nowTick` 的**纯函数**，时间在渲染时推导，**绝不存储**。
- 房间描述与 NPC 在场判定做成 `(nowTick) => descKey` 的纯选择函数。
- ⚠️ **别抄 extended_room 的区间写法**：它的 `if start < end` 让跨年区间（winter `(1.0, 0.25)`）永远匹配不上，只是靠「遍历完返回最后一个键」侥幸正确。用**半开区间 + 显式排序数组**。

### 五、实体 hook：第一天必须定对的九项（最高优先级）

读完 `objects.py` 的 141KB，最有价值的是这份清单——这九项后期改造成本极高：

1. **移动三元组** `at_pre_move`（可否决）→ `announce_move_from` → `announce_move_to` + `at_post_move`，外加容器侧 `at_pre_object_leave/receive`。**必须带 `move_type` 字符串**（teleport / traverse / get / give / drop）——没有它，后期无法在同一条移动路径上分流叙事。
2. **`move_to` 不做权限检查**（`objects.py:1216` 明说）——锁检查外置，否则每个 hook 都得补一遍。
3. **消息渲染必须按接收者逐一遍历**。若做成「先渲染成字符串再群发」，中文的「你／他／她／它」与按观者的可见性差异**永远补不回来**。
4. **`at_msg_receive` 可否决 + `from_obj` 可为 None**——把「谁在听／谁能被屏蔽」做成一等公民。
5. **`return_appearance` 必须是纯返回、不发消息**。这是确定性引擎的核心边界。
6. **`at_look` 内部做可见性检查**，而不是在命令里。
7. **`at_pre_get/give/drop/say` 的 pre 可否决 + post 通知配对**——中文 MUD 的社交叙事全挂在这四个上。
8. **`at_object_creation` vs `at_object_post_creation` 两层**：前者是默认，后者让 JSON 内容覆盖默认值。**顺序错了，JSON 内容永远赢不了代码默认值。**
9. **`at_cmdset_get` 式的动态命令集**——Exit 靠它把自己变成命令（ADR-0021 §2 已定）。

命名约定照抄（高度一致且好用）：`at_*` = hook；`at_pre_*` = 可否决；`at_post_*` = 事后通知；`announce_*` = 广播文本专用；`return_*` = 返回数据不发消息；`basetype_*` = 引擎内部装配。

⚠️ **中文坑**：Evennia 的 `Character.normalize_name` **强制拉丁化**防冒充，源码自己承认「should be refactored to support i18n for non-latin names」。中文角色名的重名检查要另做。

### 六、动作意图用可序列化的 action dict（新增，来自 EvAdventure）

EvAdventure 的战斗动作是**纯数据的 dict**：`{"key": "attack", "target": X, "repeat": True}`，`CombatAction.__init__` 把 dict 的键 `setattr` 成属性。

**dict 同时就是序列化格式、存档格式、将来的网络格式。** 这条很值得抄：意图（intent）与执行（resolution）分离，中间那条边界就是一个可 JSON 化的结构。

### 七、规则集中在「可替换的单例服务对象」（新增，来自 EvAdventure）

EvAdventure 的规则**全部硬编码在 `rules.py`**，但它用了一个技巧：把纯函数打包进一个**可用继承替换的单例类**（`rules.py:19-25`），以此模拟「规则集可换」。

可迁移的思想是：**当你还没有数据驱动管线时，用「可替换的服务对象」代替「数据文件」**。我们有 JSON + Schema，所以规则常数应该进 `content/config/`；但**「规则引擎」本身仍应是一个可替换的对象**，而不是散落在各处的函数调用。

⚠️ 教训：EvAdventure 的隐含常数（`bonus + 10` 的那个 10、`d20 > 15` 的 15）**散落在调用点**。我们的 constant 必须收进一处常量表（§八）。

### 八、输入加固：解析前转义 + 白名单重建（新增，安全）

Evennia 的模型是**「解析前转义 + 白名单重建」**，不是黑名单过滤：

- `utils/ansi.py` 的 `raw()` 把 `{` → `{{`、`|` → `||`；`strip_unsafe_tokens()` 剥掉会造成视觉攻击的标记（换行、标签）。
- 长度上限在**进引擎之前**就截断（Portal 侧）。
- 有 `validatorfuncs.py` 按类型分派校验。

对我们的推论（比 Evennia 更进一步）：**引擎指令 token 使用玩家无法产生的字符集**（`\x00` 前缀或 Unicode 私有码位）。这样「玩家文本不可被误认为引擎 markup」就是**构造性保证**，而不是靠正则兜底。

### 九、测试权重要压在边界，不是规则（修订 ADR-0023）

读 Evennia 的 110 个测试文件得到一个反直觉的洞察：**测试密度标记的是「纯函数、易构造、曾出 bug」的交集，而不是风险本身**。

- **最密**：字符串/ANSI 解析器、命令解析、纯函数规则（traits/crafting）。
- **最疏**：网络与传输边界（`test_inputfuncs.py` 只有 1 个测试）、限流与安全（`throttle.py` **零测试**）、comms/help/locks、以及 `dbserialize`（唯一防「存进去取出来不一样」的防线，只有 13 个测试）。

**对我们的推论**：规则逻辑（伤害公式）反而不容易出致命 bug。权重应压在**边界**上——输入 token 化、消息序列化往返、以及**玩家文本与引擎 markup 的不可混淆性**。

## 记录：settings 面的三分法（修订我们的 `content/config/settings.json`）

Evennia 的 62KB 配置面暴露了 21 类旋钮，但它**零校验**（全文 0 个 assert、0 个取值范围检查、0 个 deprecation 机制），且有一批 footgun：

- 耦合对无校验（`SEARCH_MULTIMATCH_REGEX` 改了必须同步改 `TEMPLATE`，只写在注释里）
- 「写入即单向」（频道列表删了不会从游戏里移除）
- 「只影响新对象」（改 cmdset 路径对既有角色无效）
- 「替换 vs 扩展」二义布尔（`COLOR_NO_DEFAULT = False`）
- **用 `None` / `0` / 负数三种方式表示「无限」**——极不一致

**三分法**（这是可迁移的结构性结论）：

| 类 | 内容 | 放哪 |
|---|---|---|
| **STRUCTURE** | 装配图：模块路径、typeclass、cmdset | **不进** settings，用 `$ref` 指向内容 |
| **TUNING** | 数字：战斗/成长/经济/上限/时长/节流 | **进** `settings.json` |
| **POLICY** | 决策：权限层级、多会话模式、默认策略 | **另开** `policy.json`（枚举白名单约束） |

首发建议 9 类：`combat` / `progression` / `derivedStats` / `economy` / `rng` / `caps` / `time` / `newPlayerDefaults` / `throttles`。

三条硬规则：**禁止用 `null` 表示「无限」**（改用 `{"unlimited": true}`）；时间值单位写进键名（`cooldownSeconds`）；每组加 `formula` 字段存公式表达式，**让数值与公式同处一地**——这正是 Evennia 缺失、而我们「零硬编码」目标需要的。

## 记录：webclient 借架构，不借渲染层

Evennia 的浏览器客户端（真正的 JS 在 `web/static/webclient/js/`）**架构值得抄，渲染层一个字都别抄**：

**借**：三元信封 + 具名 cmdname；传输抽象 + 降级（WebSocket ↔ 长轮询）；**`onSend` 广播链**（每个插件都能改写待发命令——这是别名展开与历史记录的天然挂载点）；**独占声明语义**（插件返回 `true` 即终止传播，映射到我们的 `onCommand` 返回「已消费」）；传输层与表现层严格分离。

**不借**：ANSI/管道码 → HTML 的双转换管线（服务端 `parse_html` + 客户端 `parse2html` 带状态机）；`htmlEscape` 与 `&nbsp;` 替换；无上限 append（它**没有任何 scrollback 上限**，我们的 cap 是正确决策）；MXP 的可点击注入（它的 `onclick="Evennia.msg(...)"` 只做了 `"` → `\&quot;` 的转义，注入面真实存在）；`case 9: // ignore tab key`（我们要 Tab 做补全）。

一句话：**它的那一整层是在为兼容 1980 年代的哑终端付税。**

## 记录：EvMenu 的模态性是泥潭（强化 ADR-0023 §7）

EvAdventure 是这条结论最有力的证据：这个完整游戏**大半的开发量花在绕开 EvMenu 的模态性**——手写 `_step_wizard` 状态机模拟多步输入、跨玩家强关对方菜单、把 `caller.ndb._evmenu.buymap` 当成随菜单自动销毁的临时缓存。作者甚至在 `commands.py` 顶部注释里直言「很多功能在菜单里」，**整个游戏只新增了 5 条命令**。

对我们「滚动叙事流」的目标，这是一条**明确的反面路径**：ADR-0023 §7 拒绝模态分页的判断，在这个真实案例里得到了强化。

## Consequences

- **M1 的接口必须带上 `actorId` 与事件侧 `seq`**——这是本轮唯一「现在不做将来改所有调用点」的项。
- **实体 hook 清单（§五）是 M1 世界模型的设计输入**，不是可选的打磨项。
- **调度原语集（§三）取代「每对象定时器」的一切设计**，并让「观察时补偿结算」成为 DoT 类机制的标准实现。
- **`settings.json` 按三分法重构**，并补 `formula` 字段；`policy.json` 是新增文件。
- **输入加固（§八）进入 M1 的输出层**，引擎 token 用私有码位。
- **测试计划按 §九 重新配权**：边界 > 规则。
