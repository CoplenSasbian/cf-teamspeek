using CfTeamspeed.Desktop.Services;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace CfTeamspeed.Desktop.Controls;

/// <summary>
/// ★ 服务器栏 —— 桌面端独有的一栏（网页端一个部署就是一台服务器，没有这一栏）。
///
/// 为什么用代码构建图标而不是 XAML DataTemplate + 绑定：
///   每个图标要叠加「选中态 / 悬浮态 / 未读 / 状态点 / 在线人数 / 首字母底色」六层，
///   用 DataTemplate 表达需要大量绑定转换器，反而比直接建视觉树更难读。
///   图标数量是「个位数」，重建成本可以忽略，所以每次列表变化整体重建。
///
/// 交互与 KOOK / Discord 对齐：
///   左键 = 切换；右键 = 菜单；中间 hover 显示 Tooltip（服务器名 + 地址 + 状态）。
/// </summary>
public sealed partial class ServerRail : UserControl
{
    private ServerManager? _manager;

    /// <summary>请求添加服务器（由主窗口弹对话框）。</summary>
    public event EventHandler? AddServerRequested;

    /// <summary>请求打开设置。</summary>
    public event EventHandler? SettingsRequested;

    /// <summary>请求对某台服务器执行操作（右键菜单里选中的项）。</summary>
    public event EventHandler<ServerRailActionEventArgs>? ServerActionRequested;

