# 05 · 输出管线

> **状态**：**文本面已随引擎出厂**（#50：`packages/core/src/text/`——五型渲染纯函数、显示宽度、避头尾折行、切块与 span 重放）；**web 基准端已落**（#51：`apps/web/src/ui/terminalView.ts`——纯 TS 状态机〔追加式输出＋500 行缓冲丢最早＋命令通道〕＋ React 呈现 `GameTerminal.tsx`；标题屏/世界引导/走看说/自动存在 `apps/web/src/game/`）。
> **依据**：ADR-0006、ADR-0018、ADR-0021 §3、ADR-0023 §2/§4/§5/§7、ADR-0024 §4/§5、ADR-0025 §五/§八。

## 1. 管线总览

```
GameEvent（纯语义 JSON）
   ↓  按接收者逐一遍历
渲染纯函数 renderEvent(event, observer, content) => OutputLine[]   ← 引擎出厂（src/text/render.ts，#50）
   ↓
折行＋切块 foldLine / chunkOutput(lines, { width, height })         ← 引擎出厂（src/text/wrap.ts、chunk.ts，#50）
   ↓
TerminalView.appendOutput()  ← 各端自己实现（呈现与喂参）
```

**关键**（#48 D5 收准，随 #50 落地）：引擎只吐 `GameEvent`；**渲染、折行、切块随引擎出厂**（spec/07 把 CJK 显示宽度、避头尾折行列为引擎侧职责），**宿主只做呈现与喂参**——宽度/视口高度是切块器入参，取字表/名字表/enterText 随渲染器入参注入（Q6/Q7）。原「渲染、分块、呈现全在宿主」措辞随 #50 实现修订。

## 2. 渲染是纯函数（已落：`src/text/render.ts`，#50）

```ts
renderEvent(event: GameEvent, observer: ObserverState, content: RenderContent): OutputLine[]
```

- **事件形状**（spec/01 §5，#47）：`GameEvent` 是封闭联合 `EngineEvent | CustomEvent`——渲染层按 `type` 分派各臂的渲染函数、读该臂的语义字段（引擎臂字段已分型；判别只在引擎五型之间收窄——扩展臂 `type` 是开放串，经 `isEngineEvent` 守卫显式分流）。扩展臂（合成／宿主事件）**显式不渲染**（注释点名，测试钉跳过语义；渲染缝随机制模块票）。事件零已渲染文本（spec/01 §5.1）：拒绝文案一律经语义码＋`errKey` 回内容数据取。
- **取字表随渲染器入参注入**（Q6/Q7，#48 裁决）：`RenderContent` 携取字表（模板＋第二人称代词）、名字表、房间描述/enterText、拒绝取字（`commandKey→errKey→文案` 与语义码面）——纯函数零 IO、零注册表读；名字缺表回退裸 id、描述/enterText 缺表跳行、拒绝取字两面皆缺大声抛错（接线失配看得见）。
- **同样事件 + 同样观察者状态 + 同样取字表 ⇒ 同样输出**（契合 ADR-0017 确定性）
- **必须按接收者逐一遍历**。若做成「先渲染成字符串再群发」，中文的人称代词与按观者的可见性差异**永远补不回来**
- 模板里**只有 `{引用}`，不写死名字**，渲染时按每个观察者替换成他认识的那个名字（借自 rpsystem 的 sdesc/recog）；拼错的占位符原样留在输出里（看得见的接线错）

依据：ADR-0023 §2、ADR-0025 §五.3

## 3. 立场：Actor stance（第二人称）

| 接收者 | 读到 |
|---|---|
| 当事人（自己出手） | 「你一剑刺向他的左肩。」 |
| 当事人（对手出手） | 「黑衣人一剑刺向你的左肩。」 |
| 旁观者 | 「黑衣人一剑刺向张三的左肩。」 |

**中文红利**：中文**无动词变位**，不需要 Evennia 的 `$conj()`；只需处理**人称代词**（你／我／他／她／它／您／咱们）。这套机制比英文轻一个数量级。

**单机阶段没有旁观者，但 NPC 在场时仍需第三人称——第一天就做对**，否则联网时要重写全部战斗文本。

依据：ADR-0021 §3

## 4. OutputLine：结构化 token，不是 ANSI（已落：`src/text/line.ts`，#50）

```ts
interface OutputLine {
  text: string;                          // 无样式回退：整行纯文本
  spans: { text: string; style: StyleName }[];   // 完整平铺：每字恰属一个 span
}
```

