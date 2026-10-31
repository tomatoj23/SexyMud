# 04 · 状态、存档、时间与调度

> **状态**：迁移链骨架**已实现**；**§1 已实现**（状态树种子 M2-T1：`EntityState {id, locationId, flags}` ＋ `WorldState`（`packages/core/src/state/tree.ts`），动态占用进「同一棵树」，`WorldRuntime` 持有并就地变更；flags 槽位随门禁消费者落地；**`tags` 槽已落（M3-T5／#17，形状 = `TagMap`，与内容侧同一模型，见 spec/03 §5.1）**；**`name` 显示字段已落（#52：可选、缺即无名、默认名应用点在宿主——槽位表第三种缺席策略 `unfilled`，见 §1.4）**；**`attrs` 数值槽与 `combat` 战斗会话槽已落（#56：attrs＝`Record<string, number>`、键清单归 `content/config/character.json` 声明表、引擎零认识具体键；combat＝挂玩家实体的战斗会话（NPC 不进树，D2）、含毒记账 `dot`、随档持久读档续战——两槽均 v2 内中途落地不开 v3，见 §1.4）**；states/skills 随各自系统进树。**序列化与快照 ＝ M2-T5 已落、M4-T5 升到 v2**：`state/snapshot.ts`（`serializeWorld(world, meta)`／`restoreWorld(snapshot) → { state, meta }` ＋ v2 形状，v1 仍可读并经首条真实迁移升级）＋ `state/derived.ts`（`derived` 契约）＋ `save/migrations.ts`（`SAVE_VERSION` = 2，`migrations[1]` 是链的首条真实迁移）＋ `WorldRuntime.attachEntity`（恢复＝重放树＋重挂实例），见 §1.4／§1.5）＋ **云存档 `CloudSaveStore`（#29，`apps/web`，`SaveStore` 的远端实现，见 §1.6）＋ 云存档身份与登录（#30，账密会话＋CloudBase 传输适配器＋同步与裁决，见 §1.7）＋ 本地存档导入（#33，D7 保命通道的对偶，见 §1.8）**。**§4.2 观察时补偿结算的首个真消费者已落（#56：木·中毒 DoT，`combat/session.ts` 的 settle handler——自检 :421/:423 两行随批勾选收口）**。
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

### 1.4 快照 v1（M2-T5 已落；v1 仍是**可读**的输入，迁移链把它升到 v2）

`packages/core/src/state/snapshot.ts`：v1 的形状是 `SaveDataV1 = { entities: Record<string, EntityRecord> }`；**当前写出的版本是 v2**（§1.5），签名见那里。

- **载荷就是状态树**，不是平行结构：`EntityRecord = Omit<EntityState, DerivedEntityKey>`（`tags`／`attrs`／`combat`／`lastSeenTick`／`cooldowns` 例外地可选——见下条；`name` 也可选且**缺席不填**〔#52〕——见下条末句）。⚠️ 记录**故意不编号**：v1 与 v2 写的是同一份 per-entity 记录，v2 只加了**顶层**槽。序列化在树之上只加四样：① `version` 戳（迁移链入口）② `derived` 切分（见 §1.3）③ **规范序**（entities 按 id 升序、flags 排序、**tags 维度键升序 + 键列表排序去重**、**attrs 键升序**〔#56，照 cooldowns 先例〕、**combat 字段序固定**〔#56：记录按字段重建，无战斗不写键〕、**cooldowns 键升序**、**due 按 dueTick 升序**）——两个相等的世界存出**同一份字节**（ADR-0024 §2），确定性引擎的历史才可 diff、可比对。**规范序由 `serializeWorld` 负责，不要求写入方保持有序**（照 flags 的先例）④ **世界标量**（§1.5：`nowTick`／`rngState`／`due`）。
- **新槽在恢复时可选、缺即空；`flags` 保持必填**（M3-T5 定案，写入此处以免同一份校验器两种口径被当 bug）：`tags` 是 v1 存档中途长出的槽——它落进树的那天（#17）之前写下的存档都没有这个字段，而「未显式写入的字段不落盘」（ADR-0022）意味着**缺 = 空**，不是损坏；`restoreWorld` 显式补 `{}`。`flags` 相反：**v1 起每份存档都写过它**，放宽只会白丢一条损坏检测。规则一句话：**在当前版本内中途落地的槽，恢复时一律可选**——「可选」限死含义：迟到可选槽的 reader **只容忍缺席、不容忍畸形**（#40 落字；必填槽的缺席今天就是拒，不外扩）。这条律管的是**三个载入读者**（`readSaveData`／`restoreWorld`／`migrations`）；展示摘要 `summaryOf`（#46，`save/summary.ts`）不是第四个——它对缺席**和**畸形**字段**一律答「无摘要」（键缺席；`version` 照答），判损坏始终是载入路径的裁决。**`name`（#52）是可选的第三种读法**：可选**且不填**——缺席＝无名，不是「默认名」；默认名（如「少侠」）的应用点在**宿主**（Q5 题材词红线），引擎不写也不猜，`addEntity` 不种子、`restoreWorld` 不补、迁移不记。写侧同律：`serializeWorld` 仅在 name 为**非空字符串**时写入（空串与非字符串＝无名不落盘——引擎不写读侧会拒收的键，#52 审计 N-1 owner 裁定 2026-10-25）。
- **槽位容忍一张表（#40，`state/slot-rules.ts` 的 `SLOT_RULES`）**：「缺席算空／必须有／缺即无名不填／畸形即拒／迁移填什么」收进**每槽一行**的声明——缺席策略（必须有／填默认／**不填**〔#52 的 `unfilled`：缺席即缺席、默认归读者侧——现有两行：`name`（缺即无名）、`combat`（#56：缺即无战斗，会话不是可发明的空对象）〕）、畸形校验器、迁移是否记缺席（`absent.migrate`）；`readSaveData`／`restoreWorld`／`migrations` 三处消费点各取所需、全是表驱动循环，**新增槽位＝表里一行＋（若需）校验器＋类型字段，三处零手改**（照 `DERIVED_ENTITY_KEYS` 律的「不做运行时注入」半边；类型字段是独立编辑点）。默认值**只声明一处**——迁移与恢复两处填空读同一份，防御性重复填空自此消解。`id`（键与记录的交叉核对）与 `entities`（记录所在的容器）是结构不是槽，保持手写。**`attrs` 槽已随 #56 落地**（它的四条规则当年就能被表形状表达，如今照章执行：缺席→`{}`、畸形即拒〔值须有限数，第十四类〕、无迁移行；**键规范序不在表行**——归 `serializeWorld` 的规范序清单照 `cooldowns` 先例扩一条「attrs 键升序」）。**`combat` 战斗会话槽同批落地（#56，D2/D11）**：挂玩家实体、随档持久（NPC 死亡跨档）、读档可续战——毒记账 `dot: { effectId, startTick, applied, perTick }` 同槽（`effectId`＝读档续毒的条目回溯键，interval/maxPulses 不落盘；`perTick`＝挂载时算定的跳伤，T11②）；C2 在**同一槽**上长节奏字段，不推倒改名。两槽都照 `tags` 先例**在 v2 内中途落地、不开 v3**（§1.5「不做 v2→v3 连迁」不变）。
- **NPC 不在快照里，是构造使然而非过滤**：静态在场直读放置清单（ADR-0028 §1），未显式写入的字段不落盘——这里没有 NPC 行可删，也永远不该有。
- **恢复＝重放树，不是创建**：`restoreWorld` 只重建状态（`migrateSnapshot` → 形状校验 → 逐实体重建 → 重算 `derived`）并返回 `{ state, meta }`（§1.5），重挂 hook 载体走 `WorldRuntime.attachEntity`——载入五步已收成 `assembleWorld` 一个入口（§1.5 约定 3 邻接，#37），它替宿主循环这一步、手拼照旧合法；**不跑** creation 两层（跑 `at_object_creation` 等于用代码默认值覆盖存档，正是两层接缝要防的反转）。挂载**顺序无关**（被携带者可先于携带者挂载），恢复后的位置必须仍能解析——内容漂移大声失败，不做半解释状态（**引擎律不改**；#52 给宿主一个装配**前**的例外：`continueGame` 预检存档房 id 在当前内容包查无此房 ⇒ 宿主改写记录落起始房＋一行提示〔提示文案住宿主，Q5〕，引擎从未见到漂移——见 #48 D10；载荷损坏仍走本节大声失败口径，两类不混判）。
- **大声失败**（`tests/snapshot.test.ts` 逐条行使）：**版本**不合法（大于 `SAVE_VERSION`／小于 1／非数字；**NaN 与小数同罪**——`typeof NaN` 是 `number`，曾绕过守卫被静默当当前版本恢复，#29 复查钉死，`migrations.test.ts` 行使）；**载荷** `data` 非对象、缺 `entities`、实体键为空、记录非对象、无 `locationId`、flags 非字符串数组、记录 id 与键不符——**七类**损坏载荷全部在加载时抛（ADR-0003）；**tags 存在但畸形**（非对象、某维度的键列表非字符串数组）是第八类（#17 起，与第七类同律：写进来了就必须合法）；**cooldowns 存在但畸形**（非对象、某键的值不是非负安全整数）是第九类（#23 起，同律）；**`nowTick`／`rngState` 存在但畸形**（不是非负安全整数／不是 uint32）是第十、十一类（#40 起，同律——**ADR-0033 §4「损坏不报错、比多养一条检测规则便宜」的权衡自此推翻**，「缺即空」半边不变）；**`lastSeenTick` 存在但畸形**（不是非负安全整数）是第十二类（#40 起，同律）；**`name` 存在但畸形**（不是非空字符串——空串是写下来的主张、不是无名）是第十三类（#52 起，同律）；**`attrs` 存在但畸形**（非对象、某键值非有限数）是第十四类（#56 起，同律——NaN 会静默毒化每一条读它的公式，与冷却非 tick 同罪）；**`combat` 存在但畸形**（非对象、`targetNpcId` 非非空串、`targetHp` 非有限数、`targetDead` 非布尔、`dot` 若在则 `applied` 非非负整数等）是第十五类（#56 起，同律——战斗会话是对一场战斗的主张，主张坏了就拒收）。
- **测试**：`tests/snapshot.test.ts`（形状钉死／往返经 JSON 边界后位置与 flags 存活／字节稳定与幂等／`derived` 表驱动排除＋加载后重算／未来版本与七类损坏载荷大声失败／NPC 不入档且加载后仍在场／重挂不跑 creation 两层、顺序无关、重挂后继续可玩／**tags 往返与规范序、旧存档（无 tags 字段）缺即空、第八类畸形 tags 大声失败——M3-T5**）。**cooldowns 的往返／规范序／缺即空／第九类畸形**在 `tests/cooldown.test.ts`（#23，与它自己的槽同居）。**#40**：第十至十二类畸形标量拒绝（`nowTick`／`rngState` 在 `tests/save-v2.test.ts` 随标量住、`lastSeenTick` 在 `tests/snapshot.test.ts` 随记录住）、缺席填空零变化与「同槽容忍缺席、拒绝畸形」（`tests/snapshot.test.ts`）、迁移错误类别保真（`tests/migrations.test.ts`：非对象记录留原物、加载报「记录非对象」）、**新增槽位演练**（`tests/slot-rules.test.ts`：表加一行即接通三读者）。**#37**：装配入口与采集对称面（`tests/assembly.test.ts`：五件套完备清单**逐效果**钉、无顺序断言、live-bucket、`recomputeDerived` 透传、两面往返）；两份手拼改调入口（`tests/save-v2.test.ts` 端到端、`apps/web/tests/offline-catchup.test.ts`）——手拼面仍由 `tests/snapshot.test.ts`、`tests/cooldown.test.ts` 与 `tests/save-v2.test.ts` 其余用例行使（additive 红线）。**#52**：`name` 槽往返／无名实体字节不变（记录键全列）／旧档缺字段读回无名／第十三类畸形（`tests/snapshot.test.ts`）＋ `unfilled` 策略三读者（`tests/slot-rules.test.ts`：缺席不填〔toStrictEqual〕、在场透传、迁移不记）。

