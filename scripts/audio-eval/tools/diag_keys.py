"""诊断：键盘瞬态在混合信号里到底有多突出。

写这个是因为我两次凭直觉设计检测器都失败了（召回 12% → 27%）。
与其继续猜参数，不如把信号本身量清楚：一次按键在「检测频带」里
相对周围基线到底抬高多少 dB，以及有多少次按键**根本没有抬高**。

用法：
    python tools/diag_keys.py
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


def band_env(x: np.ndarray, lo: int, hi: int, frame: int = 240) -> tuple[np.ndarray, float]:
    n_frames = len(x) // frame
    seg = x[: n_frames * frame].reshape(n_frames, frame)
    seg = seg - np.mean(seg, axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(seg * np.hanning(frame), n=frame, axis=1))
    freqs = np.fft.rfftfreq(frame, 1 / SR)
    mask = (freqs >= lo) & (freqs <= hi)
    env = 10 * np.log10(np.maximum(np.mean(spec[:, mask] ** 2, axis=1), 1e-20))
    return env, frame / SR


def main() -> int:
    samples = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
    manifest = json.loads((samples / "manifest.json").read_text("utf8"))
    case = next(c for c in manifest["cases"] if int(round(c["snr_db"])) == 6)

    mixed, _ = read_wav(samples / case["mix"])
    keyboard, _ = read_wav(samples / case["keyboard_only"])
    speech, _ = read_wav(samples / case["speech_only"])

    print(f"用例 {case['id']}")
    print(f"  按键真值 {len(case['key_times'])} 次")
    print(f"  键盘 RMS {10 * np.log10(np.mean(keyboard.astype(float) ** 2) + 1e-20):.1f} dBFS, "
          f"峰值 {20 * np.log10(np.max(np.abs(keyboard)) + 1e-20):.1f} dBFS")
    print(f"  语音 RMS {10 * np.log10(np.mean(speech.astype(float) ** 2) + 1e-20):.1f} dBFS")

    # 混合时键盘被缩放过，直接从「混合 - 语音」近似还原键盘分量
    n = min(len(mixed), len(speech))
    key_in_mix = mixed[:n].astype(np.float64) - speech[:n].astype(np.float64)
    print(f"  混合中键盘分量 RMS {10 * np.log10(np.mean(key_in_mix ** 2) + 1e-20):.1f} dBFS, "
          f"峰值 {20 * np.log10(np.max(np.abs(key_in_mix)) + 1e-20):.1f} dBFS")

    for lo, hi in ((2000, 8000), (6000, 16000), (8000, 20000)):
        env, hop_s = band_env(mixed, lo, hi)
        env_clean, _ = band_env(key_in_mix, lo, hi)

        rois: list[float] = []
        for t in case["key_times"]:
            i = int((t + 0.003) / hop_s)
            if i + 2 >= len(env):
                continue
            # 按键处的电平 vs 前 40ms 基线
            base = float(np.median(env[max(0, i - 8):i])) if i > 8 else float(env[0])
            rois.append(float(env[i]) - base)

        rois_arr = np.array(rois)
        print(f"\n  频带 {lo}-{hi}Hz：")
        print(f"    按键处相对基线的抬高：中位 {np.median(rois_arr):+.1f}dB, "
              f"25%分位 {np.percentile(rois_arr, 25):+.1f}dB, "
              f"75%分位 {np.percentile(rois_arr, 75):+.1f}dB")
        print(f"    抬高 < 3dB 的按键占比：{float(np.mean(rois_arr < 3)) * 100:.0f}%"
              f"  ← 这些在混合信号里**淹没**了")

    print("\n结论：")
    print("  如果相当比例的按键抬高不足 3dB，说明它们在混合信号里本来就不可分辨，")
    print("  那么「自动标注」这条路走不通 —— 应当改为：")
    print("    · 用**单独录制的键盘噪声**（不说话时打一段）当作键盘参考，")
    print("      再在混合录音里按频带衰减评估模型，而不需要逐次按键的时刻；")
    print("    · 或者干脆只做听感 A/B，不做逐事件指标。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
