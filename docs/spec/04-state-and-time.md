# 04 · 状态、存档、时间与调度

> **状态**：迁移链骨架**已实现**；**§1 已实现**（状态树种子 M2-T1：`EntityState {id, locationId, flags}` ＋ `WorldState`（`packages/core/src/state/tree.ts`），动态占用进「同一棵树」，`WorldRuntime` 持有并就地变更；flags 槽位随门禁消费者落地；**`tags` 槽已落（M3-T5／#17，形状 = `TagMap`，与内容侧同一模型，见 spec/03 §5.1）**；attrs/states/skills 随各自系统进树。**序列化与快照 v1 ＝ M2-T5 已落**：`state/snapshot.ts`（`serializeWorld`／`restoreWorld` ＋ v1 形状）＋ `state/derived.ts`（`derived` 契约）＋ `WorldRuntime.attachEntity`（恢复＝重放树＋重挂实例），见 §1.4）。
> **§2–§4（时间、游戏内时间、调度）＝ M4，设计已定案**：2026-09-08 的 `grill-with-docs` 访谈共 **19 条**（四轮 18 问 + 复核硬标准时补的第 19 条），本章正文即这 19 条，依据 **ADR-0031／0032／0033／0034**。
> ⚠️ 其中 **2 条覆盖了既有决策**：**ADR-0031** 覆盖 `spec/01` 端口表里 `Clock` 的「宿主实现」一列与该手册自检清单里以 `TestClock` 为证据的那一条；**ADR-0032** 覆盖 **ADR-0016 §4「双时钟……不共用代码路径」**。照本仓惯例，ADR 是不回改的决策日志，但 **spec 是活规格，被覆盖的段落在正文中就地更正**，覆盖关系由新 ADR 记录。
> **其余依据**：ADR-0002、ADR-0017、ADR-0022 §1/§5、ADR-0023 §5/§1d、ADR-0025 §二/§三/§四、ADR-0028。

## 0. 术语（M4 新增，先读）

本章好几个词在日常中文里是同一个字，在这里都是不同东西。**写任何 M4 代码前先对齐这张表**。

| 词 | 含义 | 不是 |
|---|---|---|
| **tick** | 引擎的单调计数。不是毫秒，不由墙钟推导 | 时间戳、毫秒 |
| **高水位**（`maxTick`） | 单调不减的「现在」= 所有**非 `invalid` 的命令**（即 `ok`／`rejected`）的 tick 最大值；`invalid` 不计入（§4.1）。⚠️ 初值由驱动侧播种（存档里的 `nowTick`／会话起点），**不是**某条命令给的 | 最后一条命令的 tick |
| **结算跨度** | 一次补算覆盖的区间 `[fromTick, toTick)` | 「在线时长」 |
| **游戏内时间** | tick 推导出的**段**（哪个时辰、哪个季节）。**推导，绝不存储** | tick 本身 |
| **环**（`ring`） | 一条独立的游戏内时间刻度轴（日内时辰是一条，年内季节是另一条） | 「日历」整体 |
| **世界层推进** | 到期桶这类挂在**世界**上的东西，每条命令都补到高水位 | 每个实体的推进 |
| **实体层推进** | 补偿结算／离线补算，**只推进这条命令的 actor**，用他自己的 `lastSeenTick` | 世界层推进；其他在场实体 |
| **到期桶** | 到某一 tick 触发一次的**一次性**效果（`Map<dueTick, 载荷[]>`） | 每 tick 遍历的定时器 |
| **观察时补偿结算** | 周期性效果在**被观察时**一次性补齐欠的次数（O(1)） | per-object timer |
| **冷却** | `key → 到期 tick` 的只读表。判定是 tick 比较，不是回调 | 定时器、延时句柄 |

> ⚠️ **在线心跳、离线结算、到期桶是同一件事的三种跨度**（同一个推进函数的不同调用方式，ADR-0032）。它们**不是三套机制**。说「离线结算」时指的是**跨度大**的那次调用，不是另一个代码路径。

## 1. 状态：typed 对象 + 迁移链（不需要 attribute handler）

### 1.1 明确定论：不做 attribute handler

Evennia 那一千多行缓存机器（`_cache`/`_catcache`/`SaverMutable` 代理/后端抽象）**是在为 SQL ↔ Python 的阻抗失配买单**：隐藏 SQL、隐藏 pickle、惰性加载、可替换后端、嵌套可变体原地写回。我们四项都没有。

加这层只会得到一个**把编译期类型错误推迟到运行期字符串 key 错误**的机器（Evennia 自己在 `attributes.py:304` 就抱怨过 `.db` 访问会绕过校验钩子）。

### 1.2 我们要的四样

1. **按 schema 定义的 typed 状态对象** —— 这就是「编译期 AttributeProperty」，且不可绕过
2. **版本化迁移链** —— 这是我们**相对 Evennia 的优势**：它的 `db_value` 是 pickle blob，永不迁移，只能靠 `swap_typeclass(clean_attributes=True)` 删光重来
3. **加载时构建一次的内存倒排索引** —— 用于跨实体反向查询。快照整体在内存，**没有「陈旧」概念，缓存层纯属负债**
4. **一个薄访问门面仅为可读性** —— 不承载任何缓存/失效职责

### 1.3 保留 `db`/`ndb` 的**精神**，丢弃它的 API

明确区分「进快照的」与「**派生的／可重算的**」：

- 后者标 `derived`，**序列化时排除、加载后重算**
- **不要给它一个长得一样、却会在重启时静默清空的 API**（Evennia 自己承认：nattributes 非空时对象不能 flush，「those would get lost!」）

依据：ADR-0022 §1、ADR-0025 §二

### 1.4 快照 v1（M2-T5 已落）

`packages/core/src/state/snapshot.ts`：`serializeWorld(world) → Snapshot<SaveDataV1>` ／ `restoreWorld(snapshot, options?) → WorldState`。

