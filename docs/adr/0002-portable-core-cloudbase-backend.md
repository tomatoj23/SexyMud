# Web 优先、核心逻辑平台无关、后端用 CloudBase

> ⚠️ **部分失效（2026-09-01）**
> - 「小程序用 **Taro** 复用 React 心智」「桌面端（Steam）用 Tauri/**Electron**」已由 **ADR-0018** 否掉。改为：小程序**只重写 `TerminalView` 渲染层、不引入 Taro**；桌面走 **PWA → Tauri v2**。
> - 「MVP 先纯单机延后服务端：否」已被 **ADR-0017** 翻案采纳——现在是**单机优先 + 薄服务端**（服务端只做云存档／排行榜／聊天），由 `Authority` 端口隔离。**照本文去上 CloudBase 全量后端是错的。**
> - **仍然有效**：核心逻辑平台无关、引擎零平台 API、宿主提供 `Clock`/`Rng`/`SaveStore` 实现。

目标是后期移植到微信小程序和 Steam（桌面端），因此采用**可移植架构**：

1. **Monorepo + 纯核心**：游戏逻辑全部放在平台无关的 `core` 包（纯 TypeScript，禁止依赖 DOM/window），UI 只做壳。Web 用 React + TypeScript + Vite；小程序用 Taro 复用 React 心智；桌面端（Steam）用 Tauri/Electron 包 Web 壳。
2. **后端选腾讯云 CloudBase**（云函数 + 云数据库），承担云存档与排行榜。存档以 JSON 快照形式存取，服务端不耦合业务逻辑；客户端通过自建 `SaveStore` 接口访问，Web 用 CloudBase JS SDK，小程序用其 wx SDK，桌面端走云函数 HTTP——换平台只换 SDK 适配层。

## Considered Options

- 自建 Node + PostgreSQL：完全可控但需运维，否。
- MVP 先纯单机延后服务端：省事，但用户已确认要排行榜/云存档，且 CloudBase 开箱即用，否。

## Consequences

- `core` 包的纯净性是硬约束：任何 DOM/平台 API 调用都是违规，代码评审需守住这条边界。
- CloudBase 有厂商锁定，存档格式必须保持为可导出的 JSON 快照以保留退出路径。
