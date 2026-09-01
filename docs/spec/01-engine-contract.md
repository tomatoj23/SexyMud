# 01 · 引擎对外契约

> **状态**：§1 端口、§2 命令、§3 三类失败、§4 事件流、§5 输出边界**已实现**（M1-T1：`packages/core/src/types.ts` + `command/pipeline.ts`，放置遗留已清零）；命令解析（M1-T2）、cmdset 合并（M1-T4）、条件门禁（M1-T3）、命令内容化与 `ContentRegistry`（M1-T5）已落；§6 目录树中 `world/`、`state/`、`time/`、`effects/` 待实现。
> **依据**：ADR-0002、ADR-0017、ADR-0025 §一、ADR-0006、ADR-0018。

## 1. 注入端口（Ports）

引擎**不直接触碰任何平台 API**。宿主提供四个实现：

| 端口 | 契约 | 宿主实现 |
|---|---|---|
| `Clock` | `nowTick(): number` — **引擎 tick 计数**，不是毫秒 | 单机：由宿主按固定步长推进；将来服务端：权威 tick |
| `Rng` | `next(): number` — **种子化**，种子进存档 | 确定性 PRNG（如 mulberry32 / xorshift） |
| `SaveStore` | `load(): Promise<Snapshot \| null>`、`save(s): Promise<void>` | Web：`localStorage`；小程序：`wx.setStorage`；将来：云端 |
| `Authority` | 见 §3 | `LocalAuthority`（现在）／`RemoteAuthority`（将来） |

⚠️ **引擎内禁止出现**：`Date.now()`、`new Date()`、`Math.random()`、`setTimeout`、`setInterval`、`performance.*`。
**由 `engine-purity` 测试强制**（已实现，覆盖 `packages/core/src/`）。

A-1. **Tick 不是毫秒**。ADR-0016 定的「双时钟」里，心跳是固定步长的 tick；离线结算是一次性 O(1) 补算。两者语义隔离，不共用代码路径。

## 2. 命令契约（Command）

```ts
interface Command {
  seq: number;          // 单调递增，由客户端分配
  actorId: string;      // ★ 显式携带，不依赖「当前角色」
  raw: string;          // 玩家原始输入
}
```

### 2.1 `actorId` 必须显式（最贵的一项，今天做）

不要依赖「当前角色」这种隐含上下文。Evennia 为多连接付出的最大代价就是把连接状态与游戏状态存在同一个 Session 对象里，结果被迫写出一条绕过所有 hook 与权限检查的静默重连分支。

**事后补这一项要改所有调用点与 reducer 签名——所以写第一条命令时就要带上。**
依据：ADR-0025 §一.1

### 2.2 `seq` 同时在命令侧与事件侧

- 命令带 `seq`（客户端分配，单调递增）
- **`CommandResult` 与每个 `GameEvent` 也要带 `seq`**

只在命令侧有 seq，就做不了幂等去重与乱序重组。
依据：ADR-0025 §一.2

## 3. `Authority` 契约

```ts
interface Authority {
  dispatch(command: Command): Promise<CommandResult>;
  subscribe(listener: (events: GameEvent[], meta: EventMeta) => void): () => void;
  snapshot(): Promise<Snapshot>;
}
```

- **界面只认这个接口，永远不认实现。** `LocalAuthority` 直接包引擎本地实例；`RemoteAuthority` 命令上行、事件下行。将来换实现，**引擎一行不改**。
- `meta` 含 **seq 范围**，让 UI 能做间隙检测与重放。
依据：ADR-0017、ADR-0025 §一.4

## 4. 三类失败（重试语义完全不同）

| 类型 | 含义 | 是否消耗 seq | 重试语义 |
|---|---|---|---|
| `rejected` | 引擎**合法地**拒绝（内力不足、前置不满足、门没开） | **已消耗** | **不重试**，作为事件返回给玩家（这是游戏内容，不是错误） |
| `invalid` | 格式错误／无法解析 | 未消耗 | 不重试，报错 |
| `transport` | 未送达 | 未消耗 | **可重试** |

混为一谈会让 `RemoteAuthority` 无法正确实现 ack/重传。
依据：ADR-0025 §一.2

## 5. 事件流（GameEvent）

```ts
interface GameEvent {
  seq: number;
  type: string;          // 语义类型，如 "attackResolved"
  actorId: string;
  // …纯语义字段（谁、对谁、做了什么、结果档位）
}
```

