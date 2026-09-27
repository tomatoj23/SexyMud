# 云存档身份与登录：账密会话 + CloudBase 传输适配器 + 同步状态与冲突裁决

#29 交付的 `CloudSaveStore` 语义全就位但**刻意不带身份**——传输端口在构造时绑定一个已认证会话，而「会话从哪来」是本 ADR 的事。本票（#30）落云存档**真正可用**的最后四件：登录流程（选型＋UI＋会话管理）、CloudBase 传输适配器（`CloudSaveTransport` 的真后端实现，ADR-0036 D4 义务）、`@cloudbase/js-sdk` 依赖落地、宿主接线（同步状态指示＋冲突裁决 UX，不许静默降级）。八个定案（票面三定案点 D1–D3＋实现义务落地口径 D4–D8）先落工作稿 `.scratch/cloud-auth/DECISIONS-WIP.md`，跑绿后升级为本 ADR 与 spec/04 §1.7。

## Context

- **ADR-0036 D1**：跨设备续档要的是**跨设备的账号标识**，匿名设备 ID 不够；登录超出 `SaveStore`（ADR-0018 端清单不含 Auth），身份是**传输层的属性**。D4 把 CloudBase 适配器义务写死：`write` 原子 CAS（revision 不符 ⇒ 冲突拒绝、写不落）、revision 不透明、错误分类（未知后端错误归 `"network"`）。
- **ADR-0002 §2／§21**：CloudBase 承担云存档，「换平台只换 SDK 适配层」；存档是可导出 JSON 快照（退出路径不变）。**ADR-0017**：单机优先＋薄服务端，服务端第一优先是云存档。
- **SDK 实情**（2026-09-27 装 `@cloudbase/js-sdk@3.10.1` 读 `.d.ts` 与运行时面）：v3 auth 有 `signUp({username, password})`／`signInWithPassword({email|phone|username, password})`／`getLoginState()`／`signOut()`；云数据库 `collection().doc().get()`、`where(q).update()` 返回 `updated` 计数；事务存在（`ITransaction`＋运行时 `startTransaction`，`doc(id).create()` 是 insert-only）。⚠️ 官方**类型面落后于运行时**两处：v3 登录方法名不在 `ICloudbaseAuth` 里、`db.startTransaction` 不在 `database.App` 接口里（`ITransaction` 类型本身在）——适配层各留一处带注释的窄转换，真行为由 env-gated e2e 冒烟。
- CloudBase 登录方式多源（账密／手机号／微信／自定义／匿名／托管页），外部资质门槛各不相同：微信扫码要开放平台企业认证、手机号要短信签名与模板审核、自定义登录要自建账号体系＋签票服务端。

## Decision

八条定案（2026-09-27，实现会话定案，工作稿 `.scratch/cloud-auth/DECISIONS-WIP.md`）：

