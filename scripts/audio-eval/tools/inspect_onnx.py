"""打印一个 ONNX 模型的确切输入 / 输出契约。

**为什么需要它**：接入任何 ONNX 模型时，"它要什么张量、名字叫什么、
维度是什么、类型是什么" 决定了前后处理怎么写。猜错的后果是输出一堆噪声，
而现象看起来像"这个模型没用"—— 从而得出完全错误的结论。

在浏览器里移植模型之前，先在这里把契约打印清楚，能省掉几小时的瞎试。

用法：
    pip install onnxruntime
    python tools/inspect_onnx.py path/to/model.onnx
"""

from __future__ import annotations

import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2

    path = Path(argv[1])
    if not path.exists():
        print(f"模型文件不存在：{path}")
        return 1

    try:
        import onnxruntime as ort
    except ImportError:
        print("缺少 onnxruntime：pip install onnxruntime")
        return 1

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])

    print(f"\n模型：{path.name}  （{path.stat().st_size / 1e6:.1f} MB）")
    print(f"可用执行器：{ort.get_available_providers()}")
    print(f"本会话执行器：{sess.get_providers()}")

    print("\n输入：")
    for i in sess.get_inputs():
        print(f"  {i.name:<28} shape={str(i.shape):<22} type={i.type}")
    print("\n输出：")
    for o in sess.get_outputs():
        print(f"  {o.name:<28} shape={str(o.shape):<22} type={o.type}")

    print("\n下一步：")
    print("  · 维度里的字符串（如 'batch'、'time'）是动态轴，说明该模型支持变长输入。")
    print("  · 若输入里出现 feat_erb / feat_spec 这类名字，说明**特征提取在模型外**，")
    print("    你必须自己实现 STFT + ERB 滤波器组 + 归一化 —— 这部分极易写错，")
    print("    建议优先用已经跑通这些的库（见 scripts/audio-eval/models.py 的说明）。")
    print("  · 若输入里出现 hidden / state 这类名字，说明模型是**有状态**的流式模型：")
    print("    每帧推理后要把输出状态喂回输入，否则帧与帧之间不连续，会出咔哒声。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
