# cf-teamspeed 桌面端（WinUI 3）

原生 Windows 客户端，**不使用 WebView**。与 Web 端功能对等，只有一处结构性差异：

> **最左侧多一列「服务器栏」** —— Web 端一个部署就是一台服务器（`host` 即服务器地址），
> 桌面端可以**同时挂多台服务器**，各自独立登录、独立会话。

---

## 四栏布局

```
┌──────┬──────────────┬───────────────────────┬───────────────┐
│ 服务器 │ 房间列表      │ 房间内容               │ 服务器成员     │
│ 72px │ 248px        │ flex-1                │ 240px         │
│      │              │                       │               │
│ [A]  │ 房间 A  2/10 │  房间标题 + 人数        │ 在线 — n       │
│ [B]  │ 房间 B  0/10 │                       │  [头像] 昵称    │
│ [C]  │ + 新建房间    │  [ 静音 · 状态 · 离开 ] │ 离线 — n       │
│  +   │              │                       │               │
│  ⚙   │ [自己账号卡片] │                       │               │
└──────┴──────────────┴───────────────────────┴───────────────┘
   ↑
   Web 端没有这一栏（一个部署 = 一台服务器）
```

---

## 多服务器：设计要点

### 一台服务器 = 一份完全独立的凭据

| 数据 | 是否跨服务器共享 |
|---|---|
| `baseUrl` | ❌ 每台不同 |
| `key`（访客 / 管理员） | ❌ 每台部署的 key 不同 |
| 会话 `token` | ❌ **绝不能复用** —— A 的 token 打到 B 上必然 401 |
| 昵称 / 头像 | ❌ 各服务器独立注册（昵称在**各自服务器内**全局唯一） |
| 音量 / 界面偏好 | ✅ 本地通用 |

因此 `ApiClient` 是**实例级**的（一台服务器一个），
不允许出现任何 `static string currentToken` 之类的全局凭据 —— 那必然串号。

### 会话失效的粒度

401 / `SESSION_EXPIRED` / `BANNED` **只影响出事的那一台**：
清掉该服务器的 token，让「这一个」图标提示重新登录，其它服务器完全不受影响。

### 服务器显示名

`GET /api/auth/config` 是**公开接口**，返回 `appName`。
因此添加服务器时可以**免登录**拉到人类可读的名字，并顺带当作可达性探测
（失败则提示「无法连接」）。`GET /api/health` 可作更轻量的探测。

---

## 后端是否需要改动

**不需要。** 现有 API 已经是「按服务器自包含」的：
每台部署各自有独立的 D1、独立的四个 Durable Object、独立的 key 与 `SESSION_SECRET`，
并且 `client/index.ts` 的 `new VoiceRoomClient({ baseUrl })` 本来就是一实例一服务器、
没有任何全局状态。

多服务器**纯粹是客户端的数据模型问题**：本地持久化一个
`List<ServerProfile>{ 显示名, baseUrl, key, token }`，每项跑一个独立会话即可。
没有跨服务器的协调需求（没有联邦、没有全局身份），因此不存在需要新增的服务端接口。

---

## 构建

### 前置

- .NET SDK 10
- Windows 10 SDK（`Windows Kits\10`，XAML 编译器需要 facade winmd）
- VS 2022/2026 的 MSVC 工具集（XAML 编译器需要 `vcmeta.dll`）

### 命令

```powershell
# 平台必须显式指定：WindowsAppSDKSelfContained=true 时
# Windows App SDK 的 targets 会校验平台，AnyCPU 直接报错。
dotnet restore desktop/CfTeamspeed.Desktop/CfTeamspeed.Desktop.csproj -p:Platform=x64
dotnet build   desktop/CfTeamspeed.Desktop/CfTeamspeed.Desktop.csproj -p:Platform=x64

# 运行
desktop/CfTeamspeed.Desktop/bin/x64/Debug/net10.0-windows10.0.19041.0/win-x64/CfTeamspeed.Desktop.exe
```

> **实测**：在完全断网的环境下，`restore` + `build` 均通过，**0 error / 0 warning**，
> 产物为自包含 exe（282 KB）+ Windows App SDK 运行时（共 519 个文件）。

### 部署形态：自包含 + 非打包

```
WindowsAppSDKSelfContained = true    运行时 DLL 随应用发布，不依赖 MSIX
WindowsPackageType        = None     非打包，双击 exe 即可运行
```