### 1.5 快照 v2（M4-T5 已落，#24；ADR-0033）

v1 里没有引擎 tick 与 RNG 种子；它们的消费者就是本章 §2–§4，所以那一天是 **v2 + 一条迁移**，不是往 v1 形状里静默加字段。`SAVE_VERSION` 现为 **2**。

**载荷增加四样**：

| 槽 | 位置 | 语义 |
|---|---|---|
| `nowTick` | 顶层 | 引擎高水位（§2.2）。**必须存**：不存则恢复后时间倒退，`nowTick >= dueTick` 恒为假，**冷却会永远不到期**（不是"失效"，见下面约定 2） |
| `rngState` | 顶层 | `Rng.getState()` 的读数（§2.4）。mulberry32 的状态就是一个 uint32 |
| `due` | 顶层 | 到期桶待触发项 `[{ dueTick, payload }]`，按 `dueTick` 升序（§4.5）。⚠️ **ADR-0033 §2 只列了三样** —— 这一样是 #23 的交接：到期桶是唯一无法降级为纯函数的原语，不存则读档后延迟爆炸凭空消失 |
| `lastSeenTick` | 每实体 | 该实体**上次被结算到**的 tick（§4.3 两层推进）。⚠️ **槽已随 #22 落树**（比 v2 早）：v1 存档里它是**可选**的（照 `tags` 的先例，§1.4），v2 起由迁移给默认值 |

> **落地（M4-T5，#24）**：`SaveDataV2 = SaveDataV1 & { nowTick, rngState, due }`；`EntityRecord` 不编号（v1／v2 同形，见 §1.4）。迁移链 `migrations[1]` 是它的**首条真实迁移**（此前链机制就绪但为空，ADR-0003 要求不造假迁移）。迁移的**总规则**写在 `save/migrations.ts` 文件头并由测试钉死：**只补缺失的，绝不覆盖已有的** —— ADR-0033 §3 写「`lastSeenTick = nowTick`」时那个槽还不存在于 v1，而 #22 之后写的 v1 存档**带着**它；把 777 覆成 0 等于白送那个玩家一整个世界的离线补算。

**种子（照 `tags` 的先例，别漏）**：`WorldRuntime.addEntity` 今天把树的每个槽都种子一遍（见其实现注释：「an absent `tags` would put a `??` in front of every hasTag read for no reason」）。`lastSeenTick` 与 `cooldowns` 同理必须在 `addEntity` 里种子 —— **`lastSeenTick` 种子为当前 tick**（新实体从现在开始，不是从 0），`cooldowns` 种子为 `{}`。

**四条约定**：

1. **迁移补默认值**（v1 → v2）：`nowTick = 0`、`rngState = 0`、`due = []`、`lastSeenTick = 0`（「从未结算」；ADR-0033 §3 原写 `= nowTick`，与 0 同值仅因迁移补出的 `nowTick` 是 0——#24 起实现就是常量 0，#40 收进表声明），**仅在记录原本没有它时**才补。补的是「这份存档写下时那个字段还不存在」这一事实，不是猜测玩家状态。
2. **恢复时一律「缺即空」，不为 v2 新增槽加特例** —— 与 §1.4 那条规则同一个口径。⚠️ 代价要说准：v2 存档若 `nowTick` **丢失**不会报错，游戏当成第 0 tick 继续跑 ⇒ 判定 `nowTick >= dueTick` 恒为假，**冷却不是「失效」，而是永远不到期**（技能要再等满 `dueTick` 个 tick）——「缺即空」的这半边不变。**但「损坏也不报错」的半边已随 #40 推翻（D2）**：迟到可选槽的 reader **只容忍缺席、不容忍畸形**，`nowTick`／`rngState`／`lastSeenTick` **畸形即拒**（第十至十二类，§1.4）；静默容忍坏档不再是合法体验（字符串 `nowTick` 从此不再流进 `meta`）。ADR-0033 §4 原以「比多养一条检测规则便宜」容忍损坏，#40 判定「被告诉载入成功就必须真能玩」优先，pre-release 是收紧的最后窗口（被否的「维持便宜口径」路线留痕在案）。
3. **✅ O9 已定案（#24）—— 顶层槽的进出通道**：定 **(b)**，与 §2.2 的归属一致（高水位住在驱动世界的那一侧，不在 `WorldState` 里），且不要求 `WorldState` 承担它今天不承担的语义：
   ```
   serializeWorld(world, meta) → Snapshot<SaveDataV2>      // meta 必填：没钟的世界没装载过
   restoreWorld(snapshot, options?) → { state, meta }      // 树与世界标量一起交回
   WorldMeta = { nowTick, rngState, due }
   ```
   被否的另外两条：(a) 把标量并进 `WorldState` —— `WorldState` 会从「实体树」变成「实体树 + 世界标量」，每个以树为参数的函数都要背一口它不拥有的钟；(c) 存档读写都经 `WorldRuntime` —— 要求宿主全程走 runtime，纯对象测试路径还得再造一个等价物。
   `meta` **必填**（不是可选）：没有 `nowTick` 的 v2 存档会让世界时钟归零，没有 `rngState` 会让随机流重来 —— 两者都是静默且不可恢复的。写入侧的 `nowTick` 还要过 `assertTick`。
   **装配与采集入口（#37，`state/assembly.ts`）**：载入五步（`restoreWorld` → `createWorldRuntime` → `createSeededRng` → `bucket.restore` → `attachEntity`×N）收成一个入口 `assembleWorld({ snapshot, registry, bucket, entities, restore? }) → { runtime, rng, bucket, meta }`，采集对称面 `collectMeta({ runtime, rng, bucket }) → WorldMeta` 汇三槽（nowTick/rngState/due）交给 `serializeWorld`——此前「世界→meta」手工汇齐的三处（生产 `localAuthority.snapshot()`／测试 `save-v2`／文档示例）改调它。**顺序不立契约**：次序收成入口内部实现细节（数据依赖几乎全强制，唯一自由的 attachEntity 先后本就无关），契约是五件套**完备**——漏一步/乱序结构上不可能、×N **漏挂也大声**（每个恢复实体必须带实例，半重建的世界拒绝装配——部分世界走手拼）（#35 driver 同哲学：约定变结构）。**失败契约**：装配半途失败**不动调用方的活桶**（唯一调用方拥有的可变件——`bucket.restore` 收尾：给进来的东西要么全变、要么不变，§1.4「大声失败、不做半解释状态」）。**additive 红线**：`restoreWorld`/`serializeWorld` 原样、手拼路径不封死、`RestoreOptions.recomputeDerived` 透传；live-bucket 语义不变（传进的活桶即返回的活桶）。将来新顶层槽走 `WorldMeta` 扩展（读侧沿「缺即空」宽容律，§1.4），不塞 `WorldState`。
