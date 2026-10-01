using CfTeamspeed.Desktop.Models;
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
/// ② 房间列表栏。
///
/// 数据来源是【当前激活的服务器会话】—— 切服务器时整体刷新。
/// 房间行用代码构建：一行里要同时表达「展开/收起」「有人/没人」「当前房间」
/// 「成员头像列表」「右键菜单」，用 DataTemplate 反而更绕。
/// </summary>
public sealed partial class RoomSidebar : UserControl
{
    private ServerSession? _session;

    /// <summary>用户点了某个房间（请求进入）。</summary>
    public event EventHandler<string>? RoomSelected;

    /// <summary>请求新建房间。</summary>
    public event EventHandler? CreateRoomRequested;

    /// <summary>请求刷新房间列表。</summary>
    public event EventHandler? RefreshRequested;

    /// <summary>请求登出当前服务器。</summary>
    public event EventHandler? LogoutRequested;

    /// <summary>请求打开账号设置。</summary>
    public event EventHandler? ProfileRequested;

    /// <summary>请求静音切换。</summary>
    public event EventHandler? ToggleMuteRequested;

    /// <summary>请求离开当前房间。</summary>
    public event EventHandler? LeaveRoomRequested;

    /// <summary>请求对房间执行操作（右键菜单）。</summary>
    public event EventHandler<RoomActionEventArgs>? RoomActionRequested;

    /// <summary>展开的房间 id（手风琴式，允许多个展开）。</summary>
    private readonly HashSet<string> _expanded = new(StringComparer.Ordinal);

    private bool _muted;
    private bool _inRoom;
    private bool _connected;
    private bool _connecting;
    private DateTimeOffset? _joinedAt;