WinRT 类型靠 **exe 内嵌清单**里的 `winrtv1:activatableClass` 注册表激活
（构建时由 UndockedRegFreeWinRT 生成，约 1500 条）。这也是为什么
`Program.cs` 里**不能**调用 `Bootstrap.TryInitialize` —— 见下方踩坑记录。

---

## 排查记录（都是实测踩过的，改前先读）

### 1. 启动即静默退出，没有任何报错

**症状**：进程启动后立刻结束，退出码 `0xC0000142`（`STATUS_DLL_INIT_FAILED`），
无窗口、无日志、事件查看器里也没记录。

**原因**：在自包含模式下调用了 `Bootstrap.TryInitialize`。它会去找机器上
**已安装的 Windows App Runtime 框架包**，机器上没装就直接把进程带走。

**修复**：不要调用它。自包含 + 非打包走的是 app-local DLL + 内嵌清单，
本来就不需要 Bootstrap。

### 2. 启动弹「初始化失败」（跨线程访问 UI）

**症状**：窗口出来了，但立刻弹「初始化失败」；日志里是
`COMException (0x8001010E)`（`RPC_E_WRONG_THREAD`），堆栈指向某个 `set_Text`。

**原因**：窗口构造函数里 `_ = InitializeAsync()` 是即发即忘的，而
`ServerManager` 内部大量 `ConfigureAwait(false)`（库代码的正确写法），
于是续体落在**线程池线程**上，此时去改 XAML 控件就会抛这个异常。
错误文案里既没有「跨线程」也没有「UI」，只有一句 COM 失败，极难定位。

**修复**（两处，缺一不可）：

- `ServerManager` 暴露 `Dispatcher` 属性，所有对外事件统一经
  `RaiseOnUi()` 切回 UI 线程再触发 —— 订阅方不必人人写一遍；
- `MainWindow.InitializeAsync` 用 `DispatcherQueue.EnqueueAsync()`
  把界面更新显式排队到 UI 线程。

> 顺带一个更隐蔽的坑：`ServerSession.SyncFromStore()` 曾经用
> `_store.GetAsync(Id).GetAwaiter().GetResult()` 同步等待异步。
> 那是在 UI 线程上做 sync-over-async，会**死锁**。现已改为
> 「谁改谁负责同步内存档案」（`ApplyCredentialPatch`），不再回头读磁盘。

### 3. ContentDialog 抛「This element does not have a XamlRoot」

**原因**：窗口的内容还没进可视化树就弹对话框。

**修复**：所有对话框统一走 `MainWindow.ShowDialogAsync()`，
它会等 `RootGrid.Loaded`（带 5 秒超时兜底）再 `ShowAsync`。

### 4. 服务器栏（最左一列）是空的

**原因**：漏了 `ServerRailControl.Attach(_manager)`。控件不会自己去找数据源。

**修复**：在窗口构造与初始化完成两处都 Attach 一次（初始化期间的
`ServersChanged` 可能早于 `Dispatcher` 注入，所以补一次强制重建）。

### 5. XAML 编译器只报「已退出，代码为 1」，不给文件名行号

**症状**：`MSB3073: XamlCompiler.exe 已退出，代码为 1`，其他什么都没有。

**原因**：Pass2 拿不到「中间程序集」时就会这样 —— 而中间程序集编译失败的
原因通常被吞掉了。实测两种触发方式：

- C# 代码有错（先修 C# 编译错误，Pass2 自然就好了）；
- 给控件设了**它根本没有的属性**。

**已踩到的具体例子**：`PasswordBox` **没有** `PlaceholderForeground`
（那是 `TextBox` 独有的）。加上它就会让 Pass2 直接失败，且日志里只有那一句。
`Themes/Controls.xaml` 里已留注释警告。

**排查手法**：`obj/<platform>/<tfm>/<rid>/output.json` 里其实有
`MSBuildLogEntries`，Pass1 的每个阶段都在（能看到 `perfXC_EndPass1`），
据此可判断「Pass1 过了、卡在 Pass2」还是「Pass1 就挂了」。
也可以把 `Themes/*.xaml` 逐个删掉二分定位。

### 6. `%LOCALAPPDATA%` 不可写时应用起不来