4. **不做 v2 → v3 连迁**：v2 的形状这一次要想全。这也是这条迁移链**第一次被真实迁移检验**（`SAVE_VERSION` 从 1 升到 2，链机制此前为空，不造假迁移）。

**nicks（玩家层别名，`spec/02` §8 至今未勾）不同趟** —— 它是**玩家层**不是实体层；把两层的东西塞进同一次迁移，正是走向「v2 → v3 连迁」的最快方式。等别名票自带那趟。

### 1.6 云存档：`SaveStore` 的远端实现（#29；ADR-0036）

`CloudSaveStore`（`apps/web/src/game/cloudSaveStore.ts`）只是端口的**另一个实现**（ADR-0017 §5）：**同一份快照文本**——存的就是 `JSON.stringify(serializeWorld(...))`，本地与云端存档**互换可读**，导出／导入路径不变（ADR-0002 §11／§21 的退出路径）；**同一条迁移链**——`load()` 原样返回、**绝不迁移**，低版本照旧由 `restoreWorld` 升级、高版本照旧大声失败（云端让「旧客户端读到新版本存档」成为日常，答案仍是失败：v2 的世界标量在 v1 无处安放，静默丢弃比失败更糟，ADR-0003）。`packages/core` 零改动。

**六条定案（#29 开票时明示「不预设结论」，由实现会话定案；编号与票面六定案点、ADR-0036 的 D1–D6 同号）**：

1. **（定案点 1）身份随会话，不随存档**：跨设备续档要的是**跨设备的账号标识**——匿名设备 ID 不够（它只覆盖单机云备份）。`CloudSaveStore` 只认注入的传输端口 `CloudSaveTransport`，端口在构造时绑定**一个已认证会话**：身份是传输层的属性，不是存档的属性。登录超出 `SaveStore`（ADR-0018 的端清单不含 Auth），进 Auth 票（**#30**，阻塞边已挂）。快照**不写**账号标识：可导出 JSON 不泄露身份，格式不因云而变。
2. **（定案点 2）写冲突 = 乐观并发 CAS，绝不 last-write-wins**（端口不扩版本语义——core 零改动）：远端记录带**不透明** `revision`；`save()` 永远是对**本实例最后观测版本**的 CAS（`load()` 的返回即观测；**从未 `load()` = 观测「空」⇒ 只允许新建**——新游戏首存的通道，也是「新设备不许盲覆盖旧进度」的闸门）。冲突 ⇒ `CloudSaveError("conflict")`：写不落、观测保持陈旧，宿主重新 `load()` 才能再写；裁决权（继续本地玩／重拉／另存）交宿主。⚠️ **同一实例的读写排队串行**（#29 复查收口）：重叠的自动存档不会互相误报冲突——`conflict` 从此只属于「**另一会话**写了」，同实例排队后按序 CAS 全部落地。随行实现细节：**revision 在读取成功即武装**（哪怕文本损坏）——否则损坏的云存档永远无法经 `save()` 修复／重置（「load 抛 corrupt 后 save 覆盖」是刻意保留的修复路径）。**#32 收口（武装规则只住 store）**：宿主不再自行反推武装次序——`CloudSaveStore.replace(snapshot)` 一个操作收掉「观测＋修复写＋撞 conflict 再分辨」整段舞（**单个排队单元、内部直调传输端口**，不经公共 `load`/`save`——否则内层排队挂在外层 promise 上死锁、同实例交错还会把自家写误报成 conflict），返回结果自带判定：`saved`（创建／替换／修复都是它）｜`conflict`（真竞速）｜`unrepairable`（锚损坏且行未动：没有任何写能 CAS 成功）。`load`/`save` 端口方法照旧（红线：core `SaveStore` 零改动）；`replace` 是宿主侧**换形**（`CloudSync.cloud` 打字为 `load`＋`replace`）。
3. **（定案点 3）跨版本：云端不迁移，迁移只有一条链**：`load()` 原样返回、绝不改写；低版本照旧由 `restoreWorld` 升级、**降级照旧大声失败**（云端版本 > `SAVE_VERSION` ⇒ 既有「unsupported save version」；v2 标量在 v1 无处安放，静默丢弃比失败更糟）。两级损坏分级不混：传输层损坏（记录形状不对／非 JSON／非 `{version, data}` 信封）= `CloudSaveError("corrupt")` 在 `load()` 就抛，载荷级损坏仍归引擎十二类（`restoreWorld`）。**损坏两形态由 store 操作结果分型（#32）**：文本损坏但 revision 已武装 ⇒ `replace` 即修复（`saved`，#29 修复路径换乘）；revision 锚损坏且行未动 ⇒ `unrepairable`——两形态的分辨只住 store，宿主拿结果分型、不再判别记录内部（判定规则见 §1.7 定案点 8）。
4. **（定案点 4）云存档的后端仍是 CloudBase**（ADR-0002 §2 的适配层路线在「只做云存档」范围内仍有效；ADR-0017 翻掉的是全量后端）——**适配器与 `@cloudbase/js-sdk` 已随 #30 落地**（见 §1.7；依赖只在能被行使时才引，ADR-0007）。适配器义务是 `CloudSaveTransport` 契约：`write` **原子 CAS**（revision 不符 ⇒ 冲突拒绝、写不落）、revision 不透明、错误分类（未知后端错误归 `"network"`）。
5. **（定案点 5）失败抛错，不静默降级**：远端空 = `null`（**缺席不是失败**）；断网／鉴权失效 = 拒绝且**可分辨**（`"network"` 重试／`"auth"` 重新登录）；`load()` **绝不返回旧快照冒充成功**，`save()` **绝不静默降级到本地**——「玩家以为存了、其实没同步」只能靠大声拒绝堵住，宿主的本地镜像／同步指示必须是**显式**策略。
6. **（定案点 6）G6 同趟补上**：宿主侧存档编码往返与云存档是同一条缝（JSON 文本进、JSON 出——localStorage 字符串、云存档文本同律）；`local-save-store.test.ts` 补 localStorage 字符串缝的往返（中文／surrogate pair／emoji／孤 surrogate）、损坏大声、缺席为 null，`cloud-save-store.test.ts` 补同型往返 —— `spec/07` 的 **G6 转已覆盖**。⚠️ 真 WebView 存储层的弄坏风险属环境，不属代码缝。

> **落地（#29）**：`apps/web/src/game/cloudSaveStore.ts`（`CloudSaveStore` ＋ `CloudSaveTransport` ＋ `CloudSaveError`；**#32 补 `replace` ＋ `ReplaceResult` 三分**）；测试 `apps/web/tests/cloud-save-store.test.ts`（往返与格式同一性、本地↔云端互换、CAS、失败语义、迁移透传与降级大声、Unicode、**#32 的 replace 三分与边角分辨**）＋ `local-save-store.test.ts`（G6、**#32 的 unavailable/corrupt 分类**）。`localSaveStore.ts` 注释的票号已回填并改指已落地的云实现。

### 1.7 云存档身份与登录：会话、CloudBase 适配器、同步与裁决（#30；ADR-0037）

#29 的传输端口绑定「一个已认证会话」，本节答会话从哪来、适配器怎么兑现 CAS 义务、宿主接线怎么不撒谎。**八条定案（编号与 ADR-0037 的 D1–D8 同号；票面三定案点 = D1–D3，D4–D8 是实现义务的落地口径）**：

