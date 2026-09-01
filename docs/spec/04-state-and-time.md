# 04 · 状态、存档、时间与调度

> **状态**：迁移链骨架**已实现**；**§1 已实现**（状态树种子 M2-T1：`EntityState {id, locationId, flags}` ＋ `WorldState`（`packages/core/src/state/tree.ts`），动态占用进「同一棵树」，`WorldRuntime` 持有并就地变更；flags 槽位随门禁消费者落地，attrs/tags/states/skills 随各自系统进树。**序列化与快照 v1 ＝ M2-T5 已落**：`state/snapshot.ts`（`serializeWorld`／`restoreWorld` ＋ v1 形状）＋ `state/derived.ts`（`derived` 契约）＋ `WorldRuntime.attachEntity`（恢复＝重放树＋重挂实例），见 §1.4）；§2–§4（时间、游戏内时间、调度六原语）＝ **M4**（战斗前夜）；其余**待实现**。
> **依据**：ADR-0002、ADR-0017、ADR-0022 §1/§5、ADR-0023 §5/§1d、ADR-0025 §二/§三/§四、ADR-0028。

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

- **载荷就是状态树**，不是平行结构：`SaveDataV1 = { entities: Record<string, EntityRecordV1> }`，`EntityRecordV1 = Omit<EntityState, DerivedEntityKey>`。序列化在树之上只加三样：① `version` 戳（迁移链入口）② `derived` 切分（见 §1.3）③ **规范序**（entities 按 id 升序、flags 排序）——两个相等的世界存出**同一份字节**（ADR-0024 §2），确定性引擎的历史才可 diff、可比对。
- **NPC 不在快照里，是构造使然而非过滤**：静态在场直读放置清单（ADR-0028 §1），未显式写入的字段不落盘——这里没有 NPC 行可删，也永远不该有。
- **恢复＝重放树，不是创建**：`restoreWorld` 只重建状态（`migrateSnapshot` → 形状校验 → 逐实体重建 → 重算 `derived`），宿主再用 `WorldRuntime.attachEntity` 重挂 hook 载体；**不跑** creation 两层（跑 `at_object_creation` 等于用代码默认值覆盖存档，正是两层接缝要防的反转）。挂载**顺序无关**（被携带者可先于携带者挂载），恢复后的位置必须仍能解析——内容漂移大声失败，不做半解释状态。
- **大声失败**：版本大于 `SAVE_VERSION`／非数字、`data` 非对象／缺 `entities`、实体无 `locationId`、flags 非字符串数组、记录 id 与键不符——全部在加载时抛（ADR-0003）。
- **v1 里没有**引擎 tick 与 RNG 种子（消费者在 §2–§4，M4）：树随它们的消费者长槽位，那一天是 v2 + 一条迁移，不是往 v1 形状里静默加字段。
- **`SAVE_VERSION` 保持 1，迁移链机制就绪但为空**——首个真实迁移出现在 v2 那天才算检验，不造假迁移。
- **测试**：`tests/snapshot.test.ts`（形状钉死／往返经 JSON 边界后位置与 flags 存活／字节稳定与幂等／`derived` 表驱动排除＋加载后重算／未来版本与六类损坏存档大声失败／NPC 不入档且加载后仍在场／重挂不跑 creation 两层、顺序无关、重挂后继续可玩）。

## 2. 时间：tick 计数

- `Clock.nowTick()` 返回**引擎 tick 计数**，不是毫秒
- 引擎内禁止 `Date.now()` / `new Date()` / `setTimeout` / `setInterval`
- 双时钟语义隔离（ADR-0016 §4）：
  - **`tick()`**：在线世界心跳，固定步长，驱动战斗回合与状态倒计时
  - **离线结算**：进入游戏时一次性 O(1) 补算，**只补气血/内力恢复与基础武功熟练度**（有上限），**不自动战斗、不推层、不产掉落**

