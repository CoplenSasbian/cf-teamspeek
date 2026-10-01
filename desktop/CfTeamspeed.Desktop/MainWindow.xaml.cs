using CfTeamspeed.Desktop.Controls;
using CfTeamspeed.Desktop.Models;
using CfTeamspeed.Desktop.Services;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;
using Windows.UI;
using WinRT.Interop;

namespace CfTeamspeed.Desktop;

/// <summary>
/// 主窗口 —— 应用的外壳与编排中心。
///
/// 职责：
///   1. 建立 <see cref="ServerManager"/> 并把它接到服务器栏；
///   2. 在「激活的服务器」变化时，把四栏内容整体切换到那台服务器；
///   3. 承载对话框（添加服务器 / 登录 / 改名）与轻提示；
///   4. 窗口尺寸记忆与扩展标题栏。
///
/// 刻意把「媒体链路（RoomController）」留到后续步骤：
/// 本步先把多服务器骨架与全部网络/状态逻辑跑通，音频是叠加在其上的能力。
/// </summary>
public sealed partial class MainWindow : Window
{
    private readonly ServerManager _manager;
    private readonly SettingsService _settings;
    private AppSettings _appSettings;

    /// <summary>进房时间（用于语音面板显示时长）。</summary>
    private DateTimeOffset? _joinedAt;

    private bool _muted;
    private bool _initialized;

    public MainWindow()
    {
        InitializeComponent();

        var app = (App)Application.Current;
        _manager = app.Servers;
        _settings = app.Settings;
        _appSettings = _settings.Current;

        // 把 UI 线程调度器交给 ServerManager：它会在触发事件前切回 UI 线程，
        // 避免订阅方（本窗口与各栏控件）跨线程碰 XAML 控件。
        _manager.Dispatcher = DispatcherQueue;

        ConfigureWindow();
        WireEvents();

        // ★ 服务器栏要先接上总控，否则最左那一列永远是空的
        //   （它是桌面端相对网页端唯一多出来的一栏，漏了这一步整个多服务器特性就看不见）
        ServerRailControl.Attach(_manager);

        // 初始化是异步的（要读磁盘），但窗口必须先显示出来，
        // 否则用户会看到「点了图标没反应」
        _ = InitializeAsync();
    }

    // ============================================================
    //  窗口外观
    // ============================================================

    private void ConfigureWindow()
    {
        Title = "游戏语音室";

        // 恢复上次的窗口尺寸（默认 1280x800：四栏并排需要足够宽度）
        var width = _appSettings.WindowWidth > 0 ? _appSettings.WindowWidth : 1280;
        var height = _appSettings.WindowHeight > 0 ? _appSettings.WindowHeight : 820;

        AppWindow.Resize(new SizeInt32((int)width, (int)height));
        AppWindow.Title = "游戏语音室";

        // 扩展内容到标题栏：让左上角那片区域也能拖动窗口
        if (AppWindowTitleBar.IsCustomizationSupported())
        {
            var titleBar = AppWindow.TitleBar;
            titleBar.ExtendsContentIntoTitleBar = true;
            titleBar.ButtonBackgroundColor = Colors.Transparent;
            titleBar.ButtonInactiveBackgroundColor = Colors.Transparent;

            // 深色标题栏按钮（跟随主题，避免浅色按钮压在浅色底上看不见）
            var dark = Application.Current.RequestedTheme == ApplicationTheme.Dark;
            titleBar.ButtonForegroundColor = dark
                ? Color.FromArgb(255, 241, 245, 249)
                : Color.FromArgb(255, 71, 85, 105);

            SetTitleBar(TitleBarArea);

            // 给系统按钮留出右侧空间，避免内容被压住
            TitleBarArea.Margin = new Thickness(0, 0, titleBar.RightInset, 0);
        }
        else
        {
            TitleBarArea.Visibility = Visibility.Collapsed;
        }

        // 关闭时记住尺寸
        AppWindow.Closing += (_, _) =>
        {
            try
            {
                _appSettings.WindowWidth = AppWindow.Size.Width;
                _appSettings.WindowHeight = AppWindow.Size.Height;
                _ = _settings.SaveAsync();
            }
            catch
            {
                // 关窗路径上不做任何会抛异常的事
            }
        };

        // 递归查找并启用深色/浅色跟随
        if (Content is FrameworkElement root)
        {
            root.ActualThemeChanged += (_, _) => ApplyThemeToTitleBar();
        }
    }

    private void ApplyThemeToTitleBar()
    {
        if (!AppWindowTitleBar.IsCustomizationSupported()) return;

        var dark = Content is FrameworkElement { ActualTheme: ElementTheme.Dark };
        AppWindow.TitleBar.ButtonForegroundColor = dark
            ? Color.FromArgb(255, 241, 245, 249)
            : Color.FromArgb(255, 71, 85, 105);
    }

    // ============================================================
    //  事件接线
    // ============================================================

