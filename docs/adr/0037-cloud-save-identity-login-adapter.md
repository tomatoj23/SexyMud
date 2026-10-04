# 云存档身份与登录：账密会话 + CloudBase 传输适配器 + 同步状态与冲突裁决

#29 交付的 `CloudSaveStore` 语义全就位但**刻意不带身份**——传输端口在构造时绑定一个已认证会话，而「会话从哪来」是本 ADR 的事。本票（#30）落云存档**真正可用**的最后四件：登录流程（选型＋UI＋会话管理）、CloudBase 传输适配器（`CloudSaveTransport` 的真后端实现，ADR-0036 D4 义务）、`@cloudbase/js-sdk` 依赖落地、宿主接线（同步状态指示＋冲突裁决 UX，不许静默降级）。八个定案（票面三定案点 D1–D3＋实现义务落地口径 D4–D8）先落工作稿 `.scratch/cloud-auth/DECISIONS-WIP.md`，跑绿后升级为本 ADR 与 spec/04 §1.7。

## Context

- **ADR-0036 D1**：跨设备续档要的是**跨设备的账号标识**，匿名设备 ID 不够；登录超出 `SaveStore`（ADR-0018 端清单不含 Auth），身份是**传输层的属性**。D4 把 CloudBase 适配器义务写死：`write` 原子 CAS（revision 不符 ⇒ 冲突拒绝、写不落）、revision 不透明、错误分类（未知后端错误归 `"network"`）。
- **ADR-0002 §2／§21**：CloudBase 承担云存档，「换平台只换 SDK 适配层」；存档是可导出 JSON 快照（退出路径不变）。**ADR-0017**：单机优先＋薄服务端，服务端第一优先是云存档。
- **SDK 实情**（2026-09-27 装 `@cloudbase/js-sdk@3.10.1` 读 `.d.ts` 与**运行时产物**）：v3 auth 有 `signInWithPassword({email|phone|username, password})`／`signUp`／`getLoginState()`／`signOut()`；云数据库 `collection().doc().get()`、`where(q).update()` 返回 `updated` 计数；事务存在（`ITransaction`＋运行时 `startTransaction`，`doc(id).create()` 是 insert-only）。⚠️ **四处运行时现实决定实现形态**（复查轮逐一对产物验证）：①auth 调用**返回** `{data, error}`（`AuthResult`）不抛异常——裸 await 会把「密码错误」读成成功；②`signUp` 是**邮箱/手机号验证码两步流**（校验器不要用户名），自助建号必经 `verifyOtp`；③**带 `code` 的网关错误 resolve 不 throw**——不验 `code` 就读数据，鉴权失败会以「无存档」流出去；④文档 id **原样拼进 REST 路径**（无转义），`/` 会静默 404 成「无存档」；事务内 `get` 返回 `data: doc|null`（非事务才是数组）。类型面另有缺口（`db.startTransaction` 不在 `database.App` 里），适配层留一处带注释的窄转换，真行为由 env-gated e2e 冒烟。
- CloudBase 登录方式多源（账密／手机号／微信／自定义／匿名／托管页），外部资质门槛各不相同：微信扫码要开放平台企业认证、手机号要短信签名与模板审核、自定义登录要自建账号体系＋签票服务端。

## Decision

八条定案（2026-09-27，实现会话定案，工作稿 `.scratch/cloud-auth/DECISIONS-WIP.md`）：