    public ServerRail()
    {
        InitializeComponent();

        AddServerButton.Click += (_, _) => AddServerRequested?.Invoke(this, EventArgs.Empty);
        SettingsButton.Click += (_, _) => SettingsRequested?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>绑定多服务器总控（主窗口在初始化后调用）。</summary>
    public void Attach(ServerManager manager)
    {
        ArgumentNullException.ThrowIfNull(manager);

        if (_manager is not null)
        {
            _manager.ServersChanged -= OnServersChanged;
            _manager.ServerStateChanged -= OnServerStateChanged;
        }

        _manager = manager;
        _manager.ServersChanged += OnServersChanged;
        _manager.ServerStateChanged += OnServerStateChanged;

        Rebuild();
    }

    private void OnServersChanged(object? sender, EventArgs e) => Rebuild();

    /// <summary>
    /// 状态变化只改对应图标的角标，不整体重建 ——
    /// 状态变化很频繁（心跳失败/恢复），整体重建会让悬浮态和右键菜单闪掉。
    /// </summary>
    private void OnServerStateChanged(object? sender, ServerStateChangedEventArgs e)
    {
        foreach (var child in ServerItemsHost.Children)
        {
            if (child is Grid grid && grid.Tag is string id && id == e.ServerId)
            {
                UpdateStatusDot(grid, e.State);
                return;
            }
        }
    }

    // ============================================================
    //  构建
    // ============================================================

    private void Rebuild()
    {
        ServerItemsHost.Children.Clear();
        if (_manager is null) return;

        var sessions = _manager.Sessions;
        var activeId = _manager.ActiveServerId;

        foreach (var session in sessions)
        {
            ServerItemsHost.Children.Add(BuildServerIcon(session, session.Id == activeId));
        }
    }

    /// <summary>
    /// 单个服务器图标。
    ///
    /// 视觉结构（自外向内）：
    ///   Grid(44x50)
    ///     ├ 选中指示条（左侧 3x20 圆角，仅当前服务器可见）
    ///     ├ 圆角方块（44x44，内含首字母 / 图标）
    ///     ├ 状态点（左下角，颜色表示连接状态）
    ///     └ 在线人数徽标（右下角，>0 时显示）
    /// </summary>
    private Grid BuildServerIcon(ServerSession session, bool isActive)
    {
        var profile = session.Profile;
        var accent = GetBrush("AccentBrush");
        var surface2 = GetBrush("Surface2Brush");
        var surface3 = GetBrush("Surface3Brush");
        var ink = GetBrush("InkBrush");
        var ink3 = GetBrush("Ink3Brush");

        var root = new Grid
        {
            Width = 52,
            Height = 50,
            Tag = session.Id,
            Background = new SolidColorBrush(Colors.Transparent),
        };

        // ---- 选中指示条（当前服务器左侧的小竖条，Discord 同款） ----
        var indicator = new Border
        {
            Width = 3,
            Height = isActive ? 22 : 6,
            CornerRadius = new CornerRadius(0, 2, 2, 0),
            Background = ink,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
            Opacity = isActive ? 1 : 0,
        };
        root.Children.Add(indicator);

        // ---- 图标主体 ----
        var tile = new Border
        {
            Width = 44,
            Height = 44,
            CornerRadius = new CornerRadius(14),
            Background = isActive ? accent : surface2,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };

        // 图标内容：优先显示名的首字（中文友好），没有名字则用主机名首字
        var label = new TextBlock
        {
            Text = FirstGlyph(session.DisplayName),
            FontSize = 17,
            FontWeight = FontWeights.SemiBold,
            Foreground = isActive ? new SolidColorBrush(Colors.White) : ink,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        tile.Child = label;
        root.Children.Add(tile);

        // ---- 连接状态点（左下角） ----
        var statusDot = new Ellipse
        {
            Width = 11,
            Height = 11,
            Stroke = surface2,
            StrokeThickness = 2,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(2, 0, 0, 2),
            Fill = StatusBrush(session.State),
        };
        statusDot.Name = "StatusDot";
        root.Children.Add(statusDot);

        // ---- 在线人数徽标（右下角，仅 >0 显示） ----
        var onlineCount = CountOnline(session);
        if (onlineCount > 0)
        {
            var badge = new Border
            {
                MinWidth = 18,
                Height = 16,
                CornerRadius = new CornerRadius(8),
                Background = GetBrush("UpBrush"),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(0, 0, 1, 1),
                Padding = new Thickness(4, 0, 4, 0),
                Child = new TextBlock
                {
                    Text = onlineCount > 99 ? "99+" : onlineCount.ToString(),
                    FontSize = 9,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = new SolidColorBrush(Colors.White),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                },
            };
            root.Children.Add(badge);
        }

        // ---- 交互 ----
        var tooltip = BuildTooltip(session);
        ToolTipService.SetToolTip(root, tooltip);

        root.PointerEntered += (_, _) =>
        {
            if (!isActive) tile.Background = surface3;
            indicator.Opacity = 1;
        };
        root.PointerExited += (_, _) =>
        {
            if (!isActive) tile.Background = surface2;
            indicator.Opacity = isActive ? 1 : 0;
        };

        root.Tapped += (_, _) => _ = ActivateAsync(session.Id);

        // 右键菜单：多服务器下「针对某一台」的操作必须能局部执行
        root.RightTapped += (_, e) =>
        {
            e.Handled = true;
            ShowContextMenu(root, session, e);
        };

        _ = ink3;
        return root;
    }

    /// <summary>悬浮提示：显示名 + 地址 + 状态（多服务器时地址是唯一可靠的区分）。</summary>
    private static ToolTip BuildTooltip(ServerSession session)
    {
        var panel = new StackPanel { Spacing = 3 };

        panel.Children.Add(new TextBlock
        {
            Text = session.DisplayName,
            FontWeight = FontWeights.SemiBold,
            FontSize = 13,
        });

        panel.Children.Add(new TextBlock
        {
            Text = session.HostDisplay,
            FontSize = 11,
            Opacity = 0.75,
        });

        var profile = session.Profile;
        var detail = session.State switch
        {
            ServerConnectionState.Online => profile.Nickname is { Length: > 0 } n ? $"已登录：{n}" : "在线",
            ServerConnectionState.Connecting => "连接中…",
            ServerConnectionState.Degraded => "连接不稳定，正在重试",
            ServerConnectionState.SignedOut => "需要登录",
            ServerConnectionState.Banned => "已被移出该服务器",
            _ => "未连接",
        };

        panel.Children.Add(new TextBlock
        {
            Text = detail,
            FontSize = 11,
            Opacity = 0.85,
        });

        return new ToolTip { Content = panel };
    }

    private async Task ActivateAsync(string serverId)
    {
        if (_manager is null) return;

        try
        {
            await _manager.SetActiveAsync(serverId);
        }
        catch (Exception)
        {
            // 切换失败不该弹框：状态点与提示已经反映了真实情况
        }
    }

    // ============================================================
    //  右键菜单
    // ============================================================

    private void ShowContextMenu(UIElement target, ServerSession session, RightTappedRoutedEventArgs e)
    {
        var profile = session.Profile;
        var menu = new MenuFlyout();

        var loginItem = new MenuFlyoutItem
        {
            Text = profile.HasToken ? "重新登录…" : "登录…",
            Icon = new FontIcon { Glyph = "\uE77B" },
        };
        loginItem.Click += (_, _) => Raise(session.Id, ServerRailAction.Login);
        menu.Items.Add(loginItem);

        menu.Items.Add(new MenuFlyoutSeparator());

        var renameItem = new MenuFlyoutItem
        {
            Text = "重命名…",
            Icon = new FontIcon { Glyph = "\uE8AC" },
        };
        renameItem.Click += (_, _) => Raise(session.Id, ServerRailAction.Rename);
        menu.Items.Add(renameItem);

        var copyItem = new MenuFlyoutItem
        {
            Text = "复制服务器地址",
            Icon = new FontIcon { Glyph = "\uE8C8" },
        };
        copyItem.Click += (_, _) => Raise(session.Id, ServerRailAction.CopyAddress);
        menu.Items.Add(copyItem);

        // 已登录才有「登出」的意义
        if (profile.HasToken)
        {
            var logoutItem = new MenuFlyoutItem
            {
                Text = "登出此服务器",
                Icon = new FontIcon { Glyph = "\uF3B1" },
            };
            logoutItem.Click += (_, _) => Raise(session.Id, ServerRailAction.Logout);
            menu.Items.Add(logoutItem);
        }

        menu.Items.Add(new MenuFlyoutSeparator());

        var removeItem = new MenuFlyoutItem
        {
            Text = "移除服务器",
            Icon = new FontIcon { Glyph = "\uE74D" },
        };
        removeItem.Click += (_, _) => Raise(session.Id, ServerRailAction.Remove);
        menu.Items.Add(removeItem);

        menu.ShowAt(target, new Microsoft.UI.Xaml.Controls.Primitives.FlyoutShowOptions
        {
            Position = e.GetPosition(target),
        });
    }

    private void Raise(string serverId, ServerRailAction action) =>
        ServerActionRequested?.Invoke(this, new ServerRailActionEventArgs(serverId, action));

    // ============================================================
    //  小工具
    // ============================================================

    /// <summary>状态点颜色：与网页端的 up / warn / down 语义保持一致。</summary>
    private static Brush StatusBrush(ServerConnectionState state) => state switch
    {
        ServerConnectionState.Online => GetBrush("UpBrush"),
        ServerConnectionState.Connecting => GetBrush("WarnBrush"),
        ServerConnectionState.Degraded => GetBrush("WarnBrush"),
        ServerConnectionState.Banned => GetBrush("DownBrush"),
        ServerConnectionState.SignedOut => GetBrush("Ink3Brush"),
        _ => GetBrush("Ink3Brush"),
    };

    private void UpdateStatusDot(Grid root, ServerConnectionState state)
    {
        foreach (var child in root.Children)
        {
            if (child is Ellipse { Name: "StatusDot" } dot)
            {
                dot.Fill = StatusBrush(state);
                return;
            }
        }
    }

    /// <summary>该服务器的在线人数（名册里 online=true 的数量）。</summary>
    private static int CountOnline(ServerSession session)
    {
        var presence = session.Presence;
        if (presence is null) return 0;
        return presence.Online.Count;
    }

    /// <summary>取首个「字」（含中文 / emoji），与网页端 Avatar 的首字逻辑一致。</summary>
    private static string FirstGlyph(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "?";

        var trimmed = text.Trim();
        var runes = trimmed.EnumerateRunes();
        foreach (var rune in runes)
        {
            return rune.ToString().ToUpperInvariant();
        }
        return "?";
    }

    /// <summary>
    /// 从应用资源取画刷。
    ///
    /// 注意 <c>ThemeDictionaries</c> 里的 key <b>不能</b>用
    /// <c>Application.Current.Resources.TryGetValue</c> 直接取到 ——
    /// 那是「当前主题字典」里的条目，必须走 FrameworkElement.Resources 的
    /// 解析链（即让 XAML 里的 {ThemeResource} 去解析）。
    ///
    /// 代码构建视觉树时没有 {ThemeResource} 可用，所以这里做一个显式兜底表：
    /// 颜色值与 Themes/Colors.xaml 保持一致，主题切换时重建即可。
    /// </summary>
    private static Brush GetBrush(string key)
    {
        // 先试应用级资源（Brushes.xaml 合并进来后，部分画刷是可直接命中的）
        if (Application.Current.Resources.TryGetValue(key, out var value) && value is Brush brush)
        {
            return brush;
        }

        // 按当前主题取色（深色下用深色一组，避免代码构建的图标在深色主题下发白）
        var dark = Application.Current.RequestedTheme == ApplicationTheme.Dark;
        return new SolidColorBrush(ThemeColor(key, dark));
    }

    /// <summary>与 Themes/Colors.xaml 对应的取色表。</summary>
    private static Color ThemeColor(string key, bool dark) => key switch
    {
        "AccentBrush" => dark ? Color.FromArgb(255, 77, 116, 255) : Color.FromArgb(255, 31, 71, 230),
        "AccentSoftBrush" => dark ? Color.FromArgb(255, 27, 38, 71) : Color.FromArgb(255, 238, 244, 255),
        "UpBrush" => dark ? Color.FromArgb(255, 52, 211, 153) : Color.FromArgb(255, 16, 185, 129),
        "WarnBrush" => dark ? Color.FromArgb(255, 251, 191, 36) : Color.FromArgb(255, 245, 158, 11),
        "DownBrush" => dark ? Color.FromArgb(255, 248, 113, 113) : Color.FromArgb(255, 239, 68, 68),
        "InkBrush" => dark ? Color.FromArgb(255, 241, 245, 249) : Color.FromArgb(255, 15, 23, 42),
        "Ink2Brush" => dark ? Color.FromArgb(255, 163, 174, 195) : Color.FromArgb(255, 71, 85, 105),
        "Ink3Brush" => dark ? Color.FromArgb(255, 107, 118, 145) : Color.FromArgb(255, 148, 163, 184),
        "SurfaceBrush" => dark ? Color.FromArgb(255, 20, 27, 45) : Colors.White,
        "Surface2Brush" => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
        "Surface3Brush" => dark ? Color.FromArgb(255, 39, 48, 73) : Color.FromArgb(255, 226, 232, 240),
        "LineBrush" => dark ? Color.FromArgb(255, 38, 47, 71) : Color.FromArgb(255, 226, 232, 240),
        _ => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
    };
}

/// <summary>服务器栏上可执行的操作。</summary>
public enum ServerRailAction
{
    Login,
    Logout,
    Rename,
    CopyAddress,
    Remove,
}

public sealed class ServerRailActionEventArgs : EventArgs
{
    public ServerRailActionEventArgs(string serverId, ServerRailAction action)
    {
        ServerId = serverId;
        Action = action;
    }

    public string ServerId { get; }

    public ServerRailAction Action { get; }
}
