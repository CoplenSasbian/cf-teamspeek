import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Loader2, UserPlus, X } from 'lucide-react';

import { Avatar, AvatarPicker } from '~/components/Avatar';
import { DENOISE_OPTIONS as DENOISE_OPTIONS_SHARED, dbToPercent, fmtDb } from '~/components/audio-shared';
import { ApiError, authApi } from '~/lib/api';
import { audioMixer } from '~/lib/audio-mixer';
import {
  activeDenoiseEngine,
  playProbeBlob,
  probeDenoise,
  type DenoiseEngine,
  type DenoiseProbeMetrics,
} from '~/lib/denoise';
import { loadSettings, saveSettings, type MicInputPrefs, type VoiceGatePrefs } from '~/lib/settings';
import { setSoundEffectsEnabled, soundEffectsEnabled } from '~/lib/sound';
import { PRESET_AVATARS } from '@shared/constants';
import type { PresenceStatus, Profile } from '@shared/types';
import { cn } from '~/lib/utils';

type TabId = 'account' | 'privacy' | 'audio';

/** 供外壳指定「打开设置面板时停在哪个页签」 */
export type SettingsTab = TabId;

/** 延迟测量报告（room-controller.debugLatency 的返回） */
export interface LatencyReport {
  networkRttMs?: number | null;
  playoutDelayMs?: number | null;
  jitterOutMs?: number | null;
  jitterInMs?: number | null;
  packetsLost?: number | null;
  rttRemoteMs?: number | null;
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'account', label: '账号' },
  { id: 'privacy', label: '隐私' },
  { id: 'audio', label: '音频' },
];

const STATUS_OPTIONS: Array<{ value: Exclude<PresenceStatus, 'offline'>; label: string; hint: string }> = [
  { value: 'online', label: '在线', hint: '正常展示在线状态' },
  { value: 'busy', label: '忙碌', hint: '别人无法邀请你进房间' },
  { value: 'away', label: '离开', hint: '展示为离开，仍可被邀请' },
  { value: 'invisible', label: '隐身', hint: '看起来离线，但你能看到别人' },
];

/** 引擎列表与进房前的试麦卡片共用一份（见 audio-shared.ts） */
const DENOISE_OPTIONS = DENOISE_OPTIONS_SHARED;

