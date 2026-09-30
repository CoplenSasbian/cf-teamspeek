# cf-teamspeed API 参考

> 这份文档面向**写客户端的人**（不一定是网页）。
> 目标：拿这份文档 + 一个 HTTP 库，就能在任意语言 / 平台上写出完整可用的客户端。
>
> 已经有一个现成的 TypeScript 参考实现：`client/index.ts`（零依赖，可在 Node / 浏览器 /
> React Native 里跑）。看不懂某处协议时，那里的代码就是答案。

---

## 目录

1. [一分钟上手](#1-一分钟上手)
2. [鉴权](#2-鉴权)
3. [统一响应格式与错误码](#3-统一响应格式与错误码)
4. [WebSocket 事件流](#4-websocket-事件流)
5. [接口清单](#5-接口清单)
6. [媒体层：怎么和 SFU 对接](#6-媒体层怎么和-sfu-对接)
7. [CORS 与跨域部署](#7-cors-与跨域部署)
8. [限流与审计](#8-限流与审计)
9. [写给浏览器客户端](#9-写给浏览器客户端)
10. [写给原生 / CLI 客户端](#10-写给原生--cli-客户端)
11. [变更与兼容性承诺](#11-变更与兼容性承诺)

---

## 1. 一分钟上手

```bash
# 1. 拿配置（无需鉴权）
curl https://ts.futurvo.cc/api/auth/config

# 2. 用 key + 昵称换 token
curl -X POST https://ts.futurvo.cc/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"key":"<GUEST_KEY>","nickname":"甲"}'
# → {"ok":true,"data":{"token":"eyJ...","expiresAt":...,"profile":{...}}}

# 3. 之后所有请求带上它
curl https://ts.futurvo.cc/api/rooms -H 'Authorization: Bearer eyJ...'

# 4. 进房间
curl -X POST https://ts.futurvo.cc/api/rooms/home/join -H 'Authorization: Bearer eyJ...'

# 5. 领 WebSocket 票（WebSocket 没法带请求头，所以要先领票）
curl -X POST https://ts.futurvo.cc/api/rooms/home/ws-ticket -H 'Authorization: Bearer eyJ...'
# → {"ok":true,"data":{"ticket":"...","wsUrl":"wss://.../ws?ticket=..."}}

# 6. 用拿到的 wsUrl 连 WebSocket，开始收房间事件
```

**完整生命周期**（任何客户端都是这六步）：

```
配置 → 登录(换 token) → 进房间 → 领票连 WebSocket → 收发事件/信令 → 离开 + 登出
                                    ↘ 到期前 POST /api/auth/refresh
```

---

## 2. 鉴权

### 2.1 两把 key

| Key | 能力 |
|---|---|
| `GUEST_KEY` | 登录、进/退房间、开关自己的麦克风、在线状态、邀请他人 |
| `ADMIN_KEY` | 访客全部能力 + 管理员后台（`/api/admin/*`）+ 踢人 / 封禁 / 关房 |

key 只存在于**服务端环境变量**里，永远不会下发给客户端。客户端只在登录那一瞬间
用到 key，之后一律用**会话 token**。

### 2.2 会话 token

- 形态：JWT（HS256），放在 `Authorization: Bearer <token>`。
- 有效期：**滚动窗口** 12 小时。只要在有效期内有任意鉴权请求，服务端会顺带换发新
  token —— 活跃会话自动延长，闲置超过 12 小时才掉线。
- 绝对上限：**30 天**。从首次登录算起，之后必须重新用 key 登录
  （服务端返回 `SESSION_EXPIRED`）。
- 管理员后台是**另一套** token（不同的 secret 与 audience，4 小时滚动 / 7 天绝对上限）。
  客户端 token 不能调后台接口，反之亦然。

### 2.3 服务端续期 token 的三种方式

客户端需要能收到「服务端顺手换发的新 token」，否则会把过期 token 一直用下去：

| 方式 | 出现场景 | 客户端要做的事 |
|---|---|---|
| 响应体 `data.token` | `POST /api/auth/login`、`POST /api/auth/refresh`、`PATCH /api/auth/me` | 覆盖本地存的 token |
| 响应头 `X-Refreshed-Token` | **任意**鉴权请求都可能带 | 有就覆盖本地 token |
| Cookie `ct_session` | 浏览器（HttpOnly，自动） | 什么都不用做 |

> 只处理响应头那一条也能跑通 —— 因为它覆盖了所有请求。

### 2.4 续期：两种时机

```http
POST /api/auth/refresh
Authorization: Bearer <token>
```

返回与登录相同的结构（含新 token）。**建议**：token 剩余寿命不足 5 分钟时调一次，
或者长连接客户端定时（例如每 30 分钟）调一次。

其实不调也行 —— 任何请求都会滚动续期。这个接口是给「整晚只挂 WebSocket、几乎不发
HTTP 请求」的客户端一个确定的续期时机。

失败语义：
- `401 UNAUTHORIZED`：token 无效（写错了 / 部署换过 `SESSION_SECRET`）→ 重新登录。
- `401 SESSION_EXPIRED`：会话到顶 → 重新登录，**不要重试**。

### 2.5 登出

```http
POST /api/auth/logout      # 无需鉴权（带过期 token 也必须能登出）
```

JWT 无状态，服务端不维护撤销名单。登出 = 服务端清 Cookie + **客户端自己删掉 token**。
建议先调 `POST /api/presence/leave` 让在线名册立刻更新，再登出。

### 2.6 管理员登录与人机验证

```http
POST /api/admin/auth/login
{"key":"<ADMIN_KEY>"}
```
→ `{"ok":true,"data":{"token":"...","nickname":"admin","expiresAt":...}}`

之后调 `/api/admin/*` 带 `Authorization: Bearer <后台 token>`。

> ⚠️ **注意**：客户端会话里的 `role=admin` **不能**调后台接口。后台接口只认
> `/api/admin/auth/login` 签发的 token。

**Turnstile**：客户端登录（`/api/auth/login`）在**管理员 key** 下强制人机验证，
需要提交 `turnstileToken`。是否强制由服务端 `ADMIN_LOGIN_TURNSTILE` 决定，
可以先看 `GET /api/auth/config` 的 `adminLoginTurnstile` 字段：

- `true`（默认）：原生客户端需要内嵌 WebView 渲染 Turnstile widget 才能走管理员登录。
  访客登录**不需要**。
- `false`：部署方关掉了验证，任何客户端都能直接登录后台（只剩 key + 失败锁定）。

---

## 3. 统一响应格式与错误码

### 3.1 成功 / 失败

```jsonc
// 成功
{ "ok": true, "data": { ... } }

// 失败
{ "ok": false, "error": "给用户看的中文提示", "code": "STABLE_CODE", "detail": ... }
```

**判断规则**：先看 HTTP 状态码是否 2xx，再看 `ok` 是否为 `true`。
`error` 文案会变，**分支逻辑一律用 `code`**。`detail` 只在调试时看。

### 3.2 错误码

| `code` | HTTP | 含义 | 客户端应该做什么 |
|---|---|---|---|
| `INVALID_KEY` | 401 | key 不对 | 提示重填 key |
| `INVALID_BODY` | 400 | 参数不合法 | 修请求（含昵称/房间名格式错误） |
| `NICKNAME_TAKEN` | 409 | 昵称被占用 | 让用户换名字 |
| `NICKNAME_RESERVED` | 409 | 昵称是保留字 | 让用户换名字 |
| `NICKNAME_INVALID` | 409 | 昵称格式不合法 | 让用户改格式 |
| `UNAUTHORIZED` | 401 | 未登录 / token 无效 | 清理本地会话 → 回登录 |
| `SESSION_EXPIRED` | 401 | 会话到绝对上限 | 清理本地会话 → 回登录（**别重试**） |
| `FORBIDDEN` | 403 | 权限不足 | 提示，不登出 |
| `BANNED` | 403 | 已被移出服务器 | 清理会话 → 提示 → 回登录 |
| `ROOM_NOT_FOUND` | 404 | 房间 / 轨道不存在 | 刷新房间列表 |
| `ROOM_FULL` | 409 | 房间满 | 提示换房间 |
| `RATE_LIMITED` | 429 | 太频繁 | 按 `Retry-After` 头退避 |
| `TURNSTILE_FAILED` | 403 | 人机验证失败 | 重新过验证再试 |
| `BAD_TICKET` | 401 | WebSocket 票无效/过期/已用 | 重新领票再连 |
| `INTERNAL` | 500/502 | 服务端或 SFU 出错 | 可重试，配合退避 |

### 3.3 其它响应头

| 头 | 何时出现 | 含义 |
|---|---|---|
| `X-Refreshed-Token` | 服务端滚动续期时 | 新的 token，覆盖本地存的 |
| `Retry-After` | 429 | 建议等待秒数 |
| `X-Auth-Method` | 登录响应 | `cookie` / `bearer` / `none`，排查用 |

---

## 4. WebSocket 事件流

### 4.1 为什么不能直接带 token

浏览器与原生客户端的 WebSocket API **都无法自定义请求头**，所以没法带
`Authorization: Bearer`。因此采用「HTTP 领票 + 查询串握手」：

```http
POST /api/rooms/{roomId}/ws-ticket
Authorization: Bearer <token>
```
```jsonc
{
  "ok": true,
  "data": {
    "ticket": "3f2a…",           // 一次性票据
    "expiresAt": 1750000000,     // 60 秒后过期
    "wsUrl": "wss://host/api/rooms/home/ws?ticket=3f2a…"   // 直接用它连
  }
}
```

规则：

- 有效期 **60 秒**，**单次有效**（重连必须重新领票）。
- 票据与房间绑定，别的房间用不了。
- 握手失败（`401 BAD_TICKET`）时**重新领票再连**，不要复用旧票。
- 5 秒内的重复使用是允许的（容忍重连抖动），超过就作废。

### 4.2 服务端下行事件

连上后会立刻收到一条 `room-changed`。事件是**变更信号**，不是全量数据 ——
收到后请拉一次 `GET /api/rooms/{id}/snapshot` 拿权威状态。

| `type` | 载荷 | 客户端应做什么 |
|---|---|---|
| `room-changed` | `version` | 拉快照，更新成员列表 |
| `member-joined` | `member` | 播提示音（可选），拉快照 |
| `member-left` | `uid` | 移除该成员的音频/画面，拉快照 |
| `key-rotated` | `keyId` | E2EE 客户端重新取房间密钥 |
| `kicked` | `reason` | 停止一切，提示用户，**不要重连** |
| `room-closed` | `reason` | 同上 |

### 4.3 客户端上行消息

```jsonc
{"type":"heartbeat"}            // 保活（推荐每 15 秒一次，比 HTTP 省额度）
{"type":"mute","muted":true}    // 上报麦克风开关状态
```

### 4.4 心跳与离线判定

- 服务端 **45 秒**收不到任何信号（WebSocket 消息或 HTTP `heartbeat`）就把你判为离线
  并回收房间资源。
- 所以**必须**每 15 秒发一次心跳。WebSocket 活着就走 socket，断了退回：
  `POST /api/rooms/{id}/heartbeat`，body `{"roomId":"<id>"}`。
- 断了要自动重连（建议指数退避）。重连后立刻补一次心跳，避免刚连上就被回收。

### 4.5 兼容路径（不推荐新客户端使用）

浏览器在 Cookie 有效时可以直接连 `GET /api/rooms/{id}/ws`
（服务端从会话里取 uid，客户端传什么都不算数）。这条路径是历史兼容，
新客户端请一律走 ticket。

---

## 5. 接口清单

所有接口都以 `/api` 开头。除标注「无需鉴权」外都要带 `Authorization: Bearer <token>`。

### 5.1 配置与鉴权

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/config` | **无需鉴权**。应用名、人数上限、Turnstile 开关等 |
| `POST` | `/api/auth/login` | key + 昵称换 token（**无需鉴权**） |
| `POST` | `/api/auth/refresh` | 续期 |
| `GET` | `/api/auth/me` | 当前资料 + 鉴权方式 + 到期时间 |
| `PATCH` | `/api/auth/me` | 改昵称 / 头像 |
| `POST` | `/api/auth/logout` | 登出（**无需鉴权**） |
| `GET` | `/api/health` | **无需鉴权**。存活探针 |

<details>
<summary><code>GET /api/auth/config</code> →</summary>

```jsonc
{
  "appName": "游戏语音室",
  "turnstileSiteKey": "0x4AAA…",
  "adminPath": "/dev",
  "maxRoomMembers": 10,
  "e2eeEnabled": true,
  "e2eeFallback": true,
  "audioBitrateKbps": 32,
  "adminLoginTurnstile": true,
  "crossOrigin": false
}
```
</details>

<details>
<summary><code>POST /api/auth/login</code> →</summary>

请求：
```jsonc
{
  "key": "访问 key",
  "nickname": "甲",              // 2–16 字符，中英文/数字/下划线/短横线/空格
  "avatarId": "bottts-01",       // 可选，12 个预设之一
  "turnstileToken": null         // 仅管理员 key 需要
}
```

响应（`SessionResult`）：
```jsonc
{
  "token": "eyJ…",
  "expiresAt": 1750000000,        // token 过期（Unix 秒）
  "sessionExpiresAt": 1752000000, // 会话绝对上限（Unix 秒）
  "role": "guest",
  "profile": { "uid":"…", "nickname":"甲", "role":"guest", "avatarId":"bottts-01", "avatarUrl":null }
}
```

注意：**昵称全局唯一**。已占用的昵称返回 `409 NICKNAME_TAKEN`；
管理员与访客的同名昵称互不通用。
</details>

<details>
<summary><code>PATCH /api/auth/me</code> →</summary>

```jsonc
// 请求（至少一个字段）
{
  "nickname": "乙",
  "avatarId": "lorelei-01",
  "avatarDataUrl": "data:image/webp;base64,…"   // 自定义头像，≤200KB
}
// 响应
{ "profile": { … }, "token": "eyJ…", "expiresAt": 1750000000 }
```
改名/换头像会**原地同步**到在线名册与所在房间，别人立刻看到新昵称。
</details>

### 5.2 房间

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/rooms` | 房间列表（含成员明细） |
| `POST` | `/api/rooms` | 创建房间 `{name, maxMembers?}` |
| `PATCH` | `/api/rooms/{id}` | 改名 / 调上限（房主或管理员） |
| `DELETE` | `/api/rooms/{id}` | 删除房间（房主或管理员） |
| `GET` | `/api/rooms/default` | 取默认房间 `home`（不存在则创建） |
| `GET` | `/api/rooms/{id}/snapshot` | 房间快照（权威状态） |
| `GET` | `/api/rooms/{id}/tracks` | 可订阅的轨道列表 |
| `POST` | `/api/rooms/{id}/join` | 进房 |
| `POST` | `/api/rooms/{id}/leave` | 退房 |
| `POST` | `/api/rooms/{id}/heartbeat` | HTTP 心跳，body `{roomId}` |
| `POST` | `/api/rooms/{id}/mute` | 上报静音，body `{muted}` |
| `POST` | `/api/rooms/{id}/ws-ticket` | 领 WebSocket 票 |

默认房间 id 是 `home`（`DEFAULT_ROOM_ID`），无需创建即可使用。

<details>
<summary><code>GET /api/rooms</code> →</summary>

```jsonc
{ "rooms": [ { "id":"home","name":"默认房间","ownerUid":null,
               "memberCount":2,"maxMembers":10,"createdAt":1,
               "members":[ { "uid":"…","nickname":"甲","avatarId":null,"avatarUrl":null,
                             "role":"guest","muted":false,"joinedAt":1,"lastSeen":2 } ] } ] }
```
</details>

<details>
<summary><code>GET /api/rooms/{id}/snapshot</code> →</summary>

```jsonc
{
  "room": { "id":"home","name":"默认房间","ownerUid":null,"memberCount":2,"maxMembers":10,"createdAt":1 },
  "members": [ { "uid":"…","nickname":"甲","avatarId":null,"avatarUrl":null,
                 "role":"guest","muted":false,"joinedAt":1,"lastSeen":2 } ],
  "version": 7
}
```
`version` 每次变更自增，可以拿它判断「是不是真变了」。
</details>

<details>
<summary><code>POST /api/rooms/{id}/join</code> →</summary>

```jsonc
{
  "snapshot": { … },      // 同 snapshot 接口
  "keyId": "uuid"         // 房间密钥 id（E2EE 用；轮换后会变）
}
```
房间满 → `409 ROOM_FULL`。
</details>

### 5.3 SFU 信令

这些接口把 Cloudflare Realtime SFU 包装成「不暴露 App Secret」的形式。
**参数与返回值与 SFU 官方一致**，只是鉴权换成了会话 token。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/rtc/publish` | 发布本地音频 |
| `POST` | `/api/rtc/subscribe` | 订阅一条远端轨道（单条） |
| `POST` | `/api/rtc/subscribe-batch` | 在一个接收会话上批量订阅（**推荐**） |
| `POST` | `/api/rtc/renegotiate` | 提交 SDP answer |
| `POST` | `/api/rtc/close` | 关闭轨道 |
| `POST` | `/api/rtc/usage` | 上报估算流量 |

<details>
<summary><code>POST /api/rtc/publish</code> →</summary>

```jsonc
// 请求：客户端已经 setLocalDescription(offer) 之后
{ "roomId":"home", "sdp":"v=0…", "trackName":"mic-u1", "mid":"0" }
// 响应
{ "sessionId":"…", "sessionDescription": { "type":"answer","sdp":"…" },
  "tracks":[ { "mid":"0","trackName":"mic-u1" } ] }
```
把 `sessionDescription` 交给 `setRemoteDescription` 即可。
</details>

<details>
<summary><code>POST /api/rtc/subscribe-batch</code> →</summary>

```jsonc
// 请求：sessionId 省略 = 新建接收会话；给了 = 在它上面追加订阅
{ "roomId":"home", "sessionId":"…", 
  "tracks":[ {"publisherSessionId":"…","trackName":"mic-u2"} ] }
// 响应
{ "sessionId":"…", "sessionDescription": { "type":"offer","sdp":"…" },
  "tracks":[ {"mid":"0","trackName":"mic-u2"} ] }
```
注意方向：**订阅**时 SFU 发的是 offer，客户端要 `createAnswer` 再调 `renegotiate`。
</details>

### 5.4 在线状态

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/presence/heartbeat` | 登记在线与所在房间 |
| `POST` | `/api/presence/poll` | 拉成员名册 + 取走新邀请 |
| `POST` | `/api/presence/leave` | 主动下线 |
| `POST` | `/api/presence/invite` | 邀请某人进房间 |
| `POST` | `/api/presence/kick` | 踢出服务器（**管理员**） |

"服务器" = 当前这个部署。保持心跳就算在线；离线名册只对管理员返回。

<details>
<summary><code>POST /api/presence/heartbeat</code> →</summary>

```jsonc
// 请求（全部可选）
{ "roomId":"home", "roomName":"默认房间", "status":"online", "invitable":true }
// status: online | busy | away | invisible
// 响应
{ "alive": true, "banned": false }
```

被移出服务器时返回 **`{"alive": false, "banned": true}`**（成功响应 + 标记）。
之所以不用 403：心跳是高频请求，客户端很容易把偶发的 403 当成网络抖动忽略掉，
于是被踢的人一直卡在界面里。看到 `banned: true` 就清本地会话并回登录。

建议每 15 秒一次。
</details>

<details>
<summary><code>POST /api/presence/poll</code> →</summary>

```jsonc
{
  "online":  [ { "uid":"…","nickname":"甲","role":"guest","avatarId":null,"avatarUrl":null,
                 "online":true,"status":"online","invitable":true,
                 "roomId":"home","roomName":"默认房间","lastSeen":2 } ],
  "offline": [],           // 仅管理员非空
  "invites": [ { "id":"…","fromUid":"…","fromNickname":"乙",
                 "roomId":"home","roomName":"默认房间","createdAt":1 } ],
  "serverTime": 1750000000
}
```
邀请是**取走即消费**：同一个邀请只会返回一次。建议每 6 秒轮询一次。
</details>

### 5.5 管理后台

先 `POST /api/admin/auth/login` 拿后台 token（见 2.6），然后：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/overview` | 实时概览（房间、成员、用量） |
| `GET` | `/api/admin/usage?days=7` | 用量看板（日聚合 + 实时 + 免费额度基线） |
| `GET` | `/api/admin/audit` | 审计查询（`nickname` / `event` / `from` / `to` / `page` / `pageSize`） |
| `GET` | `/api/admin/audit/export` | 导出 CSV（`text/csv`，带 BOM） |
| `POST` | `/api/admin/kick` | 踢出房间 `{roomId, uid, reason?}` |
| `POST` | `/api/admin/rooms/{id}/close` | 关闭房间（保留房间，清空成员） |
| `DELETE` | `/api/admin/rooms/{id}` | 彻底删除房间 |
| `PATCH` | `/api/admin/rooms/{id}` | 改名 `{name}` |
| `PATCH` | `/api/admin/rooms/{id}/limit` | 改人数上限 `{maxMembers}` |
| `POST` | `/api/admin/rooms/{id}/rotate-key` | 轮换房间密钥 → `{keyId}` |
| `GET` | `/api/admin/bans` | 封禁列表 |
| `POST` | `/api/admin/bans` | 新增封禁 `{kind:"ip"\|"nickname", value, reason?, durationMinutes?}` |
| `DELETE` | `/api/admin/bans/{id}` | 解除封禁 |
| `GET` | `/api/admin/users` | 已注册用户（最多 500） |
| `DELETE` | `/api/admin/users/{nickname}` | 释放昵称（昵称需 URL 编码） |
| `POST` | `/api/admin/flush` | 手动把缓冲落库到 D1 |
| `POST` | `/api/admin/auth/refresh` | 后台会话续期 |
| `POST` | `/api/admin/auth/logout` | 后台登出 |
| `GET` | `/api/admin/auth/me` | 后台身份 |

> **CSV 导出怎么在非浏览器客户端里用**：
> 请不要把 token 放进 URL —— 它会进服务器日志和浏览器历史。
> 正确做法：带 `Authorization` 头请求 `/api/admin/audit/export`，
> 把响应体按 `text/csv` 落盘（带 UTF-8 BOM，Excel 可直接打开）。

---

## 6. 媒体层：怎么和 SFU 对接

音频**不经过 Worker**，客户端直连 Cloudflare Realtime SFU。服务端只帮你保管
App Secret 并转发 SDP 交换。

### 6.1 发布自己的音频

```
1. getUserMedia({audio:true})                        → MediaStream
2. pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]})
3. pc.addTransceiver(track, {direction:'sendonly'})
4. offer = await pc.createOffer(); await pc.setLocalDescription(offer)
5. 等 ICE 收集完成（icegatheringstatechange === 'complete'）
6. POST /api/rtc/publish {roomId, sdp: pc.localDescription.sdp,
                          trackName: 'mic-<uid>', mid}
7. await pc.setRemoteDescription(response.sessionDescription)
8. 记下 response.sessionId —— 别人订阅你要用它
```

### 6.2 订阅别人的音频

```
1. GET /api/rooms/{id}/tracks                        → [{trackName, uid, sessionId, mid}]
2. POST /api/rtc/subscribe-batch {roomId, tracks:[{publisherSessionId, trackName}]}
   （第一次不带 sessionId；之后带上返回的 sessionId 复用同一接收会话）
3. await pc.setRemoteDescription(response.sessionDescription)   // 这是 offer
4. answer = await pc.createAnswer(); await pc.setLocalDescription(answer)
5. POST /api/rtc/renegotiate {roomId, sessionId, sdp: answer.sdp}
6. pc.ontrack → 拿到远端音频流，按 trackName 关联回 uid
```

### 6.3 必须遵守的三条硬约束

1. **同一个 session 上的变更必须串行** —— 一次 SDP 交换完成前不要发起下一次。
   用一个每 session 的 Promise 队列保证顺序。违反的表现是随机「听不到某人」。
2. **一个接收会话承载所有订阅**，不要每人一条 PeerConnection。
3. **关闭轨道用 mid，不是 trackName**。自己发布的轨道服务端能查出 mid；
   订阅侧的接收 mid 要由客户端提供（见 `POST /api/rtc/close` 的 `mids` 字段）。

### 6.4 E2EE（当前服务端只发 keyId）

`POST /api/rooms/{id}/join` 与 `key-rotated` 事件会给出 `keyId`。
**注意：当前版本只分发 keyId，房间密钥材料本身尚未实现下发**，
所以现在实际是纯 DTLS-SRTP 加密（`DESIGN.md` 第 11.3 节描述的目标状态尚未落地）。
写客户端时按「拿到 keyId 先存着」处理，等密钥分发协议定型后即可启用。

---

## 7. CORS 与跨域部署

默认情况下 `/api/*` **不返回任何 CORS 头** —— 只服务同源页面。
原生客户端、CLI、服务端调用不受影响（CORS 是浏览器特有的约束）。

要让**另一个域名的网页**能调，在 `wrangler.jsonc` 的 `vars` 里配置白名单：

```jsonc
"ALLOWED_ORIGINS": "https://app.example.com,https://www.example.com"
```

规则：

| 配置 | 行为 |
|---|---|
| 留空（默认） | 只服务同源；跨域网页全被浏览器拦下 |
| 具体 origin 列表 | 精确匹配才放行，**允许携带 Cookie**（回显该 origin） |
| `*` | 放行任意来源，但**不允许携带 Cookie**（CORS 规范禁止 `*` + credentials）→ 必须用 Bearer |

结论：**第三方网页客户端请一律用 Bearer**，不要指望 Cookie 跨站
（会话 Cookie 是 `SameSite=Lax`，跨站请求根本不会带上）。

---

## 8. 限流与审计

| 接口 | 限制 |
|---|---|
| `POST /api/auth/login` | 每 IP 每分钟 10 次 |
| 房间写操作（建房 / 改房 / 进房 / 邀请） | 每 IP 每分钟 240 次 |
| `POST /api/admin/auth/login` | 同一 IP 连续失败 5 次 → 锁定 15 分钟 |
| 心跳 / 快照 / 房间列表 | 不限流（但要自觉，别 1 秒打一次） |

被记录的审计事件：登录成功/失败、进房、退房、被踢、超时离线、后台登录、封禁。
IP 只存哈希与前两段，不存完整地址。

---

## 9. 写给浏览器客户端

浏览器是最省事的一类客户端，因为 Cookie 帮你兜住了鉴权：

```js
// 1. 登录（Cookie 自动种下）
await fetch('/api/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key, nickname })
});

// 2. 之后所有请求：带上 credentials 即可
const rooms = await fetch('/api/rooms', { credentials: 'include' }).then(r => r.json());

// 3. WebSocket 照样要领票（Cookie 也能用，但推荐统一走 ticket）
const { data } = await fetch('/api/rooms/home/ws-ticket', {
  method: 'POST', credentials: 'include'
}).then(r => r.json());
const ws = new WebSocket(data.wsUrl);
```

**建议**：即便在浏览器里也显式用 Bearer（登录响应里有 token）。
这样「网页能跑」就等价于「别的客户端也能跑」，不会出现只有浏览器才通的路径。

---

## 10. 写给原生 / CLI 客户端

### 10.1 直接照抄参考实现

`client/index.ts` 是零依赖的 TypeScript 实现，已经处理好了：登录、token 续期、
`X-Refreshed-Token`、WebSocket 领票与重连（指数退避）、心跳（优先走 socket）、
在线状态轮询、错误分类。Node / Bun / Deno 可直接跑，浏览器 / React Native 也能用
（注入 `fetchImpl` / `webSocketImpl` 即可）。

```ts
import { VoiceRoomClient } from './client/index';

const client = new VoiceRoomClient({ baseUrl: 'https://ts.futurvo.cc' });

client.on('snapshot', (snap) => console.log('成员变化', snap.members));
client.on('kicked', (e) => console.log('被踢', e.reason));
client.on('sessionExpired', () => console.log('需要重新登录'));

await client.login({ key: '…', nickname: '甲' });
await client.joinRoom('home');       // 自动连 WebSocket、跑心跳
// …做你的媒体与 UI…
await client.leaveRoom();
await client.logout();
client.dispose();
```

### 10.2 用别的语言实现时的检查清单

| 检查项 | 为什么 |
|---|---|
| 登录响应里的 token 与 `expiresAt` 都存下来 | 否则无法提前续期 |
| 每个响应都看 `X-Refreshed-Token` | 滚动续期只有这个头 |
| 区分 `UNAUTHORIZED` 与 `SESSION_EXPIRED` | 前者可能只是没登录，后者必须清会话回登录 |
| WebSocket 每次重连都重新领票 | 票是单次有效的 |
| 心跳 15 秒一次，断了自动重连 + 指数退避 | 45 秒没信号会被判离线回收 |
| 心跳响应里的 `banned: true` 要处理 | 被踢的人否则会一直卡在界面里 |
| 收到 `kicked` / `room-closed` 要**停止重连** | 否则会无限打服务端 |
| `tracks/close` 传 mid 不传 trackName | 服务端只认 mid |
| 同一 session 的 SDP 变更串行化 | 否则随机听不到人 |

---

## 11. 变更与兼容性承诺

- `/api/*` 路径不会在 1.x 内做破坏性变更。
- 新增字段是允许的，客户端请**忽略未知字段**而不是报错。
- 错误文案（`error`）可能随时改；`code` 视为稳定契约。
- 新增错误码是允许的，客户端遇到未知 `code` 请按 HTTP 状态码兜底。

**已知的将来变更**：

1. 房间密钥材料的下发（E2EE 真正落地）会新增字段与事件载荷。
2. 兼容用的 Cookie 版 WebSocket 路径（`GET /api/rooms/{id}/ws`）保留，
   但新客户端请只用 ticket 路径。

---

## 附：一句话总结

> 拿 key 换 token → 带 token 调 `/api/*` → 领票连 WebSocket → 15 秒一次心跳 →
> 收到 `room-changed` 就拉快照 → 音频用原生 WebRTC 直连 SFU，
> 信令走 `/api/rtc/*`。