- `style` 是**语义样式名**——五型渲染今日实际发出的是闭集 `plain`／`npcName`／`commandHint`／`roomName`／`itemName`／`danger`（`plain` 是引擎的无样式词）；`dim`／`strong`／`emphasis`／`good` 已在维度表挂名、待后续渲染面启用
- 样式枚举作为**维度表**落在 `content/config/dimensions.json` 的 `style` 维度（#50 起 `plain` 入表），schema 不写死
- **不是 ANSI、不是 HTML** —— 小程序无 DOM 且不支持 ANSI 转义
- spans **完整平铺**（拼接＝text）是折行/切块能在任意处下刀、两侧各自成线的前提（§6）

两条原则：
- **样式不得承载唯一信息**，且必须有**无样式回退**（`text` 字段即回退）
- 加一种高亮 = 加一个维度表项 + 各端映射一次，引擎零改动

依据：ADR-0018 §3

## 5. CJK 显示宽度（已落：`src/text/width.ts`，#50）

### 5.1 必须自研，且要覆盖的不止全角

Evennia 全仓只有 24 行 `display_len()`（W/F 记 2，其余记 1）：
- **不处理**组合符与变体选择符（应记 **0**）、emoji ZWJ 序列、控制字符
- **几乎没有被调用** —— `evmore`／`ansi`／`text2html`／`evmenu` 全都没用它

落地口径（#50 初稿表，B8 同律可实现期调）：全角＝2（含全角标点、破折号—与省略号…按中文排版记 2）；组合符 Mn/Me、变体选择符、emoji 修饰符（肤色）、控制字符、格式字符＝0；Mc 记 1；拉丁邻接歧义符号记 1；emoji 图形块记 2；**旗对**（regional indicators 两两成对）整对记 2；**ZWJ 链**（含「窄底＋VS16」续接）整链记一个底座宽。原子切分（`splitUnits`）供折行/切块共用。

### 5.2 必须注入测量本身（已落：折行/切块全走宽度函数）

**Evennia 正是漏了这一步**（它的 `evmore` 纯按行数切，`justify=True` 时用裸 `len(line)`）。

所以不只是"写个函数"，而是**折行、截断、对齐、分块全部要走它**——`src/text/` 的折行器与切块器对每一处测量都经 `width.ts`，测试钉「按字符串长度折行即红」（全角例）。

依据：ADR-0023 §4、ADR-0024 §4

## 6. 分块要重放未闭合的样式 span（已落：`src/text/wrap.ts`＋`chunk.ts`，#50）

借自 `ANSIString` 的**机制**（不是它的 ANSI 语法）：

1. 维护 token 数组 + 平行的「**可见宽度**」（落地形：`splitUnits` 原子单元，单元携带 span 样式）
2. 切块时把可见偏移反查回 token（落地形：折行器在单元粒度上决定刀口，刀口查询即反查）
3. 在每个分块首尾**重开所有未闭合的 span / 补闭合**（落地形：物理行 spans 完整平铺——跨越刀口的 span 在前行末闭合、次行首重开，相邻同样式段合并回一个 span；切块边界只落在整物理行之间，永不切穿 span）

适用于小程序端的输出缓冲上限裁剪。**避头尾折行**（B8）同在折行器内建：行首禁则（收尾标点族＋破折号后半）、行尾禁则（起始标点族＋破折号前半）、`——`／`……` 成组不拆——**折行时处理、不是折完再修**；禁则表初稿见 #50 AC，B8 授权可实现期调（全角问号已作同族补全入表）。

依据：ADR-0024 §5

## 7. 非模态输出（不做 EvMore）

- 输出是**追加式滚动流**，分页**不得劫持输入**
- 只取「按显示高度切块 + 边界感知」
- 分页/滚动是**客户端职责**（`TerminalView`）
- 输出缓冲设上限，超出丢弃最早行（否则长会话拖垮小程序的 `scroll-view`）

**证据**：EvAdventure 这个完整游戏**大半开发量花在绕开 EvMenu 的模态性**，整个游戏只新增 5 条命令。

依据：ADR-0023 §7、ADR-0025 记录

## 8. 输入加固

### 8.1 模型：解析前转义 + 白名单重建（不是黑名单过滤）