    private void WireEvents()
    {
        ServerRailControl.AddServerRequested += (_, _) => _ = ShowAddServerDialogAsync();
        ServerRailControl.SettingsRequested += (_, _) => _ = ShowSettingsDialogAsync();
        ServerRailControl.ServerActionRequested += (_, e) => _ = HandleServerActionAsync(e);

        SidebarControl.RoomSelected += (_, roomId) => _ = EnterRoomAsync(roomId);
        SidebarControl.CreateRoomRequested += (_, _) => _ = ShowCreateRoomDialogAsync();
        SidebarControl.RefreshRequested += (_, _) => RefreshActive();
        SidebarControl.LogoutRequested += (_, _) => _ = LogoutActiveAsync();
        SidebarControl.ProfileRequested += (_, _) => _ = ShowSettingsDialogAsync();
        SidebarControl.ToggleMuteRequested += (_, _) => _ = ToggleMuteAsync();
        SidebarControl.LeaveRoomRequested += (_, _) => _ = LeaveRoomAsync();
        SidebarControl.RoomActionRequested += (_, e) => _ = HandleRoomActionAsync(e);

        RoomViewControl.RoomSelected += (_, roomId) => _ = EnterRoomAsync(roomId);

        MemberRailControl.InviteRequested += (_, user) => _ = InviteAsync(user);
        MemberRailControl.FollowRequested += (_, user) => FollowUser(user);
        MemberRailControl.KickRequested += (_, user) => _ = KickAsync(user);

        AddFirstServerButton.Click += (_, _) => _ = ShowAddServerDialogAsync();

        _manager.ActiveServerChanged += (_, _) => OnActiveServerChanged();
        _manager.ServersChanged += (_, _) => OnServersChanged();
        _manager.ServerStateChanged += (_, e) => OnServerStateChanged(e);
        _manager.Invited += (_, e) => OnInvited(e);
    }

    private async Task InitializeAsync()
    {
        try
        {
            // ★ 关键：初始化完成后必须回到 UI 线程再动界面。
            //
            // 窗口构造函数里 `_ = InitializeAsync()` 是「即发即忘」的，
            // 而 ServerManager 内部到处 ConfigureAwait(false)（库代码应当如此），
            // 于是续体落在**线程池线程**上。此时任何 set TextBlock.Text 都会抛
            // RPC_E_WRONG_THREAD (0x8001010E)，表现为启动即弹「初始化失败」。
            //
            // 用 EnqueueAsync 显式切回 UI 线程，比依赖 SynchronizationContext
            // 更稳（不依赖调用点是否捕获到了上下文）。
            await _manager.InitializeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            LogStartupFailure(ex);
            await DispatcherQueue.EnqueueAsync(() =>
                ShowMessageAsync("初始化失败", Describe(ex)));
            return;
        }

        // 界面更新一律在 UI 线程上做
        await DispatcherQueue.EnqueueAsync(() =>
        {
            _initialized = true;

            // 初始化期间 ServersChanged 可能已经触发过（那时 Dispatcher 还没接上），
            // 这里补一次强制重建，确保服务器栏一定拿到最新列表
            ServerRailControl.Attach(_manager);

            OnServersChanged();
            OnActiveServerChanged();
        });
    }

    /// <summary>把启动期异常写到数据目录，便于事后排查。</summary>
    private static void LogStartupFailure(Exception ex)
    {
        try
        {
            File.AppendAllText(
                AppPaths.Combine("startup-failure.log"),
                $"""

                ===== {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} =====
                {ex}

                """);
        }
        catch
        {
            // 记不下来就算了
        }
    }

    /// <summary>把异常压成一句可读的话（含最内层原因）。</summary>
    private static string Describe(Exception ex)
    {
        var innermost = ex;
        while (innermost.InnerException is not null) innermost = innermost.InnerException;

        return innermost == ex
            ? ex.Message
            : $"{ex.Message}\n\n原因：{innermost.Message}";
    }

    // ============================================================
    //  服务器变化
    // ============================================================

    private void OnServersChanged()
    {
        var hasServers = _manager.Sessions.Count > 0;

        EmptyStateOverlay.Visibility = hasServers ? Visibility.Collapsed : Visibility.Visible;

        // 有服务器但当前这台没登录 → 引导登录。
        //
        // ★ 只在启动完成后才弹：初始化过程中 ServerManager 会多次触发
        //   ServersChanged（每加一台会话就一次），若每个事件都去弹登录框，
        //   多服务器用户一开机就会被叠加的模态框淹没。
        if (_initialized && hasServers && _manager.Active is { } active && !active.Profile.HasToken)
        {
            _ = PromptLoginIfNeededAsync(active);
        }
    }

    private void OnActiveServerChanged()
    {
        var session = _manager.Active;

        SidebarControl.Attach(session);
        SidebarControl.SetSelfUid(session?.SelfUid);
        MemberRailControl.Attach(session, session?.SelfUid);

        _joinedAt = null;
        _muted = false;

        RefreshActive();
        UpdateConnectionBadge();

        if (session is not null)
        {
            TitleText.Text = string.IsNullOrEmpty(session.DisplayName)
                ? "游戏语音室"
                : session.DisplayName;
        }
        else
        {
            TitleText.Text = "游戏语音室";
        }
    }

    private void OnServerStateChanged(ServerStateChangedEventArgs e)
    {
        if (e.ServerId != _manager.ActiveServerId) return;

        UpdateConnectionBadge();
        SidebarControl.Refresh();
        MemberRailControl.Refresh();
    }

    private void UpdateConnectionBadge()
    {
        var session = _manager.Active;
        if (session is null)
        {
            ConnectionDot.Fill = GetBrush("Ink3Brush");
            ConnectionText.Text = "未选择服务器";
            return;
        }

        var (brush, text) = session.State switch
        {
            ServerConnectionState.Online =>
                (GetBrush("UpBrush"), session.Profile.Nickname is { Length: > 0 } n ? $"已连接 · {n}" : "已连接"),
            ServerConnectionState.Connecting => (GetBrush("WarnBrush"), "连接中…"),
            ServerConnectionState.Degraded => (GetBrush("WarnBrush"), "连接不稳定"),
            ServerConnectionState.SignedOut => (GetBrush("Ink3Brush"), "需要登录"),
            ServerConnectionState.Banned => (GetBrush("DownBrush"), "已被移出该服务器"),
            _ => (GetBrush("Ink3Brush"), "未连接"),
        };

        ConnectionDot.Fill = brush;
        ConnectionText.Text = $"{session.DisplayName} · {text}";
    }

