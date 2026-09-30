# cf-teamspeed

> 基于 **Cloudflare Realtime SFU + Workers** 的私人游戏语音室。
> 浏览器直接打开即用，也可用 WebView 套壳成 App。

---

## 特性

| | |
|---|---|
| 🎙 **真实时语音** | Cloudflare Realtime SFU，UDP 传输，延迟低 |
| 🆓 **零成本** | 全部跑在 Cloudflare 免费额度内 |
| 🚀 **单条命令部署** | 一个 Worker 同时提供前端页面与后端 API |
| 🔑 **两级 key** | 访客 key（进/退房）+ 管理员 key（管理人与房间） |
| 👤 **昵称全局唯一** | 规范化后注册，防止重名与冒充 |
| 🖼 **头像系统** | 12 个预设头像 + 自定义上传 |
| 🛡 **防白嫖** | key 只存服务端 Secret，登录换短期 JWT |
| 🔌 **任意客户端可接入** | 纯 JSON API + Bearer 鉴权 + WebSocket 票据，附 SDK 与完整文档（见下） |
| 📊 **用量看板** | 实时监控 Cloudflare 免费额度占用 |
| 📜 **会话审计** | 登录、进/退房、踢人等事件全记录，可导出 CSV |
| 🔒 **E2EE** | 端到端加密：**目标状态**，当前仅下发 keyId（见「已知未完成」） |

---

## 用别的客户端接入

服务端不假设客户端是浏览器：

- **鉴权只有一种必需形态**：`Authorization: Bearer <token>`（Cookie 是浏览器专属的便利通道）
- **WebSocket 用一次性票据握手**：因为 WebSocket API 无法自定义请求头
- **统一响应格式**：`{ok:true,data}` / `{ok:false,error,code}`，分支判断用稳定的 `code`
- **滚动续期**：活跃会话自动延长，不用自己算过期

| 资源 | 说明 |
|---|---|
| [`docs/API.md`](docs/API.md) | 完整接口文档（含 WebRTC 对接、错误码、限流、检查清单） |
| [`docs/openapi.json`](docs/openapi.json) | OpenAPI 3.1 规格（核心闭环，可导入 Postman / 代码生成器） |
| [`client/index.ts`](client/index.ts) | 零依赖 TypeScript SDK：登录、续期、房间、WebSocket 重连、心跳 |
| [`shared/api-surface.ts`](shared/api-surface.ts) | 机器可读的接口清册（有测试防止文档腐烂） |
| [`scripts/audio-eval/`](scripts/audio-eval/README.md) | 语音隔离评测台：换降噪模型前先量出结论，别靠耳朵猜 |

```ts
import { VoiceRoomClient } from './client/index';

const client = new VoiceRoomClient({ baseUrl: 'https://your-worker.workers.dev' });
client.on('snapshot', (s) => console.log(s.members));
client.on('kicked', (e) => console.log('被踢：', e.reason));

await client.login({ key: '你的 GUEST_KEY', nickname: '甲' });
await client.joinRoom('home');   // 自动连 WebSocket、跑心跳、断线重连
```

原生客户端（Kotlin / Swift / Go / Python…）照 [`docs/API.md`](docs/API.md) 第 10 节的
检查清单实现即可；媒体层用平台自带的 WebRTC，信令走 `/api/rtc/*`。

> SDK 目前以**源码形式**提供（`client/` + `shared/`），没有单独的 npm 包：
> 它既是可直接使用的实现，也是「协议长什么样」的参考。
> 在自己的工程里直接拷进去或让打包器一起编即可。

**默认零配置安全**：`ALLOWED_ORIGINS` 为空时只服务同源页面，跨域网页全被拦下；
原生客户端不受 CORS 约束，无需任何配置。

---

## 快速开始

### 1. 前置条件

- Node.js ≥ 20
- Cloudflare 账号（免费版即可）
- 已登录 wrangler：`wrangler login`

### 2. 准备凭据

```bash
cp .dev.vars.example .dev.vars
```

然后按下面的表格填写 `.dev.vars`：