**原因**：`servers.json` / `settings.json` 写在 `%LOCALAPPDATA%\CfTeamspeed`，
受限账户或沙箱环境里这个目录可能存在但不可写；旧代码只判「目录存在」，
于是后续所有落盘都失败（表现为「设置改了不生效」「每次启动都要重新登录」）。

**修复**：`AppPaths.DataDirectory` 依次试写三个候选位置，取第一个真正可写的：

1. `%LOCALAPPDATA%\CfTeamspeed`
2. 环境变量 `CFTEAMSPEED_DATA_DIR`（测试 / 便携部署用）
3. `<应用目录>\data`

### 7. 本机 Schannel 损坏导致 `dotnet restore` 全失败

**症状**：`NU1301: 无法加载源 https://api.nuget.org/v3/index.json`，
内层是 `SEC_E_NO_CREDENTIALS`；`curl` / `Invoke-WebRequest` 也一样。
但**纯 HTTP 正常**，说明网络与代理都没问题，坏的是 Windows 的 TLS 凭据层。

**绕法**：**Node.js 走 OpenSSL，不受 Schannel 影响**，用它下载包即可。

```powershell
node -e "
const https=require('https'),fs=require('fs');
const [,,id,ver]=process.argv;
const url='https://api.nuget.org/v3-flatcontainer/'+id+'/'+ver+'/'+id+'.'+ver+'.nupkg';
const out='.dotnet-home/local-feed/'+id+'.'+ver+'.nupkg';
(function go(u,n){https.get(u,r=>{
  if([301,302,303,307,308].includes(r.statusCode)&&r.headers.location)
    return r.destroy(),go(new URL(r.headers.location,u).toString(),n+1);
  r.pipe(fs.createWriteStream(out)).on('finish',()=>console.log('saved',out));
}).on('error',e=>console.error('FAIL',e.message));})(url,0);
" microsoft.windows.sdk.net.ref 10.0.19041.57
```

> 注意：本机访问 nuget.org 会被 302 重定向到 `nuget.azure.cn`
> （国内镜像），上面的脚本会跟着重定向走。

### 离线包清单

`desktop/NuGet.config` 清空了所有内置源，只用仓库内（或本机）的本地包目录。
需要这些包：

| 包 | 作用 |
|---|---|
| `Microsoft.WindowsAppSDK` | WinUI 3 本体（含 9 个组件子包） |
| `Microsoft.Windows.SDK.NET.Ref` | `Windows.*` 的 C#/WinRT 投影。**版本必须与 TFM 匹配**：`net10.0-windows10.0.19041.0` → `10.0.19041.57` |
| `Microsoft.NETCore.App.Ref` / `Microsoft.WindowsDesktop.App.Ref` | 目标框架引用包 |
| `Microsoft.NETCore.App.Runtime.win-x64` 等 3 个 | 自包含运行时（`SelfContained=true` 时需要） |
| `Microsoft.Windows.SDK.BuildTools` | `makepri.exe` / `mt.exe` |

从本机 NuGet 缓存快速收集：

```powershell
Get-ChildItem "$env:USERPROFILE\.nuget\packages" -Recurse -Filter *.nupkg |
  Copy-Item -Destination .dotnet-home\local-feed
```

