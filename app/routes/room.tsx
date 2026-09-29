import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import {
  AlertTriangle,
  Info,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
  Users,
} from 'lucide-react';

import { ContextMenu, MenuButton, type MenuEntry } from '~/components/ContextMenu';
import { RoomStagePlaceholder } from '~/components/RoomStagePlaceholder';
import { RoomController } from '~/lib/room-controller';
import { useMixerVolumes } from '~/lib/audio-mixer';
import type { DenoiseEngine } from '~/lib/denoise';
import { setBaseUrl } from '~/lib/api';
import { playSound } from '~/lib/sound';
import { loadSettings, resolveBaseUrl } from '~/lib/settings';
import { cn } from '~/lib/utils';
import { DEFAULT_ROOM_ID } from '@shared/constants';
import type { ShellContext } from '~/routes/app-shell';
import type { RoomSnapshot } from '@shared/types';

export function meta() {
  return [{ title: '语音房间' }];
}

type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** 中间栏：房间内容（成员网格 + 底部控制条）。 */
export default function RoomPage() {
  const { id = 'home' } = useParams();
  const navigate = useNavigate();
  const {
    profile,
    rooms,
    openRoomSettings,
    canEditRoom,
    deleteRoom,
    reportVoice,
    registerApplyDenoise,
    registerMeasureLatency,
  } = useOutletContext<ShellContext>();

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  /** 文字输入草稿：聊天逻辑接入前的占位 */
  const [draft, setDraft] = useState('');

  const controllerRef = useRef<RoomController | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  // 把「立即切换降噪」注册到外壳：设置面板在房间里操作时即刻重建管线。
  // 注册表放在外壳（ref），房间页只负责挂载/卸载自己的实现。
  useEffect(() => {
    registerApplyDenoise(async (engine: DenoiseEngine) => {
      const controller = controllerRef.current;
      if (!controller) return false;
      return controller.applyDenoise(engine);
    });
    return () => registerApplyDenoise(null);
  }, [registerApplyDenoise]);

  // 延迟测量同样注册到外壳（设置 → 音频 → 延迟检测使用）
  useEffect(() => {
    registerMeasureLatency(async () => {
      const controller = controllerRef.current;
      if (!controller) return null;
      return controller.debugLatency();
    });
    return () => registerMeasureLatency(null);
  }, [registerMeasureLatency]);

  const startedAt = useRef(Date.now());

  /** 混音器状态（只用 degraded 标记提示音频链路降级） */
  const volumes = useMixerVolumes();

  // ---- 1. baseUrl ----
  useEffect(() => {
    const s = loadSettings();
    setBaseUrl(s.baseUrl || resolveBaseUrl());
  }, []);

  // ---- 2. 启动控制器 ----
  // 依赖只放「身份」与「房间」：uid 是稳定主键，昵称/头像只是元数据。
  // 若把整个 profile 对象放进依赖，改昵称会换掉对象引用 → 触发清理 →
  // controller.stop() 里的 roomsApi.leave() 会把人踢出房间。
  //
  // 切房间的正确顺序（关键）：
  //   旧 effect cleanup → 旧 controller.stop()（发 leave、关 SFU、停麦克风）
  //   → 新 effect → 新 controller.start()（join、重新开麦克风）
  // React 保证 cleanup 在下一个 effect 之前【同步跑完】，但 stop() 内部的一串
  // await 会跨到下一轮。所以串行化交给 RoomController.start()：它开头会等
  // 「上一任」彻底停完再 join，避免两个房间的生命周期交叠。
  useEffect(() => {
    let cancelled = false;

    const controller = new RoomController({
      roomId: id,
      uid: profile.uid,
      events: {
        onSnapshot: (snap) => {
          if (!cancelled) setSnapshot(snap);
        },
        onConnectionState: (state) => {
          if (!cancelled) setConnState(state);
        },
        // 远端流的播放由混音器直接接管，主内容区（原成员网格）已移除，
        // 所以这里不再需要把 uid 记进 state —— 保留空实现满足接口即可。
        onRemoteStream: () => {},
        onRemoteStreamRemoved: () => {},
        onError: (msg) => {
          if (!cancelled) setError(msg);
        },
        onKicked: (reason) => {
          if (!cancelled) {
            setError(`你被移出房间：${reason}`);
            setTimeout(() => navigate('/', { replace: true }), 1500);
          }
        },
      },
    });

    controllerRef.current = controller;
    startedAt.current = Date.now();

    // 调试入口：控制台 `await __cfRoomController.debugStats()` 可看 RTP 统计
    if (typeof window !== 'undefined') {
      (window as unknown as { __cfRoomController?: RoomController }).__cfRoomController =
        controller;
    }

    void controller
      .start()
      .then(() => {
        if (!cancelled) setLocalStream(controller.getLocalStream());
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '进入房间失败');
      });

    return () => {
      cancelled = true;
      // stop() 里会把自己从 lastController 摘掉（若它仍是当前这一任）
      void controller.stop();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, profile.uid, navigate]);

  const toggleMute = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    const next = !muted;
    setMuted(next);
    // 控制器会同时开关采集轨与发布轨（发布轨可能经过 Web Audio 增益链路）
    await controller.setMuted(next);
  }, [muted]);

  const leave = useCallback(async () => {
    await controllerRef.current?.stop();
    navigate('/', { replace: true });
  }, [navigate]);

  // ---- 2.5 向外壳上报语音状态（侧栏常驻语音面板展示用） ----
  // 电平的连续展示由侧栏面板自己订阅混音器（rAF），这里只上报离散状态，
  // 200ms 节流一次即可。
  useEffect(() => {
    const timer = setInterval(() => {
      reportVoice({
        muted,
        connected: connState === 'connected',
        connecting: connState === 'connecting' || connState === 'reconnecting',
        hasMic: localStream !== null,
        elapsed: Date.now() - startedAt.current,
        onToggleMute: () => void toggleMute(),
        onLeave: () => void leave(),
      });
    }, 200);
    return () => {
      clearInterval(timer);
      reportVoice(null); // 离开房间/卸载时撤下语音状态
    };
  }, [reportVoice, muted, connState, localStream, toggleMute, leave]);

  // 离开前上报用量估算
  useEffect(() => {
    return () => {
      const controller = controllerRef.current;
      if (!controller) return;
      const others = Math.max(0, (snapshot?.members.length ?? 1) - 1);
      const bytes = controller.estimateEgressBytes(Date.now() - startedAt.current, others);
      if (bytes > 0) void controller.reportUsage(bytes);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const members = snapshot?.members ?? [];
  const roomName = snapshot?.room.name ?? '房间';

  /** 侧栏的房间对象（用于删除确认里展示人数）；快照里的 room 没有 members 明细 */
  const room = rooms.find((r) => r.id === id);
  /** 删除权限与侧栏保持一致：房主或管理员，默认房间只留给管理员 */
  const canDeleteRoom =
    !!room &&
    (profile.role === 'admin' ||
      (room.id !== DEFAULT_ROOM_ID && room.ownerUid === profile.uid));

  /** 标题栏菜单：房间设置 / 删除（权限不足时不显示对应项） */
  const headerMenu: MenuEntry[] = useMemo(() => {
    const entries: MenuEntry[] = [];
    if (canEditRoom) {
      entries.push({
        id: 'settings',
        label: '房间设置…',
        icon: <Pencil className="h-3.5 w-3.5" />,
        hint: '改名 / 人数',
        onSelect: openRoomSettings,
      });
    }
    if (canDeleteRoom && room) {
      entries.push({
        id: 'delete',
        label: '删除房间',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        onSelect: () => void deleteRoom(room),
      });
    }
    return entries;
  }, [canEditRoom, canDeleteRoom, room, openRoomSettings, deleteRoom]);

  // ---- 4. 空格键快捷静音 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      e.preventDefault();
      void toggleMute();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMute]);

  return (
    <div className="flex h-full flex-col">
      {/* 房间标题（窄屏由外壳顶栏承担；连接状态/时长在侧栏语音面板里） */}
      <header className="hidden h-14 shrink-0 items-center gap-3 border-b border-line-soft px-5 xl:flex">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold tracking-tight text-ink">{roomName}</h1>
          <div className="mt-0.5 flex items-center gap-3 text-[11px] text-ink-3">
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {members.length} / {snapshot?.room.maxMembers ?? 10}
            </span>
          </div>
        </div>

        {/* 房间操作收进「⋯」菜单（右键标题栏也可以） */}
        <ContextMenu entries={headerMenu} header={roomName} className="contents">
          <div className="flex shrink-0 items-center gap-2">
            <MenuButton
              entries={headerMenu}
              header={roomName}
              icon={<MoreHorizontal className="h-4 w-4" />}
              title="房间操作"
            />
          </div>
        </ContextMenu>
      </header>

      {/* 内容区 */}
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {connState === 'connecting' && (
          <div className="mb-4 flex items-center justify-center gap-2 rounded-2xl border border-line-soft bg-surface/60 py-3 text-sm text-ink-2">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
            正在连接语音服务…
          </div>
        )}

        {volumes.degraded && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-line-soft bg-surface/60 px-4 py-3 text-xs text-ink-3">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              浏览器音频链路还没就绪，
              <span className="font-medium text-ink-2">「我的麦克风」音量暂时不可调</span>
              （发送的是原始麦克风，声音本身正常）。在页面上点一下即可恢复，恢复后会自动重连一次麦克风。
            </span>
          </div>
        )}

        <RoomStagePlaceholder />
      </div>

      {/* 底部：文字输入框，干净的一个框（语音状态/操作在左侧栏） */}
      <footer className="shrink-0 border-t border-line-soft bg-surface/70 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface/80 p-1.5 shadow-[var(--c-shadow)]">
          {/* 文字输入框（发送逻辑等文字聊天落地时接入） */}
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                e.preventDefault();
                playSound('message'); // 聊天落地后：收到新消息才响，这里只是发送反馈
                setDraft('');
              }
            }}
            placeholder="发送消息…"
            className="min-w-0 flex-1 rounded-xl bg-transparent px-2 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-3"
          />

          <button
            type="button"
            disabled={draft.trim().length === 0}
            onClick={() => {
              if (!draft.trim()) return;
              playSound('message'); // 同上，占位的发送反馈
              setDraft('');
            }}
            title="发送（文字聊天尚未开放）"
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
              draft.trim().length === 0
                ? 'cursor-default text-ink-3 opacity-50'
                : 'text-accent-ink hover:bg-accent-soft',
            )}
          >
            <Send className="h-4.5 w-4.5" />
          </button>
        </div>
      </footer>
    </div>
  );
}
