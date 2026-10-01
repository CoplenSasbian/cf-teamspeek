# cf-teamspeed — Cloudflare 私人游戏语音室

> 基于 Cloudflare Realtime SFU + Workers 的轻量私有语音室。
> 浏览器可直接打开，也可用 WebView 套壳成 App。

---

## 1. 项目定位

一个**私人用**的游戏语音室：给自己和朋友开黑时用，不需要注册账号体系，靠两把 key 区分身份。

设计目标：

| 目标 | 说明 |
|---|---|
| **零成本运行** | 全部跑在 Cloudflare 免费额度内 |
| **部署极简** | 单个 Worker 同时提供前端页面 + 后端 API，一条 `wrangler deploy` 上线 |
| **客户端极轻** | 浏览器打开即用；WebView 套壳 App 只需设一个 baseUrl |
| **防白嫖** | 访客 key 与管理员 key 分离，key 只存服务端环境变量 |
| **可观测** | 管理员后台能看到用量，避免超额扣费 |
| **可开源** | 敏感信息全部剥离，仓库里只有模板 |

---

## 2. 技术选型（已确认）

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Cloudflare Workers** | 免费 10 万请求/天；静态资源请求免费无限 |
| SSR 框架 | **React Router v8**（framework mode） | Cloudflare Vite 插件一等支持，SSR 在 10ms CPU 限制内可跑 |
| 构建 | **Vite + @cloudflare/vite-plugin** | Worker 与前端同进程开发，本地即生产运行时 |
| 样式 | **Tailwind CSS v4** | 官方 SFU 示例同款，无额外 JS 运行时 |
| 图标 | **lucide-react**（ISC 许可，可商用） | 树摇友好，纯 SVG |
| 头像 | **@dicebear/collection**（本地渲染 SVG） | 不依赖外部 API，避免商用授权问题 |
| 房间状态 | **Durable Objects（SQLite 后端）** | 强一致、单房间单实例、免费版支持 |
| 数据库 | **D1** | 存审计流水与用量聚合；免费版 5GB |
| 实时长连接 | **DO WebSocket Hibernation API** | 空闲自动驱逐，**不计时长费** |
| 媒体传输 | **Cloudflare Realtime SFU** | 免费 1000 GB/月出站 |
| 人机验证 | **Cloudflare Turnstile** | 完全免费，服务端 Siteverify 校验 |
| 语言 | **TypeScript** + **Zod** | 请求校验在 Worker 侧完成 |

---

## 3. 依赖库清单（完整）

### 核心发现：SFU 没有官方客户端 SDK

⚠️ **重要事实**：Cloudflare Realtime SFU **不提供官方客户端 JS SDK / npm 包**。
官方文档明确要求浏览器端**直接使用原生 WebRTC API**（`RTCPeerConnection`、`getUserMedia`），
服务端由自己的后端持 App Secret 调 HTTP API。

这意味着 `.js` 文件**不会通过 CDN 引入**，而是我们基于原生 API 自己封一层薄客户端
（约 300 行，封装在 `app/lib/sfu-session.ts` / `room-controller.ts`）。

唯一的官方 CDN 选项是 **RealtimeKit**（见第 5 节），但它是「会议产品」而非「SFU 裸接口」，
与本项目的房间系统设计冲突，**不采用**。

### 前端依赖

| 包 | 版本线 | 用途 | 许可 |
|---|---|---|---|
| `react` / `react-dom` | 19.x | UI | MIT |
| `react-router` | 8.x | SSR 框架（framework mode） | MIT |
| `@cloudflare/vite-plugin` | latest | Vite 与 Workers 运行时集成 | MIT |
| `vite` | 7.x | 构建 | MIT |
| `tailwindcss` + `@tailwindcss/vite` | 4.x | 样式 | MIT |
| `lucide-react` | latest | 图标 | ISC |
| `@dicebear/core` + `@dicebear/collection` | 10.x | 头像本地渲染 | 各风格单独（见 LICENSE.md） |
| `zod` | 4.x | 前后端共享校验 | MIT |
| `clsx` + `tailwind-merge` | latest | className 合并工具 | MIT |
| `nanoid` | 5.x | 客户端 ID 生成 | MIT |
| `recharts` | 3.x | **后台用量图表**（折线/柱状） | MIT |

### 后端依赖（Worker 内运行）

| 包 | 版本线 | 用途 | 许可 |
|---|---|---|---|
| `hono` | 4.x | API 路由框架（官方 SFU 示例同款） | MIT |
| `zod` | 4.x | 请求体校验 | MIT |
| `jose` | 6.x | JWT 签发与校验（Web Crypto 原生，Workers 友好） | MIT |
| `@cloudflare/workers-types` | latest | Workers 运行时类型 | MIT |

> **不用** `jsonwebtoken`（依赖 Node crypto，Workers 上跑不了）。**用** `jose`，它基于 Web Crypto。

### 开发依赖

| 包 | 用途 |
|---|---|
| `typescript` | 类型检查 |
| `vite` | 构建 |
| `@cloudflare/vite-plugin` | Vite 与 Workers 运行时集成 |
| `tailwindcss` + `@tailwindcss/vite` | 样式 |
| `wrangler` | 部署与本地运行时（已全局安装 4.142.0） |
| `@cloudflare/workers-types` | Workers 运行时类型 |
| `@types/react` / `@types/react-dom` | React 类型 |
| `tsx` | 运行 `scripts/gen-avatars.ts` |

> **刻意不引入**：`eslint` / `prettier`（见第 19.4 节）、
> `vitest` / `@cloudflare/vitest-pool-workers`（见第 19.5 节）。

### CDN 引入策略

**原则上不通过 CDN 引入运行时依赖**，原因：

1. Worker 侧的所有依赖由 `wrangler` 打包，无 CDN 概念；
2. 前端依赖由 Vite 打包并带 hash 指纹，随静态资源免费无限分发；
3. 引入外部 CDN 会破坏离线可用性、增加 CSP 复杂度、且开源后无法保证第三方可用。

**唯一例外**：Turnstile 的 widget 脚本**必须**从 Cloudflare CDN 引入（官方要求）：

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

### RealtimeKit 的 CDN 用法（仅记录，不采用）

作为备查，RealtimeKit 确实提供 CDN：

```html
<script src="https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@latest/dist/browser.js"></script>
<script type="module">
  import { defineCustomElements } from 'https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit-ui@latest/loader/index.es2017.js';
  defineCustomElements();
</script>
```

对应 npm 包：`@cloudflare/realtimekit`（核心）、`@cloudflare/realtimekit-react`（React hooks）、
`@cloudflare/realtimekit-react-ui`（现成 UI 组件）。

**不采用的原因**见第 5 节。

### 依赖数量控制

**13 个运行时依赖 + 9 个开发依赖**。刻意保持精简，因为：

- Worker 冷启动与包体积正相关，免费版 CPU 只有 10ms；
- 开源项目依赖越少，长期维护负担越小；
- 本项目核心复杂度在 WebRTC 信令，而非业务逻辑，不需要重型框架。


---

## 4. 架构

```
┌─────────────────────────────────────────────────────────┐
│  浏览器 / WebView 客户端                                  │
│  大厅页 → 语音页 → 开发者页（内嵌后台）                     │
└───────────────┬─────────────────────────┬───────────────┘
                │ HTTPS / WebSocket       │ WebRTC (SRTP)
                │ 信令 + 房间业务           │ 音频流
                ▼                          ▼
┌───────────────────────────┐   ┌──────────────────────────┐
│  单个 Worker               │   │  Cloudflare Realtime SFU  │
│  ├ 静态资源（免费无限）      │   │  rtc.live.cloudflare.com  │
│  ├ SSR 外壳（React Router） │──▶│  /sessions/new            │
│  ├ /api/* 路由 + 鉴权       │   │  /tracks/new              │
│  └ RoomDO binding          │   │  /renegotiate             │
└───────────┬───────────────┘   └──────────────────────────┘
            │                               ▲
            │ RPC                           │ 客户端直连
            ▼                               │
┌───────────────────────────┐                │
│  RoomDO（每房间一个实例）    │                │
│  成员表 / 昵称占用 / track   │                │
│  SDP 队列 / 心跳 / 回收      │                │
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│  D1（审计 + 用量聚合）       │
│  会话流水 / 日聚合 / 违规    │
└───────────────────────────┘
```

