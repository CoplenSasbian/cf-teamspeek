"""导出 Python 侧的状态演化，与 `js/dump-states.mjs` 做逐帧对比。

这是定位 JS 穿线 bug 的标准做法：喂**完全相同的输入**，看两边内部状态何时开始分叉。
分叉发生在第几帧、哪个状态，就直接指向穿线代码里的哪一行。

用法：
    python tools/dump_states.py
"""

from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

FRAME = 512
N_FRAMES = 20


def stats(a: np.ndarray) -> dict:
    a = np.asarray(a, dtype=np.float64).ravel()
    return {"mean": round(float(a.mean()), 4), "std": round(float(a.std()), 4)}


def main() -> int:
    import onnxruntime as ort

    wav_path = HERE / "real" / "harvard_m1.wav"
    with wave.open(str(wav_path), "rb") as f:
        raw = f.readframes(f.getnframes())
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    need = N_FRAMES * FRAME
    x = data[:need].astype(np.float64)
    x = x / np.sqrt(np.mean(x ** 2)) * (10 ** (-26 / 20))  # 归一化到 -26dBFS

    sess = ort.InferenceSession(
        str(HERE / "models" / "denoiser_model.onnx"), providers=["CPUExecutionProvider"]
    )
    inputs = [i.name for i in sess.get_inputs()]
    outputs = [o.name for o in sess.get_outputs()]

    with np.load(HERE / "models" / "initial_states.npz") as z:
        states = {n: z[n].astype(np.float32) for n in inputs[1:]}

    rows = []
    for f in range(N_FRAMES):
        feeds = {"input_frame": x[f * FRAME:(f + 1) * FRAME].astype(np.float32)}
        feeds.update(states)
        res = sess.run(outputs, feeds)
        audio = np.asarray(res[0], dtype=np.float32).reshape(-1)
        for name, val in zip(inputs[1:], res[1:]):
            states[name] = val

        rows.append({
            "frame": f,
            "audioRms": round(float(np.sqrt(np.mean(audio ** 2))), 6),
            "erb": stats(states["erb_norm_state"]),
            "enc": stats(states["enc_hidden"]),
            "specX": stats(states["rolling_spec_buf_x"]),
        })

    print(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
