"""诊断：oracle 掩码为什么没有把键盘压下去。

上一轮评测里 oracle-irm 的「键压低」只有 -6.8dB，这在直觉上不合理：
按键在时频面上只占少数 bin，理想掩码应当把键盘压掉几十 dB。
所以要么是掩码实现错了，要么是**评测指标本身错了**。

这个脚本绕开评测指标，直接用真值分量算：
    key_reduction = 输出里的键盘分量 / 混合里的键盘分量
    speech_keep   = 输出里的语音分量 / 混合里的语音分量
它顺便验证「混合 = 语音 + 键盘」这个前提是否成立 —— 这是所有 oracle
结论的地基，地基不牢后面全是废话。

用法：
    python tools/diag_oracle.py
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
from evaluate import (  # noqa: E402
    OracleIdealBinaryMask,
    OracleIdealRatioMask,
    OraclePerfectGate,
)


def component_db(x: np.ndarray) -> float:
    return float(10 * np.log10(max(float(np.mean(x.astype(np.float64) ** 2)), 1e-20)))


def main() -> int:
    samples = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
    manifest = json.loads((samples / "manifest.json").read_text("utf8"))
    case = next(c for c in manifest["cases"] if int(round(c["snr_db"])) == 6)

    mixed, _ = read_wav(samples / case["mix"])
    speech_file, _ = read_wav(samples / case["speech_only"])
    keyboard_file, _ = read_wav(samples / case["keyboard_only"])

    n = min(len(mixed), len(speech_file))
    mixed = mixed[:n]

    print("=== 前提检验：混合是不是「语音 + 键盘」的线性叠加 ===")
    k_gain = 10 ** ((component_db(speech_file[:n]) - case["snr_db"] - component_db(keyboard_file[:n])) / 20)
    reconstructed = speech_file[:n] + keyboard_file[:n] * k_gain
    # 混合被整体归一化过，所以比较形状而不是绝对值
    scale = float(np.dot(reconstructed, mixed) / max(np.dot(reconstructed, reconstructed), 1e-20))
    err = mixed - reconstructed * scale
    print(f"  重建误差相对混合：{component_db(err) - component_db(mixed):+.1f} dB "
          f"(越负越好；-40dB 以下说明线性假设成立)")

    # 用重建出的分量作为真值（比直接拿 speech_only 更准：尺度与混合一致）
    speech_in_mix = (speech_file[:n] * scale).astype(np.float64)
    key_in_mix = (keyboard_file[:n] * k_gain * scale).astype(np.float64)
    print(f"  混合中语音分量 {component_db(speech_in_mix):.1f} dBFS，"
          f"键盘分量 {component_db(key_in_mix):.1f} dBFS")

    print("\n=== 各处理器对两个分量分别做了什么 ===")
    print(f"{'处理器':<14}{'键盘衰减':>12}{'语音保留':>12}")
    print("-" * 40)

    for proc in (OracleIdealRatioMask(samples), OracleIdealBinaryMask(samples), OraclePerfectGate()):
        out = proc.process(mixed, SR, case).astype(np.float64)
        m = min(len(out), n)
        # 分量在输出里的残留：用「输出 − 该分量」的能量无法直接分离，
        # 所以改用投影：把输出投影到各分量上，得到该分量的贡献系数。
        denom_s = float(np.dot(speech_in_mix, speech_in_mix))
        denom_k = float(np.dot(key_in_mix, key_in_mix))
        coef_s = float(np.dot(out[:m], speech_in_mix[:m])) / max(denom_s, 1e-20)
        coef_k = float(np.dot(out[:m], key_in_mix[:m])) / max(denom_k, 1e-20)
        key_reduction = 20 * np.log10(max(abs(coef_k), 1e-9))
        speech_keep = 20 * np.log10(max(abs(coef_s), 1e-9))
        print(f"{proc.name:<14}{key_reduction:>11.1f}dB{speech_keep:>11.1f}dB")

    print("\n判读：")
    print("  · 「键盘衰减」很负 = 键盘被压掉；「语音保留」接近 0dB = 语音没被破坏。")
    print("  · 若 oracle 的键盘衰减只有几 dB，说明理想掩码本身就分不开 ——")
    print("    那意味着这个问题在时频掩码框架下不可解，需要更强的模型或额外信息。")
    print("  · 若 oracle 很好而 evaluate.py 报的却很差，说明**指标写错了**，")
    print("    那之前所有基于该指标的结论都要推翻重来。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
