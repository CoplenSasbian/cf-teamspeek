"""绕过 deepfilter-stream 的块处理，直接按帧喂模型。

目的：把「封装层的环形缓冲/重采样/flush」这一层嫌疑彻底排除。
如果直接按帧喂能得到正常输出，说明问题在封装层；如果依然不正常，
说明问题在「数据的性质」上（比如模型要求特定的输入电平或样本分布）。

用法：
    python tools/probe_frames.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from dsp import SR, read_wav, write_wav  # noqa: E402


def db(x: np.ndarray) -> float:
    return float(10 * np.log10(max(float(np.mean(np.asarray(x, dtype=np.float64) ** 2)), 1e-20)))


def corr(a: np.ndarray, b: np.ndarray) -> float:
    n = min(len(a), len(b))
    a, b = a[:n] - np.mean(a[:n]), b[:n] - np.mean(b[:n])
    d = np.sqrt(float(np.dot(a, a)) * float(np.dot(b, b)))
    return float(np.dot(a, b)) / d if d > 0 else 0.0


def run_streaming(session, x: np.ndarray, frame: int, gains: np.ndarray | None = None) -> np.ndarray:
    """按帧喂模型，逐帧收集输出。"""
    inputs = [i.name for i in session.get_inputs()]
    outputs = [o.name for o in session.get_outputs()]

    states: dict[str, np.ndarray] = {}
    with np.load(HERE / "models" / "initial_states.npz") as z:
        for name in inputs[1:]:
            states[name] = z[name].astype(np.float32)

    n_frames = len(x) // frame
    out = np.zeros(n_frames * frame, dtype=np.float32)
    for i in range(n_frames):
        seg = x[i * frame:(i + 1) * frame].astype(np.float32)
        if gains is not None:
            seg = seg * gains[i]
        feeds = {"input_frame": seg}
        feeds.update(states)
        res = session.run(outputs, feeds)
        out[i * frame:(i + 1) * frame] = np.asarray(res[0], dtype=np.float32).reshape(-1)
        for name, val in zip(inputs[1:], res[1:]):
            states[name] = val
    return out


def main() -> int:
    import onnxruntime as ort

    meta = json.loads((HERE / "models" / "meta.json").read_text("utf8"))
    print(f"meta.json: {meta}")

    sess = ort.InferenceSession(
        str(HERE / "models" / "denoiser_model.onnx"), providers=["CPUExecutionProvider"]
    )
    frame = int(sess.get_inputs()[0].shape[0])
    print(f"frame = {frame}\n")

    samples = HERE / "samples"
    manifest = json.loads((samples / "manifest.json").read_text("utf8"))
    case = next(c for c in manifest["cases"] if int(round(c["snr_db"])) == 6)
    mixed, _ = read_wav(samples / case["mix"])
    speech, _ = read_wav(samples / case["speech_only"])

    print(f"{'输入':<22}{'输入dBFS':>10}{'输出dBFS':>10}{'相关系数':>10}")
    print("-" * 54)

    for label, sig in (("干净语音（合成）", speech), ("混合（合成）", mixed)):
        out = run_streaming(sess, sig, frame)
        # 模型有 512 样本(10.7ms)的内部延迟，比较时对齐
        lag = frame
        r = corr(sig[: len(sig) - lag], out[lag:])
        print(f"{label:<22}{db(sig):>10.1f}{db(out):>10.1f}{r:>10.3f}")
        write_wav(HERE / "out" / f"frames_{label[:4]}_in.wav", sig)
        write_wav(HERE / "out" / f"frames_{label[:4]}_out.wav", out)

    # 附加实验：把输入放大到 -20dBFS 左右（有些模型对输入电平有隐含要求）
    print("\n=== 输入电平敏感性（看是不是电平问题）===")
    print(f"{'输入增益':<14}{'输出dBFS':>10}{'相关系数':>10}")
    for gain_db in (-12.0, 0.0, 6.0, 12.0, 20.0):
        g = 10 ** (gain_db / 20)
        out = run_streaming(sess, speech * g, frame)
        r = corr(speech[: len(speech) - frame] * g, out[frame:])
        print(f"{gain_db:+.0f}dB{'':<9}{db(out):>10.1f}{r:>10.3f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
