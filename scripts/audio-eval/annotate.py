"""给真实录音生成标注文件（键盘事件时刻 + 说话区间）。

**为什么需要**：合成样本能筛掉不行的方案，但最终判定必须用你的真实录音。
而真实录音要进评测，就需要知道「哪些时刻在打字」「哪些区间在说话」——
手工标注一段 30 秒的录音非常痛苦，所以让脚本先猜，你只负责核对。

**它是估计值，不是真值。** 脚本刻意把检测结果打印出来让你过一眼，
而不是假装准确。标注错了，指标就会骗你。

用法：
    python annotate.py 我的录音.wav
    # → 生成 我的录音.json，同时打印检测到的按键次数与说话区间

然后把 WAV 与 JSON 放进 samples 目录，即可用 compare_real.py / 同一套指标评估。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from dsp import SR, read_wav

FRAME = 480  # 10ms


def _band_envelope(x: np.ndarray, lo: int, hi: int, frame: int = FRAME) -> np.ndarray:
    """逐帧的带内能量包络（线性）。"""
    n_frames = len(x) // frame
    seg = x[: n_frames * frame].reshape(n_frames, frame)
    spec = np.fft.rfft(seg * np.hanning(frame), n=frame, axis=1)
    freqs = np.fft.rfftfreq(frame, 1 / SR)
    mask = (freqs >= lo) & (freqs <= hi)
    return np.mean(np.abs(spec[:, mask]) ** 2, axis=1)


def _db(x: np.ndarray) -> np.ndarray:
    return 10 * np.log10(np.maximum(x, 1e-20))


def detect_keys(x: np.ndarray, min_gap_s: float = 0.06) -> list[float]:
    """从高频瞬态里挑出按键时刻。

    两个关键设计（都是被实测打回来才定下来的）：

    1. **检测频带用 6–16kHz。** 语音在 6kHz 以上几乎没有能量，而键盘的
       「咔哒」是宽带瞬态，在那里依然突出；2–8kHz 是语音的摩擦音与共振峰区域，
       在那里找会大面积漏检（实测召回只有 12–21%），而漏检会让评测**低估**
       问题 —— 这是最危险的失败模式。

    2. **基线用整段包络的低分位，而不是「前 N 帧的中位数」。**
       键盘事件间隔只有 70–220ms，而每次击键的衰减尾巴有 20–55ms，
       用滑动中位数会把上一次的尾巴算进基线，导致检测器对自己刚检出的
       事件视而不见 —— 这正是召回率上不去的真正原因。

    判据本质是「比安静时的底噪高出多少」（SNR 意义上的），而不是绝对电平，
    因此不受录音增益影响。
    """
    frame = 240  # 5ms：瞬态需要更细的时间分辨率，10ms 会把起振抹平
    n_frames = len(x) // frame
    seg = x[: n_frames * frame].reshape(n_frames, frame)

    # 去直流：避免低频偏置污染带内能量
    seg = seg - np.mean(seg, axis=1, keepdims=True)

    spec = np.abs(np.fft.rfft(seg * np.hanning(frame), n=frame, axis=1))
    freqs = np.fft.rfftfreq(frame, 1 / SR)
    band = (freqs >= 6000) & (freqs <= 16000)
    env = 10 * np.log10(np.maximum(np.mean(spec[:, band] ** 2, axis=1), 1e-20))

    # 安静时的底噪：取低分位。键盘占空比很低（一分钟几百次 × 30ms），
    # 所以 30% 分位大概率落在「没有按键」的帧上。
    floor = float(np.percentile(env, 30))
    threshold = floor + KEY_RISE_DB

    min_gap_frames = max(1, int(min_gap_s * SR / frame))
    times: list[float] = []
    last = -min_gap_frames
    i = 0
    while i < len(env):
        if env[i] > threshold:
            # 爬到局部峰：一次击键会跨好几帧，只记峰顶
            j = i
            while j + 1 < len(env) and env[j + 1] > env[j]:
                j += 1
            if j - last >= min_gap_frames:
                times.append(round(float(j * frame / SR), 3))
                last = j
            i = j + 1
        else:
            i += 1
    return times


# 相对安静底噪的抬升门限。合成样本实测按键抬高 +20~25dB，
# 所以 12dB 有充足余量；真实录音若键盘很轻，可下调到 8。
KEY_RISE_DB = 12.0


def detect_speech(x: np.ndarray, min_len_s: float = 0.25, merge_gap_s: float = 0.25) -> list[list[float]]:
    """从 0.1–1kHz 的语音根基能量里划出说话区间。

    用「低分位 + 动态范围的一部分」作为门限，而不是绝对电平 ——
    这样录音增益变了、麦克风换了，判据依然成立。
    """
    frame = FRAME
    env = _db(_band_envelope(x, 100, 1000, frame))
    lo, hi = np.percentile(env, 20), np.percentile(env, 95)
    threshold = lo + (hi - lo) * 0.35

    active = env > threshold
    spans: list[list[float]] = []
    start: int | None = None
    for i, v in enumerate(list(active) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            spans.append([start * frame / SR, i * frame / SR])
            start = None

    # 合并过短的停顿（说话中的自然换气不该被切成两段）
    merged: list[list[float]] = []
    for span in spans:
        if merged and span[0] - merged[-1][1] <= merge_gap_s:
            merged[-1][1] = span[1]
        else:
            merged.append(list(span))
    return [[round(a, 3), round(b, 3)] for a, b in merged if b - a >= min_len_s]


def annotate(path: Path) -> dict:
    x, sr = read_wav(path)
    if sr != SR:
        print(f"⚠️ 采样率 {sr}Hz ≠ {SR}Hz。指标假定 48k，请先重采样，否则频带划分不准。")

    keys = detect_keys(x)
    speech = detect_speech(x)

    in_speech = sum(
        1 for t in keys if any(a <= t <= b for a, b in speech)
    )

    print(f"\n录音：{path.name}  时长 {len(x) / sr:.1f}s")
    print(f"检测到按键 {len(keys)} 次，其中 {in_speech} 次发生在说话期间 "
          f"({in_speech / max(1, len(keys)) * 100:.0f}%)")
    print(f"检测到说话区间 {len(speech)} 段：{speech[:6]}{' …' if len(speech) > 6 else ''}")
    print("\n⚠️ 这些是**估计值**：脚本按 2–8kHz 瞬态猜键盘、按 0.1–1k 能量猜语音。")
    print("   如果数字明显不对（例如你其实没打字却检出几十次），请手工修正 JSON 再评测 ——")
    print("   标注错了，指标会给出错误结论，比没有指标更危险。")

    return {
        "source": path.name,
        "sample_rate": sr,
        "duration_s": round(len(x) / sr, 3),
        "speech_spans": speech,
        "key_times": keys,
        "estimated": True,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    src = Path(sys.argv[1])
    if not src.exists():
        print(f"文件不存在：{src}")
        raise SystemExit(1)

    data = annotate(src)
    out = src.with_suffix(".json")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf8")
    print(f"\n已写出标注：{out}")
