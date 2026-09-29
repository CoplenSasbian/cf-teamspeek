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
| 📊 **用量看板** | 实时监控 Cloudflare 免费额度占用 |
| 📜 **会话审计** | 登录、进/退房、踢人等事件全记录，可导出 CSV |
| 🔒 **E2EE** | 端到端加密（`RTCRtpScriptTransform`），SFU 只见密文 |

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
浏览器 / WebView
     │
     │  ① HTTP：登录、房间管理、SFU 信令
     │  ② WebSocket：房间变更通知
     ▼
Cloudflare Worker（单文件入口 workers/app.ts）
     ├── Hono 路由  ── /api/auth  /api/rooms  /api/rtc  /api/admin
     ├── React Router SSR（只渲染外壳，控制在 10ms CPU 内）
     └── 绑定
          ├── RegistryDO   昵称注册表 + 房间目录 + 用量累加
          ├── RoomDO       每房间一个：成员表 + WebSocket 广播 + track 发现
          ├── AdminDO      封禁名单 + 登录锁定 + 审计缓冲
          └── D1           审计流水 + 用量日聚合（批量落库）
                    │
                    │  ③ SFU REST API（App Secret 认证）
                    ▼
          Cloudflare Realtime SFU
                    │
                    │  ④ WebRTC（DTLS-SRTP + E2EE）
                    ▼
              其他成员的浏览器
```

**关键设计**：Worker 不接触媒体流。音频走「客户端 ↔ SFU」直连，
Worker 只负责信令与房间状态。

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
├── app/                          # 客户端（React Router）
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
│   │   ├── api.ts                # 后端 API 客户端
│   │   └── settings.ts           # 本地配置
│   ├── root.tsx
│   ├── routes.ts
│   └── styles.css
├── workers/                      # 服务端
│   ├── app.ts                    # Worker 入口
│   ├── middleware/               # auth、ratelimit
│   ├── routes/                   # auth、rooms、rtc、admin
│   ├── durable/                  # RoomDO、RegistryDO、AdminDO
│   └── lib/                      # sfu、jwt、db、turnstile、crypto
├── shared/                       # 前后端共享类型与 schema
├── assets/avatars/               # 12 个预设头像（构建期生成）
├── migrations/                   # D1 迁移
├── scripts/gen-avatars.ts        # 头像生成脚本
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
| `npm run gen:avatars` | 生成预设头像 SVG |
| `npm run db:migrate:local` | 本地执行 D1 迁移 |
| `npm run db:migrate:remote` | 远程执行 D1 迁移 |
| `npm run db:studio` | 本地 D1 可视化 |

---

## 安全说明

- **永不提交**：`.dev.vars`、`.env*`、`config.yml`、`.wrangler/`
  （已在 `.gitignore` 中；`.dev.vars.example` 与 `config.example.yml` 是模板，可提交）
- key 只存 Worker Secret，登录后换 12 小时 JWT，之后不再传输 key
- key 比对使用时序安全比较，防侧信道攻击
- 登录失败 5 次锁定该 IP 15 分钟
- 所有 SFU 调用必须携带有效 JWT
- track 操作校验所有权，防越权
- IP 只存哈希 + 前两段，不存完整地址

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