1. **（定案点 1）登录方式 = 账密（邮箱／用户名＋密码）**：CloudBase 内置身份（`signInWithPassword` 两式皆认），零外部资质（微信要开放平台企业认证、手机号要短信签名与模板审核、自定义登录要自建账号服务）。**注册 = 邮箱验证码两步**（SDK 现实：`signUp` 的校验器只要邮箱/手机号，自助建号必经 `verifyOtp`；用户名直注不存在，用户名作登录名随注册捎带或控制台预置）。手机号／微信／自定义登录是后续可加的**身份源**——「身份随会话」（§1.6 定案点 1）天然支持换源，本侧代码不动。
2. **（定案点 2）匿名登录不提供**：云存档显式要求登录，未登录 = 纯本地（`LocalSaveStore` 照旧）。匿名身份是设备级的，「匿名云备份」的承诺与「跨设备续档」混淆——换机即丢档是「以为存了」洞的变体。云存档永远意味着「换机能续」。
3. **（定案点 3）登录与本地存档不自动上传、不合并；同步是显式动作**（上传／下载／裁决）。登录后只**探测展示**两边档（存在／版本／进度 tick——自 `SlotView` 的 summary 字段读出、不钻 payload，#46）；两边**逐字节相同 = 无分歧**。合并 = 发明 UX（快照是整体 JSON，无字段级合并语义）；自动上传违背显式策略（§1.6 定案点 5）。
4. **适配器 CAS 形态 = 混合两路**：**更新走条件更新**（`where({_id, revision}).update(…)` 看 `updated` 计数；`updated ≠ 1` ⇒ `conflict`、写不落）；**新建走事务**（`get` ⇒ 占用即 `conflict`；`create` insert-only ⇒ `commit`）——「仅当不存在才插入」没有查询形态，正是「做不到原子就上事务」的那半边。**revision = 每次写入新铸的不透明 token**（注入 minter，永不解析、**永不读回**——读回有竞态，会把别人的 revision 认领成自己的观测）；**文档 `_id` = `${uid}~${key}`**（身份落存储层的账号命名空间；快照仍不写账号标识。两段限 `[A-Za-z0-9._-]`、`~` 不出现在段内 ⇒ 拼接无歧义且 URL 安全——SDK 把 doc id **原样拼进 REST 路径**，`/` 会让读静默变「无存档」）；集合名可配（默认 `save_slots`）。
5. **错误分类 = 最小信号表，不猜错误字符串**：UNAUTHENTICATED 信号（`errorCode === 16`（`AuthErrorCode.UNAUTHENTICATED`）／`code ∈ {"unauthenticated", "UNAUTHENTICATED", "login_required"}`（`ErrorType` 枚举词）／HTTP 401（`statusCode`/`status`，数字或字符串））⇒ `"auth"`；CAS 落空 ⇒ `"conflict"`（出自逻辑判断；**唯一例外**：新建竞速的 `already_exists`——后端在命名 CAS 条件，也是「不许静默覆盖」的闸门）；**其余（含未知后端错误）⇒ `"network"`**（未知按可重试读）。⚠️ **带 `code` 的网关错误是 resolve 不是 throw**（SDK 现实）——每个结果先验 `code` 再读数据，否则一次鉴权失败会以「无存档」流出去（D8 禁的静默降级）。登录表单的失败分类同律（**枚举词不是猜测**）：`AuthErrorCategory`／`ErrorType` 的凭据类枚举词 ⇒ 表单提示分类（`invalid-credentials`／`already-exists`），其余归 `"network"`。**信号表收一张（#43）**：SDK 错误词汇的**分类＋判定收进 `cloudbaseSignals.ts` 一个 module**（`apps/web` cloudbase 边界——SDK 词汇是宿主集成词汇，core 不认识 CloudBase），两 binding 只留「信号→失败 kind」薄映射，`already_exists` **判一次**、「未知⇒network」**一份注释**（4 处拷贝措辞归一、规则住表内）；词汇与判定边界对**单信号载体**不变（上文即其内容）。**多信号矛盾载体**（一个错误同时带两类信号）由表的优先序裁决：`already-exists` ＞ `invalid-credentials` ＞ `unauthenticated`（具体信号压过笼统信号）——save 侧旧读法（只判 unauthenticated ⇒ `auth`）在矛盾载体上翻成 `network`，这是「收一张」的**唯一合并行为差**（#43 复查轮 A/B 实测记录）；敌意 JS 对象级载体（boxed／数组 code、throwing getter）归域外，同 §1.6 的信封域律。
6. **会话管理三态 `signed-out`／`signed-in`／`expired`——`expired` ≠ `signed-out`**：`CloudSaveError("auth")` ⇒ 标过期＋**重登引导，绝不自动重试**；过期后同步器实例即死（动作拒绝、不再打后端），**重登 = 重建传输端口＋同步器**（换账号 = 换命名空间）。**过期归属会话本人**：旧会话的迟到失败绝不灭掉新会话（`markExpired` 比 **session 对象身份**，非 uid——uid 名账号、同账号重登即新会话对象，比 uid 会误伤）；启动探测也不覆盖新状态（纪元护栏——慢探测的答案若遇上玩家先登录则作废）。**死亡表态单点（#42）**：「会话之死」的引导文案只住 `AuthPanel`（会话机状态驱动，`expired` 的引导语义）——`CloudSavePanel` 零死亡文案（状态词与引导段两处删除，「一闪即卸」随消解），同步器 `auth-expired` 相位**只作动作拒绝终结态、不渲染**：状态行对它出**空词**，旧裁决词照旧**不透出**（相位先行的原行为未动——「盖过」是点 7 失败相位的专名，此处不借；只删「说话」、不动「判定」——`statusView` 五形与拒绝通道原样，拒绝词**只指名真因**「登录已过期，此操作未执行。」（a dead session says so）、**不带引导**——引导是会话机的那份）；App 兜底句（「登录后启用云存档…」）非死亡表态、签出与过期两态照常显示。**探测失败 ≠ 无会话（#43）**：探测（`getLoginState`）失败状态不动、**上抛**——真 binding 原「吞成 null」改上抛，登录后两处同款探测一并响亮，**绝不吞成「登录成功但未获得会话」**（该裁决只留给真跑过、确实无会话的探测）；「flaky boot 不打扰玩家」归**渲染层**决策（App 启动处显式 catch 保持安静），绑定层不销毁信息。⚠️ SDK 门面自身把探测失败吞成 `null`（`@cloudbase/js-sdk@3.10.1` 实装查证）——裁定钉在 binding 缝上（fake 与真 binding 双侧共用断言），门面层的残余合流记 e2e 校准点。账密错误是**登录失败**（改输入），不是过期；**登出失败同样不翻状态**（后端会话还活着时说「已退出」是撒谎）。
7. **冲突裁决 UX = 三选项＋明示代价**：「以本地为准（覆盖云端）」二次确认明示「另一台设备的进度将被丢弃」、「以云端为准（下载载入）」、「继续本地玩（暂不同步）」。**「另存」被否**——存档槽管理是另一个功能（§1.6 被否路线同律）；保命通道是**导出 JSON**（ADR-0002 §21）。**导出亦为机器自读（#34，#31 D3 的推论落字）**——载荷＝导出动作当时从本地槽自读的**原始文本**（字节保真，永不派生自展示视图；槽外写〔另一标签页／命令层直写〕后导出必最新），**损坏槽照导原始字节**（salvage，修复后走 §1.8 导入回来），存储拿不到响亮失败不出文件、空槽 `local-empty` 不算失败。**结局分两层词**：成功／缺席走 outcome（`exported`／`local-empty`），失败落 `failed` 相位（`local-unavailable`／`file`——`file` 随动作两义：导入是读不出、导出是产不出）；**失败大声**（失败大声末句律——ADR-0037 D8 末句）：失败相位先行、盖过旧裁决。**裁决态落点（#34 D5＋#45 R6 实现期补裁，2026-10-04 追认）**：相位与裁决词两轴分离（`last`/`lastFrom` 在失败下存活、相位先行），三条规则收口——**出口即裁决**：D7 三出口（upload／download／dismiss）按下即裁决，upload/download 的缺席结局落在 `local-empty`/`remote-empty`＋`idle` 是**结局**不是盖过；**非出口保全**：导出是逃生舱、不是三出口之一，在审裁决下导出成功与空槽都**保全**裁决（空槽「不算失败」），只有失败替换相位落 `failed`（失败也不动两端、probe 即回原比较——两端仍可读时；存储拿不到时 probe 如实呈现 `unavailable`）；**「盖过」精确定义 = 失败相位替换旧裁决词**，出口自身除外，旧 `failed` 相位会被后续动作落的新状态**清除**（新裁决胜旧失败是取代，不是盖过；upload/probe 同律）。被否：（导出的）空槽落 `idle` 抹裁决（无失败何来盖过——失败是唯一盖过来源）、失败也保全（违背 D8 大声律，`local-empty`/`file` 会盖在「冲突——」下读不到）。红线：core `SaveStore` 端口不动（raw 面挂宿主侧 `LocalSlot.readRaw`），导出非破坏性、**无二次确认**。CAS 冲突与登录后两边分歧共用同一裁决面（`cause: save | compare`）。
8. **上传语义 = load-then-save（观测后写；#32 收成 store 的 `replace` 一个操作）**：新建与刻意替换同一通道；**整段「观测＋修复写＋撞 conflict 再分辨」舞步收进 store 成 `replace(snapshot)`**——`upload()` 调一次即完、不再反推 store 武装次序（武装规则只住 store，知识不漏 seam），返回结果自带判定：`saved`（创建／替换／修复）｜`conflict`（真竞速）｜`unrepairable`（锚损坏且行未动）。**载荷 = 本地槽当前内容、机器自读（#31）**——`upload()` 无参，展示视图（last-known 缓存）**永不作载荷**，载荷获取在动作最前端、**不打后端**（槽空 ⇒ `"local-empty"`、`"remote-empty"` 的对偶；槽损坏 ⇒ `failed`／`"local-corrupt"`，与「云端损坏」分义；**存储拿不到 ⇒ `failed`／`"local-unavailable"`**，读视图 `unavailable`，#32 D4——损坏⇒修/导出 salvage/导入覆盖（§1.8），不可访问⇒查浏览器设置或退出隐私模式、重试无用，**动作指引相反必须分词**；配额满是 `local` 原词，存储被禁绝不误报配额），本地视图随载荷读取即刷新（成功后必等于上载载荷，与下载对称）；**云端档损坏时**修复即 `replace`（§1.6 修复／重置路径换乘）。⚠️ **判定规则（#32 D3）**：写被拒**或锚损坏无从表达 CAS** 时，**再观测 raw record、以行身份定判**——**同一条行**（revision token／text 未变，即那条没有任何写能 CAS 的损坏行）⇒ `unrepairable`；其余一律**真竞速** ⇒ `conflict`（**含竞速方写入新的损坏行**——损坏在竞速后视图呈现；**含行消失**〔竞速方删槽〕——删除也是「有人写过」）。**锚损坏从不写**（#32 复查收口）：无锚的写只能盲建，恰在删槽竞速里覆盖掉「有人写过」的痕迹、还会让判定随实例残留武装翻转——不写、只按行身份判。任何失败大声（状态明示没存上、两端原样未动），绝不静默降级本地。

