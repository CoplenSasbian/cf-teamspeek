import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Settings2 } from 'lucide-react';

import { DENOISE_OPTIONS, dbToPercent } from '~/components/audio-shared';
import { audioMixer } from '~/lib/audio-mixer';
import type { DenoiseEngine } from '~/lib/denoise';
import { startMicMonitor, type MicMonitor } from '~/lib/mic-monitor';
import { loadSettings, saveSettings } from '~/lib/settings';
import { cn } from '~/lib/utils';

/**
 * 进房前的音频检查卡片（首页/房间总览页顶部）。
 *
 * 为什么不直接用设置面板：进房前最要紧的是**确认麦克风真的在收音**。
 * 设置面板是个模态框，选完设备你看不到任何反馈；这里把「设备 + 实时电平 +
 * 降噪算法」放在一屏里，试麦按钮点下去就能看到电平跳不跳。
 *
 * 设备选择必须真的生效 —— 否则这张卡片就只是装饰（见 sfu-session 的
 * micAudioConstraints：房间、试麦、A/B 试听共用同一份约束）。
 */
export function PrejoinAudio({
  denoise,
  onDenoiseChange,
  notify,
  onOpenFullSettings,
}: {
  denoise: DenoiseEngine;
  onDenoiseChange: (engine: DenoiseEngine) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onOpenFullSettings: () => void;
}) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState(() => loadSettings().inputDeviceId ?? '');
  const [outputId, setOutputId] = useState(() => loadSettings().outputDeviceId ?? '');
  const [monitoring, setMonitoring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [levelDb, setLevelDb] = useState(-100);
  const monitorRef = useRef<MicMonitor | null>(null);

  const sinkSupported =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setInputs(list.filter((d) => d.kind === 'audioinput'));
      setOutputs(list.filter((d) => d.kind === 'audiooutput'));
    } catch {
      /* 列不出来就先空着，用户点试麦拿到权限后会自动刷新 */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    // 插拔耳机 / 蓝牙连上来时要跟着更新，否则列表是打开页面那一刻的快照
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => void refreshDevices();
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  /**
   * 从别处改了设备要同步回来。
   *
   * 场景：用户点「全部音频设置」在设置面板里换了麦克风，关掉弹窗回来 ——
   * 卡片如果还显示旧的选择，用户会以为没生效。窗口重新获得焦点时对一次账；
   * 顺带也覆盖了「在另一个标签页改了设置」。
   */
  useEffect(() => {
    const sync = () => {
      const s = loadSettings();
      setInputId(s.inputDeviceId ?? '');
      setOutputId(s.outputDeviceId ?? '');
    };
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  // 卸载（或切走页面）时必须真的把麦克风关掉，不然浏览器一直亮着录音指示
  useEffect(
    () => () => {
      monitorRef.current?.stop();
      monitorRef.current = null;
    },
    [],
  );

  function stopMonitor() {
    monitorRef.current?.stop();
    monitorRef.current = null;
    setMonitoring(false);
    setLevelDb(-100);
  }

  async function startMonitor(deviceId: string) {
    setBusy(true);
    try {
      const handle = await startMicMonitor({
        deviceId: deviceId || undefined,
        onLevel: setLevelDb,
      });
      monitorRef.current = handle;
      setMonitoring(true);
      // 拿到权限之后设备名才可见，顺手刷新一次列表
      void refreshDevices();
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      notify(
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝，无法试麦'
          : name === 'OverconstrainedError' || name === 'NotFoundError'
            ? '这个麦克风现在打不开，换一个试试'
            : '试麦失败，换一个设备试试',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }

  function pickInput(id: string) {
    setInputId(id);
    saveSettings({ inputDeviceId: id || undefined });
    // 正在试麦时换设备：立刻用新设备重开，才能听出/看出区别
    if (monitoring) {
      stopMonitor();
      void startMonitor(id);
    }
  }

  async function toggleMonitor() {
    if (monitoring) {
      stopMonitor();
      return;
    }
    await startMonitor(inputId);
  }

  async function pickOutput(id: string) {
    setOutputId(id);
    saveSettings({ outputDeviceId: id || undefined });
    const ok = await audioMixer.setOutputDevice(id);
    if (!ok) {
      notify(
        sinkSupported
          ? '切换输出设备失败，继续用系统默认设备'
          : '当前浏览器不支持切换输出设备（Chrome / Edge 支持）',
        'error',
      );
    }
  }

  const active = DENOISE_OPTIONS.find((o) => o.value === denoise) ?? DENOISE_OPTIONS[0]!;
  const hasSignal = monitoring && levelDb > -55;

  return (
    <section className="rounded-3xl border border-line bg-surface/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-2">
          <Mic className="h-3.5 w-3.5" />
          麦克风与降噪
        </h2>
        <button
          onClick={onOpenFullSettings}
          className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-ink-2 transition hover:bg-surface-2"
        >
          <Settings2 className="h-3 w-3" />
          全部音频设置
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* 输入设备 + 试麦 */}
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[11px] text-ink-3">输入设备</p>
          <div className="flex gap-2">
            <select
              value={inputId}
              onChange={(e) => pickInput(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface-2/60 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
            >
              <option value="">默认设备（浏览器）</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `麦克风 ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
            <button
              onClick={() => void toggleMonitor()}
              disabled={busy}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition disabled:opacity-60',
                monitoring
                  ? 'bg-down/15 text-down hover:bg-down/25'
                  : 'bg-accent text-white hover:bg-accent-hover',
              )}
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {monitoring ? '停止' : '试麦'}
            </button>
          </div>

          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-75 ease-out',
                hasSignal ? 'bg-up' : 'bg-ink-3/50',
              )}
              style={{ width: `${dbToPercent(levelDb)}%` }}
            />
          </div>
          <p className="text-[11px] leading-snug text-ink-3">
            {monitoring
              ? hasSignal
                ? '有信号 ✅ 就是它了'
                : '对着麦克风说句话，看这条有没有反应'
              : '点「试麦」确认选中的设备真的能收音'}
          </p>
        </div>

        {/* 输出设备 */}
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[11px] text-ink-3">输出设备</p>
          <select
            value={outputId}
            onChange={(e) => void pickOutput(e.target.value)}
            disabled={!sinkSupported}
            className="w-full rounded-xl border border-line bg-surface-2/60 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">默认设备（浏览器）</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `扬声器 ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
          <p className="text-[11px] leading-snug text-ink-3">
            {sinkSupported
              ? '切换后立即对房间里所有人的声音生效'
              : '当前浏览器不支持切换输出设备（Chrome / Edge 支持）'}
          </p>
        </div>
      </div>

      {/* 降噪算法 */}
      <div className="mt-4">
        <p className="mb-2 text-[11px] text-ink-3">降噪算法</p>
        <div className="flex flex-wrap gap-1.5">
          {DENOISE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onDenoiseChange(opt.value)}
              className={cn(
                'rounded-xl border px-3 py-1.5 text-[11px] font-medium transition',
                denoise === opt.value
                  ? 'border-accent/50 bg-accent-soft text-ink'
                  : 'border-line bg-surface-2/40 text-ink-2 hover:bg-surface-2',
              )}
            >
              {opt.short}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-ink-3">{active.hint}</p>
      </div>
    </section>
  );
}