1. **D1 登录方式 = 账密（邮箱／用户名＋密码）**：`signInWithPassword` 两式皆认。**注册 = 邮箱验证码两步**（SDK 现实：`signUp` 的校验器只要邮箱/手机号，自助建号必经 `verifyOtp`；用户名直注不存在——用户名作登录名随注册捎带或控制台预置）。手机号／微信／自定义登录是**后续可加的身份源**——「身份随会话」（ADR-0036 D1）的设计天然支持换登录方式，传输端口只认已认证会话，本侧代码不动。
2. **D2 匿名登录不提供**：云存档显式要求登录；未登录 = 纯本地（`LocalSaveStore` 照旧）。匿名身份是设备级的（ADR-0036 D1 已否「匿名＝身份」），「匿名单机云备份」的承诺与「跨设备续档」混淆——换机即丢档恰是「以为存了、其实没同步」洞的变体。云存档按钮永远意味着「换机能续」。
3. **D3 登录与本地存档：不自动上传、不合并；同步是显式动作**（上传／下载／裁决）。登录后只**探测展示**两边档（存在／版本／进度 tick）；两边**逐字节相同 = 无分歧**，不需要动作。合并 = 发明 UX（快照是整体 JSON，无字段级合并语义）；自动上传违背显式策略（#29 D5）。
4. **D4 适配器 CAS 形态 = 混合两路**：**更新走条件更新**（`where({_id, revision: 期望值}).update({text, revision: 新值})`，看 `updated` 计数；`updated ≠ 1` ⇒ `conflict`、写不落）；**新建走事务**（`get` ⇒ 槽已存在即 `conflict`；不存在 ⇒ `create` insert-only ⇒ `commit`）——条件更新无法表达「仅当不存在才插入」，正是票面「做不到原子就上事务」的那半边。**revision = 每次写入新铸的不透明 token**（注入 minter；对上层永不解析、永不读回——读回有竞态，两写之间插队会让本会话认领别人的 revision，CAS 就破了）；**文档 `_id` = `${uid}~${key}`**（身份落存储层的账号级命名空间，快照本身仍不写账号标识；两段限 `[A-Za-z0-9._-]`、`~` 不入段 ⇒ 拼接无歧义**且 URL 安全**——SDK 把 doc id 原样拼进 REST 路径，`/` 会让读静默变「无存档」）；集合名可配（默认 `save_slots`）。
5. **D5 错误分类 = 最小信号表，不猜错误字符串**：UNAUTHENTICATED 信号（`errorCode === 16`（`AuthErrorCode.UNAUTHENTICATED`）／`code ∈ {"unauthenticated", "UNAUTHENTICATED", "login_required"}`（`ErrorType` 枚举词）／HTTP 401（`statusCode`/`status`，数字或字符串））⇒ `"auth"`；CAS 落空 ⇒ `"conflict"`（出自逻辑判断；**唯一例外**：新建路径的 `already_exists`——后端在命名 CAS 条件本身，也是「不许静默覆盖」的闸门：新建竞速输掉若被归 `network`，重试会把「当时云端为空」的承诺静默换成替换）；**其余（含未知后端错误）⇒ `"network"`**（契约既定：未知按可重试读）。⚠️ **带 `code` 的网关错误 resolve 不 throw**（SDK 现实）——每个结果先验 `code` 再读数据，否则一次鉴权失败会以「无存档」流出去（D8 禁的静默降级）。登录表单的失败分类同律（**枚举词不是猜测**）：`AuthErrorCategory`（`INVALID_CREDENTIALS`／`USER_NOT_FOUND`／`AUTH_METHOD_MISMATCH`）与 `ErrorType`（`invalid_password`／`invalid_credentials`／`invalid_grant`／`already_exists`）⇒ 表单提示分类，其余归 `"network"`。**#43 修订（信号表收一张）**：分类＋判定收进 `cloudbaseSignals.ts` 一个 module（apps/web cloudbase 边界），两 binding 只留「信号→失败 kind」薄映射，`already_exists` 判一次、「未知⇒network」一份注释归一（4 处拷贝措辞折叠、规则住表内）——词汇与判定边界对**单信号载体**不变（本条正文即表的内容）；**多信号矛盾载体**（一个错误同时带两类信号）由表的优先序裁决：`already-exists` ＞ `invalid-credentials` ＞ `unauthenticated`（具体信号压过笼统信号），save 侧旧「只判 unauthenticated ⇒ `auth`」在矛盾载体上翻 `network`——「收一张」的**唯一合并行为差**（#43 复查轮 A/B 实测记录）；敌意 JS 对象级载体（boxed／数组 code、throwing getter）归域外。
6. **D6 会话管理三态 `signed-out`／`signed-in`／`expired`——`expired` ≠ `signed-out`**：`CloudSaveError("auth")` ⇒ 标过期＋重登引导，**绝不自动重试**；过期后该同步器实例即死（后续动作拒绝、不再打后端），**重登 = 重建传输端口＋同步器**（换账号 = 换命名空间）。账密错误是**登录失败**（改输入），不是过期（状态不动）；**登出失败同样不翻状态**（后端会话还活着时说「已退出」是撒谎）。**过期归属会话本人**：旧会话的迟到失败绝不灭掉新会话（`markExpired` 比 **session 对象身份**——⚠️ **#42 勘误**：旧句「带 uid 比对」系误写，实现从来比的是会话对象；uid 名账号、同账号重登即新对象，比 uid 会把旧登录的迟到失败算到新会话头上）；启动探测不覆盖新状态（纪元护栏）。**#43 修订（探测失败裁定显性化）**：探测失败 ≠ 无会话——`getLoginState` 失败状态不动、**上抛**（真 binding「吞成 null」改上抛，登录后两处同款探测一并响亮，**不吞成「登录成功但未获得会话」**——该裁决只留给真跑过、确实无会话的探测）；「flaky boot 安静」归渲染层决策（App 启动处显式 catch），绑定层不销毁信息。⚠️ 实现期查证：SDK 门面自身把探测失败吞成 `null`（`@cloudbase/js-sdk@3.10.1` 实装，`Auth.getLoginState` 的 try/catch）——裁定钉在 binding 缝上（fake 与真 binding 双侧共用断言），门面层残余合流记 e2e 校准点。登录失败三分类供表单提示：`invalid-credentials`／`already-exists`／`network`。
7. **D7 冲突裁决 UX = 三选项＋明示代价**：「以本地为准（覆盖云端）」二次确认明示「另一台设备的进度将被丢弃」、「以云端为准（下载载入）」、「继续本地玩（暂不同步）」。**「另存」被否**——存档槽管理／正档切换是另一个功能（ADR-0036 被否路线 6 同律）；保命通道是**导出 JSON**（ADR-0002 §21 退出路径）。`save()` CAS 冲突与「登录后两边分歧」共用同一裁决面（`cause: save | compare`）。
8. **D8 上传语义 = load-then-save（观测后写）**：新建与刻意替换走同一通道；**#32 修订**——整段「观测＋修复写＋撞 conflict 再分辨」舞步收进 store 成 `replace(snapshot)` 一个操作（结果三分 `saved`／`conflict`／`unrepairable`），`upload()` 调一次即完、不再反推 store 武装次序（武装规则只住 store）；**云端档损坏时**修复即 `replace`（ADR-0036 修复／重置路径换乘）。⚠️ **判定规则换成行身份（#32 修订旧句「远端仍损坏 ⇒ 是损坏不是竞速」）**：写被拒**或锚损坏无从表达 CAS** 时**再观测 raw record**——**同一条行**（revision token／text 未变，即那条没有任何写能 CAS 的损坏行）⇒ `unrepairable`（上传以**损坏**收场、不冒充「另一台设备写了」的冲突）；其余一律**真竞速** ⇒ `conflict`（**含竞速方写入新的损坏行**——损坏在竞速后视图呈现；**含行消失**〔竞速方删槽〕——删除也是「有人写过」）。**锚损坏从不写**（#32 复查收口）：无锚的写只能盲建，恰在删槽竞速里覆盖掉「有人写过」的痕迹、判定还会随实例残留武装翻转。另 **#32 D4 加词**：存储拿不到 ⇒ `failed`／`"local-unavailable"`（读视图 `unavailable`），与「损坏」（`local-corrupt`）「配额」（`local`）三词分义——损坏⇒修/导出/导入，不可访问⇒查浏览器设置、重试无用，配额⇒删东西，动作指引相反不许混报。任何失败大声（状态明示没存上、远端原样未动），**绝不静默降级本地**。