**面板纪律（#45 D1–D5）**：判定住机器、面板是薄绑定——**薄＝无业务判定**（同批修订 ADR-0037 的「面板是薄绑定」句），交互编排（按钮／二次确认／文件选择）留面板，面板只画＋手势上报。判定三面全出机器暴露视图：破坏性判定＋代价**要素**（`destructive`——哪些动作破坏性、各自覆盖哪槽、该槽现状；**文案措辞住渲染层**）、失败盖过旧裁决的状态（`statusView`——相位先行，失败相位盖过旧裁决；失败细节段按机器 `failure` 词配文案，是同一判定的展开、不再判一次）、机器守卫判定（灰显是展示、**守卫是机器**）。**机器一种拒绝（`CloudSyncError`）**：busy／auth-expired／adjudicating／no-staged-import／nothing-to-dismiss 全走 rejection，`dismiss` 的同步 throw 归一进同一通道（一机一拒，与「失败大声」同源）；面板一头适配、**不再吞错误**（与 AuthPanel 同律，来源都是机器）。红线：面板 `disabled` 只留**显示门**——视图门读 `localView.kind`／`remoteView.kind`、导出门 `exportDisabled`（「机器能否出文件」）、冲突块导入钮常灰纯展示；机器守卫复写删除（原文尾子句 `busy || state.phase === "auth-expired"`，简写 `busy || auth-expired`）；面板渲染测试随本批落地（jsdom＋React `act`）。

> **落地（#30）**：`apps/web/src/game/`（`cloudAuth.ts` 三态会话机＋`cloudbaseTransport.ts` CloudBase 适配器＋`cloudbaseSdk.ts` SDK 绑定＋`cloudSync.ts` 同步状态机与裁决；**#32 换形**：`cloud` 字段打字为 `load`＋`replace` 的宿主侧接口、upload 三分映射、词表加 `local-unavailable`；**#34**：导出收回机器自读——`exportLocal()` 无参＋`local` 字段加宽为 `LocalSlot`（core 端口＋宿主侧 `readRaw` raw 面）＋词表加 `exported`、`SyncAction` 加 `"export"`＋Blob/URL/`a.download` 出文件、失败 `file`）、`cloudSetup.ts`（每会话重建传输与同步器）、`ui/AuthPanel.tsx`／`ui/CloudSavePanel.tsx`。测试 `cloud-auth.test.ts`／`cloudbase-transport.test.ts`／`cloud-sync.test.ts`（语义全由假会话／假后端钉住）＋ `cloudbase-e2e.test.ts`（**env-gated 真后端冒烟**，无环境变量即 skip）。⚠️ **真后端冒烟未跑**（需要 CloudBase 环境）：错误分类信号表与条件更新／事务真语义是最可能被打脸的两处，校准点与部署清单（集合＋安全规则＋账密开关）见该测试头注释。**#45**：判定纪律收进机器（`destructive`／`statusView` 两面＋`CloudSyncError` 拒绝通道归一，`dismiss` 改 rejection）＋面板只画与手势上报（机器守卫尾子句删、视图门留、错误不再吞）＋面板渲染测试基建（`tests/panel-rig.ts`＋`cloud-save-panel.test.ts` 渲染钉，承接 #33/#34 延期断言）。**#43**：SDK 错误信号表收进 `cloudbaseSignals.ts`（分类＋判定一处、两 binding 薄映射、`already_exists` 判一次、未知⇒network 一份注释）＋「探测失败 ≠ 无会话」裁定显性化（binding 吞改抛、App 渲染层显式接住）＋双侧共用探测失败契约（`tests/support.ts` 的 `probeFailureContract`，fake 与真 binding 同一断言）＋ `tests/cloudbase-signals.test.ts`（表读法＋两道 src 扫描钉：词汇单点、规则注释单份）。

### 1.8 本地存档导入：D7 保命通道的对偶（#33；ADR-0039）

§1.7 的保命通道原是**单向**的：导出 JSON 有（ADR-0002 §21）、导入无，导出的档救不回来。本节补上对偶——**文件 → 本地槽**。六条定案（与 ADR-0039 的 D1–D6 同号）：

1. **（#33 D1）入口与导出对偶同居**：`CloudSavePanel` 上「导出／导入」成对，文件选择器选 `.json`。独立「本地存档」面板被否（保命通道拆两处难找；「本地动作住云面板」的耦合是后续宿主整理议题）。
2. **（#33 D2）写路径收进机器**：`CloudSync` 两段导入操作——`beginImport`（读文件 → parse → 验证 → 暂存）＋`commitImport`（消耗暂存写槽，**无参**——暂存载荷即写入载荷，视图缓存永不作载荷，#31 律）→ `views.local` 随写刷新；面板只做文件选择＋确认。⚠️ 两段的分界就是二次确认的位置（AC1「验证通过才进确认」与「一条链」不可同时成立于单操作，实现期拆段留痕票面）。
3. **（#33 D3）解析先行＋确认无条件化＋冲突态禁用**：验证通过才弹二次确认，明示代价「**覆盖当前本地存档、不可撤销、建议先导出保命**」；确认不经任何视图缓存短路；**冲突态禁用导入**（裁决中不可动赌注——机器守卫为准，面板 disabled 只是视图门/展示）。
4. **（#33 D4）「restore 必可载」验证**：调 `restoreWorld`（纯函数）整链验证（migrate 链＋十二类载荷一并验——只跑 migrate 链挡不住信封好载荷坏的档）；**存未迁移的解析结果**（store 不迁移律不破，§1.6 定案点 3 同律）。
5. **（#33 D5）失败口径**：`file`（读不出）｜`file-corrupt`（解析损坏**或载荷类验证失败**）｜`file-version`（**限版本/迁移类**验证失败）三词可分辨（失败源是文件——与 `local-*`（槽）、`corrupt`（云端）对仗）；写入失败沿 `local`（配额）/`local-unavailable`（#32 D4 词）；成功 outcome `imported`；用户取消文件选择＝静默，不算失败。⚠️ **分词机制（2026-10-01 复查收口）**：`file-version` vs `file-corrupt` 由**空载荷探针**问「链能否走」（`migrateSnapshot({version, data:{}})` 抛 ⇒ 纯版本/缺步类）——**探针绝不喂真载荷**：敌意形状（`data: null`）会崩掉 v1 迁移步，实测曾把同一种伤害按版本戳漂移成两词。
6. **（#33 D6）红线**：core 零改动；不做存档槽管理、不做自动上传/合并（版本兼容交 `migrateSnapshot` 一条链，导入原样进槽；活世界写入方是命令层的活）。

