# 命令分发四步时序收成 driver module：两处手抄并成一份，「忘调＝世界静默冻结」结构上不可能（C1）

spec/04 §4.1 规定驱动侧固定四步（预检 → 推进 → 分发 → `observeDispatch`），但这条时序**只有约定没有实现**——「全程跑这四步的有两处」：测试 harness（`command/testing.ts` 的 `settle` 钩子）与宿主 `LocalAuthority`，两处各手抄一份。O10 选 (b)「约定驱动侧一律经 `observeDispatch`、两处各自照做」时自己记档了失败模式：「忘调 = 世界静默不前进、不报错，属最难查的一类」。两份手抄副本必漂（实测 6 处差异），「interface 就是测试面」在此破了。本票（#35）把四步时序收成**一个 driver module**，两个调用方退成薄 adapter——约定变结构，「忘掉一步」编译不过、写不出来。

## Context

- **O10（spec/04 §6，#20 复查新提）**：`runCommand` 内部算 `max(deps.nowTick, command.tick)` 却不回传，驱动侧必须自己调 `observeDispatch` 才能持久化水位；忘调的后果是世界静默冻结。当时选 (b)「不动 `CommandResult` 形状、约定一律经 `observeDispatch`」，归 #22／#26 各自照做——**约定式方案的结构性产物就是本票要治的病**。
- 事实核查（2026-09-28，两份实现逐条对照）：6 处差异里 **4 处参数化进 driver**（推进实现＝注入 `settle` 钩子、时钟持有者＝注入 `clock`、预检触发＝钩子在场、心跳有无＝独立 `heartbeat` 入口），**2 处按红线留在 adapter**（spec 来源＝C4 的 resolve 领域、出口路径＝AC4 的出口差异）——「可参数化」不等于「都收进 driver」。真正手抄的是**次序与规则**（含排序：已收成 driver 导出的 `settlementFirst`，三个输出通道都经它合成）。O10 恐惧的真相比记载的窄：`settleTo` 内部已 `clock.observe(toTick)`，有推进时第 4 步对抬水位是冗余的；真正会静默冻结的是**无推进路径**（无 settle 钩子的 harness 塌缩为两步）。本票的卖点因此是「**次序与规则只有一份**」，不是「`observeDispatch` 忘不得」。
- 「无钩子不预检」的怪癖是**观测等价**的（不预检时 `runCommand` 内部 parse 返回的 invalid 形状完全一致），其存在意义是文档契约「没有钩子就没有世界要保护」。
- 时机便宜：`LocalAuthority.dispatch` 目前只有测试在调、UI 未接线；`heartbeat` 的 toTick 是 adapter 内从 `HostClock` 读的，driver 不读墙钟有据可依。
- 设计定案（2026-09-28 grilling 四轮八问）：工作稿 `.scratch/command-driver/DECISIONS-WIP.md`（被否路线留痕在彼），立项 #35（C1）／#36（C2，harness 选项 11→5，本票明确不碰）。

## Decision

七条定案（D1–D7，2026-09-28，工作稿 `.scratch/command-driver/DECISIONS-WIP.md`）：

1. **D1 重开 O10 (b)「两处各自照做」**：四步时序收成一个 driver module，harness 的 settle 钩子与 `LocalAuthority` 退成薄 adapter。约定变结构——「忘调」从靠自觉变成写不出来。被否的是**方案 (b) 的形态**（约定式），不是它守的语义。
2. **D2 C1／C2 拆两票**：本票只做「时序归属搬家＋零行为变化」；C2（harness 选项 11→5、一次组装）独立票 #36 挂 blocked by、另开小决策。两票验收面互不覆盖（「四步只有一份实现」vs「选项 11→5」），一票做两个设计选择会被顺手决定。
3. **D3 心跳归 driver**：两个入口——带命令完整四步、无命令「推进＋抬水位」。心跳语义不变（`seq` 显式、只跑世界层、`toTick` 由 adapter 从 `HostClock` 供给，**driver 不读墙钟**）。心跳与命令路径共享「推进＋抬水位」内脏，另写一条＝病灶换位置复发。
4. **D4 红线：纯搬家、零可观测行为变化（含怪癖原样）**——结算事件排命令事件之前、`invalid` 连推进都不调、无 settle 钩子的 harness 不跑预检等既有行为原样保留；任何行为修改另票另议。#30 复查轮教训的镜像：无 AC 覆盖的行为修改会静默漂。
5. **D5 接口形状：工厂闭包一次组装**——`createDispatchDriver({ clock, settle? })` → `{ dispatch(command, spec, deps), heartbeat({ toTick, seq }) }`，返回 `{ result, settled }`（原始结算消息，出口差异留 adapter）；`deps.nowTick` 读数收进 driver（工厂持钟的理由，adapter 交进来的 deps 没有这个字段）。两处调用方都是「组装一次、多次调用」；纯函数每次带依赖会把装配知识留在调用方。
6. **D6 无推进规则一条进 driver**：settle 可选——有推进必「预检→推进→分发→observe」，无推进走「分发→observe」。「没有钩子就没有世界要保护」显式化成一条规则，只剩一份；两个入口让调用方选＝忘选就复发。
7. **D7 命名与落层**：`packages/core/src/command/driver.ts` 导出 `createDispatchDriver`（与 pipeline 同居，注释先例 "driver's pre-flight"）；落 core——harness 在 core 内部、宿主 import core、将来 `RemoteAuthority` 同用。不抵触 O10「`WorldRuntime` 持有高水位但不分发」：分发的**决定权**在宿主，时序的**实现**只是四个引擎原语的编排。