- **载荷就是状态树**，不是平行结构：`SaveDataV1 = { entities: Record<string, EntityRecordV1> }`，`EntityRecordV1 = Omit<EntityState, DerivedEntityKey>`（`tags` 例外地可选——见下条）。序列化在树之上只加三样：① `version` 戳（迁移链入口）② `derived` 切分（见 §1.3）③ **规范序**（entities 按 id 升序、flags 排序、**tags 维度键升序 + 键列表排序去重**）——两个相等的世界存出**同一份字节**（ADR-0024 §2），确定性引擎的历史才可 diff、可比对。**规范序由 `serializeWorld` 负责，不要求写入方保持有序**（照 flags 的先例）。
- **新槽在恢复时可选、缺即空；`flags` 保持必填**（M3-T5 定案，写入此处以免同一份校验器两种口径被当 bug）：`tags` 是 v1 存档中途长出的槽——它落进树的那天（#17）之前写下的存档都没有这个字段，而「未显式写入的字段不落盘」（ADR-0022）意味着**缺 = 空**，不是损坏；`restoreWorld` 显式补 `{}`。`flags` 相反：**v1 起每份存档都写过它**，放宽只会白丢一条损坏检测。规则一句话：**在当前版本内中途落地的槽，恢复时一律可选**。
- **NPC 不在快照里，是构造使然而非过滤**：静态在场直读放置清单（ADR-0028 §1），未显式写入的字段不落盘——这里没有 NPC 行可删，也永远不该有。
- **恢复＝重放树，不是创建**：`restoreWorld` 只重建状态（`migrateSnapshot` → 形状校验 → 逐实体重建 → 重算 `derived`），宿主再用 `WorldRuntime.attachEntity` 重挂 hook 载体；**不跑** creation 两层（跑 `at_object_creation` 等于用代码默认值覆盖存档，正是两层接缝要防的反转）。挂载**顺序无关**（被携带者可先于携带者挂载），恢复后的位置必须仍能解析——内容漂移大声失败，不做半解释状态。
- **大声失败**（`tests/snapshot.test.ts` 逐条行使）：**版本**不合法（大于 `SAVE_VERSION`／小于 1／非数字）；**载荷** `data` 非对象、缺 `entities`、实体键为空、记录非对象、无 `locationId`、flags 非字符串数组、记录 id 与键不符——**七类**损坏载荷全部在加载时抛（ADR-0003）；**tags 存在但畸形**（非对象、某维度的键列表非字符串数组）是第八类（#17 起，与第七类同律：写进来了就必须合法）；**cooldowns 存在但畸形**（非对象、某键的值不是非负安全整数）是第九类（#23 起，同律）。
- **测试**：`tests/snapshot.test.ts`（形状钉死／往返经 JSON 边界后位置与 flags 存活／字节稳定与幂等／`derived` 表驱动排除＋加载后重算／未来版本与七类损坏载荷大声失败／NPC 不入档且加载后仍在场／重挂不跑 creation 两层、顺序无关、重挂后继续可玩／**tags 往返与规范序、旧存档（无 tags 字段）缺即空、第八类畸形 tags 大声失败——M3-T5**）。**cooldowns 的往返／规范序／缺即空／第九类畸形**在 `tests/cooldown.test.ts`（#23，与它自己的槽同居）。

### 1.5 快照 v2（M4 待实现，ADR-0033）

v1 里没有引擎 tick 与 RNG 种子；它们的消费者就是本章 §2–§4，所以那一天是 **v2 + 一条迁移**，不是往 v1 形状里静默加字段。

**载荷增加三样**：

| 槽 | 位置 | 语义 |
|---|---|---|
| `nowTick` | 顶层 | 引擎高水位（§2.2）。**必须存**：不存则恢复后时间倒退，`nowTick >= dueTick` 恒为假，**冷却会永远不到期**（不是"失效"，见下面约定 2） |
| `rngState` | 顶层 | `Rng.getState()` 的读数（§2.4）。mulberry32 的状态就是一个 uint32 |
| `lastSeenTick` | 每实体 | 该实体**上次被结算到**的 tick（§4.3 两层推进）。⚠️ **槽已随 #22 落树**（比 v2 早）：v1 存档里它是**可选**的（照 `tags` 的先例，§1.4），v2 起由迁移给默认值 |

**种子（照 `tags` 的先例，别漏）**：`WorldRuntime.addEntity` 今天把树的每个槽都种子一遍（见其实现注释：「an absent `tags` would put a `??` in front of every hasTag read for no reason」）。`lastSeenTick` 与 `cooldowns` 同理必须在 `addEntity` 里种子 —— **`lastSeenTick` 种子为当前 tick**（新实体从现在开始，不是从 0），`cooldowns` 种子为 `{}`。

**四条约定**：

1. **迁移补默认值**（v1 → v2）：`nowTick = 0`、`rngState = 0`、`lastSeenTick = nowTick`。补的是「这份存档写下时那个字段还不存在」这一事实，不是猜测玩家状态。
2. **恢复时一律「缺即空」，不为 v2 新增槽加特例** —— 与 §1.4 那条规则同一个口径。⚠️ 代价要说准（此前措辞是错的）：v2 存档若 `nowTick` 丢失／损坏不会报错，游戏当成第 0 tick 继续跑 ⇒ 判定 `nowTick >= dueTick` 恒为假，**冷却不是「失效」，而是永远不到期**（技能要再等满 `dueTick` 个 tick）。这比「失效」糟，但仍是「时间回到过去」这一类可恢复的问题，且比多一条检测规则便宜。
3. **⚠️ 顶层槽的进出通道是一个签名问题，实现前必须解决**：今天 `serializeWorld(world)` 只收一个 world、`restoreWorld(snapshot) → WorldState` 只返一棵树（`WorldState = { entities }`）。而按 §2.2，高水位住在**驱动世界的那一侧**（`WorldRuntime`／宿主 Authority），**不在 `WorldState` 里**。于是 `nowTick`／`rngState` 既**写不进**（`serializeWorld` 拿不到它们）也**读不出**（`restoreWorld` 的返回值里没有它们）。三条路，必须选一条并写进票：
   - **(a)** 把它们并进 `WorldState`（树自带 `nowTick`）—— 签名最小改动，但 `WorldState` 从「实体树」变成「实体树 + 世界标量」，语义要跟着重写一遍；
   - **(b)** 改签名：`serializeWorld(world, meta)` ／ `restoreWorld(snapshot) → { state, meta }`，`meta = { nowTick, rngState }` —— 语义最清（树与时钟分开），代价是动两个公开函数；
   - **(c)** 由 `WorldRuntimeOptions` 接收 `nowTick?`／`rngState?`，存档读写都经 runtime —— 与 §2.2「高水位住在驱动侧」最一致，但要求宿主全程走 runtime，纯对象测试路径也要给一个等价物。

   倾向 **(b)**：与 §2.2 的归属一致，且不要求 `WorldState` 承担它今天不承担的语义。
4. **不做 v2 → v3 连迁**：v2 的形状这一次要想全。这也是这条迁移链**第一次被真实迁移检验**（`SAVE_VERSION` 保持 1、链机制就绪但为空至今，不造假迁移）。

**nicks（玩家层别名，`spec/02` §8 至今未勾）不同趟** —— 它是**玩家层**不是实体层；把两层的东西塞进同一次迁移，正是走向「v2 → v3 连迁」的最快方式。等别名票自带那趟。

## 2. 时间：tick 计数（ADR-0031）

### 2.1 硬约束（不变）

引擎内禁止 `Date.now()` / `new Date()` / `setTimeout` / `setInterval`；由 `tests/engine-purity.test.ts` 的 platform scanner 机械强制。

### 2.2 tick 的真相：`Command` 携带，引擎取高水位

**每一条 `Command` 自带 `tick`**（与 `actorId` 同一条理由——ADR-0025 §1.1：「最贵的 retrofit，今天做」）：

```
Command { seq, actorId, tick, raw }
```

**`maxTick = max(所有非 invalid 的命令的 tick)`**，由 `createTickClock` 的**实例**维护（单调不减），是引擎唯一承认的「现在」，由 §2.3 的 `Clock` 对外读出。⚠️ 「引擎维护」不等于「`runCommand` 维护」：那个实例由**驱动世界的那一侧**持有（§2.2 末条），`runCommand` 只是被喂一个数。