## Considered Options

- **微信扫码登录**：被否——开放平台企业认证与网页应用申请是仓库外流程，开发期不可控；后续可加为身份源。
- **手机号＋短信登录**：被否——腾讯云短信签名与模板审核同上。
- **自定义登录（自建账号体系＋ticket）**：被否——等于在薄服务端之外造一个账号服务（ADR-0017 的服务端只有云存档／排行榜／聊天）。
- **CloudBase 托管登录页（`toDefaultLoginPage`）**：被否——品牌与跳转配置不可控，且「登录 UI」是票面交付物。
- **匿名模式（单机云备份）**：被否——承诺混淆（D2）：云按钮永远意味着「换机能续」。
- **匿名 → 账号链接升级**：被否——复杂度票面外；D2 不提供匿名则无此路径。
- **登录后自动上传本地档**：被否——静默写远端违背显式策略（#29 D5）；「云端空」的 CAS 新建通道会让玩家只是想看一眼的本地档直接落云端。
- **登录后自动合并（merge）**：被否——快照是整体 JSON，无字段级合并语义；发明合并 UX 超范围。
- **冲突自动分叉槽（另存／keep both）**：被否——同 ADR-0036 被否路线 6；保命走导出 JSON。
- **revision 用条件自增 `_.inc` ＋ 读回新值**：被否——读回有竞态（D4 已述）；改为写时新铸 token、永不读回。
- **新建走 `add` ＋ 重复键错误映射 `conflict`**：被否——重复键的错误码／文本不可核实，映射 = 猜测（违反 D5）；事务 `create` 的 insert-only 语义显式可测。
- **网络失败自动重试**：被否——「以为存了」的窗口自己开回来；重试是玩家动作，auth 失败更是绝不自动重试（AC3）。

