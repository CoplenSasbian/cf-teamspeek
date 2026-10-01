using CfTeamspeed.Desktop.Models;
using CfTeamspeed.Desktop.Services;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace CfTeamspeed.Desktop.Controls;

/// <summary>
/// ③ 房间内容栏（中间栏）。
///
/// 两种形态，与网页端的 welcome.tsx / room.tsx 对应：
///   未进房 → 房间卡片总览
///   已进房 → 房间内成员网格
///
/// 这里【不】持有 RoomController：媒体链路的建立与生命周期由主窗口统一编排，
/// 本控件只负责呈现。这样切换服务器/房间时不会残留半死的 PeerConnection。
/// </summary>
public sealed partial class RoomView : UserControl
{
    /// <summary>用户从总览里选了某个房间。</summary>
    public event EventHandler<string>? RoomSelected;

    /// <summary>请求打开房间操作菜单（改名 / 删除）。</summary>
    public event EventHandler? RoomMenuRequested;

    public RoomView()
    {
        InitializeComponent();

        RoomMenuButton.Click += (_, _) => RoomMenuRequested?.Invoke(this, EventArgs.Empty);

        // 文字聊天与网页端一致：尚未开放，输入框只做占位反馈
        MessageInput.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                e.Handled = true;
                MessageInput.Text = string.Empty;
            }
        };
    }

    /// <summary>当前服务器显示名（未进房时显示在标题里）。</summary>
    private string _serverName = "";

    private string _nickname = "";

    /// <summary>
    /// 渲染「未进房」的总览态。
    /// </summary>
    public void ShowOverview(string serverName, string nickname, IReadOnlyList<RoomWithMembers> rooms)
    {
        _serverName = serverName;
        _nickname = nickname;

        OverviewPanel.Visibility = Visibility.Visible;
        InRoomPanel.Visibility = Visibility.Collapsed;
        RoomMenuButton.Visibility = Visibility.Collapsed;

        RoomTitle.Text = string.IsNullOrEmpty(serverName) ? "服务器总览" : serverName;
        GreetingText.Text = string.IsNullOrEmpty(nickname) ? "欢迎" : $"嗨，{nickname}";

        var totalOnline = rooms.Sum(r => r.MemberCount);
        var liveCount = rooms.Count(r => r.MemberCount > 0);
        RoomSubtitle.Text = $"挑一个房间开始语音 · 当前有 {totalOnline} 人在频道里";
        OverviewHint.Text = $"{liveCount} 个有人 / 共 {rooms.Count} 个房间";

        NoRoomsHint.Visibility = rooms.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        RoomCardsHost.Items.Clear();
        foreach (var room in rooms.OrderByDescending(r => r.MemberCount > 0).ThenBy(r => r.CreatedAt))
        {
            RoomCardsHost.Items.Add(BuildRoomCard(room));
        }

        MessageInput.IsEnabled = false;
        SendButton.IsEnabled = false;
    }

    /// <summary>渲染「已进房」的房间内视图。</summary>
    public void ShowRoom(RoomSnapshot snapshot)
    {

        OverviewPanel.Visibility = Visibility.Collapsed;
        InRoomPanel.Visibility = Visibility.Visible;
        RoomMenuButton.Visibility = Visibility.Visible;

        // snapshot.Room 可空：服务端理论上一定带，但反序列化缺字段时不能崩。
        // 缺了就用「房间」兜底，标题栏照样能显示人数。
        var room = snapshot.Room;
        RoomTitle.Text = room?.Name ?? "房间";
        RoomSubtitle.Text = room is null
            ? $"{snapshot.Members.Count} 人"
            : $"{snapshot.Members.Count} / {room.MaxMembers} 人";

        MembersHeader.Text = $"房间里的人 — {snapshot.Members.Count}";
        MemberGridHost.Items.Clear();
        foreach (var member in snapshot.Members.OrderByDescending(m => m.Role == Role.Admin))
        {
            MemberGridHost.Items.Add(BuildMemberCard(member));
        }

        MessageInput.IsEnabled = true;
    }

    /// <summary>显示一条提示条（错误用红色，普通信息用中性色）。</summary>
    public void ShowNotice(string message, bool isError = true)
    {
        NoticeText.Text = message;
        NoticeBorder.Visibility = Visibility.Visible;

        var brush = isError ? GetBrush("DownBrush") : GetBrush("WarnBrush");
        NoticeBorder.BorderBrush = brush;
        NoticeBorder.Background = GetBrush(isError ? "DownBrush" : "WarnBrush", 0.12);
        NoticeIcon.Foreground = brush;
        NoticeText.Foreground = isError ? brush : GetBrush("Ink2Brush");
        NoticeIcon.Glyph = isError ? "\uE783" : "\uE946";
    }

    public void HideNotice() => NoticeBorder.Visibility = Visibility.Collapsed;

    // ============================================================
    //  卡片
    // ============================================================

    private UIElement BuildRoomCard(RoomWithMembers room)
    {
        var isLive = room.MemberCount > 0;

        var card = new Border
        {
            Width = 236,
            Height = 100,
            Margin = new Thickness(0, 0, 12, 12),
            Padding = new Thickness(14, 12, 14, 12),
            CornerRadius = new CornerRadius(16),
            Background = GetBrush("SurfaceBrush", 0.6),
            BorderThickness = new Thickness(1),
            BorderBrush = isLive ? GetBrush("UpBrush", 0.35) : GetBrush("LineBrush"),
        };

        var panel = new StackPanel { Spacing = 8 };

        // 顶部：图标 + 名字 + 人数
        var head = new Grid { ColumnSpacing = 10 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var iconWrap = new Border
        {
            Width = 36, Height = 36,
            CornerRadius = new CornerRadius(12),
            Background = isLive ? GetBrush("UpBrush", 0.12) : GetBrush("Surface2Brush"),
            Child = new FontIcon
            {
                Glyph = "\uE8A7",
                FontSize = 16,
                Foreground = isLive ? GetBrush("UpBrush") : GetBrush("Ink3Brush"),
            },
        };
        Grid.SetColumn(iconWrap, 0);
        head.Children.Add(iconWrap);

        var textStack = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        textStack.Children.Add(new TextBlock
        {
            Text = room.Name,
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            Foreground = GetBrush("InkBrush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });

        var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        meta.Children.Add(new TextBlock
        {
            Text = $"{room.MemberCount} / {room.MaxMembers} 人",
            FontSize = 11,
            Foreground = GetBrush("Ink3Brush"),
        });
        if (isLive)
        {
            meta.Children.Add(new Ellipse
            {
                Width = 6, Height = 6,
                Fill = GetBrush("UpBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            });
        }
        textStack.Children.Add(meta);

        Grid.SetColumn(textStack, 1);
        head.Children.Add(textStack);
        panel.Children.Add(head);

        // 底部：成员名字预览
        panel.Children.Add(new TextBlock
        {
            Text = room.Members.Count > 0
                ? string.Join("、", room.Members.Take(3).Select(m => m.Nickname)) +
                  (room.Members.Count > 3 ? $" 等 {room.Members.Count} 人" : "")
                : "还没有人，进去开个麦",
            FontSize = 11,
            Foreground = GetBrush("Ink3Brush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });

        card.Child = panel;

        card.PointerEntered += (_, _) => card.Background = GetBrush("SurfaceBrush", 0.95);
        card.PointerExited += (_, _) => card.Background = GetBrush("SurfaceBrush", 0.6);
        card.Tapped += (_, _) => RoomSelected?.Invoke(this, room.Id);

        return card;
    }

    private UIElement BuildMemberCard(RoomMember member)
    {
        var isAdmin = member.Role == Role.Admin;
        var isMuted = member.Muted;

        var card = new Border
        {
            Width = 100,
            Height = 120,
            Margin = new Thickness(0, 0, 12, 12),
            Padding = new Thickness(8, 12, 8, 10),
            CornerRadius = new CornerRadius(16),
            Background = GetBrush("SurfaceBrush", 0.55),
            BorderThickness = new Thickness(1),
            BorderBrush = GetBrush("LineSoftBrush"),
        };

        var panel = new StackPanel
        {
            Spacing = 8,
            HorizontalAlignment = HorizontalAlignment.Center,
        };

        // 头像（首字 + 稳定色相，与网页端「昵称派生头像」的思路一致）
        var avatar = new Border
        {
            Width = 46, Height = 46,
            CornerRadius = new CornerRadius(23),
            HorizontalAlignment = HorizontalAlignment.Center,
            Background = new SolidColorBrush(AvatarColor(member.Nickname)),
            Child = new TextBlock
            {
                Text = FirstGlyph(member.Nickname),
                FontSize = 19,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Colors.White),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        panel.Children.Add(avatar);

        // 昵称（管理员加个标记）
        var nameRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 4,
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        if (isAdmin)
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
            Text = member.Nickname,
            FontSize = 12,
            FontWeight = FontWeights.Medium,
            Foreground = GetBrush("InkBrush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth = 76,
        });
        panel.Children.Add(nameRow);

        // 麦克风状态
        panel.Children.Add(new FontIcon
        {
            Glyph = isMuted ? "\uE74F" : "\uE720",
            FontSize = 12,
            HorizontalAlignment = HorizontalAlignment.Center,
            Foreground = isMuted ? GetBrush("DownBrush") : GetBrush("UpBrush"),
        });

        card.Child = panel;
        return card;
    }

    // ============================================================
    //  小工具
    // ============================================================

    private static string FirstGlyph(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "?";
        foreach (var rune in text.Trim().EnumerateRunes()) return rune.ToString().ToUpperInvariant();
        return "?";
    }

    /// <summary>
    /// 由昵称派生一个稳定色相的头像底色（对应网页端 Avatar.tsx 的 hashHue）。
    /// 同一昵称在任何时候都是同一个颜色，便于辨认。
    /// </summary>
    private static Color AvatarColor(string seed)
    {
        var text = string.IsNullOrEmpty(seed) ? "anonymous" : seed;
        var hash = 0;
        foreach (var ch in text)
        {
            hash = (hash * 31 + ch) % 360;
        }

        return FromHsl(hash, 0.70, 0.55);
    }

    /// <summary>HSL → RGB（只用于头像底色，精度足够）。</summary>
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

    private static Brush GetBrush(string key, double opacity = 1.0)
    {
        if (opacity >= 1.0 &&
            Application.Current.Resources.TryGetValue(key, out var value) &&
            value is Brush brush)
        {
            return brush;
        }

        var dark = Application.Current.RequestedTheme == ApplicationTheme.Dark;
        var color = key switch
        {
            "AccentBrush" => dark ? Color.FromArgb(255, 77, 116, 255) : Color.FromArgb(255, 31, 71, 230),
            "UpBrush" => dark ? Color.FromArgb(255, 52, 211, 153) : Color.FromArgb(255, 16, 185, 129),
            "WarnBrush" => dark ? Color.FromArgb(255, 251, 191, 36) : Color.FromArgb(255, 245, 158, 11),
            "DownBrush" => dark ? Color.FromArgb(255, 248, 113, 113) : Color.FromArgb(255, 239, 68, 68),
            "InkBrush" => dark ? Color.FromArgb(255, 241, 245, 249) : Color.FromArgb(255, 15, 23, 42),
            "Ink2Brush" => dark ? Color.FromArgb(255, 163, 174, 195) : Color.FromArgb(255, 71, 85, 105),
            "Ink3Brush" => dark ? Color.FromArgb(255, 107, 118, 145) : Color.FromArgb(255, 148, 163, 184),
            "SurfaceBrush" => dark ? Color.FromArgb(255, 20, 27, 45) : Colors.White,
            "Surface2Brush" => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
            "LineBrush" => dark ? Color.FromArgb(255, 38, 47, 71) : Color.FromArgb(255, 226, 232, 240),
            "LineSoftBrush" => dark ? Color.FromArgb(255, 30, 38, 57) : Color.FromArgb(255, 238, 242, 247),
            _ => dark ? Color.FromArgb(255, 28, 36, 56) : Color.FromArgb(255, 241, 245, 249),
        };

        if (opacity < 1.0)
        {
            color = Color.FromArgb((byte)Math.Round(opacity * 255), color.R, color.G, color.B);
        }

        return new SolidColorBrush(color);
    }
}

