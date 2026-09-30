"""直接探测模型：它到底输出的是语音，还是噪声？

起因：第一次评测里 dfn3 的「语音变化 −36dB」，看起来像严重吞字。
但排查发现**我的比较方式有缺陷**：流式处理的输出与输入存在延迟偏移
（环形缓冲要攒满一帧才吐），按索引直接对齐比较，相关性自然是 0。

这个脚本绕开评测台，直接做三件事：
  1. 加载模型，跑一段混合音频，导出 WAV 供试听；
  2. **搜索最佳延迟**（±80ms）后计算相关系数与 SI-SDR；
  3. 分别对齐「语音分量」与「键盘分量」，看输出里剩下的是谁。

只有延迟对齐之后，指标才有意义。

用法：
    python tools/probe_model.py
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
    return float(10 * np.log10(max(float(np.mean(x.astype(np.float64) ** 2)), 1e-20)))


def best_lag(ref: np.ndarray, test: np.ndarray, max_lag_ms: float = 80.0, sr: int = SR) -> tuple[int, float]:
    """在 ±max_lag 内找让相关系数最大的延迟。

    返回 (lag_samples, r)。lag > 0 表示 test 比 ref **晚** lag 个样本。
    """
    max_lag = int(max_lag_ms / 1000 * sr)
    n = min(len(ref), len(test))
    ref = ref[:n] - np.mean(ref[:n])
    test = test[:n] - np.mean(test[:n])

    best = (0, -2.0)
    for lag in range(-max_lag, max_lag + 1, 8):  # 先粗搜（步长 8）
        if lag >= 0:
            a, b = ref[: n - lag], test[lag:n]
        else:
            a, b = ref[-lag:n], test[: n + lag]
        if len(a) < sr // 4:
            continue
        denom = np.sqrt(float(np.dot(a, a)) * float(np.dot(b, b)))
        if denom <= 0:
            continue
        r = float(np.dot(a, b)) / denom
        if r > best[1]:
            best = (lag, r)
    # 细搜
    coarse = best[0]
    for lag in range(coarse - 8, coarse + 9):
        if lag >= 0:
            a, b = ref[: n - lag], test[lag:n]
        else:
            a, b = ref[-lag:n], test[: n + lag]
        if len(a) < sr // 4:
            continue
        denom = np.sqrt(float(np.dot(a, a)) * float(np.dot(b, b)))
        if denom <= 0:
            continue
        r = float(np.dot(a, b)) / denom
        if r > best[1]:
            best = (lag, r)
    return best


def si_sdr(ref: np.ndarray, test: np.ndarray, lag: int) -> float:
    """尺度不变信噪比（对齐后）。这是语音增强的标准指标：
    它允许任意增益差异，只惩罚「形状不对」。>0dB 才有意义，理想是十几 dB。
    """
    n = min(len(ref), len(test))
    if lag >= 0:
        r, t = ref[: n - lag], test[lag:n]
    else:
        r, t = ref[-lag:n], test[: n + lag]
    m = min(len(r), len(t))
    r, t = r[:m].astype(np.float64), t[:m].astype(np.float64)
    r = r - np.mean(r)
    t = t - np.mean(t)
    alpha = float(np.dot(t, r)) / max(float(np.dot(r, r)), 1e-20)
    target = alpha * r
    noise = t - target
    return float(10 * np.log10(max(np.sum(target ** 2), 1e-20) / max(np.sum(noise ** 2), 1e-20)))


def main() -> int:
    samples = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
    manifest = json.loads((samples / "manifest.json").read_text("utf8"))
    case = next(c for c in manifest["cases"] if int(round(c["snr_db"])) == 6)

    mixed, _ = read_wav(samples / case["mix"])
    speech, _ = read_wav(samples / case["speech_only"])
    keyboard, _ = read_wav(samples / case["keyboard_only"])

    try:
        from deepfilter_stream import DeepFilterModel
    except ImportError as err:
        print(f"缺少 deepfilter-stream：{err}")
        return 1

    os.environ.setdefault("DEEPFILTER_STREAM_MODEL_DIR", str(HERE / "models"))
    model = DeepFilterModel()
    print(f"模型输入：{[i.name for i in model.session.get_inputs()][:4]} …")
    print(f"frame_size={model.frame_size}  sample_rate={model.sample_rate}")

    stream = model.new_stream()
    out = stream.process(mixed.astype(np.float32), sr=SR)
    tail = stream.flush()
    if tail is not None and np.size(tail):
        out = np.concatenate([out, np.asarray(tail)])
    out = np.asarray(out, dtype=np.float32).reshape(-1)

    print(f"\n输入长度 {len(mixed)}，输出长度 {len(out)}（差 {len(mixed) - len(out)}）")
    print(f"输入 {db(mixed):.1f} dBFS，输出 {db(out):.1f} dBFS")

    # 混合里各分量的尺度（合成数据里「混合 = speech + key」成立）
    n = min(len(mixed), len(speech))
    scale = float(np.dot(speech[:n], mixed[:n]) / max(np.dot(speech[:n], speech[:n]), 1e-20))
    speech_in_mix = (speech[:n] * scale).astype(np.float32)
    key_in_mix = (mixed[:n].astype(np.float64) - speech_in_mix).astype(np.float32)

    for label, ref in (("混合(未处理)", mixed), ("语音分量", speech_in_mix), ("键盘分量", key_in_mix)):
        lag, r = best_lag(ref, out)
        print(f"\n  与[{label}]对齐：延迟 {lag / SR * 1000:+.1f}ms，相关系数 r={r:+.3f}")
        if label != "键盘分量":
            print(f"    SI-SDR = {si_sdr(ref, out, lag):+.1f} dB")

    # ---- 对照实验：模型的「身份测试」 ----
    # 把**干净语音**直接喂给模型。一个正常的语音增强模型在输入本身就干净时
    # 应当基本原样输出（r ≈ 1）。如果这里也只有 r≈0，说明问题不在我的混合
    # 样本上，而在模型调用或模型本身 —— 这是区分「数据问题」与「实现问题」
    # 最关键的一刀。
    print("\n=== 对照：把「干净语音」单独喂进去（身份测试） ===")
    s2 = model.new_stream()
    clean_out = s2.process(speech.astype(np.float32), sr=SR)
    t2 = s2.flush()
    if t2 is not None and np.size(t2):
        clean_out = np.concatenate([clean_out, np.asarray(t2)])
    clean_out = np.asarray(clean_out, dtype=np.float32).reshape(-1)
    lag2, r2 = best_lag(speech, clean_out)
    print(f"  输入干净语音 {db(speech):.1f} dBFS → 输出 {db(clean_out):.1f} dBFS")
    print(f"  延迟 {lag2 / SR * 1000:+.1f}ms，r={r2:+.3f}，SI-SDR={si_sdr(speech, clean_out, lag2):+.1f} dB")
    if r2 < 0.5:
        print("  ⚠️ 干净语音都还原不出来 → 问题在**调用方式或模型本身**，")
        print("     而不是「我的合成样本不像语音」。下一步应当换真实语音验证。")
    else:
        print("  ✓ 模型能还原干净语音 → 说明模型工作正常，问题在我的合成语音上：")
        print("     它不在模型的训练分布内（真语音训练的模型不认谐波合成声）。")
    clean_path = HERE / "out" / "probe_clean_dfn3.wav"
    write_wav(clean_path, clean_out)
    write_wav(clean_path.with_name("probe_clean_input.wav"), speech)

    out_path = HERE / "out" / f"probe_{case['id']}_dfn3.wav"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_wav(out_path, out)
    write_wav(out_path.with_name(out_path.stem + "_input.wav"), mixed)
    print(f"\n已导出试听文件：\n  {out_path}\n  {out_path.with_name(out_path.stem + '_input.wav')}")

    print("\n判读：")
    print("  · r 接近 1、SI-SDR 为正 → 输出就是语音（说明之前指标是被延迟错位坑了）。")
    print("  · r 接近 0 → 输出与语音无关，是噪声（说明模型/调用有问题）。")
    print("  · 与「键盘分量」的 r 高 → 输出里主要是键盘，完全反了。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
