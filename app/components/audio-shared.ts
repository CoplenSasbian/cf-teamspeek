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
];

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
