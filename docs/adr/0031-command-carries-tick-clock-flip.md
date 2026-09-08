# tick 的真相：`Command` 携带 tick，`Clock` 端口翻转为引擎读数

引擎需要一个「现在」，但今天没人规定它从哪来：`Clock` 端口存在并注入到 `CommandContext`，但**没有任何引擎 behavior 读它**（`src/` 内零消费者；测试里有 1 处守卫，见 Context）。M4 要给时间系统落地，这个问题必须先解决。本文定三件事：tick 由 `Command` 携带、引擎内部维护**高水位**、`Clock` 的方向从「宿主注入」翻转为「引擎对外读数」。

## Context

- `spec/01` §端口表把 `Clock` 写成 **宿主实现**（「单机：由宿主按固定步长推进；将来服务端：权威 tick」），但实际形态是**宿主造一个对象、引擎拿去读**。
- 实测（2026-09-08）：`clock` 在 `packages/core/src` 里**零消费者** —— 只出现在 `types.ts`（端口定义）、`pipeline.ts`（注入并透传给 `CommandContext`）、`command/testing.ts`（`TestClock`）。**但测试里有 1 处消费者**：`tests/command-harness.test.ts` 的 `tickProbe` 用例显式读 `ctx.clock.nowTick()`，并断言 `harness.clock.advance(7)` 之后两次调用看到 `[100, 107]` —— 它今天就是「命令从时钟读现在」这件事的守卫。
- `Command` 的构造点共 **8 处**：`command/testing.ts` 的 `call()` 1 处，加上 `tests/parser.test.ts` 绕过 harness 直接调 `runCommand` 的 **7 处**。加一个字段的成本是小而非零。
- ADR-0025 §1.1 已经为同类问题留了判词：`actorId` 是「最贵的 retrofit，今天做」。`tick` 属于同一类命令语境。
- ADR-0022 §5 / ADR-0025 §四要求「时间推进**按需求值**而非每 tick 遍历」，引擎在本体论上是**被动**的：没有命令就没有「现在」。

## Decision

### 1. `Command` 自带 `tick`

```
Command { seq, actorId, tick, raw }
```

与 `actorId` 同律：**语境由命令携带，不由环境推断**。附带的好处是「同一条命令序列在不同 tick 重放」成为可表达的事，测试无需模拟「推进」动作。

### 2. 引擎内部维护高水位 `maxTick`

`maxTick = max(见过的所有「进入执行段的命令」的 tick)`，单调不减，是引擎唯一承认的「现在」。⚠️ 限定语不可省：`invalid` 的 tick 不参与（见 ADR-0032 §4）。

**tick 倒退的命令照常执行**，但一切时间判定取高水位，**不**大声失败。理由：tick 倒退**不改变任何已发生的事实**，只影响「现在」，而「现在取最大值」是唯一无歧义的解释；且丢命令（抛错）比采纳命令代价大。这不是 ADR-0003「大声失败」的例外 —— 那条守则针对的是**内容漂移**（引用断了、id 重名），这里没有解释空间可被隐藏。

### 3. `CommandDeps.clock` 删除；`Clock` 端口翻转语义

```
Clock { nowTick(): number }   // = 引擎高水位，不是毫秒，不是宿主时钟
```

`Clock` **保留为一个端口，但方向反过来**：不再是「宿主提供给引擎的依赖」，而是「**引擎**对外暴露的读数」。宿主仍然负责**产生** tick（把墙钟翻译成 tick 是宿主的事），但只在构造 `Command` 时给它。

### 4. 不保留两个真相

如果既留 `CommandDeps.clock` 又加 `cmd.tick`，就必须规定二者不一致时怎么办 —— 多一条规则，且迟早漂移。两个「现在」是最难查的一类 bug（比两个 DoT 定时器更难，因为它影响所有判定）。

## Considered Options

| 方案 | 否掉的理由 |
|---|---|
| **保留 `deps.clock` 为权威，要求 `cmd.tick === clock.nowTick()`** | 两个真相 + 一条校验规则；且等它真的漂移时，修的是标不是本 |
| **命令不带 tick，宿主调 `clock.advance()` 后 dispatch** | 「同一命令序列在不同 tick 重放」不可表达；把「现在」变成引擎内的可变时序状态，与「引擎是纯函数取向」相悖 |
| **引擎暴露 `advance(tick)` 由宿主驱动** | 把推进做成一个显式动作后，「两条命令在同一 tick 内发生」变得难以表达 |

## Consequences

- **`CommandDeps` 少一个字段**：这是本次设计与既有代码接口唯一的一处破坏性改动。实测范围约 **10 处**：`parser.test.ts` 的 7 个 `Command` 字面量要加 `tick`、它的 `deps()` 要去掉 `clock`；`command-harness.test.ts` 的 `tickProbe` 用例要重写（`ctx.clock.nowTick()` 改为从 `ctx.command.tick` 取）；
  `testing.ts` 自身改 `TestClock` 语义。
  **不是零回归**，但那条 `tickProbe` 的断言值 `[100, 107]` **不变** —— `advance(7)` 从「推进引擎的现在」变为「改下一条命令的默认 tick」，两次调用看到的 tick 序列照旧。它将继续守卫同一件事，只是换了表达。
- **`TestClock.advance()` 语义改变**：从「推进引擎的现在」变为「改下一条命令的默认 tick」。`spec/01` 自检清单里以 `TestClock` 作为「Clock 是 tick 计数」证据的那一条已同步更正。
- **覆盖 `spec/01` §端口表 `Clock` 行的「宿主实现」一列**（原写「单机：由宿主按固定步长推进」）。ADR-0017「单机优先 + 薄服务端」不变：服务端形态变成「服务端是 tick 的权威**生产者**」，而不是「宿主注入一个时钟对象」。
- 高水位必须进存档（见 ADR-0033）：不存则恢复后时间倒退，`nowTick >= dueTick` 恒为假 ⇒ **冷却永远不到期**。
