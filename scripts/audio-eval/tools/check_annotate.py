"""标注助手的准确度自检。

`annotate.py` 是**估计**工具，如果不验证它准不准，用它标出来的数据就会
把错误结论带进评测。这里拿合成样本当被测对象 —— 因为合成样本有真值
（manifest 里的 key_times / speech_spans），可以量化检测得对不对。

用法：
    python tools/check_annotate.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from annotate import detect_keys, detect_speech  # noqa: E402
from dsp import SR, read_wav  # noqa: E402


def match_rate(truth: list[float], found: list[float], tol: float = 0.08) -> tuple[float, float]:
    """返回 (召回率, 误报率)。

    召回率：真值里有多少被检出（容差 tol 秒）
    误报率：检出里有多少不在真值附近
    """
    if not truth:
        return 1.0, 0.0
    matched = sum(1 for t in truth if any(abs(t - f) <= tol for f in found))
    false_pos = sum(1 for f in found if not any(abs(t - f) <= tol for t in truth))
    return matched / len(truth), false_pos / max(1, len(found))


def main() -> int:
    import os

    samples = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
    manifest_path = samples / "manifest.json"
    if not manifest_path.exists():
        print(f"找不到 {manifest_path}；先跑 make_samples.py")
        return 1

    manifest = json.loads(manifest_path.read_text("utf8"))
    # 三档 SNR 全测：0dB（键盘与语音一样响）最容易漏检，必须覆盖
    cases = sorted(manifest["cases"], key=lambda c: c["id"])

    print(f"{'用例':<16}{'真值按键':>10}{'检出':>8}{'召回':>8}{'误报':>8}   说话区间召回")
    print("-" * 72)
    for case in cases:
        mixed, _ = read_wav(samples / case["mix"])
        keys = detect_keys(mixed)
        recall, fp = match_rate(case["key_times"], keys)

        speech_found = detect_speech(mixed)
        # 说话区间用「覆盖了真值多少」衡量：按真值中点是否落在某个检出区间内
        hits = 0
        for a, b in case["speech_spans"]:
            mid = (a + b) / 2
            if any(x <= mid <= y for x, y in speech_found):
                hits += 1
        speech_recall = hits / max(1, len(case["speech_spans"]))

        print(f"{case['id']:<16}{len(case['key_times']):>10}{len(keys):>8}"
              f"{recall * 100:>7.0f}%{fp * 100:>7.0f}%{speech_recall * 100:>13.0f}%")

    print("\n判读：")
    print("  · 召回低 → 漏标按键，评测会低估问题（看起来「键盘不多」）。")
    print("  · 误报高 → 把语音的清音当键盘，评测会高估问题。")
    print("  · 说话区间召回低 → 语音/键盘的重叠判定失准，最关键的指标会失真。")
    print("  真实录音的准确度通常低于合成样本，所以产出仍建议人工核对一遍。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
