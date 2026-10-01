using System.Text.Json;
using CfTeamspeed.Desktop.Services;

namespace CfTeamspeed.Desktop;

/// <summary>
/// 自检入口：验证 Cloudflare Turnstile 的 WebView2 宿主是否真的能拿到 token。
///
/// 这不是给用户用的功能，是**开发期的可验证性工具**：
/// 「人机验证能不能过」这件事如果只能靠人肉点界面来验证，
/// 那它出问题时就没有任何确定的排查手段。
///
/// 用法：
///   CfTeamspeed.Desktop.exe --turnstile-selftest [siteKey]
///
/// siteKey 省略时使用 Cloudflare 官方测试 key（总是通过，见官方文档
/// "Dummy sitekeys"），因此可在完全离线于业务服务的环境下验证渲染链路。
///
/// 输出：一行 JSON 到 stdout，退出码 0 表示拿到 token，1 表示失败。
/// </summary>
internal static class TurnstileSelfTest
{
    /// <summary>Cloudflare 官方「总是通过」的测试 sitekey。</summary>
    private const string AlwaysPassSiteKey = "1x00000000000000000000AA";

    public static bool IsRequested(string[] args) =>
        args.Any(a => string.Equals(a, "--turnstile-selftest", StringComparison.OrdinalIgnoreCase));

    public static int Run(string[] args)
    {
        var index = Array.FindIndex(
            args,
            a => string.Equals(a, "--turnstile-selftest", StringComparison.OrdinalIgnoreCase));

        var siteKey = index >= 0 && index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal)
            ? args[index + 1]
            : AlwaysPassSiteKey;

        // 可选的服务器地址：真实 sitekey 会校验页面 origin 是否在 widget 的
        // 域名白名单里，所以自检也必须能指定域名，否则测不出真实行为。
        // 用法：--turnstile-selftest <siteKey> --origin https://ts.example.com
        var originIndex = Array.FindIndex(
            args,
            a => string.Equals(a, "--origin", StringComparison.OrdinalIgnoreCase));

        var serverOrigin = originIndex >= 0 && originIndex + 1 < args.Length
            ? args[originIndex + 1]
            : null;

        Emit($"starting selftest, siteKey={siteKey}, origin={serverOrigin ?? "(none)"}");

        var exitCode = 1;

        try
        {
            WinRT.ComWrappersSupport.InitializeComWrappers();

            Microsoft.UI.Xaml.Application.Start(initParams =>
            {
                var context = new Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(
                    Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);

                _ = initParams;

                // ★ 必须先构造 App：它负责合并 XamlControlsResources 与我们的主题字典。
                //   TurnstileWindow 的样式引用了 {ThemeResource InkBrush} 等键，
                //   没有 App 提供的资源字典，窗口在 InitializeComponent 阶段
                //   就会卡住（不抛异常，只是永远不返回）—— 排查成本极高。
                App.SelfTestMode = true;
                _ = new App();

                // 用 ContinueWith 把退出码记下来再退出，避免在 UI 线程上阻塞等待
                _ = RunAsync(siteKey, serverOrigin).ContinueWith(
                    t =>
                    {
                        exitCode = t.IsCompletedSuccessfully ? t.Result : 1;
                        Microsoft.UI.Xaml.Application.Current.Exit();
                    },
                    TaskScheduler.FromCurrentSynchronizationContext());
            });
        }
        catch (Exception ex)
        {
            Emit($"harness-error: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }

        return exitCode;
    }

    private static async Task<int> RunAsync(string siteKey, string? serverOrigin)
    {
        Emit("creating window");

        Views.TurnstileWindow window;
        try
        {
            window = new Views.TurnstileWindow(siteKey, "自检", darkTheme: true, serverOrigin);
        }
        catch (Exception ex)
        {
            Emit($"window-ctor-failed: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }

        Emit("window created, activating");

        // 让窗口置顶到前台 —— 自检脚本是脱离主窗口单独跑的，
        // 没主动 Activate + BringToFront 的话窗口可能出现在其它显示器
        // 或者被其它进程盖住，看起来像「没打开」。
        window.Activate();

        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            Emit($"activated, hwnd={hwnd:X} visible={window.Visible}");
        }
        catch (Exception ex)
        {
            Emit($"activate-failed: {ex.GetType().Name}: {ex.Message}");
        }

        Emit("waiting for outcome");

        // 给 Cloudflare 脚本留出网络时间；超时就判定失败。
        //   1x000000…AA 是「总是通过」的测试 key，不应需要人机交互，
        //   所以 25 秒足够；正式部署中的真实 key 走的就是登录流程，由
        //   MainWindow 的 AcquireTurnstileTokenIfNeededAsync 决定要不要弹窗。
        var outcome = await window.WaitAsync().WaitAsync(TimeSpan.FromSeconds(25));

        Emit($"outcome success={outcome.Success} error={outcome.Error}");

        if (outcome.Success && !string.IsNullOrWhiteSpace(outcome.Token))
        {
            // 只打印长度与前缀：token 是凭据，不该整串写进日志
            var token = outcome.Token!;
            Emit($"success tokenLength={token.Length} prefix={token[..Math.Min(12, token.Length)]}…");
            return 0;
        }

        Emit($"failed reason={outcome.Error}");
        return 1;
    }

    private static void Emit(string message)
    {
        try
        {
            // 走 stderr，避免与 stdout 的 JSON 结果混在一起
            Console.Error.WriteLine($"[turnstile-selftest] {message}");
            Console.Error.Flush();
        }
        catch
        {
            // 无控制台时忽略
        }
    }
}

