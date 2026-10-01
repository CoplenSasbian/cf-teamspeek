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
/// ④ 服务器成员栏。
///
/// 名册有两个来源，与网页端 MemberRail 完全一致的合并策略：
///   1. presence 名册（在线/离线分组的权威来源）
///   2. 房间快照里的成员（心跳可能慢一拍，房间成员更及时）
/// 两处都有的以 presence 为准，只在房间里的则临时补进在线列表。
/// </summary>
public sealed partial class MemberRail : UserControl
{
    private ServerSession? _session;
    private string? _selfUid;

    /// <summary>请求邀请某人进我的房间。</summary>
    public event EventHandler<PresenceUser>? InviteRequested;

    /// <summary>请求跟随某人（切到 TA 所在的房间）。</summary>
    public event EventHandler<PresenceUser>? FollowRequested;

    /// <summary>请求把某人踢出服务器（管理员）。</summary>
    public event EventHandler<PresenceUser>? KickRequested;

    public MemberRail()
    {
        InitializeComponent();
    }

    public void Attach(ServerSession? session, string? selfUid)
    {
        _session = session;
        _selfUid = selfUid;
        Refresh();
    }

    /// <summary>按当前会话数据重绘名册。</summary>
    public void Refresh()
    {
        OnlineHost.Children.Clear();
        OfflineHost.Children.Clear();

        if (_session is null)
        {
            OnlineCountText.Text = "0";
            OnlineLabel.Text = "在线 — 0";
            EmptyHint.Visibility = Visibility.Visible;
            OfflineLabel.Visibility = Visibility.Collapsed;
            return;
        }

        var (online, offline) = MergeRoster(_session);

        OnlineCountText.Text = online.Count.ToString();
        OnlineLabel.Text = $"在线 — {online.Count}";
        EmptyHint.Visibility = online.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        foreach (var user in online)
        {
            OnlineHost.Children.Add(BuildMemberRow(user));
        }

        if (offline.Count > 0)
        {
            OfflineLabel.Visibility = Visibility.Visible;
            OfflineLabel.Text = $"离线 — {offline.Count}";
            foreach (var user in offline)
            {
                OfflineHost.Children.Add(BuildMemberRow(user));
            }
        }
        else
        {
            OfflineLabel.Visibility = Visibility.Collapsed;
        }
    }

    /// <summary>
    /// 合并 presence 名册与房间成员。
    ///
    /// 排序：管理员优先 → 自己优先 → 昵称（与网页端 rank 逻辑一致）。
    /// </summary>
    private (List<PresenceUser> Online, List<PresenceUser> Offline) MergeRoster(ServerSession session)
    {
        var map = new Dictionary<string, PresenceUser>(StringComparer.Ordinal);

        var presence = session.Presence;
        if (presence is not null)
        {
            foreach (var user in presence.Online)
            {
                map[user.Uid] = user;
            }
        }

        // 用房间快照补齐（心跳可能慢一拍）
        foreach (var room in session.Rooms)
        {
            foreach (var member in room.Members)
            {
                if (map.TryGetValue(member.Uid, out var existing))
                {
                    // PresenceUser 是普通类（不可 with），需要补房间信息时重建一个
                    if (string.IsNullOrEmpty(existing.RoomId))
                    {
                        map[member.Uid] = CloneWithRoom(existing, room.Id, room.Name);
                    }
                }
                else
                {
                    map[member.Uid] = new PresenceUser
                    {
                        Uid = member.Uid,
                        Nickname = member.Nickname,
                        Role = member.Role,
                        AvatarId = member.AvatarId,
                        AvatarUrl = member.AvatarUrl,
                        Online = true,
                        Status = PresenceStatus.Online,
                        Invitable = true,
                        RoomId = room.Id,
                        RoomName = room.Name,
                        LastSeen = member.LastSeen,
                    };
                }
            }
        }

        var online = map.Values
            .OrderBy(u => u.Role == Role.Admin ? 0 : 1)
            .ThenBy(u => string.Equals(u.Uid, _selfUid, StringComparison.Ordinal) ? 0 : 1)
            .ThenBy(u => u.Nickname, StringComparer.CurrentCulture)
            .ToList();

        var offline = (presence?.Offline ?? new List<PresenceUser>())
            .Where(u => !map.ContainsKey(u.Uid))
            .OrderBy(u => u.Nickname, StringComparer.CurrentCulture)
            .ToList();

        return (online, offline);
    }

