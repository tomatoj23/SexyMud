# 云存档：`SaveStore` 的远端实现——身份随会话、写冲突 CAS、失败大声

`LocalSaveStore` 是 `SaveStore` 端口唯一的宿主实现，存档只落 localStorage——换设备即丢档。#29 落第一个远端实现（云存档），兑现 ADR-0017 §1 联网阶段第一优先「跨设备续档」。形状早已定死：云存档**只是 `SaveStore` 的另一个实现**（ADR-0017 §5），快照格式与迁移链不变、仍是可导出 JSON（ADR-0002 §11／§21），`packages/core` 零改动。但端口只有 `load`／`save`，没有身份、没有版本、没有失败分类——六个语义问题必须先有结论才能写实现（票面「先定后做，本票不预设结论」）。

## Context

- **ADR-0002** 选腾讯云 CloudBase 承担云存档与排行榜，存档以 JSON 快照存取、客户端自建 `SaveStore` 访问、「换平台只换 SDK 适配层」；**ADR-0017** 翻掉了「照 ADR-0002 去上 CloudBase **全量后端**」，定「单机优先 + 薄服务端」，服务端三件事按优先级是 ① 云存档 ② 排行榜 ③ 聊天，世界状态共享明确推迟。
- 跨设备续档 = 同一份进度在另一台设备上继续。它比「云备份」多要求一样东西：**跨设备的身份**。设备 ID 天生只在本机；登录又引入 Auth 依赖，超出 `SaveStore` 本身。
- `SaveStore` 端口今天没有版本号／冲突语义。last-write-wins 会让后上线的设备**静默覆盖**先上线的进度；扩端口（`save(s, expectedVersion)`）被 #29 的 AC「`packages/core` 零改动」明确排除。
- 云端快照是**跨版本可读**的：旧设备上传 v1、新设备读到 v2 走 `migrateSnapshot` 没有争议；反过来（新版本存档被旧版本客户端读到）在单机时代不可能发生，云端让它成为日常。
- 项目环境约定：依赖自包含于本仓（ADR-0007），新依赖只在**能被行使**时才引入。

## Decision

六条定案（2026-09-27，实现会话定案，工作稿 `.scratch/cloud-save/DECISIONS-WIP.md`）：

1. **D1 身份 = 跨设备的账号身份，但获取身份（登录）超出 `SaveStore`**。`CloudSaveStore` 只认**注入的传输端口**，端口在构造时绑定到一个已认证会话——身份是**传输层的属性**，不是存档的属性。匿名设备 ID 不够（只能单机云备份，不是跨设备续档）；登录流程另立 Auth 票（**#30**，本票建成后按约定挂依赖边）。快照里**不写**账号标识：快照是可导出 JSON，账号 id 进快照既泄露身份又让格式因云而变。
2. **D2 写冲突：不扩端口，乐观并发留在实现内**。远端记录带不透明 `revision`；`save()` 永远是对**本实例最后观测版本**的 CAS（`load()` 的返回即观测；从未 `load()` = 观测「空」⇒ 只允许**新建**，这是新游戏首存的通道，也是「新设备不许盲覆盖旧进度」的闸门）。冲突 ⇒ 拒绝抛 `CloudSaveError("conflict")`，**绝不 last-write-wins**；成功写入推进本实例的 revision，连续自动存档不受影响；冲突后观测保持陈旧，宿主 `load()` 重新观测才能再写。**同一实例的读写排队串行**（#29 复查收口）：重叠的自动存档曾因同抢一个观测版本而互相误报冲突——排队后按序 CAS 全部落地，`conflict` 只属于「另一会话写了」。随行实现细节：**revision 在读取成功即武装**（哪怕文本损坏）——否则损坏的云存档永远无法经 `save()` 修复／重置（「load 抛 corrupt 后 save 覆盖」是刻意保留的修复路径）。裁决权（继续本地玩／重拉／另存）交宿主，冲突自动分叉存档槽被否（发明合并 UX，超范围）。
3. **D3 跨版本：云端原样存取快照文本，`load()` 不迁移不改写**。迁移仍是引擎 `migrateSnapshot` **一条链**（`restoreWorld` 入口），`SAVE_VERSION` 语义不变。**降级大声失败**：云端版本 > `SAVE_VERSION` 时迁移链照旧抛「unsupported save version」，云端不特判、不做降级转换——v2 的世界标量（`nowTick`／`rngState`／`due`）在 v1 无处安放，静默丢弃比失败更糟（ADR-0003：不做半解释状态）。信封校验（记录形状＋JSON 对象＋`version` 数字＋有 `data`）是传输层损坏的分级：`CloudSaveError("corrupt")`，与引擎九类载荷损坏不混；记录的 `revision` 不是字符串 ⇒ 不武装（它锚不住 CAS），`text` 不是字符串 ⇒ 武装后仍报 corrupt（保住修复路径）。
4. **D4 云存档这一件事仍用 CloudBase**（ADR-0002 §2 的适配层路线在「只做云存档」范围内仍有效），但**适配器与 `@cloudbase/js-sdk` 不进 #29**：CloudBase 访问必须先有会话（D1），依赖自包含原则下「引而不被行使」不可接受。#29 交付的类以**传输端口 `CloudSaveTransport`** 为界，全部语义由假传输钉住；CloudBase 适配器的义务写进接口契约——`write` **原子 CAS**（revision 不符 ⇒ 冲突拒绝、写不落；条件更新看 `updated` 计数，做不到原子就上事务）、revision 不透明、错误分类（未知后端错误归 `"network"`）。退出路径不变：存档是可导出 JSON 文本。
5. **D5 失败语义：抛错，不静默降级**。`load()`：远端空 = `null`（缺席不是失败）；断网／鉴权失效 = 拒绝且**可分辨**（`"network"` 重试、`"auth"` 重新登录）；**绝不返回旧快照冒充成功**。`save()`：失败 = 拒绝且远端原样未动（CAS 天然无半写）；**不静默降级到本地**——「玩家以为存了、其实没同步」只能靠大声拒绝堵住；宿主的本地镜像／同步指示必须是显式策略。
6. **D6 G6 同趟补上**：宿主侧存档编码往返与云存档是同一条缝（JSON 文本进、JSON 出——localStorage 字符串、云存档文本同律），补两处往返测试（中文／surrogate pair／emoji／孤 surrogate），spec/07 的 G6 从「待定」转「已覆盖」。⚠️ 真 WebView 存储层弄坏 surrogate pair 的风险属**环境**，不属代码缝，测试进程内无法行使（如实记录）。

