"""诊断瞬态检测器的触发情况：它是在检"咔哒"，还是在检"有声音"？

起因：在真人语音上，`transient-soft` 显示「键压低 −11.1dB / 语音变化 −10.1dB」。
两者数值几乎相同，这很可疑 —— 真正的分离应当是「键盘压得多、语音动得少」。
数值相同通常意味着**它对整段音频施加了同样的增益**，也就是退化成了音量旋钮。

可能的原因：真人语音在 6–16kHz 也有可观能量（擦音、齿音），
若检测器只看「该频带能量高于底噪」，语音就会持续触发它。
那样「说话期间压 12dB」就变成了「一直压 12dB」。

这个脚本量三件事，用真值判断检测器到底在检什么：
  1. 触发帧占比（正常应当远小于说话帧占比，因为按键是稀疏的）；
  2. 触发点与真实按键时刻的匹配率；
  3. 触发点落在说话区间内的比例。

用法：
    python tools/diag_transient.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from dsp import SR, read_wav  # noqa: E402

FRAME = 240


def trigger_mask(x: np.ndarray, sr: int, rise_db: float = 10.0,
                 rise_window_ms: float = 80.0) -> tuple[np.ndarray, np.ndarray]:
    """复现 TransientGate 的触发判据（能量**突增** + 不应期）。"""
    n_frames = len(x) // FRAME
    seg = x[: n_frames * FRAME].reshape(n_frames, FRAME).astype(np.float64)
    seg = seg - np.mean(seg, axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(seg * np.hanning(FRAME), n=FRAME, axis=1))
    freqs = np.fft.rfftfreq(FRAME, 1 / sr)
    band = (freqs >= 6000) & (freqs <= 16000)
    env = 10 * np.log10(np.maximum(np.mean(spec[:, band] ** 2, axis=1), 1e-20))

    win = max(2, int(rise_window_ms / 1000 * sr / FRAME))
    rise = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        rise[i] = env[i] - float(np.min(env[max(0, i - win):i + 1]))

    triggered = rise > rise_db
    min_gap = max(1, int(0.05 * sr / FRAME))
    kept = np.zeros(n_frames, dtype=bool)
    last = -min_gap
    for i in range(n_frames):
        if triggered[i] and (i - last) >= min_gap:
            j = i
            while j + 1 < n_frames and rise[j + 1] > rise[j]:
                j += 1
            kept[j] = True
            last = j
    return kept, env


def matching(times: list[float], triggered: np.ndarray, tol_s: float = 0.03) -> tuple[float, float]:
    """返回（按键被检出的比例, 触发点里对应真实按键的比例）。"""
    hits = 0
    for t in times:
        i = int(t / (FRAME / SR))
        a, b = max(0, i - 3), min(len(triggered), i + 4)
        if triggered[a:b].any():
            hits += 1
    recall = hits / max(1, len(times))

    idx = np.where(triggered)[0]
    if len(idx) == 0:
        return recall, 0.0
    good = 0
    for i in idx:
        t = i * FRAME / SR
        if any(abs(t - k) <= tol_s for k in times):
            good += 1
    return recall, good / len(idx)


def main() -> int:
    for tag, dirname in (("真人语音", "samples_real"), ("合成语音", "samples")):
        samples = HERE / dirname
        if not (samples / "manifest.json").exists():
            continue
        manifest = json.loads((samples / "manifest.json").read_text("utf8"))
        case = next(c for c in manifest["cases"] if int(round(c["snr_db"])) == 6)
        mixed, _ = read_wav(samples / case["mix"])

        triggered, env = trigger_mask(mixed, SR)
        n = len(triggered)
        centers = (np.arange(n) + 0.5) * FRAME / SR

        speech = np.zeros(n, dtype=bool)
        for a, b in case["speech_spans"]:
            speech |= (centers >= a) & (centers <= b)

        in_speech = float((triggered & speech).sum() / max(1, triggered.sum()))
        recall, precision = matching(case["key_times"], triggered)

        print(f"\n=== {tag}（{case['id']}）===")
        print(f"  总帧 {n}，说话帧 {int(speech.sum())}（{speech.sum() / n * 100:.0f}%）")
        print(f"  **触发帧 {int(triggered.sum())}（{triggered.sum() / n * 100:.0f}%）**  "
              f"← 正常应当接近按键占空比（几个百分点）")
        print(f"  触发点落在说话区间内的比例：{in_speech * 100:.0f}%")
        print(f"  按键被检出比例 {recall * 100:.0f}%（召回）")
        print(f"  触发点里确实是按键的比例 {precision * 100:.0f}%（精确）")

        if triggered.sum() / n > 0.25:
            print("  ⚠️ 触发率过高 → 检测器在检「有声音」而不是「有咔哒」。")
            print("     后果：说话期间几乎一直在压，等价于整体降音量（不是分离）。")
        if precision < 0.3:
            print("  ⚠️ 精确率过低 → 大量触发与按键无关（多半是语音的擦音/齿音）。")

    print("\n修法：判据要从「能量高」改成「**能量突增**」——")
    print("      键盘是瞬态（几毫秒内涨 20dB 再衰减），语音是持续能量。")
    print("      用「当前帧相对近邻低分位的抬升」+ 不应期，才能只挑出瞬态。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
