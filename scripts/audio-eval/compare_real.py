"""在**真实录音**上比较两个音频文件：一个处理前、一个处理后。

为什么需要它：合成样本能给出相对排序，但结论最终要在真实录音上下。
真实录音的难点是**没有干净参考**（你不可能同时录到"没有键盘的同一句话"），
所以不能用语音残留那类指标。

这里改用**频带衰减**这个不需要参考的判据：
  · 键盘的能量集中在 2–8kHz 的瞬态；
  · 语音的基频与第一共振峰在 300–1000Hz。
所以一个真正在「分离」的模型，应当表现为
  **高频段（键盘）衰减大、低频段（语音根基）衰减小**。
如果两个频段一起被压掉同样的量，那说明它只是**整体降了音量**，没有分离。

用法：
    python compare_real.py 原始录音.wav 处理后.wav
    python compare_real.py 原始.wav gate处理.wav dfn3处理.wav   # 多个结果并列比较
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from dsp import SR, read_wav, stft

# 频带划分：既有语音根基，也有键盘主战场，还有一个折中的中频
BANDS: list[tuple[str, int, int]] = [
    ("语音基频/低共振峰 0.1–1k", 100, 1000),
    ("中频 1–2k", 1000, 2000),
    ("键盘主战场 2–8k", 2000, 8000),
    ("高频咔哒 8–16k", 8000, 16000),
]


def band_attenuation_db(ref: np.ndarray, test: np.ndarray, lo: int, hi: int) -> float:
    """指定频带上，test 相对 ref 的平均能量变化（dB，负数=被压低）。"""
    n = min(len(ref), len(test))
    sref = stft(ref[:n])
    stest = stft(test[:n])

    freqs = np.fft.rfftfreq(512, 1 / SR)
    mask = (freqs >= lo) & (freqs <= hi)

    pref = np.abs(sref[:, mask]) ** 2
    ptest = np.abs(stest[:, mask]) ** 2

    # 只统计「ref 有能量」的帧：静音帧的比值没有意义，还会污染平均
    active = pref.sum(axis=1) > (np.max(pref.sum(axis=1)) * 1e-4)
    if active.sum() < 5:
        return float("nan")

    e_ref = float(np.mean(pref[active].sum(axis=1)))
    e_test = float(np.mean(ptest[active].sum(axis=1)))
    return 10 * np.log10(max(e_test, 1e-20) / max(e_ref, 1e-20))


def report(ref_path: Path, candidates: list[Path]) -> None:
    ref, sr = read_wav(ref_path)
    if sr != SR:
        print(f"⚠️ 采样率 {sr} ≠ {SR}，指标仍可比但建议重采样到 48k")

    print(f"\n参考（原始录音）：{ref_path.name}  {len(ref) / sr:.1f}s")
    header = f"{'频带':<24}" + "".join(f"{p.stem[:14]:>16}" for p in candidates)
    print(header)
    print("-" * len(header))

    for label, lo, hi in BANDS:
        row = f"{label:<24}"
        for cand in candidates:
            test, _ = read_wav(cand)
            att = band_attenuation_db(ref, test, lo, hi)
            row += f"{att:>15.1f}dB"
        print(row)

    print("\n怎么读：")
    print("  · 真正的分离 → 「键盘主战场」衰减明显大于「语音基频」那一行。")
    print("  · 低频和高频衰减差不多 → 它只是在整体降音量，不是在做分离。")
    print("  · 低频衰减比高频还大 → 语音被削得比键盘更狠，这是「吞字」，最糟的情况。")

    # 附一个总分，便于快速比较多个候选
    print("\n分离度评分（键盘衰减 − 语音衰减，越大越好）：")
    for cand in candidates:
        test, _ = read_wav(cand)
        key_att = band_attenuation_db(ref, test, 2000, 8000)
        spk_att = band_attenuation_db(ref, test, 100, 1000)
        score = key_att - spk_att
        verdict = "像分离" if score > 6 else ("整体降音量" if abs(score) <= 6 else "可能吞字")
        print(f"  {cand.name:<28} {score:+7.1f}dB   {verdict}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)

    ref = Path(sys.argv[1])
    cands = [Path(p) for p in sys.argv[2:]]
    for p in [ref, *cands]:
        if not p.exists():
            print(f"文件不存在：{p}")
            raise SystemExit(1)
    report(ref, cands)
