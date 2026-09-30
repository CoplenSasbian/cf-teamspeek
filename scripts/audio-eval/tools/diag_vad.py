"""诊断 TransientGate 内部的语音检测器：它在真人语音上准不准？

起因：在真人语音样本上，`transient`（配置为「说话期间不动手」，衰减 0dB）
却显示语音变化 −11.9dB。这不可能 —— 除非内部的语音检测器把说话帧判成了静音，
于是对语音也施加了静音窗。

这个脚本用样本自带的说话区间真值（`speech_spans`）来量检测器的准确率。
检测器写错的话，后面所有比较都是错的，所以必须单独验证。

用法：
    python tools/diag_vad.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from dsp import SR, read_wav  # noqa: E402

FRAME = 240


def low_band_vad(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """TransientGate 里用的那套语音判据（原样复制，便于单独检验）。

    与 evaluate.py 的实现保持同步：宽带 100–4000Hz + 50ms 平滑 + 迟滞。
    """
    n_frames = len(x) // FRAME
    seg = x[: n_frames * FRAME].reshape(n_frames, FRAME).astype(np.float64)
    seg = seg - np.mean(seg, axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(seg * np.hanning(FRAME), n=FRAME, axis=1))
    freqs = np.fft.rfftfreq(FRAME, 1 / sr)

    wide = (freqs >= 100) & (freqs <= 4000)
    env = 10 * np.log10(np.maximum(np.mean(spec[:, wide] ** 2, axis=1), 1e-20))

    smooth = max(1, int(0.05 * sr / FRAME))
    env = np.convolve(env, np.ones(smooth) / smooth, mode="same")

    lo_p, hi_p = np.percentile(env, 15), np.percentile(env, 90)
    span = max(hi_p - lo_p, 1e-6)
    open_th, close_th = lo_p + span * 0.30, lo_p + span * 0.18

    out = np.zeros(n_frames, dtype=bool)
    on = False
    for i, v in enumerate(env):
        if on:
            if v < close_th:
                on = False
        elif v > open_th:
            on = True
        out[i] = on
    return out, env


def main() -> int:
    for tag, dirname in (("真人语音", "samples_real"), ("合成语音", "samples")):
        samples = HERE / dirname
        if not (samples / "manifest.json").exists():
            print(f"跳过 {tag}：没有 {samples}/manifest.json")
            continue

        manifest = json.loads((samples / "manifest.json").read_text("utf8"))
        case = next(c for c in manifest["cases"] if int(round(c["snr_db"])) == 6)
        mixed, _ = read_wav(samples / case["mix"])

        detected, env = low_band_vad(mixed, SR)
        n_frames = len(detected)
        centers = (np.arange(n_frames) + 0.5) * FRAME / SR

        truth = np.zeros(n_frames, dtype=bool)
        for a, b in case["speech_spans"]:
            truth |= (centers >= a) & (centers <= b)

        tp = int((detected & truth).sum())
        fp = int((detected & ~truth).sum())
        fn = int((~detected & truth).sum())
        tn = int((~detected & ~truth).sum())
        precision = tp / max(1, tp + fp)
        recall = tp / max(1, tp + fn)

        print(f"\n=== {tag}（{case['id']}）===")
        print(f"  真值说话帧 {int(truth.sum())} / 总帧 {n_frames}")
        print(f"  检测说话帧 {int(detected.sum())}")
        print(f"  召回 {recall * 100:.0f}%   精确 {precision * 100:.0f}%")
        print(f"  判为说话但其实静音 {fp} 帧；判为静音但其实在说话 {fn} 帧")
        print(f"  低频能量分位：20%={np.percentile(env, 20):.1f}dB  "
              f"95%={np.percentile(env, 95):.1f}dB  门限={np.percentile(env, 20) + (np.percentile(env, 95) - np.percentile(env, 20)) * 0.35:.1f}dB")

        if recall < 0.8:
            print("  ⚠️ 召回不足：检测器会把说话帧当成静音 → 对语音施加静音窗 → 吞字。")
            print("     这是 TransientGate 在真人语音上「语音变化 −11.9dB」的原因。")

    print("\n结论：检测器必须在真人语音上验证过才能用于决策；")
    print("      合成语音上它「看起来正常」只是因为合成语音的能量分布太规整。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