    /// <summary>把当前激活服务器的数据铺到各栏。</summary>
    private void RefreshActive()
    {
        var session = _manager.Active;
        if (session is null)
        {
            RoomViewControl.ShowOverview(string.Empty, string.Empty, Array.Empty<RoomWithMembers>());
            return;
        }

        var profile = session.Profile;
        var currentRoom = session.CurrentRoomId is { Length: > 0 } rid
            ? session.Rooms.FirstOrDefault(r => r.Id == rid)
            : null;

        if (currentRoom is null)
        {
            RoomViewControl.ShowOverview(session.DisplayName, profile.Nickname, session.Rooms);
            SidebarControl.SetVoiceState(false, _muted, false, false, null, null);
        }
        else
        {
            // 已进房：用房间列表里的成员构造快照视图
            RoomViewControl.ShowRoom(new RoomSnapshot
            {
                Room = new RoomSummary
                {
                    Id = currentRoom.Id,
                    Name = currentRoom.Name,
                    OwnerUid = currentRoom.OwnerUid,
                    MemberCount = currentRoom.MemberCount,
                    MaxMembers = currentRoom.MaxMembers,
                    CreatedAt = currentRoom.CreatedAt,
                },
                Members = currentRoom.Members,
                Version = 0,
            });

            SidebarControl.SetVoiceState(
                true, _muted, session.State == ServerConnectionState.Online,
                session.State == ServerConnectionState.Connecting,
                currentRoom.Name, _joinedAt);
        }
    }

    // ============================================================
    //  服务器操作
    // ============================================================

    private async Task HandleServerActionAsync(ServerRailActionEventArgs e)
    {
        var session = _manager.Find(e.ServerId);
        if (session is null) return;

        switch (e.Action)
        {
            case ServerRailAction.Login:
                await ShowLoginDialogAsync(session);
                break;

            case ServerRailAction.Logout:
                await _manager.LogoutAsync(session.Id);
                RefreshActive();
                Toast($"已登出 {session.DisplayName}");
                break;

            case ServerRailAction.Rename:
                await ShowRenameDialogAsync(session);
                break;

            case ServerRailAction.CopyAddress:
                CopyToClipboard(session.Profile.BaseUrl);
                Toast("服务器地址已复制");
                break;

            case ServerRailAction.Remove:
                await ConfirmRemoveServerAsync(session);
                break;
        }
    }

