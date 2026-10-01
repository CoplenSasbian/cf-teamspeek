using CfTeamspeed.Desktop.Models;
using CfTeamspeed.Desktop.Services;
using Microsoft.UI.Xaml;

namespace CfTeamspeed.Desktop;

/// <summary>
/// 应用入口。
///
/// 这里只做三件事，其余全部交给 MainWindow：
///   1. 建立全局服务（设置、服务器档案、多服务器总控），供各页面通过 App 拿到；
///   2. 捕获未处理异常，避免整个应用静默退出；
///   3. 打开主窗口。
///
/// 之所以把服务挂在 App 上而不是用依赖注入容器：本应用只有一个窗口、
/// 生命周期与进程一致，引入容器只会增加阅读成本。
/// </summary>
public partial class App : Application
{
    /// <summary>进程内唯一的设置服务（跨服务器共享的界面/音频偏好）。</summary>
    public SettingsService Settings { get; } = new();

    /// <summary>多服务器档案的持久化。</summary>
    public ServerStore ServerStore { get; } = new();

    /// <summary>
    /// 多服务器总控。窗口构造时初始化（需要 UI 线程上下文来做通知）。
    ///
    /// 用 <c>null!</c> 起步、在 <see cref="OnLaunched"/> 里赋值：
    /// 它是「必须有」的，标成可空会让每个使用点都写一遍 !.
    /// </summary>
    public ServerManager Servers { get; private set; } = null!;

    /// <summary>主窗口（单窗口应用，保留引用方便从任意位置调 Activate）。</summary>
    public MainWindow? MainWindow { get; private set; }

    /// <summary>
    /// 自检模式：只初始化资源字典，不开主窗口。
    /// 由 <see cref="TurnstileSelfTest"/> 在构造前设置。
    /// </summary>
    internal static bool SelfTestMode { get; set; }

    public App()
    {
        // 启动轨迹：这套自包含非打包部署在缺少运行时/清单问题时是「静默退出」，
        // 没有这条日志就完全无从下手。稳定后可以删掉。
        Trace("App ctor enter");

        try
        {
            InitializeComponent();
            Trace("InitializeComponent ok");
        }
        catch (Exception ex)
        {
            LogFatal("InitializeComponent", ex);
            throw;
        }

        // 兜底：任何没被 catch 的异常都要留下痕迹，否则表现为「应用莫名其妙就没了」
        UnhandledException += OnUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            LogFatal("AppDomain", e.ExceptionObject as Exception);
        };
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            LogFatal("UnobservedTask", e.Exception);
            e.SetObserved(); // 标记已观察，避免进程被拖垮
        };

        Trace("App ctor exit");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Trace("OnLaunched enter");

        // 自检模式下不打开主窗口：TurnstileSelfTest 会自己开验证窗口。
        // 这里只保留 App 的资源字典（XamlControlsResources + Themes），
        // 那正是自检窗口需要的。
        if (SelfTestMode)
        {
            Trace("self-test mode: skipping main window");
            return;
        }

        try
        {
            Servers = new ServerManager(ServerStore, Settings);
            Trace("ServerManager created");

            MainWindow = new MainWindow();
            Trace("MainWindow created");

            MainWindow.Activate();
            Trace("MainWindow activated");
        }
        catch (Exception ex)
        {
            LogFatal("OnLaunched", ex);
            throw;
        }
    }

    /// <summary>写一条启动轨迹（仅用于排查启动期静默退出）。</summary>
    private static void Trace(string message)
    {
        try
        {
            File.AppendAllText(
                AppPaths.Combine("startup.log"),
                $"{DateTimeOffset.Now:HH:mm:ss.fff} {message}{Environment.NewLine}");
        }
        catch
        {
            // 记录失败就算了，绝不能因此影响启动
        }
    }

    private void OnUnhandledException(object sender, Microsoft.UI.Xaml.UnhandledExceptionEventArgs e)
    {
        LogFatal("XamlUnhandled", e.Exception);

        // 标记已处理：单个页面的异常不该让整个应用崩掉。
        // 真正的致命错误（启动期）仍然会在别处抛出。
        e.Handled = true;
    }

    /// <summary>
    /// 把致命错误写到日志文件。
    ///
    /// 不用 Debug.WriteLine：那种输出在 Release 下看不到，
    /// 而这个应用是给非开发者用的，出问题必须能事后翻日志。
    /// </summary>
    private static void LogFatal(string source, Exception? ex)
    {
        try
        {
            var path = AppPaths.Combine("error.log");
            var text = $"""

                ===== {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} [{source}] =====
                {ex}

                """;
            File.AppendAllText(path, text);
        }
        catch
        {
            // 记日志本身失败就只能放弃 —— 绝不能在异常处理里再抛异常
        }
    }
}
