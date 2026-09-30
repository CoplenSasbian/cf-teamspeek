"""生成**真实语音 + 合成键盘**的评测样本。

为什么重做样本集：前几轮的样本用**合成语音**（共振峰谐波堆），实测
DeepFilterNet3 在它上面输出是垃圾（相关系数 0.33、SI-SDR −9dB），而换成真人语音
立刻正常（r=0.98、SI-SDR +14.7dB）。也就是说合成语音不在模型的训练分布内 ——
**基于它的模型结论全部不可信**。

这个生成器的做法：
  · 语音：真人录音（Harvard Sentences，8k 原始，重采样到 48k）
  · 键盘：沿用参数化瞬态合成（成本低、可复现、时间标注精确）
  · 混合：按目标 SNR 线性叠加

好处是两头都要：
  · **语音是真的** → 模型能正常工作，结论有意义；
  · **键盘是合成的** → 有精确的按键时刻与干净参考，指标可算。

局限（要知道）：键盘是参数化合成的，不等于你的具体键盘。所以最终判定仍应
用你录的真实音频（`real/` + `compare_real.py`）。

用法：
    python make_real_samples.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

from dsp import SR, eprint, normalize_db, rms_db, read_wav, write_wav
from make_samples import synth_key_event

HERE = Path(__file__).parent
REAL_DIR = HERE / "real"
OUT_DIR = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples_real"))

SPEECH_DB = -26.0
KEY_DB = -30.0

# 真人录音源（Harvard Sentences，8kHz）。文件名 → 说话人标识
VOICES = {
    "harvard_m1.wav": "male1",
    "harvard_m2.wav": "male2",
    "harvard_f1.wav": "female1",
}


def resample_linear(x: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return x.astype(np.float32)
    n_out = int(round(len(x) * dst_sr / src_sr))
    return np.interp(np.linspace(0, len(x) - 1, n_out), np.arange(len(x)), x).astype(np.float32)


def detect_speech_spans(x: np.ndarray, frame: int = 480, min_len_s: float = 0.2,
                        merge_gap_s: float = 0.25) -> list[list[float]]:
    """从真人录音里划出说话区间（用低频能量，不做任何模型推断）。"""
    n_frames = len(x) // frame
    seg = x[: n_frames * frame].reshape(n_frames, frame).astype(np.float64)
    spec = np.abs(np.fft.rfft(seg * np.hanning(frame), n=frame, axis=1))
    freqs = np.fft.rfftfreq(frame, 1 / SR)
    band = (freqs >= 100) & (freqs <= 1000)
    env = 10 * np.log10(np.maximum(np.mean(spec[:, band] ** 2, axis=1), 1e-20))

    lo, hi = np.percentile(env, 20), np.percentile(env, 95)
    active = env > (lo + (hi - lo) * 0.35)

    spans: list[list[float]] = []
    start: int | None = None
    for i, v in enumerate(list(active) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            spans.append([start * frame / SR, i * frame / SR])
            start = None

    merged: list[list[float]] = []
    for a, b in spans:
        if merged and a - merged[-1][1] <= merge_gap_s:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [[round(a, 3), round(b, 3)] for a, b in merged if b - a >= min_len_s]


def synth_keyboard(rng: np.random.Generator, n: int, spans: list[list[float]]) -> tuple[np.ndarray, list[float]]:
    """一串按键，**尽量落在说话区间内**（打游戏时才是同时发生的）。"""
    out = np.zeros(n, dtype=np.float32)
    times: list[float] = []

    def in_speech(t: float) -> bool:
        return any(a <= t <= b for a, b in spans)

    t = 0.3
    while t < n / SR - 0.2:
        times.append(round(t, 4))
        event = synth_key_event(rng)
        a = int(t * SR)
        b = min(n, a + len(event))
        out[a:b] += event[: b - a]
        t += rng.uniform(0.07, 0.20) if in_speech(t) else rng.uniform(0.2, 0.7)
    return out, times


def build() -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"sample_rate": SR, "source": "Harvard Sentences (real speech)", "cases": []}

    missing = [f for f in VOICES if not (REAL_DIR / f).exists()]
    if missing:
        eprint(f"缺少真人语音：{missing}\n请先跑 tools/real_speech_check.py 下载，或手动放入 real/")
        return {"cases": []}

    for idx, (fname, voice) in enumerate(VOICES.items()):
        raw, sr = read_wav(REAL_DIR / fname)
        speech = normalize_db(resample_linear(raw, sr, SR), SPEECH_DB)

        # 只用前 20 秒：足够算指标，也让评测快一些
        speech = speech[: 20 * SR]
        n = len(speech)
        spans = detect_speech_spans(speech)

        rng = np.random.default_rng(4000 + idx)
        keyboard, key_times = synth_keyboard(rng, n, spans)

        name = f"real{idx}_{voice}"
        write_wav(OUT_DIR / f"{name}_speech_only.wav", speech)
        write_wav(OUT_DIR / f"{name}_keyboard_only.wav", keyboard)

        for snr_db in (12.0, 6.0, 0.0):
            k_gain = 10 ** ((rms_db(speech) - snr_db - rms_db(keyboard)) / 20)
            mixed = normalize_db((speech + keyboard * k_gain).astype(np.float32), SPEECH_DB)
            write_wav(OUT_DIR / f"{name}_mixed_snr{int(snr_db):02d}.wav", mixed)

            calibrated = keyboard * k_gain
            manifest["cases"].append({
                "id": f"{name}_snr{int(snr_db):02d}",
                "voice": voice,
                "mix": f"{name}_mixed_snr{int(snr_db):02d}.wav",
                "speech_only": f"{name}_speech_only.wav",
                "keyboard_only": f"{name}_keyboard_only.wav",
                "snr_db": snr_db,
                "speech_spans": spans,
                "key_times": key_times,
                "levels": {
                    "speech_rms_dbfs": round(rms_db(speech), 1),
                    "keyboard_rms_dbfs": round(rms_db(calibrated), 1),
                },
            })

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf8")
    eprint(f"已生成 {len(manifest['cases'])} 个用例（真人语音）→ {OUT_DIR}")
    return manifest


if __name__ == "__main__":
    m = build()
    if m["cases"]:
        c = m["cases"][0]
        eprint(f"示例：{c['id']}  说话区间 {len(c['speech_spans'])} 段，按键 {len(c['key_times'])} 次")