> ⚠️ 限定语不可省，且**口径要比「进入执行段」更宽**：`ok` 与 `rejected` 都算（含被门禁／`at_pre_cmd` 在 parse 之前就拒掉的），只有 `invalid`（没解析成命令，它连命令都算不上）**不参与** —— 否则一条乱码就能把水位抬高、让下一条真实命令瞬间跨过一大段，等于间接快进世界。见 §4.1。

- **tick 倒退的命令照常执行**，但一切时间判定用高水位。**不**大声失败：tick 倒退**不改变任何已发生的事实**，只影响「现在」，而「现在取最大值」是唯一无歧义的解释；丢命令比采纳命令代价大。
- **不保留两个真相**：既有 `CommandDeps.clock`（宿主注入的时钟）**删除**（**#20 已完成**），改为 `CommandDeps.nowTick`。
  **改动面（2026-09-08 实测，#20 已完成，不夸大也不缩小）**：`Command` 的构造点共 **8 处**（`testing.ts` 的 `call()` 1 处 + `parser.test.ts` 绕过 harness 直接调 `runCommand` 的 7 处）全部带上 `tick`；`parser.test.ts` 的 `deps()` 去掉 `clock`；`command-harness.test.ts` 的 `tickProbe` 改读 `ctx.command.tick`。合计约 10 处，**不是零回归**，但它发生在「全仓只有 1 处读时钟」的时点 —— 等战斗系统开始读 `ctx.clock` 之后再改就是几十处。那条 `tickProbe` 的**断言值不变**：`advance(7)` 改为「改下一条命令的默认 tick」之后仍是 `[100, 107]`。
- **附带**：`TestClock.advance()` 的语义从「推进引擎的现在」变为「改下一条命令的默认 tick」。
- **实现落点（#20 已落）**：`packages/core/src/clock.ts` 导出 `createTickClock(startTick)`（`TickClock = Clock & { observe(tick) }`）与 `observeDispatch(clock, command, result)` —— 后者封装 §4.1 那张表（`ok`／`rejected` 抬高水位，`invalid` 不抬高），让这条规则只有一个副本。`runCommand` **自己不持有时钟**：它从 `deps.nowTick`（驱动侧在本条命令之前的水位）取，算 `now = max(deps.nowTick, command.tick)`，再把它包成 `ctx.clock` 交给命令。`deps.nowTick` 与 `command.tick` 任一不是非负安全整数时**大声失败** —— 那是接线错误，不是玩家输入（NaN 水位会让下游所有判定静默失真，必须挡在入口）。
- **高水位住在「推进世界的那一侧」，不在 `runCommand` 里**：`runCommand` 是纯函数（它因此**不持有**任何时钟，这正是能删掉 `CommandDeps.clock` 的原因）。推进与高水位由**驱动世界的那一侧**持有 —— 生产上是 `WorldRuntime`／宿主 `Authority`，测试上是 `createCommandHarness`（#22：`WorldRuntime` 已真的持有 `clock`，`addEntity` 从它取当前 tick；推进函数 `settleTo` 收它作起点，见 §4.3）。纯对象模式（`liveWorld: false`）每次调用深拷贝一个全新夹具，本就不存在跨调用的时间，需要跨调用观察时间的用例改用 `liveWorld: true`（该开关已存在）。
- ⚠️ **驱动侧必须把自己持有的水位喂进 `deps.nowTick`，不能图省事喂 `command.tick`**：后者会让「tick 倒退取高水位」这条规则整个失效（水位恒等于本条命令的 tick），而且**引擎侧无从检测** —— 传给 `runCommand` 的数与本条命令的 tick 恰好相等是完全合法的情形。这是驱动侧的纪律，不是引擎能守的约束（#26 的宿主实现要照做）。
- ⚠️ **重放的限定**（ADR-0031 §1 那句「同一命令序列在不同 tick 重放」的准确含义）：重放**必须**从一个新的水位开始（或按不减的顺序喂入）。把一段旧序列喂进一个水位已经更高的时钟，每条命令看到的都是那个水位 —— 这是高水位语义的正确结果，不是 bug，但它意味着「乱序重放」不可表达，见 §2.5。

### 2.3 `Clock` 端口：方向翻转（ADR-0031）

`Clock` 端口**保留**，但语义从「**宿主注入**的依赖」翻转为「**引擎对外**暴露的读数」：

```
Clock { nowTick(): number }   // = 引擎高水位，不是毫秒，不是宿主时钟
```

宿主仍然负责**产生** tick（把墙钟翻译成 tick 是宿主的事），但只在构造 `Command` 时给它，不再注入。由此引擎不存在第二个「现在」。

> ⚠️ 这条**覆盖了 `spec/01` §端口表里 `Clock` 行的「宿主实现」一列**（原写「单机：由宿主按固定步长推进」）与该手册自检清单里以 `TestClock` 为证据的那一条 —— 那两处已在本次一并更正。

### 2.4 `Rng` 端口：状态可导出（ADR-0033）

```
Rng { next(): number; getState(): number }
```

`getState()` 是**强制**的：宿主不可提供一个不可序列化的 RNG，否则存档即失去确定性。mulberry32 的状态就是一个 uint32，导出成本近乎为零，恢复 O(1)。

**被否的替代**：只存初始种子 + 快进 N 次 `next()` —— 恢复是 O(N)，N 随存档年龄无界增长。见 §1.5：`rngState` 进 v2。

### 2.5 `seq` 与 `tick` 各管一段（O2 定案，#20）

| | 定什么 | 不同序时 |
|---|---|---|
| `seq` | **投递顺序**：谁先被处理（ADR-0025 §1.2） | 由调用方分配，引擎**不重排、不校验** |
| `tick` | **世界时间**：一切判定用的「现在」（§2.2） | 取高水位；倒退不改任何已发生的事实 |

二者**独立，不互相校验**：一条 `seq` 更大的命令完全可以携带一个更小的 `tick`（重放、网络乱序、离线补发都会这样），引擎既不因为它重排，也不因为它失败 —— 那样只会把「乱序」变成「丢命令」。

## 3. 游戏内时间 = tick 的纯函数（ADR-0032）

### 3.1 明确定论：日历全内容化，引擎只做取模

**时辰／刻／季节这些词一个都不能出现在引擎源码里** —— 不是因为它们是「武侠题材词」（它们其实只是中文历法），而是因为它们是**内容**：验收标准 2 要求换一套包之后连历法一起换，迷你包（近轨灯塔站）不能被追着问「现在是子时三刻」。

因此：

- 引擎只有 **`f(环, tick) → 段索引`** 这一个概念。段名、段数、每段多长、有哪些环，全在数据里。
- **没有默认公历兜底**：包没给 `calendar`，用到时间时**大声失败**（与 `settings` 缺失同一条规则，见 §3.3）。
- 换算数字（`TICKS_PER_HOUR`／`TICKS_PER_DAY`／`DAYS_PER_YEAR` 那一类）**一律不进引擎**（硬标准 1「零写死数量」），它们的家是内容。段 id（`zi`／`chun`…）同理只住在内容 JSON —— 引擎源码里一个历法词都搜不到，由 `tests/engine-purity.test.ts` 的 CJK 扫描机械保证（#21）。
- **不需要 `TIME_FACTOR`** —— tick 频率本身就是缩放因子（Evennia 需要它是因为它绑真实时间）。

