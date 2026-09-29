import { useCallback, useEffect, useRef, useState } from 'react';

import { presenceApi, ApiError } from './api';
import { playSound } from './sound';
import { PRESENCE_HEARTBEAT_MS, PRESENCE_POLL_MS } from '@shared/constants';
import type { PresenceInvite, PresenceSnapshot, PresenceStatus } from '@shared/types';

/**
 * 服务器在线状态。
 *
 * 心跳：每 15s 上报一次「我还活着 + 我在哪个房间」，服务端据此判定在线。
 * 轮询：每 6s 拉一次成员快照，并取走别人发给我的邀请。
 *
 * 之所以用轮询而不是常驻 WebSocket：心跳 + 轮询已足够覆盖在线判定与邀请投递，
 * 不必为每个用户维持一条长连接，免费额度下更省。
 */
export function usePresence(opts: {
  enabled: boolean;
  roomId: string | null;
  roomName: string | null;
  /** 展示状态（设置面板选择；随每次心跳上报） */
  status?: Exclude<PresenceStatus, 'offline'>;
  /** 是否允许被邀请（设置面板选择） */
  invitable?: boolean;
  /** 被管理员踢出服务器时回调（客户端应清会话并回登录页） */
  onBanned?: () => void;
}) {
  const { enabled, roomId, roomName } = opts;

  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null);
  const [invites, setInvites] = useState<PresenceInvite[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** 用 ref 持有最新房间/状态信息，定时器不必因为切房间而重建 */
  const roomRef = useRef({ roomId, roomName, status: opts.status, invitable: opts.invitable });
  roomRef.current = { roomId, roomName, status: opts.status, invitable: opts.invitable };

  const onBannedRef = useRef(opts.onBanned);
  onBannedRef.current = opts.onBanned;

  const poll = useCallback(async () => {
    try {
      const snap = await presenceApi.poll();
      setSnapshot(snap);
      if (snap.invites.length > 0) {
        setInvites((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          const fresh = snap.invites.filter((i) => !seen.has(i.id));
          // 有新邀请才响（重复拉到的旧邀请不响）
          if (fresh.length > 0) playSound('invite');
          return [...prev, ...fresh];
        });
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '在线状态同步失败');
    }
  }, []);

  const heartbeat = useCallback(async () => {
    try {
      await presenceApi.heartbeat({
        roomId: roomRef.current.roomId,
        roomName: roomRef.current.roomName,
        status: roomRef.current.status,
        invitable: roomRef.current.invitable,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BANNED') {
        onBannedRef.current?.();
        return;
      }
      /* 单次心跳失败不影响使用，下次重试 */
    }
  }, []);

  // 固定节奏：心跳 + 轮询
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void heartbeat();
    void poll();

    const hb = setInterval(() => {
      if (!cancelled) void heartbeat();
    }, PRESENCE_HEARTBEAT_MS);
    const pl = setInterval(() => {
      if (!cancelled) void poll();
    }, PRESENCE_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(hb);
      clearInterval(pl);
    };
  }, [enabled, heartbeat, poll]);

  // 切换房间时立刻同步一次，避免别人看到的位置滞后
  useEffect(() => {
    if (!enabled) return;
    void heartbeat();
    void poll();
  }, [enabled, roomId, heartbeat, poll]);

  const dismissInvite = useCallback((id: string) => {
    setInvites((prev) => prev.filter((i) => i.id !== id));
  }, []);

  return { snapshot, invites, dismissInvite, refresh: poll, error };
}