## Considered Options

- **O10 路 (a)：`ok`／`rejected` 结果加 `nowTick` 回传**：被否——只消掉「忘调 `observeDispatch`」一种；预检→推进→分发的次序仍两处手抄；心跳没有 `CommandResult`，(a) 救不了那一半（O10 原文自认）。
- **不重开、补「水位必须动了」测试钉**：被否——给漂移的两个手抄副本再加副本；忘调类问题的结构性成因原样留着。
- **C1／C2 一票收口**：被否——C2 的设计选择（选项砍到哪 5 个、装配形状）会被顺手决定。
- **心跳另走手抄路径**：被否——「两处手抄」变「两处半手抄」，病灶换位置复发。
- **搬家夹带行为修改**：被否——无 AC 覆盖的行为修改静默漂（#30 教训）。
- **纯函数每次带依赖**（`runDispatchSequence({command, spec, deps, settle, clock})`）：被否——装配知识留在调用方，接口面宽；调用方仍可拼错依赖组合。
- **driver 暴露两个入口（完整四步／裸两步）**：被否——把「何时预检」的规则推给调用方选，忘选就复发；规则该住 driver。

## Consequences

- `packages/core/src/command/driver.ts`（新）导出 `createDispatchDriver` 与排序函数 `settlementFirst`（规则三「结算排命令之前」的唯一实现——事件通道、消息通道、批次通道都经它合成）；`command/testing.ts` 的 `call()` 与 `apps/web/src/game/localAuthority.ts` 的 `dispatchNow`／`heartbeat` 改委托，出口各自保持（harness 按 receivers 过滤后排前合并、`LocalAuthority` 按被消耗 seq 投递批次：`ok`／`rejected` 发、`invalid` 不发）。`packages/core` 对外新增导出，既有导出零改动。
- **机械扫描钉死**（照 `host-purity` 先例，扫描器在测试套件内）：core 侧扫 `testing.ts`、apps/web 侧扫 `localAuthority.ts`，二者不得再引用 `parseCommand`／`runCommand`／`observeDispatch`／`effectiveNowTick`（`settleTo` 只以注入函数出现），不得手拼 `[...结算, ...自己]`（排序只许经 `settlementFirst`）；反向钉 driver.ts 确实持有四原语、`nowTick` 读数与排序实现（防扫描空转）。
- **行为零变化**：既有测试全绿、断言值不改不删（harness 全部、`local-authority` 11 例、`offline-catchup`、`tick`／`settle`／`due`）；怪癖原样——无 settle 钩子不预检、`invalid` 不发批次、`rejected` 出口不带 events、心跳只跑世界层。
- ⚠️ **一处超出 §E 接口钉的细节，如实记录**：`heartbeat` 里 driver 自己 `clock.observe(toTick)`。§E 写的是「heartbeat = settle(...)」，抬水位在推进内（`settleTo` 内部就 observe）；但心跳入口的契约是 D3 的「**推进＋抬水位**」两件，而第 4 步的兜底（`observeDispatch`）在心跳路径不存在（没有命令可喂）——由 driver 兜这一脚，与「无推进路径由 `observeDispatch` 兜底」同构。对唯一真实调用方（`LocalAuthority` 的 `settleTo`）这一步是 no-op（observe 只升不降），**零可观测行为变化**成立；无推进钩子的心跳抬水位是新面，钉了测试。同理 harness 的 `invalid` 出口从「预检失败硬返 `messages: []`」改为统一出口公式——预检失败时 `runCommand` 未跑、sink 没收到任何东西，两条路径观测等价。
- `WorldRuntime` 持水位边界与 `Authority` 接口零改动；`CommandResult` 形状零改动（O10 (a) 的否决理由继续有效）。
- C2（harness 选项收敛）仍开在 #36，blocked by 本票。
- 落点：`docs/spec/04` §4.1（「两处」句改写、第 4 步「抬水位」修准为「白名单守卫；抬水位在推进内、无推进路径由 `observeDispatch` 兜底」）与 §6 O10 行收口、`docs/HANDBOOK.md` 测试规模随行。
