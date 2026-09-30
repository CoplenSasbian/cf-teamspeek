"""不用真人语音，判断 DFN3 是否在正常工作：检查它的内部状态。

思路：DFN3 内部维护若干流式状态（ERB 指数均值归一化、单位归一化、GRU 隐状态、
分析/合成记忆）。这些状态在**正常工作时**应当表现出明确特征：

  · erb_norm_state：指数均值归一化器的均值，应当**收敛到接近 0**；
  · band_unit_norm_state：单位归一化，应当收敛到**接近 1**（归一化后单位方差）；
  · enc_hidden 等 GRU 状态：应当有非平凡的变化，而不是停在初值或发散。

如果模型收到的是它不认识的信号（或调用方式错误），典型表现是：
  · 状态停在初始值不动（说明内部短路 / 分支没走）；
  · 状态数值爆炸或塌缩到 0（说明数值不稳定）；
  · 归一化状态收敛到明显偏离 0/1 的值（说明它在"努力归一化"一个不合理的输入）。

这能区分「模型不认这种语音」与「调用根本是错的」，而且**不需要真人语音**。

用法：
    python tools/diag_states.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from dsp import SR, read_wav  # noqa: E402


def summarize(name: str, arr: np.ndarray) -> str:
    a = np.asarray(arr, dtype=np.float64).ravel()
    return (f"{name:<26} shape={str(np.shape(arr)):<18} "
            f"mean={a.mean():+.4f} std={a.std():.4f} "
            f"min={a.min():+.3f} max={a.max():+.3f}")


def run_and_track(session, x: np.ndarray, frame: int, label: str) -> dict[str, np.ndarray]:
    """按帧喂，返回「输入结束后」的状态。"""
    inputs = [i.name for i in session.get_inputs()]
    outputs = [o.name for o in session.get_outputs()]

    with np.load(HERE / "models" / "initial_states.npz") as z:
        init = {n: z[n].astype(np.float32) for n in inputs[1:]}
    states = {k: v.copy() for k, v in init.items()}

    n_frames = len(x) // frame
    for i in range(n_frames):
        feeds = {"input_frame": x[i * frame:(i + 1) * frame].astype(np.float32)}
        feeds.update(states)
        res = session.run(outputs, feeds)
        for name, val in zip(inputs[1:], res[1:]):
            states[name] = val

    print(f"\n--- {label}（{n_frames} 帧）---")
    for key in ("erb_norm_state", "band_unit_norm_state"):
        if key in states:
            print("  " + summarize(key, states[key]))
            if key in init:
                print("  " + summarize("  ↑ 初始值", init[key]))
    for key in ("enc_hidden", "erb_dec_hidden", "df_dec_hidden"):
        if key in states:
            print("  " + summarize(key, states[key]))
    return states


def main() -> int:
    import onnxruntime as ort

    sess = ort.InferenceSession(
        str(HERE / "models" / "denoiser_model.onnx"), providers=["CPUExecutionProvider"]
    )
    frame = int(sess.get_inputs()[0].shape[0])

    samples = HERE / "samples"
    speech, _ = read_wav(samples / "case0_speech_only.wav")
    mixed, _ = read_wav(samples / "case0_mixed_snr06.wav")
    noise = np.random.default_rng(7).normal(0, 0.03, len(speech)).astype(np.float32)

    print("=== 模型状态诊断 ===")
    print("期望：erb_norm_state 收敛到 ≈0，band_unit_norm_state 收敛到 ≈1；")
    print("      GRU 状态有非平凡变化（std > 0）。若停在初值或发散，说明调用有问题。")

    run_and_track(sess, speech, frame, "合成语音")
    run_and_track(sess, mixed, frame, "混合")
    run_and_track(sess, noise, frame, "白噪声（对照：模型应当判为噪声）")

    print("\n=== 对照：初始状态 ===")
    with np.load(HERE / "models" / "initial_states.npz") as z:
        for key in ("erb_norm_state", "band_unit_norm_state"):
            if key in z:
                print("  " + summarize(key, z[key]))

    print("\n判读：")
    print("  · 若「白噪声」与「合成语音」的状态几乎一样 → 模型没区分输入，调用或输入有问题。")
    print("  · 若归一化状态在三种输入上收敛到同样的值 → 模型处于某种退化模式。")
    print("  · 若合成语音的状态与噪声明显不同，且归一化状态收敛正常 → 模型是活的，")
    print("    那问题就更偏向「合成语音不在分布内」。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