### 3.2 形状：一组**独立**的环，不是一张扁平分段表

一个 tick 同时落在**多条**刻度轴上（日内是「哪个时辰」，年内是「哪个季节」）。一张扁平分段表只能表达**一个**环 —— 后来想加季节就得改 schema + 改引擎，正是「面向未来：MVP 只控制系统数量，**不降低架构完备度**」要防的那种返工。（这一条是 2026-09-08 复核硬标准时补的**第 19 条**。）

```
content/config/calendar.json   →   schemas/config.calendar.schema.json
{
  "id": "calendar",
  "rings": [
    { "id": "day",  "segments": [ { "id": "zi",   "ticks": 2400 }, … ] },
    { "id": "year", "segments": [ { "id": "chun", "ticks": …    }, … ] }
  ]
}
```

- **环周期 = `Σ segments[].ticks`** ⇒ **没有第二个数需要同步**：不让 `settings.time.ticksPerDay` 与环周期各说一遍，照 §2.2「不保留两个真相」同一条纪律。
- **环之间互相独立**，各自取模；引擎不知道也不关心 `day` 与 `year` 之间是否成 360 倍关系 —— 那是数据的事。
- 求值 O(段数)（段数很小，够了）；要 O(1) 时在加载期预算前缀和，那是 `derived` 的用法，不进存档。
- ⚠️ **别抄 `extended_room` 的区间写法**：它的 `if start < end` 让跨年区间（winter `(1.0, 0.25)`）**永远匹配不上**，只是靠「遍历完返回最后一个键」侥幸正确。用**半开区间 + 显式排序数组**。
- 房间描述与 NPC 在场判定做成 `(nowTick) => descKey` 的纯选择函数。

> **落地（M4-T2，#21）**：`packages/core/src/time/calendar.ts` —— `ringPeriod(环)`（Σ 段 tick，周期只有一个来源）、`segmentIndexAt(环, tick)`（`tick % period` 一次取模 + 半开区间扫描，O(段数)）、`segmentAt`、`createGameTime(calendar?)`（按环 id 查；**缺日历时首次使用才抛**，不是构造时、更不是加载期）。武侠包 `content/config/calendar.json` = `day`（十二时辰，各 1200 tick，周期 14400）＋ `year`（四季，各 1296000 tick）；迷你包是另一套（`shift`／`orbit`）。

依据：ADR-0025 §四

### 3.3 通道：与 `dimensions` 同构（ADR-0032）

配置三分法（ADR-0025 §三，见 `08-non-goals.md` C4）：**STRUCTURE 不进 `settings`**。日历的段名／段数属装配图（STRUCTURE），速率类数字属调参（TUNING），因此**拆两处**：

| 文件 | 承载 | 三分法归类 |
|---|---|---|
| `content/config/calendar.json`（新） | 环、段名、每段 tick 数 | **STRUCTURE** |
| `content/config/settings.json` 的 `time` 组 | 回复速率、buff 时长、冷却默认（键名一律带 tick 单位） | **TUNING** |

- 走与 `dimensions` **同一条通道**：`createContentRegistry(content, { dimensions?, settings?, calendar? })`，由宿主装载器读 `config/` 后传入。引擎**不读文件**（照 `tests/fixtures/mini-content-pack.ts` 里 `readDimensions` 的先例）。
- 注册表**校验跨字段一致性**（如「环周期 > 0」「段 id 在环内唯一」）——那是 schema 管不了的那类约束，与今天的引用完整性同一层。
- **缺 `settings.time` 或 `calendar` 时，由引擎侧在首次使用时间时大声失败**，不是注册表加载期：注册表不该知道引擎需要哪些参数（与它今天不知道引擎用不用 `byTag` 同一分寸）。
- **新增 schema 需走 ADR-0003 的三处同步**：`core` 类型／编辑器表单（`apps/editor` 今日仍是占位）／`docs/agents/content.md` 字段说明。

> **落地（M4-T2，#21）**：`createContentRegistry(content, { dimensions?, settings?, calendar? })` — 三张表同构进注册表，校验只做 schema 管不了的那一层（`src/content/config.ts` 的 `assertCalendar`／`assertSettingsTable`：环 id 全表唯一、段 id 环内唯一、tick 为正整数、每个组是对象；**`id` 戳豁免**）。注册表把两张表**原样交回**（`registry.calendar`／`registry.settings`：同一个已校验的对象，不是第二份副本），让引擎侧只有一个来源可问。引擎侧读数在 `createGameTime`（日历）与 `createTimeTuning`（`settings.time`）——**两者都是惰性抛错**，这正是「不是注册表加载期」的字面实现。

## 4. 调度（ADR-0032／0034）

### 4.1 推进：`settleTo`

`spec/04` §4 原列**六个**原语（ADR-0025 §三明说「可砍到四」）。M4 落**四个**，另两个留给它们的消费者：

| 原语 | M4 | 复杂度 | 为什么 |
|---|---|---|---|
| **Clock**（高水位，§2.3） | ✅ | O(1) | 所有判定的输入 |
| **纯 stage 求值** `f(startTick, nowTick, stages)` | ✅ | O(1) | 无注册、无状态、无回调 |
| **观察时补偿结算** | ✅ | O(1) | `pulses` 公式；绝大多数 per-object timer 需求被它取代 |
| **到期桶** `Map<dueTick, 载荷[]>` | ✅ | O(到期项数) | 延迟爆炸这类一次性效果 |
| 区域 tick（`tick % interval === phase`） | ❌ | **O(跨度 / interval)** | 唯一一个 O(tick 数) 的原语，且今天无订阅者（天气／刷新的事） |
| on-change 钩子 | ❌ | — | 属于**状态层**不是调度层，与 tick 解耦，随第一个需要它的系统走 |

**接缝要写进本节**（避免将来被当成「忘了做」而悄悄侵蚀）：区域 tick 的插入点是「一条结算跨度内的分组订阅」，on-change 的插入点是「状态树写入钩子」，两者都**不需要改 `settleTo` 自身**。

> **复杂度那一列说的是「与结算跨度无关」，不是「与内容规模无关」**：到期桶是 O(到期项数)、stage 求值与日历环是 O(段数)（段数是内容里的一个小常数）。被封死的是 **O(tick 数)** 那一类 —— 见 §4.4。
>
> **落地（M4-T4，#23）**：`src/time/due.ts`（到期桶）／`src/time/cooldown.ts`（冷却判定）／`src/time/stage.ts`（纯 stage 求值）。到期桶接的是 §4.1 那个**世界层注册位**（`createSettler({ world: bucket.settle })`）—— `settleTo` 自身一行未改，这正是接缝先行的兑现；冷却是状态树新槽（§4.6）；stage 求值是三个里唯一连注册位都不需要的（§4.7）。