| 变量 | 从哪里拿 |
|---|---|
| `REALTIME_SFU_APP_ID` | [Cloudflare Dashboard → Realtime → SFU](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Frealtime%2Fsfu) 创建应用 |
| `REALTIME_SFU_BEARER_TOKEN` | 同上，**App Secret 只显示一次** |
| `GUEST_KEY` | 自己生成：`node -e "console.log(crypto.randomUUID())"` |
| `ADMIN_KEY` | 同上（**不要**用可猜的字符串） |
| `SESSION_SECRET` | 同上 |
| `TURNSTILE_SECRET_KEY` | [Turnstile 控制台](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fturnstile)；开发阶段可用测试 key `1x0000000000000000000000000000000AA` |

### 3. 创建 D1 数据库

```bash
wrangler d1 create cf-teamspeed
```

把返回的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`。

### 4. 启动

```bash
npm install
npm run gen:avatars            # 生成 12 个预设头像
npm run db:migrate:local       # 本地建表
npm run dev                    # → http://localhost:5173
```

### 5. 配置应用

非敏感配置在 `config.yml`（已被 git 忽略）：

```bash
cp config.example.yml config.yml
```

---

## 部署

```bash
# 1. 远程建表
npm run db:migrate:remote

# 2. 写入 Secret（逐个粘贴 .dev.vars 里的值）
wrangler secret put REALTIME_SFU_APP_ID
wrangler secret put REALTIME_SFU_BEARER_TOKEN
wrangler secret put GUEST_KEY
wrangler secret put ADMIN_KEY
wrangler secret put SESSION_SECRET
wrangler secret put TURNSTILE_SECRET_KEY

# 3. 部署
npm run deploy
```

> **上线前**：把 `wrangler.jsonc` 里的 `TURNSTILE_SITE_KEY` 从测试 key
> 换成真实 widget 的 sitekey，并同步更新 `.dev.vars` 的
> `TURNSTILE_SECRET_KEY`。Turnstile 的 Hostname 是**白名单**（不是所有权证明），
> 填你的域名即可，随时可改。

---

## 架构

```
浏览器 / WebView / 原生 App / CLI
     │
     │  ① HTTP：登录（换 Bearer token 或 Cookie）、房间、presence、SFU 信令
     │  ② WebSocket：房间变更通知（先用 HTTP 领一次性票据，再带 ticket 握手）
     ▼
Cloudflare Worker（单文件入口 workers/app.ts）
     ├── CORS 白名单中间件（默认关闭 = 只服务同源）
     ├── Hono 路由  ── /api/auth  /api/rooms  /api/rtc  /api/presence  /api/admin
     ├── React Router SSR（只渲染外壳，控制在 10ms CPU 内）
     └── 绑定
          ├── RegistryDO   昵称注册表 + 房间目录 + 用量累加
          ├── RoomDO       每房间一个：成员表 + WebSocket 广播 + track 发现 + 握手票
          ├── AdminDO      封禁名单 + 登录锁定 + 审计缓冲
          └── D1           审计流水 + 用量日聚合（批量落库）
                    │
                    │  ③ SFU REST API（App Secret 认证）
                    ▼
          Cloudflare Realtime SFU
                    │
                    │  ④ WebRTC（DTLS-SRTP；E2EE 见「已知未完成」）
                    ▼
              其他成员
```

**关键设计**：Worker 不接触媒体流。音频走「客户端 ↔ SFU」直连，
Worker 只负责信令与房间状态。

---

## 可选配置

非敏感配置在 `wrangler.jsonc` 的 `vars` 里，改完重新 `npm run deploy` 即可：

| 变量 | 默认 | 作用 |
|---|---|---|
| `ALLOWED_ORIGINS` | 空 | 跨域白名单，逗号分隔的完整 origin。**空 = 只服务同源页面**，原生客户端不受影响。填 `*` 则放行任意来源但只能用 Bearer（浏览器不允许 `*` + Cookie） |
| `ADMIN_LOGIN_TURNSTILE` | `true` | 管理员登录是否强制人机验证。设为 `false` 可让无法渲染 Turnstile 的原生客户端直接登录后台 |
| `MAX_ROOM_MEMBERS` | `10` | 新房默认人数上限 |
| `ADMIN_PATH` | `/dev` | 后台路径 |
| `AUDIT_RETENTION_DAYS` | `90` | 审计流水保留天数 |

**什么时候需要动 `ALLOWED_ORIGINS`**：

- 前端和 Worker **同域**（本项目默认形态，React Router 一起部署）→ 不用管。
- 原生 App / CLI / 服务端脚本 → 不用管（CORS 是浏览器特有的约束）。
- 想把前端部署到**另一个域名**（比如 `app.example.com` 调 `ts.example.com`）→
  必须填上 `https://app.example.com`，并用 Bearer 而非 Cookie 鉴权。