## Considered Options

- **匿名设备 ID 充当身份**：被否——「跨设备续档」直接不成立，设备 ID 只在本机。
- **`SaveStore` 实现自带登录**：被否——把 Auth 依赖拖进端口实现；ADR-0018 的端清单（`TerminalView` + `SaveStore` + `Clock`）不含 Auth。身份随会话走反而把登录换成可注入的传输端口。
- **扩端口 `save(s, expectedVersion)`**：被否——AC「`packages/core` 零改动」排除；还要动 `LocalAuthority` 与所有实现。冲突语义在实现内做 CAS，端口零感知。
- **last-write-wins**：被否——票面点名的洞：后上线的设备静默覆盖先上线的进度。
- **冲突自动分叉存档槽（keep both）**：被否——发明合并 UX（谁是正档、怎么切），超范围；大声冲突把裁决交还宿主／玩家即可。
- **云端负责迁移／降级尽力读**：被否——迁移链分叉两处（违反「同一条 `migrateSnapshot`」）；降级尽力读 = 半解释状态（ADR-0003 禁）。
- **换通用 HTTP 后端、弃 CloudBase**：被否——票面与标题点名 CloudBase；ADR-0002 选型在「只做云存档」范围内仍有效；换厂商无新信息，且传输端口已把厂商锁在适配层（ADR-0002 §21）。
- **#29 直接引 `@cloudbase/js-sdk` + 匿名登录**：被否——匿名身份是设备级的（与 D1 冲突）；无会话则适配器无法行使。
- **断网时 `load()` 返回旧快照／静默降级本地**：被否——读到的是谎言；「以为存了、其实没同步」正是要堵的洞。
- **`save()` 吞错 resolve**：被否——`Promise<void>` 的 resolve 从此不可信。

## Consequences

- `apps/web` 新增 `CloudSaveStore`（`cloudSaveStore.ts`）＋ `CloudSaveTransport` 端口＋`CloudSaveError`（`network`／`auth`／`conflict`／`corrupt` 四类），与 `LocalSaveStore` 同接口、宿主可换插；两者存档**同一份 JSON 文本**、互换可读。`packages/core` 零改动。
- **端到端「真云端」未验证**（D4 的代价，如实记录）：CloudBase 适配器、SDK 依赖与登录随 **#30（Auth）** 落地，届时才第一次打真实后端；#29 的语义由假传输钉住，适配器义务是 `CloudSaveTransport` 契约与本 ADR 的 D4。
- **冲突裁决 UX 是宿主的债**：`conflict` 抛出后玩家看到什么、怎么处理，随 #30 的宿主接线做。
- **同实例写入排队串行**（#29 复查收口）：重叠的自动存档不再互相误报冲突；**跨实例**（两台设备）仍是 CAS 裁决、必有一输大声出局。契约注释写明「写是 CAS」。
- 落点：`docs/spec/01` 端口表 `SaveStore` 行、`docs/spec/04` §1.6、`docs/spec/07`（G6 转已覆盖）、`apps/web/tests/cloud-save-store.test.ts`／`local-save-store.test.ts`。