    public RoomSidebar()
    {
        InitializeComponent();

        RefreshButton.Click += (_, _) => RefreshRequested?.Invoke(this, EventArgs.Empty);
        CreateRoomButton.Click += (_, _) => CreateRoomRequested?.Invoke(this, EventArgs.Empty);
        LogoutButton.Click += (_, _) => LogoutRequested?.Invoke(this, EventArgs.Empty);
        ProfileButton.Click += (_, _) => ProfileRequested?.Invoke(this, EventArgs.Empty);
        MuteButton.Click += (_, _) => ToggleMuteRequested?.Invoke(this, EventArgs.Empty);
        LeaveButton.Click += (_, _) => LeaveRoomRequested?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>绑定当前激活的会话（可为 null = 没有服务器）。</summary>
    public void Attach(ServerSession? session)
    {
        _session = session;
        _expanded.Clear();
        Refresh();
    }

    /// <summary>更新语音状态（由主窗口在进/退房、静音、连接状态变化时推送）。</summary>
    public void SetVoiceState(bool inRoom, bool muted, bool connected, bool connecting, string? roomName, DateTimeOffset? joinedAt)
    {
        _inRoom = inRoom;
        _muted = muted;
        _connected = connected;
        _connecting = connecting;
        _joinedAt = joinedAt;

        UpdateVoicePanel(roomName);
    }

    /// <summary>按当前会话数据整体重绘。</summary>
    public void Refresh()
    {
        if (_session is null)
        {
            ServerNameText.Text = "未选择服务器";
            ServerHostText.Text = "—";
            RoomListHost.Children.Clear();
            SelfNickname.Text = "未登录";
            SelfRole.Text = "—";
            SelfInitial.Text = "?";
            RoomsEmptyHint.Visibility = Visibility.Visible;
            UpdateVoicePanel(null);
            return;
        }

        var profile = _session.Profile;

        ServerNameText.Text = _session.DisplayName;
        ServerHostText.Text = _session.HostDisplay;

        // 底部自己
        SelfNickname.Text = string.IsNullOrWhiteSpace(profile.Nickname) ? "未登录" : profile.Nickname;
        SelfInitial.Text = FirstGlyph(profile.Nickname);
        SelfRole.Text = !profile.HasToken
            ? "未登录"
            : _session.IsAdmin ? "管理员" : "成员";

        BuildRoomList();
        UpdateVoicePanel(null);
    }

    // ============================================================
    //  房间列表
    // ============================================================

    private void BuildRoomList()
    {
        RoomListHost.Children.Clear();
        if (_session is null) return;

        var rooms = _session.Rooms;
        RoomsEmptyHint.Visibility = rooms.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        // 有人的房间排前面，其次按创建时间（与网页端 Sidebar 的排序一致）
        var sorted = rooms
            .OrderByDescending(r => r.MemberCount > 0)
            .ThenBy(r => r.CreatedAt)
            .ToList();

        foreach (var room in sorted)
        {
            RoomListHost.Children.Add(BuildRoomRow(room));
        }
    }

    private UIElement BuildRoomRow(RoomWithMembers room)
    {
        var isActive = string.Equals(_session?.CurrentRoomId, room.Id, StringComparison.Ordinal);
        var isExpanded = _expanded.Contains(room.Id) || isActive;
        var isLive = room.MemberCount > 0;

        var container = new StackPanel { Spacing = 2 };

        // ---- 房间行 ----
        var row = new Grid
        {
            Padding = new Thickness(4, 6, 6, 6),
            CornerRadius = new CornerRadius(10),
            ColumnSpacing = 6,
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var accentSoft = GetBrush("AccentSoftBrush");
        var surface2 = GetBrush("Surface2Brush");
        row.Background = isActive ? accentSoft : new SolidColorBrush(Colors.Transparent);

        // 展开箭头
        var chevron = new FontIcon
        {
            Glyph = isExpanded ? "\uE70D" : "\uE76C",
            FontSize = 10,
            Foreground = GetBrush("Ink3Brush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(chevron, 0);
        row.Children.Add(chevron);

        // 喇叭图标（有人在 = 绿色）
        var speaker = new FontIcon
        {
            Glyph = "\uE767",
            FontSize = 13,
            Foreground = isActive
                ? GetBrush("AccentBrush")
                : isLive ? GetBrush("UpBrush") : GetBrush("Ink3Brush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(speaker, 1);
        row.Children.Add(speaker);

        // 房间名
        var name = new TextBlock
        {
            Text = room.Name,
            FontSize = 13,
            FontWeight = isActive ? FontWeights.SemiBold : FontWeights.Normal,
            Foreground = isActive
                ? GetBrush("AccentInkBrush")
                : isLive ? GetBrush("Ink2Brush") : GetBrush("Ink3Brush"),
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(name, 2);
        row.Children.Add(name);

        // 人数
        var count = new TextBlock
        {
            Text = $"{room.MemberCount}/{room.MaxMembers}",
            FontSize = 11,
            FontFamily = GetMonoFont(),
            Foreground = GetBrush("Ink3Brush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(count, 3);
        row.Children.Add(count);

        // 交互：单击展开/收起，双击进入
        row.PointerEntered += (_, _) =>
        {
            if (!isActive) row.Background = surface2;
        };
        row.PointerExited += (_, _) =>
        {
            if (!isActive) row.Background = new SolidColorBrush(Colors.Transparent);
        };
        row.Tapped += (_, e) =>
        {
            // 双击进入（Tapped 的 ClickCount 在 WinUI 里由 DoubleTapped 单独给）
            ToggleExpanded(room.Id);
            e.Handled = true;
        };
        row.DoubleTapped += (_, e) =>
        {
            e.Handled = true;
            RoomSelected?.Invoke(this, room.Id);
        };
        row.RightTapped += (_, e) =>
        {
            e.Handled = true;
            ShowRoomMenu(row, room, e);
        };

        ToolTipService.SetToolTip(row, "单击展开成员 · 双击进入房间 · 右键更多操作");
        container.Children.Add(row);

        // ---- 展开区：进入按钮 + 房内成员 ----
        if (isExpanded)
        {
            var detail = new StackPanel
            {
                Margin = new Thickness(18, 0, 0, 6),
                Spacing = 1,
            };

            // 左侧竖线（视觉上把展开内容挂到房间行下面）
            var detailBorder = new Border
            {
                BorderBrush = GetBrush("LineSoftBrush"),
                BorderThickness = new Thickness(1, 0, 0, 0),
                Padding = new Thickness(8, 0, 0, 0),
                Child = detail,
            };

            if (!isActive)
            {
                var enterButton = new Button
                {
                    Content = BuildEnterContent(),
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Left,
                    Background = new SolidColorBrush(Colors.Transparent),
                    BorderThickness = new Thickness(0),
                    Padding = new Thickness(6, 4, 6, 4),
                    CornerRadius = new CornerRadius(8),
                };
                enterButton.Click += (_, _) => RoomSelected?.Invoke(this, room.Id);
                detail.Children.Add(enterButton);
            }
            else
            {
                detail.Children.Add(new TextBlock
                {
                    Text = "当前房间",
                    FontSize = 11,
                    Margin = new Thickness(6, 3, 0, 3),
                    Foreground = GetBrush("Ink3Brush"),
                });
            }

            foreach (var member in room.Members)
            {
                detail.Children.Add(BuildMemberRow(member));
            }

            container.Children.Add(detailBorder);
        }

        return container;
    }

    private static UIElement BuildEnterContent()
    {
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        panel.Children.Add(new FontIcon { Glyph = "\uE8A7", FontSize = 11 });
        panel.Children.Add(new TextBlock { Text = "进入", FontSize = 12, VerticalAlignment = VerticalAlignment.Center });
        return panel;
    }

    private UIElement BuildMemberRow(RoomMember member)
    {
        var panel = new Grid
        {
            Padding = new Thickness(6, 2, 6, 2),
            ColumnSpacing = 7,
        };
        panel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        panel.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        panel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // 首字头像
        var avatar = new Border
        {
            Width = 20, Height = 20,
            CornerRadius = new CornerRadius(10),
            Background = GetBrush("Surface3Brush"),
            Child = new TextBlock
            {
                Text = FirstGlyph(member.Nickname),
                FontSize = 10,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = GetBrush("Ink2Brush"),
            },
        };
        Grid.SetColumn(avatar, 0);
        panel.Children.Add(avatar);

        var name = new TextBlock
        {
            Text = member.Nickname,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            // 自己用强调色标出来，一眼能在人堆里找到
            Foreground = IsSelf(member) ? GetBrush("AccentInkBrush") : GetBrush("Ink2Brush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        Grid.SetColumn(name, 1);
        panel.Children.Add(name);

        // 麦克风状态：静音显示红麦
        if (member.Muted)
        {
            var muted = new FontIcon
            {
                Glyph = "\uE74F",
                FontSize = 11,
                Foreground = GetBrush("DownBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(muted, 2);
            panel.Children.Add(muted);
        }

        return panel;
    }

    /// <summary>该成员是不是自己（uid 是稳定主键，昵称会变）。</summary>
    private bool IsSelf(RoomMember member)
    {
        var selfUid = _selfUid;
        return !string.IsNullOrEmpty(selfUid) &&
               string.Equals(member.Uid, selfUid, StringComparison.Ordinal);
    }

    /// <summary>当前登录用户的 uid（由主窗口在会话切换时同步过来）。</summary>
    private string? _selfUid;

    /// <summary>告知本栏「我是谁」，用于在成员列表里高亮自己。</summary>
    public void SetSelfUid(string? uid)
    {
        _selfUid = uid;
    }

    private void ToggleExpanded(string roomId)
    {
        if (!_expanded.Remove(roomId)) _expanded.Add(roomId);
        BuildRoomList();
    }

    private void ShowRoomMenu(UIElement target, RoomWithMembers room, RightTappedRoutedEventArgs e)
    {
        var menu = new MenuFlyout();

        var enter = new MenuFlyoutItem { Text = "进入房间", Icon = new FontIcon { Glyph = "\uE8A7" } };
        enter.Click += (_, _) => RoomSelected?.Invoke(this, room.Id);
        menu.Items.Add(enter);

        menu.Items.Add(new MenuFlyoutSeparator());

        var copyId = new MenuFlyoutItem { Text = "复制房间 ID", Icon = new FontIcon { Glyph = "\uE8C8" } };
        copyId.Click += (_, _) => RoomActionRequested?.Invoke(this, new RoomActionEventArgs(room.Id, RoomAction.CopyId));
        menu.Items.Add(copyId);

        menu.Items.Add(new MenuFlyoutSeparator());

        var settings = new MenuFlyoutItem { Text = "房间设置…", Icon = new FontIcon { Glyph = "\uE70F" } };
        settings.Click += (_, _) => RoomActionRequested?.Invoke(this, new RoomActionEventArgs(room.Id, RoomAction.Settings));
        menu.Items.Add(settings);

        var remove = new MenuFlyoutItem { Text = "删除房间", Icon = new FontIcon { Glyph = "\uE74D" } };
        remove.Click += (_, _) => RoomActionRequested?.Invoke(this, new RoomActionEventArgs(room.Id, RoomAction.Delete));
        menu.Items.Add(remove);

        menu.ShowAt(target, new Microsoft.UI.Xaml.Controls.Primitives.FlyoutShowOptions
        {
            Position = e.GetPosition(target),
        });
    }

    // ============================================================
    //  语音状态面板
    // ============================================================

    private void UpdateVoicePanel(string? roomName)
    {
        if (!_inRoom)
        {
            VoiceRoomName.Text = "未加入房间";
            VoiceStatusText.Text = "待命";
            VoiceStatusDot.Fill = GetBrush("Ink3Brush");
            VoiceElapsed.Text = string.Empty;
            MuteButton.IsEnabled = false;
            LeaveButton.IsEnabled = false;
            return;
        }

        VoiceRoomName.Text = roomName ?? _session?.Rooms
            .FirstOrDefault(r => r.Id == _session.CurrentRoomId)?.Name ?? "房间";

        if (_connecting)
        {
            VoiceStatusText.Text = "连接中…";
            VoiceStatusDot.Fill = GetBrush("WarnBrush");
        }
        else if (_connected)
        {
            VoiceStatusText.Text = _muted ? "已静音" : "已连接";
            VoiceStatusDot.Fill = _muted ? GetBrush("DownBrush") : GetBrush("UpBrush");
        }
        else
        {
            VoiceStatusText.Text = "重连中…";
            VoiceStatusDot.Fill = GetBrush("WarnBrush");
        }

        // 时长：只在已连接时显示
        if (_connected && _joinedAt is { } joined)
        {
            var span = DateTimeOffset.Now - joined;
            VoiceElapsed.Text = span.TotalHours >= 1
                ? $"{(int)span.TotalHours}:{span.Minutes:D2}:{span.Seconds:D2}"
                : $"{span.Minutes:D2}:{span.Seconds:D2}";
        }
        else
        {
            VoiceElapsed.Text = string.Empty;
        }

        MuteIcon.Glyph = _muted ? "\uE74F" : "\uE720";
        MuteLabel.Text = _muted ? "已静音" : "静音";
        MuteButton.IsEnabled = true;
        LeaveButton.IsEnabled = true;
    }

    // ============================================================
    //  小工具
    // ============================================================

    private static string FirstGlyph(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "?";
        foreach (var rune in text.Trim().EnumerateRunes())
        {
            return rune.ToString().ToUpperInvariant();
        }
        return "?";
    }

    private static FontFamily GetMonoFont() =>
        Application.Current.Resources.TryGetValue("AppMonoFontFamily", out var f) && f is FontFamily font
            ? font
            : new FontFamily("Consolas");

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
            "AccentSoftBrush" => dark ? Color.FromArgb(255, 27, 38, 71) : Color.FromArgb(255, 238, 244, 255),
            "AccentInkBrush" => dark ? Color.FromArgb(255, 157, 180, 255) : Color.FromArgb(255, 26, 55, 184),
            "UpBrush" => dark ? Color.FromArgb(255, 52, 211, 153) : Color.FromArgb(255, 16, 185, 129),
            "WarnBrush" => dark ? Color.FromArgb(255, 251, 191, 36) : Color.FromArgb(255, 245, 158, 11),
            "DownBrush" => dark ? Color.FromArgb(255, 248, 113, 113) : Color.FromArgb(255, 239, 68, 68),
            "InkBrush" => dark ? Color.FromArgb(255, 241, 245, 249) : Color.FromArgb(255, 15, 23, 42),
            "Ink2Brush" => dark ? Color.FromArgb(255, 163, 174, 195) : Color.FromArgb(255, 71, 85, 105),
            "Ink3Brush" => dark ? Color.FromArgb(255, 107, 118, 145) : Color.FromArgb(255, 148, 163, 184),
            "Surface2Brush" => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
            "Surface3Brush" => dark ? Color.FromArgb(255, 39, 48, 73) : Color.FromArgb(255, 226, 232, 240),
            "LineSoftBrush" => dark ? Color.FromArgb(255, 30, 38, 57) : Color.FromArgb(255, 238, 242, 247),
            _ => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
        });
    }
}

/// <summary>房间列表上的操作。</summary>
public enum RoomAction
{
    Settings,
    Delete,
    CopyId,
}

public sealed class RoomActionEventArgs : EventArgs
{
    public RoomActionEventArgs(string roomId, RoomAction action)
    {
        RoomId = roomId;
        Action = action;
    }

    public string RoomId { get; }

    public RoomAction Action { get; }
}