> **落地（#33）**：`apps/web/src/game/cloudSync.ts`（`beginImport`／`commitImport`＋`ImportSource`〔文件的最小切片，读失败也是机器裁决〕＋词表 `file`/`file-corrupt`/`file-version`＋outcome `imported`＋`SyncAction` 加 `"import"`＋冲突守卫）；`ui/CloudSavePanel.tsx`（导入按钮＋文件选择＋二次确认＋按 action 分文案）。测试 `cloud-sync.test.ts` 45 → 61 例（复查轮补分类回归、暂存生命周期、无参签名机械钉）。

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
- **高水位住在「推进世界的那一侧」，不在 `runCommand` 里**：`runCommand` 是纯函数（它因此**不持有**任何时钟，这正是能删掉 `CommandDeps.clock` 的原因）。推进与高水位由**驱动世界的那一侧**持有 —— 生产上是 `WorldRuntime`／宿主 `Authority`，测试上是 `createCommandHarness`（#22：`WorldRuntime` 已真的持有 `clock`，`addEntity` 从它取当前 tick；推进函数 `settleTo` 收它作起点，见 §4.3）。纯对象模式（裸夹具 `world: W`）每次调用深拷贝一个全新夹具，本就不存在跨调用的时间，需要跨调用观察时间的用例改用 live 模式（`world: { live: W }` 引用传递；#36 把 `liveWorld` 开关并进 `world` 的形态）。
- ⚠️ **驱动侧必须把自己持有的水位喂进 `deps.nowTick`，不能图省事喂 `command.tick`**：后者会让「tick 倒退取高水位」这条规则整个失效（水位恒等于本条命令的 tick），而且**引擎侧无从检测** —— 传给 `runCommand` 的数与本条命令的 tick 恰好相等是完全合法的情形。这是驱动侧的纪律，不是引擎能守的约束（#26 的 `LocalAuthority` 已照做：水位喂 `deps.nowTick`、命令 tick 原样不动）。
- ⚠️ **重放的限定**（ADR-0031 §1 那句「同一命令序列在不同 tick 重放」的准确含义）：重放**必须**从一个新的水位开始（或按不减的顺序喂入）。把一段旧序列喂进一个水位已经更高的时钟，每条命令看到的都是那个水位 —— 这是高水位语义的正确结果，不是 bug，但它意味着「乱序重放」不可表达，见 §2.5。

### 2.3 `Clock` 端口：方向翻转（ADR-0031）

`Clock` 端口**保留**，但语义从「**宿主注入**的依赖」翻转为「**引擎对外**暴露的读数」：

```
Clock { nowTick(): number }   // = 引擎高水位，不是毫秒，不是宿主时钟
```

宿主仍然负责**产生** tick（把墙钟翻译成 tick 是宿主的事），但只在构造 `Command` 时给它，不再注入。由此引擎不存在第二个「现在」。

> ⚠️ 这条**覆盖了 `spec/01` §端口表里 `Clock` 行的「宿主实现」一列**（原写「单机：由宿主按固定步长推进」）与该手册自检清单里以 `TestClock` 为证据的那一条 —— 那两处已在本次一并更正。

> **落地（M4-T7，#26）**：宿主侧「墙钟 → tick」的翻译在 `apps/web/src/game/hostClock.ts`（`createHostClock({ tickSeconds, now? })`，绝对公式见 §6 O5），`Date.now` 只在那一处被读（`apps/web/tests/host-purity.test.ts` 机械钉死「游戏层不读墙钟、不掷随机」）。它与本节的端口**同形不同义**（一个是 tick 的产生器、一个是高水位的读数），因此不复用类型名。

### 2.4 `Rng` 端口：状态可导出（ADR-0033）

```
Rng { next(): number; getState(): number }
```

`getState()` 是**强制**的：宿主不可提供一个不可序列化的 RNG，否则存档即失去确定性。mulberry32 的状态就是一个 uint32，导出成本近乎为零，恢复 O(1)。

**被否的替代**：只存初始种子 + 快进 N 次 `next()` —— 恢复是 O(N)，N 随存档年龄无界增长。见 §1.5：`rngState` 进 v2。

> **落地（M4-T5，#24）**：`types.ts` 的 `Rng` 加 `getState(): number`；`createSeededRng(state)` **一身二用**（既是新建也是恢复，不另开 `restoreRng` —— 两个入口会暗示两种语义，而它们收的是同一个 uint32）。`rngState` 走 `WorldMeta` 进出存档（§1.5）。

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

- 引擎只有 **`f(环, tick) → 段索引`** 这一个概念。段名、段数、每段多长、有哪些环，全在数据里。段的**显示字**也住内容：`segments[].label`（可选，缺省回退裸 id）——2026-10-25 owner 裁（#51 D2）：时辰词是包的词汇，与房间的 `name` 同律（「内容取字」按字面落）；引擎只透传。
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
> **落地（M4-T6，#25）**：迷你包异种日历**验收**——`tests/fixtures/mini-pack/config/calendar.json` = `shift`（`night-watch`／`day-watch` 各 900 tick）＋ `orbit`（`sunlit` 4200／`eclipse` 600），与武侠包**零重合**（环与段 id 一个不重），经**同一装配路径**（`packRegistry`，换目录即换历法）跑通，**引擎零改动**。迷你包侧算出的是**自己的**段名（逐段边界扫过，全部轮到自己的名字），武侠历法词汇（`WUXIA_CALENDAR_WORDS`：§3.1 三族——时辰十二名／刻／季节）在迷你包侧零命中；两包**词汇与 id 空间互不渗漏**——日历的环与段 id 已进 `packVocabulary` 的 `calendarIds` 桶（渲染器会印出段名，它就是包的词汇；与条目 id 同属一个 id 空间），日历 id 在 `foundIn` 里按**整词**匹配、条目 id 仍按子串（M2-T6／M3-T6 两张既有网语义不变；连字符属 id 本身：`day` 不在 `day-watch` 里，见 `mini-content-pack.ts`）。

依据：ADR-0025 §四

### 3.3 通道：与 `dimensions` 同构（ADR-0032）

配置三分法（ADR-0025 §三，见 `08-non-goals.md` C4）：**STRUCTURE 不进 `settings`**。日历的段名／段数属装配图（STRUCTURE），速率类数字属调参（TUNING），因此**拆两处**：

| 文件 | 承载 | 三分法归类 |
|---|---|---|
| `content/config/calendar.json`（新） | 环、段名、每段 tick 数 | **STRUCTURE** |
| `content/config/settings.json` 的 `time` 组 | 回复速率、buff 时长、冷却默认（键名一律带 tick 单位） | **TUNING** |

- 走与 `dimensions` **同一条通道**：`createContentRegistry(content, { dimensions?, settings?, calendar?, … })`——时间相关的是 `settings?`／`calendar?` 两张（通道上还有 `world?`，世界引导表，#49；非时间表不在本节展开）。由宿主装载器读 `config/` 后传入。引擎**不读文件**（照 `tests/fixtures/mini-content-pack.ts` 里 `readDimensions` 的先例）。
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

**四步之前先答一问：这条输入跑哪个 spec？** 这一步收成 `command/resolve.ts` 的 `resolve(input, table, bindings)` **一份**（#38）：match → lookup → **绑行为**（bindSpec——把 command key 变成可执行 `CommandSpec`；`bindings` 一个参数面带两形态：已建 spec／thunk 工厂，entry 由调用方柯里化，resolve 看不到内容）。⚠️ **绑行为（bindSpec）与绑参数（parseArgs）是两个词**：绑参数——`rawArgs` 解析进 `ctx.args`——**留在管线 parse 段**（跑两次契约：预检＋实跑、parse 必须纯；`spec.parse` 自定义钩子原样），resolve 不碰 args。失败形状**一条规则**：empty/unknown verb ⇒ `invalid`（带 reason，由调用方回给玩家），查无绑定 ⇒ throw wiring error（接错线不是玩错字——收编的各副本〔宿主 step 0 与四个测试驱动器〕继承同一分类，各自转 throw 时文案归驱动器自己）。「源→表」装配链同批收成 `verbTableFrom(sources)`（mergeCmdSets→verbEntries→createVerbTable 三连收一份）：**源配方留调用方**、每 dispatch 重合并、**从不缓存**（§4 的组源合并时机同律）。

**驱动侧的固定四步**——**唯一实现是 `command/driver.ts` 的 `createDispatchDriver`（#35／ADR-0038）**。测试 harness 的 `settle` 钩子与宿主 `Authority`（`apps/web` 的 `LocalAuthority`）都是它的**薄 adapter**：约定变结构，「忘掉一步」不再靠自觉，机械扫描钉死两侧 adapter 不再引用四原语：

1. 先跑一次**预检**（`parseCommand(spec, command, deps)`，只跑 parse 段）：解析失败就直接回 `invalid`、**不再调 `runCommand`**，推进函数一次都不会被调用，水位也不动；
2. 解析成功才**推进**：`settle({ toTick: effectiveNowTick(水位, command), seq, actorId })`（注入的推进钩子——宿主传 `settler.settleTo`，两层，见 §4.3）；
3. 再跑 `runCommand`（它内部会再解析一次 —— 与「分发器已匹配动词、管线内再切一次」同一个既有取舍，代价是 **parse 段必须无副作用**）；
4. 最后 `observeDispatch` **白名单守卫**（`ok`／`rejected` 才抬水位，`invalid` 不抬）；**抬水位在推进内**（`settleTo` 内部就 `clock.observe`），**无推进路径由 `observeDispatch` 兜底**（无钩子 harness 塌缩为「分发→observe」两步时它就是唯一的抬水位者）。结算事件**排在命令自身事件之前**返回——这条排前规则**只有一份实现**：driver 导出的 `settlementFirst`（事件通道、消息通道、批次通道都经它合成，adapter 不许自己拼 `[...结算, ...自己]`）；出口（消息路由／批次投递）各自保持。