**关键点：Worker 永远不碰音频流。** 音频走客户端到 SFU 的直连，Worker 只负责信令交换和房间业务。这既降低了 CPU 开销，也大幅减少了流量费用。

### 四个 Durable Object 类

| 类名 | 实例粒度 | 职责 |
|---|---|---|
| `RoomDO` | 每房间一个 | 成员进出、昵称占用、track 发现、心跳、资源回收、WebSocket 广播 |
| `RegistryDO` | 全局单例 | 全局昵称注册表（保证唯一）、会话流水缓冲、用量计数聚合 |
| `AdminDO` | 全局单例 | 封禁名单缓存、后台实时统计缓存、审计缓冲 |
| `PresenceDO` | 全局单例 | 服务器在线名册（谁连上了这台服务器、在哪个房间）、邀请信箱 |

> 用单例 DO 做缓冲是关键设计：把大量小写入在内存里累加，按时间窗口一次性 flush 到 D1，避免击穿 D1 每天 10 万行的写入额度。

> `PresenceDO` 承担「网关」角色：本应用没有独立的服务器实体，**一个部署就是一台服务器**。
> 客户端在外壳层以 15s 心跳登记在线、以 6s 轮询拉取成员列表与邀请；
> 用轮询而非常驻 WebSocket，是为了不给每个用户维持一条长连接（房间内的实时同步仍走 `RoomDO` 的 WebSocket）。

---

## 5. 为什么不用 RealtimeKit？

Cloudflare 提供两套 Realtime 方案，必须明确区分：

| | **Realtime SFU**（本项目采用） | **RealtimeKit**（不采用） |
|---|---|---|
| 定位 | 裸 WebRTC 基础设施 | 完整会议产品 |
| 客户端 | ❌ 无官方 SDK，用原生 WebRTC API | ✅ 官方 SDK + 现成 UI 组件 |
| 房间概念 | 由**我们自己**用 DO 实现 | Cloudflare 托管的 Meeting 对象 |
| 参与者 | 我们自己的昵称/头像/权限体系 | Cloudflare 的 Participant + Preset |
| 权限模型 | 我们的 guest/admin key | Cloudflare 的 Preset 配置 |
| 服务端 API | `rtc.live.cloudflare.com/v1` | `api.cloudflare.com/.../realtime/kit/...` |
| 需要额外 Token | 否（用 App Secret） | 是（需 Cloudflare 账户级 API Token + Realtime 权限） |
| 计费 | 1000 GB/月免费 | 同一套 SFU 计费 |

**不采用 RealtimeKit 的决定性原因：**

1. **房间归属权冲突** —— RealtimeKit 要求房间是它托管的 `Meeting` 对象，参与者通过
   `POST /accounts/{id}/realtime/kit/{appId}/meetings/{meetingId}/participants` 由 Cloudflare 签发
   `authToken`。而本项目要求房间和参与者由我们自己的 `RoomDO` 管理（昵称全局唯一、头像、
   心跳回收、管理员踢人）。两套房间模型无法共存，强行桥接会变成两套状态的同步地狱。

2. **破坏「单个 Worker 自包含」** —— RealtimeKit 需要在 Cloudflare 账户级 API Token
   （Realtime/Realtime Admin 权限）才能调管理 API。我们的 SFU App Secret 是**应用级**的，
   权限面小得多。为了开源和降低泄露风险，只用应用级 Secret 更安全。

3. **免费版风险** —— 每个参与者进房都要调一次 Cloudflare 账户 API 签发 token，
   增加了一次外部往返和一层失败点，对 10ms CPU 预算是负担。

4. **我们要自己做 UI** —— RealtimeKit 最大的价值是现成的 `RtkMeeting` UI 组件，
   但本项目需要自定义布局（游戏语音室式的小尺寸成员条、音量指示、无视频），
   用它的 UI 反而要大量覆盖样式。

**结论**：SFU 裸接口 + 自建 DO 房间系统，虽然要多写约 300 行 WebRTC 客户端封装，
但换来完整的控制权和更小的攻击面。这也是 Cloudflare 官方 SFU 示例
（`realtime-examples/video-room`）采用的路线。

---

## 6. 身份与权限模型

### 6.1 两把 key

| Key | 用途 | 能力 |
|---|---|---|
| `GUEST_KEY` | 发给朋友 | 登录、进/退房间、开关自己的麦克风 |
| `ADMIN_KEY` | 只有自己有 | 访客全部能力 + 后台 + 管理操作 |

两把 key 都以 **Worker Secret** 形式存储（`wrangler secret put`），永不进入 git、永不发给客户端。

### 6.2 登录流程

```
客户端                     Worker                      RegistryDO / RoomDO
  │                          │                              │
  ├─ POST /api/auth/login ──▶│                              │
  │   { key, nickname,       ├─ 1. 比对 GUEST_KEY/ADMIN_KEY │
  │     avatar }             │     （timing-safe compare）   │
  │                          ├─ 2. 若 ADMIN_KEY → 标记 admin │
  │                          ├─ 3. 校验昵称格式 ────────────▶│
  │                          │                              ├ 检查全局唯一
  │                          │◀── 通过 / 已占用 ─────────────┤ 注册昵称
  │                          │                              │
  │                          ├─ 4. 签发会话 JWT              │
  │                          │     (HS256, SESSION_SECRET)   │
  │◀── 200 { token, role, ───┤     payload: {uid, name,      │
  │         profile }        │              role, exp}      │
  │                          │                              │
```

会话 token 用 **HttpOnly Cookie** 下发（WebView 场景可选返回 Bearer token）。

### 6.3 昵称全局唯一

- 昵称注册表存在 `RegistryDO`，主键为昵称的规范化形式（trim + 全角转半角 + 大小写折叠）。
- 已被占用的昵称**直接拒绝**，返回明确错误让用户换名字。
- 昵称与头像**绑定**：`avatarSeed = normalize(nickname)`，因此同一个昵称在任何设备、任何时间登录，看到的都是同一个头像。
- 保留昵称黑名单：`admin` `system` `官方` 等，防止冒充。
- 会话结束后昵称**保留占用**（私人场景，不设超时释放），管理员可在后台手动释放。

### 6.4 头像方案

三层优先级：

1. **上传图片** — 客户端 canvas 压缩到 256×256、WebP 质量 0.8（约 15KB），存为 DO 存储（SQLite BLOB），不走 R2 省配额。
2. **12 个预设头像** — 由 DiceBear 在本地构建期生成 SVG，随包发布。风格统一、无外部请求。
3. **默认头像** — 未选择时用昵称作 seed 自动生成，保证每人都有独特头像。

预设头像风格列表（初始 12 个）：

| # | 标识 | 视觉描述 |
|---|---|---|
| 1 | `bottts-01` | 机器人，圆头天线 |
| 2 | `bottts-02` | 机器人，方头屏幕脸 |
| 3 | `pixel-art-01` | 像素风头盔战士 |
| 4 | `pixel-art-02` | 像素风法师 |
| 5 | `adventurer-01` | 冒险者，护目镜 |
| 6 | `adventurer-02` | 冒险者，兜帽 |
| 7 | `lorelei-01` | 简约线条人像 |
| 8 | `lorelei-02` | 简约线条人像（长发） |
| 9 | `fun-emoji-01` | 表情包风格 |
| 10 | `fun-emoji-02` | 表情包风格（墨镜） |
| 11 | `shapes-01` | 几何图形组合 |
| 12 | `identicon-01` | 对称图标（Gravatar 风） |

---