Evennia 的做法：`raw()` 把 `{` → `{{`、`|` → `||`；`strip_unsafe_tokens()` 剥掉会造成视觉攻击的标记（换行、标签）；长度上限在**进引擎之前**截断。

### 8.2 ★ 更进一步：构造性保证

**引擎 markup 使用玩家无法产生的字符集**（`\x00` 前缀或 Unicode 私有码位）。

这样「玩家文本不可能被误认为引擎指令」是**构造出来的**，而不是靠正则兜底。

### 8.3 可点击命令

**只能来自引擎／内容侧，绝不能来自玩家输入**（防钓鱼）。Evennia 的 MXP 实现只做了 `"` → `\&quot;` 的转义，注入面真实存在。

依据：ADR-0022 §8（可点击命令只来自引擎／内容侧）、ADR-0025 §八

## 9. 多端：TerminalView

```ts
interface TerminalView {
  appendOutput(lines: OutputLine[]): void;   // 增量追加，不可全量重渲染
  setStatus(panel: StatusPanel): void;
  onCommand(cb: (raw: string) => void): void;
  setSuggestions(list: string[]): void;
}
```

**web 基准端已落**（#51：`apps/web/src/ui/terminalView.ts`——纯 TS 状态机承载共享逻辑〔追加式输出＋缓冲 500 行丢最早＋稳定行 id〕，React 呈现在 `GameTerminal.tsx`）。四方法是**跨端共享面**；各端可再挂自己的 glue（web 端：命令框提交通道 `submitCommand`＋React 订阅 `subscribe`/`getSnapshot`），glue 不进跨端契约。

- **跨端只共享接口与逻辑层，不共享组件**
- Web（React）是唯一基准端；小程序用原生 WXML + `scroll-view` 实现；APK 用 Capacitor 包 Web 壳
- 移动端三件套是**一等职责**：常用命令快捷条 + 命令补全 + 历史回溯（⚠️ 可玩闭环首刀切片不含移动三件套——**系切片非翻案**，本条仍是目标态）

依据：ADR-0018

## 10. 自检清单

- [x] `GameEvent` **不含已渲染文本**（M1-T1 定契约；M2-T1 测试显式断言事件串不含 `err_*` 文案）
- [x] 渲染是纯函数 `(event, observerState)`（#50：`src/text/render.ts`，取字表随第三参注入——Q6）
- [x] **按接收者逐一渲染**（不是先渲染后群发）（#50：`ObserverState` 单观者签名）
- [x] 采用 **Actor stance**，中文人称代词正确（#50：当事人读第二人称代词、旁观者读名字表）
- [x] 输出是**结构化 token**，不是 ANSI / HTML 字符串（#50：`src/text/line.ts`）
- [x] 样式名是**语义名**，枚举在 `config/dimensions.json`（#50：`style` 维度，`plain` 入表）
- [x] 显示宽度函数覆盖全角／组合符／emoji／控制字符（#50：`src/text/width.ts`——另覆盖变体选择符记 0、肤色修饰符记 0、旗对与 ZWJ 链折叠）
- [x] **宽度函数被切块器调用**（不是只写不用）（#50：折行/切块测量全走 `width.ts`，全角例钉「按长度折行即红」）
- [x] 折行器**内建避头尾**（行首禁则／行尾禁则），不是折完再后处理（B8）（#50：`src/text/wrap.ts`，禁则逐条参数化测试）
- [x] 分块**重放未闭合样式 span**（#50：物理行完整平铺＋同 span 刀口两侧闭/开）
- [x] 输出**非模态**，不劫持输入（#51：输出流滚动＋命令框常驻，分页不拦输入）
- [x] 输出缓冲有上限，增量 append（#51：缓冲上限 500 行、超出丢最早，`apps/web/src/ui/terminalView.ts`＋panel-rig 钉丢行与追加不动旧行）
- [ ] 引擎 markup 用**玩家无法产生的码位**（输入加固全量随机制面；#51 首刀已按 token 渲染＋玩家输入原样显示〔`GameTerminal.tsx` 无 markup 解释〕，码位级加固仍待机制面。**机制面票落地须含换行 strip**——#51 复核已复现：玩家输入内嵌换行穿透到输出行，`white-space:pre` 下可伪造额外行〔§8.1 strip 族〕）
- [ ] 可点击命令只来自引擎/内容侧（同上）
- [ ] 移动端三件套（快捷条 / 补全 / 历史）已实现（可玩闭环首刀切片不含——目标态）
