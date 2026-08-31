# SexyMUD 手册（统一总览）

> 🎯 **定位（ADR-0026）**：本项目是**一个中文优先的确定性文字 MUD 引擎**，武侠是它装载的第一套内容包。三条硬标准由此从「开发纪律」升级为「产品定位」。
> 支柱：**中文是一等公民**（不是适配层）／**确定性**（可重放、可搬服务端）／**内容即数据**（JSON + Schema 硬门禁）。
> 验收：换一套非武侠内容，引擎不改一行代码。

**武侠内容包**：命令驱动，世界由房间与人物构成，战斗反馈以叙事文本为主体。战斗文本对标侠客行（xkx100）。进度主轴 = **武功修习**（招式按等级解锁）+ 空间探索 + 装备构筑，**不设境界突破**（ADR-0019）。特色 = 门派/流派二分 + 装备 × 武功构筑。
本文件是**索引与速查**，定案细节以权威文档为准。

## 权威与文档地图

| 文件 | 作用 | 状态 |
|---|---|---|
| **`docs/spec/`** | **活规格**（8 份：总览／引擎契约／命令层／世界模型／状态与时间／输出管线／内容 Schema／中文层／**non-goals**） | ✅ **开工先读** |
| `CONTEXT.md` | 术语词典（**武侠内容包**作用域，非引擎） | ✅ 权威（最高） |
| `docs/agents/content.md` | `content/` 目录、id 规则、字段约定、批量工作流 | ✅ 权威 |
| `docs/adr/0001`–`0027` | 27 个架构决策（0016–0027 = MUD 转向与引擎定位） | ✅ 权威 |
| `content/style-guide.md` | 叙事文风硬约束 | ✅ 权威 |
| `docs/engine-reservations.md` | 引擎预留清单（`condition` 维度 / `targetSelector` / 效果与装备影响穷举） | 参考（效力低于 ADR，供 effects 与 condition 设计对齐） |
| `docs/chinese-mud-concerns.md` | **中文 MUD 特有问题全景**（输入／显示／叙事／检索／编码，含待定项） | 设计研究（**非 ADR**，是需求来源） |
| `docs/engine-purity-audit.md` | 换内容演练审计报告（五处耦合 + 清零结论） | 一次性证据 |
| `AGENTS.md` | agent 环境、技能、管线入口 | ✅ |
| `docs/agents/domain.md` | 工程技能如何消费本仓库文档（含 monorepo 路径规范） | ✅ |
| `docs/agents/issue-tracker.md` | Issues 走 GitHub（`gh` CLI） | ✅ |
| `schemas/` | JSON Schema（**16 个**；`config` 拆 5 类）；`content:check` 实际执行其中 config 3 类 | 🚧 `commands` / `rooms` / `npcs` 的 schema 待 M1 补；其余集合随内容落地启用 |
| `docs/research/xkx100-*.md` | **一手调研**：房间/NPC/物品/任务结构、武功体系、**战斗文本模板与 50 档造诣完整列表** | 参考（高价值） |

**冲突处置顺序**：`CONTEXT.md`（术语）／ `content.md`（内容管线）> `docs/adr/` > `content/style-guide.md`（文风）> `docs/engine-reservations.md`（**参考**：设计清单，不是定案）。

> 🧹 放置游戏时期的 `docs/design-spec-BRIEF.md`（1000+ 行规格，MUD 转向后已失准）、`docs/archive/`（设计会话记录）、`docs/design/`（废弃稿）**已于 2026-09-01 删除**；BRIEF §11 的引擎预留清单已提取至 `docs/engine-reservations.md`，50 档造诣表在 `docs/research/xkx100-kungfu-combat.md` §5.1。如需回溯：`git checkout 79bd991 -- docs/design-spec-BRIEF.md docs/archive/`。

## 三条硬标准

1. **引擎与内容完全分离**：引擎零题材词汇、零写死数量；造诣档位表、槽数、维度表、阈值、命令动词等结构性配置只在 `content/`（含 `config/`）。
2. **面向未来**：修饰符聚合引擎、带完整语境的事件流、版本化存档迁移、Schema 三处同步（core／编辑器／`content.md`）、`content:check` 硬门禁——第一天做对；MVP 只控制系统数量，不降低架构完备度。
3. **依赖环境自包含**：`corepack pnpm`（版本由根 `package.json` 的 `packageManager` 锁定）、包缓存在项目内 `.pnpm-store/`；禁止 `npm i -g`、改全局 PATH、升级宿主机 Node（ADR-0007）。