## 7. 模块划分

### 7.1 服务端（`workers/`）

| 模块 | 文件 | 职责 |
|---|---|---|
| Worker 入口 | `workers/app.ts` | 路由分发、导出 DO 类、注入 SSR handler |
| 鉴权中间件 | `server/middleware/auth.ts` | 解析 Cookie/Bearer、验证 JWT、注入 `ctx.user` |
| 限流 | `server/middleware/ratelimit.ts` | 基于 DO 的滑动窗口，防暴力猜 key |
| 登录路由 | `server/routes/auth.ts` | 登录、登出、会话刷新、昵称校验 |
| 房间路由 | `server/routes/rooms.ts` | 房间列表、创建、销毁、房间内操作 |
| RTC 路由 | `server/routes/rtc.ts` | 包装 SFU API（`sessions/new`、`tracks/new`、`renegotiate`、`tracks/close`） |
| 后台路由 | `server/routes/admin.ts` | 概览、用量、审计、管理操作 |
| 在线状态路由 | `server/routes/presence.ts` | 服务器成员心跳 / 轮询、邀请入频道、管理员踢出服务器 |
| SFU 客户端 | `server/lib/sfu.ts` | 调用 `rtc.live.cloudflare.com/v1` 的封装，统一错误处理 |
| 用量聚合 | `server/lib/usage.ts` | 内存累加 + 定时 flush 到 D1 |
| RoomDO | `server/durable/RoomDO.ts` | 房间状态与生命周期 |
| RegistryDO | `server/durable/RegistryDO.ts` | 昵称注册表、写入缓冲 |
| AdminDO | `server/durable/AdminDO.ts` | 封禁名单、统计缓存 |
| PresenceDO | `server/durable/PresenceDO.ts` | 在线名册、邀请信箱 |

### 7.2 客户端（`app/`）

| 模块 | 路径 | 职责 |
|---|---|---|
| 路由定义 | `app/routes.ts` | React Router 路由表 |
| 根布局 | `app/root.tsx` | HTML 骨架、Tailwind 注入、错误边界 |
| 登录页 | `app/routes/login.tsx` | baseUrl/key/昵称/头像 输入，本地持久化 |
| 应用外壳 | `app/routes/app-shell.tsx` | **三栏布局**：房间列表 / 房间内容 / 服务器成员；持有会话、房间列表、在线状态 |
| 房间总览 | `app/routes/welcome.tsx` | 未选房间时的中间栏（房间卡片） |
| 房间页 | `app/routes/room.tsx` | 中间栏：成员网格、麦克风控制、连接状态 |
| 开发者页 | `app/routes/dev.tsx` | 管理员后台（概览/用量/审计/管理 四个 Tab） |
| 房间控制器 | `app/lib/room-controller.ts` | **核心**：管理 PeerConnection 生命周期、SDP 队列、重连 |
| SFU 会话 | `app/lib/sfu-session.ts` | 发布/订阅 PeerConnection 的封装 |
| 在线状态 | `app/lib/use-presence.ts` | 服务器心跳 + 成员轮询 + 邀请收取 |
| 头像组件 | `app/components/Avatar.tsx` | 渲染预设/上传/默认头像 |
| 音频指示 | `app/components/VolumeMeter.tsx` | Web Audio API 实时音量条 |
| 房间侧栏 | `app/components/Sidebar.tsx` | 房间列表 + 房间内成员 + 自己的账号卡片 |
| 成员侧栏 | `app/components/MemberRail.tsx` | 在线/离线成员、邀请入频道、踢出服务器 |
| 设置存储 | `app/lib/settings.ts` | baseUrl/key/昵称 的 localStorage 持久化 |

### 7.3 共享（`shared/`）

`shared/schema.ts` — Zod schema，服务端与客户端共用，保证请求体类型一致。

---

## 8. 核心业务流程

### 8.1 发布音频（Publish）

```
浏览器                          Worker                    SFU
  │                               │                        │
  ├ getUserMedia(audio)           │                        │
  ├ pc.addTransceiver(sendonly)   │                        │
  ├ createOffer → setLocalDesc    │                        │
  ├ 等待 ICE 候选收集完成 ─────────┤                        │
  │                               │                        │
  ├ POST /api/rtc/publish ───────▶│                        │
  │   { sdp, mid, trackName }     ├ POST /sessions/new ───▶│
  │                               │◀── sessionId ──────────┤
  │                               ├ POST /sessions/{id}/   │
  │                               │      tracks/new ──────▶│
  │                               │   { sessionDescription:│
  │                               │     offer, tracks:[…] }│
  │                               │◀── answer + trackName ─┤
  │◀── { sessionId, answer } ─────┤                        │
  ├ setRemoteDescription(answer)  │                        │
  ├ 等待 connectionState=connected│                        │
  └ 通知 RoomDO 更新 track 发现表   │                        │
```

### 8.2 订阅他人（Subscribe / Pull）

```
浏览器                          Worker                    SFU
  │                               │                        │
  ├ POST /api/rtc/subscribe ─────▶│                        │
  │   { publisherSessionId,       ├ POST /sessions/new ───▶│
  │     trackName }               │◀── subSessionId ───────┤
  │                               ├ POST /sessions/{sub}/  │
  │                               │      tracks/new ──────▶│
  │                               │   { tracks:[{location: │
  │                               │     "remote", …}] }    │
  │                               │◀── SFU offer ──────────┤
  │◀── { subSessionId, offer } ───┤                        │
  ├ setRemoteDescription(offer)   │                        │
  ├ createAnswer → setLocalDesc   │                        │
  ├ POST /api/rtc/renegotiate ───▶│                        │
  │   { sdp: answer }             ├ PUT /sessions/{sub}/   │
  │                               │     renegotiate ──────▶│
  │◀── 200 ok ────────────────────┤◀── 200 ok ─────────────┤
  └ audio 元素播放 event.track     │                        │
```

> **关键约束**：同一个 session 上的变更必须**串行化**——一次请求及其 SDP 交换完成前，不能发起下一次变更。客户端用一个每 session 的 Promise 队列保证顺序。

### 8.3 心跳与离线判定

- 客户端每 **15 秒**通过 WebSocket 发一次心跳。
- `RoomDO` 记录每个成员的 `lastSeen`。
- 超过 **45 秒**无心跳 → 标记为离线候选。
- 离线后触发清理：关闭 SFU tracks、释放 session、从成员表移除、广播 `room-changed`。
- 清理失败会重试，最多 3 次。
- 使用 **Hibernation API** 的 `serializeAttachment()` 在连接上持久化成员状态，保证 DO 被驱逐后重建时不丢状态。

### 8.4 状态同步

- WebSocket 只发**变更信号**（`room-changed` + 版本号），不发全量数据。
- 客户端收到信号后通过 HTTP `GET /api/rooms/{id}/snapshot` 拉取权威快照。
- 另有 **15 秒兜底轮询**，防止 WebSocket 静默断开导致状态不一致。

### 8.5 库职责映射

每个模块用哪个库、解决什么问题，逐项对齐：

| 模块 | 用到的库 | 解决什么 |
|---|---|---|
| `workers/app.ts` | `hono` | 路由分发、中间件编排，比手写 `switch(url.pathname)` 清晰 |
| `workers/middleware/auth.ts` | `hono/jwt` + `jose` | 解析 Cookie、校验 JWT、注入 `ctx.user` |
| `workers/middleware/ratelimit.ts` | `hono` 中间件 + DO | 滑动窗口限流，无需 Redis |
| `workers/routes/*.ts` | `hono` + `zod` | `zValidator` 中间件自动校验请求体 |
| `workers/lib/sfu.ts` | 原生 `fetch` | SFU 无 SDK，直接封装 `rtc.live.cloudflare.com/v1` |
| `workers/lib/jwt.ts` | `jose` | Web Crypto 原生 JWT，Workers 上零兼容问题 |
| `app/lib/sfu-session.ts` | **原生 WebRTC** | `RTCPeerConnection` / `getUserMedia` / `addTransceiver` |
| `app/lib/room-controller.ts` | `nanoid` + 原生 | 连接生命周期、SID 队列、重连 |
| `app/lib/audio.ts` | **Web Audio API** | `AudioContext` + `AnalyserNode` 算实时音量 |
| `app/components/*` | `lucide-react` | 所有图标 |
| `app/components/Avatar.tsx` | `@dicebear/core` | 生成预设头像 SVG |
| `app/routes/dev.tsx` | `zod` + `recharts` | 用量图表、审计表格 |
| 全项目 | `clsx` + `tailwind-merge` | 条件 className 拼接 |
| 全项目 | `zod` | 前后端共享 schema，`shared/schema.ts` |

