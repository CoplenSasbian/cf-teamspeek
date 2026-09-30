"""把现成的 ONNX 降噪/分离模型接进评测台。

设计原则：**不自己重写模型的特征提取与状态管理。**
DeepFilterNet3 的 ERB/DF 特征、指数均值归一化、帧间 GRU 状态，细节多且
容易写错 —— 写错的表现是「模型看起来无效」，比不写更糟。
所以这里调用已经把这些跑通的库，评测逻辑只管喂音频和收音频。

依赖（你本机执行，需要联网）：
    pip install onnxruntime numpy deepfilter-stream

用法：
    python evaluate.py --processor dfn3            # 用 deepfilter-stream 的封装
    python evaluate.py --processor dfn3 onnx       # 两者都跑，互相校验

如果 `deepfilter-stream` 的 API 与我这里写的不同，脚本会打印它的实际
成员列表，照提示改一处即可（见 _DeepFilterStreamAdapter.probe）。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np

from dsp import SR, eprint


class ModelUnavailable(RuntimeError):
    """模型依赖或权重缺失 —— 明确报错，不要静默降级成 identity。

    静默降级会让评测结果看起来「这个模型没用」，从而得出错误结论。
    """


def _require(module: str, hint: str) -> Any:
    try:
        return __import__(module)
    except ImportError as err:  # pragma: no cover - 取决于运行环境
        raise ModelUnavailable(f"缺少依赖 {module}：{hint}") from err


# ------------------------------------------------------------
#  DeepFilterNet3（经 deepfilter-stream 封装）
# ------------------------------------------------------------

class _DeepFilterStreamAdapter:
    """包一层，吸收 API 细节差异。

    我只依赖两件事，且都做了存在性检查：
      1. 能从模型拿到一个「流」对象（每路音频一个，持有 GRU 状态）
      2. 能对任意长度音频块调用它，拿回同样长度的增强音频

    deepfilter-stream 的 README 给出的形态是：
        model = DeepFilterModel()
        stream = model.new_stream()
        enhanced = stream.process(noisy_float32, sr=48000)
    但为稳妥起见，这里按能力探测而不是硬编码。
    """

    #: 仓库内的本地权重目录（由 tools/fetch_model.py 下载）
    LOCAL_DIR = Path(__file__).parent / "models"

    def __init__(self, model_dir: Path | None = None) -> None:
        dfs = _require("deepfilter_stream", "pip install deepfilter-stream")

        # 优先用本地目录：包自带的下载器一次失败就放弃、也不校验断流，
        # 首次使用时很容易失败（我们实测第一次就下到损坏文件）。
        target = model_dir or (self.LOCAL_DIR if self.LOCAL_DIR.exists() else None)
        if target is not None:
            os.environ["DEEPFILTER_STREAM_MODEL_DIR"] = str(target)

        model_cls = getattr(dfs, "DeepFilterModel", None)
        if model_cls is None:
            raise ModelUnavailable(
                f"deepfilter_stream 里没有 DeepFilterModel，实际成员：{dir(dfs)}"
            )
        self._model = model_cls()

    def new_stream(self) -> Any:
        if hasattr(self._model, "new_stream"):
            return self._model.new_stream()
        raise ModelUnavailable(
            f"DeepFilterModel 没有 new_stream()，实际成员：{dir(self._model)}"
        )


class DeepFilterNet3:
    """处理器：按流式方式跑 DeepFilterNet3。

    注意 **每次 process() 都新建一条流**：评测是按整段音频算指标的，
    而流式状态必须从零开始。如果跨用例复用同一条流，上一段音频的 GRU 状态
    会污染下一段，指标就不可信了。

    另外内置了**输出健全性检查**（见 _health_warning）：如果模型的输出与输入
    几乎不相关，说明调用方式或输入分布有问题 —— 这时评测数字毫无意义，
    必须显式喊出来，而不是安静地输出一份漂亮的表格。
    """

    name = "dfn3"
    note = "DeepFilterNet3（ONNX，经 deepfilter-stream）"

    def __init__(self, model_dir: Path | None = None) -> None:
        self._adapter = _DeepFilterStreamAdapter(model_dir)
        self._model_dir = model_dir
        self._checked = False

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        # case（真值）刻意忽略：真实模型拿不到它，只有 oracle 才允许用
        stream = self._adapter.new_stream()
        out = stream.process(mixed.astype(np.float32), sr=sr)

        # 流式处理会持有尾部（不足一帧的部分），必须 flush 把尾巴排出来，
        # 否则输出比输入短，后面的对齐/指标都会被这段长度差污染。
        flush = getattr(stream, "flush", None)
        if callable(flush):
            tail = flush()
            if tail is not None and np.size(tail):
                out = np.concatenate([out, np.asarray(tail, dtype=np.float32)])

        out = np.asarray(out, dtype=np.float32).reshape(-1)

        if not self._checked:
            self._checked = True
            warn = _health_warning(mixed, out)
            if warn:
                eprint(f"\n⚠️  {self.name} 输出健全性检查未通过：{warn}\n"
                       f"    下面的 dfn3 指标不可信，请先排查调用方式与输入分布。\n")

        return out


def _health_warning(mixed: np.ndarray, out: np.ndarray) -> str | None:
    """检查模型输出是否"像"处理过的输入。

    判据：在最优延迟对齐下算相关系数。一个正常工作的语音增强模型，
    输出应当与输入显著相关（保留语音），而不是一段无关信号。

    实测教训：我们曾在合成语音上得到 r=0.33 / SI-SDR −9dB 的输出，
    却差点把它当成「模型无效」的结论。没有这道检查，这种垃圾结果会
    安静地流进指标表，误导后面的所有决策。
    """
    a = np.asarray(mixed, dtype=np.float64).reshape(-1)
    b = np.asarray(out, dtype=np.float64).reshape(-1)
    n = min(len(a), len(b))
    if n < 48000:
        return None  # 太短，不做判断

    a = a[:n] - np.mean(a[:n])
    b = b[:n] - np.mean(b[:n])
    best_r = -1.0
    # 模型固有延迟约 512 样本（约 10.7ms），在 0–40ms 内搜索
    for lag in range(0, 2000, 8):
        x, y = a[: n - lag], b[lag:n]
        denom = np.sqrt(float(np.dot(x, x)) * float(np.dot(y, y)))
        if denom <= 0:
            continue
        r = float(np.dot(x, y)) / denom
        if r > best_r:
            best_r = r

    if best_r < 0.5:
        gain_db = 10 * np.log10(max(float(np.mean(b ** 2)), 1e-20) / max(float(np.mean(a ** 2)), 1e-20))
        return (f"输出与输入几乎不相关（最佳对齐 r={best_r:.2f} < 0.5），"
                f"整体电平变化 {gain_db:+.1f}dB")
    return None


# ------------------------------------------------------------
#  通用 ONNX 直连（给「自己导出模型」的路线用）
# ------------------------------------------------------------

class RawOnnxModel:
    """直接跑一个 ONNX 图，用于试验性模型。

    ⚠️ 它**不做任何特征提取**：输入输出就是图本身要求的张量。
    只有当你确认了模型的确切 I/O 契约（用 tools/inspect_onnx.py 打印）
    并且自己补齐了前后处理时，它才是有意义的。
    对 DeepFilterNet 这类模型，请优先用上面的 DeepFilterNet3，
    不要用这个 —— 手写 DFN3 的预处理几乎一定会出错。
    """

    def __init__(self, model_path: Path, input_name: str | None = None) -> None:
        ort = _require("onnxruntime", "pip install onnxruntime")
        if not model_path.exists():
            raise ModelUnavailable(f"模型文件不存在：{model_path}")
        self._sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self._input_name = input_name or self._sess.get_inputs()[0].name
        eprint(
            f"[onnx] 已加载 {model_path.name}；"
            f"输入={[(i.name, i.shape, i.type) for i in self._sess.get_inputs()]} "
            f"输出={[(o.name, o.shape, o.type) for o in self._sess.get_outputs()]}"
        )

    def run(self, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        return self._sess.run(None, feeds)


# ------------------------------------------------------------
#  注册
# ------------------------------------------------------------

def register_optional(processors: dict[str, object]) -> list[str]:
    """把可用的模型处理器塞进注册表，返回已注册的名字。

    依赖缺失时**只提示、不报错** —— 这样评测台在没有模型的环境里
    仍然能跑基线（identity / gate），不会因为一个可选依赖直接挂掉。

    注意这里捕获的是**所有异常**而不只是 ModelUnavailable：
    模型下载中断、onnxruntime 加载失败、CUDA/线程库缺失……
    任何原因都不该让整场评测（包括基线）跑不起来。
    """
    registered: list[str] = []

    try:
        processors["dfn3"] = DeepFilterNet3()
        registered.append("dfn3")
    except Exception as err:  # noqa: BLE001 - 见上方注释
        hint = ""
        if "下载" in str(err) or "download" in str(err).lower():
            hint = "（可先跑 python tools/fetch_model.py 手动下载并校验权重）"
        eprint(f"[skip] dfn3 不可用：{type(err).__name__}: {err} {hint}")

    return registered


if __name__ == "__main__":  # 手动自检：能加载就打印一行
    eprint("探测可用的模型处理器…")
    got = register_optional({})
    eprint(f"可用：{got or '（无）'}")