#### ★ 只有非 `invalid` 的命令（`ok`／`rejected`）才推进世界 —— 否则时间可被刷

推进发生在命令处理前，于是有个必须回答的问题：**一条 `invalid`（无法解析）的输入，推进世界吗？**

它**不消耗 seq**（ADR-0025 §1.2：格式错误／无法解析，seq 未消耗）。如果它也推进世界，玩家**发一堆乱码就能快进世界** —— 到期桶提前触发、离线补算的跨度凭空变长、冷却白白流逝。**时间与 seq 必须同律：**

| 结果 | 推进世界？ | 抬高 `maxTick`？ |
|---|---|---|
| `ok` | ✅ | ✅ |
| `rejected`（引擎合法拒绝，事件已发出） | ✅ | ✅ |
| `invalid`（没解析成命令，它连命令都算不上） | ❌ | ❌ |
| `transport` | —— 根本没到引擎，不存在这个问题 | —— |

⚠️ 连带一条不可漏：`invalid` 的 `tick` **也不参与高水位** —— 否则一条乱码先把 `maxTick` 抬到 1000，下一条 tick=500 的真实命令一进来世界就跨了 500，等于**间接推进**，上面那张表就白定了。

#### 推进发生在命令**之前**，于是驱动侧必须先知道它是不是命令

「推进到高水位」里的高水位含本条命令的 tick（`max(驱动侧水位, command.tick)`，§2.2），而 `invalid` 又不许推进 ⇒ **不能等分发完再回头推进**：那既要让命令跑在一个「还没结算到现在」的世界（炸弹该在 50 tick 炸、命令在 100 tick 却没看见），又要把结算事件插到已发出的事件之前。

**驱动侧的固定四步**（`WorldRuntime`／宿主 `Authority`／测试 harness 都照这个顺序，测试 harness 已实现，见 `command/testing.ts` 的 `settle` 钩子）：

1. 先跑一次**预检**（`parseCommand(spec, command, deps)`，只跑 parse 段）：解析失败就直接回 `invalid`、**不再调 `runCommand`**，推进函数一次都不会被调用，水位也不动；
2. 解析成功才**推进**：`settler.settleTo({ toTick: effectiveNowTick(水位, command), seq, actorId })`（`time/settle.ts`，两层，见 §4.3）；
3. 再跑 `runCommand`（它内部会再解析一次 —— 与「分发器已匹配动词、管线内再切一次」同一个既有取舍，代价是 **parse 段必须无副作用**）；
4. 最后 `observeDispatch` 抬水位，并把结算事件**排在命令自身事件之前**返回。

「现在的算法」同样只有一个副本：`effectiveNowTick(水位, command)`（`command/pipeline.ts`）—— 预检、分发、驱动侧的推进目标都调它，两个 tick 的合法性也由它一起挡。

⚠️ 今天只有**测试 harness** 全程跑这四步（`HarnessOptions.settle`）；`WorldRuntime` 持有高水位但**不分发**（分发是宿主 `Authority` 的事，见 O10 与 #26）。没有配推进钩子的 harness 不需要预检，也就不跑它。

⚠️ 只有 1 能挡住「发一堆乱码快进世界」：若跳过预检直接按 `command.tick` 推进，一条 tick=1000000 的乱码照样把到期桶提前引爆 —— 水位虽不抬，**世界已经动了**。

### 4.2 同一件事的三种跨度：在线心跳／离线结算／到期桶

```
pulses = min(floor((nowTick - startTick) / interval), maxPulses) - applied
```

**观察时补偿结算**不需要注册、不需要存储、不需要回调，只在被观察时一次性补齐欠的跳数并写回 `applied`。（`maxPulses` 是**语义**上限——毒最多跳 5 次，内容可配；它不是性能护栏，别混淆。）

> ⚠️ **这条覆盖了 ADR-0016 §4「双时钟（心跳 tick／离线结算）……不共用代码路径」**（ADR-0032）：**双时钟降级为同一个推进函数的两个调用跨度**，而不是两套代码。在线心跳 = 跨度 1；离线结算 = 跨度很大（「进入游戏时一次性 O(1) 补算」）；到期桶 = 跨度内的到期项。**ADR-0016 §4 的另一半仍然有效**：离线补算**只补资源与基础熟练度**（有上限），**不自动战斗、不推层、不产掉落**。

### 4.3 ★ 两层推进：世界层 vs 实体层（ADR-0034）

这是「离线结算能否存在」的关键。**如果所有实体都跟着每条命令一起推进，`lastSeenTick` 会被刷成 `nowTick`，离线补算的跨度永远是 0 —— 离线结算等于没做。**

| 层 | 推进时机 | 用谁的 tick | 装什么 |
|---|---|---|---|
| **世界层** | 每条**非 `invalid` 的**命令（`ok`／`rejected`）处理前都补到高水位 | 全局（推进后 = `nowTick`，故只需存 `nowTick`） | 到期桶、一次性世界事件 |
| **实体层** | **只推进这条命令的 actor** | 实体自己的 `lastSeenTick` | 补偿结算、离线补算 |

⚠️ **为什么是 actor 而不是「所有在场者」**：在场 ≠ 在线。离线玩家的实体仍然在树里、仍然「在同房间」，若把在场者一起推进，**甲的活动就会消耗乙的离线补算额度**，乙的离线结算就不再发生在「他自己回来」的那一次 —— 玩家会发现自己「什么都没干，回来时补的却变少了」。actor-only 是唯一没有歧义的解释。

这正是 ADR-0022 §5「时间推进**按需求值**」的字面实现：没被「需求」的实体不推进。场景核对：甲 tick 0 下线、乙 tick 100 下线，都在 1000 回来 —— 甲先回：世界层 0→1000 跑完到期桶，实体层结算甲 0→1000；乙后回：世界层无需再跑，只结算乙 100→1000。

接缝：将来若有票需要「被动参与者（如被攻击者）也推进」，那是那张票的独立决策，插入点是这里；**今天不做**。

**M4 只落机制与接缝，不落真消费者**：状态树今天**没有任何可补的数值槽**（只有 `id`／`locationId`／`flags`／`tags`），而「补气血／内力／基础熟练度」要的槽属于效果系统那一族 —— 现在为它开 `attrs` 槽，等于提前承诺一个**还没设计**的形状（这正是 §4.1 拒掉「为到期桶提前建具名 effect 表」的同一个理由）。所以 M4 落的是**补偿结算这个原语 + 一个注册位**，由**合成消费者**驱动测试 —— 照 `entity-seams.test.ts`（全合成驱动、不依赖物品系统）与 `derived` 表今日为空这两个既有先例。

- **`lastSeenTick` 由引擎在结算完该实体后写入**，宿主不碰（否则「上次在线」会被宿主的时钟实现污染）。
- **结算事件的时间戳必须写 `dueTick`**（它本该发生的时刻），**不能写「被补跑时的 tick」**。写后者的话，事件顺序会依赖谁先上线，重放就不再确定 —— 正是 ADR-0024 §2 确定性清单要封死的。