> 注意 `app/routes/dev.tsx` 用 `recharts` 而不是图表手写 SVG——后台要画
> 7/30 天折线图和额度进度条，手写坐标轴和 tooltip 是浪费。

---

## 9. 管理员后台

访问路径：`/dev`（或环境变量配置的自定义路径）。

### 9.1 登录

- 输入 `ADMIN_KEY`。
- **Turnstile 强制校验**：前端渲染 Turnstile widget 拿到 token，后端调
  `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` 校验。
- 校验失败则拒绝，错误尝试计数 +1。
- 连续失败 **5 次** → 该 IP 锁定 15 分钟（存 `AdminDO`）。

### 9.2 四个 Tab

#### Tab 1 · 实时概览

| 指标 | 数据来源 |
|---|---|
| 当前房间数 / 总在线人数 | `RegistryDO` 汇总（各 RoomDO 上报） |
| 每房间成员列表 | `RoomDO` 快照 |
| 活跃 SFU session 数 | `RegistryDO` 计数 |
| 实时出站流量估算 | 位率 × 时长 累加 |
| Worker 请求速率 | 本地计数器 |

刷新方式：SSE 或 5 秒轮询。

#### Tab 2 · 用量看板

对比免费额度的进度条：

| 指标 | 免费额度 | 说明 |
|---|---|---|
| SFU 出站流量 | 1000 GB/月 | **最重要**，直接对应扣费 |
| Workers 请求 | 10 万/天 | |
| DO 请求 | 10 万/天 | |
| DO 时长 | 13,000 GB-s/天 | Hibernation 下应远低于此 |
| D1 行读 / 行写 | 500 万 / 10 万 每天 | 写入是最紧的瓶颈 |

数据来源：`RegistryDO` 的本地聚合计数（精确、无延迟） + 可选的 Cloudflare GraphQL Analytics API 交叉校验（需额外 API Token）。

图表：最近 7/30 天折线图 + 当月累计柱状图。

#### Tab 3 · 会话审计

| 字段 | 说明 |
|---|---|
| 时间 | |
| 昵称 + 头像 | |
| 事件类型 | 登录成功 / 登录失败 / 进房 / 退房 / 被踢 / 超时离线 |
| 房间 | |
| IP | 存哈希值 + 前两段（隐私考虑） |
| 地域 | 从 `request.cf.country` / `city` 取（免费且无需额外服务） |
| User-Agent | 截断存储 |
| 会话时长 | |

支持：按时间/昵称/事件类型筛选、分页、导出 CSV。

#### Tab 4 · 管理操作

| 操作 | 说明 |
|---|---|
| 踢出成员 | 从房间移除 + 关闭其 SFU 资源 |
| 强制关闭房间 | 清理全体成员 |
| 封禁 IP / 昵称 | 写入封禁名单（`AdminDO`），登录与进房时校验 |
| 解除封禁 | |
| 释放昵称 | 从全局注册表移除 |
| 查看房间详情 | 成员、track 列表、连接状态 |
| 调整房间人数上限 | 写入 D1 配置表 |
| 清理僵尸房间 | 手动触发回收 |

---

## 10. 客户端形态

### 10.1 三栏布局（KOOK 式）

桌面端为固定三栏，窄屏下两侧栏收起为抽屉、中间栏占满：

```
┌──────────────┬───────────────────────────┬───────────────┐
│ 房间列表       │ 房间内容                   │ 服务器成员      │
│ 248px         │ flex-1                    │ 240px         │
│               │                           │               │
│ 服务器名        │ 房间标题 + 人数/时长/连接状态  │ 在线 — n       │
│ 房间 A  2/10  │                           │  [头像] 昵称    │
│   ├ [头像] 甲  │  ┌─────────────────────┐  │  [头像] 昵称    │
│   └ [头像] 乙  │  │  成员网格（大头像）    │  │ 离线 — n       │
│ 房间 B  0/10  │  └─────────────────────┘  │  [头像] 昵称    │
│ + 新建房间     │  [ 静音 · 状态 · 离开 ]     │               │
│ [自己账号卡片]  │                           │               │
└──────────────┴───────────────────────────┴───────────────┘
```

各栏对应关系与设计取舍：

| 栏位 | 对应 KOOK | 本项目实现 |
|---|---|---|
| 服务器竖排图标 | 第一列 | **省略** —— Web 端一个部署就是一台服务器，没有多服务器概念 |
| 频道列表 | 第二列 | 房间列表；进入房间后，房间下方直接铺开房里的人（与 KOOK 语音频道下挂成员一致） |
| 频道内容 | 第三列 | 房间内容（语音房间：成员网格 + 底部控制条） |
| 服务器成员 | 第四列 | 连上这台服务器的人：在线 / 离线分组，可邀请入频道；管理员可踢出服务器 |

交互要点：

- **在线**＝保持 presence 心跳的人（不论是否在房间）；**离线**＝已注册但当前没连接的人（离线名册只对管理员返回）。
- **邀请入频道**：把自己所在房间的房间号投递到对方信箱，对方右下角弹出邀请卡片，接受即进入。
- **踢出服务器**：管理员操作，立即断开对方连接并封禁其昵称（可在后台封禁名单解除）。
- 未进入任何房间时，中间栏展示房间总览卡片（`welcome.tsx`）。

### 10.2 浏览器直开

- 访问 Worker 域名 → 若曾登录过（Cookie 有效）直接进大厅；否则显示登录页。
- baseUrl 默认为 `window.location.origin`，用户无需填写。

### 10.3 WebView 套壳 App

套壳极简，只需：

```html
<!-- WebView 加载的本地壳页 -->
<iframe src="https://your-worker.workers.dev" />
```

或原生 WebView 直接加载 URL。客户端会自动识别 `window.location.origin` 作为 baseUrl。

若套壳 App 需要固定指向某个 Worker，可在壳页注入：

```js
window.__CF_VOICE_BASE_URL__ = 'https://your-worker.workers.dev';
```

客户端启动时优先读这个变量。

> **WebView 兼容性注意**：Android WebView 需 `setMediaPlaybackRequiresUserGesture(false)` 才能自动播放远端音频；iOS `WKWebView` 需在 Info.plist 声明麦克风权限并处理 `WKUIDelegate` 的权限请求。

### 10.4 本地配置持久化

| 键 | 存储位置 | 说明 |
|---|---|---|
| `baseUrl` | localStorage | 服务器地址 |
| `key` | localStorage | 访客或管理员 key（明文，私人场景可接受） |
| `nickname` | localStorage | 昵称 |
| `avatarId` | localStorage | 头像选择 |
| 会话 token | HttpOnly Cookie | 服务端签发 |

---

## 11. 安全设计

| 威胁 | 对策 |
|---|---|
| key 泄露到前端 | key 只存 Worker Secret；登录用 key 换短期 JWT，之后不再传 key |
| 时序攻击猜 key | 用 `crypto.subtle.timingSafeEqual` 等长比较 |
| 暴力猜 key | 登录接口限流，5 次失败锁 15 分钟 |
| 白嫖 SFU 流量 | 所有 SFU 调用必须携带有效 JWT；无 JWT 直接拒绝 |
| 越权操作别人 track | `RoomDO` 校验操作者是否拥有该 track 的所有权 |
| 管理员后台被扫 | Turnstile + 可配置隐藏路径 + IP 锁 |
| 音频窃听 | 传输层 DTLS-SRTP 加密 + **端到端加密（见 11.3）** |
| 敏感信息进 git | `.gitignore` 排除 `.dev.vars`、`.env*`、`config.yml`；CI 里加密钥扫描 |