1. **D1 登录方式 = 用户名＋密码（账密）**：`signUp({username, password})` 注册、`signInWithPassword({username, password})` 登录，CloudBase 内置身份体系。手机号／微信／自定义登录是**后续可加的身份源**——「身份随会话」（ADR-0036 D1）的设计天然支持换登录方式，传输端口只认已认证会话，本侧代码不动。
2. **D2 匿名登录不提供**：云存档显式要求登录；未登录 = 纯本地（`LocalSaveStore` 照旧）。匿名身份是设备级的（ADR-0036 D1 已否「匿名＝身份」），「匿名单机云备份」的承诺与「跨设备续档」混淆——换机即丢档恰是「以为存了、其实没同步」洞的变体。云存档按钮永远意味着「换机能续」。
3. **D3 登录与本地存档：不自动上传、不合并；同步是显式动作**（上传／下载／裁决）。登录后只**探测展示**两边档（存在／版本／进度 tick）；两边**逐字节相同 = 无分歧**，不需要动作。合并 = 发明 UX（快照是整体 JSON，无字段级合并语义）；自动上传违背显式策略（#29 D5）。
4. **D4 适配器 CAS 形态 = 混合两路**：**更新走条件更新**（`where({_id, revision: 期望值}).update({text, revision: 新值})`，看 `updated` 计数；`updated ≠ 1` ⇒ `conflict`、写不落）；**新建走事务**（`get` ⇒ 槽已存在即 `conflict`；不存在 ⇒ `create` insert-only ⇒ `commit`）——条件更新无法表达「仅当不存在才插入」，正是票面「做不到原子就上事务」的那半边。**revision = 每次写入新铸的不透明 token**（注入 minter；对上层永不解析、永不读回——读回有竞态，两写之间插队会让本会话认领别人的 revision，CAS 就破了）；**文档 `_id` = `${uid}/${key}`**（身份落存储层的账号级命名空间，快照本身仍不写账号标识）；集合名可配（默认 `save_slots`）。
5. **D5 错误分类 = 最小信号表，不猜错误字符串**：UNAUTHENTICATED 信号（`errorCode === 16`（`AuthErrorCode.UNAUTHENTICATED`）／`code ∈ {"unauthenticated", "UNAUTHENTICATED", "login_required"}`（`ErrorType` 枚举词）／HTTP 401（`statusCode`/`status`，数字或字符串））⇒ `"auth"`；CAS 落空 ⇒ `"conflict"`（出自逻辑判断；**唯一例外**：新建路径的 `already_exists`——后端在命名 CAS 条件本身，也是「不许静默覆盖」的闸门：新建竞速输掉若被归 `network`，重试会把「当时云端为空」的承诺静默换成替换）；**其余（含未知后端错误）⇒ `"network"`**（契约既定：未知按可重试读）。登录表单的失败分类同律（**枚举词不是猜测**）：`AuthErrorCategory`（`INVALID_CREDENTIALS`／`USER_NOT_FOUND`／`AUTH_METHOD_MISMATCH`）与 `ErrorType`（`invalid_password`／`invalid_credentials`／`invalid_grant`／`already_exists`）⇒ 表单提示分类，其余归 `"network"`。
6. **D6 会话管理三态 `signed-out`／`signed-in`／`expired`——`expired` ≠ `signed-out`**：`CloudSaveError("auth")` ⇒ 标过期＋重登引导，**绝不自动重试**；过期后该同步器实例即死（后续动作拒绝、不再打后端），**重登 = 重建传输端口＋同步器**（换账号 = 换命名空间）。账密错误是**登录失败**（改输入），不是过期（状态不动）。登录失败三分类供表单提示：`invalid-credentials`／`already-exists`／`network`。
7. **D7 冲突裁决 UX = 三选项＋明示代价**：「以本地为准（覆盖云端）」二次确认明示「另一台设备的进度将被丢弃」、「以云端为准（下载载入）」、「继续本地玩（暂不同步）」。**「另存」被否**——存档槽管理／正档切换是另一个功能（ADR-0036 被否路线 6 同律）；保命通道是**导出 JSON**（ADR-0002 §21 退出路径）。`save()` CAS 冲突与「登录后两边分歧」共用同一裁决面（`cause: save | compare`）。
8. **D8 上传语义 = load-then-save（观测后写）**：新建与刻意替换走同一通道（ADR-0036「`load` → `save` 覆盖」的刻意替换路径）；**云端档损坏时** `load` 抛 `corrupt` 但 revision 已武装 ⇒ 上传照走 `save` = ADR-0036 刻意保留的修复／重置路径；任何失败大声（状态明示没存上、远端原样未动），**绝不静默降级本地**。

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
- **UI 无渲染测试**（仓库无 jsdom）：逻辑全在可测状态机，React 面板是薄绑定。
- 落点：`docs/spec/04` §1.7（＋§1.6 指针刷新）、`docs/spec/01` 端口表 `SaveStore` 行、`docs/HANDBOOK.md` 当前事实与前沿、`apps/web/tests/*`。