## 3. 游戏内时间 = tick 的纯函数

时辰／刻／季节全是 `nowTick` 的**纯函数**，**渲染时推导、绝不存储**：

```
TICKS_PER_HOUR / TICKS_PER_DAY / DAYS_PER_YEAR   （常量）
hour     = floor((nowTick % TICKS_PER_DAY) / TICKS_PER_HOUR)
shichen  = ...            // 时辰
ke       = ...            // 刻（子时三刻 = (0, 3)）
season   = SEASONS[floor(nowTick / TICKS_PER_DAY) % DAYS_PER_YEAR]
nextDueTick(hour) = ...   // 投进到期桶
```

- **不需要 `TIME_FACTOR`** —— tick 频率本身就是缩放因子（Evennia 需要它是因为它绑真实时间）
- 房间描述与 NPC 在场判定做成 `(nowTick) => descKey` 的纯选择函数
- ⚠️ **别抄 `extended_room` 的区间写法**：它的 `if start < end` 让跨年区间（winter `(1.0, 0.25)`）**永远匹配不上**，只是靠「遍历完返回最后一个键」侥幸正确。用**半开区间 + 显式排序数组**

依据：ADR-0025 §四

## 4. 调度六原语（可砍到四）

| 原语 | 覆盖的需求 |
|---|---|
| **Clock**（唯一 tick 计数器） | 取代一切墙钟 |
| **纯 stage 求值** `f(startTick, nowTick, stages)` | 门 N tick 后重锁、作物 4 阶段、技能还有多久好 |
| **观察时补偿结算** | 毒每 3 tick 跳 5 次 |
| **到期桶** `Map<dueTick, cb[]>` | 延迟爆炸等一次性事件 |
| **区域 tick**（`tick % interval === phase` 分组订阅） | 天气、区域驻守刷新等**必须主动推送**的 |
| **on-change 钩子** | 字段变更触发，与 tick 完全解耦 |

### 4.1 ★「观察时补偿结算」—— 把定时器降级为纯函数

```
pulses = min(floor((nowTick - startTick) / interval), maxPulses) - applied
```

不需要注册、不需要存储、不需要回调，只在被观察时一次性补齐欠的跳数并写回 `applied`。

这一条取代了绝大多数 per-object timer 需求（如 DoT）。

### 4.2 冷却

`key → 到期 tick` 的只读表。**存 tick 而非时间戳**，判定是 `nowTick >= dueTick` 的比较，不是定时器回调。天然确定性，成本几乎为零。

### 4.3 明确不需要

Script 实体、per-object timer、线程、async/await、任何墙钟。

⚠️ Evennia 的 OnDemand **自己也依赖墙钟**（`gametime.runtime()` 用 `time.time()`），且其 stage 回调「**is not guaranteed to be called**」。我们改成纯函数后这两个问题都不存在。

依据：ADR-0022 §5、ADR-0023 §5、ADR-0025 §三

## 5. 自检清单

- [ ] 状态是 **typed 对象**，没有 attribute handler / 字符串 key 查找层
- [x] 迁移链可用；`derived` 字段**不进快照**、加载后重算（M2-T5：`state/derived.ts` 一张表同时驱动「快照类型」（`Omit`）与「序列化排除」，恢复时逐实体 `recompute`；表今日为空，首个消费者是修饰符系统）
- [ ] 引擎里搜不到 `Date.now` / `setTimeout`
- [ ] `Clock` 是 **tick 计数**不是毫秒
- [ ] 游戏内时间（时辰/刻/季节）是 **tick 的纯函数**，不存储
- [ ] 时间区间用**半开区间 + 显式排序数组**（不是 `if start < end`）
- [ ] 冷却存**到期 tick** 不存时间戳
- [ ] DoT 类机制用**观察时补偿结算**，不是定时器
- [ ] 无任何 per-object timer
- [ ] 离线结算**只补资源与基础熟练度**，不自动战斗、不推层