### 11.1 会话 JWT

- 算法 HS256，密钥 `SESSION_SECRET`（Worker Secret）。
- Payload：`{ uid, nickname, role: 'guest'|'admin', iat, exp }`。
- 有效期 12 小时，滑动续期。
- `uid` 为随机 UUID，与昵称解耦，便于改名/封禁。

### 11.2 请求校验

所有写操作请求体经 Zod schema 校验，失败返回 400 并记录审计。

### 11.3 端到端加密（E2EE）— 已确认开启，⚠️ 但**当前未落地**

> **实现状态（诚实说明）**：下面描述的是目标设计。
> 当前代码只做到「服务端下发 `keyId`」这一步：
> 房间密钥**材料**还没有分发协议，Web 客户端拿到 `keyId` 后直接丢弃
> （`app/lib/room-controller.ts` 的 `void keyId`）。
> 因此现在实际加密强度 = **DTLS-SRTP**，SFU 能看到明文音频。
>
> 真正开启前必须先定密钥分发协议（服务端只做分发、不持有明文音频），
> 并同步更新 `docs/API.md` 与 `client/` SDK —— 否则每个客户端会各写一套。
> 相关说明见第 22.5 节与 README「已知未完成」。

**方案**：基于 WebRTC 原生 Insertable Streams（`RTCRtpScriptTransform`）。

```
发布端                                        订阅端
  │                                             │
  ├ getUserMedia                                │
  ├ AudioContext + MediaStreamTrackProcessor    │
  ├ AES-GCM 加密每一帧 ─────────┐                │
  │                             │               │
  │                   SFU 只看到密文              │
  │                             │               │
  │                             └──────────────▶│
  │                                             ├ MediaStreamTrackGenerator
  │                                             ├ AES-GCM 解密
  │                                             └ 输出到 audio 元素
```

**密钥协商**：

- 房间创建时生成一个 256-bit 房间密钥（`crypto.getRandomValues`）。
- 密钥通过 **Worker 的加密通道**分发给已通过 JWT 鉴权的成员（Worker 只做分发，
  不持有解密后的音频）。
- 每个成员用 `crypto.subtle.deriveKey`（PBKDF2）从房间密钥派生出自己的 AES-GCM key。

**实现要点**：

| 项 | 说明 |
|---|---|
| 加密算法 | AES-GCM 256 |
| 每帧 IV | 12 字节随机数，随帧一起传输 |
| 变换位置 | `RTCRtpScriptTransform`（Web Worker 中执行，不阻塞主线程） |
| 浏览器支持 | Chrome/Edge 111+、Safari 17+、Firefox 117+（`RTCRtpScriptTransform`） |
| 降级策略 | 检测 `RTCRtpScriptTransform` 不存在时，**提示用户并降级到纯 DTLS-SRTP**（不阻塞通话） |
| SFU 影响 | 无。SFU 只转发加密后的 Opus 帧，不解码 |

**代价**（本项目可接受）：

- ❌ 无法做服务端混音 —— 本项目不需要
- ❌ 无法做服务端录制 —— 本项目不需要
- ❌ 无法做服务端语音活动检测 —— 音量指示在客户端本地算
- ⚠️ 新成员加入需要重新分发房间密钥（用 `RoomDO` 广播 `key-rotated` 事件）

**密钥轮换**：成员退房时**不**自动轮换（私人场景，退房者本就不该偷听）。
若管理员在后台点击「轮换密钥」，`RoomDO` 生成新密钥并广播，所有成员重新协商。

---

## 12. 项目结构

```
cf-teamspeed/
├── app/                          # 客户端（React Router）
│   ├── routes/
│   │   ├── lobby.tsx             # 大厅/登录
│   │   ├── room.$id.tsx          # 语音房间
│   │   └── dev.tsx               # 管理员后台
│   ├── components/
│   │   ├── Avatar.tsx
│   │   ├── VolumeMeter.tsx
│   │   ├── MemberList.tsx
│   │   └── admin/
│   │       ├── OverviewTab.tsx
│   │       ├── UsageTab.tsx
│   │       ├── AuditTab.tsx
│   │       └── ManageTab.tsx
│   ├── lib/
│   │   ├── room-controller.ts    # 核心：连接生命周期
│   │   ├── sfu-session.ts        # SFU 会话封装
│   │   ├── api.ts                # 后端 API 客户端
│   │   ├── settings.ts           # 本地配置
│   │   └── audio.ts              # 采集与音量
│   ├── root.tsx
│   ├── routes.ts
│   └── styles.css
├── workers/                      # 服务端
│   ├── app.ts                    # Worker 入口
│   ├── middleware/
│   │   ├── auth.ts
│   │   └── ratelimit.ts
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── rooms.ts
│   │   ├── rtc.ts
│   │   └── admin.ts
│   ├── durable/
│   │   ├── RoomDO.ts
│   │   ├── RegistryDO.ts
│   │   └── AdminDO.ts
│   └── lib/
│       ├── sfu.ts                # SFU API 封装
│       ├── usage.ts              # 用量聚合
│       ├── jwt.ts
│       ├── turnstile.ts
│       └── db.ts                 # D1 访问
├── shared/
│   └── schema.ts                 # 共享 Zod schema
├── assets/
│   └── avatars/                  # 12 个预设头像 SVG
├── migrations/                   # D1 迁移
│   └── 0001_init.sql
├── scripts/
│   └── gen-avatars.ts            # 生成预设头像
├── .dev.vars.example             # 本地密钥模板（进 git）
├── .gitignore
├── config.example.yml            # 配置模板（进 git）
├── react-router.config.ts
├── vite.config.ts
├── wrangler.jsonc
├── tsconfig.json
├── package.json
├── README.md
└── DESIGN.md                     # 本文件
```

### package.json 预览

```jsonc
{
  "name": "cf-teamspeed",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "react-router build",
    "deploy": "npm run build && wrangler deploy",
    "preview": "vite preview",
    "typecheck": "wrangler types && tsc --noEmit",
    "gen:avatars": "tsx scripts/gen-avatars.ts",
    "db:migrate:local": "wrangler d1 migrations apply cf-teamspeed --local",
    "db:migrate:remote": "wrangler d1 migrations apply cf-teamspeed --remote",
    "db:studio": "wrangler d1 studio cf-teamspeed --local"
  },
  "dependencies": {
    "@dicebear/collection": "^10.0.0",
    "@dicebear/core": "^10.0.0",
    "clsx": "^2.1.1",
    "hono": "^4.6.0",
    "jose": "^6.0.0",
    "lucide-react": "^0.470.0",
    "nanoid": "^5.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^8.0.0",
    "recharts": "^3.0.0",
    "tailwind-merge": "^3.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.0.0",
    "@cloudflare/workers-types": "^4.20260101.0",
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vite": "^7.0.0",
    "wrangler": "^4.142.0"
  }
}
```

> 版本号是**起始约束**，实际安装时用 `npm i` 取当时最新兼容版，
> 并用 `package-lock.json` 锁定。开源发布时会附上实测通过的版本组合。

---

## 13. 数据模型（D1）

