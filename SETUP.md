# 配置填写清单

你需要填写的**只有 2 个文件**。全部完成后即可开始开发。

---

## 一、配置项说明（已完成，留档参考）

配置已全部填好，本节仅作说明用途。

### `.dev.vars` —— 密钥（不会提交到 git）

| 变量名 | 从哪获取 | 备注 |
|---|---|---|
| `REALTIME_SFU_APP_ID` | [SFU 控制台](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Frealtime%2Fsfu) → Create application | 创建后立即复制 |
| `REALTIME_SFU_BEARER_TOKEN` | 同上 | ⚠️ **只显示一次**，关页面就没了 |
| `GUEST_KEY` | 自动生成随机 UUID | 发给朋友用 |
| `ADMIN_KEY` | 自动生成随机 UUID | ⚠️ 泄漏 = 后台失守 |
| `SESSION_SECRET` | 自动生成随机 UUID | ⚠️ 更换会导致全员掉线 |
| `TURNSTILE_SECRET_KEY` | 当前为官方测试 key | 部署前必须换真实值 |

后两项（`CF_ANALYTICS_API_TOKEN` / `CF_ACCOUNT_ID`）**留空**，不影响核心功能。

### `wrangler.jsonc` —— 2 个值

| 位置 | 状态 |
|---|---|
| `d1_databases[0].database_id` | ✅ 已填（D1 已创建） |
| `vars.TURNSTILE_SITE_KEY` | ✅ 已填测试 key |

---

## 二、当前配置状态（已完成）

本地开发所需配置已**全部填写完毕**：

| 项 | 状态 | 值来源 |
|---|---|---|
| `REALTIME_SFU_APP_ID` | ✅ 已填 | 你自行填写 |
| `REALTIME_SFU_BEARER_TOKEN` | ✅ 已填 | 你自行填写 |
| `GUEST_KEY` | ✅ 已填 | 自动生成随机 UUID |
| `ADMIN_KEY` | ✅ 已填 | 自动生成随机 UUID |
| `SESSION_SECRET` | ✅ 已填 | 自动生成随机 UUID |
| `TURNSTILE_SECRET_KEY` | ✅ 已填 | 官方测试 key（总是通过） |
| D1 `database_id` | ✅ 已填 | `wrangler d1 create` 创建 |
| `TURNSTILE_SITE_KEY` | ✅ 已填 | 官方测试 key |

> ⚠️ **部署前唯一要改的**：把 Turnstile 的两个测试 key 换成真实 widget 的 key。
> 生产 secret key 会拒绝测试 token，不换会导致后台登录一直失败。

### 不用你管的文件

| 文件 | 状态 |
|---|---|
| `.gitignore` | ✅ 已生成，敏感文件全部排除 |
| `config.yml` | ✅ 已填好默认值，想调再改 |
| `.dev.vars.example` | ✅ 可提交的纯模板 |
| `config.example.yml` | ✅ 可提交的纯模板 |
| `wrangler.jsonc` | ✅ D1 id 与 sitekey 已填 |
| `DESIGN.md` | ✅ 设计文档 |

---

## 三、验证结果

已实测确认 git 隔离正确：

```
.dev.vars          → IGNORED ✓ （不会提交）
config.yml         → IGNORED ✓ （不会提交）
.dev.vars.example  → tracked   （会提交，纯模板）
config.example.yml → tracked   （会提交，纯模板）
wrangler.jsonc     → tracked   （会提交，无敏感值）
```

D1 数据库已创建：

| 项 | 值 |
|---|---|
| 名称 | `cf-teamspeed` |
| database_id | `ea808fe4-74e0-43d6-89ce-b86cd3d768fb` |
| 区域 | WNAM |

Account ID：`9370e7f7ba4b38a57ffe6d4ebc6acec4`

---

## 四、已完成的准备流程

以下步骤均已执行完毕，留档供参考：

```bash
# 1. 登录 Cloudflare
wrangler login
wrangler whoami          # profile: sfu, futurvo@outlook.com

# 2. 创建 D1 数据库
wrangler d1 create cf-teamspeed
# → database_id: ea808fe4-74e0-43d6-89ce-b86cd3d768fb

# 3. 生成三个自定义密钥
node -e "console.log(crypto.randomUUID())"   # GUEST_KEY
node -e "console.log(crypto.randomUUID())"   # ADMIN_KEY
node -e "console.log(crypto.randomUUID())"   # SESSION_SECRET

# 4. SFU 应用（手动创建，见下方注意事项）
#    https://dash.cloudflare.com/?to=%2F%3Aaccount%2Frealtime%2Fsfu
```