---

## 免费额度

| 服务 | 免费额度 | 本项目预估 | 风险 |
|---|---|---|---|
| SFU 出站 | 1000 GB/月 | 10 人 × 4h/天 ≈ 216 GB | ✅ 充裕 |
| Workers 请求 | 10 万/天 | ~2000/天 | ✅ |
| Workers CPU | **10ms/次** | SSR 外壳 ~3ms | ⚠️ 需控制 |
| DO 请求 | 10 万/天 | ~5000/天 | ✅ |
| DO 时长 | 13,000 GB-s/天 | Hibernation 下接近 0 | ✅ |
| D1 行读 | 500 万/天 | ~1 万/天 | ✅ |
| D1 行写 | **10 万/天** | ~500/天（聚合后） | ⚠️ **最紧瓶颈** |
| D1 存储 | 5 GB | < 50 MB | ✅ |

**三条硬约束**（改架构前必读）：

1. **Workers 免费版 CPU = 10ms/次调用** — 超出报 `Error 1102`。SSR 只做外壳。
2. **Durable Objects 免费版只支持 SQLite 后端** — migrations 必须用 `new_sqlite_classes`。
3. **D1 写入 10 万行/天是最紧的瓶颈** — 因此所有写入走
   「DO 内存累加 → cron 每 10 分钟批量 flush → D1」，**绝不逐条写日志**。

另有两条 DO 使用纪律：

4. **禁止 `setInterval`** — 会阻止 DO 休眠，产生时长费。离线判定改为惰性清理。
5. **全程使用 Hibernation API** — 空闲连接不计时长费。

---

## 项目结构

```
cf-teamspeed/
├── app/                          # Web 客户端（React Router）
│   ├── routes/
│   │   ├── lobby.tsx             # 登录 + 资料 + 房间列表
│   │   ├── room.tsx              # 语音房间
│   │   └── dev.tsx               # 管理员后台
│   ├── components/
│   │   ├── Avatar.tsx            # 头像渲染 + 选择器
│   │   ├── VolumeMeter.tsx       # 实时音量（Web Audio API）
│   │   ├── MemberList.tsx        # 成员列表
│   │   └── admin/                # 后台四个 Tab
│   ├── lib/
│   │   ├── room-controller.ts    # 核心：连接生命周期
│   │   ├── sfu-session.ts        # SFU 会话封装
│   │   ├── api.ts                # 后端 API 客户端（Bearer + 自动续期）
│   │   └── settings.ts           # 本地配置
│   ├── root.tsx
│   ├── routes.ts
│   └── styles.css
├── client/                       # 跨客户端 SDK（零依赖，任何运行时可用）
│   ├── index.ts                  # VoiceRoomClient：认证 / 房间 / WebSocket / 心跳
│   └── lib/http.ts               # HTTP 层：Bearer、401 处置、滚动续期
├── docs/
│   ├── API.md                    # 完整接口文档（写给写客户端的人）
│   └── openapi.json              # OpenAPI 3.1 规格
├── workers/                      # 服务端
│   ├── app.ts                    # Worker 入口
│   ├── middleware/               # auth（Cookie/Bearer + 续期）、cors、ratelimit
│   ├── routes/                   # auth、rooms、rtc、presence、admin
│   ├── durable/                  # RoomDO、RegistryDO、AdminDO、PresenceDO
│   └── lib/                      # sfu、jwt、db、turnstile、crypto
├── shared/                       # 前后端共享类型与 schema
│   ├── schema.ts                 # Zod 请求校验
│   ├── types.ts                  # 类型 + 错误码契约
│   └── api-surface.ts            # 机器可读的接口清册（防文档腐烂）
├── assets/avatars/               # 12 个预设头像（构建期生成）
├── migrations/                   # D1 迁移
├── scripts/
│   ├── gen-avatars.ts            # 头像生成脚本
│   ├── test-client-api.ts        # 鉴权 / CORS / 文档一致性自测
│   └── test-sdk.ts               # SDK 自测（假 HTTP + 假 WebSocket）
├── public/favicon.svg
├── DESIGN.md                     # 完整设计文档
└── SETUP.md                      # 配置步骤留档
```