```sql
-- 会话流水（审计）
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  role          TEXT NOT NULL,          -- guest | admin
  room_id       TEXT,
  event         TEXT NOT NULL,          -- login_ok | login_fail | join | leave | kick | timeout
  ip_hash       TEXT,
  ip_prefix     TEXT,
  country       TEXT,
  city          TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_created ON sessions(created_at DESC);
CREATE INDEX idx_sessions_nickname ON sessions(nickname);

-- 房间记录
CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_uid     TEXT,
  max_members   INTEGER DEFAULT 10,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER,
  peak_members  INTEGER DEFAULT 0
);

-- 用量日聚合（每类每天一行）
CREATE TABLE usage_daily (
  day           TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  metric        TEXT NOT NULL,          -- sfu_egress_bytes | worker_requests | do_requests | do_duration_ms | d1_reads | d1_writes
  value         REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

-- 封禁名单
CREATE TABLE bans (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,          -- ip | nickname
  value         TEXT NOT NULL,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER
);
CREATE INDEX idx_bans_lookup ON bans(kind, value);

-- 配置
CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

**DO 侧存储**（SQLite-backed）：

| DO | 表 | 说明 |
|---|---|---|
| `RegistryDO` | `nicknames` | 全局昵称注册表 |
| `RegistryDO` | `write_buffer` | 待 flush 的写入缓冲（内存 + 持久化兜底） |
| `RoomDO` | `members` | 房间成员 |
| `RoomDO` | `tracks` | track 发现表 |
| `AdminDO` | `bans_cache` | 封禁名单缓存 |
| `AdminDO` | `login_attempts` | 登录失败计数与锁定 |

---

## 14. 环境变量与密钥

| 名称 | 类型 | 说明 |
|---|---|---|
| `REALTIME_SFU_APP_ID` | Secret | Cloudflare Realtime SFU 应用 ID |
| `REALTIME_SFU_BEARER_TOKEN` | Secret | SFU App Secret |
| `GUEST_KEY` | Secret | 访客 key |
| `ADMIN_KEY` | Secret | 管理员 key |
| `SESSION_SECRET` | Secret | 客户端会话 JWT 签名密钥 |
| `ADMIN_SESSION_SECRET` | Secret | 管理后台会话签名密钥（**必须与上一个不同**，见第 22.2 节④） |
| `TURNSTILE_SECRET_KEY` | Secret | Turnstile 服务端密钥 |
| `VITE_TURNSTILE_SITE_KEY` | Var | Turnstile 前端 sitekey（公开，可进 git） |
| `ADMIN_PATH` | Var | 后台路径（默认 `/dev`） |
| `MAX_ROOM_MEMBERS` | Var | 默认房间人数上限 |
| `ALLOWED_ORIGINS` | Var | 跨域白名单（逗号分隔）；留空 = 只服务同源。见第 22.2 节③ |
| `LOGIN_TURNSTILE` | Var | 登录是否需要人机验证（默认 `true`，**访客与管理员都要**）；设 `false` 可整体关闭 |

### 密钥管理方式

**本地开发**：`.dev.vars`（已在 `.gitignore`）

```
REALTIME_SFU_APP_ID=xxx
REALTIME_SFU_BEARER_TOKEN=xxx
GUEST_KEY=xxx
ADMIN_KEY=xxx
SESSION_SECRET=xxx
TURNSTILE_SECRET_KEY=xxx
```

**生产部署**：

```bash
wrangler secret put REALTIME_SFU_APP_ID
wrangler secret put REALTIME_SFU_BEARER_TOKEN
wrangler secret put GUEST_KEY
wrangler secret put ADMIN_KEY
wrangler secret put SESSION_SECRET
wrangler secret put TURNSTILE_SECRET_KEY
```

### `.gitignore` 关键条目

```
.dev.vars
.env
.env.*
config.yml
.wrangler/
node_modules/
build/
dist/
*.log
```

> `config.example.yml` 与 `.dev.vars.example` **保留在仓库里**，只含占位符，供开源使用者参考。

---

## 15. 开发资源获取

### 15.1 一键安装全部依赖

```bash
# 运行时依赖（前端 + Worker）
npm i hono zod jose \
      react react-dom react-router \
      lucide-react @dicebear/core @dicebear/collection \
      clsx tailwind-merge nanoid recharts

# 开发依赖
npm i -D typescript vite @cloudflare/vite-plugin wrangler \
         tailwindcss @tailwindcss/vite tsx \
         @cloudflare/workers-types \
         @types/react @types/react-dom
```

### 15.2 图标（lucide-react）

| 图标名 | 用途 |
|---|---|
| `Mic` / `MicOff` | 麦克风开关 |
| `Headphones` | 语音室标识 |
| `Volume2` / `VolumeX` | 音量 |
| `Users` | 成员列表 |
| `LogOut` | 离开房间 |
| `Crown` | 管理员标识 |
| `Signal` / `SignalHigh` | 连接质量 |
| `Shield` | 后台鉴权 |
| `Activity` | 用量监控 |
| `ListChecks` | 审计日志 |
| `Settings2` | 管理操作 |
| `Plus` / `Trash2` | 增删 |
| `Upload` | 上传头像 |
| `RefreshCw` | 刷新/重连 |
| `AlertTriangle` | 警告 |
| `Loader2` | 加载中 |
| `DoorOpen` / `DoorClosed` | 进/退房 |
| `Gauge` | 额度进度条 |
| `Download` | 导出 CSV |

### 15.3 头像（DiceBear 本地渲染）

在 `scripts/gen-avatars.ts` 中构建期生成 12 个 SVG 到 `assets/avatars/`，随包发布。
**不调用外部 API**，规避商用授权和可用性风险。

许可说明：DiceBear 各风格许可不同，项目会在 `assets/avatars/LICENSE.md` 中逐个标注来源与许可。

### 15.4 UI 资源清单

| 资源 | 方案 | 状态 |
|---|---|---|
| Favicon | SVG 内联（麦克风 + 声波） | 待生成 |
| 加载动画 | CSS 动画 | 无需资源 |
| 音量指示条 | 纯 CSS + Web Audio API | 无需资源 |
| 连接质量图标 | lucide `Signal*` 三档 | 已覆盖 |
| 用量图表 | `recharts` 折线/柱状/进度条 | 已覆盖 |
| 错误/空状态插画 | 简单 SVG 内联 | 待生成 |

> PWA 图标（192/512 PNG）已排除，原因见第 19.1 节决策 5。

---

## 16. 部署流程

### 16.1 首次准备

**Step 1 — 创建 SFU 应用**

Cloudflare Dashboard → **Realtime** → **Serverless SFU** → 创建应用 → 保存 **App ID** 和 **App Secret**。

或用 API：

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/{account_id}/calls/apps" \
  -H "Authorization: Bearer {CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name": "cf-teamspeed"}'
```

**Step 2 — 创建 Turnstile widget**

Dashboard → **Turnstile** → 添加站点 → 拿到 **Site Key**（前端）和 **Secret Key**（服务端）。

**Step 3 — 创建 D1 数据库**

```bash
wrangler d1 create cf-teamspeed
```

把返回的 `database_id` 填进 `wrangler.jsonc`。

**Step 4 — 生成密钥**

```bash
node -e "console.log('GUEST_KEY=' + crypto.randomUUID())"
node -e "console.log('ADMIN_KEY=' + crypto.randomUUID())"
node -e "console.log('SESSION_SECRET=' + crypto.randomUUID())"
```

### 16.2 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars    # 填入上面的值
npm run db:migrate:local
npm run dev                        # → http://localhost:5173
```

### 16.3 部署

```bash
# 1. 执行远程迁移
npm run db:migrate:remote

# 2. 写入密钥
wrangler secret put REALTIME_SFU_APP_ID
wrangler secret put REALTIME_SFU_BEARER_TOKEN
wrangler secret put GUEST_KEY
wrangler secret put ADMIN_KEY
wrangler secret put SESSION_SECRET
wrangler secret put TURNSTILE_SECRET_KEY

