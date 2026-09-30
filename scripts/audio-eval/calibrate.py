"""打印电平校准表 —— 解释「门限为什么不管用」的关键数据。

门限类方案的判据是「检测带内电平 > 阈值」。所以只有把
  「键盘事件在 500–4000Hz 检测带内的 RMS」
与「阈值（默认 -45 dBFS）」
放在一起看，才能判断门到底会不会打开。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

HERE = Path(__file__).parent
SAMPLES = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))

GATE_THRESHOLDS = (-45.0, -30.0, -20.0)


def main() -> None:
    manifest = json.loads((SAMPLES / "manifest.json").read_text("utf8"))
    print(f"{'用例':<16}{'SNR':>6}{'语音RMS':>10}{'键盘RMS':>10}{'键盘峰值':>10}{'检测带内RMS':>13}")
    print("-" * 68)
    for case in manifest["cases"]:
        L = case["levels"]
        print(
            f"{case['id']:<16}{case['snr_db']:>5.0f}dB"
            f"{L['speech_rms_dbfs']:>9.1f}{L['keyboard_rms_dbfs']:>10.1f}"
            f"{L['keyboard_peak_dbfs']:>10.1f}{L['keyboard_band_rms_dbfs']:>13.1f}"
        )

    print("\n门限阈值会怎样判定（看「检测带内RMS」这一列）：")
    print(f"{'阈值':>8}   每个用例上门是否打开（开 = 键盘原样通过）")
    for th in GATE_THRESHOLDS:
        verdicts = []
        for case in manifest["cases"]:
            band = case["levels"]["keyboard_band_rms_dbfs"]
            verdicts.append("开" if band > th else "关")
        opened = verdicts.count("开")
        print(
            f"{th:>7.0f}dB   {' '.join(verdicts)}   （{opened}/{len(verdicts)} 个用例上会为键盘开门）"
        )

    print("\n结论：键盘事件只要在检测带内高于阈值，门就会为它打开 —— 打游戏时键盘")
    print("      恰好又响又密，所以默认阈值下门几乎一直开着，键盘原样送出去。")
    print("      把阈值收紧到键盘之下，语音的清音段（同样非平稳、能量相近）也会被关掉；")
    print("      而且表里显示收紧后只有部分用例能挡住 —— 它是在赌运气，不是在做分离。")


if __name__ == "__main__":
    main()