---

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发（Vite + Workerd） |
| `npm run build` | 构建 |
| `npm run deploy` | 构建并部署 |
| `npm run typecheck` | 生成类型并检查 |
| `npm test` | 跑全部自测（语音门限 + API 契约 + SDK） |
| `npm run test:api` | 鉴权续期、CORS、API 文档一致性 |
| `npm run test:sdk` | 跨客户端 SDK 行为 |
| `npm run gen:avatars` | 生成预设头像 SVG |
| `npm run db:migrate:local` | 本地执行 D1 迁移 |
| `npm run db:migrate:remote` | 远程执行 D1 迁移 |
| `npm run db:studio` | 本地 D1 可视化 |

> 自测脚本用 Node 自带的 TypeScript 类型擦除运行（`--experimental-strip-types`），
> 不需要额外构建步骤，因此 `engines.node` 要求 **≥ 22.6**。

---

## 安全说明

- **永不提交**：`.dev.vars`、`.env*`、`config.yml`、`.wrangler/`
  （已在 `.gitignore` 中；`.dev.vars.example` 与 `config.example.yml` 是模板，可提交）
- key 只存 Worker Secret，登录后换 **会话 token**，之后不再传输 key
- 会话 token 双通道下发：浏览器用 HttpOnly Cookie，其他客户端用 `Authorization: Bearer`
- **滚动续期**：活跃会话自动延长（12 小时窗口），绝对上限 30 天，不会被无限续期
- 管理后台用**独立的 secret、audience 与 token**，客户端 token 进不了后台 API
- key 比对使用时序安全比较，防侧信道攻击
- 登录失败 5 次锁定该 IP 15 分钟
- 所有 SFU 调用必须携带有效会话；track 操作校验所有权，防越权
- WebSocket 握手用**一次性票据**（60 秒有效），票据与房间、用户绑定
- 跨域默认关闭；白名单精确匹配才放行，且不把 `*` 与凭据混用
- IP 只存哈希 + 前两段，不存完整地址

---

## 已知未完成

**E2EE 只完成了一半。** `DESIGN.md` 第 11.3 节把端到端加密列为「已确认开启」，
但实际实现只到「服务端下发 `keyId`」这一步：

- 房间密钥**材料**没有下发协议，客户端拿不到密钥；
- Web 客户端里 `room-controller.ts` 拿到 `keyId` 后直接丢弃（`void keyId`）；
- 因此当前实际加密强度 = **DTLS-SRTP**（传输层加密），SFU 能看到明文音频。

这一项没有隐藏：`docs/API.md` 第 6.4 节写明了现状。
要真正开启需要先定密钥分发协议（服务端只做分发、不持有明文音频），
再在客户端接 `RTCRtpScriptTransform`，并同步更新 API 契约与本文档。

---

## WebView 套壳

若 App 需要固定指向某个 Worker：

```js
window.__CF_VOICE_BASE_URL__ = 'https://your-worker.workers.dev';
```

否则客户端自动使用 `window.location.origin`。

**兼容性注意**：

- Android WebView 需 `setMediaPlaybackRequiresUserGesture(false)` 才能自动播放远端音频
- iOS `WKWebView` 需在 Info.plist 声明麦克风权限并处理 `WKUIDelegate` 的权限请求

---

## 许可

MIT

预设头像由 [DiceBear](https://www.dicebear.com/) 在构建期本地渲染生成，
各风格许可详见 `assets/avatars/LICENSE.md`。其中 `adventurer` 风格为 CC BY 4.0：

> Avatars: "Adventurer" by Lisa Wischofsky, licensed under CC BY 4.0.