# 3. 部署
npm run deploy
```

### 16.4 wrangler.jsonc 关键配置

```jsonc
{
  "name": "cf-teamspeed",
  "main": "./workers/app.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./build/client" },
  "durable_objects": {
    "bindings": [
      { "name": "ROOM_DO",     "class_name": "RoomDO" },
      { "name": "REGISTRY_DO", "class_name": "RegistryDO" },
      { "name": "ADMIN_DO",    "class_name": "AdminDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RoomDO", "RegistryDO", "AdminDO"] }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "cf-teamspeed", "database_id": "<填这里>" }
  ],
  "observability": { "enabled": true }
}
```

> `new_sqlite_classes` 是必须的——免费版只支持 SQLite 后端的 DO。

---

## 17. 免费额度与风险

### 17.1 额度清单

| 服务 | 免费额度 | 本项目预估 | 余量 |
|---|---|---|---|
| **SFU 出站** | 1000 GB/月 | 10 人 × 4h/天 × 30 天 ≈ 216 GB | ✅ 充裕 |
| Workers 请求 | 10 万/天 | ~2000/天 | ✅ |
| Workers CPU | **10ms/次** | SSR 外壳 ~3ms | ⚠️ 需控制 |
| DO 请求 | 10 万/天 | ~5000/天 | ✅ |
| DO 时长 | 13,000 GB-s/天 | Hibernation 下接近 0 | ✅ |
| D1 行读 | 500 万/天 | ~1 万/天 | ✅ |
| D1 行写 | **10 万/天** | ~500/天（聚合后） | ⚠️ 需控制 |
| D1 存储 | 5 GB | < 50 MB | ✅ |

### 17.2 风险与对策

| 风险 | 后果 | 对策 |
|---|---|---|
| SSR 渲染超 10ms | `Error 1102`，页面 500 | 只 SSR 外壳，重逻辑全在客户端 |
| D1 写入超额 | 写入失败 | 内存聚合 + 定时 flush；后台监控写入量 |
| 房间中继走 TURN | 流量翻倍，可能超额 | 优先直连；后台显示 TURN 占比 |
| DO 未休眠 | 时长费累积 | 全程使用 Hibernation API，禁止 `setInterval` |
| 有人拿到 guest key 滥用 | 费用上升 | key 可轮换；后台可封禁；设置房间人数上限 |

---

## 18. 开发里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M1** | 项目脚手架、Vite + Worker + DO 打通、登录鉴权、昵称注册表 | 能登录进空房间 |
| **M2** | SFU 发布/订阅、房间控制器、成员列表、音量指示 | **能通话** |
| **M3** | 头像系统、心跳与离线回收、重连、房间管理 | 完整可用 |
| **M4** | 管理员后台四个 Tab、Turnstile、限流封禁 | 可运维 |
| **M5** | 用量聚合、D1 迁移、审计导出、README 与部署文档 | 可开源 |

---

## 19. 设计决策记录（已确认）

> 本节记录所有已拍板的决策，后续实现以此为准。

### 19.1 架构类

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 房间默认人数上限 | **10 人**（后台可调整） |
| 2 | 管理员后台路径 | **`/dev`**（默认值，仍通过 `ADMIN_PATH` 环境变量可配） |
| 3 | 端到端加密（E2EE） | **开启**。SFU 仅转发加密流，无功能损失 |
| 4 | 预设头像 | **采用第 6.4 节的 12 个方案**（多样风格） |
| 5 | PWA 支持 | **不做**。仅保留浏览器直开 + WebView 套壳两条路径 |

### 19.2 库选型类

| # | 决策项 | 结论 |
|---|---|---|
| 6 | API 路由框架 | **用 `hono`**（官方 SFU 示例同款） |
| 7 | 后台用量图表 | **用 `recharts`**（仅后台页按需加载） |
| 8 | JWT 库 | **用 `jose`**（唯一能在 Workers 上可靠跑的选择） |
| 9 | ESLint + Prettier | **不引入**。仅保留 TypeScript 类型检查 |
| 10 | 单元测试 | **暂不写**。信令逻辑靠手动验证 |

### 19.3 因「不做 PWA」产生的简化

- 不生成 192/512 PNG 图标
- 不写 Service Worker
- 不写 manifest.json
- `vite.config.ts` 无需 PWA 插件

### 19.4 因「不引入 ESLint」产生的简化

- 不生成 `.eslintrc` / `eslint.config.js`
- 不生成 `.prettierrc`
- `package.json` 的 devDependencies 相应减少 6 项
- **代码风格约束改由约定保证**：统一 2 空格缩进、单引号、语句末尾分号，
  由我生成代码时保持一致；后续如需要可随时补上 ESLint

### 19.5 因「暂不写测试」产生的调整

- devDependencies 去掉 `vitest` 和 `@cloudflare/vitest-pool-workers`
- `package.json` 的 `test` script 暂时移除
- **风险提示**：SDP 串行化队列（第 8.1/8.2 节）和心跳回收（8.3 节）
  是最容易出隐蔽 bug 的地方。若后续出现「偶尔连不上」「幽灵成员」这类问题，
  建议回头给这两块补测试

---

## 20. 下一步

设计已定稿，决策已锁定。开工前需要先完成凭据准备（见第 21 节）。

实现顺序 M1 → M5：

| 阶段 | 内容 |
|---|---|
| M1 | 脚手架 + Vite/Worker/DO 打通 + 登录鉴权 + 昵称注册表 |
| M2 | SFU 发布/订阅 + 房间控制器 + 成员列表 + 音量指示 |
| M3 | 头像系统 + 心跳回收 + 重连 + 房间管理 |
| M4 | 管理员后台四 Tab + Turnstile + 限流封禁 |
| M5 | 用量聚合 + D1 迁移 + 审计导出 + README |

---

## 21. 凭据获取指南

按顺序完成以下 4 步。每步都很短，全程约 10 分钟。

### 21.1 登录 wrangler

在项目目录执行：

```bash
wrangler login
```

会打开浏览器要求授权。完成后验证：

```bash
wrangler whoami
```

应显示你的账号邮箱和 Account ID。

### 21.2 创建 Realtime SFU 应用

1. 打开 <https://dash.cloudflare.com/?to=%2F%3Aaccount%2Frealtime%2Fsfu>
2. 点击 **Create application**
3. 命名任意，如 `cf-teamspeed`
4. 创建后页面上会显示两个值，**立刻复制保存**：

| 值 | 填入 `.dev.vars` 的变量名 |
|---|---|
| App ID | `REALTIME_SFU_APP_ID` |
| App Secret | `REALTIME_SFU_BEARER_TOKEN` |

> ⚠️ App Secret **只显示一次**，关掉页面就再也看不到，只能重新创建应用。
> 它等价于你 SFU 账户的密码，绝不能提交到 git。

### 21.3 创建 Turnstile widget

1. 打开 <https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fturnstile>
2. **Add widget**
3. 配置：
   - Widget name：`cf-teamspeed`
   - Hostname：先填 `localhost`（本地开发用），域名上线后再补
   - Widget Mode：**Managed**（推荐）
4. 创建后拿到两个值：

| 值 | 填入位置 |
|---|---|
| Site Key（公开） | `wrangler.jsonc` 的 `vars.TURNSTILE_SITE_KEY` |
| Secret Key（保密） | `.dev.vars` 的 `TURNSTILE_SECRET_KEY` |

> Turnstile 免费版没有名额限制，随意建。

### 21.4 创建 D1 数据库

```bash
wrangler d1 create cf-teamspeed
```

命令会返回一段配置，形如：

```jsonc
[[d1_databases]]
binding = "DB"
database_name = "cf-teamspeed"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把 `database_id` 的值记下来，稍后我写进 `wrangler.jsonc`。

### 21.5 生成自定义密钥

两把 key 和 JWT 密钥都由你自己生成，不需要向 Cloudflare 申请：

```bash
node -e "console.log('GUEST_KEY=' + crypto.randomUUID())"
node -e "console.log('ADMIN_KEY=' + crypto.randomUUID())"
node -e "console.log('SESSION_SECRET=' + crypto.randomUUID())"
```

> 想更好记的话，`GUEST_KEY` 可以换成自己想的一句好记字符串（建议 ≥16 字符），
> 但 `ADMIN_KEY` 和 `SESSION_SECRET` 强烈建议用随机 UUID。

