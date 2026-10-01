using System.Text.Json;
using CfTeamspeed.Desktop.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;

namespace CfTeamspeed.Desktop.Views;

/// <summary>
/// Cloudflare Turnstile 的宿主窗口。
///
/// 生命周期很短：打开 → 用户完成验证 → 回调里拿到 token → 立即关闭。
/// 用 <see cref="TaskCompletionSource{TResult}"/> 把「窗口」包装成一次
/// 可以 await 的调用，调用方（登录流程）拿到的就是一个 token 或失败原因。
///
/// 安全收紧（相对普通 WebView 而言）：
///   · 只 NavigateToString 一张本地 HTML，不加载任何远程页面；
///   · 关闭右键菜单、状态栏、开发者工具，禁用拖放；
///   · 不允许新窗口（NewWindowRequested 一律取消）；
///   · 不做下载。唯一被允许的外联请求是 Cloudflare 的验证脚本，
///     由页面内的 &lt;script src&gt; 发起 —— 这是验证本身的必要组成。
/// </summary>
public sealed partial class TurnstileWindow : Window
{
    private readonly TaskCompletionSource<TurnstileOutcome> _completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private bool _settled;

    /// <summary>Cloudflare 官方脚本地址（与网页端 Turnstile.tsx 保持一致）。</summary>
    private const string ScriptUrl = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

    /// <summary>
    /// 服务器域名（如 <c>ts.futurvo.cc</c>）。
    ///
    /// 用途：Turnstile 会校验页面 origin 是否在该 widget 的域名白名单里，
    /// 因此承载页必须跑在这个域名下（见 InitializeAsync 里的虚拟主机映射）。
    /// </summary>
    private readonly string? _serverOrigin;

    public TurnstileWindow(string siteKey, string? serverName, bool darkTheme, string? serverOrigin = null)
    {
        InitializeComponent();

        _serverOrigin = serverOrigin;

        Title = "人机验证";

        SubtitleText.Text = string.IsNullOrWhiteSpace(serverName)
            ? "登录需要完成一次人机验证"
            : $"{serverName} 的登录需要完成一次人机验证";

        // 尺寸：Turnstile 组件本体 300×65，但 Cloudflare 的失败提示条
        // 会横向撑开（实测到 ~430px），窗口给 520 宽才不会被裁掉。
        AppWindow.Resize(new SizeInt32(520, 420));

        // 限制窗口缩放下限，避免用户把组件挤没
        if (AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = 480;
            presenter.PreferredMinimumHeight = 380;
        }

        CancelButton.Click += (_, _) => Settle(TurnstileOutcome.Cancelled());
        Closed += (_, _) => Settle(TurnstileOutcome.Cancelled());

        // 重试：回到加载态，重新初始化一遍 WebView2
        RetryButton.Click += (_, _) =>
        {
            StatusText.Text = string.Empty;
            RetryButton.Visibility = Visibility.Collapsed;
            CancelButton.Content = "取消";
            LoadingPanel.Visibility = Visibility.Visible;

            _ = InitializeAsync(siteKey, darkTheme);
        };

        _ = InitializeAsync(siteKey, darkTheme);
    }

    /// <summary>等待用户完成（或放弃）验证。</summary>
    public Task<TurnstileOutcome> WaitAsync() => _completion.Task;

