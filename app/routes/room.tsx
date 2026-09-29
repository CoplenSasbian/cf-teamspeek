import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ChevronLeft,
  Loader2,
  LogOut,
  Mic,
  MicOff,
  SignalHigh,
  Signal,
  SignalLow,
  UserRound,
  Users,
  AlertTriangle,
  Check,
} from 'lucide-react';

import { RoomGrid } from '~/components/RoomGrid';
import { RoomController } from '~/lib/room-controller';
import { useAudioLevels, useSpeakingSet } from '~/lib/use-audio-levels';
import { authApi, setBaseUrl } from '~/lib/api';
import { loadSettings, resolveBaseUrl } from '~/lib/settings';
import { cn, formatDuration } from '~/lib/utils';
import type { RoomSnapshot } from '@shared/types';

export function meta() {
  return [{ title: '语音房间' }];
}

type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export default function RoomPage() {
  const { id = 'home' } = useParams();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<{
    uid: string;
    nickname: string;
    role: 'guest' | 'admin';
    avatarId: string | null;
    avatarUrl: string | null;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showMembers, setShowMembers] = useState(true);

  const controllerRef = useRef<RoomController | null>(null);
  /** uid → 远端音频流（订阅成功后才有） */
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const startedAt = useRef(Date.now());

  // 自己 + 所有远端成员一起测音量；自己被静音时只看远端
  const streams = useMemo(() => {
    const map: Record<string, MediaStream> = { ...remoteStreams };
    if (localStream && profile) map[profile.uid] = localStream;
    return map;
  }, [remoteStreams, localStream, profile]);

  const levels = useAudioLevels(streams, { enabled: true });

  /** uid → 是否有音频流（用于「连接中…」提示） */
  const hasStream = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const uid of Object.keys(remoteStreams)) map[uid] = true;
    return map;
  }, [remoteStreams]);

  /** 展示用音量：自己静音时归零。（track.enabled=false 仍会让分析器读到信号） */
  const displayLevels = useMemo(() => {
    if (!profile || !muted) return levels;
    return { ...levels, [profile.uid]: 0 };
  }, [levels, muted, profile]);

  /** 各成员的静音状态，用于抑制说话光圈 */
  const mutedMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const m of snapshot?.members ?? []) map[m.uid] = m.muted;
    return map;
  }, [snapshot]);

  const speakingSet = useSpeakingSet(displayLevels, mutedMap);
  const someoneSpeaking = speakingSet.size > 0;

  // ---- 1. 读取资料 ----
  useEffect(() => {
    const s = loadSettings();
    setBaseUrl(s.baseUrl || resolveBaseUrl());

    void (async () => {
      try {
        const { profile: me } = await authApi.me();
        setProfile(me);
      } catch {
        navigate('/', { replace: true });
      }
    })();
  }, [navigate]);

  // ---- 2. 启动控制器 ----
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;

    const controller = new RoomController({
      roomId: id,
      uid: profile.uid,
      nickname: profile.nickname,
      events: {
        onSnapshot: (snap) => {
          if (!cancelled) setSnapshot(snap);
        },
        onConnectionState: (state) => {
          if (!cancelled) setConnState(state);
        },
        onRemoteStream: (uid, stream) => {
          if (cancelled) return;
          setRemoteStreams((prev) => ({ ...prev, [uid]: stream }));
          // 自动播放远端音频
          attachAudio(uid, stream);
        },
        onRemoteStreamRemoved: (uid) => {
          if (cancelled) return;
          setRemoteStreams((prev) => {
            const next = { ...prev };
            delete next[uid];
            return next;
          });
          detachAudio(uid);
        },
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
      void controller.stop();
      controllerRef.current = null;
    };
  }, [profile, id, navigate]);

  // ---- 3. 计时 ----
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // ---- 4. 静音状态同步到本地流 ----
  useEffect(() => {
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }, [muted, localStream]);

  const toggleMute = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    const next = !muted;
    setMuted(next);
    await controller.setMuted(next);
  }, [muted]);

  const leave = useCallback(async () => {
    await controllerRef.current?.stop();
    navigate('/', { replace: true });
  }, [navigate]);

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

  // ---- 5. 空格键快捷静音 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement | null;
      // 输入框内不劫持
      if (target?.isContentEditable) return;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      e.preventDefault();
      void toggleMute();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMute]);

  if (!profile) {
    return (
      <main className="app-backdrop flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </main>
    );
  }

  return (
    <main className="app-backdrop safe-top safe-bottom relative flex min-h-screen flex-col">
      {/* ---------------- 顶栏 ---------------- */}
      <header className="sticky top-0 z-20 border-b border-line-soft bg-app/70 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
          <Link
            to="/"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-2 transition hover:bg-surface-2 hover:text-ink"
            title="返回大厅"
            aria-label="返回大厅"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-tight text-ink">
              {roomName}
            </h1>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-3">
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {members.length} / {snapshot?.room.maxMembers ?? 10}
              </span>
              <span className="font-mono tabular-nums">{formatDuration(elapsed)}</span>
              <ConnBadge state={connState} />
            </div>
          </div>

          {/* 叠放的成员头像，点开/收起网格 */}
          <button
            onClick={() => setShowMembers((v) => !v)}
            className={cn(
              'hidden items-center rounded-full border py-1 pl-1 pr-2.5 transition sm:flex',
              showMembers
                ? 'border-accent/40 bg-accent-soft'
                : 'border-line bg-surface hover:bg-surface-2',
            )}
            title={showMembers ? '收起成员' : '展开成员'}
          >
            <span className="flex -space-x-2">
              {members.slice(0, 3).map((m) => (
                <span
                  key={m.uid}
                  className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-app bg-surface-2 text-[10px] font-medium text-ink-2"
                >
                  {m.avatarId || m.avatarUrl ? (
                    <img
                      src={m.avatarUrl || `/avatars/${m.avatarId}.svg`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    m.nickname.slice(0, 1)
                  )}
                </span>
              ))}
            </span>
            <span className="ml-2 text-xs font-medium text-ink-2">
              {showMembers ? <Check className="h-3.5 w-3.5" /> : `+${members.length}`}
            </span>
          </button>
        </div>
      </header>

      {/* ---------------- 内容区 ---------------- */}
      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 pb-36 pt-6 sm:px-6">
        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {connState === 'connecting' && (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-line-soft bg-surface/60 py-3 text-sm text-ink-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在连接语音服务…
          </div>
        )}

        {showMembers ? (
          <RoomGrid
            members={members}
            selfUid={profile.uid}
            speaking={speakingSet}
            levels={displayLevels}
            hasStream={hasStream}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
            <UserRound className="h-8 w-8 text-ink-3" />
            <p className="text-sm text-ink-3">成员列表已收起</p>
          </div>
        )}
      </section>

      {/* ---------------- 悬浮胶囊控制条 ---------------- */}
      <footer className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div
          className={cn(
            'pointer-events-auto flex items-center gap-2 rounded-full border p-2 backdrop-blur-xl transition-shadow',
            'border-line bg-surface-glass',
            someoneSpeaking ? 'shadow-[0_0_0_1px_var(--c-up),var(--c-shadow-lg)]' : 'shadow-[var(--c-shadow-lg)]',
          )}
        >
          <button
            onClick={() => void toggleMute()}
            aria-pressed={muted}
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-full transition',
              muted
                ? 'bg-down text-white hover:brightness-110'
                : 'bg-surface-2 text-ink hover:bg-surface-3',
            )}
            title={muted ? '取消静音（空格）' : '静音（空格）'}
          >
            {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          <div className="flex min-w-[7.5rem] flex-col px-1">
            <span className="text-[13px] font-medium text-ink">
              {muted ? '已静音' : localStream ? '麦克风开启' : '只听模式'}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  connState === 'connected' ? 'bg-up' : 'bg-warn',
                )}
              />
              {connState === 'connected' ? '已连接' : '连接中'}
            </span>
          </div>

          <div className="mx-1 h-8 w-px bg-line" />

          <button
            onClick={() => void leave()}
            className="flex h-12 items-center gap-2 rounded-full bg-down px-5 text-sm font-medium text-white transition hover:brightness-110"
            title="离开房间"
          >
            <LogOut className="h-4.5 w-4.5" />
            离开
          </button>
        </div>
      </footer>
    </main>
  );
}

