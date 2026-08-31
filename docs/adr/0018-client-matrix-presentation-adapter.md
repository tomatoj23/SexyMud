# 客户端矩阵与呈现层适配：Web 为基准端，其余端只实现呈现接口

首发 Web（桌面 + 手机浏览器一套响应式覆盖）。其他端是**适配**，不是平行产品：只复用逻辑层与内容，不复用组件代码。

## Context

ADR-0002 已定「Web 优先、核心平台无关」，ADR-0006 已定「core 只吐结构化事件、呈现由内容驱动」。本 ADR 解决剩下的问题：**界面如何跨端**，尤其是微信小程序——它无 DOM，React DOM 不可运行，是唯一无法复用 Web 代码的端。

## Decision

1. **Web 为基准端**：`apps/web`（React + Vite）是唯一首发目标、唯一「完整体验」参考实现。桌面与手机浏览器由同一套响应式布局覆盖（文字 MUD 无图形压力，无需分端）。
2. **极窄呈现接口 `TerminalView`**：UI 逻辑层只依赖它——
   ```
   TerminalView {
     appendOutput(lines: OutputLine[]): void   // 增量追加，不可全量重渲染
     setStatus(panel: StatusPanel): void
     onCommand(cb: (raw: string) => void): void
     setSuggestions(list: string[]): void
   }
   ```
   Web 用 React 实现；其他端各自实现。**跨端共享的是接口、逻辑层与内容，不是组件。**
3. **`OutputLine` 是可移植富文本 token，不是 ANSI、不是 HTML**：
   `{ text, spans: [{ text, style }] }`，`style` 取**语义样式名**（`dim` / `strong` / `emphasis` / `danger` / `good` / `roomName` / `npcName` / `itemName` …）。
   - 样式枚举作为**维度表**落在 `content/config/dimensions.json`（与 ADR-0011 的维度键同构），schema 不写死；各端各自把语义名映射成原生表现（Web → CSS 类，小程序 → `rich-text` 节点 / `span style`）。
   - 理由：小程序无 DOM 且不支持 ANSI 转义；HTML 在所有端都要额外转义且易注入。语义样式名是唯一三端都能落地、又能被内容驱动的中间表示。
4. **桌面端**：PWA 优先（可安装、离线可用，文字游戏零性能压力）。需要独立进程 / 商店分发时再上 **Tauri v2**（体积比 Electron 小一个数量级）。
5. **Android APK**：**Capacitor** 直接包 Web 壳（复用基准端全部代码，成本最低）。若届时桌面已采用 Tauri v2，改用 Tauri mobile 出同一套壳，避免维护两套原生工程。
6. **微信小程序**：唯一无法复用 Web 代码的端。**只按第 2 条的 `TerminalView` 重新实现渲染层**（原生 WXML + `scroll-view` + `rich-text`），**不引入 Taro**。
   - 理由：Taro 是「受限 React」，会绑架整个 UI 层，并与已有 `apps/web` 争夺同一份组件代码（要么全量迁 Taro，要么长期维护两套 UI）；而 MUD 的界面只有三块（文本流 / 输入 / 状态面板），重写渲染层的成本**低于**引入并长期维护一套编译框架。
   - 端侧硬约束：文本流必须**增量 append**，并设输出缓冲上限（config，如保留最近 N 行），超出丢弃最早行——否则长会话会拖垮 `scroll-view`。
## Considered Options

- **全端统一上 Taro**（一套 React 出 Web + 小程序 + H5）：被否——受限 React 绑架 UI 层，与 `apps/web` 二选一；为三块界面引入整套编译框架不划算。
- **全端统一上 uni-app**（Vue）：被否——现有栈是 React + TS，切换等于整体重写，且同样绑架 UI 层。
- **直接上 Electron**：被否——体积与内存成本对本项目的收益为零（文字游戏），Tauri / PWA 更省。
- **首发射微信小程序**（社交传播最好）：被否——它是唯一无法复用 Web 代码的端，先做它会把适配成本压在玩法验证**之前**；应先有可玩的 Web 版本验证玩法（ADR-0017 的「先验证玩法」同理）。（注：合规因素按用户指示不纳入选型考量。）
- **跨端共享 React 组件，仅样式分叉**：被否——小程序根本不能运行 React DOM，共享只在「逻辑层 + 接口」层面成立。

## Consequences

- **组件代码不跨端复用是有意的取舍**：跨端 UI 框架的成本是长期的、不可逆的；本方案把不可逆的部分压到最小（只有一个接口 + 一份逻辑层）。
- **新增一个端 = 实现 `TerminalView` + `SaveStore` + `Clock`**，不碰 `core`。这是 ADR-0002 端口注入设计的直接兑现。
- **语义样式枚举进 config**：加一种高亮 = 加一个维度表项 + 各端映射一次，引擎零改动（符合硬标准 1）。
- **移动端输入法体验是 MUD 的真实门槛**：命令输入依赖打字，移动端需要「常用命令快捷条 + 命令补全（`setSuggestions`）+ 历史回溯」。这三样是 `TerminalView` 的一等职责，不是可选优化。