> 目标框架引用包（`Microsoft.NETCore.App.Ref` 等）不在 NuGet 缓存里，
> 它们在 `C:\Program Files\dotnet\packs\` 下。离线场景需要把它们
> 打包成 nupkg 放进 local-feed（脚本见本仓库提交记录）。

---

## 人机验证（Cloudflare Turnstile）

### 为什么这里必须用 WebView2

Turnstile 的 token 由 Cloudflare 的 JS 在**真实浏览器环境**里算出来，
服务端再拿它去 `POST /turnstile/v0/siteverify` 校验。
官方**没有** REST 接口、也**没有**原生 SDK ——
除了让一个浏览器引擎执行那段 JS，没有第二条路能拿到合法 token。

这和「用 WebView 套壳整个应用」是两回事：

| | 本项目的用法 |
|---|---|
| 触发时机 | **仅**「管理员 key 登录 + 服务端要求验证」时弹出 |
| 加载内容 | 只 `NavigateToString` 一张内存里的本地 HTML，**不导航到任何站点** |
| 生命周期 | 拿到 token 立即关闭，窗口不驻留 |
| 能力 | 关右键菜单 / 关 DevTools / 关自动填充 / 禁新窗口 / 禁宿主对象 |
| 应用主体 | 大厅、房间、设置**全部**是原生 WinUI，与 WebView 无关 |

访客 key 登录**永远不需要**验证，走不到这段代码。

### 交互设计：验证对所有身份都必需

服务端对**访客与管理员一视同仁**，登录一律要求人机验证 ——
客户端因此**每次登录都会弹出验证窗口**，不再区分身份。

登录框里仍保留「以管理员身份登录」勾选框，但它**不控制是否验证**，
只是提醒用户「我这次填的是管理员 key」（权限更高，改名/踢人等）。
早先的设计里它才是验证开关，那个前提（"只有管理员要验"）已经不成立。

是否需要验证由服务端 `GET /api/auth/config` 的 `loginTurnstile` 决定
（默认 `true`）。部署方把它设为 `false` 时，客户端会自动跳过验证窗口。

### ★ 真实 sitekey 必须让页面跑在服务器域名下（踩过的大坑）

**症状**：验证窗口里显示 Cloudflare 的错误框「无法连接到网站 / 故障排除」，
底部错误码 `110200`，并且窗口状态栏写着「验证失败，请重试」。

**误导之处**：`110200` 的文案是「无法连接到网站」，很容易被当成网络问题去排查。
**它其实是「域名不被允许」** —— 一个纯粹的配置问题，重试一万次也不会成功。

**根因**：Turnstile 会拿 `window.location.hostname` 去比对 widget 配置里的
域名白名单。而桌面端原先用 `NavigateToString` 加载承载页，页面 origin 是
`about:blank` —— **永远不可能**匹配任何白名单域名。

> 用官方测试 sitekey（`1x0000…AA`）时不会暴露这个问题，因为它不做域名校验。
> 一旦换成真实 sitekey 就必然失败。这也是为什么自检当时「能过」而实际登录不能。

**修复**：把承载页挂到**服务器域名**的虚拟主机下再导航过去：

```csharp
core.SetVirtualHostNameToFolderMapping(
    originHost,                       // 例如 ts.futurvo.cc
    localDir,                         // HTML 仍来自本地，不产生网络请求
    CoreWebView2HostResourceAccessKind.DenyCors);

core.Navigate($"https://{originHost}/index.html");
```

WebView2 会把该虚拟主机的 origin 报成 `https://ts.futurvo.cc`，
Turnstile 的域名校验随之通过，而文件完全来自本地磁盘。

实测（真实 sitekey + 真实域名）：

```
origin host for turnstile = ts.futurvo.cc
navigated via virtual host https://ts.futurvo.cc/index.html
NavigationCompleted: success=True http=200
outcome success=True
success tokenLength=794 prefix=1.uQxaLUaNR5…
```

`tokenLength=794`、前缀形如 `1.uQxaLUaNR5…` 是**真实 token** 的格式
（测试 key 给的是固定的 `XXXX.DUMMY.…`），说明确实走通了真实校验。

**部署前提**：该域名必须已加入 Turnstile widget 的允许域名列表。
没加的话仍然会报 `110200`，此时窗口会明确提示「该域名未被 Cloudflare
Turnstile 允许，请到控制台把它加入允许列表」—— 而不是含糊地说「网络不好」。

### 自检用法

人机验证是「能否登录」的硬前提。如果它只能靠人肉点界面来确认，
坏了就没有任何确定的排查手段。所以内置一个自检入口：

```powershell
# 测试 key（不校验域名，只能验证「渲染链路」是否通）
CfTeamspeed.Desktop.exe --turnstile-selftest

# 真实 key + 真实域名（完整链路，能测出域名白名单问题）
CfTeamspeed.Desktop.exe --turnstile-selftest 0x4AAAAAAA... --origin https://ts.example.com
```

它不开主窗口，只跑一次验证，把过程写进
`%LOCALAPPDATA%\CfTeamspeed\turnstile.log`，并输出 token 长度与前缀
（**不打印完整 token** —— 那是凭据）。退出码 0 = 拿到 token。

### 实测结果：可用（已跑通）

`--turnstile-selftest` 在 Windows 桌面会话下**完整跑通**，实测日志：

```
[turnstile] EnsureCoreWebView2Async 返回, CoreWebView2=ok
[turnstile] navigated (page 4627 bytes)
[turnstile] DOMContentLoaded
[turnstile] NavigationCompleted: success=True
[turnstile-selftest] outcome success=True error=
[turnstile-selftest] success tokenLength=21 prefix=XXXX.DUMMY.T…
```