> **落地（M4-T3，#22）**：`packages/core/src/time/settle.ts` —— `createSettler({ state, clock, world?, entity? })` 导出 `settleTo(request)` 这一个推进函数（`request = { toTick, seq, actorId? }`）。
> - **世界层的起点就是驱动侧高水位**，推进即抬高同一个数（`clock.observe`），所以不存在第二个「已结算到哪」；`toTick ≤ 水位` 时世界层一步不走。
> - **实体层**只跑 `request.actorId`，跨度 `[lastSeenTick, max(lastSeenTick, toTick))`，跑完由引擎写回 `lastSeenTick`。
> - 两层各**一个注册位**（`world`／`entity`），今天都是空的接缝，由合成消费者驱动测试；`actorId` 缺省即**宿主心跳**（只跑世界层，§4.1 的调用方显式给 seq）。
> - 未知实体、非法 `toTick` **大声失败**。
> - **状态树新增 `lastSeenTick` 槽**（`state/tree.ts`），`WorldRuntime.addEntity` 用**当前 tick** 种子（不是 0），且 `WorldRuntime` 现在**持有 `clock`**（§2.2「高水位住在驱动世界那一侧」的字面实现）；恢复路径 `attachEntity` 不重新种子（恢复＝重放树）。
> - 推进一次＝两个回调各一次，**与跨度长度无关**（1 万还是 100 万 tick 都是一次，§4.4 的构造性保证）。
> - 驱动侧预检在 `command/pipeline.ts` 的 `parseCommand`，harness 的 `settle` 钩子按上面四步跑（§4.1）。
> - 测试：`tests/settle.test.ts`（22 例）。

### 4.4 大跨度：靠构造性保证，不加数值上限

砍掉区域 tick 之后，留下的原语**没有一个是 O(tick 数)**（补偿结算 O(1)、stage 求值 O(1)、到期桶 O(到期项数)），因此：

- **不加 `settings.time.maxCatchUpTicks`**。截断会让世界状态依赖玩家多久上线一次，违反「世界不因观察而不同」；而且那是个**写死的护栏数字**，会改变游戏语义（跟 `caps.maxConcurrent*` 那种不改变语义的技术护栏不是一类）。
- 替代：**构造性保证 + 一条测试钉死**（推进 100 万 tick，断言迭代次数／耗时上界）。写法照本仓既有口味（「出口不可继承是构造性的」、「不可混淆是构造性保证」）。

> **落地（M4-T4，#23）**：`tests/due.test.ts` 的「构造性保证」两例 —— ①推进 **100 万 tick**、桶里 3 项：断言**世界层回调 1 次、到期处理器 3 次**（迭代次数上界）＋ 耗时 < 100 ms（耗时上界，是迭代上界背后的烟雾报警器：真写了 per-tick 循环会先造出一百万个事件）；②扫 `src/` 与 `content/config/`，断言 `maxCatchUpTicks` **一个都没有**（不是"没启用"，是引擎与调参表里都不存在这个旋钮）。

### 4.5 到期桶的载荷

约束：到期桶是唯一**不能**降级为纯函数的原语（爆炸是副作用，降不了），于是它必须能进存档 —— 否则读档后延迟爆炸凭空消失。而闭包不可序列化。

- 载荷 = **`{ dueTick, payload }`**，`payload` 是 opaque，**引擎不解释**，推进时按 `dueTick` 升序交给**宿主注入的处理器**。⚠️ 那个处理器需要一个 `CommandDeps` 字段才能进引擎 —— 见 §6 O8。这与 §4.1 的「接缝先行」一致，也与拒绝为它提前建具名 effect 表同一个理由（那张表是分支内容那族的问题，今天不存在）。
- `payload` 进存档。引擎只保证**按 `dueTick` 升序、稳定序**触发。
- 「opaque 数据往返存档」在本仓有先例：`Snapshot<T = unknown>`（`types.ts`）。运行时产生的数据本就不进 `content/`，不由 `content:check` 校验 —— 这是它与内容数据的分工，不是漏检。

> **落地（M4-T4，#23）**：`packages/core/src/time/due.ts` 的 `createDueBucket({ fire })` → `DueBucket { schedule, settle, snapshot, restore }`。
> - ⚠️ **§0 术语表与 ADR-0025 写的是 `Map<dueTick, 载荷[]>`，那是概念形状**（强调「按到期 tick 分组」）；实现是一条按 `dueTick` 升序的**扁平表**，同一 tick 的项按布雷顺序触发 —— 两者同义，不是要求引擎真的建一张 Map（一张 Map 反而要为"同 tick 内谁先"再定一条规则）。
> - **宿主处理器由构造参数注入**（`fire(item, emit)`），命令侧只拿得到窄接口 `DueScheduler { schedule }` —— **O8 定死**：新增的是 `CommandDeps.due`（命令靠 `ctx.due.schedule` 布雷），照 `subjectOf` 的先例由宿主注入，不是让命令去读内容注册表；没给 `deps.due` 时布雷**大声失败**（`NO_DUE_BUCKET`），与 `deps.verbs` 缺失同一条纪律。
> - **触发口径是 `dueTick <= span.toTick`** —— 与冷却的 `nowTick >= dueTick` 同一条「now >= due」：跨度 `[fromTick, toTick)` 说的是**流逝了什么**，不是说它末端那个 tick 还没到。已到期而未触发的项在**下一次推进**触发（不是丢弃），事件仍盖 `dueTick`。
> - **事件 tick 由引擎盖**：处理器的 `emit` 类型里 `tick` 是 `never`（`DueEvent`），处理器**无从**写补跑时刻 —— ADR-0034 §3 在这里是构造性的，不是靠记性。
> - **存档边界**：`snapshot()` 返回按 `dueTick` 升序的 `DueItem[]`（规范序，照 `flags` 先例），`restore(items)` 全量校验后才替换（畸形项大声失败、半加载不留）；测试行使其经 JSON 边界往返后 payload 原样存活。⚠️ **v2 的槽位由 #24 一并接上** —— 本票不改 `serializeWorld`／`restoreWorld` 的签名（那是 **O9**，#24 的定夺），到期桶这一侧先把「能存、能读、不解释」这条边界造好。
> - **O4 一并写明**：桶是全局扁平的，`Object.keys(bucket)` 只有 `schedule`／`settle`／`snapshot`／`restore` 四个键，由测试钉死 —— 引擎**不提供**按房间／区域／实体索引到期项的能力，「这个房间的炸弹」是 payload 里带了个 `roomId`，不是一个引擎回答的查询。

### 4.6 冷却

冷却是 `key → 到期 tick` 的**只读表**。判定是 `nowTick >= dueTick` 的 tick 比较，不是定时器回调，天然确定性，成本几乎为零。

- **存哪**：状态树新槽 `cooldowns: Record<string, number>`（我的技能冷却不等于别人的），**进存档、缺即空**（照 §1.4 规则）。
- 为什么 M4 就落它：**长冷却必须跨存档存活**（「门 N tick 后重锁」），不进存档会直接坏掉。
- ⚠️ 它是 M4 里**第二个没有真消费者的状态槽**（第一个是 `derived` 表）。形状被本节钉死、不会错，接受这个代价。

