using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace CfTeamspeed.Desktop;

/// <summary>
/// 显式入口点。
///
/// 为什么不用 XAML 生成的 Main：
///   WinUI 3 默认生成一个 Main，但它假设应用有「框架包依赖」（即 Windows App SDK
///   运行时以 MSIX 框架包形式已安装）。本项目走的是**自包含、非打包**部署
///   （WindowsAppSDKSelfContained=true + WindowsPackageType=None），
///   必须在启动最早的时刻把 Windows App SDK 的运行时初始化起来，
///   否则进程会在创建 Application 时静默退出（没有任何异常、没有任何输出）——
///   这个坑排查成本很高，所以这里显式写出来并加了日志。
///
/// 初始化方式：
///   - 自包含部署：运行时 DLL 就在应用目录里，不需要 Bootstrap；
///     UndockedRegFreeWinRT 会自动激活（见 csproj 的编译常量）。
///   - 仍调用一次 <see cref="Bootstrap.TryInitialize"/> 作为兜底：
///     若机器上恰好装了框架包也能用；失败不影响自包含路径。
/// </summary>
public static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Trace("Main enter");

        // 开发期自检：只验证 Turnstile 的 WebView2 宿主能否拿到 token，
        // 不开主窗口。人机验证是「能否以管理员登录」的硬前提，
        // 没有这个自检就只能靠人肉点界面来确认它没坏。
        if (TurnstileSelfTest.IsRequested(args))
        {
            Environment.ExitCode = TurnstileSelfTest.Run(args);
            return;
        }

        // 音频链路自检：设备枚举 → 采集 → 各档降噪 → 播放 → 热切换。
        // 音频问题（没声音 / 爆音 / 降噪没生效）在 GUI 里只能靠「我听不到」去猜，
        // 这个入口把链路拆成可测量的几段，每段单独报数。
        // 走控制台模式（不需要 WinUI），所以放在 Application.Start 之前。
        if (args.Any(a => string.Equals(a, "--audio-selftest", StringComparison.OrdinalIgnoreCase)))
        {
            Environment.ExitCode = AudioSelfTest.Run(args);
            return;
        }

        // 降噪正确性自检：把官方测试样本过一遍本项目的 C# 链路，
        // 与官方参考输出逐样点比对 —— 证明「推理跑完」之外，结果也确实对。
        if (args.Any(a => string.Equals(a, "--denoise-selftest", StringComparison.OrdinalIgnoreCase)))
        {
            Environment.ExitCode = DenoiseSelfTest.Run(args);
            return;
        }

        // SFU 链路自检：真的打服务端走一遍 publish 协商，
        // 验证 SDP 往返 + Opus 编码 + RTP 发送。
        if (args.Any(a => string.Equals(a, "--rtc-selftest", StringComparison.OrdinalIgnoreCase)))
        {
            Environment.ExitCode = RtcSelfTest.Run(args);
            return;
        }

        // ★ 这里刻意【不】调用 Bootstrap.TryInitialize。
        //
        // 本项目是**自包含 + 非打包**部署：Windows App SDK 的运行时 DLL 就在
        // 应用目录里，靠 exe 内嵌清单里的 winrtv1:activatableClass 注册表
        // （构建时由 UndockedRegFreeWinRT 生成）来激活 WinRT 类型。
        //
        // 一旦调用 Bootstrap.TryInitialize，它反而会去找机器上**已安装的框架包**
        // （Microsoft.WindowsAppRuntime.1.8）。机器上没装 → 进程直接以
        // 0xC0000142 (STATUS_DLL_INIT_FAILED) 退出，而且没有任何异常可捕获。
        //
        // 这条踩坑记录留着，免得以后有人「好心」把它加回来。

        try
        {
            // WinUI 要求进程级初始化 WinRT 与 DispatcherQueue
            WinRT.ComWrappersSupport.InitializeComWrappers();
            Trace("ComWrappers initialized");

            // 捕获所有「第一次机会」异常：XAML 抛出的 stowed exception
            // 会让进程以 0xC000027B 直接退出，常规 catch 抓不到。
            AppDomain.CurrentDomain.FirstChanceException += (_, e) =>
            {
                var ex = e.Exception;
                if (ex is OperationCanceledException) return;
                LogFatal($"FirstChance/{ex.GetType().Name}", ex);
            };
            Trace("FirstChance handler installed");

            Application.Start(_ =>
            {
                Trace("Application.Start callback enter");
                var context = new DispatcherQueueSynchronizationContext(
                    DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);

                new App();
                Trace("App constructed");
            });

            Trace("Application.Start returned");
        }
        catch (Exception ex)
        {
            LogFatal("Main", ex);
            throw;
        }
    }

    private static void Trace(string message)
    {
        try
        {
            File.AppendAllText(
                Services.AppPaths.Combine("startup.log"),
                $"{DateTimeOffset.Now:HH:mm:ss.fff} {message}{Environment.NewLine}");
        }
        catch
        {
            // 忽略
        }
    }

    private static void LogFatal(string source, Exception ex)
    {
        try
        {
            File.AppendAllText(
                Services.AppPaths.Combine("error.log"),
                $"""

                ===== {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} [{source}] =====
                {ex}

                """);
        }
        catch
        {
            // 忽略
        }
    }
}