    /// <summary>
    /// 复制一个 PresenceUser 并补上房间信息。
    ///
    /// 名册（presence）可能比房间快照慢一拍：刚进房的人已经在快照里，
    /// 但名册里的 roomId 还是空的。这时用快照的房间信息补上，
    /// 否则界面会显示「未进频道」而实际上人就在房间里。
    /// </summary>
    private static PresenceUser CloneWithRoom(PresenceUser source, string roomId, string roomName) => new()
    {
        Uid = source.Uid,
        Nickname = source.Nickname,
        Role = source.Role,
        AvatarId = source.AvatarId,
        AvatarUrl = source.AvatarUrl,
        Online = source.Online,
        Status = source.Status,
        Invitable = source.Invitable,
        RoomId = roomId,
        RoomName = roomName,
        LastSeen = source.LastSeen,
    };

    private UIElement BuildMemberRow(PresenceUser user)
    {
        var isSelf = string.Equals(user.Uid, _selfUid, StringComparison.Ordinal);
        var inMyRoom = _session?.CurrentRoomId is { Length: > 0 } rid &&
                       string.Equals(user.RoomId, rid, StringComparison.Ordinal);

        var row = new Grid
        {
            Padding = new Thickness(6, 5, 6, 5),
            CornerRadius = new CornerRadius(10),
            ColumnSpacing = 8,
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        // ---- 头像 + 状态点 ----
        var avatarContainer = new Grid { Width = 30, Height = 30 };

        var avatar = new Border
        {
            Width = 30, Height = 30,
            CornerRadius = new CornerRadius(15),
            Background = new SolidColorBrush(AvatarColor(user.Nickname)),
            Opacity = user.Online ? 1.0 : 0.45,
            Child = new TextBlock
            {
                Text = FirstGlyph(user.Nickname),
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Colors.White),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        avatarContainer.Children.Add(avatar);

        // 状态点（在线/忙碌/离开/隐身）
        var dot = new Ellipse
        {
            Width = 10, Height = 10,
            Stroke = GetBrush("SurfaceBrush"),
            StrokeThickness = 2,
            Fill = StatusBrush(user),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        avatarContainer.Children.Add(dot);

        Grid.SetColumn(avatarContainer, 0);
        row.Children.Add(avatarContainer);

        // ---- 昵称 + 位置 ----
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 1 };

        var nameRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        if (user.Role == Role.Admin)
        {
            nameRow.Children.Add(new FontIcon
            {
                Glyph = "\uE735",
                FontSize = 10,
                Foreground = GetBrush("WarnBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            });
        }

        nameRow.Children.Add(new TextBlock
        {
            Text = user.Nickname,
            FontSize = 13,
            FontWeight = FontWeights.Medium,
            Foreground = user.Online ? GetBrush("InkBrush") : GetBrush("Ink3Brush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });

        if (isSelf)
        {
            nameRow.Children.Add(new Border
            {
                Padding = new Thickness(4, 0, 4, 0),
                CornerRadius = new CornerRadius(4),
                Background = GetBrush("AccentSoftBrush"),
                Child = new TextBlock
                {
                    Text = "我",
                    FontSize = 9,
                    Foreground = GetBrush("AccentInkBrush"),
                },
            });
        }

        text.Children.Add(nameRow);

        // 位置说明：在同一频道 / 在别的房间 / 未进频道
        var location = inMyRoom
            ? "在同一频道"
            : !string.IsNullOrEmpty(user.RoomName) ? $"在 {user.RoomName}" : "未进频道";

        text.Children.Add(new TextBlock
        {
            Text = user.Online ? location : "离线",
            FontSize = 11,
            Foreground = GetBrush("Ink3Brush"),
        });

        Grid.SetColumn(text, 1);
        row.Children.Add(text);

        // ---- 交互 ----
        row.PointerEntered += (_, _) => row.Background = GetBrush("Surface2Brush");
        row.PointerExited += (_, _) => row.Background = new SolidColorBrush(Colors.Transparent);

        ToolTipService.SetToolTip(row, $"{user.Nickname}\n{user.Nickname}\n右键可邀请 / 跟随");
        row.RightTapped += (_, e) =>
        {
            e.Handled = true;
            ShowMemberMenu(row, user, isSelf, inMyRoom, e);
        };

        return row;
    }

    /// <summary>
    /// 成员右键菜单。
    ///
    /// 可执行项按网页端 MemberRow 的规则：
    ///   - 跟随：对方在线、在某个房间、且不是我这个房间
    ///   - 邀请：我在房间里、对方在线且可被邀请、且不在我这个房间
    ///   - 踢出：仅管理员、且不是自己
    /// </summary>
    private void ShowMemberMenu(
        UIElement target,
        PresenceUser user,
        bool isSelf,
        bool inMyRoom,
        RightTappedRoutedEventArgs e)
    {
        var menu = new MenuFlyout();
        var isAdmin = _session?.IsAdmin == true;

        var hasMyRoom = _session?.CurrentRoomId is { Length: > 0 };
        var canFollow = !isSelf && user.Online && !string.IsNullOrEmpty(user.RoomId) && !inMyRoom;
        var canInvite = !isSelf && user.Online && user.Invitable &&
                        user.Status != PresenceStatus.Busy && hasMyRoom && !inMyRoom;
        var canKick = isAdmin && !isSelf;

        if (canFollow)
        {
            var follow = new MenuFlyoutItem
            {
                Text = "跟随",
                Icon = new FontIcon { Glyph = "\uE8AB" },
            };
            follow.Click += (_, _) => FollowRequested?.Invoke(this, user);
            menu.Items.Add(follow);
        }

        if (canInvite)
        {
            var invite = new MenuFlyoutItem
            {
                Text = "邀请到我的房间",
                Icon = new FontIcon { Glyph = "\uE8FA" },
            };
            invite.Click += (_, _) => InviteRequested?.Invoke(this, user);
            menu.Items.Add(invite);
        }

        if (canKick)
        {
            if (menu.Items.Count > 0) menu.Items.Add(new MenuFlyoutSeparator());

            var kick = new MenuFlyoutItem
            {
                Text = "踢出服务器",
                Icon = new FontIcon { Glyph = "\uE8BB" },
            };
            kick.Click += (_, _) => KickRequested?.Invoke(this, user);
            menu.Items.Add(kick);
        }

        if (menu.Items.Count == 0)
        {
            var none = new MenuFlyoutItem { Text = "无可执行操作", IsEnabled = false };
            menu.Items.Add(none);
        }

        menu.ShowAt(target, new Microsoft.UI.Xaml.Controls.Primitives.FlyoutShowOptions
        {
            Position = e.GetPosition(target),
        });
    }

    // ============================================================
    //  小工具
    // ============================================================

    private static Brush StatusBrush(PresenceUser user)
    {
        if (!user.Online) return GetBrush("Ink3Brush");

        return user.Status switch
        {
            PresenceStatus.Busy => GetBrush("DownBrush"),
            PresenceStatus.Away => GetBrush("WarnBrush"),
            PresenceStatus.Invisible => GetBrush("Ink3Brush"),
            _ => GetBrush("UpBrush"),
        };
    }

    private static string FirstGlyph(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "?";
        foreach (var rune in text.Trim().EnumerateRunes()) return rune.ToString().ToUpperInvariant();
        return "?";
    }

    private static Color AvatarColor(string seed)
    {
        var text = string.IsNullOrEmpty(seed) ? "anonymous" : seed;
        var hash = 0;
        foreach (var ch in text) hash = (hash * 31 + ch) % 360;
        return FromHsl(hash, 0.70, 0.55);
    }

    private static Color FromHsl(double h, double s, double l)
    {
        double c = (1 - Math.Abs(2 * l - 1)) * s;
        double x = c * (1 - Math.Abs((h / 60.0 % 2) - 1));
        double m = l - c / 2;

        (double r, double g, double b) = h switch
        {
            < 60 => (c, x, 0.0),
            < 120 => (x, c, 0.0),
            < 180 => (0.0, c, x),
            < 240 => (0.0, x, c),
            < 300 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };

        return Color.FromArgb(
            255,
            (byte)Math.Round((r + m) * 255),
            (byte)Math.Round((g + m) * 255),
            (byte)Math.Round((b + m) * 255));
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
            "AccentSoftBrush" => dark ? Color.FromArgb(255, 27, 38, 71) : Color.FromArgb(255, 238, 244, 255),
            "AccentInkBrush" => dark ? Color.FromArgb(255, 157, 180, 255) : Color.FromArgb(255, 26, 55, 184),
            "UpBrush" => dark ? Color.FromArgb(255, 52, 211, 153) : Color.FromArgb(255, 16, 185, 129),
            "WarnBrush" => dark ? Color.FromArgb(255, 251, 191, 36) : Color.FromArgb(255, 245, 158, 11),
            "DownBrush" => dark ? Color.FromArgb(255, 248, 113, 113) : Color.FromArgb(255, 239, 68, 68),
            "InkBrush" => dark ? Color.FromArgb(255, 241, 245, 249) : Color.FromArgb(255, 15, 23, 42),
            "Ink3Brush" => dark ? Color.FromArgb(255, 107, 118, 145) : Color.FromArgb(255, 148, 163, 184),
            "SurfaceBrush" => dark ? Color.FromArgb(255, 20, 27, 45) : Colors.White,
            "Surface2Brush" => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
            _ => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
        });
    }
}