> **落地（M4-T4，#23）**：`EntityState.cooldowns: Record<string, number>`（`state/tree.ts`），`addEntity` 种子 `{}`、`attachEntity` 不重新种子；判定在 `src/time/cooldown.ts`：`cooldownReady(table, key, nowTick)` = `nowTick >= dueTick`、`cooldownRemaining(table, key, nowTick)`（派生、不存；**缺键＝就绪**，没有第三个状态）。进存档走 `tags`／`lastSeenTick` 的同一条规则：**v1 记录里可选、缺即空**；`serializeWorld` 排序键（规范序）；**存在但畸形大声失败**（非对象／值不是非负安全整数 —— `NaN >= dueTick` 恒为假，那件装备会永远"还在冷却"，所以这是写进来了就必须合法，第九类损坏载荷）。引擎侧只有**读**：写是一个赋值，归拥有那个键的系统 —— 这里刻意没有 `cancel`／`extend`，一个带生命周期的冷却对象就是被换掉马甲的 per-object timer。

### 4.7 纯 stage 求值（M4-T4，#23）

`f(startTick, nowTick, stages)` —— ADR-0025 §三给它列了三个需求：**门几 tick 后重锁**（那是冷却，§4.6）、**技能还有多久好**（也是冷却）、**作物 4 阶段**（这个）。

- **落地**：`src/time/stage.ts` 的 `stageAt(startTick, nowTick, stages) → { index, stage, elapsed, remaining, done }`。`stages` 是 `{ id, ticks }[]`，**线性且在最后一段夹紧**：熟了就一直是熟的，不会退回幼苗 —— 这与**环**（§3.2，取模循环）语义相反，所以是两个函数而不是一个带 `cyclic` 开关的函数。
- **O(1) 指跨度无关**：一次减法 + 一次走过若干段（内容里的小常数），不碰 tick 数；离开十万 tick 再回来，问的是同一个函数、同一个答案。无注册、无状态、无回调 —— 没有"阶段变化时发生什么"，也就没有 Evennia 那个「stage 回调 is not guaranteed to be called」的问题。
- **`startTick` 在未来读作"还没开始"**（elapsed 0）而不是失败：这对数据可能来自尚未追上的存档，而开始之前没有阶段可名。

### 4.8 明确不需要

Script 实体、per-object timer、线程、async/await、任何墙钟。

⚠️ Evennia 的 OnDemand **自己也依赖墙钟**（`gametime.runtime()` 用 `time.time()`），且其 stage 回调「**is not guaranteed to be called**」。我们改成纯函数后这两个问题都不存在。

依据：ADR-0022 §5、ADR-0023 §5、ADR-0025 §三

## 5. 自检清单

- [x] 状态是 **typed 对象**，没有 attribute handler / 字符串 key 查找层（M2-T1 `state/tree.ts`）
- [x] 迁移链可用；`derived` 字段**不进快照**、加载后重算（M2-T5；表今日为空，首个消费者是修饰符系统）
- [x] 引擎里搜不到 `Date.now` / `setTimeout`（`tests/engine-purity.test.ts` 机械验证）
- [x] `Clock` 是 **tick 计数**不是毫秒 —— ⚠️ 语义已翻转：它是**引擎高水位读数**，不再是宿主注入的时钟（ADR-0031）
- [x] `Command` 自带 `tick`；引擎维护高水位；`CommandDeps.clock` 已删除（ADR-0031，#20：`src/clock.ts` 的 `TickClock`／`observeDispatch`，`deps.nowTick`）
- [ ] `Rng.getState()` 存在且强制；种子/状态进 v2 存档（ADR-0033）
- [x] 游戏内时间（时辰/刻/季节）是 **tick 的纯函数**，不存储；**日历在内容里**（ADR-0032，#21：`content/config/calendar.json` + `createGameTime`）
- [x] 日历是**一组独立的环**，不是一张扁平分段表（第 19 条）（#21：`rings[]`，多环各自取模）
- [x] `settings` / `calendar` 走与 `dimensions` 同构的通道；缺失时**引擎侧大声失败**，无默认公历兜底（#21：`createContentRegistry(content, { settings?, calendar? })` ＋ `createGameTime`／`createTimeTuning` 的惰性抛错）
- [x] 时间参数零写死：`TICKS_PER_*` 一类换算数字不在引擎源码里（硬标准 1）（#21：换算数字全部住在 `calendar.json`）
- [x] 时间区间用**半开区间 + 显式排序数组**（不是 `if start < end`）（#21：`segmentIndexAt`）
- [x] 冷却存**到期 tick** 不存时间戳；`cooldowns` 槽进存档（#23：`state/tree.ts` 新槽 + `addEntity` 种子 `{}` + 判定 `nowTick >= dueTick`（`src/time/cooldown.ts`，不是回调）+ 规范序与第九类畸形载荷）
- [x] 纯 stage 求值 `f(startTick, nowTick, stages)` 落地：O(1)（跨度无关）、无注册无状态无回调、末端夹紧（#23：`src/time/stage.ts` 的 `stageAt`，§4.7）
- [x] 无任何 per-object timer（六原语里的区域 tick / on-change 在 M4 不落，接缝已写在 §4.1）（#23：三个剩余原语里没有任何一个是每对象定时器 —— 到期桶 O(到期项数)、冷却是 tick 比较、stage 是纯函数）
- [ ] DoT 类机制用**观察时补偿结算**，不是定时器
- [x] 离线结算与在线心跳走**同一个推进函数**（只差跨度），不是两套代码（ADR-0032 覆盖 ADR-0016 §4）（#22：`settleTo` 一个函数，跨度是参数）
- [ ] 离线补算**只补资源与基础熟练度**，不自动战斗、不推层、不产掉落（ADR-0016 §4 未被覆盖的那一半）—— 随第一个真消费者钉死
- [x] 推进复杂度是 O(事件数) 不是 O(tick 数)，由测试钉死（无 `maxCatchUpTicks`）（#22 钉「一次调用覆盖 100 万 tick、跨度不被截断」；#23 补齐**迭代次数上界（世界层 1 次／处理器 3 次）＋ 耗时上界**，并机械断言 `src/` 与 `content/config/` 里 `maxCatchUpTicks` 一个都没有 —— §4.4）
- [x] 世界层与实体层**分层推进**，实体用自身 `lastSeenTick`（ADR-0034）（#22：`settleTo` 两层 + 甲乙跨度场景）
- [x] 结算事件的时间戳写 **`dueTick`**，不写补跑时刻（#22：`SettleDraft.tick` 必填，测试钉死「到期 300、补跑 1000 → 事件写 300」）
- [x] `settleTo` 产生的事件与触发它的命令**同 seq，且排在命令自身事件之前**（#22）
- [ ] v2 迁移存在且为迁移链首条真实迁移；**无 v2 → v3 连迁**
- [x] 宿主心跳（无命令的推进）由调用方**显式给 seq**，与命令 seq 同一单调空间；不伪造 `actorId: ""` 的系统命令（#22：`settleTo` 不传 `actorId` 即心跳，只跑世界层）
- [x] **`invalid` 不推进世界、其 tick 不抬高 `maxTick`**（`ok`／`rejected` 才推进）；有一条测试钉死「刷无效输入不加速世界」（#20，`tests/tick.test.ts`；#22 补上「连推进函数都不调用」这一半——驱动侧预检）
- [x] 每个 `GameEvent` 带 **`tick`**：命令事件写它看到的「现在」，结算事件写 `dueTick`（**O1 已定案，#22**；规则见 `spec/01` §5.0）
- [x] `addEntity` 为 `lastSeenTick`（= 当前 tick）与 `cooldowns`（= `{}`）种子，照 `tags` 的先例（#22 落前半；#23 落 `cooldowns`）
- [ ] `serializeWorld` 的规范序覆盖新槽（`nowTick`／`rngState` 为标量；`cooldowns` 的键排序）

