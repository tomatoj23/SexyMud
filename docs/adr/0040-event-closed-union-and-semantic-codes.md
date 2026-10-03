# 事件收成「构造一处＋封闭联合＋语义码取值面」：拼错字段从静默漏过变成编译报错，扩展臂用品牌挡伪（C7）

`GameEvent` 曾是带 `[key: string]: unknown` 的开放接口——语义字段（`reason`／`commandKey`／`errKey`／`accessType`／`roomId`／`stage`）拼错编译器不响，`commandRefused` 一族在 engine 6 处手拼、tests 有手拼发射与把事件形状快照化的子集断言；`reason`／`accessType` 是自由字符串，渲染端「把码映射成内容文案」没有单一住所。C7 把事件构造收成一处（#41：factory 一族＋`customEvent`）并封门（#47：封闭联合＋品牌化扩展臂＋语义码面＋盖章点受检收口）。设计定案 2026-09-28 grilling＋2026-09-29 复查重新裁决（H4/M1/M2/L11），工作稿 `.scratch/grill-2026-09-29/refusal-event-factory/`（被否 8 路线留痕在彼）。立否三条件自评：**难逆**（封闭联合＋码面＋品牌律进 `GameEvent` 公共契约，渲染层与宿主从此按型消费，撤回波及全部调用面）／**会困惑**（「自定义事件为何不能手写字面量」「reason 为何不能直接写」无记录必读不懂，工作稿在临时区会清）／**真权衡**（纯封闭／开放臂／无品牌／自由字符串码等 8 条被否路线，H4 技术陷阱）——三条齐，立。

## Context

- **H4 技术陷阱**（复查裁决）：纯开放扩展臂（`{ type: string; … }` 直接并入联合）会让引擎事件的拼错字段掉进开放臂照样编译通过——「拼错编译期报错」的立意漏光。正解是**封闭引擎臂＋品牌化扩展臂**：手写字面量掉进任何臂都编译报错。
- **拆批事实纠错**：「封联合必破 tests 20+/35+ 手写面」经代码实证**证伪**（发射全走 `EventDraft` 开放形，字面量多在 `toEqual`/`toMatchObject`/`Partial` 下照旧编译）；真实编译耦合是两个**盖章点**的 `{...draft, …}` 展开（展开进封闭联合编译不过）与语义码品牌化当刻红的**自由字符串调用点**。故 #41＝纯构造面、#47＝封门＋码面＋盖章点＋tests 面。
- **`worldSettled` 定性**：测试合成型（仅 settle.test.ts 手拼、引擎 src 零发射），**不入引擎联合**——五型才是引擎真名全集（`commandRefused`／`say`／`appearance`／`departed`／`arrived`）。

## Decision