## 核心定案速查

| 域 | 定案 | 出处 |
|---|---|---|
| 造诣 / 显示档位 | **50 档**区间表（非「等级 ÷ 步长」），由武功等级 + 实战经验推导，**纯显示不设门槛**；另有生产称谓 16 档。完整列表见 `docs/research/xkx100-kungfu-combat.md` §5.1；「超凡入圣」「天人合一」豁免禁修仙词 | `CONTEXT.md` |
| 伤害模型 | 兵刃层（恒有、受外功防御减）+ 系别层（× 系别系数）；方式（内功/外功）× 系别（七系 + 无属性）= 2×8；玩家抗性 = 条件修饰符（非属性） | ADR-0009 |
| 内力 | 持续回复 + 离线稳态结算 O(1)；耗尽 → 零消耗基础攻击；代价"在另一维度付账" | ADR-0010 |
| 战斗文本 | 13 槽位 `{attacker}` 语法；模板 = 片段序列（3–7 段）；后果词库 5 维分池；三层门控；motion 是**动词**的属性 | ADR-0011 |
| 秘境与产出 | 分层驻守（难度涌现）；四参数在 config；掉落 8 步管线（**稀有度是因、词条数是果**）；底材分层 + 倾向标签化 | ADR-0012 |
| 装备 | **7 槽**（兵/冠/甲/腕/腰/裤/靴）+ 独立随从栏（兽）；稀有度四档；底材分层 + 倾向标签化 | `CONTEXT.md`／ADR-0012 |
| 呈现 | 对峙式视觉层 + MUD 式叙事层；`core` 只吐结构化事件，不感知题材 | ADR-0006 |
| 构筑 | 掉落驱动（底材 × 稀有度 × 词缀阶位）；流派由标签联动涌现 | ADR-0005 |
| 内容管线 | `content/` **16 个集合**（原 13 + `commands/` `rooms/` `npcs/`）+ `config/`（结构性配置）；每条目一 JSON 文件；id 一经发布不可变更 | `content.md` |
| 兽 | 本质是装备（修饰符 + 叙事片段），不是战斗单位；七系各一只**机制放大器**；独立随从栏不占 7 槽；数据在独立 `beast/` 集合（第 13 集合），获取走 sect `exchange` 兑换 | ADR-0013 |
| 门派 | 武功池 + 缺省系别 + 生产加成三件套；脉是武功池标签、非身份选择；已学武功与门派解耦 | ADR-0014 |
| 成长与反馈 | 招式解锁 + 造诣晋升替代天赋树；战斗摘要／同对手对照补中频反馈；专精靠词缀涌现 | ADR-0015／0019／0020 |
| **玩法主次** | **MUD 为主，放置为辅**：在线命令交互是核心体验；离线只补气血／内力恢复与基础武功熟练度（有上限），**不自动战斗、不推层、不产掉落** | ADR-0016／0019 |
| **交互模型** | 命令层内容化（`commands/` 的动词/别名/前置/拒绝文案全是数据，**引擎零动词**）；世界 = 房间（`rooms/`）+ 人物（`npcs/`）；**双时钟**（心跳 tick ／ 离线结算，不共用代码路径） | ADR-0016 |
| **intent** | **manual-source 优先**（命令输入是主要来源），auto 降级为「未下指令时的默认行为」与自动应战模式；共用注册位，切换不改 core | ADR-0016 |
| **权威端** | **单机优先 + 薄服务端**：世界模拟在本机，服务端只做云存档／排行榜／聊天；`Authority` 端口隔离，界面永远不认实现；core 必须保持完全确定性（禁 `Math.random()` ／ `Date.now()`） | ADR-0017 |
| **客户端矩阵** | Web（React + Vite）是唯一基准端；跨端只共享 `TerminalView` 接口与逻辑层，**不共享组件**；小程序端重写渲染层、**不引入 Taro**；桌面 PWA → Tauri v2，APK 用 Capacitor | ADR-0018 |
| **输出行** | 可移植富文本 token：语义样式名（枚举在 `config/dimensions.json`），不是 ANSI、不是 HTML | ADR-0018 |
| **进度主轴** | **取消境界门槛**；三根并行：武功修习（招式按等级解锁，主）／空间探索（战力门槛）／装备构筑。造诣 50 档改为由武功等级 + 实战经验推导的**纯显示层**；内容分层锚改用 `recommendedPower` 区间 | ADR-0019 |
| **七系** | **每系必须有一个结构签名**（频次／节奏／档位跃迁／事件触发／状态词条），**禁止纯数值系数**。**硬判据**：关掉 UI 只读文本，玩家能说出自己是火系还是风系 | ADR-0020 |
| **反馈三层** | ① 战斗摘要（战后一行画像，由签名生成，是 build 的指纹）② 同对手对照（昨我 vs 今我：「三日前三十合，今日十一合」）③ 社会层（50 档造诣 + NPC 敬称） | ADR-0020 |
| **命令可用性** | **多源合并**：会话／玩家／角色／携带物／所在地／周围物件／**出口（优先级最高，永远可用）**，按 `priority` + `mergetype`（Union/Replace/Remove/Intersect）合成。全是内容字段，引擎零改动 | ADR-0021 |
| **出口** | **独立实体，不是房间字段**；方向即命令（中文「北／南／上／出」+ 英文缩写并列）。门禁挂在出口上，拒绝文案是内容 | ADR-0021 |
| **视角** | **Actor stance（第二人称）**：同一事件，当事人读到「你…」、旁观者读到「黑衣人…」。中文无动词变位，只需代词替换——**第一天做对，否则联网时全部文本返工** | ADR-0021 |
| **别名** | 两层：**内容层**（`commands[].verbs[]`，全局）+ **玩家层**（存档 nicks，个人，支持模板）。中文输入成本高，个人别名是刚需 | ADR-0021 |
| **状态持久化** | `db.*`（持久，进存档）／ `ndb.*`（非持久，重启即失，**游戏逻辑不得读取**）。**未显式写入的字段不落盘**，改默认值时既有存档自动跟随 | ADR-0022 |
| **条件表达式** | **JSON 数组** `{all/any/not}` + 通用谓词（`attr_gte`/`has_tag`/`has_flag`/`has_state`…），**不用字符串 DSL**（无法被 Schema 校验）；拒绝文案 `err_*` 也是数据 | ADR-0022 |
| **原型继承** | 条目可带 `prototypeKey` / `prototypeParent`（多亲，左到右优先）；`attrs`/`tags` **互补合并**，其余键整体替换。动态值走种子化白名单求值（**禁 `$random()` 式 protfunc**） | ADR-0022 |
| **时间推进** | **按需求值**（纯函数 `f(startTick, nowTick)`）而非每 tick 遍历；时间源 = **引擎 tick 计数**。订阅式心跳只留给全局事件 | ADR-0022 |
| **输出安全** | 可点击命令**只能来自引擎／内容侧**，绝不能来自玩家输入（防钓鱼）；样式不承载唯一信息，须有无样式回退 | ADR-0022 |
| **测试契约** | 命令测试骨架：`call(cmd, args)` 手工跑 `at_pre_cmd → parse → func → at_post_cmd`，断言**输出消息序列**（前缀匹配）。注入四件套：时钟／输出汇／世界夹具／**RNG 种子**（种子是 Evennia 缺的，必须补） | ADR-0023 |
| **渲染** | 纯函数 `(event, observerState) => string`：模板里只有引用不写死名字，按**每个观察者**分别替换 | ADR-0023 |
| **CJK 计宽** | 显示宽度须自研 `wcwidth` 式函数（全角 = 2）。Evennia 按字符数计宽，中文会折行错位——**中文项目不可回避** | ADR-0023 |
| **冷却与定时** | 一律存**到期 tick**，不存时间戳；判定是 tick 比较而非定时器回调。**引擎内禁 `setTimeout`** | ADR-0023 |
| **分支内容** | 节点图（`{文本, 选项[]}`，`goto` 指向节点名或具名 effect）+ **具名 effect 注册表**；**内容只被 parse，不被 eval** | ADR-0023 |
| **命令解析** | **必须自研**：Evennia 按空格分词，中文无空格。改用**最长动词匹配**（长优先防子串冲突）+ 参数形态由命令条目声明。**不引入分词库** | ADR-0024 |
| **确定性清单** | 测试环境须逐条封死：延时回调队列、全局缓存（**禁对象 id 做键**）、集合迭代顺序、自增 ID、世界 fixture 深拷贝（无事务回滚）、RNG 种子 | ADR-0024 |
| **CJK 计宽** | 不止 wcwidth：要覆盖零宽／组合符／emoji，且**必须注入切块器本身**（Evennia 的 `display_len` 存在但几乎没被调用） | ADR-0024 |
| **输出分块** | 切块时**重放未闭合的样式 span**（借鉴 ANSIString 的可见字符索引机制） | ADR-0024 |
| **原型继承** | 仅 `attrs`/`tags` 互补合并、其余整体替换（规则对）；但须补**归一化**、**环检测**（校验器）、**`prototypeKey` 禁止继承** | ADR-0024 |
| **条件表达式** | `{all/any/not}` **必须允许递归嵌套**（否则弱于 lockstring 的 `a AND b OR c`）；外层是 `Map<accessType, expr>` + `default` | ADR-0024 |
| **命令契约** | 每条命令**必须携带 `actorId`**（最贵的 retrofit，今天做）；事件侧也要 `seq`；`CommandResult` 区分 `rejected`／`invalid`／`transport` 三类失败（重试语义不同）。**`GameEvent` 绝不含已渲染文本** | ADR-0025 |
| **状态层** | **不需要 attribute handler**（那一千行是在为 SQL↔Python 阻抗失配买单）。要的是：typed 状态对象 + 版本化迁移链 + 加载时倒排索引 + 薄门面。`derived` 标记派生态，序列化排除、加载重算 | ADR-0025 |
| **调度原语** | 六个（可砍到四）：Clock ／ 纯 stage 求值 ／ **观察时补偿结算**（把 ticker 降级为纯函数）／ 到期桶 ／ 区域 tick ／ on-change。**禁 per-object timer** | ADR-0025 |
| **游戏内时间** | 时辰／刻／季节全是 `nowTick` 的**纯函数**，渲染时推导、**绝不存储** | ADR-0025 |
| **实体 hook** | 第一天必须定对的九项（移动三元组带 `moveType`／`move_to` 不查权限／**按接收者逐一渲染**／`return_appearance` 纯返回／可见性在 `at_look` 内／pre-post 配对／`at_object_post_creation` 让 JSON 赢默认值／动态命令集） | ADR-0025 |
| **输入加固** | **解析前转义 + 白名单重建**，不是黑名单。引擎 markup 用**玩家无法产生的私有码位**——不可混淆是构造性保证 | ADR-0025 |
| **测试权重** | 压在**边界**（输入 token 化、序列化往返、玩家文本 vs 引擎 markup）而非规则逻辑。Evennia 的密度分布证明：最密处是「易构造且曾出 bug」，不是风险本身 | ADR-0025 |
| **配置三分法** | STRUCTURE（装配图，不进 settings）／ TUNING（数字，进 `settings.json`）／ POLICY（决策，另开 `policy.json`）。**禁用 `null` 表「无限」**；时间单位写进键名；每组加 `formula` | ADR-0025 |
| **扩展模型** | 三层：**内核**（实体/移动/命令/事件/时间/持久化，**完备但最简**）+ **六条契约**（效果/条件/事件/状态/命令/时间）+ **可选机制模块**。模块间**只通过契约交互，不互相 import**（N² 降为 N） | ADR-0027 |
| **不做插件系统** | 现在不做（YAGNI，边界未验证）。扩展靠契约。待第二套内容包出现时，把已实现的机制**抽**成模块——**先做对，再拆开** | ADR-0027 |