## 6. 开放问题

> ⚠️ **O8 与 O9 会阻塞实现**，拆票时必须落到具体某张票上（O9 → 存档 v2 那张；O8 → 跑 `settleTo` 的那张），否则开工即卡。其余 O1–O7 在票内明确即可。

| # | 问题 | 现状与倾向 |
|---|---|---|
| ~~O1~~ | ~~**`GameEvent` 要不要带 `tick`**~~ | **✅ 已定案（#22）**：**加，且所有事件都带**。命令事件写它看到的「现在」（高水位），**结算事件写 `dueTick`** 而不是补跑时刻 —— 写后者会让事件顺序依赖谁先上线，重放不再确定。落点 `types.ts` 的 `GameEvent.tick`（必填）＋ `pipeline.ts` 的盖章，规则见 `spec/01` §5.0 |
| ~~O2~~ | ~~**`seq` 与 `tick` 不同序时谁定顺序**~~ | **✅ 已定案（#20）**：**seq 定投递顺序、tick 定世界时间**，二者独立、不互相校验。见 §2.5 |
| ~~O3~~ | ~~**`settings.time` 缺**组内某个键**（如 `regenPerTick`）怎么算~~ | **✅ 已定案（#21）**：缺**组**失败（缺 `settings` 表或缺 `time` 组）、缺**键**由消费该键的系统自己大声失败，**引擎绝不替它猜默认值**。落点 `src/time/tuning.ts` 的 `createTimeTuning(settings).number(键)`，两条错误文案分别点名「组」与「键」 |
| ~~O4~~ | ~~**到期桶的项没有锚点**~~ | **✅ 已定案（#23）**：桶**保持全局扁平**，「这个房间的炸弹」靠宿主把 `roomId` 塞进 opaque payload —— 已写进正文本节：**引擎不提供按房间／区域／实体索引到期项的能力**，并由一条测试把 `DueBucket` 的键列表钉死（`schedule`／`settle`／`snapshot`／`restore`，多一个键即红），避免将来误以为有 |
| O5 | **`tickSeconds` 归谁** | ADR-0016 §4 提到「固定步长（`content/config/`：`tickSeconds`）」。它是**真实秒**，属于宿主把墙钟翻译成 tick 的参数，**引擎不读** ⇒ 不应进 `content/config/settings.json`（那是给引擎的 TUNING）。⚠️ 连带一条：若确认只有宿主用它，那它连 `content/config/` 都不该待 —— `content/` 是引擎读的东西，放进去会让人误以为引擎消费它。落点由宿主票定 |
| O6 | **要不要时间谓词**（如"只在夜里能进"） | `spec/02` §5.3 谓词表里今天**零**时间相关谓词（全文 `tick` 零命中）。倾向：M4 **不**加，等第一个内容真的需要时按既有三处同步流程加（引擎／`condition.schema.json`／spec/02 §5.3） |
| ~~O7~~ | ~~**创建 `calendar.json` 那张票的文档同步债**~~ | **✅ 已在 #21 一并改**：`docs/agents/content.md` 的 config 清单（四类 + 新增「日历集合」字段约定节）、`docs/spec/06` 状态行与 `spec/00` 的 schema 总数口径（19 → **20**、`config` 三类 → **四类**、14 → **15** 待重估）、`HANDBOOK` 三处数字与 `content/config/` 文件数。**编辑器表单那一处**待 `apps/editor` 脱离占位后随行 |
| ~~O8~~ | ~~**★引擎侧要用到 calendar／到期桶处理器时，走什么通道**~~ | **✅ 已定案（#23）**：**新增 `CommandDeps.due?: DueBucket`**，照 `subjectOf` 的先例**由宿主注入**（不是让命令执行函数读内容注册表），命令侧经 `ctx.due.schedule(dueTick, payload)` 布雷；`ctx.due` 只暴露窄接口 `DueScheduler`（能布雷，不能触发、不能窥视），缺 `deps.due` 时布雷**大声失败**（`NO_DUE_BUCKET`，与 `deps.verbs` 缺失同律）。**触发**那一半的处理器（`fire`）在 `createDueBucket({ fire })` 构造时注入 —— 引擎全程不知道 payload 是什么。**calendar 那一半**走的是另一条既有通道：注册表 `calendar?` → `createGameTime`（#21） |
| O9 | **★`serializeWorld`／`restoreWorld` 的签名怎么容纳 `nowTick`／`rngState`** | 这是**会卡住实现**的一条，三选项与倾向见 §1.5 约定 3（倾向 `serializeWorld(world, meta)` ／ `restoreWorld → { state, meta }`）。**拆票时必须落到具体某张票上**，否则 T6 开工即阻塞 |
| O10 | **`runCommand` 算出的 `nowTick` 要不要回传给驱动侧**（#20 复查新提） | 今天 `runCommand` 内部算了 `max(deps.nowTick, command.tick)` 却**不回传**，驱动侧必须自己再调 `observeDispatch` 才能把水位持久化。**忘调的后果是「世界静默不前进」，不报错** —— 属最难查的一类（所有时间判定仍自洽，只是永远停在旧水位）。两条路：(a) 给 `ok`／`rejected` 结果加一个 `nowTick` 字段（动 `spec/01` §2.2 的结果形状，且 `invalid` 不给）；(b) 不动形状，约定「驱动侧一律经 `observeDispatch`」，由 #22（`WorldRuntime` 侧）与 #26（宿主 Authority）各自照做。倾向 **(b)** —— 心跳（无命令）也要抬水位，它本来就没有 `CommandResult` 可用，(a) 救不了那一半。**归 #22／#26**。⚠️ **#22 已落驱动侧那一半**：`WorldRuntime` 现在**持有 `clock`**、`addEntity` 从它取当前 tick 种子，测试 harness 的 `settle` 钩子按「预检 → 推进 → 分发 → `observeDispatch`」四步跑（§4.1）；**宿主 `Authority` 那一半仍归 #26**，它照同一四步做即可，**不要**指望 `runCommand` 回传水位 |
