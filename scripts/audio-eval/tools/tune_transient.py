"""搜索瞬态门限的最佳参数：在「语音损失可接受」的前提下最大化键盘抑制。

为什么需要搜索：瞬态门限有两个互相拉扯的旋钮 ——
  · 压制越狠（说话期间衰减越多、静音窗越长）→ 键盘越干净，语音越糊；
  · 越保守 → 语音越完整，键盘越明显。
靠手调只能找到「某个还行」的点，而且容易在改了别处之后失去参考。
这里把权衡曲线算出来，让选择有依据。

用法：
    python tools/tune_transient.py
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
from evaluate import TransientGate, measure  # noqa: E402

# 语音损失上限（dB）。超过这个值就认为「吞字」了，不论键盘压得多干净都不用。
SPEECH_LOSS_BUDGET = 3.0


def main() -> int:
    samples = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
    manifest = json.loads((samples / "manifest.json").read_text("utf8"))
    cases = manifest["cases"]

    grid = []
    for atten in (0.0, -6.0, -12.0, -18.0, -24.0):
        for hold in (4.0, 6.0, 10.0):
            for rise in (8.0, 10.0, 14.0):
                grid.append((atten, hold, rise))

    print(f"搜索 {len(grid)} 组参数（{len(cases)} 个用例求平均，语音损失预算 {SPEECH_LOSS_BUDGET}dB）\n")
    print(f"{'说话期衰减':>10}{'静音窗':>8}{'触发门限':>10}{'键压低(说话中)':>16}{'语音变化':>10}   结论")
    print("-" * 78)

    best: tuple[float, tuple[float, float, float], float, float] | None = None
    rows = []

    for atten, hold, rise in grid:
        proc = TransientGate(speech_atten_db=atten, speech_hold_ms=hold, hold_ms=hold, rise_db=rise)
        key_drops, speech_drops = [], []
        for case in cases:
            mixed, _ = read_wav(samples / case["mix"])
            out = proc.process(mixed, SR, case)
            m = measure(case["id"], "tune", mixed, out, case, samples)
            if not np.isnan(m.key_speech_drop_db):
                key_drops.append(m.key_speech_drop_db)
            if not np.isnan(m.speech_drop_db):
                speech_drops.append(m.speech_drop_db)

        key_avg = float(np.mean(key_drops)) if key_drops else float("nan")
        spk_avg = float(np.mean(speech_drops)) if speech_drops else float("nan")

        ok = spk_avg >= -SPEECH_LOSS_BUDGET
        verdict = "候选" if ok else "语音损失超预算"
        if ok and (best is None or key_avg < best[0]):
            best = (key_avg, (atten, hold, rise), key_avg, spk_avg)

        rows.append((atten, hold, rise, key_avg, spk_avg, ok, verdict))

    # 只打印「每档衰减里的最优」以及突破预算的边界，避免刷屏
    for atten in (0.0, -6.0, -12.0, -18.0, -24.0):
        subset = [r for r in rows if r[0] == atten and r[5]]
        if not subset:
            subset = [r for r in rows if r[0] == atten]
            subset.sort(key=lambda r: -r[4])
            show = subset[:1]
        else:
            show = sorted(subset, key=lambda r: r[3])[:2]
        for atten_, hold_, rise_, key_, spk_, ok_, verdict_ in show:
            print(f"{atten_:>9.0f}dB{hold_:>7.0f}ms{rise_:>9.0f}dB{key_:>15.1f}dB{spk_:>9.1f}dB   {verdict_}")

    print()
    if best is not None:
        atten, (h, hold, rise), key_avg, spk_avg = best
        print("最佳候选（满足语音损失预算的前提下键盘压得最狠）：")
        print(f"  speech_atten_db={atten:.0f}  hold_ms={hold:.0f}  rise_db={rise:.0f}")
        print(f"  键压低(说话中) = {key_avg:.1f}dB   语音变化 = {spk_avg:.1f}dB")
        print()
        print("参考：")
        print("  · 你现在的能量门限：键压低 0.0dB（键盘原样通过），语音变化 −0.2dB")
        print("  · oracle-irm（理想时频掩码）：键压低 约 −10dB，已是掩码框架的上限")
    else:
        print("没有任何参数组合能在语音损失预算内有效压制键盘 —— 需要更强的手段。")

    print("\n注意：这里用的是合成样本，结论用于筛掉不行的组合，最终仍需真实录音确认。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
