import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
  Signal,
  SignalHigh,
  SignalLow,
  TriangleAlert,
} from 'lucide-react';

import { LevelBar, VolumeSlider } from '~/components/VolumeControl';
import { audioMixer, MIC_VOLUME_MAX, useMixerVolumes, useSpeakingSet } from '~/lib/audio-mixer';
import type { DenoiseEngine } from '~/lib/denoise';
import { cn, formatDuration } from '~/lib/utils';

/**
 * 麦克风按钮的电平填充：rAF 直写 DOM 高度，绕过 React 渲染。
 *
 * 为什么不走 state：填充高度每帧都在变（60fps），走 setState 会把
 * 整个面板（乃至订阅了同源数据的兄弟组件）拖进每秒 60 次重渲染 ——
 * 表现为「一直在闪」。这里用 ref 拿到 DOM 节点后直接写 style.height，
 * React 全程不参与，一帧只动一个 style 属性。
 *
 * 平滑用「快攻慢放」包络：上升紧跟（~80ms），回落放缓（~200ms），
 * 填充看起来是呼吸而不是频闪。
 */
function useMicFill(ref: React.RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      if (ref.current) ref.current.style.height = '0%';
      return;
    }

    let stopped = false;
    let raf = 0;
    let smooth = 0;

    const tick = () => {
      if (stopped) return;

      const level = audioMixer.getMicLevel();

      // 快攻慢放包络（与帧时长无关的指数平滑）
      const up = 1 - Math.exp(-1 / (0.08 * 60));
      const down = 1 - Math.exp(-1 / (0.2 * 60));
      smooth = level > smooth ? smooth + (level - smooth) * up : smooth + (level - smooth) * down;

      const el = ref.current;
      if (el) el.style.height = `${Math.round(smooth * 100)}%`;

      raf = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (ref.current) ref.current.style.height = '0%';
    };
  }, [enabled, ref]);
}

/** 延迟快照（room-controller.debugLatency 的精简视图） */
export interface LatencySnapshot {
  networkRttMs?: number | null;
  playoutDelayMs?: number | null;
  jitterOutMs?: number | null;
  jitterInMs?: number | null;
  packetsLost?: number | null;
  rttRemoteMs?: number | null;
}

/**
 * 侧栏底部的「语音状态」面板 —— 常驻。
 *
 * 麦克风按钮学 KOOK：说话时按钮被绿色从下往上填充（电平越高填充越高），
 * hover 按钮弹出音量滑块 + 降噪开关。电平显示、音量调节、降噪切换
 * 都长在按钮上，不用额外占一排 UI。
 * 信号图标 hover 显示实时延迟详情（RTT / 抖动 / 播放缓冲）。
 *
 * 没进房间时面板也在（待命态），按钮禁用。
 */