`XXXX.DUMMY.…` 是 Cloudflare 官方测试 sitekey 的标准 token 格式，
说明 **WebView2 加载 → Cloudflare 脚本执行 → 组件渲染 → 回调拿到 token**
整条链路都是通的。用 `3x00000000000000000000FF`（强制交互式挑战）
可肉眼确认组件确实渲染出了「请验证您是真人」的卡片。

> ⚠️ **一个曾经误判、值得记下的坑**：
> 中途曾观察到 `E_UNEXPECTED (0x8000FFFF)`，当时判断为「沙箱里 Chromium 起不来」。
> **那个判断是错的。** 真正原因是**上一次运行残留的进程锁住了 exe**，
> 导致 Build 复制失败、启动的是半新半旧的程序集。
> 杀掉残留进程后一次通过。
>
> 教训：`dotnet build` 报 `MSB3027 文件被锁定` 时，不要忽略它继续跑，
> 更不要据此推断运行时不兼容 —— 先 `Stop-Process -Name CfTeamspeed.Desktop`。

### 失败态的处理

WebView2 起不来时（缺运行时 / 被安全策略拦截），窗口**不会自动关闭**，
而是留在原地显示原因 +「重试」按钮。这一点很重要：
早先的实现在失败时立刻关窗，用户只看到「闪一下」，
完全不知道为什么、也不知道该怎么办。

失败原因按 HRESULT 区分，给出不同指引：

| 错误码 | 含义 | 提示 |
|---|---|---|
| `0x80070002` | 找不到运行时 | 装 Microsoft Edge WebView2 Runtime |
| `0x80070005` | 拒绝访问 | 安全软件 / 企业策略拦截了浏览器进程 |
| 其它 | 未知 | 带错误码，并提示可改用访客 key |

> 注意 `0x8000FFFF` 的异常 `Message` 常常是**空字符串**，
> 所以 `Diag` 必须把 `HResult` 一起记录，否则等于什么都没说。

### 渲染看门狗：一个容易写错、后果严重的地方

「渲染成功」与「验证完成」是**两件事**。Managed 模式的验证需要用户
自己去看窗口、点复选框，经常要十几秒。

如果用一个固定的 15 秒定时器判「超时 → 失败」，它会在用户**还在操作时**
就把界面改成错误态、收起加载遮罩 —— 用户以为自己失败了就去点取消，
一次本来能成功的验证就此丢掉。

正确做法（已实现）：

- `iframe` 一出现就立刻**停表**（组件已正常渲染），此后无论用户花多久都不判超时；
- 只有「30 秒内始终没渲染出来」才判定加载失败；
- Cloudflare 的 300xxx / 600xxx 系列是**可重试**错误，回调可能多次触发，
  因此只提示「正在自动重试」而不判死，避免界面在失败/成功之间来回闪。

---

## 目录结构

```
desktop/
├── NuGet.config                       # 离线包源
├── .gitignore
├── README.md                          # 本文件
└── CfTeamspeed.Desktop/
    ├── CfTeamspeed.Desktop.csproj     # 平台/自包含/自定义入口点都在这里
    ├── app.manifest                   # DPI 感知 / 非打包自包含
    ├── Program.cs                     # ★ 自定义入口点（不可用自动生成的 Main）
    ├── DispatcherQueueExtensions.cs   # await 友好的「切回 UI 线程」
    ├── App.xaml(.cs)                  # 应用入口 + 全局异常兜底
    ├── MainWindow.xaml(.cs)           # ★ 四栏外壳 + 对话框 + 轻提示
    ├── Models/
    │   ├── ApiModels.cs               # 所有 DTO + 错误码
    │   └── ServerProfile.cs           # ★ 多服务器模型 + 持久化（ServerStore）
    ├── Services/
    │   ├── ApiClient.cs               # ★ 实例级 HTTP 客户端（一台服务器一个）
    │   ├── ApiException.cs
    │   ├── AppPaths.cs                # 数据目录解析 + 原子写
    │   ├── AppSettings.cs             # 本地偏好（跨服务器通用）
    │   ├── ServerSession.cs           # ★ 单台服务器的会话（心跳/轮询/续期）
    │   └── ServerManager.cs           # ★ 多服务器总控（增删切换 + UI 线程事件）
    ├── Themes/
    │   ├── Colors.xaml                # 色板（深浅色 + 高对比）
    │   ├── Brushes.xaml               # 由颜色派生的画刷
    │   └── Controls.xaml              # 控件样式与模板
    └── Controls/
        ├── ServerRail.xaml(.cs)       # ★★ 最左侧服务器栏（Web 端没有这一栏）
        ├── RoomSidebar.xaml(.cs)      # ② 房间列表 + 语音状态 + 自己的账号
        ├── RoomView.xaml(.cs)         # ③ 房间内容（总览卡片 / 房间内成员）
        └── MemberRail.xaml(.cs)       # ④ 服务器成员（在线/离线 + 右键操作）
```