「现在的算法」同样只有一个副本：`effectiveNowTick(水位, command)`（`command/pipeline.ts`）—— 预检、分发、驱动侧的推进目标都调它，两个 tick 的合法性也由它一起挡。`deps.nowTick` 的读数也收进 driver（adapter 交进来的 deps **没有**这个字段，第二口钟无处可插）。

⚠️ **没有钩子就没有世界要保护**：无推进钩子的 harness 不预检、不跑第 2 步，塌缩为「分发→observe」两步——这条怪癖观测等价（不预检时 `runCommand` 内部 parse 返回的 invalid 形状完全一致），原样保留（D4）。`WorldRuntime` 持有高水位但**不分发**（分发是宿主 `Authority` 的事，见 O10）。

⚠️ 只有 1 能挡住「发一堆乱码快进世界」：若跳过预检直接按 `command.tick` 推进，一条 tick=1000000 的乱码照样把到期桶提前引爆 —— 水位虽不抬，**世界已经动了**。

### 4.2 同一件事的三种跨度：在线心跳／离线结算／到期桶

```
pulses = min(floor((nowTick - startTick) / interval), maxPulses) - applied
```

**观察时补偿结算**不需要注册、不需要存储、不需要回调，只在被观察时一次性补齐欠的跳数并写回 `applied`。（`maxPulses` 是**语义**上限——毒最多跳 5 次，内容可配；它不是性能护栏，别混淆。）**首个真消费者已随 #56 落地**：木·中毒（`dot` 记账挂 `combat` 会话槽，`perTick` 挂载时算定〔T11②〕，`effectId` 回溯条目读 interval/maxPulses；结算 handler 见自检清单 :421 行）。

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

**M4 只落机制与接缝，不落真消费者**：状态树今天**没有任何可补的数值槽**（只有 `id`／`locationId`／`flags`／`tags`），而「补气血／内力／基础熟练度」要的槽属于效果系统那一族 —— 现在为它开 `attrs` 槽，等于提前承诺一个**还没设计**的形状（这正是 §4.1 拒掉「为到期桶提前建具名 effect 表」的同一个理由）。所以 M4 落的是**补偿结算这个原语 + 一个注册位**，由**合成消费者**驱动测试 —— 照 `entity-seams.test.ts`（全合成驱动、不依赖物品系统）与 `derived` 表今日为空这两个既有先例。**（#56 注记：`attrs` 槽已随后来的一击结算内核开设——第一个设计者是一击内核票，毒补偿结算是实体层首个真消费者；此段保留为决策史。）**

- **`lastSeenTick` 由引擎在结算完该实体后写入**，宿主不碰（否则「上次在线」会被宿主的时钟实现污染）。
- **结算事件的时间戳必须写 `dueTick`**（它本该发生的时刻），**不能写「被补跑时的 tick」**。写后者的话，事件顺序会依赖谁先上线，重放就不再确定 —— 正是 ADR-0024 §2 确定性清单要封死的。

> **落地（M4-T3，#22）**：`packages/core/src/time/settle.ts` —— `createSettler({ state, clock, world?, entity? })` 导出 `settleTo(request)` 这一个推进函数（`request = { toTick, seq, actorId? }`）。
> - **世界层的起点就是驱动侧高水位**，推进即抬高同一个数（`clock.observe`），所以不存在第二个「已结算到哪」；`toTick ≤ 水位` 时世界层一步不走。
> - **实体层**只跑 `request.actorId`，跨度 `[lastSeenTick, max(lastSeenTick, toTick))`，跑完由引擎写回 `lastSeenTick`。
> - 两层各**一个注册位**（`world`／`entity`），今天都是空的接缝，由合成消费者驱动测试；`actorId` 缺省即**宿主心跳**（只跑世界层，§4.1 的调用方显式给 seq）。
> - 未知实体、非法 `toTick` **大声失败**。
> - **状态树新增 `lastSeenTick` 槽**（`state/tree.ts`），`WorldRuntime.addEntity` 用**当前 tick** 种子（不是 0），且 `WorldRuntime` 现在**持有 `clock`**（§2.2「高水位住在驱动世界那一侧」的字面实现）；恢复路径 `attachEntity` 不重新种子（恢复＝重放树）。
> - 推进一次＝两个回调各一次，**与跨度长度无关**（1 万还是 100 万 tick 都是一次，§4.4 的构造性保证）。
> - 驱动侧预检在 `command/pipeline.ts` 的 `parseCommand`，四步时序在 `command/driver.ts` 的 `createDispatchDriver`（§4.1）——adapter 只注 `settle` 钩子，不排步骤。
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
> - **存档边界**：`snapshot()` 返回按 `dueTick` 升序的 `DueItem[]`（规范序，照 `flags` 先例），`restore(items)` 全量校验后才替换（畸形项大声失败、半加载不留）；测试行使其经 JSON 边界往返后 payload 原样存活。✅ **v2 的槽位已由 #24 接上**：到期项进 `SaveDataV2.due`（顶层，迁移默认 `[]`），宿主经 `WorldMeta.due` 存取（`bucket.snapshot()` 存、`bucket.restore(meta.due)` 读）。
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
- [x] `Rng.getState()` 存在且强制；状态进 v2 存档（ADR-0033）（#24：`Rng` 端口加 `getState(): number`，`createSeededRng(state)` **一身二用**——既是新建也是恢复，不另开 `restoreRng`，因为两者收的是同一个 uint32）
- [x] 游戏内时间（时辰/刻/季节）是 **tick 的纯函数**，不存储；**日历在内容里**（ADR-0032，#21：`content/config/calendar.json` + `createGameTime`）；**M4-T6（#25）已验收「日历随包」**：迷你包异种日历（`shift`／`orbit`，与武侠包零重合）经同一装配路径跑通、换目录即换历法，迷你包算出的是自己的段名，两包词汇与 id 空间互不渗漏
- [x] 日历是**一组独立的环**，不是一张扁平分段表（第 19 条）（#21：`rings[]`，多环各自取模）
- [x] `settings` / `calendar` 走与 `dimensions` 同构的通道；缺失时**引擎侧大声失败**，无默认公历兜底（#21：`createContentRegistry(content, { settings?, calendar? })` ＋ `createGameTime`／`createTimeTuning` 的惰性抛错）
- [x] 时间参数零写死：`TICKS_PER_*` 一类换算数字不在引擎源码里（硬标准 1）（#21：换算数字全部住在 `calendar.json`）
- [x] 时间区间用**半开区间 + 显式排序数组**（不是 `if start < end`）（#21：`segmentIndexAt`）
- [x] 冷却存**到期 tick** 不存时间戳；`cooldowns` 槽进存档（#23：`state/tree.ts` 新槽 + `addEntity` 种子 `{}` + 判定 `nowTick >= dueTick`（`src/time/cooldown.ts`，不是回调）+ 规范序与第九类畸形载荷）
- [x] 纯 stage 求值 `f(startTick, nowTick, stages)` 落地：O(1)（跨度无关）、无注册无状态无回调、末端夹紧（#23：`src/time/stage.ts` 的 `stageAt`，§4.7）
- [x] 无任何 per-object timer（六原语里的区域 tick / on-change 在 M4 不落，接缝已写在 §4.1）（#23：三个剩余原语里没有任何一个是每对象定时器 —— 到期桶 O(到期项数)、冷却是 tick 比较、stage 是纯函数）
- [x] DoT 类机制用**观察时补偿结算**，不是定时器（#56：木·中毒是首个真消费者——`combat/session.ts` 的 `createDotSettleHandler` 挂实体层，命令边界与离线跨度一次补齐、每跳事件盖 **dueTick**（`startTick + k×interval`）、`maxPulses` 跳满即清记账〔T11④〕、中途致死即止〔T8 剩余跳作废〕；`tests/combat-strike.test.ts` 钉跨命令／离线一万 tick／due-tick 盖章／跳满清除／mid-pile 截断五面）
- [x] 离线结算与在线心跳走**同一个推进函数**（只差跨度），不是两套代码（ADR-0032 覆盖 ADR-0016 §4）（#22：`settleTo` 一个函数，跨度是参数）
- [x] 离线补算的白名单**随首个真消费者钉死并扩为**：资源与基础熟练度**＋挂载效果的状态结算**（#56：毒离线照跳、可致死、产 `dotTick` 事件）。⚠️ 这是对 ADR-0016 §1「离线只补资源与基础熟练度」「只结算不产生叙事的时间推进」白名单的**第一次扩充**——按 ADR-0032 覆盖 ADR-0016 §4 的既有惯例**记录覆盖关系**（见 ADR-0041）：「不自动战斗、不推层、不产掉落」三条不变——毒跳是**状态结算**不是替你打怪（战斗仍只在玩家命令里发生）；owner 已批该定案（十轮审核 D4 批注，2026-10-30）
- [x] 推进复杂度是 O(事件数) 不是 O(tick 数)，由测试钉死（无 `maxCatchUpTicks`）（#22 钉「一次调用覆盖 100 万 tick、跨度不被截断」；#23 补齐**迭代次数上界（世界层 1 次／处理器 3 次）＋ 耗时上界**，并机械断言 `src/` 与 `content/config/` 里 `maxCatchUpTicks` 一个都没有 —— §4.4）
- [x] 世界层与实体层**分层推进**，实体用自身 `lastSeenTick`（ADR-0034）（#22：`settleTo` 两层 + 甲乙跨度场景）
- [x] 结算事件的时间戳写 **`dueTick`**，不写补跑时刻（#22：`SettleDraft.tick` 必填，测试钉死「到期 300、补跑 1000 → 事件写 300」）
- [x] `settleTo` 产生的事件与触发它的命令**同 seq，且排在命令自身事件之前**（#22）
- [x] v2 迁移存在且为迁移链首条真实迁移；**无 v2 → v3 连迁**（#24：`SAVE_VERSION` 1 → 2，`migrations[1]` 补 `nowTick=0`／`rngState=0`／`due=[]`／`lastSeenTick`（**只补缺失的**）；v3 存档直接「unsupported save version」，链一次只走一步）
- [x] 宿主心跳（无命令的推进）由调用方**显式给 seq**，与命令 seq 同一单调空间；不伪造 `actorId: ""` 的系统命令（#22：`settleTo` 不传 `actorId` 即心跳，只跑世界层；**#26**：`apps/web` 的 `LocalAuthority.heartbeat(seq)`，命令与心跳同一 seq 单调空间由测试钉死）
- [x] **`invalid` 不推进世界、其 tick 不抬高 `maxTick`**（`ok`／`rejected` 才推进）；有一条测试钉死「刷无效输入不加速世界」（#20，`tests/tick.test.ts`；#22 补上「连推进函数都不调用」这一半——驱动侧预检）
- [x] 每个 `GameEvent` 带 **`tick`**：命令事件写它看到的「现在」，结算事件写 `dueTick`（**O1 已定案，#22**；规则见 `spec/01` §5.0）
- [x] `addEntity` 为 `lastSeenTick`（= 当前 tick）与 `cooldowns`（= `{}`）种子，照 `tags` 的先例（#22 落前半；#23 落 `cooldowns`）
- [x] `serializeWorld` 的规范序覆盖新槽（`nowTick`／`rngState` 为标量；`cooldowns` 的键排序；`due` 按 `dueTick` 升序）（#23 落 `cooldowns` 那一半；#24 落标量 + `due`，一并钉在 `SaveDataV2` 里）

