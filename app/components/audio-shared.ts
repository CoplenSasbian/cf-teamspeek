import type { DenoiseEngine } from '~/lib/denoise';

/**
 * 音频相关界面在两处复用（设置面板的「音频」页、进房前的试麦卡片），
 * 这里是它们共用的一份定义 —— 免得两边的引擎列表和电平表刻度各写一套后走样。
 */

export const DENOISE_OPTIONS: Array<{
  value: DenoiseEngine;
  /** 设置面板里用的完整标签 */
  label: string;
  /** 进房前卡片里用的短标签 */
  short: string;
  hint: string;
}> = [
  { value: 'off', label: '关闭', short: '关闭', hint: '发送原始麦克风' },
  {
    value: 'gtcrn',
    label: 'GTCRN（推荐）',
    short: 'GTCRN',
    hint: '效果更好，AI 模型（48K 参数），稍占 CPU',
  },
  {
    value: 'rnnoise',
    label: 'RNNoise',
    short: 'RNNoise',
    hint: '经典轻量方案，效果一般，CPU 占用最低',
  },
  {
    value: 'dfn3',
    label: 'DeepFilterNet3（键盘声克星）',
    short: 'DFN3',
    hint: '能压掉「说话时打字」的键盘声（前两者做不到）。代价：延迟 +19ms，首次需下载约 24MB',
  },
];

/**
 * 取引擎的显示名。
 *
 * 存在的理由：引擎名曾在 UI 里被硬编码了**六七处**（三元表达式嵌套），
 * 每加一个引擎都要挨个改，实际已经漏过（加 DFN3 时又一次漏）。
 * 统一走这个函数，以后加引擎只改 DENOISE_OPTIONS 一处。
 */
export function denoiseLabel(engine: DenoiseEngine, style: 'short' | 'label' = 'short'): string {
  const opt = DENOISE_OPTIONS.find((o) => o.value === engine);
  if (!opt) return engine;
  return style === 'label' ? opt.label : opt.short;
}

/** 电平表量程（dBFS） */
export const METER_MIN_DB = -80;
export const METER_MAX_DB = 0;

/** 把 dBFS 映射到电平条百分比 */
export function dbToPercent(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const ratio = (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
  return Math.max(0, Math.min(100, ratio * 100));
}

/** dBFS 显示：≤ -99 是我们的「数字静音」哨兵值，不显示成数字 */
export function fmtDb(v: number): string {
  if (!Number.isFinite(v) || v <= -99) return '静音';
  return `${v.toFixed(1)} dB`;
}