    private async Task ConfirmRemoveServerAsync(ServerSession session)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "移除服务器",
            Content = $"确定移除「{session.DisplayName}」吗？\n\n{session.HostDisplay}\n\n" +
                      "只会删除本机保存的地址与登录凭据，不影响服务器上的数据。",
            PrimaryButtonText = "移除",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        await _manager.RemoveServerAsync(session.Id);
        Toast($"已移除 {session.DisplayName}");
    }

    private async Task ShowRenameDialogAsync(ServerSession session)
    {
        var input = new TextBox
        {
            Text = session.DisplayName,
            PlaceholderText = "给这台服务器起个名字",
            MaxLength = 32,
            Style = (Style)Application.Current.Resources["AppTextBoxStyle"],
        };

        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "重命名服务器",
            Content = input,
            PrimaryButtonText = "保存",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        var name = input.Text.Trim();
        if (name.Length == 0) return;

        await _manager.RenameServerAsync(session.Id, name);
        if (session.Id == _manager.ActiveServerId) OnActiveServerChanged();
    }

    private async Task ShowAddServerDialogAsync()
    {
        var urlInput = new TextBox
        {
            PlaceholderText = "https://your-worker.workers.dev",
            Style = (Style)Application.Current.Resources["AppTextBoxStyle"],
        };

        var nameInput = new TextBox
        {
            PlaceholderText = "留空则自动读取服务器名称",
            MaxLength = 32,
            Style = (Style)Application.Current.Resources["AppTextBoxStyle"],
        };

        var panel = new StackPanel { Spacing = 10, Width = 380 };
        panel.Children.Add(new TextBlock
        {
            Text = "服务器地址",
            FontSize = 12,
            Foreground = GetBrush("Ink2Brush"),
        });
        panel.Children.Add(urlInput);
        panel.Children.Add(new TextBlock
        {
            Text = "显示名称（可选）",
            FontSize = 12,
            Margin = new Thickness(0, 6, 0, 0),
            Foreground = GetBrush("Ink2Brush"),
        });
        panel.Children.Add(nameInput);
        panel.Children.Add(new TextBlock
        {
            Text = "地址就是网页端打开时用的那个网址。\n桌面端可以添加多台，各自独立登录。",
            FontSize = 11,
            Margin = new Thickness(0, 6, 0, 0),
            TextWrapping = TextWrapping.Wrap,
            Foreground = GetBrush("Ink3Brush"),
        });

        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "添加服务器",
            Content = panel,
            PrimaryButtonText = "添加",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        var url = urlInput.Text.Trim();
        if (url.Length == 0) return;

        try
        {
            var session = await _manager.AddServerAsync(url, nameInput.Text.Trim());
            Toast($"已添加 {session.DisplayName}");

            // 添加后立刻引导登录（没有 key 的话这台服务器用不了）
            await ShowLoginDialogAsync(session);
        }
        catch (ApiException ex)
        {
            await ShowMessageAsync("添加失败", ex.Message);
        }
        catch (Exception ex)
        {
            await ShowMessageAsync("添加失败", ex.Message);
        }
    }

    /// <summary>已经登录过的服务器不用再弹登录框。</summary>
    private async Task PromptLoginIfNeededAsync(ServerSession session)
    {
        if (session.Profile.HasToken) return;
        await ShowLoginDialogAsync(session);
    }

    private async Task ShowLoginDialogAsync(ServerSession session)
    {
        var profile = session.Profile;

        var keyInput = new PasswordBox
        {
            PlaceholderText = "粘贴你的访问 key",
            Style = (Style)Application.Current.Resources["AppPasswordBoxStyle"],
        };
        if (!string.IsNullOrEmpty(profile.Key)) keyInput.Password = profile.Key;

        var nicknameInput = new TextBox
        {
            Text = string.IsNullOrWhiteSpace(profile.Nickname)
                ? _appSettings.Nickname
                : profile.Nickname,
            PlaceholderText = "起一个名字（2–16 字符）",
            MaxLength = 16,
            Style = (Style)Application.Current.Resources["AppTextBoxStyle"],
        };

        var statusText = new TextBlock
        {
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Foreground = GetBrush("Ink3Brush"),
            Visibility = Visibility.Collapsed,
        };

        var panel = new StackPanel { Spacing = 10, Width = 380 };
        panel.Children.Add(new TextBlock
        {
            Text = session.HostDisplay,
            FontSize = 12,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            Foreground = GetBrush("Ink2Brush"),
        });
        panel.Children.Add(new TextBlock
        {
            Text = "访问 Key",
            FontSize = 12,
            Margin = new Thickness(0, 4, 0, 0),
            Foreground = GetBrush("Ink2Brush"),
        });
        panel.Children.Add(keyInput);
        panel.Children.Add(new TextBlock
        {
            Text = "昵称",
            FontSize = 12,
            Margin = new Thickness(0, 4, 0, 0),
            Foreground = GetBrush("Ink2Brush"),
        });
        panel.Children.Add(nicknameInput);

        // 「以管理员身份登录」勾选框。
        //
        // ⚠️ 它**不再**控制是否做验证 —— 服务端现在对访客与管理员一视同仁，
        //    验证一律进行。保留这个勾选框只是为了：
        //      · 让用户明确知道自己填的是管理员 key（改名、封禁等能力更强）；
        //      · 把「管理员」这层含义显式化，避免拿错 key 却不自知。
        var adminCheck = new CheckBox
        {
            Content = "以管理员身份登录（权限更高，人机验证对所有人都是必需的）",
            FontSize = 12,
            IsChecked = _loginAsAdmin,
            Margin = new Thickness(0, 2, 0, 0),
        };
        adminCheck.Checked += (_, _) => _loginAsAdmin = true;
        adminCheck.Unchecked += (_, _) => _loginAsAdmin = false;
        panel.Children.Add(adminCheck);

        panel.Children.Add(statusText);

        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "登录服务器",
            Content = panel,
            PrimaryButtonText = "登录",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };

        // 登录过程中禁用按钮，避免重复提交
        dialog.PrimaryButtonClick += async (s, args) =>
        {
            var deferral = args.GetDeferral();
            try
            {
                var key = keyInput.Password.Trim();
                var nickname = nicknameInput.Text.Trim();

                if (key.Length == 0)
                {
                    args.Cancel = true;
                    ShowStatus(statusText, "请填写访问 key", isError: true);
                    return;
                }

                if (nickname.Length < 2)
                {
                    args.Cancel = true;
                    ShowStatus(statusText, "昵称至少 2 个字符", isError: true);
                    return;
                }

                ShowStatus(statusText, "正在登录…", isError: false);

                // ★ 先完成人机验证拿 token —— **所有身份都要**（访客与管理员一视同仁）。
                //
                //   Turnstile 的 token 只能由浏览器引擎执行 Cloudflare 的 JS 得到
                //   （官方没有 REST API / 原生 SDK），所以这里会短暂弹出一个
                //   WebView2 窗口 —— 这是全项目唯一用到 WebView2 的地方，
                //   且只加载一张本地页面，拿到 token 立即关闭。
                //
                //   仅当部署方设了 LOGIN_TURNSTILE=false 时才会跳过（Required=false）。
                var turnstileToken = await AcquireTurnstileTokenIfNeededAsync(session, key);
                if (turnstileToken.Required && turnstileToken.Token is null)
                {
                    args.Cancel = true;
                    ShowStatus(
                        statusText,
                        turnstileToken.Error ?? "未完成人机验证，无法登录",
                        isError: true);
                    return;
                }

                await _manager.LoginAsync(
                    session.Id,
                    key,
                    nickname,
                    _appSettings.AvatarId,
                    turnstileToken.Token);

                await _settings.UpdateAsync(s => s.Nickname = nickname);

                Toast($"已登录 {session.DisplayName}");
            }
            catch (ApiException ex)
            {
                args.Cancel = true; // 保持对话框打开，让用户改完再试

                // 服务端说验证没通过（token 过期/被消费）：提示用户重试，
                // 下一次点「登录」会重新走一遍验证流程
                ShowStatus(
                    statusText,
                    ex.Code == ErrorCodes.TurnstileFailed
                        ? "人机验证已失效，请重新点击「登录」再验证一次"
                        : DescribeLoginError(ex),
                    isError: true);
            }
            catch (Exception ex)
            {
                args.Cancel = true;
                ShowStatus(statusText, ex.Message, isError: true);
            }
            finally
            {
                deferral.Complete();
            }
        };

        await ShowDialogAsync(dialog);

        // 登录成功与否都刷新一次界面（失败时状态点会变成「需要登录」）
        OnActiveServerChanged();
    }

    /// <summary>
    /// 安全地弹出 ContentDialog。
    ///
    /// ContentDialog 必须挂在已经进入可视化树、且带 XamlRoot 的元素上，
    /// 否则会抛「This element does not have a XamlRoot」—— 而这条异常
    /// 只在 FirstChance 里看得到，界面上表现为「点了按钮没反应」。
    ///
    /// 所以这里统一等一次 RootGrid 的 Loaded，保证 XamlRoot 就绪。
    /// </summary>
    private async Task<ContentDialogResult> ShowDialogAsync(ContentDialog dialog)
    {
        var root = Content as FrameworkElement;

        if (root is not null && root.XamlRoot is null)
        {
            var ready = new TaskCompletionSource();
            void OnLoaded(object sender, RoutedEventArgs e) => ready.TrySetResult();

            root.Loaded += OnLoaded;
            try
            {
                // 已经在树上但尚未 Loaded 时，Loaded 会很快触发；
                // 加超时是防御性的，避免极端情况下永久等待。
                await ready.Task.WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (TimeoutException)
            {
                // 超时就照常尝试 —— 让 WinUI 自己报错，总比静默什么都不做强
            }
            finally
            {
                root.Loaded -= OnLoaded;
            }
        }

        dialog.XamlRoot ??= root?.XamlRoot;
        return await dialog.ShowAsync();
    }

    /// <summary>
    /// 人机验证的获取结果。
    /// <c>Required=false</c> 表示这次登录压根不需要验证（访客 key，或服务端已关闭）。
    /// </summary>
    private readonly record struct TurnstileAcquisition(bool Required, string? Token, string? Error);

    /// <summary>
    /// 判断本次登录是否需要人机验证，需要就弹出验证窗口。
    ///
    /// 这里刻意<b>先问服务端要不要</b>：部署方可以把 <c>LOGIN_TURNSTILE</c>
    /// 设为 false 整体关掉验证，那时硬弹窗口会直接卡死登录。
    /// 判断依据是 <c>GET /api/auth/config</c> 返回的 <c>loginTurnstile</c>
    /// 与 <c>turnstileSiteKey</c>。
    /// </summary>
    private async Task<TurnstileAcquisition> AcquireTurnstileTokenIfNeededAsync(
        ServerSession session,
        string key)
    {
        ClientConfig config;
        try
        {
            config = await session.Api.GetConfigAsync();
        }
        catch (ApiException)
        {
            // 配置拉不到：不阻断登录，直接不带 token 试一次。
            // 服务端若真要求验证会返回 TURNSTILE_FAILED，界面会提示重试。
            return new TurnstileAcquisition(false, null, null);
        }

        // 服务端关掉了验证 → 不需要。
        // 新字段优先；老服务端只有 adminLoginTurnstile，回退到它。
        var required = config.LoginTurnstile ?? config.AdminLoginTurnstile ?? true;
        if (!required) return new TurnstileAcquisition(false, null, null);

        // 没配 Site Key → 无法渲染验证组件。
        // 这属于部署配置问题，给出明确指引比抛异常有用。
        if (string.IsNullOrWhiteSpace(config.TurnstileSiteKey))
        {
            return new TurnstileAcquisition(
                true,
                null,
                "服务端要求人机验证，但没有下发 Site Key。请联系部署方检查 Turnstile 配置。");
        }

        // ★ 验证对所有身份都必需（访客与管理员一视同仁）。
        //
        //   原先这里用「以管理员身份登录」勾选框来决定要不要弹验证 ——
        //   那个设计的前提是「只有管理员要验」。服务端改为全员验证后，
        //   勾选框就不再是「要不要验证」的开关，验证一律进行。
        //
        //   登录框里仍保留它，但语义改为「提示服务端我将用管理员 key」，
        //   不影响是否验证。

        var dark = Content is FrameworkElement { ActualTheme: ElementTheme.Dark };
        var window = new Views.TurnstileWindow(
            config.TurnstileSiteKey,
            session.DisplayName,
            dark,
            // 服务器 baseUrl：承载页要跑在这个域名下，Turnstile 的域名校验才过得去
            session.Api.BaseUrl);

        // 让验证窗口居中于主窗口，避免出现在屏幕角落
        CenterChildWindow(window);

        window.Activate();

        var outcome = await window.WaitAsync();

        return outcome.Success
            ? new TurnstileAcquisition(true, outcome.Token, null)
            : new TurnstileAcquisition(true, null, outcome.Error);
    }

    /// <summary>把子窗口大致居中到主窗口上。</summary>
    private void CenterChildWindow(Window child)
    {
        try
        {
            var host = AppWindow;
            var hostPos = host.Position;
            var hostSize = host.Size;
            var childSize = child.AppWindow.Size;

            child.AppWindow.Move(new Windows.Graphics.PointInt32(
                hostPos.X + Math.Max(0, (hostSize.Width - childSize.Width) / 2),
                hostPos.Y + Math.Max(0, (hostSize.Height - childSize.Height) / 2)));
        }
        catch
        {
            // 移动失败无所谓，窗口出现在默认位置也能用
        }
    }

    /// <summary>本次登录是否勾选了「以管理员身份登录」（决定要不要人机验证）。</summary>
    private bool _loginAsAdmin;

    /// <summary>把错误码翻译成用户能照做的提示（与网页端登录页一致）。</summary>
    private static string DescribeLoginError(ApiException ex) => ex.Code switch
    {
        ErrorCodes.InvalidKey => "key 无效，请检查后重试",
        ErrorCodes.NicknameTaken => "这个昵称已经被占用了，换一个",
        ErrorCodes.NicknameReserved => "这个昵称是保留字，换一个",
        ErrorCodes.NicknameInvalid => "昵称格式不合法（2–16 字符，中英文/数字/下划线/短横线/空格）",
        ErrorCodes.RateLimited => "尝试太频繁了，请稍后再试",
        ErrorCodes.TurnstileFailed => "需要完成人机验证（管理员 key 强制要求）",
        ErrorCodes.Banned => "你已被移出这台服务器",
        _ => ex.Message,
    };

    private static void ShowStatus(TextBlock target, string message, bool isError)
    {
        target.Text = message;
        target.Foreground = isError ? GetBrush("DownBrush") : GetBrush("Ink3Brush");
        target.Visibility = Visibility.Visible;
    }

    // ============================================================
    //  房间操作
    // ============================================================

    private async Task EnterRoomAsync(string roomId)
    {
        var session = _manager.Active;
        if (session is null) return;

        try
        {
            await session.Api.JoinRoomAsync(roomId);
            session.SetCurrentRoom(roomId);
            _joinedAt = DateTimeOffset.Now;
            _muted = false;

            RoomViewControl.HideNotice();
            RefreshActive();
            Toast($"已进入房间");
        }
        catch (ApiException ex)
        {
            var message = ex.Code switch
            {
                ErrorCodes.RoomFull => "房间已满，换一个吧",
                ErrorCodes.RoomNotFound => "房间不存在，列表可能已更新",
                _ => ex.Message,
            };
            RoomViewControl.ShowNotice(message);
        }
    }

    private async Task LeaveRoomAsync()
    {
        var session = _manager.Active;
        if (session?.CurrentRoomId is not { Length: > 0 } roomId) return;

        try
        {
            await session.Api.LeaveRoomAsync(roomId);
        }
        catch (ApiException)
        {
            // 离开失败也让本地状态先归位：否则界面会卡在「在房间里」
        }

        session.SetCurrentRoom(null);
        _joinedAt = null;
        RefreshActive();
        Toast("已离开房间");
    }

    private async Task ToggleMuteAsync()
    {
        var session = _manager.Active;
        if (session?.CurrentRoomId is not { Length: > 0 } roomId) return;

        _muted = !_muted;

        try
        {
            await session.Api.SetMutedAsync(roomId, _muted);
        }
        catch (ApiException)
        {
            // 上报失败不影响本地静音状态；下一次心跳后会重新对齐
        }

        RefreshActive();
    }

    private async Task HandleRoomActionAsync(RoomActionEventArgs e)
    {
        var session = _manager.Active;
        if (session is null) return;

        switch (e.Action)
        {
            case RoomAction.CopyId:
                CopyToClipboard(e.RoomId);
                Toast("房间 ID 已复制");
                break;

            case RoomAction.Settings:
                await ShowRoomSettingsDialogAsync(session, e.RoomId);
                break;

            case RoomAction.Delete:
                await ConfirmDeleteRoomAsync(session, e.RoomId);
                break;
        }
    }

    private async Task ShowCreateRoomDialogAsync()
    {
        var session = _manager.Active;
        if (session is null) return;

        var nameInput = new TextBox
        {
            Text = string.IsNullOrWhiteSpace(session.Profile.Nickname)
                ? "新房间"
                : $"{session.Profile.Nickname}的房间",
            MaxLength = 32,
            Style = (Style)Application.Current.Resources["AppTextBoxStyle"],
        };

        var limitInput = new NumberBox
        {
            Value = 10,
            Minimum = 2,
            Maximum = 50,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact,
        };

        var panel = new StackPanel { Spacing = 10, Width = 360 };
        panel.Children.Add(new TextBlock { Text = "房间名", FontSize = 12, Foreground = GetBrush("Ink2Brush") });
        panel.Children.Add(nameInput);
        panel.Children.Add(new TextBlock
        {
            Text = "人数上限",
            FontSize = 12,
            Margin = new Thickness(0, 6, 0, 0),
            Foreground = GetBrush("Ink2Brush"),
        });
        panel.Children.Add(limitInput);

        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "新建房间",
            Content = panel,
            PrimaryButtonText = "创建",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        var name = nameInput.Text.Trim();
        if (name.Length == 0) return;

        try
        {
            var result = await session.Api.CreateRoomAsync(name, (int)limitInput.Value);

            // room 可空：服务端正常都会带，缺了就只提示成功、不自动进房
            if (result.Room is { } created)
            {
                Toast($"已创建房间「{created.Name}」");
                await EnterRoomAsync(created.Id);
            }
            else
            {
                Toast("房间已创建");
            }
        }
        catch (ApiException ex)
        {
            await ShowMessageAsync("创建失败", ex.Message);
        }
    }

    private async Task ShowRoomSettingsDialogAsync(ServerSession session, string roomId)
    {
        var room = session.Rooms.FirstOrDefault(r => r.Id == roomId);
        if (room is null) return;

        var nameInput = new TextBox
        {
            Text = room.Name,
            MaxLength = 32,
            Style = (Style)Application.Current.Resources["AppTextBoxStyle"],
        };

        var limitInput = new NumberBox
        {
            Value = room.MaxMembers,
            Minimum = 2,
            Maximum = 50,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact,
        };

        var panel = new StackPanel { Spacing = 10, Width = 360 };
        panel.Children.Add(new TextBlock { Text = "房间名", FontSize = 12, Foreground = GetBrush("Ink2Brush") });
        panel.Children.Add(nameInput);
        panel.Children.Add(new TextBlock
        {
            Text = "人数上限",
            FontSize = 12,
            Margin = new Thickness(0, 6, 0, 0),
            Foreground = GetBrush("Ink2Brush"),
        });
        panel.Children.Add(limitInput);

        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "房间设置",
            Content = panel,
            PrimaryButtonText = "保存",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        try
        {
            await session.Api.UpdateRoomAsync(roomId, nameInput.Text.Trim(), (int)limitInput.Value);
            Toast("房间已更新");
        }
        catch (ApiException ex)
        {
            await ShowMessageAsync("更新失败", ex.Message);
        }
    }

    private async Task ConfirmDeleteRoomAsync(ServerSession session, string roomId)
    {
        var room = session.Rooms.FirstOrDefault(r => r.Id == roomId);
        if (room is null) return;

        var live = room.MemberCount > 0;
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "删除房间",
            Content = live
                ? $"确定删除「{room.Name}」吗？\n\n里面还有 {room.MemberCount} 人，会被立刻断开连接。此操作不可恢复。"
                : $"确定删除「{room.Name}」吗？此操作不可恢复。",
            PrimaryButtonText = "删除",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        try
        {
            await session.Api.DeleteRoomAsync(roomId);

            // 删掉的正是自己所在的房间 → 回总览
            if (session.CurrentRoomId == roomId)
            {
                session.SetCurrentRoom(null);
                _joinedAt = null;
            }

            Toast($"已删除「{room.Name}」");
            RefreshActive();
        }
        catch (ApiException ex)
        {
            await ShowMessageAsync("删除失败", ex.Message);
        }
    }

    // ============================================================
    //  成员操作
    // ============================================================

    private async Task InviteAsync(PresenceUser user)
    {
        var session = _manager.Active;
        if (session?.CurrentRoomId is not { Length: > 0 } roomId)
        {
            Toast("先进入一个房间才能邀请别人", isError: true);
            return;
        }

        try
        {
            var result = await session.Api.PresenceInviteAsync(user.Uid, roomId);
            Toast(result.Sent ? $"已邀请 {user.Nickname}" : result.Reason ?? "邀请未发送");
        }
        catch (ApiException ex)
        {
            Toast(ex.Message, isError: true);
        }
    }

    private void FollowUser(PresenceUser user)
    {
        if (string.IsNullOrEmpty(user.RoomId))
        {
            Toast($"{user.Nickname} 还没进入房间", isError: true);
            return;
        }

        if (user.RoomId == _manager.Active?.CurrentRoomId)
        {
            Toast($"已经和 {user.Nickname} 在同一个房间了");
            return;
        }

        _ = EnterRoomAsync(user.RoomId);
    }

    private async Task KickAsync(PresenceUser user)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "踢出服务器",
            Content = $"确定把「{user.Nickname}」踢出服务器吗？\n\n" +
                      "会立即断开 TA 的连接并封禁该昵称（可在后台解除）。",
            PrimaryButtonText = "踢出",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        try
        {
            var session = _manager.Active;
            if (session is null) return;

            await session.Api.PresenceKickAsync(user.Uid, "被管理员踢出服务器");
            Toast($"已把 {user.Nickname} 踢出服务器");
            MemberRailControl.Refresh();
        }
        catch (ApiException ex)
        {
            Toast(ex.Message, isError: true);
        }
    }

    private void OnInvited(ServerInviteEventArgs e)
    {
        // 多服务器下必须说清是哪台服的邀请，否则用户没法判断要不要去
        _ = ShowInviteDialogAsync(e);
    }

    private async Task ShowInviteDialogAsync(ServerInviteEventArgs e)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "收到邀请",
            Content = $"{e.Invite.FromNickname} 邀请你加入「{e.Invite.RoomName}」\n\n" +
                      $"来自服务器：{e.ServerName}",
            PrimaryButtonText = "接受",
            CloseButtonText = "忽略",
            DefaultButton = ContentDialogButton.Primary,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        // 接受邀请要切到发出邀请的那台服务器，再进房间
        await _manager.SetActiveAsync(e.ServerId);
        await EnterRoomAsync(e.Invite.RoomId);
    }

    // ============================================================
    //  设置 / 登出
    // ============================================================

    private async Task LogoutActiveAsync()
    {
        var session = _manager.Active;
        if (session is null) return;

        await _manager.LogoutAsync(session.Id);
        _joinedAt = null;
        RefreshActive();
        Toast($"已登出 {session.DisplayName}");
    }

    private async Task ShowSettingsDialogAsync()
    {
        var settings = await _settings.LoadAsync();
        var session = _manager.Active;

        var nicknameInput = new TextBox
        {
            Text = session?.Profile.Nickname ?? settings.Nickname,
            MaxLength = 16,
            Style = (Style)Application.Current.Resources["AppTextBoxStyle"],
            IsEnabled = session?.Profile.HasToken == true,
        };

        var soundToggle = new ToggleSwitch
        {
            IsOn = settings.SoundEffects,
            OnContent = "开启",
            OffContent = "关闭",
        };

        var statusCombo = new ComboBox
        {
            Style = (Style)Application.Current.Resources["AppComboBoxStyle"],
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        statusCombo.Items.Add("在线");
        statusCombo.Items.Add("忙碌");
        statusCombo.Items.Add("离开");
        statusCombo.Items.Add("隐身");
        statusCombo.SelectedIndex = settings.PresenceStatus switch
        {
            PresenceStatus.Busy => 1,
            PresenceStatus.Away => 2,
            PresenceStatus.Invisible => 3,
            _ => 0,
        };

        var invitableToggle = new ToggleSwitch
        {
            IsOn = settings.Invitable,
            OnContent = "允许",
            OffContent = "不允许",
        };

        var panel = new StackPanel { Spacing = 12, Width = 400 };

        panel.Children.Add(SectionLabel("服务器信息"));
        panel.Children.Add(new TextBlock
        {
            Text = session is null
                ? "未选择服务器"
                : $"{session.DisplayName}\n{session.HostDisplay}\n{settings.Nickname}",
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Foreground = GetBrush("Ink2Brush"),
        });

        panel.Children.Add(SectionLabel("昵称"));
        panel.Children.Add(nicknameInput);

        panel.Children.Add(SectionLabel("在线状态"));
        panel.Children.Add(statusCombo);

        panel.Children.Add(SectionLabel("允许别人邀请我"));
        panel.Children.Add(invitableToggle);

        panel.Children.Add(SectionLabel("界面音效"));
        panel.Children.Add(soundToggle);

        panel.Children.Add(new TextBlock
        {
            Text = $"数据目录：{AppPaths.DataDirectory}",
            FontSize = 11,
            Margin = new Thickness(0, 8, 0, 0),
            TextWrapping = TextWrapping.Wrap,
            Foreground = GetBrush("Ink3Brush"),
        });

        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "设置",
            Content = new ScrollViewer { Content = panel, MaxHeight = 460 },
            PrimaryButtonText = "保存",
            CloseButtonText = "关闭",
            DefaultButton = ContentDialogButton.Primary,
        };

        if (await ShowDialogAsync(dialog) != ContentDialogResult.Primary) return;

        var newStatus = statusCombo.SelectedIndex switch
        {
            1 => PresenceStatus.Busy,
            2 => PresenceStatus.Away,
            3 => PresenceStatus.Invisible,
            _ => PresenceStatus.Online,
        };

        await _settings.UpdateAsync(s =>
        {
            s.SoundEffects = soundToggle.IsOn;
            s.PresenceStatus = newStatus;
            s.Invitable = invitableToggle.IsOn;
        });

        // 改昵称是「改资料」而不是「改本地偏好」：要同步到服务端
        var newNickname = nicknameInput.Text.Trim();
        if (session is not null &&
            session.Profile.HasToken &&
            newNickname.Length >= 2 &&
            newNickname != session.Profile.Nickname)
        {
            try
            {
                await session.Api.UpdateMeAsync(new UpdateProfileRequest { Nickname = newNickname });
                await _settings.UpdateAsync(s => s.Nickname = newNickname);
                Toast("昵称已更新");
            }
            catch (ApiException ex)
            {
                await ShowMessageAsync("昵称更新失败", ex.Message);
            }
        }

        RefreshActive();
    }

    private static TextBlock SectionLabel(string text) => new()
    {
        Text = text,
        FontSize = 12,
        Margin = new Thickness(0, 4, 0, -4),
        Foreground = GetBrush("Ink2Brush"),
    };

    // ============================================================
    //  通用 UI 辅助
    // ============================================================

    private async Task ShowMessageAsync(string title, string message)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = title,
            Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
            CloseButtonText = "知道了",
        };

        await ShowDialogAsync(dialog);
    }

    private static void CopyToClipboard(string text)
    {
        try
        {
            var package = new DataPackage();
            package.SetText(text);
            Clipboard.SetContent(package);
        }
        catch
        {
            // 剪贴板被占用等情况：静默失败，不值得为它弹框
        }
    }

    /// <summary>
    /// 右下角轻提示。
    ///
    /// 用浮层而不是 ContentDialog：心跳失败、邀请之类的提示很频繁，
    /// 每次都弹模态框会把人逼疯。
    /// </summary>
    private void Toast(string message, bool isError = false)
    {
        var border = new Border
        {
            Margin = new Thickness(0, 0, 0, 6),
            Padding = new Thickness(14, 8, 14, 8),
            CornerRadius = new CornerRadius(999),
            Background = GetBrush("SurfaceBrush"),
            BorderThickness = new Thickness(1),
            BorderBrush = isError ? GetBrush("DownBrush") : GetBrush("LineBrush"),
        };

        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 7 };
        row.Children.Add(new FontIcon
        {
            Glyph = isError ? "\uE783" : "\uE73E",
            FontSize = 12,
            Foreground = isError ? GetBrush("DownBrush") : GetBrush("UpBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        });
        row.Children.Add(new TextBlock
        {
            Text = message,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = isError ? GetBrush("DownBrush") : GetBrush("InkBrush"),
        });

        border.Child = row;
        ToastHost.Items.Add(border);

        // 4 秒后自动消失（与网页端一致）
        var timer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(4);
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            ToastHost.Items.Remove(border);
        };
        timer.Start();
    }

    private static Brush GetBrush(string key)
    {
        if (Application.Current.Resources.TryGetValue(key, out var value) && value is Brush brush)
        {
            return brush;
        }

        var dark = Application.Current.RequestedTheme == ApplicationTheme.Dark;
        return new SolidColorBrush(key switch
        {
            "AccentBrush" => dark ? Color.FromArgb(255, 77, 116, 255) : Color.FromArgb(255, 31, 71, 230),
            "DownBrush" => dark ? Color.FromArgb(255, 248, 113, 113) : Color.FromArgb(255, 239, 68, 68),
            "UpBrush" => dark ? Color.FromArgb(255, 52, 211, 153) : Color.FromArgb(255, 16, 185, 129),
            "InkBrush" => dark ? Color.FromArgb(255, 241, 245, 249) : Color.FromArgb(255, 15, 23, 42),
            "Ink2Brush" => dark ? Color.FromArgb(255, 163, 174, 195) : Color.FromArgb(255, 71, 85, 105),
            "Ink3Brush" => dark ? Color.FromArgb(255, 107, 118, 145) : Color.FromArgb(255, 148, 163, 184),
            "SurfaceBrush" => dark ? Color.FromArgb(255, 20, 27, 45) : Colors.White,
            "LineBrush" => dark ? Color.FromArgb(255, 38, 47, 71) : Color.FromArgb(255, 226, 232, 240),
            _ => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
        });
    }
}