export function SettingsPanel({
  profile,
  onClose,
  onSaved,
  notify,
  prefs,
  onPrefsChange,
  applyDenoise,
  denoiseSwitching,
  onCycleDenoise,
  measureLatency,
  onCopyInvite,
  initialTab = 'account',
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: (profile: Profile) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
  prefs: {
    status: Exclude<PresenceStatus, 'offline'>;
    invitable: boolean;
    denoise: DenoiseEngine;
    /** 浏览器自带降噪 / 自动增益（作用在采集层，与 GTCRN 串联） */
    input: MicInputPrefs;
    /** 语音门限：低于阈值不发送 */
    gate: VoiceGatePrefs;
  };
  onPrefsChange: (patch: {
    status?: Exclude<PresenceStatus, 'offline'>;
    invitable?: boolean;
    denoise?: DenoiseEngine;
    input?: MicInputPrefs;
    gate?: VoiceGatePrefs;
  }) => void;
  /** 立即应用降噪引擎（在房间里时由房间页实现） */
  applyDenoise: (engine: DenoiseEngine) => Promise<boolean>;
  /** 降噪管线重建中（与语音卡片共享同一状态） */
  denoiseSwitching: boolean;
  /** 循环切换降噪（与语音卡片同一入口） */
  onCycleDenoise: () => void;
  /** 延迟测量（在房间里时由房间页实现，不在房间为 null） */
  measureLatency: (() => Promise<unknown>) | null;
  /** 复制邀请链接（带 key） */
  onCopyInvite: () => void;
  /** 打开时默认停在哪个页签（进房前的「全部音频设置」直接跳到音频页） */
  initialTab?: TabId;
}) {
  const [tab, setTab] = useState<TabId>(initialTab);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/*
        宽度：384px(max-w-sm) 太窄 —— 设备名（"麦克风 (Realtek(R) Audio)" 这种）
        在下拉框里会被截断，音频页那一堆控件也挤成一团。768px 正好是一倍，
        长设备名和提示文字都能完整显示。
      */}
      <div className="rise-in relative flex max-h-[88vh] w-full max-w-3xl flex-col rounded-3xl border border-line bg-surface shadow-[var(--c-shadow-lg)]">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-sm font-semibold text-ink">设置</h2>
          <button
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab 导航 */}
        <nav className="mx-5 mt-4 flex gap-1 rounded-xl bg-surface-2 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition',
                tab === t.id ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
          {tab === 'account' && (
            <AccountTab
              profile={profile}
              onSaved={onSaved}
              notify={notify}
              onCopyInvite={onCopyInvite}
            />
          )}
          {tab === 'privacy' && (
            <PrivacyTab
              status={prefs.status}
              invitable={prefs.invitable}
              onChange={onPrefsChange}
            />
          )}
          {tab === 'audio' && (
            <AudioTab
              denoise={prefs.denoise}
              input={prefs.input}
              gate={prefs.gate}
              onChange={onPrefsChange}
              notify={notify}
              applyDenoise={applyDenoise}
              denoiseSwitching={denoiseSwitching}
              onCycleDenoise={onCycleDenoise}
              measureLatency={measureLatency as (() => Promise<LatencyReport>) | null}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
//  账号
// ============================================================

function AccountTab({
  profile,
  onSaved,
  notify,
  onCopyInvite,
}: {
  profile: Profile;
  onSaved: (profile: Profile) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onCopyInvite: () => void;
}) {
  const [nickname, setNickname] = useState(profile.nickname);
  const [avatarId, setAvatarId] = useState<string | null>(profile.avatarId);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!nickname.trim()) {
      notify('昵称不能为空', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.updateMe({ nickname: nickname.trim(), avatarId });
      onSaved(res.profile);
      saveSettings({ nickname: res.profile.nickname, avatarId: res.profile.avatarId });
      notify('资料已保存');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '保存失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Avatar
          nickname={nickname || profile.nickname}
          avatarId={avatarId}
          avatarUrl={profile.avatarUrl}
          size={48}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{nickname || profile.nickname}</p>
          <p className="font-mono text-[11px] text-ink-3">{profile.uid.slice(0, 8)}…</p>
        </div>
      </div>

      <label className="flex flex-col gap-2">
        <span className="text-xs font-medium text-ink-2">昵称</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={16}
          className="w-full rounded-2xl border border-line bg-surface-2/60 px-4 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/12"
        />
      </label>

      <div>
        <p className="mb-2.5 text-xs font-medium text-ink-2">头像</p>
        <AvatarPicker value={avatarId} onChange={setAvatarId} presets={PRESET_AVATARS} size={40} />
      </div>

      <button
        onClick={() => void save()}
        disabled={busy}
        className="mt-1 flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        保存资料
      </button>

      {/* 邀请朋友 */}
      <button
        onClick={onCopyInvite}
        className="flex items-center justify-center gap-1.5 rounded-xl border border-line px-4 py-2.5 text-xs font-medium text-ink-2 transition hover:bg-surface-2"
      >
        <UserPlus className="h-3.5 w-3.5" />
        复制邀请链接
      </button>
      <p className="-mt-2 text-[11px] leading-snug text-ink-3">
        链接里带着访问 key，对方打开后自动填好服务器与 key，取个昵称、选个头像就能进来。
        <b className="text-warn">只发给信得过的人</b>
        ——拿到链接等于拿到这台服务器的入场券。
      </p>
    </div>
  );
}

// ============================================================
//  隐私
// ============================================================

function PrivacyTab({
  status,
  invitable,
  onChange,
}: {
  status: Exclude<PresenceStatus, 'offline'>;
  invitable: boolean;
  onChange: (patch: { status?: Exclude<PresenceStatus, 'offline'>; invitable?: boolean }) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-xs font-medium text-ink-2">在线状态</p>
        <div className="flex flex-col gap-1.5">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange({ status: opt.value })}
              className={cn(
                'flex items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition',
                status === opt.value
                  ? 'border-accent/50 bg-accent-soft'
                  : 'border-line bg-surface-2/40 hover:bg-surface-2',
              )}
            >
              <span
                className={cn(
                  'h-2.5 w-2.5 shrink-0 rounded-full',
                  opt.value === 'online' && 'bg-up',
                  opt.value === 'busy' && 'bg-down',
                  opt.value === 'away' && 'bg-warn',
                  opt.value === 'invisible' && 'bg-ink-3',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-ink">{opt.label}</span>
                <span className="block truncate text-[11px] text-ink-3">{opt.hint}</span>
              </span>
              {status === opt.value && <CheckMark />}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          状态随心跳上报，其他人在成员列表里看到的是你选的状态。隐身只影响展示，
          你所在房间的成员仍能看到你。
        </p>
      </div>

      <ToggleRow
        label="允许被邀请"
        hint="关闭后，别人邀请你进房间会被服务端直接拒绝"
        checked={invitable}
        onChange={(v) => onChange({ invitable: v })}
      />
    </div>
  );
}

// ============================================================
//  音频
// ============================================================

function AudioTab({
  denoise,
  input,
  gate,
  onChange,
  notify,
  applyDenoise,
  denoiseSwitching,
  onCycleDenoise,
  measureLatency,
}: {
  denoise: DenoiseEngine;
  input: MicInputPrefs;
  gate: VoiceGatePrefs;
  onChange: (patch: {
    denoise?: DenoiseEngine;
    input?: MicInputPrefs;
    gate?: VoiceGatePrefs;
  }) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
  /** 立即应用降噪（在房间里时）；不在房间返回 false */
  applyDenoise: (engine: DenoiseEngine) => Promise<boolean>;
  /** 降噪管线重建中（与语音卡片共享同一状态） */
  denoiseSwitching: boolean;
  /** 循环切换降噪（与语音卡片同一入口，保证状态同步） */
  onCycleDenoise: () => void;
  /** 在房间里才有的延迟测量（由房间页注册） */
  measureLatency: (() => Promise<LatencyReport>) | null;
}) {
  const [devices, setDevices] = useState<{
    inputs: MediaDeviceInfo[];
    outputs: MediaDeviceInfo[];
  }>({ inputs: [], outputs: [] });
  const [soundOn, setSoundOn] = useState(() => soundEffectsEnabled());
  const [hasPermission, setHasPermission] = useState(false);
  /** 当前选中的设备（从设置读，改动即写回） */
  const [inputDeviceId, setInputDeviceId] = useState(() => loadSettings().inputDeviceId ?? '');
  const [outputDeviceId, setOutputDeviceId] = useState(() => loadSettings().outputDeviceId ?? '');

  // ---- 延迟测量状态 ----
  const [latencyBusy, setLatencyBusy] = useState(false);
  const [latency, setLatency] = useState<LatencyReport | null>(null);
  const [latencyError, setLatencyError] = useState<string | null>(null);

  async function runLatency() {
    if (!measureLatency) return;
    setLatencyBusy(true);
    setLatencyError(null);
    try {
      const report = (await measureLatency()) as LatencyReport | null;
      if (report) setLatency(report);
    } catch (err) {
      setLatencyError(err instanceof Error ? err.message : '测量失败');
    } finally {
      setLatencyBusy(false);
    }
  }

  // ---- A/B 试听状态 ----
  const PROBE_SECONDS = 3;
  const [activeEngine, setActiveEngine] = useState<DenoiseEngine>(() => activeDenoiseEngine());
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeCountdown, setProbeCountdown] = useState<number | null>(null);
  const [probeRawUrl, setProbeRawUrl] = useState<string | null>(null);
  const [probeDenoisedUrl, setProbeDenoisedUrl] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  /** 客观量化结果（底噪降了多少 dB / 人声掉了多少 dB） */
  const [probeMetrics, setProbeMetrics] = useState<DenoiseProbeMetrics | null>(null);
  const probeUrlsRef = useRef<{ raw?: string; denoised?: string }>({});

  /** 引擎选择变化时刷新「实际生效」状态 */
  useEffect(() => {
    setActiveEngine(activeDenoiseEngine());
  }, [denoise]);

  /**
   * 选择指定引擎：保存设置 + 在房间里立即重建管线（热切换）。
   * 使用 onCycleDenoise 同款底层（applyDenoise），状态由外壳统一持有。
   */
  async function chooseEngine(engine: DenoiseEngine) {
    if (engine === denoise) return; // 已是这个引擎
    onChange({ denoise: engine });
    const applied = await applyDenoise(engine);
    setActiveEngine(activeDenoiseEngine());
    if (applied) {
      notify(
        engine === 'off'
          ? '降噪已关闭'
          : engine === 'gtcrn'
            ? 'GTCRN 降噪已生效'
            : 'RNNoise 降噪已生效',
      );
    } else if (engine !== 'off' && audioMixer.hasMicPipeline()) {
      // 在房间里但没切成功：模型没能起来，已经回退成原始麦克风。
      // 不能沿用「下次进房生效」那句话 —— 用户会以为现在已经在降噪了。
      notify('降噪没能启动（模型初始化失败），已回退为发送原始麦克风', 'error');
    } else if (engine !== 'off') {
      // 不在房间 —— 设置已保存，下次进房生效
      notify('已保存，将在下次进入房间时生效', 'info');
    }
  }

  /**
   * 切换浏览器自带的降噪 / 自动增益。
   *
   * 这两个量作用在采集轨上，Chrome 支持热改、别的浏览器不一定，所以
   * 只有拿到「确实改成功」才说已生效。
   */
  async function toggleInputProcessing(patch: Partial<MicInputPrefs>) {
    const next = { ...input, ...patch };
    onChange({ input: next });
    const applied = await audioMixer.applyMicInputPrefs(next);
    if (!applied) notify('已保存，将在下次进入房间时生效', 'info');
  }

  // ---- 语音门限 ----
  const [gateMeter, setGateMeter] = useState({ levelDb: -100, open: true, available: true });

  /**
   * 电平表：10Hz 轮询主线程侧缓存的值。
   * 门限本身跑在音频线程里（采样级），这里只是把读数画出来，慢一点无所谓。
   */
  useEffect(() => {
    const tick = () => {
      const st = audioMixer.getVoiceGateState();
      setGateMeter({ levelDb: st.levelDb, open: st.open, available: st.available });
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, []);

  /** 开关/阈值都是 AudioParam，改完立即生效且不中断音频 */
  function changeGate(patch: Partial<VoiceGatePrefs>) {
    const next = { ...gate, ...patch };
    onChange({ gate: next });
    audioMixer.setVoiceGate(next);
  }

  function releaseProbeUrls() {
    if (probeUrlsRef.current.raw) URL.revokeObjectURL(probeUrlsRef.current.raw);
    if (probeUrlsRef.current.denoised) URL.revokeObjectURL(probeUrlsRef.current.denoised);
    probeUrlsRef.current = {};
  }

  async function runProbe() {
    setProbeBusy(true);
    setProbeError(null);
    setProbeRawUrl(null);
    setProbeDenoisedUrl(null);
    setProbeMetrics(null);
    releaseProbeUrls();
    try {
      const result = await probeDenoise({
        seconds: PROBE_SECONDS,
        engine: denoise,
        input,
        deviceId: inputDeviceId || undefined,
        onCountdown: (remain) => setProbeCountdown(remain),
      });
      const rawUrl = URL.createObjectURL(result.rawBlob);
      probeUrlsRef.current.raw = rawUrl;
      setProbeRawUrl(rawUrl);
      setProbeMetrics(result.metrics);

      if (result.denoisedBlob) {
        const url = URL.createObjectURL(result.denoisedBlob);
        probeUrlsRef.current.denoised = url;
        setProbeDenoisedUrl(url);
        // 顺序播放：先原始后降噪
        playProbeBlob(result.rawBlob, () => playProbeBlob(result.denoisedBlob!));
        setActiveEngine(result.engine);
      } else {
        playProbeBlob(result.rawBlob);
        setActiveEngine(result.engine);
        if (denoise !== 'off') {
          setProbeError('降噪节点没有启动成功（当前只有原始音）。切到房间页重新进入后重试。');
        }
      }
      setProbeCountdown(null);
    } catch (err) {
      setProbeCountdown(null);
      setProbeError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝，无法录音对比'
          : err instanceof Error
            ? err.message
            : '录音失败',
      );
    } finally {
      setProbeBusy(false);
    }
  }

  function playBoth() {
    if (!probeUrlsRef.current.raw) return;
    // 顺序播：raw → denoised
    const raw = new Audio(probeUrlsRef.current.raw);
    raw.onended = () => {
      if (probeUrlsRef.current.denoised) {
        const den = new Audio(probeUrlsRef.current.denoised);
        void den.play();
      }
    };
    void raw.play();
  }

  // 枚举设备：没有麦克风权限时 label 为空，先请求一次权限拿完整列表
  useEffect(() => {
    void (async () => {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        setHasPermission(true);
      } catch {
        setHasPermission(false);
      }
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        setDevices({
          inputs: list.filter((d) => d.kind === 'audioinput'),
          outputs: list.filter((d) => d.kind === 'audiooutput'),
        });
      } catch {
        /* 忽略 */
      }
    })();
  }, []);

  const sinkSupported = useMemo(
    () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* 输入设备 */}
      <div>
        <p className="mb-2 text-xs font-medium text-ink-2">输入设备（麦克风）</p>
        <select
          value={inputDeviceId}
          onChange={(e) => {
            const id = e.target.value;
            setInputDeviceId(id);
            saveSettings({ inputDeviceId: id || undefined });
            notify(
              id ? '已保存，下次进房使用这个麦克风' : '已改回系统默认麦克风',
              'info',
            );
          }}
          className="w-full rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-xs text-ink outline-none focus:border-accent"
        >
          <option value="">默认设备（浏览器）</option>
          {devices.inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `麦克风 ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
        {!hasPermission && (
          <p className="mt-1.5 text-[11px] text-warn">
            尚未授权麦克风，设备名不可见。进入房间授权后重开此面板即可看到。
          </p>
        )}
      </div>

      {/* 输出设备 */}
      <div>
        <p className="mb-2 text-xs font-medium text-ink-2">输出设备（扬声器）</p>
        <select
          value={outputDeviceId}
          onChange={(e) => {
            const id = e.target.value;
            setOutputDeviceId(id);
            saveSettings({ outputDeviceId: id || undefined });
            // 输出设备可以立刻切（setSinkId），不像麦克风要重新采集
            void audioMixer.setOutputDevice(id).then((ok) => {
              if (!ok) {
                notify(
                  sinkSupported
                    ? '切换输出设备失败，继续用系统默认设备'
                    : '当前浏览器不支持切换输出设备（Chrome / Edge 支持）',
                  'error',
                );
              } else {
                notify(id ? '输出设备已切换' : '已改回系统默认输出设备');
              }
            });
          }}
          disabled={!sinkSupported}
          className="w-full rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
        >
          <option value="">默认设备（浏览器）</option>
          {sinkSupported &&
            devices.outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `扬声器 ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
        </select>
        {!sinkSupported && (
          <p className="mt-1.5 text-[11px] text-ink-3">
            当前浏览器不支持选择输出设备（Chrome / Edge 支持）。
          </p>
        )}
      </div>

      {/* 当前生效状态（区分「选择了」与「真的在跑」） */}
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-2xl border px-3.5 py-2.5',
          activeEngine === 'off' ? 'border-line bg-surface-2/40' : 'border-up/30 bg-up/10',
        )}
      >
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            activeEngine === 'off' ? 'bg-ink-3' : 'bg-up',
          )}
        />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-ink-3">
          {activeEngine === 'off' ? (
            <>
              当前<b className="text-ink-2">未开启</b>降噪（或正在向房间里的人发送原始麦克风）
            </>
          ) : (
            <>
              当前生效：<b className="text-ink-2">{activeEngine === 'gtcrn' ? 'GTCRN' : 'RNNoise'}</b>
              。播放音效、说话光圈与电平条展示的都是降噪后的声音。
            </>
          )}
        </span>
      </div>

      {/* A/B 试听：直接听「原始 vs 降噪后」的差别 */}
      <div className="rounded-2xl border border-line bg-surface-2/40 px-3.5 py-3">
        <p className="text-xs font-medium text-ink-2">A/B 试听</p>
        <p className="mt-1 text-[11px] leading-snug text-ink-3">
          录 {PROBE_SECONDS} 秒麦克风，先播原始音再播降噪后的音。建议在有声源的环境
          （风扇 / 音乐 / 街道声）里说话对比，差别会很明显。
        </p>

        <div className="mt-2.5 flex items-center gap-2">
          <button
            onClick={() => void runProbe()}
            disabled={probeBusy}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            {probeBusy && <Loader2 className="h-3 w-3 animate-spin" />}
            {probeBusy ? `录音中… ${probeCountdown ?? ''}` : '开始试听对比'}
          </button>
          {probeRawUrl && (
            <button
              onClick={() => playBoth()}
              className="rounded-xl border border-line px-3 py-1.5 text-[11px] font-medium text-ink-2 transition hover:bg-surface-2"
            >
              重播对比
            </button>
          )}
        </div>

        {probeError && (
          <p className="mt-2 text-[11px] text-down">{probeError}</p>
        )}
        {probeRawUrl && !probeBusy && (
          <ul className="mt-2.5 flex flex-col gap-1 text-[11px] text-ink-3">
            <li>
              <span className="mr-1.5 rounded bg-surface-3 px-1.5 py-0.5 font-medium text-ink-2">
                1 原始
              </span>
              {probeDenoisedUrl ? '环境噪音应该很明显' : '（降噪未开启，只有这一路）'}
            </li>
            {probeDenoisedUrl && (
              <li>
                <span className="mr-1.5 rounded bg-up/15 px-1.5 py-0.5 font-medium text-up">
                  2 降噪后
                </span>
                背景噪音应明显减弱，人声保留
              </li>
            )}
          </ul>
        )}

        {/* 客观量化：把「感觉好像安静了」变成可比较的数字 */}
        {probeMetrics && !probeBusy && (
          <div className="mt-3 rounded-xl border border-line bg-surface/60 px-3 py-2.5">
            {probeMetrics.rawSpeechToNoiseDb < 6 ? (
              <p className="text-[11px] leading-snug text-warn">
                这段录音里几乎没说话（人声只比底噪高{' '}
                {probeMetrics.rawSpeechToNoiseDb.toFixed(1)} dB），下面的数字不可信 ——
                请在说话的同时重录一次。
              </p>
            ) : (
              <>
                <p className="mb-1.5 text-[11px] font-medium text-ink-2">客观量化</p>
                <div className="flex flex-col gap-1 text-[11px] text-ink-3">
                  <div className="flex items-center justify-between gap-2">
                    <span>背景噪声</span>
                    <span className="tabular-nums">
                      {fmtDb(probeMetrics.rawNoiseDb)} → {fmtDb(probeMetrics.denoisedNoiseDb)}
                      <b className="ml-1 text-up">
                        ↓{probeMetrics.noiseReductionDb.toFixed(1)} dB
                      </b>
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>人声</span>
                    <span className="tabular-nums">
                      {fmtDb(probeMetrics.rawSpeechDb)} → {fmtDb(probeMetrics.denoisedSpeechDb)}
                      <b
                        className={cn(
                          'ml-1',
                          Math.abs(probeMetrics.speechLossDb) <= 1.5
                            ? 'text-up'
                            : probeMetrics.speechLossDb > 3
                              ? 'text-warn'
                              : 'text-ink-2',
                        )}
                      >
                        {probeMetrics.speechLossDb >= 0 ? '↓' : '↑'}
                        {Math.abs(probeMetrics.speechLossDb).toFixed(1)} dB
                      </b>
                    </span>
                  </div>
                </div>
                <p className="mt-1.5 text-[10px] leading-snug text-ink-3">
                  按 20ms 分帧取分位数估算，用于横向对比不同引擎/参数，不是标准声学计量。
                  人声那一行越接近 0 越好（模型削掉的人声已被自动补偿拉回来多少）。
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* 降噪 */}
      <div>
        <p className="mb-2 flex items-center gap-2 text-xs font-medium text-ink-2">
          麦克风降噪
          {denoiseSwitching && (
            <span className="flex items-center gap-1 text-[10px] font-normal text-ink-3">
              <Loader2 className="h-3 w-3 animate-spin" />
              切换中…
            </span>
          )}
        </p>
        <div className="flex flex-col gap-1.5">
          {DENOISE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => void chooseEngine(opt.value)}
              disabled={denoiseSwitching}
              className={cn(
                'flex items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition disabled:opacity-60',
                denoise === opt.value
                  ? 'border-accent/50 bg-accent-soft'
                  : 'border-line bg-surface-2/40 hover:bg-surface-2',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-ink">{opt.label}</span>
                <span className="block truncate text-[11px] text-ink-3">{opt.hint}</span>
              </span>
              {denoise === opt.value && <CheckMark />}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          在浏览器本地对麦克风做降噪后再发送。GTCRN 效果更好（AI 模型，48K 参数），
          RNNoise 更省 CPU。
          <b className="text-ink-2">在房间里选择会立即生效</b>
          （对方会听到一次轻微顿挫），不在房间里则下次进房生效。
          初始化失败会自动回退原始麦克风。
        </p>
      </div>

      {/* 语音门限：低于阈值不发送，开门时音量精确不变 */}
      <div className="rounded-2xl border border-line bg-surface-2/40 px-3.5 py-3">
        <label className="flex cursor-pointer items-start justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="text-xs font-medium text-ink-2">语音门限</span>
            <span className="text-[11px] leading-snug text-ink-3">
              低于阈值整段不发送；高于阈值原样通过，<b className="text-ink-2">音量一点都不变</b>
            </span>
          </span>
          <input
            type="checkbox"
            checked={gate.enabled}
            onChange={(e) => changeGate({ enabled: e.target.checked })}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
          />
        </label>

        {!gateMeter.available && gate.enabled && (
          <p className="mt-2 text-[11px] text-warn">
            门限节点没能在音频线程里跑起来，已自动改为直连（不影响出声）。重进房间会再试一次。
          </p>
        )}

        {gate.enabled && gateMeter.available && (
          <>
            <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-surface-3">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-100 ease-out',
                  gateMeter.open ? 'bg-up' : 'bg-ink-3/60',
                )}
                style={{ width: `${dbToPercent(gateMeter.levelDb)}%` }}
              />
            </div>
            <div className="relative mt-0.5 h-3.5">
              <span
                className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-ink-3"
                style={{ left: `${dbToPercent(gate.thresholdDb)}%` }}
              >
                ▲ {gate.thresholdDb} dB
              </span>
            </div>

            <input
              type="range"
              min={-80}
              max={-20}
              step={1}
              value={gate.thresholdDb}
              onChange={(e) => changeGate({ thresholdDb: Number(e.target.value) })}
              className="mt-1 w-full accent-accent"
            />

            <p className="mt-1.5 text-[11px] leading-snug text-ink-3">
              当前<b className={gateMeter.open ? 'text-up' : 'text-ink-2'}>
                {gateMeter.open ? '开着（在发送）' : '关着（不发送）'}
              </b>
              。往右拖更激进。调到「说话时电平明显高过三角、不说话时明显低于三角」就对了。
            </p>
          </>
        )}

        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          它只在你不说话时切断，所以能挡住**说话间隙**里的键盘/鼠标声；
          <b className="text-ink-2">边说话边敲键盘挡不住</b>
          —— 那时门必须开着。检测只看麦克风原始电平，不经过降噪、也不经过音量补偿，
          所以阈值设一次就稳定。
        </p>
      </div>

      {/* 浏览器自带的麦克风处理（在采集层，与我们自己的降噪串联） */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-ink-2">浏览器自带处理</p>
        <ToggleRow
          label="浏览器降噪"
          hint="作用在采集层，与上面的降噪是串联关系"
          checked={input.noiseSuppression}
          onChange={(v) => void toggleInputProcessing({ noiseSuppression: v })}
        />
        <ToggleRow
          label="自动增益（AGC）"
          hint="浏览器自动拉平音量，与本地响度补偿在做同一件事"
          checked={input.autoGainControl}
          onChange={(v) => void toggleInputProcessing({ autoGainControl: v })}
        />
        <p className="text-[11px] leading-relaxed text-ink-3">
          默认全开（与一直以来的行为一致）。关掉浏览器降噪可以让 GTCRN 独占降噪、
          避免双重处理带来的水声与抽吸感；关掉 AGC 则音量更稳、更可预期。
          哪种更好要在你的设备和麦克风上试听。当前浏览器若不支持热改，
          改动会在下次进入房间时生效。
        </p>
      </div>

      {/* 音效开关 */}
      <ToggleRow
        label="界面音效"
        hint="进出房间 / 成员变动 / 被邀请时的提示音"
        checked={soundOn}
        onChange={(v) => {
          setSoundOn(v);
          setSoundEffectsEnabled(v);
        }}
      />

      {/* 延迟检测（在房间里才有意义） */}
      {measureLatency && (
        <div className="rounded-2xl border border-line bg-surface-2/40 px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-2">延迟检测</p>
            <button
              onClick={() => void runLatency()}
              disabled={latencyBusy}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-2 transition hover:bg-surface-2 disabled:opacity-50"
            >
              {latencyBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Activity className="h-3 w-3" />
              )}
              {latencyBusy ? '测量中…' : '测量'}
            </button>
          </div>

          {latencyError && <p className="mt-2 text-[11px] text-down">{latencyError}</p>}

          {latency && !latencyBusy && (
            <div className="mt-2.5 grid grid-cols-3 gap-2">
              <LatencyCell label="网络 RTT" value={latency.networkRttMs} unit="ms" tone="net" />
              <LatencyCell
                label="播放缓冲"
                value={latency.playoutDelayMs}
                unit="ms"
                tone="buf"
              />
              <LatencyCell label="发送抖动" value={latency.jitterOutMs} unit="ms" tone="dim" />
              <LatencyCell label="接收抖动" value={latency.jitterInMs} unit="ms" tone="dim" />
              <LatencyCell label="丢包" value={latency.packetsLost} unit="包" tone="dim" />
              <LatencyCell
                label="对端测得 RTT"
                value={latency.rttRemoteMs}
                unit="ms"
                tone="net"
              />
            </div>
          )}

          {latency && !latencyBusy && (
            <p className="mt-2 text-[10.5px] leading-snug text-ink-3">
              「对方说话→你听到」≈ RTT + 对端播放缓冲 + 声卡输入输出延迟（浏览器不暴露后者，
              通常合计 20–60ms）。RTT 高 → 网络问题；播放缓冲高 → 对端网络抖动大。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 延迟指标的小格子 */
function LatencyCell({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  tone: 'net' | 'buf' | 'dim';
}) {
  const v = value ?? null;
  const toneClass =
    v == null
      ? 'text-ink-3'
      : tone === 'net' && v > 150
        ? 'text-down'
        : tone === 'net' && v > 70
          ? 'text-warn'
          : tone === 'net'
            ? 'text-up'
            : tone === 'buf' && v > 200
              ? 'text-warn'
              : 'text-ink-2';
  return (
    <div className="rounded-xl bg-surface px-2.5 py-2 ring-1 ring-line">
      <p className="truncate text-[10px] text-ink-3">{label}</p>
      <p className={cn('mt-0.5 font-mono text-sm font-semibold tabular-nums', toneClass)}>
        {v == null ? '—' : v}
        <span className="ml-0.5 text-[10px] font-normal text-ink-3">{v == null ? '' : unit}</span>
      </p>
    </div>
  );
}

// ============================================================
//  通用小组件
// ============================================================

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-line bg-surface-2/40 px-3.5 py-2.5">
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        <span className="text-[11px] text-ink-3">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-accent"
      />
    </label>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-accent" fill="none">
      <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