1. **`GameEvent = EngineEvent | CustomEvent` 封闭判别联合**（`types.ts`）：引擎五型按 `type` 分型声明语义字段必/可选（pre-veto `commandRefused` 只有 `type`+`reason`，`commandKey` 可选）；顶层 index signature 删除。新引擎事件＝联合加一员＋factory 加一个（`events.ts`）。
2. **扩展臂品牌化、自由 fields 开放承载**：`customEvent(type, fields?)` 是唯一发品牌处——**类型级 phantom 品牌**（`declare const unique symbol`，零运行时改动，守「行为零变化」红线），手写字面量不结构等价、掉不进任何臂。**有意代价明码标价**：自定义自由 fields 拼错**不报**（开放承载＝内容自由度），编译期钉只钉引擎臂字段与骨架，勿给自由 fields 上钉。
3. **语义码取值面单一住所**（`types.ts`）：`reason`（拒绝面 `accessDenied`/`vetoed`/`notVisible`/`sayVetoed`/`moveVetoed`＋解析面 `emptyInput`/`unknownVerb`/`verbMismatch`/`unexpectedArg`/`missingTarget`/`badOrdinal`/`missingNoun`）与 `accessType` 面（`use`/`traverse`/`enter`/`look`）＝引擎字面量＋`customCode(text)` 品牌化自定义码；`DispatchFailure.reason`／`CommandRejection.reason`／`ParseOutcome.reason`／`ctx.veto(reason)`／`commandRefused.reason` 同一面（「reason 单一住所」覆盖 rejected/invalid 双面）。`DEFAULT_VETO_REASON`（`"vetoed"`）机制与 errKey 机制不动。
4. **factory 参数换臂字段型**（#41 形状不变，仅收窄入参）：拼错引擎臂字段、夹带 `type`／骨架键＝新鲜字面量 excess property check 当场红；factory 仍**只统一 `type`**，骨架归盖章点。
5. **盖章点收成受检构造 `stampEvent(draft, skeleton)`**：pipeline emit 与 settler 两个 `{...draft, …}` 展开进封闭联合编译不过，收成 `events.ts` 一处收口（发射时机与字段值零变化；骨架永远盖过 draft 同名键）。第三个 spread 点 `time/due.ts:138` 是 `DueEvent`→`SettleDraft` 的 tick 重盖（draft→draft），封 `GameEvent` 不破它，`EventDraft` 不收形，不入改写清单。
6. **断言面换义**：`ExpectedMessage.event = EventSubset<引擎臂逐型> | CustomEventDraft`——**递归子集**是 `matchesSubset` 的类型孪生（浅 `Partial` 会逼测试把嵌套 digests 写全量，换掉「子集匹配」语义）；自定义期望走 `customEvent`（**`Partial` 不吃品牌**——`Partial<CustomEvent>` 会把品牌变可选、任何字面量都进得来）。

## Considered Options

（八条被否路线全文见 `.scratch/grill-2026-09-29/refusal-event-factory/DECISIONS-WIP.md` C 节）

- **保留 index signature、只加 factory**：被否——绕过 factory 照样拼错。
- **只加常量字段表／全自由表只作文档**：被否——文档不是结构，编译器照样不响。
- **reason/veto reason 留自由字符串**：被否——渲染端无法把码映射成内容文案，「reason 是什么」没有单一住所。
- **只收 engine 构造处，tests 留手拼**：被否——漂移温床照旧。
- **纯封闭联合、无扩展臂**（合成 type 全伪造引擎 type 或 module augmentation）：被否——20+ 处测试合成事件被迫失真。
- **只收 `commandRefused` 一族强类型**：被否——其余四型的拼错洞原样留着。
- **开放扩展臂不带品牌**（H4 陷阱）：被否——引擎事件拼错字段掉进扩展臂照样通过。
- **`ExpectedMessage.event` 用 `Partial<CustomEvent>`**：被否——`Partial` 吃掉品牌，封闭形同虚设。

## Consequences

- 拼错引擎臂字段／夹带 `type`／骨架键／裸字符串码／手写字面量事件：**编译期红**；`tests/events.test.ts` 的 `@ts-expect-error` 钉住这些面，钉失效（面放宽）＝typecheck 自身红。
- 自定义事件的自由 fields 拼错**不报**——开放承载的明码代价；「engine src 一律经 factory」由扫描钉兜底（对象字面量 `type: "…"` 盖章在 `core/src` 除 `events.ts` 零命中，任何 type 字符串）。
- 品牌是类型级 phantom，事件**运行时形状零变化**；不变量是**无品牌的开放 `EventDraft` 展开不进封闭联合**（编译不过）——`stampEvent` 因此是 draft→已投递事件的唯一收口（臂归属/品牌声明点）。带品牌的 `CustomEventDraft` 自身展开保品牌，属扩展臂内部构造（测试夹具亦改走 `stampEvent`，与引擎同一条交付构造）。
- 渲染层（spec/05）按 `type` 判别收窄读臂字段，扩展臂自由 fields 当 `unknown` 读；`GameEvent` 公共面字段名与语义不变。
- 测试网 910 → 915 用例（core 34/682→34/687、web 12/228 不变；新增＝`stampEvent` 2、自由 fields 有意代价 1、编译期钉 2）。