### 21.6 最终自检清单

完成后对照确认：

- [ ] `wrangler whoami` 能显示账号
- [ ] `REALTIME_SFU_APP_ID` 已保存
- [ ] `REALTIME_SFU_BEARER_TOKEN` 已保存
- [ ] `TURNSTILE_SITE_KEY` 已保存
- [ ] `TURNSTILE_SECRET_KEY` 已保存
- [ ] D1 `database_id` 已保存
- [ ] `GUEST_KEY` / `ADMIN_KEY` / `SESSION_SECRET` 已生成

### 21.7 需要给我的内容

**不要直接把密钥贴给我。** 我会先写好 `.dev.vars.example` 模板和
`wrangler.jsonc` 骨架，你只需告诉我：

1. **D1 的 `database_id`** —— 这个必须写进配置文件，属于非敏感值，可以直接给
2. 其余密钥你自己填进 `.dev.vars` 即可，我写代码时不接触真实值

> 如果你的 D1 `database_id` 不便提供，我也可以用占位符 `REPLACE_WITH_YOUR_D1_ID`，
> 你部署前自行替换。

---

## 22. 跨客户端开放（已实现）

> 目标：**服务端不假设客户端是浏览器**。网页、WebView 套壳、原生 App、CLI、
> 第三方网页，都能接同一套 API。本节记录为此做的改动与背后的取舍。

### 22.1 改动前的四个缺口

| # | 缺口 | 后果 |
|---|---|---|
| 1 | 房间 WebSocket 只认 Cookie | 原生客户端根本连不上（WebSocket API 无法自定义请求头） |
| 2 | 后台 API 只认 Cookie | 脚本 / CLI / 原生 App 无法调管理接口 |
| 3 | 没有任何 CORS 头 | 另一个域名的网页客户端连登录都过不去 |
| 4 | token 生命周期无对外契约 | 12 小时固定 TTL，没有 `/refresh`，长会话必然掉线 |

另有一个文档缺口：契约散落在 `app/lib/api.ts`（web 端实现）里，
而那份代码正是「不想依赖」的东西。

### 22.2 五条设计决定

**① 凭据：Bearer 是主路，Cookie 是浏览器专属的便利通道**

`middleware/auth.ts` 同时接受 `Authorization: Bearer` 与 Cookie，
且 **Bearer 优先**（显式声明的凭据应当胜过隐式的，否则「切账号」会被旧 cookie 覆盖）。
`requireAdminSession` 也补上了 Bearer —— 它原来只认 cookie，
但登录接口却明明返回了 token，属于自相矛盾。

> 网页端也主动带 Bearer。这样「网页能跑」就等价于「别的客户端也能跑」，
> 不会出现只有浏览器才通、别处一接就炸的路径。

**② WebSocket：HTTP 领一次性票据**

```
POST /api/rooms/:id/ws-ticket   (带 Bearer)
  → { ticket, expiresAt, wsUrl }
WS  wss://…/api/rooms/:id/ws?ticket=<ticket>
```

票据存在 **RoomDO 自己的 SQLite 表**里（`ws_tickets`），因此天然与房间绑定：
别的房间的 DO 里根本没有这张票。三重限制：60 秒过期、单次有效、绑定 uid。

允许 **5 秒内的重复消费**：WebSocket 重连可能因网络抖动紧挨着发生两次，
严格单次会让第二次莫名其妙连不上，而 5 秒窗口短到来不及被利用。

老路径（Cookie + `?uid=`）保留，但 uid 由 Worker 从**已校验的会话**写入，
客户端传什么都不算数。

**③ CORS：默认关闭，白名单精确匹配**

`ALLOWED_ORIGINS` 逗号分隔；命中才回显该 origin。三个细节：

- **同源请求不写 CORS 头**。浏览器的同源请求也会带 `Origin`，
  照抄会让服务端把自己当第三方。
- **未命中时普通请求仍然照常处理**，只是不写 CORS 头。
  非浏览器客户端（curl / 原生）不带 `Origin`，白名单对它们完全无感 ——
  这也是「原生客户端零配置」的原因。
- **`*` 与凭据互斥**。CORS 规范禁止 `Access-Control-Allow-Origin: *`
  与 `Allow-Credentials: true` 共存，所以通配模式下只能用 Bearer。
  这反而与第三方客户端的推荐做法一致。

预检（OPTIONS）在最外层拦截，不会走到鉴权中间件 ——
否则未登录的预检会被 401 掉，前端只能看到「CORS 预检失败」这种误导性错误。

**④ 会话：滚动续期 + 绝对上限**

```
SESSION_TTL_HOURS = 12            # 滚动窗口
SESSION_ABSOLUTE_TTL_HOURS = 720  # 30 天硬上限
```

任意鉴权请求都会顺带续期，但 **`iat` 是原始签发时间，续期时原样保留** ——
否则「每次续期都刷新 iat」会把绝对上限骗过去，token 等于永不过期。

续期后的 `exp` 必须是 `now + ttl`，**不是** `iat + ttl`。
这一点最初的实现写错了：老 token 剩多久新 token 就还是多久，
「续期」变成原地踏步。测试（`scripts/test-client-api.ts`）把这个 bug 钉住了。

token 下发三条路，客户端只需实现一条也能跑：

| 通道 | 场景 |
|---|---|
| 响应体 `data.token` | 登录 / refresh / 改资料 |
| 响应头 `X-Refreshed-Token` | 任意鉴权请求都可能带（覆盖面最广） |
| Cookie | 浏览器 |

**⑤ 契约外置：清册 + OpenAPI + 参考实现**

- `shared/api-surface.ts`：机器可读的接口清册（含鉴权等级、核心闭环标记）
- `docs/API.md`：写给「写客户端的人」，含 WebRTC 对接步骤与踩坑清单
- `docs/openapi.json`：OpenAPI 3.1（核心闭环，可导入 Postman / 代码生成器）
- `client/`：零依赖 TypeScript 参考实现（认证 / 房间 / WS 重连 / 心跳）

**防腐烂**：`scripts/test-client-api.ts` 会核对
「OpenAPI 里的每个接口都在清册里」+「核心闭环接口都有文档」，
改了路由不同步文档就会测试失败。

### 22.3 与「不做 PWA」的关系

第 19.1 节决定不做 PWA。这里要区分两件事：

- **PWA**（可安装、离线、Service Worker）—— 仍然不做。
- **跨客户端 API**（让别的客户端能接）—— 本次要做。

前者是「网页的增强形态」，后者是「服务端不绑定网页」，方向不同。

### 22.4 客户端库的边界

`client/index.ts` **只负责信令与房间状态**，不碰媒体。
音频采集、编解码、E2EE 是平台强相关的，由调用方实现 `MediaTransport`
（接口定义在文件末尾）。好处：房间状态机与语音实现可以各自演进。

约束：SDK 与它的测试必须能被 Node 的 type-stripping 直接加载，
因此**不使用构造函数参数属性**（`constructor(readonly x: T)`）——
strip-only 模式只擦除类型，无法生成参数属性所需的赋值。

### 22.5 明确未做

- **E2EE 仍未落地**（见第 11.3 节的说明与 README「已知未完成」）。
  密钥分发协议必须先在 API 契约里定死，否则每个客户端会各写一套。
- **HTTP 与 WebSocket 在 Worker 上是两条路径**，因此 CORS 中间件管不到
  WebSocket 握手。目前够用（票据本身即凭据），但如果将来要限制
  「哪些源可以连 WebSocket」，需要在 RoomDO 里再校验一次 Origin。

---

## 23. 待办：用户提供凭据后开工

**当前状态**：设计定稿，等待用户完成第 21 节的凭据准备。

**用户回来后我需要做的第一件事**：
1. 读取用户提供的 `database_id`
2. 生成 `.dev.vars.example`、`.gitignore`、`wrangler.jsonc`
3. 开始 M1 实现