// ------------------------------------------------------------

function ConnBadge({ state }: { state: ConnState }) {
  const good = state === 'connected';
  const fair = state === 'reconnecting' || state === 'connecting';
  const Icon = good ? SignalHigh : fair ? Signal : SignalLow;
  const color = good ? 'text-up' : fair ? 'text-warn' : 'text-down';
  const label =
    state === 'connected'
      ? '已连接'
      : state === 'reconnecting'
        ? '重连中'
        : state === 'disconnected'
          ? '已断开'
          : '连接中';

  return (
    <span className={cn('flex items-center gap-1', color)}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

// ---- 远端音频播放管理 ----
const audioEls = new Map<string, HTMLAudioElement>();

function attachAudio(uid: string, stream: MediaStream): void {
  let el = audioEls.get(uid);
  if (!el) {
    el = new Audio();
    el.autoplay = true;
    audioEls.set(uid, el);
  }
  el.srcObject = stream;
  void el.play().catch(() => {
    // 自动播放被拦截时，等首次用户交互再试
    const resume = () => {
      void el?.play().catch(() => undefined);
      document.removeEventListener('click', resume);
    };
    document.addEventListener('click', resume);
  });
}

function detachAudio(uid: string): void {
  const el = audioEls.get(uid);
  if (!el) return;
  el.srcObject = null;
  el.pause();
  audioEls.delete(uid);
}