## Consequences

- `apps/web` 新增：`game/cloudAuth.ts`（`CloudAuth` 三态会话机＋`CloudAuthClient` 端口）、`game/cloudbaseTransport.ts`（`CloudBaseSaveTransport`——CAS 混合两路＋错误分类＋uid 命名空间）、`game/cloudbaseSdk.ts`（SDK 绑定：两处带注释的窄转换＋登录失败分类）、`game/cloudSync.ts`（`CloudSync`——同步状态机＋冲突裁决三出口）、`cloudSetup.ts`（每会话重建传输与同步器）＋ `ui/AuthPanel.tsx`／`ui/CloudSavePanel.tsx`（登录面＋状态指示＋裁决对话）。`packages/core` **零改动**；`@cloudbase/js-sdk` 进 `apps/web` dependencies（`corepack pnpm` 管理，`core-js-pure` 构建脚本显式 `false`）。
- 测试：`cloud-auth.test.ts` 14 例 ＋ `cloudbase-transport.test.ts` 18 例 ＋ `cloud-sync.test.ts` 22 例（语义全由假会话／假后端钉住）＋ `cloudbase-e2e.test.ts`（**env-gated 真后端冒烟**，无 `CLOUDBASE_ENV_ID`／测试账号变量即 skip）。
- ⚠️ **真后端冒烟未跑**（需要用户的 CloudBase 环境）：错误分类信号表（UNAUTHENTICATED 16 等）与条件更新／事务真语义是**最可能被打脸的两处**——冒烟清单与校准点写在 e2e 测试头注释；部署面两件（集合 `save_slots` 与安全规则、账密登录开关）也在清单里。
- **面板是薄绑定（#45 D2 修订本条）**：**薄＝无业务判定**——破坏性判定＋代价要素、失败盖过旧裁决的状态、机器守卫判定都出自机器暴露视图（`destructive`／`statusView`／机器自身守卫与拒绝），面板只画＋手势上报；交互编排（按钮／二次确认／文件选择）留面板。原句「**UI 无渲染测试**（仓库无 jsdom）：逻辑全在可测状态机，React 面板是薄绑定」已随 #45 翻转——**面板渲染测试已落地**（jsdom＋React `act`，`apps/web/tests/panel-rig.ts`＋`cloud-save-panel.test.ts`），判定纪律同时收进机器（D1）。
- 落点：`docs/spec/04` §1.7（＋§1.6 指针刷新）、`docs/spec/01` 端口表 `SaveStore` 行、`docs/HANDBOOK.md` 当前事实与前沿、`apps/web/tests/*`。