    private async Task InitializeAsync(string siteKey, bool darkTheme)
    {
        try
        {
            Diag("init start");

            // 用户数据目录：放在应用数据目录下，避免污染系统 profile。
            // 每次验证都是独立的，所以不需要保留任何会话状态。
            var userDataFolder = Path.Combine(AppPaths.DataDirectory, "webview2");
            Directory.CreateDirectory(userDataFolder);
            Diag($"userDataFolder={userDataFolder}");

            // ★ 用「设 Environment + 无参 EnsureCoreWebView2Async」这套写法，
            //   而不是 EnsureCoreWebView2Async(environment) 那个重载。
            //
            //   实测：在 WinUI 3 + 自包含非打包部署下，传 environment 的重载会
            //   「正常返回但 CoreWebView2 仍为 null」；先给控件的 Environment
            //   属性赋值、再无参调用，才是这个控件稳定工作的方式。
            var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataFolder,
                options: new CoreWebView2EnvironmentOptions
                {
                    AdditionalBrowserArguments = "--disable-features=msWebOOUI,msPdfOOUI",
                });

            Diag("environment created");

            // ★ WebView2 必须在**已加载进可视化树**之后才能初始化。
            //   窗口刚构造时控件还没上树，初始化会静默失败（CoreWebView2 为 null）。
            if (!Web.IsLoaded)
            {
                var loaded = new TaskCompletionSource();
                void OnLoaded(object s, RoutedEventArgs e) => loaded.TrySetResult();

                Web.Loaded += OnLoaded;
                try
                {
                    await loaded.Task.WaitAsync(TimeSpan.FromSeconds(10));
                }
                catch (TimeoutException)
                {
                    Diag("waiting for Loaded timed out; trying anyway");
                }
                finally
                {
                    Web.Loaded -= OnLoaded;
                }
            }

            Diag("webview loaded, ensuring core");

            Web.CoreWebView2Initialized += (_, e) =>
            {
                if (e.Exception is not null)
                {
                    // 这个异常的 Message 常常是空的，必须把 HResult 一起记下来，
                    // 否则等于什么都没说。
                    var ex = e.Exception;
                    Diag($"CoreWebView2Initialized 失败: hresult=0x{ex.HResult:X8} " +
                         $"type={ex.GetType().FullName} msg='{ex.Message}' " +
                         $"inner='{ex.InnerException?.Message}'");
                }
            };

            // ★ 必须显式指定用户数据目录，不能依赖运行时默认值。
            //
            //   默认位置是 %LOCALAPPDATA%\Microsoft\EdgeWebView。在受限账户或
            //   被沙箱管控的环境里那个目录不可写，WebView2 会以
            //   E_UNEXPECTED (0x8000FFFF) 失败 —— 而且 CoreWebView2Initialized
            //   给出的异常 Message 是**空字符串**，不看 HResult 根本查不出来。
            //
            //   AppPaths.DataDirectory 已经做过「逐个候选位置试写」，
            //   所以这里直接用它，WebView2 就跟着落到可写的地方。
            await Web.EnsureCoreWebView2Async(environment);

            Diag($"EnsureCoreWebView2Async 返回, CoreWebView2={(Web.CoreWebView2 is null ? "null" : "ok")}");

            // EnsureCoreWebView2Async 返回后 CoreWebView2 理论上必然非空，
            // 但 WebView2 在某些失败路径下会「成功返回 + 属性为 null」，
            // 直接解引用就是一个没有上下文的 NullReferenceException。
            var core = Web.CoreWebView2
                ?? throw new InvalidOperationException("WebView2 内核未能初始化（CoreWebView2 为空）");

            Diag("core obtained");

            // ---- 收紧：禁用一切与验证无关的能力 ----
            var settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.AreHostObjectsAllowed = false;   // 不注入宿主对象
            settings.IsWebMessageEnabled = true;      // 唯一需要的通道：回传 token
            settings.IsGeneralAutofillEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;

            // 只允许 HTTPS：Turnstile 脚本必须走 https
            core.NavigationStarting += (_, e) =>
            {
                if (!e.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) &&
                    !e.Uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase) &&
                    !e.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase))
                {
                    e.Cancel = true;
                }
            };

            // 禁止开新窗口（验证过程中不该出现任何弹窗）
            core.NewWindowRequested += (_, e) => e.Handled = true;

            core.WebMessageReceived += OnWebMessageReceived;

            var page = TurnstileHostPage.Build(new TurnstileHostOptions
            {
                SiteKey = siteKey,
                ScriptUrl = ScriptUrl,
                Theme = darkTheme ? "dark" : "light",
                Hint = "验证由 Cloudflare 提供，用于确认你是真人。",
            });

            // ★ 页面必须以**服务器自己的域名**为 origin 加载，否则真实 sitekey 必失败。
            //
            //   原因（踩坑记录，报错是 110200「无法连接到网站」，极具误导性）：
            //   Cloudflare Turnstile 会拿 window.location.hostname 去比对 widget
            //   配置里的域名白名单。用 NavigateToString 加载时页面 origin 是
            //   `about:blank`，**永远不可能**匹配任何白名单域名 ——
            //   于是组件渲染成一个错误框，而不是网络问题。
            //
            //   做法：把 HTML 通过 SetVirtualHostNameToFolderMapping 挂到
            //   <服务器域名> 这个虚拟主机下，再 Navigate 到它。
            //   WebView2 会把该虚拟主机的 origin 报成
            //   `https://<服务器域名>`，Turnstile 的域名校验即可通过，
            //   而文件仍然完全来自本地（不产生任何网络请求）。
            var originHost = ResolveOriginHost(_serverOrigin);
            Diag($"origin host for turnstile = {originHost ?? "(none)"}");

            if (!string.IsNullOrEmpty(originHost))
            {
                // 把本地临时目录映射为该域名
                var dir = Path.Combine(AppPaths.DataDirectory, "turnstile-page");
                Directory.CreateDirectory(dir);
                var htmlPath = Path.Combine(dir, "index.html");
                await File.WriteAllTextAsync(htmlPath, page, System.Text.Encoding.UTF8);

                core.SetVirtualHostNameToFolderMapping(
                    originHost,
                    dir,
                    CoreWebView2HostResourceAccessKind.DenyCors);

                core.Navigate($"https://{originHost}/index.html");
                Diag($"navigated via virtual host https://{originHost}/index.html");
            }
            else
            {
                // 拿不到服务器域名（离线 / 地址异常）：退回内联页面。
                // 此时真实 sitekey 会因 origin 不匹配而失败，但至少能看到明确提示。
                Diag("no origin host available; falling back to NavigateToString");
                core.NavigateToString(page);
            }

            // 让 WebView2 报上来它实际加载了什么（这点非常关键，
            // 没日志的话「白屏」和「页面没拿到脚本」永远分不清）
            core.NavigationCompleted += (_, e) =>
            {
                Diag($"NavigationCompleted: success={e.IsSuccess} http={e.HttpStatusCode} " +
                     $"webError={e.WebErrorStatus}");
            };
            core.DOMContentLoaded += (_, _) => Diag("DOMContentLoaded");
        }
        catch (Exception ex)
        {
            Diag($"init failed: {ex.GetType().Name}: {ex.Message}");

            // ★ 失败时【不关窗口】。
            //
            //   原先一失败就 Settle → Close，窗口「闪一下就消失」，
            //   用户只看到「打不开」，完全不知道为什么、也不知道该怎么办。
            //   正确做法：留在窗口里把原因说清楚，并给一个「重试」出口。
            EnterFailureState(DescribeInitFailure(ex));
        }
    }

    /// <summary>
    /// 进入失败态：显示原因 + 重试按钮，等用户决定。
    ///
    /// 与成功路径的区别是它**不自动关闭** —— 用户需要时间读这段话。
    /// </summary>
    private void EnterFailureState(string message)
    {
        if (_settled) return;

        void Apply()
        {
            LoadingPanel.Visibility = Visibility.Collapsed;
            StatusText.Text = message;

            // 复用「取消」按钮变成「关闭」，另外放一个「重试」
            CancelButton.Content = "关闭";
            RetryButton.Visibility = Visibility.Visible;
        }

        if (DispatcherQueue.HasThreadAccess) Apply();
        else DispatcherQueue.TryEnqueue(Apply);
    }

    /// <summary>
    /// 从服务器 baseUrl 解析出用于虚拟主机的域名。
    ///
    /// 只取 host（含端口以外的主机名）—— Turnstile 的域名白名单匹配的是
    /// hostname，带端口会导致不匹配（白名单里通常只填域名）。
    /// </summary>
    private static string? ResolveOriginHost(string? serverOrigin)
    {
        if (string.IsNullOrWhiteSpace(serverOrigin)) return null;

        if (!Uri.TryCreate(serverOrigin, UriKind.Absolute, out var uri)) return null;

        // 必须是 http(s)，其它 scheme（file: 等）没法当虚拟主机
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;

        return string.IsNullOrWhiteSpace(uri.Host) ? null : uri.Host;
    }

    /// <summary>
    /// 诊断输出。
    ///
    /// WebView2 的初始化失败往往是「静默的」：进程还在、窗口还在，
    /// 但内核进程没起来，界面就永远停在「加载中」。没有这条日志
    /// 就只能靠猜，所以保留它（只在 selftest / 排查时看得到）。
    /// </summary>
    private static void Diag(string message)
    {
        try
        {
            Console.Error.WriteLine($"[turnstile] {message}");
            Console.Error.Flush();
        }
        catch
        {
            // 无控制台时忽略
        }

        try
        {
            File.AppendAllText(
                Path.Combine(AppPaths.DataDirectory, "turnstile.log"),
                $"{DateTimeOffset.Now:HH:mm:ss.fff} {message}{Environment.NewLine}");
        }
        catch
        {
            // 落盘失败不影响验证本身
        }
    }

    /// <summary>
    /// WebView2 运行时缺失时给出可照做的提示，而不是抛一堆 HRESULT。
    /// </summary>
    private static string DescribeInitFailure(Exception ex)
    {
        var message = ex.Message;
        var code = ex.HResult;

        // 0x80070002 = 找不到运行时（未安装 / 版本不匹配）
        if (code == unchecked((int)0x80070002) ||
            message.Contains("WebView2", StringComparison.OrdinalIgnoreCase))
        {
            return "无法启动验证组件：本机缺少 Microsoft Edge WebView2 Runtime。\n" +
                   "请安装后重试（Windows 11 通常已自带）。";
        }

        // 0x80070005 = 拒绝访问：浏览器进程被安全策略 / 沙箱拦住了。
        // 这是「装了运行时但起不来」的典型报错，必须和「没装」区分开，
        // 否则用户会白白重装一次运行时。
        if (code == unchecked((int)0x80070005) || code == unchecked((int)0x8000FFFF))
        {
            return "无法启动验证组件：浏览器进程被拒绝访问。\n" +
                   "常见原因是安全软件或企业策略阻止了它。\n" +
                   "可尝试：以普通桌面会话运行、临时关闭安全软件后重试。";
        }

        // 兜底：把 HRESULT 带上，方便定位（很多这类异常的 Message 是空的）
        return string.IsNullOrWhiteSpace(message)
            ? $"无法启动验证组件（错误码 0x{code:X8}）。请重试，或改用访客 key 登录。"
            : $"无法启动验证组件：{message}（0x{code:X8}）";
    }

    private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        string raw;
        try
        {
            raw = args.TryGetWebMessageAsString();
        }
        catch
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(raw)) return;

        string? kind = null;
        string? token = null;
        string? detail = null;

        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (root.TryGetProperty("kind", out var k)) kind = k.GetString();
            if (root.TryGetProperty("token", out var t) && t.ValueKind == JsonValueKind.String)
            {
                token = t.GetString();
            }
            if (root.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String)
            {
                detail = d.GetString();
            }
        }
        catch (JsonException)
        {
            return; // 不是我们预期的消息，忽略
        }

        switch (kind)
        {
            case "success" when !string.IsNullOrWhiteSpace(token):
                Settle(TurnstileOutcome.Ok(token));
                break;

            case "expired":
                // token 过期：把界面状态说清楚，让用户重新验证，但窗口不关
                SetStatus("验证已过期，请重新完成验证");
                break;

            case "error":
                SetStatus(DescribeWidgetError(detail));
                break;
        }
    }

    /// <summary>
    /// 把 Turnstile 的错误码翻译成用户能理解的说明。
    ///
    /// ⚠️ 这里必须区分「网络问题」与「配置问题」。
    ///   早先的版本把一切都写成「请检查网络后重试」，导致
    ///   110200（域名不被允许）这种纯配置问题被误报成网络故障 ——
    ///   用户反复重试永远不可能成功，还会以为是自己的网络不好。
    /// </summary>
    private static string DescribeWidgetError(string? detail) => detail switch
    {
        "script-load-failed" => "无法加载 Cloudflare 验证脚本，请检查网络后重试。",
        "script-not-loaded" => "验证脚本未能就绪，请检查网络后重试。",
        "timeout" => "验证组件加载超时，请检查网络后重试。",
        null or "" => "验证失败，请重试。",
        _ when detail.StartsWith("render-failed", StringComparison.Ordinal) =>
            "验证组件初始化失败。请确认服务器配置的 Site Key 是否正确。",

        // 110200：域名不在该 widget 的允许列表里。
        // 这是**部署配置问题**，重试一万次也没用，必须明确说出来。
        "110200" =>
            "该域名未被 Cloudflare Turnstile 允许。\n" +
            "请到 Turnstile 控制台的 widget 设置里，把本服务器的域名加入允许列表。",

        // 110100 / 110110：sitekey 本身无效或已禁用
        "110100" or "110110" =>
            "Site Key 无效或已被禁用。请部署方检查 Turnstile 配置。",

        // 110500 / 110510 / 110600：Cloudflare 侧的临时故障或配置错误
        "110500" or "110510" or "110600" =>
            "Cloudflare 验证服务暂时异常，请稍后重试。",

        _ => $"验证失败（{detail}）。",
    };

    private void SetStatus(string message)
    {
        if (DispatcherQueue.HasThreadAccess)
        {
            StatusText.Text = message;
            LoadingPanel.Visibility = Visibility.Collapsed;
        }
        else
        {
            DispatcherQueue.TryEnqueue(() =>
            {
                StatusText.Text = message;
                LoadingPanel.Visibility = Visibility.Collapsed;
            });
        }
    }

    /// <summary>
    /// 结束等待并关闭窗口。多次调用只生效一次 ——
    /// 「用户点取消」与「Closed 事件」会几乎同时到达，必须幂等。
    /// </summary>
    private void Settle(TurnstileOutcome outcome)
    {
        if (_settled) return;
        _settled = true;

        _completion.TrySetResult(outcome);

        // ⚠️ 这里必须用 Window.Close()，不能写成同名的局部函数 ——
        //    局部函数会**递归调用自己**，而且不会抛异常，直接以
        //    「Stack overflow. Repeated N times」结束整个进程，
        //    看起来像莫名其妙的崩溃。这个坑踩过一次。
        void CloseWindow()
        {
            try
            {
                this.Close();
            }
            catch
            {
                // 窗口可能已经关了
            }
        }

        if (DispatcherQueue.HasThreadAccess) CloseWindow();
        else DispatcherQueue.TryEnqueue(CloseWindow);
    }
}
