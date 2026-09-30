"""诊断：一个处理器的输出是不是「只是整体变了音量」。

为什么必须先排除这个：如果模型输出只是被缩小了几十 dB，评测会显示
「语音变化 −36dB」，看起来像「严重吞字」，但实际上只要把增益补回去就完好无损。
**不排除缩放就直接下结论，会误杀一个好模型**（或误判一个坏模型）。

这里用「最优增益下的归一化误差」判断：
    g = <out, in> / <in, in>          （最小二乘最优增益）
    residual = out - g*in
如果 residual 比 out 小很多，说明输出基本就是输入的缩放版。

用法：
    python tools/diag_scale.py dfn3
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
from evaluate import get_processors  # noqa: E402


def db(x: np.ndarray) -> float:
    return float(10 * np.log10(max(float(np.mean(x.astype(np.float64) ** 2)), 1e-20)))


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else "dfn3"
    samples = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
    manifest = json.loads((samples / "manifest.json").read_text("utf8"))
    case = next(c for c in manifest["cases"] if int(round(c["snr_db"])) == 6)

    registry = get_processors(samples)
    if name not in registry:
        print(f"未知处理器 {name}；可用：{sorted(registry)}")
        return 1

    mixed, _ = read_wav(samples / case["mix"])
    speech, _ = read_wav(samples / case["speech_only"])
    out = np.asarray(registry[name].process(mixed, SR, case), dtype=np.float64)

    n = min(len(mixed), len(out), len(speech))
    mixed, out, speech = mixed[:n].astype(np.float64), out[:n], speech[:n]

    # 只在与干净语音对齐的部分比较（混合里的语音分量 = scale * speech）
    scale = float(np.dot(speech, mixed) / max(np.dot(speech, speech), 1e-20))
    speech_in_mix = speech * scale

    g = float(np.dot(out, mixed) / max(np.dot(mixed, mixed), 1e-20))
    residual = out - g * mixed

    print(f"处理器 {name}  用例 {case['id']}")
    print(f"  混合          {db(mixed):>7.1f} dBFS")
    print(f"  输出          {db(out):>7.1f} dBFS")
    print(f"  输出/混合     {db(out) - db(mixed):>+7.1f} dB   ← 整体增益变化")
    print(f"  最优增益 g    {20 * np.log10(abs(g) + 1e-20):>+7.1f} dB")
    print(f"  归一化后残差  {db(residual) - db(out):>+7.1f} dB   ← 越负说明越像「纯缩放」")

    gs = float(np.dot(out, speech_in_mix) / max(np.dot(speech_in_mix, speech_in_mix), 1e-20))
    print(f"\n  输出里语音分量的系数 {20 * np.log10(abs(gs) + 1e-20):>+7.1f} dB "
          f"(0dB = 语音完好保留)")
    if abs(20 * np.log10(abs(gs) + 1e-20)) > 6:
        print("  ⚠️ 语音被显著改变。若上面「归一化后残差」很负，说明是**整体增益**问题；")
        print("     否则才是真的处理掉了语音。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
