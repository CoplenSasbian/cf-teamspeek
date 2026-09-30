"""用**真人语音**判定 DFN3 到底能不能工作。

背景：在合成语音上，DFN3 的输出与输入相关系数只有 0.3、SI-SDR −9dB，
看起来像「模型没用」。但合成语音是共振峰谐波堆出来的，可能根本不在模型的
训练分布内。**在下结论之前必须用真人语音验一次** —— 否则可能误杀一个好模型。

数据源：Harvard Sentences（公开的标准语音测试集，8kHz 单声道），
重采样到 48kHz 后直接喂模型。

判定标准（关键）：
  · 真实语音上 r 高、SI-SDR 为正 → 模型正常，之前是**我的合成语音**的问题；
  - 真实语音上依然是噪声 → 模型/封装真的有问题，这条路要停。

用法：
    python tools/real_speech_check.py
"""

from __future__ import annotations

import sys
import urllib.request
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from dsp import SR, write_wav  # noqa: E402

REAL_DIR = HERE / "real"
SOURCES = {
    "harvard_m1.wav": "http://www.voiptroubleshooter.com/open_speech/american/OSR_us_000_0010_8k.wav",
    "harvard_m2.wav": "http://www.voiptroubleshooter.com/open_speech/american/OSR_us_000_0030_8k.wav",
}


def db(x: np.ndarray) -> float:
    return float(10 * np.log10(max(float(np.mean(np.asarray(x, dtype=np.float64) ** 2)), 1e-20)))


def resample_linear(x: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return x.astype(np.float32)
    n_out = int(round(len(x) * dst_sr / src_sr))
    src_idx = np.linspace(0, len(x) - 1, n_out)
    return np.interp(src_idx, np.arange(len(x)), x).astype(np.float32)


def load_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as f:
        sr = f.getframerate()
        width = f.getsampwidth()
        raw = f.readframes(f.getnframes())
    if width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128
    elif width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    else:
        raise ValueError(f"不支持的位宽 {width}")
    return data, sr


def fetch(name: str, url: str) -> Path | None:
    """取真人语音：**本地已存在就直接用**，否则尝试下载。

    注意那个源对请求头很挑剔 —— 实测只要设了 `Accept: */*` 就返回 406，
    不加任何头反而正常。所以这里刻意用最朴素的请求。
    文件已经下好放在 real/ 里时，这一步完全跳过（离线可用）。
    """
    dst = REAL_DIR / name
    if dst.exists() and dst.stat().st_size > 5000:
        print(f"  使用本地文件 {name}（{dst.stat().st_size / 1024:.0f} KB）")
        return dst
    REAL_DIR.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url)  # 不加任何头：加 Accept 会被 406
        with urllib.request.urlopen(req, timeout=60) as resp, open(dst, "wb") as f:
            f.write(resp.read())
        print(f"  已下载 {name}（{dst.stat().st_size / 1024:.0f} KB）")
        return dst
    except Exception as err:  # noqa: BLE001
        print(f"  取 {name} 失败：{err}")
        return None


def corr_aligned(ref: np.ndarray, test: np.ndarray, min_lag: int = -4000, max_lag: int = 4000) -> tuple[int, float]:
    n = min(len(ref), len(test))
    a_full = ref[:n] - np.mean(ref[:n])
    b_full = test[:n] - np.mean(test[:n])
    best = (0, -2.0)
    for lag in range(min_lag, max_lag + 1, 4):
        if lag >= 0:
            a, b = a_full[: n - lag], b_full[lag:n]
        else:
            a, b = a_full[-lag:n], b_full[: n + lag]
        if len(a) < 4800:
            continue
        denom = np.sqrt(float(np.dot(a, a)) * float(np.dot(b, b)))
        if denom <= 0:
            continue
        r = float(np.dot(a, b)) / denom
        if r > best[1]:
            best = (lag, r)
    return best


def si_sdr(ref: np.ndarray, test: np.ndarray, lag: int) -> float:
    n = min(len(ref), len(test))
    if lag >= 0:
        r, t = ref[: n - lag], test[lag:n]
    else:
        r, t = ref[-lag:n], test[: n + lag]
    m = min(len(r), len(t))
    r = r[:m].astype(np.float64)
    t = t[:m].astype(np.float64)
    r -= np.mean(r)
    t -= np.mean(t)
    alpha = float(np.dot(t, r)) / max(float(np.dot(r, r)), 1e-20)
    target = alpha * r
    noise = t - target
    return float(10 * np.log10(max(np.sum(target ** 2), 1e-20) / max(np.sum(noise ** 2), 1e-20)))


def main() -> int:
    print("=== 准备真人语音 ===")
    files = [fetch(name, url) for name, url in SOURCES.items()]
    files = [f for f in files if f]

    # 顺带把合成语音也列进来对照
    synthetic = HERE / "samples" / "case0_speech_only.wav"
    cases: list[tuple[str, np.ndarray]] = []
    for f in files:
        x, sr = load_wav(f)
        x = resample_linear(x, sr, SR)
        # 归一化到 -26dBFS，与语音室的实际电平一致
        x = x / max(np.sqrt(np.mean(x ** 2)), 1e-9) * (10 ** (-26 / 20))
        cases.append((f.stem, x.astype(np.float32)))
        print(f"  {f.stem}: {len(x) / SR:.1f}s @48k, {db(x):.1f} dBFS")
    if synthetic.exists():
        from dsp import read_wav
        s, _ = read_wav(synthetic)
        cases.append(("合成语音(对照)", s))
        print(f"  合成语音(对照): {len(s) / SR:.1f}s, {db(s):.1f} dBFS")

    print("\n=== 用 DFN3 处理 ===")
    import os

    os.environ.setdefault("DEEPFILTER_STREAM_MODEL_DIR", str(HERE / "models"))
    from deepfilter_stream import DeepFilterModel

    model = DeepFilterModel()
    print(f"{'输入':<20}{'输入dBFS':>10}{'输出dBFS':>10}{'延迟':>9}{'相关系数':>10}{'SI-SDR':>9}")
    print("-" * 70)
    verdicts = []
    for label, x in cases:
        stream = model.new_stream()
        out = stream.process(x.astype(np.float32), sr=SR)
        tail = stream.flush()
        if tail is not None and np.size(tail):
            out = np.concatenate([out, np.asarray(tail)])
        out = np.asarray(out, dtype=np.float32).reshape(-1)

        lag, r = corr_aligned(x, out)
        sdr = si_sdr(x, out, lag)
        print(f"{label:<20}{db(x):>10.1f}{db(out):>10.1f}{lag / SR * 1000:>8.1f}ms{r:>10.3f}{sdr:>8.1f}dB")
        verdicts.append((label, r, sdr))
        write_wav(HERE / "out" / f"real_{label}_out.wav", out)
        write_wav(HERE / "out" / f"real_{label}_in.wav", x)

    print("\n=== 结论 ===")
    real_ok = [label for label, r, sdr in verdicts if "合成" not in label and r > 0.7]
    if real_ok:
        print(f"  ✓ 在真人语音上模型工作正常（{', '.join(real_ok)}）")
        print("    → 之前合成语音上的失败是**样本不在训练分布内**，不是模型的问题。")
        print("    → 结论：要用真实语音做评测，合成样本只能用于相对排序。")
    else:
        print("  ✗ 真人语音上依然是噪声 → 模型或调用方式确实有问题，这条路要停下来查。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
