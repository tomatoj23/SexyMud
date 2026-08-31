# 05 · 输出管线

> **状态**：全部**待实现**。
> **依据**：ADR-0006、ADR-0018、ADR-0021 §3、ADR-0023 §2/§4/§5/§7、ADR-0024 §4/§5、ADR-0025 §五/§八。

## 1. 管线总览

```
GameEvent（纯语义 JSON）
   ↓  按接收者逐一遍历
渲染纯函数 (event, observerState) => OutputLine[]
   ↓
分块（CJK 显示宽度 + 重放未闭合样式 span）
   ↓
TerminalView.appendOutput()  ← 各端自己实现
```

**关键**：引擎只吐 `GameEvent`；**渲染、分块、呈现全在宿主**。

## 2. 渲染是纯函数

```ts
render(event: GameEvent, observerState: ObserverState): OutputLine[]
```

- **同样事件 + 同样观察者状态 ⇒ 同样输出**（契合 ADR-0017 确定性）
- **必须按接收者逐一遍历**。若做成「先渲染成字符串再群发」，中文的「你／他／她／它」与按观者的可见性差异**永远补不回来**
- 文本模板里**只有引用，不写死名字**，渲染时按每个观察者替换成他认识的那个名字（借自 rpsystem 的 sdesc/recog）

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

## 4. OutputLine：结构化 token，不是 ANSI

```ts
interface OutputLine {
  text: string;
  spans: { text: string; style: StyleName }[];
}
```

- `style` 是**语义样式名**（`dim` / `strong` / `emphasis` / `danger` / `good` / `roomName` / `npcName` / …）
- 样式枚举作为**维度表**落在 `content/config/dimensions.json`，schema 不写死
- **不是 ANSI、不是 HTML** —— 小程序无 DOM 且不支持 ANSI 转义

两条原则：
- **样式不得承载唯一信息**，且必须有**无样式回退**
- 加一种高亮 = 加一个维度表项 + 各端映射一次，引擎零改动

依据：ADR-0018 §3

## 5. CJK 显示宽度

### 5.1 必须自研，且要覆盖的不止全角

Evennia 全仓只有 24 行 `display_len()`（W/F 记 2，其余记 1）：
- **不处理**组合符与变体选择符（应记 **0**）、emoji ZWJ 序列、控制字符
- **几乎没有被调用** —— `evmore`／`ansi`／`text2html`／`evmenu` 全都没用它

### 5.2 ⚠️ 必须注入切块器本身

**Evennia 正是漏了这一步**（它的 `evmore` 纯按行数切，`justify=True` 时用裸 `len(line)`）。

所以不只是"写个函数"，而是**折行、截断、对齐、分块全部要走它**。

依据：ADR-0023 §4、ADR-0024 §4

## 6. 分块要重放未闭合的样式 span

借自 `ANSIString` 的**机制**（不是它的 ANSI 语法）：

1. 维护 token 数组 + 平行的「**可见字符索引**」
2. 切块时把可见偏移反查回 `(tokenIndex, intraOffset)`
3. 在每个分块首尾**重开所有未闭合的 span / 补闭合**

适用于小程序端的输出缓冲上限裁剪。

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

- **跨端只共享接口与逻辑层，不共享组件**
- Web（React）是唯一基准端；小程序用原生 WXML + `scroll-view` 实现；APK 用 Capacitor 包 Web 壳
- 移动端三件套是**一等职责**：常用命令快捷条 + 命令补全 + 历史回溯

依据：ADR-0018

## 10. 自检清单

- [ ] `GameEvent` **不含已渲染文本**
- [ ] 渲染是纯函数 `(event, observerState)`
- [ ] **按接收者逐一渲染**（不是先渲染后群发）
- [ ] 采用 **Actor stance**，中文人称代词正确
- [ ] 输出是**结构化 token**，不是 ANSI / HTML 字符串
- [ ] 样式名是**语义名**，枚举在 `config/dimensions.json`
- [ ] 显示宽度函数覆盖全角／组合符／emoji／控制字符
- [ ] **宽度函数被切块器调用**（不是只写不用）
- [ ] 分块**重放未闭合样式 span**
- [ ] 输出**非模态**，不劫持输入
- [ ] 输出缓冲有上限，增量 append
- [ ] 引擎 markup 用**玩家无法产生的码位**
- [ ] 可点击命令只来自引擎/内容侧
- [ ] 移动端三件套（快捷条 / 补全 / 历史）已实现