## MVP 范围（待重估，勿按此排产）

> ⚠️ **本表源自放置游戏时期，MUD 转向后已失准。**
> - 已翻案：「任务体系」「独立 NPC 集合」（ADR-0016）
> - 已作废：一切境界相关内容（ADR-0019）
> - **MUD 化后优先级改变**：**房间与人物先于秘境分层**——没有可走的世界就没有 MUD

原表（仅供历史参考）：门派 3 ／ 秘境 3 ／ 兽 2 ／ 底材 42 ／ 词缀池 20+ 条 × 3 阶 ／ 招式 4 · 心法 3 ／ primitive 9 个使用 + 2 个注册 ／ 出招调制器 4 ／ 内力最小形态 ／ 只做闪避

**明确不做**：知识/生活技能、换派偷师、招架/格挡、`itemLevel`（ADR-0008）

## 当前状态

- ✅ 术语词典、文风指南、内容管线约定、**22 个 ADR**
- ✅ **Schema 16 个**：覆盖 16 个集合（`config` 拆 5 类 activities / dimensions / display-tiers / resources / settings；+ effects / martial / equipment / beast / monster / dungeon / herb / pill / sect / event / combat-text）。**`commands` / `rooms` / `npcs` 的 schema 待 M1 补**
- ✅ 兽数据归属已定：独立 `beast/` 集合（第 13 集合），获取走 sect `exchange` 贡献兑换（ADR-0013）
- 🚧 `content/` 条目填充：config 已有 activities / resources / settings **三个**最小文件（dimensions、display-tiers 待补），其余集合待生产（见 issue #17）
- ✅ **Monorepo tracer bullet 已落地（issue #2）**：`packages/core`（纯 TS 引擎门面 `createGame`，注入 content/save/clock/rng）+ `apps/web`（React + Vite 壳，本地存档、刷新不丢）+ `apps/editor` 占位；三测试套件（门面行为 / 存档迁移 / 引擎纯度）；版本化存档 v1 + 迁移链骨架
- ✅ **`content:check` 最小形态已落地**：`scripts/check-content.mjs` 自动发现 `content/` 下全部 JSON 并按目录约定映射 Schema 校验，退出码即结果（当前覆盖 config 3 文件）；完整化（交叉引用 / 连通性 / 反向扫描孤儿 schema）见 issue #3
- ✅ **MUD 转向已定案（2026-09-01）**：ADR-0016 交互模型 ／ ADR-0017 权威端抽象 ／ ADR-0018 客户端矩阵；ADR-0008 部分翻案（任务体系、NPC 集合）；`CONTEXT.md` 新增「世界与交互」术语段 7 条，`intent` 改判为 manual-source 优先
- ✅ **ADR-0019 / 0020 已定案（2026-09-01）**：取消境界突破（进度主轴改为武功修习／空间探索／装备构筑）；七系从系数升级为结构签名 + 三层反馈定案
- 🧹 **无关内容已清理（2026-09-01）**：删除 `docs/design/`（废弃设计稿）、`docs/research/ui-mockups/` + `idle-ui-references.md` + `ui-gen-prompts.md`（放置期视觉资产）、`prototype/`（结论已迁至 ADR-0006/0011）、`apps/web/dist/`、`docs/design-spec-BRIEF.md`（放置期规格，§11 已提取至 `docs/engine-reservations.md`）、`docs/archive/`（放置期设计会话记录）。恢复命令：`git checkout 79bd991 -- docs/design-spec-BRIEF.md docs/archive/`
- ✅ **ADR-0023 已定案（2026-09-01）**：测试契约与输出层约定（命令测试骨架 / per-observer 渲染 / CJK 计宽 / tick 化定时 / 节点图 / 非模态输出）
- ✅ **ADR-0024 已定案（2026-09-01）**：Evennia 源码级第二轮——**中文解析器必须自研**（Evennia 按空格分词，中文无空格）、确定性检查清单、`.call()` 三处缺陷不照抄、CJK 范围扩大、原型与条件表达式的边界修正
- ✅ **ADR-0025 已定案（2026-09-01）**：Evennia 第三轮（源码 + 完整示例游戏 EvAdventure）——**不能后补的地基**：命令携带 `actorId`、事件侧 `seq` 与三类失败、**不需要 attribute handler**、调度六原语（含「观察时补偿结算」）、游戏内时间是 tick 纯函数、**实体 hook 九项**、输入加固用私有码位、测试权重压边界、配置三分法
- ✅ **ADR-0026 已定案（2026-09-01）· 定位升级**：**我们做的是引擎**——中文优先的确定性文字 MUD 引擎 + 武侠内容包。三条硬标准从「纪律」升级为「产品定义」；确立取长补短分工（Evennia 给架构、xkx100 给中文叙事、我们补确定性/JSON 门禁/多端结构化输出）
- ✅ **`docs/chinese-mud-concerns.md` 已落**：中文 MUD 特有问题全景（A 输入／B 输出／C 叙事／D 检索／E 编码／F 中立性），26 条，**6 条待定**（避头尾折行与中文排序最贵）
- ✅ **换内容演练已完成（2026-09-01）**：结论是「通过词汇检验、未通过领域检验」——引擎读的是放置模型（`cycleSeconds`/`offlineCapHours`）且 `Clock` 是墙钟毫秒。五处耦合见 `docs/engine-purity-audit.md`
- ✅ **领域模型已清零（2026-09-01）**：删除放置遗留的配置面、引擎门面与内容绑定加载器；**保留**纯度测试、`content:check`、迁移链。同时把 `docs/spec/01` 的端口与契约落成 `packages/core/src/types.ts`（Clock 改 tick 计数、命令带 `actorId`、事件带 `seq`、三类失败）
- 🚧 **下一步 M1**：命令测试骨架 → 中文解析器 → `commands/` `rooms/` `npcs/` 三个集合。起点见 `docs/spec/02-command-layer.md`
- 🚧 **下一步 M1**：**先搭命令测试骨架（ADR-0023 §1）**，再做 `commands/` `rooms/` `npcs/` 三个集合 + schema 三处同步（core 类型／编辑器／`content.md`）+ 命令解析管线 + 双时钟拆分（`tick()` ／ `settleOffline()`）
- ✅ **术语清理已完成（2026-09-01）**：`CONTEXT.md` 删除「境界／修为／突破／闭关／突破丹」，新增「实战经验／武功等级／练功／潜能／造诣」，改写「显示档位／兽／内力／intent／离线结算／疗伤丹」；`style-guide.md` 改「静修／造诣档位」；HANDBOOK 与 10 个 schema 全表去放置语汇（波次／DPS／挂机／Melvor／断链 BRIEF 引用 ×33）
- ✅ **境界已从代码删除（2026-09-01）**：`packages/core` 去掉 `realmId` / `currentRealm()` / `progress()` / `content.realm()` / `RealmConfig` / `RealmProgressSettings`；删除 `content/config/realms.json` 与 `config.realms.schema.json`；`settings.json` 去掉 `realmProgress`；`martial` schema 的 `realmIndexMin` → `martialLevelMin`，`dungeon` 的 `recommendedRealmIndex` → `recommendedPower` 区间，`pill` 去掉 `isBreakthrough`；活动 `act-seclusion`（闭关）→ `act-practice`（练功），资源 `res-cultivation`（修为）→ `res-experience`（实战经验）。**测试 24 全过、typecheck 通过、content:check 通过、build 通过**
- ✅ **docs/martial 与 docs/quests 已同步**：武功前置门槛 `realmIndexMin` → `martialLevelMin`，造诣门槛映射（三流→初窥门径 / 二流→登堂入室 / 绝顶→炉火纯青）；任务六卷分卷依据改为造诣档位（不堪一击 / 初窥门径 / 驾轻就熟 / 炉火纯青 / 出神入化 / 返璞归真）
- ✅ **ADR 历史标注已完成（2026-09-01）**：0001 作废、0004／0005／0010／0012／0013／0015 部分失效或待重估均已加眉注；0016 的「闭关修为／波次／挂机」改为「基础武功熟练度／驻守／自动应战」；0019 的待办清单标记执行完毕
- ✅ **包名已改（2026-09-01）**：`@idlerpg/*` → `@sexymud/*`（root `package.json` 亦改 `sexymud`），同步 `pnpm-lock.yaml` 与三处 import。`pnpm install` 通过（lockfile 无需重新解析）、软链接 `@sexymud` 已重建；24 测试 / content:check / typecheck / build 全过。全仓已无 `idlerpg` 残留
- ⏸ 待决：奇遇形态未定（`event/` 仅有最小骨架；形态未定的概念不进术语表）