export function VoiceStatusPanel({
  inRoom,
  selfUid,
  roomName,
  muted,
  connected,
  connecting,
  hasMic,
  elapsed,
  onToggleMute,
  onLeave,
  denoise,
  onCycleDenoise,
  denoiseSwitching,
  measureLatency,
  className,
}: {
  /** 是否在房间里（false = 待命态） */
  inRoom: boolean;
  /** 自己的 uid：混音器里按 uid 存各自的电平 */
  selfUid: string;
  /** 当前房间名（待命态忽略） */
  roomName: string | null;
  muted: boolean;
  /** WebSocket / RTC 是否已连上 */
  connected: boolean;
  connecting: boolean;
  /** 是否拿到了麦克风（拿不到 = 只听模式） */
  hasMic: boolean;
  /** 在当前房间的时长（毫秒）；待命态为 null */
  elapsed: number | null;
  onToggleMute: () => void;
  /** 离开当前房间（挂断） */
  onLeave: () => void;
  /** 当前降噪引擎 */
  denoise: DenoiseEngine;
  /** 循环切换降噪：off → gtcrn → rnnoise → off */
  onCycleDenoise: () => void;
  /** 正在切换降噪（重建管线中） */
  denoiseSwitching: boolean;
  /** 延迟测量（在房间里时由房间页实现） */
  measureLatency: (() => Promise<LatencySnapshot>) | null;
  className?: string;
}) {
  const volumes = useMixerVolumes();

  // hover 弹出音量滑块；稍微延迟关闭，鼠标从按钮挪到滑块上不会误关
  const [sliderOpen, setSliderOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 电平填充：rAF 直写 DOM（不触发 React 渲染），快攻慢放包络防频闪
  const fillRef = useRef<HTMLSpanElement | null>(null);
  useMicFill(fillRef, inRoom && !muted);

  // 说话光圈：迟滞 + 保持，不会在阈值附近来回闪
  const speakingSet = useSpeakingSet(inRoom);
  const speaking = speakingSet.has(selfUid);

  // ---- 延迟弹窗（信号图标 hover 显示） ----
  const [latOpen, setLatOpen] = useState(false);
  const [latBusy, setLatBusy] = useState(false);
  const [lat, setLat] = useState<LatencySnapshot | null>(null);
  const latCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const openLat = () => {
    if (latCloseTimer.current) {
      clearTimeout(latCloseTimer.current);
      latCloseTimer.current = null;
    }
    if (!inRoom) return;
    setLatOpen(true);
    // 打开即测一次 + 每 2 秒自动刷新（低成本：读 PeerConnection 统计）
    if (!latBusy && measureLatency) {
      void measureLatency().then((r) => r && setLat(r)).catch(() => undefined);
    }
    if (!latTimer.current) {
      latTimer.current = setInterval(() => {
        if (!measureLatency) return;
        void measureLatency().then((r) => r && setLat(r)).catch(() => undefined);
      }, 2000);
    }
  };
  const scheduleLatClose = () => {
    if (latCloseTimer.current) clearTimeout(latCloseTimer.current);
    latCloseTimer.current = setTimeout(() => {
      setLatOpen(false);
      if (latTimer.current) {
        clearInterval(latTimer.current);
        latTimer.current = null;
      }
    }, 150);
  };
  // 卸载时清理轮询
  useEffect(() => {
    return () => {
      if (latTimer.current) clearInterval(latTimer.current);
      if (latCloseTimer.current) clearTimeout(latCloseTimer.current);
    };
  }, []);

  const openSlider = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (inRoom) setSliderOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setSliderOpen(false), 150);
  };

  return (
    <div className={cn('shrink-0 px-2.5 pb-2.5', className)}>
      <div
        className={cn(
          'rounded-2xl border bg-surface-2/70 p-2 transition-colors',
          inRoom ? (muted ? 'border-down/30' : 'border-line') : 'border-line-soft opacity-70',
        )}
      >
        <div className="flex items-center gap-2">
          {/* 麦克风按钮：电平填充 + hover 滑块 */}
          <div
            className="relative shrink-0"
            onMouseEnter={openSlider}
            onMouseLeave={scheduleClose}
          >
            <button
              onClick={onToggleMute}
              disabled={!inRoom}
              aria-pressed={muted}
              className={cn(
                'relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl transition',
                !inRoom
                  ? 'cursor-not-allowed bg-surface text-ink-3 opacity-50'
                  : muted
                    ? 'bg-down text-white hover:brightness-110'
                    : 'bg-surface text-ink hover:bg-surface-3',
                speaking && 'ring-2 ring-up speaking-ring',
              )}
              title={inRoom ? (muted ? '取消静音（空格）' : '静音（空格）') : '未进入房间'}
            >
              {/* 电平填充：说话时从底部涨上来（KOOK 式），高度由 rAF 直写 */}
              <span
                aria-hidden
                ref={fillRef}
                className="absolute inset-x-0 bottom-0 bg-up/35"
              />
              <span className="relative z-10 flex">
                {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </span>
            </button>

            {/* hover 弹出的音量滑块 + 降噪开关 */}
            {sliderOpen && inRoom && (
              <div
                className="rise-in absolute bottom-full left-0 z-50 mb-2 w-[14rem] rounded-2xl border border-line bg-surface p-3 shadow-[var(--c-shadow-lg)]"
                onClick={(e) => e.stopPropagation()}
              >
                <VolumeSlider
                  label="我的麦克风（对方听到的音量）"
                  value={volumes.mic}
                  max={MIC_VOLUME_MAX}
                  onChange={(v) => audioMixer.setMicVolume(v)}
                >
                  <div className="mt-1 flex items-center gap-2">
                    {/* 滑块打开时读一次当前电平（静态展示，避免面板高频重渲染） */}
                    <LevelBar level={audioMixer.getMicLevel()} muted={muted} />
                    <span className="text-[11px] text-ink-3">
                      {muted ? '已静音' : hasMic ? '输入电平' : '无麦克风'}
                    </span>
                  </div>
                </VolumeSlider>

                <div className="mt-3 border-t border-line-soft pt-3">
                  <VolumeSlider
                    label="总输出音量"
                    value={volumes.master}
                    onChange={(v) => audioMixer.setMasterVolume(v)}
                    hint="影响所有人；单独调某人请右键成员"
                  />
                </div>

                {/* 降噪开关：一键循环 关 → GTCRN → RNNoise */}
                <div className="mt-3 border-t border-line-soft pt-3">
                  <p className="mb-1.5 text-[11px] font-medium text-ink-2">麦克风降噪</p>
                  <button
                    onClick={onCycleDenoise}
                    disabled={denoiseSwitching}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-xl border px-3 py-1.5 text-left transition',
                      denoise === 'off'
                        ? 'border-line bg-surface-2 text-ink-2 hover:bg-surface-3'
                        : 'border-up/40 bg-up/10 text-ink hover:bg-up/15',
                    )}
                  >
                    <span className="shrink-0">
                      {denoiseSwitching ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" />
                      ) : denoise === 'off' ? (
                        <MicOff className="h-3.5 w-3.5 text-ink-3" />
                      ) : (
                        <AudioLines className="h-3.5 w-3.5 text-up" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-medium">
                        {denoiseSwitching
                          ? '切换中…'
                          : denoise === 'off'
                            ? '降噪：关闭'
                            : denoise === 'gtcrn'
                              ? '降噪：GTCRN'
                              : '降噪：RNNoise'}
                      </span>
                      <span className="block text-[10px] leading-snug text-ink-3">
                        {denoise === 'off'
                          ? '点击开启（GTCRN）'
                          : '点击切换 / 关闭'}
                      </span>
                    </span>
                  </button>
                  <p className="mt-1 text-[10px] leading-snug text-ink-3">
                    更细的设置（含设备选择）在 设置 → 音频
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5">
              {/* 降噪开启时的小徽标（点击同 hover 面板循环切换） */}
              {inRoom && (
                <button
                  onClick={onCycleDenoise}
                  disabled={denoiseSwitching}
                  title={
                    denoise === 'off'
                      ? '降噪：关闭（点击开启）'
                      : `降噪：${denoise === 'gtcrn' ? 'GTCRN' : 'RNNoise'}（点击切换）`
                  }
                  className={cn(
                    'flex h-4 items-center gap-0.5 rounded px-1 text-[9px] font-semibold transition disabled:opacity-60',
                    denoise === 'off'
                      ? 'bg-surface-3 text-ink-3 hover:text-ink-2'
                      : 'bg-up/15 text-up hover:bg-up/25',
                  )}
                >
                  {denoiseSwitching ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <AudioLines className="h-2.5 w-2.5" />
                  )}
                  {denoise === 'off' ? '关' : denoise === 'gtcrn' ? 'G' : 'R'}
                </button>
              )}
              <span className={cn('min-w-0 truncate', inRoom && 'text-[12px] font-medium text-ink')}>
                {inRoom ? (roomName ?? '房间') : '未进入房间'}
              </span>
            </p>
            <div className="mt-0.5 flex h-3.5 items-center gap-1.5 text-[10.5px] text-ink-3">
              {inRoom ? (
                <>
                  {/* 信号图标：hover 显示实时延迟详情 */}
                  <div
                    className="relative shrink-0"
                    onMouseEnter={openLat}
                    onMouseLeave={scheduleLatClose}
                  >
                    <span
                      className="flex cursor-help items-center justify-center"
                      title="悬停查看延迟详情"
                    >
                      <ConnDot connected={connected} connecting={connecting} />
                    </span>

                    {latOpen && (
                      <div
                        className="rise-in absolute bottom-full left-0 z-50 mb-2 w-[13.5rem] rounded-2xl border border-line bg-surface p-3 shadow-[var(--c-shadow-lg)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold text-ink-2">连接质量</p>
                          {latBusy && <Loader2 className="h-3 w-3 animate-spin text-ink-3" />}
                        </div>

                        {lat == null ? (
                          <p className="mt-2 text-[11px] text-ink-3">测量中…</p>
                        ) : (
                          <>
                            <div className="mt-2 flex items-baseline gap-1.5">
                              <span
                                className={cn(
                                  'font-mono text-xl font-semibold tabular-nums',
                                  (lat.networkRttMs ?? 999) > 150
                                    ? 'text-down'
                                    : (lat.networkRttMs ?? 999) > 70
                                      ? 'text-warn'
                                      : 'text-up',
                                )}
                              >
                                {lat.networkRttMs ?? '—'}
                              </span>
                              <span className="text-[10px] text-ink-3">ms RTT</span>
                            </div>

                            <ul className="mt-2 flex flex-col gap-1 border-t border-line-soft pt-2 text-[10.5px] text-ink-3">
                              <LatRow label="对端测得 RTT" v={lat.rttRemoteMs} unit="ms" />
                              <LatRow label="播放缓冲" v={lat.playoutDelayMs} unit="ms" />
                              <LatRow label="发送抖动" v={lat.jitterOutMs} unit="ms" />
                              <LatRow label="接收抖动" v={lat.jitterInMs} unit="ms" />
                              <LatRow label="丢包" v={lat.packetsLost} unit="包" />
                            </ul>
                            <p className="mt-2 text-[10px] leading-snug text-ink-3">
                              每 2 秒自动刷新 · 详细解读在 设置 → 音频
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="truncate">
                    {muted ? '已静音' : hasMic ? '麦克风开启' : '只听模式'} ·{' '}
                    {connecting ? '连接中' : connected ? '已连接' : '未连接'}
                  </span>
                  {degradedHint()}
                  {elapsed !== null && (
                    <span className="ml-auto shrink-0 font-mono tabular-nums">
                      {formatDuration(elapsed)}
                    </span>
                  )}
                </>
              ) : (
                <span>语音待命</span>
              )}
            </div>
          </div>

          {/* 挂断：离开当前房间 */}
          {inRoom && (
            <button
              onClick={onLeave}
              title="离开房间"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-2 transition hover:bg-down/12 hover:text-down"
            >
              <PhoneOff className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  /** Web Audio 链路没就绪时的小警示（详细说明放在 hover 提示里） */
  function degradedHint() {
    if (!volumes.degraded || muted) return null;
    return (
      <span
        title="浏览器音频链路未就绪，发送的是原始麦克风，声音正常，但录制音量暂时不可调。在页面上点一下即可恢复。"
        className="flex shrink-0 text-warn"
      >
        <TriangleAlert className="h-3 w-3" />
      </span>
    );
  }
}

function ConnDot({ connected, connecting }: { connected: boolean; connecting: boolean }) {
  const good = connected;
  const Icon = good ? SignalHigh : connecting ? Signal : SignalLow;
  return (
    <span className={cn('flex h-3 w-3 shrink-0 items-center justify-center', good ? 'text-up' : 'text-warn')}>
      <Icon className="h-3 w-3" />
    </span>
  );
}

/** 延迟弹窗里的明细行 */
function LatRow({ label, v, unit }: { label: string; v: number | null | undefined; unit: string }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="truncate">{label}</span>
      <span className="shrink-0 font-mono tabular-nums text-ink-2">
        {v == null ? '—' : v}
        {v != null && <span className="ml-0.5 text-[9px] text-ink-3">{unit}</span>}
      </span>
    </li>
  );
}