### 5.1 铁律：**绝不含已渲染文本**

Evennia 在线上传输的是**已渲染的字符串**（`data_out.text`）。它为此付出的代价：多端要各自解析 ANSI、本地化无从下手、多端适配锁死在转义码上。

**我们传纯语义 JSON，渲染推迟到 `TerminalView`（见 `05-output-pipeline.md`）。这条已经比 Evennia 好，不要因为它"看起来更省事"而退回去。**
依据：ADR-0006、ADR-0018 §3、ADR-0025 §一.3

### 5.2 事件必须携带呈现所需语境

伤害档位（轻/中/重/濒死）、剩余气血档、是否暴击/闪避、系别、作用方式、品阶。**后补会伤及存档与模拟器兼容性。**
依据：ADR-0006、ADR-0011 §7

## 6. 包与目录结构

```
packages/core/          引擎（可独立发布的库，零题材词）
  src/
    types.ts            端口与对外契约（Clock / Rng / SaveStore / Authority、GameEvent）
    conditions.ts       条件求值与谓词注册表（独立横切契约，M1-T3 已落——不并入 effects/）
    command/            解析、命令集合并、分发（M1-T1/T2 已落）
    save/               版本化存档迁移链
    world/              房间、出口、实体、hook
    state/              typed 状态、derived
    time/               tick、调度六原语、游戏内时间
    effects/            效果执行
    content/            ContentRegistry（读内容，永不 import 数据）
  tests/                ★ 必须脱离 apps/ 也能跑

apps/*                  宿主（提供端口实现 + TerminalView）
content/                内容包（可整体替换）
schemas/                内容 JSON Schema
```

依据：`docs/agents/domain.md` 路径规范、ADR-0026

## 7. 六条横切契约（模块化的真正载体）

> 这是引擎「既能做最小 MUD、又能做复杂 MUD」的原因。见 `00-overview.md`「能力光谱与扩展模型」。

| 契约 | 内容 | 让什么成为可能 |
|---|---|---|
| **效果** | 任何系统产生的影响都用同一套 effect／修饰符表达 | 技能改战斗数值，**不用 import 战斗** |
| **条件** | 任何「能不能」都用同一套条件表达式 | 所有门槛统一，且能被 Schema 校验 |
| **事件** | 任何系统都往同一条事件流吐 `GameEvent` | 系统间通过事件解耦，不互相调用 |
| **状态** | 任何状态都在同一棵树里，遵循同一套 `derived` 规则 | 存档与迁移统一 |
| **命令** | 任何系统都往命令集注册，不自己发明输入方式 | 可用命令可合并、可被别名、可被门禁 |
| **时间** | 任何系统都用同一套 tick 与调度原语 | 无隐式定时器，**保持确定性** |

**这六条让机制模块之间不需要知道彼此的存在。**

⚠️ 它们现在是**类型与接口**，不是插件系统——见 `08-non-goals.md` A7。

依据：ADR-0004（声明式效果）、ADR-0006（事件流）、ADR-0022 §2（条件）、ADR-0025 §三（时间）

## 8. 自检清单

- [ ] 引擎 `src/` 里搜不到 `Date.now` / `Math.random` / `setTimeout` / `new Date`
- [ ] 引擎 `src/` 里搜不到任何题材词（跑 `engine-purity` 测试）
- [x] 引擎不 import `content/` 下任何 JSON，只经 `ContentRegistry`（M1-T5 已落：src/ 零内容导入，测试扮演宿主读文件喂注册表，`engine-purity` 守卫）
- [ ] 每条命令带 `actorId` 与 `seq`
- [ ] 每个 `GameEvent` 带 `seq`，且**不含已渲染文本**
- [ ] `dispatch` 的返回区分 `rejected` / `invalid` / `transport`
- [ ] `subscribe` 回调收到 `(events, meta)`，`meta` 含 seq 范围
- [ ] `packages/core/tests` 可独立运行，不依赖 `apps/`
- [ ] `Clock` 是 **tick 计数**而非毫秒
- [ ] 效果／条件／事件／状态／命令／时间 **六条契约**已定义为类型与接口
- [ ] 机制模块之间**不互相 import**，只通过契约交互
- [ ] **没有**插件加载器 / 动态模块注册（见 `08-non-goals.md` A7）