## 6. 开放问题

> ⚠️ **O8 与 O9 曾会阻塞实现**，已分别落到 #23（O8）与 #24（O9）并双双定案（见下）。其余 O1–O7 在票内明确即可。

| # | 问题 | 现状与倾向 |
|---|---|---|
| ~~O1~~ | ~~**`GameEvent` 要不要带 `tick`**~~ | **✅ 已定案（#22）**：**加，且所有事件都带**。命令事件写它看到的「现在」（高水位），**结算事件写 `dueTick`** 而不是补跑时刻 —— 写后者会让事件顺序依赖谁先上线，重放不再确定。落点 `types.ts` 的 `GameEvent.tick`（必填）＋ `pipeline.ts` 的盖章，规则见 `spec/01` §5.0 |
| ~~O2~~ | ~~**`seq` 与 `tick` 不同序时谁定顺序**~~ | **✅ 已定案（#20）**：**seq 定投递顺序、tick 定世界时间**，二者独立、不互相校验。见 §2.5 |
| ~~O3~~ | ~~**`settings.time` 缺**组内某个键**（如 `regenPerTick`）怎么算~~ | **✅ 已定案（#21）**：缺**组**失败（缺 `settings` 表或缺 `time` 组）、缺**键**由消费该键的系统自己大声失败，**引擎绝不替它猜默认值**。落点 `src/time/tuning.ts` 的 `createTimeTuning(settings).number(键)`，两条错误文案分别点名「组」与「键」 |
| ~~O4~~ | ~~**到期桶的项没有锚点**~~ | **✅ 已定案（#23）**：桶**保持全局扁平**，「这个房间的炸弹」靠宿主把 `roomId` 塞进 opaque payload —— 已写进正文本节：**引擎不提供按房间／区域／实体索引到期项的能力**，并由一条测试把 `DueBucket` 的键列表钉死（`schedule`／`settle`／`snapshot`／`restore`，多一个键即红），避免将来误以为有 |
| O5 | ~~**`tickSeconds` 归谁**~~ | **✅ 已定案（#26）**：**宿主参数**——它是宿主把墙钟翻译成 tick 的那个钟的构造输入（`apps/web` 的 `createHostClock({ tickSeconds })`），**引擎不读**（引擎只认 tick），**不进 `content/`**（`content/` 是引擎读的东西，放进去会让人误以为引擎消费它），也不是 `settings.json` 的 TUNING（那是给引擎的）。连带定死：宿主的墙→tick 公式是**绝对的**（`tick = floor(wallMs / tickMs)`，`tickMs = tickSeconds × 1000` **必须折合整毫秒、折不整大声失败**——宽度要在 tick 边界上精确，`16.1 × 1000` 的浮点尾巴会让每个边界晚 1ms，1/3 秒则根本折不整毫秒，静默取整等于把调用方的数字变成谎言；Unix 纪元、不另存锚点）—— 锚在会话起点的计数器每次重载归零，高水位永远看不见离线跨度，「回来补算」会被静默杀死；绝对公式下「存档的 nowTick ↔ 现在的墙钟读数」之差**就是**离线跨度，零额外状态 |
| O6 | **要不要时间谓词**（如"只在夜里能进"） | `spec/02` §5.3 谓词表里今天**零**时间相关谓词（全文 `tick` 零命中）。倾向：M4 **不**加，等第一个内容真的需要时按既有三处同步流程加（引擎／`condition.schema.json`／spec/02 §5.3） |
| ~~O7~~ | ~~**创建 `calendar.json` 那张票的文档同步债**~~ | **✅ 已在 #21 一并改**：`docs/agents/content.md` 的 config 清单（四类 + 新增「日历集合」字段约定节）、`docs/spec/06` 状态行与 `spec/00` 的 schema 总数口径（19 → **20**、`config` 三类 → **四类**、14 → **15** 待重估）、`HANDBOOK` 三处数字与 `content/config/` 文件数。**编辑器表单那一处**待 `apps/editor` 脱离占位后随行 |
| ~~O8~~ | ~~**★引擎侧要用到 calendar／到期桶处理器时，走什么通道**~~ | **✅ 已定案（#23）**：**新增 `CommandDeps.due?: DueBucket`**，照 `subjectOf` 的先例**由宿主注入**（不是让命令执行函数读内容注册表），命令侧经 `ctx.due.schedule(dueTick, payload)` 布雷；`ctx.due` 只暴露窄接口 `DueScheduler`（能布雷，不能触发、不能窥视），缺 `deps.due` 时布雷**大声失败**（`NO_DUE_BUCKET`，与 `deps.verbs` 缺失同律）。**触发**那一半的处理器（`fire`）在 `createDueBucket({ fire })` 构造时注入 —— 引擎全程不知道 payload 是什么。**calendar 那一半**走的是另一条既有通道：注册表 `calendar?` → `createGameTime`（#21） |
| ~~O9~~ | ~~**★`serializeWorld`／`restoreWorld` 的签名怎么容纳 `nowTick`／`rngState`**~~ | **✅ 已定案（#24）：选 (b)** —— `serializeWorld(world, meta)`（`meta` **必填**）／`restoreWorld(snapshot) → { state, meta }`，`WorldMeta = { nowTick, rngState, due }`。理由与被否的两条见 §1.5 约定 3。`due` 是 #23 的交接（ADR-0033 §2 只列了三样），一并进了 v2 |
| ~~O10~~ | ~~**`runCommand` 算出的 `nowTick` 要不要回传给驱动侧**（#20 复查新提）~~ | **✅ 已收口（#35，bb18259）**：(b)「约定驱动侧一律经 `observeDispatch`」被 **driver 结构取代**——四步时序收成 `command/driver.ts` 的 `createDispatchDriver`（ADR-0038），`deps.nowTick` 读数一并收进 driver（adapter 交进来的 deps 没有这个字段，第二口钟无处可插）；「忘调＝世界静默不前进」从靠自觉变成写不出来，机械扫描钉死两侧 adapter 不再引用 `parseCommand`／`runCommand`／`observeDispatch`／`effectiveNowTick`。历史：本行原是「(a) 结果加 `nowTick` 回传 vs (b) 约定经 `observeDispatch`」二选一并归 #22／#26 各自手抄 (b)——两份副本实测漂出 6 处差异，#35 把它们并成一份（harness 的 `settle` 钩子与 `LocalAuthority` 退成薄 adapter，心跳同归 driver）；(a) 的被否理由（动 `spec/01` §2.2 结果形状、心跳没有 `CommandResult` 可用）不过时 |