### ⚠️ 注意事项：SFU 应用无法用命令行创建

`wrangler` 的 OAuth token **没有 `calls` 权限**，所以无法通过命令行调用 SFU API：

```
curl -H "Authorization: Bearer <wrangler token>" \
  https://api.cloudflare.com/client/v4/accounts/<id>/calls/apps
# → {"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}
```

SFU 应用**只能**从 Dashboard 手动创建，或使用单独的账户级 API Token。

---

## 五、关于 Turnstile 的「域名」——不用去建 DNS 记录

创建 widget 时会让你填 **Hostname**，这里容易卡住。先说结论：

> **不需要为此去建 DNS 记录，也不需要先注册域名。直接填 `localhost` 就行。**

### 为什么

Turnstile 的 hostname **不是所有权声明**，而是一份**白名单**——限制「只允许来自这些 hostname 的请求通过验证」。

判定依据：

1. 官方文档明确写着 *"Turnstile is designed to be an independent service. You can use Turnstile on any website, **regardless of whether it is proxied through the Cloudflare network**."*
2. 官方 API 示例的 `domains` 数组里可以填 **IP 地址**（`"203.0.113.1"`）。
   如果要求域名所有权验证，IP 是不可能填得进去的。

### 开发阶段的最省事做法：用官方测试 key

Turnstile **没有"开发模式"开关**，但官方提供了恒定的测试 key。
开发阶段直接用它们，连 widget 都不用建：

| 行为 | Site Key | Secret Key |
|---|---|---|
| **总是通过**（推荐开发用） | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| 总是拦截 | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |
| 强制弹交互框 | `3x00000000000000000000FF` | `3x0000000000000000000000000000000AA` |

对照填入：

- `.dev.vars` → `TURNSTILE_SECRET_KEY`
- `wrangler.jsonc` → `vars.TURNSTILE_SITE_KEY`

> ⚠️ 生产环境的 secret key 会**拒绝**这些测试 token。
> 所以上线前必须换成真实 widget 的 key。

### 有域名时的正确顺序

⚠️ 注意：**Custom Domain 要求域名已托管在 Cloudflare**，这是 Workers 路由的要求，
和 Turnstile 无关。所以顺序是：

```
1. 域名接入 Cloudflare（NS 改到 CF 给的两个地址）
   ↓  等 DNS 生效（几分钟到几小时）
2. 部署 Worker，绑 Custom Domain
   ↓  得到 voice.example.com
3. 回 Turnstile，把 hostname 从 localhost 改成 voice.example.com
   ↓  保存，立即生效
```

第 3 步随时可改：Dashboard → Turnstile → 选中 widget → **Settings** → 改 → **Save**。

### 顺带说明：不买域名也能跑

Cloudflare Worker 自带 `<name>.<account>.workers.dev` 子域名，开箱可用。

⚠️ 但 `workers.dev` 在部分网络环境下访问不稳定。如果主要在国内使用，
建议绑定自有域名。这个决定可以推迟到**部署阶段**。

---

## 六、填完之后

告诉我一声，我会：

1. 检查配置是否完整（只读文件名和键名，不读密钥值）
2. 生成 `workers/app.ts` 等 M1 阶段的代码
3. 跑起来让你验证

### 你唯一需要告诉我的

- **D1 的 `database_id`**（可以直接贴，非敏感）

其余密钥你自己填进 `.dev.vars` 就行，**不需要给我**。

---

## 七、遇到问题？

| 现象 | 处理 |
|---|---|
| `wrangler login` 打不开浏览器 | 终端会打印一个 URL，手动复制到浏览器打开 |
| 找不到 SFU 入口 | 确认账号已开通 Realtime；免费版即可，无需付费 |
| Turnstile 创建时让填域名 | **填 `localhost`**，详见第五节 |
| Turnstile 提示域名无效 | 只填域名本身，不带 `https://`、不带路径、不带端口 |
| `wrangler d1 create` 报权限错误 | 确认 `wrangler whoami` 正常，且账号有 Workers 权限 |
