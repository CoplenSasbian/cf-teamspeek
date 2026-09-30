"""核实：把静音窗拉长到覆盖键盘整个衰减过程，能压到什么程度？

`tune_transient.py` 显示 10ms 静音窗只能压 6dB。但合成键盘事件的实际能量
持续约 20–55ms（`synth_key_event` 的 dur），而静音窗开启前还留了 2ms。
所以在说话期间，静音窗大概只盖住了键盘事件的前半段。

这引出一个**因果性的根本问题**：
  · 若静音窗拉长到 30ms，说话期间就会每 70–220ms 出现一次 30ms 的空洞，
    语音会被切成断续的碎片（听觉上非常明显，比键盘声更糟）；
  · 若静音窗保持短，键盘的尾巴就漏出去。

也就是说：**瞬态门限在「键盘尾巴」和「语音完整性」之间没有双赢解**，
除非能只掐掉高频部分（键盘）而保留语音的低频根基。

最后一个实验：验证「只在检测到瞬态时对 6kHz 以上做高通静音」是否更好 ——
键盘能量集中在高频，语音根基在低频，按频带分别处理才是分辨「咔哒」与「语音」
的正确维度。这也直接解释了为什么时频掩码（oracle-irm）能做到 10dB。

用法：
    python tools/tune_bandsplit.py
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
from evaluate import measure  # noqa: E402


class BandSplitGate:
    """检测到瞬态时，只压高频，保留语音根基。

    实现：把信号拆成「低频（<cutoff）」与「高频（>=cutoff）」两支，
    触发时只把高频支的增益压下去，低频支原样通过。
    这样即使静音窗很长，语音的基频与第一共振峰也不受影响 ——
    代价只是声音稍微「发闷」几百毫秒，而不是被切成碎片。
    """

    def __init__(self, cutoff_hz: float = 4000.0, rise_db: float = 8.0,
                 hold_ms: float = 15.0, pre_ms: float = 3.0,
                 high_atten_db: float = -24.0, low_atten_db: float = 0.0) -> None:
        self.cutoff = cutoff_hz
        self.rise_db = rise_db
        self.hold_ms = hold_ms
        self.pre_ms = pre_ms
        self.high_atten_db = high_atten_db
        self.low_atten_db = low_atten_db

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        frame = 240
        n = len(mixed)
        n_frames = n // frame

        # 频带拆分
        spec = np.fft.rfft(mixed[: n_frames * frame].reshape(n_frames, frame) * np.hanning(frame), n=frame, axis=1)
        freqs = np.fft.rfftfreq(frame, 1 / sr)
        m_low = freqs < self.cutoff
        m_high = ~m_low
        env = 10 * np.log10(np.maximum(np.mean(np.abs(spec[:, m_high]) ** 2, axis=1), 1e-20))

        floor = float(np.percentile(env, 30))
        triggered = env > floor + self.rise_db

        gain_high = np.ones(n, dtype=np.float64)
        hold = int(self.hold_ms / 1000 * sr)
        pre = int(self.pre_ms / 1000 * sr)
        for i in np.where(triggered)[0]:
            a = max(0, i * frame - pre)
            b = min(n, i * frame + hold)
            gain_high[a:b] = 10 ** (self.high_atten_db / 20)

        ramp = max(1, int(0.001 * sr))
        gain_high = np.convolve(gain_high, np.ones(ramp) / ramp, mode="same")

        # 分频处理
        full = np.fft.rfft(mixed)
        f_all = np.fft.rfftfreq(n, 1 / sr)
        low = np.fft.irfft(np.where(f_all < self.cutoff, full, 0), n=n)
        high = np.fft.irfft(np.where(f_all >= self.cutoff, full, 0), n=n)
        return (low + high * gain_high).astype(np.float32)


def main() -> int:
    samples = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
    manifest = json.loads((samples / "manifest.json").read_text("utf8"))
    cases = manifest["cases"]

    configs = [
        ("4k/-24dB/15ms", dict(cutoff_hz=4000, high_atten_db=-24.0, hold_ms=15.0)),
        ("4k/-24dB/25ms", dict(cutoff_hz=4000, high_atten_db=-24.0, hold_ms=25.0)),
        ("4k/-40dB/25ms", dict(cutoff_hz=4000, high_atten_db=-40.0, hold_ms=25.0)),
        ("2k/-24dB/25ms", dict(cutoff_hz=2000, high_atten_db=-24.0, hold_ms=25.0)),
        ("6k/-24dB/25ms", dict(cutoff_hz=6000, high_atten_db=-24.0, hold_ms=25.0)),
        ("6k/-40dB/40ms", dict(cutoff_hz=6000, high_atten_db=-40.0, hold_ms=40.0)),
    ]

    print(f"{'配置':<18}{'键压低(说话中)':>16}{'语音变化':>10}{'语音残留':>10}")
    print("-" * 56)
    for label, kwargs in configs:
        proc = BandSplitGate(**kwargs)
        keys, spk = [], []
        for case in cases:
            mixed, _ = read_wav(samples / case["mix"])
            out = proc.process(mixed, SR, case)
            m = measure(case["id"], label, mixed, out, case, samples)
            if not np.isnan(m.key_speech_drop_db):
                keys.append(m.key_speech_drop_db)
            if not np.isnan(m.speech_drop_db):
                spk.append(m.speech_drop_db)
        print(f"{label:<18}{float(np.mean(keys)):>15.1f}dB{float(np.mean(spk)):>9.1f}dB"
              f"{(float(np.mean(spk)) * 0):>10.1f}")

    print("\n参考值：")
    print("  · 现有能量门限：键压低 0.0dB")
    print("  · 瞬态全带静音（10ms 窗）：键压低 −6.0dB")
    print("  · oracle-irm（理想时频掩码）：键压低 约 −10dB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
