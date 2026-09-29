import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { AlertTriangle, Check, Loader2, Menu, Settings, Users, X } from 'lucide-react';

import { SettingsPanel } from '~/components/SettingsPanel';
import { InviteToasts } from '~/components/InviteToasts';
import { MemberRail } from '~/components/MemberRail';
import { RoomDialog, type RoomDraft } from '~/components/RoomDialog';
import { Sidebar } from '~/components/Sidebar';
import { ApiError, authApi, presenceApi, roomsApi, setBaseUrl } from '~/lib/api';
import type { DenoiseEngine } from '~/lib/denoise';
import { loadSettings, resolveBaseUrl, saveSettings, buildInviteUrl } from '~/lib/settings';
import { usePresence } from '~/lib/use-presence';
import { cn } from '~/lib/utils';
import { DEFAULT_ROOM_ID } from '@shared/constants';
import type {
  PresenceInvite,
  PresenceSnapshot,
  PresenceStatus,
  PresenceUser,
  Profile,
  RoomWithMembers,
} from '@shared/types';

/** 房间列表刷新间隔（成员数 / 各房间人头） */
const ROOMS_REFRESH_MS = 8_000;

/**
 * 应用外壳 —— 三栏布局。
 *
 *   ┌──────────────┬───────────────────────┬───────────────┐
 *   │ 房间列表      │ 房间内容（Outlet）      │ 服务器成员      │
 *   │ Sidebar      │ room.tsx / welcome    │ MemberRail    │
 *   └──────────────┴───────────────────────┴───────────────┘
 *
 * 最左侧的「服务器竖排图标」在 Web 端没有意义（一个部署就是一台服务器），故省略。
 * 窄屏下两侧栏收起为抽屉，中间栏占满。
 */
export interface VoiceStatus {
  muted: boolean;
  connected: boolean;
  connecting: boolean;
  hasMic: boolean;
  /** 在当前房间的时长（毫秒），不在房间为 null */
  elapsed: number | null;
  onToggleMute: () => void;
  /** 挂断：离开当前房间 */
  onLeave: () => void;
}

export interface ShellContext {
  profile: Profile;
  rooms: RoomWithMembers[];
  refreshRooms: () => Promise<void>;
  presence: PresenceSnapshot | null;
  currentRoomId: string | null;
  currentRoomName: string | null;
  notify: (message: string, tone?: ToastTone) => void;
  /** 打开新建房间弹窗（带名字与人数上限） */
  openCreateRoom: () => void;
  /** 打开当前房间的设置弹窗（可改名 / 调上限） */
  openRoomSettings: () => void;
  /** 打开指定房间的设置弹窗（侧栏右键用） */
  openRoomSettingsFor: (room: RoomWithMembers) => void;
  /** 跟随某人：切到 TA 所在的房间 */
  follow: (user: PresenceUser) => void;
  /** 当前房间是否可编辑（房主 / 管理员） */
  canEditRoom: boolean;
  /** 删除房间（带二次确认）；返回 false 表示用户取消 */
  deleteRoom: (room: RoomWithMembers) => Promise<boolean>;
  /** 服务端配置的默认人数上限 */
  maxRoomMembers: number;
  /** 语音状态（侧栏语音面板用），由房间页填充 */
  voice: VoiceStatus | null;
  /** 房间页上报语音状态（麦克风/连接/时长/电平） */
  reportVoice: (status: VoiceStatus | null) => void;
  /**
   * 立即应用降噪引擎（由设置面板调用）。
   * 在房间里时由房间页注册的实现处理；不在房间返回 false（下次进房生效）。
   */
  applyDenoise: (engine: DenoiseEngine) => Promise<boolean>;
  /** 房间页挂载时注册自己的 applyDenoise 实现 */
  registerApplyDenoise: (impl: ((engine: DenoiseEngine) => Promise<boolean>) | null) => void;
  /**
   * 延迟测量（设置面板调用）。在房间里时由房间页注册的实现处理；
   * 不在房间返回 null（面板隐藏测量入口）。
   */
  measureLatency: (() => Promise<unknown>) | null;
  /** 房间页挂载时注册自己的 measureLatency 实现 */
  registerMeasureLatency: (impl: (() => Promise<unknown>) | null) => void;
}