---

## 当前完成度

### 已经跑通并实测

- ✅ 离线构建（0 error / 0 warning），自包含 exe 可直接运行
- ✅ 四栏布局渲染正常，深浅色跟随系统
- ✅ **多服务器栏**：图标、选中态、状态点、Tooltip、右键菜单、添加/设置按钮
- ✅ 服务器档案持久化（原子写、坏档案自动备份重建、去重、排序）
- ✅ 每台服务器独立会话：15s 心跳、6s 名册轮询、8s 房间刷新、临期自动续期
- ✅ 登录对话框（地址预填、key、昵称、错误码翻译成可照做的提示）
- ✅ 401 / SESSION_EXPIRED / BANNED 都只影响「出事的那一台」
- ✅ 滚动续期（读 `X-Refreshed-Token`）
- ✅ **人机验证**：**每次登录都要验证**（访客与管理员一视同仁）——
  按需弹出 WebView2 承载的 Turnstile，拿到 token 自动继续登录；
  `--turnstile-selftest` **实测已跑通拿 token**
- ✅ Turnstile 失败时不关窗，保留原因与「重试」按钮；按 HRESULT 给不同指引

### 尚未实现（下一步）

- ⬜ **音频链路**：`getUserMedia` 采集、SFU 发布/订阅、`RTCRtpScriptTransform` E2EE
  —— 目前进房只做 HTTP 登记，**还没有声音**
- ⬜ WebSocket 事件流（`/ws-ticket` + 重连 + 指数退避）
- ⬜ 音量控制 / 降噪 / 语音门限（网页端 `audio-mixer` / `denoise` 那一整套）
- ⬜ 管理员后台（用量看板、审计、封禁）
- ⬜ 头像图片加载（当前用昵称派生的首字底色，未拉取预设 SVG）
- ⬜ 窗口位置记忆（当前只记尺寸）

> 说明：音频是本项目**最重的一块**，网页端对应实现约 1000 行
> （`room-controller` + `sfu-session` + `audio-mixer` + `denoise`）。
> 本步先把「多服务器骨架 + 全部网络与状态逻辑」做扎实，
> 音频作为独立能力叠加在其上，避免两者互相拖累。

---

## 与 Web 端的行为对齐

| 行为 | 间隔 / 说明 |
|---|---|
| 房间心跳 | 15s（`POST /api/rooms/{id}/heartbeat`） |
| presence 心跳 | 15s |
| presence 轮询 | 6s（同时取走新邀请） |
| 房间列表刷新 | 8s |
| token 续期 | 临期 5 分钟内主动 refresh；另外任何响应都可能带 `X-Refreshed-Token` |
| WebSocket | 先 `POST /api/rooms/{id}/ws-ticket` 领**一次性**票据，再连 `wsUrl`；每次重连都要**重新领票**（指数退避）⬜ 待实现 |
| SFU | 同一 `sessionId` 上的 SDP 变更**必须串行**，否则会随机「听不到某人」⬜ 待实现 |

### 客户端检查清单（来自 docs/API.md 第 10.2 节）

- [x] 登录响应的 `token` 与 `expiresAt` 都存下来（否则无法提前续期）
- [x] 每个响应都看 `X-Refreshed-Token`
- [x] 区分 `UNAUTHORIZED` 与 `SESSION_EXPIRED`
- [x] 心跳 15s（断了自动重连 + 指数退避的是 WS，待实现）
- [x] 处理心跳响应里的 `banned: true`
- [ ] WebSocket 每次重连都重新领票 ⬜
- [ ] 收到 `kicked` / `room-closed` 停止重连 ⬜
- [ ] `tracks/close` 传 `mid` 不传 `trackName` ⬜
- [ ] 同一 session 的 SDP 变更串行化 ⬜