type ToastTone = 'info' | 'error';
type Toast = { id: number; message: string; tone: ToastTone };
type Drawer = 'none' | 'rooms' | 'members';

export default function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [appName, setAppName] = useState('游戏语音室');
  const [maxRoomMembers, setMaxRoomMembers] = useState(10);
  const [rooms, setRooms] = useState<RoomWithMembers[]>([]);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingUid, setPendingUid] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer>('none');
  const [showSettings, setShowSettings] = useState(false);
  /** 'create' | 'edit' | null —— 房间弹窗模式 */
  const [roomDialog, setRoomDialog] = useState<'create' | 'edit' | null>(null);
  /** 编辑弹窗作用的房间 id：不传就是「当前所在房间」（侧栏右键时用） */
  const [roomTarget, setRoomTarget] = useState<string | null>(null);
  /** 房间页上报上来的语音状态（侧栏语音面板展示用） */
  const [voice, setVoice] = useState<VoiceStatus | null>(null);

  const bannedRef = useRef(false);

  /** 只关心「有没有登录」，不关心资料内容 —— 改昵称不该重启任何定时器 */
  const signedIn = !!profile;

  // ---------------- 提示 ----------------
  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  // ---------------- 当前房间（从 URL 推导，外壳拿不到子路由的 params） ----------------
  const currentRoomId = useMemo(() => {
    const m = pathname.match(/^\/room\/([^/]+)/);
    return m ? decodeURIComponent(m[1]!) : null;
  }, [pathname]);

  const currentRoomName = useMemo(
    () => rooms.find((r) => r.id === currentRoomId)?.name ?? null,
    [rooms, currentRoomId],
  );

  // ---------------- 会话 ----------------
  const handleBanned = useCallback(() => {
    if (bannedRef.current) return;
    bannedRef.current = true;
    notify('你已被移出本服务器', 'error');
    void authApi.logout().catch(() => undefined);
    setTimeout(() => navigate('/login', { replace: true }), 1500);
  }, [navigate, notify]);

  useEffect(() => {
    const s = loadSettings();
    setBaseUrl(s.baseUrl || resolveBaseUrl());

    void (async () => {
      try {
        const cfg = await authApi.config();
        setAppName(cfg.appName || '游戏语音室');
        if (cfg.maxRoomMembers > 0) setMaxRoomMembers(cfg.maxRoomMembers);
      } catch {
        /* 配置拉取失败用默认值 */
      }
      try {
        const { profile: me } = await authApi.me();
        setProfile(me);
      } catch {
        navigate('/login', { replace: true });
      }
    })();
  }, [navigate]);

  // ---------------- 房间列表 ----------------
  const refreshRooms = useCallback(async () => {
    try {
      const { rooms: list } = await roomsApi.list();
      setRooms(list);
    } catch {
      /* 保留上一次结果 */
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void refreshRooms();
    const timer = setInterval(() => void refreshRooms(), ROOMS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [signedIn, refreshRooms]);

  /** 房间页上报语音状态；每次渲染期间同步最新值（ref 防抖 setState） */
  const voiceRef = useRef<VoiceStatus | null>(null);
  const reportVoice = useCallback((status: VoiceStatus | null) => {
    // 引用相等就跳过：电平每帧都在变，靠调用方传稳定引用或节流
    voiceRef.current = status;
    setVoice(status);
  }, []);

  /**
   * 「立即切换降噪」的注册表：房间页挂载时把自己的实现注册进来
   * （控制器在房间页手里）。设置面板调用时转发给当前控制器；
   * 不在房间里时注册表为空 → 返回 false（下次进房生效）。
   */
  const applyDenoiseRef = useRef<((engine: DenoiseEngine) => Promise<boolean>) | null>(null);
  const registerApplyDenoise = useCallback(
    (impl: ((engine: DenoiseEngine) => Promise<boolean>) | null) => {
      applyDenoiseRef.current = impl;
    },
    [],
  );
  const applyDenoise = useCallback(async (engine: DenoiseEngine) => {
    const impl = applyDenoiseRef.current;
    if (!impl) return false;
    return impl(engine);
  }, []);

  /** 延迟测量注册表（同 applyDenoise 模式） */
  const measureLatencyRef = useRef<(() => Promise<unknown>) | null>(null);
  const registerMeasureLatency = useCallback(
    (impl: (() => Promise<unknown>) | null) => {
      measureLatencyRef.current = impl;
    },
    [],
  );
  const measureLatency = useCallback(async () => {
    const impl = measureLatencyRef.current;
    if (!impl) return null;
    return impl();
  }, []);

  // ---------------- 本地偏好（状态 / 可邀请性 / 降噪），设置面板改动后立即生效 ----------------
  const [prefs, setPrefs] = useState(() => {
    const s = loadSettings();
    const raw = s.presenceStatus;
    const status: Exclude<PresenceStatus, 'offline'> =
      raw === 'busy' || raw === 'away' || raw === 'invisible' ? raw : 'online';
    return {
      status,
      invitable: s.invitable !== false,
      denoise: s.denoise?.engine ?? ('off' as DenoiseEngine),
    };
  });

  const updatePrefs = useCallback((patch: Partial<typeof prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveSettings({
        presenceStatus: next.status,
        invitable: next.invitable,
        denoise: { engine: next.denoise },
      });
      return next;
    });
  }, []);

  /** 降噪切换的「进行中」标记（重建管线需要 1-2 秒） */
  const [denoiseSwitching, setDenoiseSwitching] = useState(false);

  /**
   * 循环切换降噪：off → gtcrn → rnnoise → off。
   * 保存设置 + 立即应用（在房间里时）；状态面板和语音卡片同步。
   */
  const cycleDenoise = useCallback(async () => {
    if (denoiseSwitching) return;
    const order: DenoiseEngine[] = ['off', 'gtcrn', 'rnnoise'];
    const next = order[(order.indexOf(prefs.denoise) + 1) % order.length];

    setDenoiseSwitching(true);
    try {
      const applied = await applyDenoise(next);
      updatePrefs({ denoise: next });
      if (applied) {
        notify(
          next === 'off'
            ? '降噪已关闭'
            : next === 'gtcrn'
              ? 'GTCRN 降噪已生效'
              : 'RNNoise 降噪已生效',
        );
      } else if (next !== 'off') {
        notify('已保存，将在下次进入房间时生效', 'info');
      }
    } finally {
      setDenoiseSwitching(false);
    }
  }, [denoiseSwitching, prefs.denoise, applyDenoise, updatePrefs, notify]);

  // ---------------- 在线状态 ----------------
  const { snapshot: presence, invites, dismissInvite, refresh: refreshPresence } = usePresence({
    enabled: signedIn,
    roomId: currentRoomId,
    roomName: currentRoomName,
    status: prefs.status,
    invitable: prefs.invitable,
    onBanned: handleBanned,
  });

  // ---------------- 操作 ----------------
  const enterRoom = useCallback(
    (id: string) => {
      setDrawer('none');
      navigate(`/room/${id}`);
    },
    [navigate],
  );

  /** 提交新建 / 修改房间 */
  const submitRoom = useCallback(
    async (draft: RoomDraft) => {
      setBusy(true);
      try {
        if (roomDialog === 'create') {
          const { room } = await roomsApi.create({
            name: draft.name,
            maxMembers: draft.maxMembers,
          });
          await refreshRooms();
          setRoomDialog(null);
          enterRoom(room.id);
          return;
        }

        const targetId = roomTarget ?? currentRoomId;
        if (!targetId) {
          notify('先进入一个房间', 'error');
          return;
        }
        await roomsApi.update(targetId, {
          name: draft.name,
          maxMembers: draft.maxMembers,
        });
        await refreshRooms();
        setRoomDialog(null);
        setRoomTarget(null);
        notify('房间已更新');
      } catch (err) {
        notify(err instanceof ApiError ? err.message : '操作失败', 'error');
      } finally {
        setBusy(false);
      }
    },
    [roomDialog, roomTarget, currentRoomId, refreshRooms, enterRoom, notify],
  );

  /** 编辑弹窗的初始值：优先用右键指定的房间，其次是当前房间 */
  const editDraft = useMemo<RoomDraft>(() => {
    const targetId = roomTarget ?? currentRoomId;
    const room = rooms.find((r) => r.id === targetId);
    return {
      name: room?.name ?? currentRoomName ?? '',
      maxMembers: room?.maxMembers ?? maxRoomMembers,
    };
  }, [rooms, roomTarget, currentRoomId, currentRoomName, maxRoomMembers]);

  /** 当前房间是否可编辑：默认房间只留给管理员，其他房间只有房主 / 管理员 */
  const canEditRoom = useMemo(() => {
    if (!currentRoomId || !profile) return false;
    const room = rooms.find((r) => r.id === currentRoomId);
    if (profile.role === 'admin') return true;
    if (currentRoomId === DEFAULT_ROOM_ID) return false;
    return room ? room.ownerUid === profile.uid : false;
  }, [currentRoomId, profile, rooms]);

  const invite = useCallback(
    async (user: PresenceUser) => {
      if (!currentRoomId) {
        notify('先进入一个频道，才能邀请别人', 'error');
        return;
      }
      setPendingUid(user.uid);
      try {
        const res = await presenceApi.invite({ toUid: user.uid, roomId: currentRoomId });
        notify(res.sent ? `已邀请 ${user.nickname} 加入频道` : (res.reason ?? '邀请未发送'));
      } catch (err) {
        notify(err instanceof ApiError ? err.message : '邀请失败', 'error');
      } finally {
        setPendingUid(null);
      }
    },
    [currentRoomId, notify],
  );

  const serverKick = useCallback(
    async (user: PresenceUser) => {
      const ok = window.confirm(
        `确定把「${user.nickname}」踢出服务器吗？\n\n将立即断开 TA 的连接并封禁该昵称（可在后台封禁名单里解除）。`,
      );
      if (!ok) return;

      setPendingUid(user.uid);
      try {
        await presenceApi.kick({ uid: user.uid, reason: '被管理员踢出服务器' });
        notify(`已把 ${user.nickname} 踢出服务器`);
      } catch (err) {
        notify(err instanceof ApiError ? err.message : '操作失败', 'error');
      } finally {
        setPendingUid(null);
      }
    },
    [notify],
  );

  const acceptInvite = useCallback(
    (invite: PresenceInvite) => {
      dismissInvite(invite.id);
      enterRoom(invite.roomId);
    },
    [dismissInvite, enterRoom],
  );

  /** 跟随某人：切到 TA 所在的房间（TA 没在房间里则提示） */
  const follow = useCallback(
    (user: PresenceUser) => {
      if (!user.roomId) {
        notify(`${user.nickname} 还没进入房间`, 'error');
        return;
      }
      if (user.roomId === currentRoomId) {
        notify(`已经和 ${user.nickname} 在同一个房间了`);
        return;
      }
      enterRoom(user.roomId);
    },
    [currentRoomId, enterRoom, notify],
  );

  /** 删除房间：二次确认（有人时强调会被断开），成功后必要时退出该房间 */
  const deleteRoom = useCallback(
    async (room: RoomWithMembers): Promise<boolean> => {
      const live = room.memberCount > 0;
      const ok = window.confirm(
        live
          ? `确定删除房间「${room.name}」吗？\n\n里面还有 ${room.memberCount} 人，他们会被立刻断开连接。此操作不可恢复。`
          : `确定删除房间「${room.name}」吗？此操作不可恢复。`,
      );
      if (!ok) return false;

      setBusy(true);
      try {
        await roomsApi.remove(room.id);
        await refreshRooms();

        // 删掉的正是自己所在的房间 → 回总览页，否则会停在一个已不存在的房间里
        if (currentRoomId === room.id) {
          setDrawer('none');
          navigate('/', { replace: true });
        }
        notify(`已删除房间「${room.name}」`);
        return true;
      } catch (err) {
        notify(err instanceof ApiError ? err.message : '删除失败', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [currentRoomId, refreshRooms, navigate, notify],
  );

  const logout = useCallback(async () => {
    await presenceApi.leave().catch(() => undefined);
    await authApi.logout().catch(() => undefined);
    navigate('/login', { replace: true });
  }, [navigate]);

  /** 离开当前房间（侧栏语音面板的挂断按钮） */
  const leaveRoom = useCallback(() => {
    if (!currentRoomId) {
      notify('当前不在任何房间里', 'error');
      return;
    }
    // 回总览页 → 房间页卸载 → controller.stop() 负责 leave / 释放麦克风
    setDrawer('none');
    navigate('/', { replace: true });
  }, [currentRoomId, navigate, notify]);

  /**
   * 复制邀请链接：带上访问 key（以及跨部署时的 server 地址）。
   * 对方打开链接 → 登录页自动填好 key 与地址，只需取昵称、选头像。
   */
  const copyInvite = useCallback(async () => {
    const s = loadSettings();
    const base = s.baseUrl || resolveBaseUrl() || window.location.origin;
    if (!s.key) {
      notify('本地没有记住访问 key，请重新登录后再试', 'error');
      return;
    }

    const url = buildInviteUrl({ baseUrl: base, key: s.key });
    try {
      await navigator.clipboard.writeText(url);
      notify('邀请链接已复制，发给朋友即可加入');
    } catch {
      // 剪贴板不可用（非 HTTPS / 权限被拒）→ 退化为让用户手动复制
      window.prompt('复制下面的邀请链接发给朋友：', url);
    }
  }, [notify]);

  // 侧栏 / 抽屉共用同一份 props
  const sidebar = profile ? (
    <Sidebar
      appName={appName}
      profile={profile}
      rooms={rooms}
      currentRoomId={currentRoomId}
      currentRoomName={currentRoomName}
      busy={busy}
      onEnterRoom={enterRoom}
      onCreateRoom={() => setRoomDialog('create')}
      onRenameRoom={(room) => {
        setRoomTarget(room.id);
        setRoomDialog('edit');
      }}
      onDeleteRoom={deleteRoom}
      onRefresh={() => void refreshRooms()}
      onLogout={() => void logout()}
      onOpenSettings={() => setShowSettings(true)}
      onCopyInvite={() => void copyInvite()}
      voice={voice}
      onLeaveRoom={leaveRoom}
      denoise={prefs.denoise}
      onCycleDenoise={() => void cycleDenoise()}
      denoiseSwitching={denoiseSwitching}
      measureLatency={measureLatency}
      className="h-full"
    />
  ) : null;

  const rail = profile ? (
    <MemberRail
      profile={profile}
      rooms={rooms}
      presence={presence}
      currentRoomId={currentRoomId}
      currentRoomName={currentRoomName}
      pendingUid={pendingUid}
      onInvite={(u) => void invite(u)}
      onFollow={follow}
      onKick={(u) => void serverKick(u)}
      className="h-full"
    />
  ) : null;

  if (!profile) {
    return (
      <main className="app-backdrop flex h-dvh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </main>
    );
  }

  const context: ShellContext = {
    profile,
    rooms,
    refreshRooms,
    presence,
    currentRoomId,
    currentRoomName,
    notify,
    openCreateRoom: () => setRoomDialog('create'),
    openRoomSettings: () => {
      setRoomTarget(null);
      setRoomDialog('edit');
    },
    openRoomSettingsFor: (room) => {
      setRoomTarget(room.id);
      setRoomDialog('edit');
    },
    follow,
    canEditRoom,
    deleteRoom,
    maxRoomMembers,
    voice,
    reportVoice,
    applyDenoise,
    registerApplyDenoise,
    measureLatency,
    registerMeasureLatency,
  };

  return (
    <div className="app-backdrop flex h-dvh w-full overflow-hidden">
      {/* 第二栏：房间列表（桌面常驻） */}
      <div className="hidden lg:flex">{sidebar}</div>

      {/* 第三栏：房间内容 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 窄屏顶栏：抽屉入口（<1280 显示；房间栏在 <1024 才需要抽屉） */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line-soft bg-surface/60 px-3 backdrop-blur-xl xl:hidden">
          <button
            onClick={() => setDrawer('rooms')}
            title="房间列表"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2 lg:invisible"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-semibold text-ink">
              {currentRoomName ?? appName}
            </p>
          </div>
          {canEditRoom && (
            <button
              onClick={() => setRoomDialog('edit')}
              title="房间设置（改名 / 人数上限）"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2"
            >
              <Settings className="h-4.5 w-4.5" />
            </button>
          )}
          <button
            onClick={() => setDrawer('members')}
            title="服务器成员"
            className="relative flex h-9 w-9 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2"
          >
            <Users className="h-4.5 w-4.5" />
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-up" />
          </button>
        </header>

        <div className="min-h-0 flex-1">
          <Outlet context={context} />
        </div>
      </div>

      {/* 第四栏：服务器成员（宽屏常驻） */}
      <div className="hidden xl:flex">{rail}</div>

      {/* 窄屏抽屉 */}
      {drawer !== 'none' && (
        <div className="fixed inset-0 z-40 xl:hidden">
          <div
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
            onClick={() => setDrawer('none')}
          />
          <div
            className={cn(
              'rise-in absolute inset-y-0 flex bg-app shadow-[var(--c-shadow-lg)]',
              drawer === 'rooms' ? 'left-0' : 'right-0',
            )}
          >
            <button
              onClick={() => setDrawer('none')}
              title="收起"
              className={cn(
                'absolute top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink',
                drawer === 'rooms' ? 'right-2' : 'left-2',
              )}
            >
              <X className="h-4 w-4" />
            </button>
            {drawer === 'rooms' ? (
              <div className="w-[268px]">{sidebar}</div>
            ) : (
              <div className="w-[260px]">{rail}</div>
            )}
          </div>
        </div>
      )}

      {/* 邀请提醒 */}
      <InviteToasts invites={invites} onAccept={acceptInvite} onDismiss={dismissInvite} />

      {/* 轻提示 */}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'rise-in flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium shadow-[var(--c-shadow-lg)] backdrop-blur-xl',
              t.tone === 'error'
                ? 'border-down/30 bg-down/15 text-down'
                : 'border-line bg-surface-glass text-ink',
            )}
          >
            {t.tone === 'error' ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0" />
            )}
            {t.message}
          </div>
        ))}
      </div>

      {/* 新建 / 修改房间 */}
      {roomDialog && profile && (
        <RoomDialog
          mode={roomDialog}
          initial={
            roomDialog === 'create'
              ? { name: `${profile.nickname}的房间`, maxMembers: maxRoomMembers }
              : editDraft
          }
          busy={busy}
          onClose={() => setRoomDialog(null)}
          onSubmit={(draft) => void submitRoom(draft)}
        />
      )}

      {/* 设置（账号 / 隐私 / 音频） */}
      {showSettings && (
        <SettingsPanel
          profile={profile}
          prefs={prefs}
          onPrefsChange={updatePrefs}
          applyDenoise={applyDenoise}
          denoiseSwitching={denoiseSwitching}
          onCycleDenoise={() => void cycleDenoise()}
          measureLatency={measureLatency}
          onCopyInvite={() => void copyInvite()}
          onClose={() => setShowSettings(false)}
          onSaved={(p) => {
            // 只更新展示用的资料，uid 不变 —— 房间会话不该因此重建
            setProfile(p);
            void refreshRooms();
            void refreshPresence();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
