"""生成可复现的「打游戏说话 + 键盘」评测样本。

为什么要合成而不是直接录：评测必须**可复现、可回归、带干净参考**，
否则每次换模型都只能靠耳朵，得不出结论。真实录音留到最后一关（你在浏览器里试）。

信号链刻意贴近真实场景：
  - 语音：谐波堆 + 共振峰滤波 + 音节包络 + 音高起伏 + 停顿（近似人声，而非白噪声）
  - 键盘：机械轴的「瞬态 + 衰减振铃」，能量集中在 2–6kHz —— 这正是降噪模型
    最不擅长的那类非平稳冲击，也是它和语音**同时发生**的部分
  - 两者**有真实重叠**（打字时会说话），因此门限式方案在原理上无法处理

关键产物：
  - speech_only.wav   干净语音（评测的参考信号，模型不该破坏它）
  - mixed_snrXX.wav   语音 + 键盘的混合（模型输入）
  - manifest.json     时间标注：哪些帧是纯键盘、哪些帧是纯语音、键盘事件时刻
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import numpy as np

from dsp import SR, eprint, normalize_db, rms_db, write_wav

# 输出目录可用 CF_EVAL_SAMPLES 覆盖。
# 存在的理由：某些受限环境（例如 DSH 沙箱）只允许写 workspace 根目录，
# 而 scripts/ 下的子目录不可写 —— 这时把产物落到临时目录即可继续实验。
OUT_DIR = Path(os.environ.get("CF_EVAL_SAMPLES") or (Path(__file__).parent / "samples"))
DURATION_S = 12.0
SPEECH_DB = -26.0  # 语音 RMS 电平（典型语音室麦克风电平）
KEY_DB = -30.0     # 单个键盘事件的 RMS 电平


# ------------------------------------------------------------
#  语音合成（共振峰 + 谐波）
# ------------------------------------------------------------

def _resonator(x: np.ndarray, freq: float, bw: float, sr: int = SR) -> np.ndarray:
    """二阶共振器（biquad），用来捏共振峰。"""
    r = math.exp(-math.pi * bw / sr)
    theta = 2 * math.pi * freq / sr
    a1 = -2 * r * math.cos(theta)
    a2 = r * r
    gain = (1 - r) * math.sqrt(1 - 2 * r * math.cos(2 * theta) + r * r)
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, sample in enumerate(x):
        v = gain * float(sample) - a1 * y1 - a2 * y2
        y[i] = v
        x2, x1 = x1, float(sample)
        y2, y1 = y1, v
    return y


def _syllable_envelope(n: int, rng: np.random.Generator, sr: int = SR) -> np.ndarray:
    """音节包络：约 4Hz 的起伏 + 随机重音，语音不是连续的。"""
    t = np.arange(n) / sr
    env = 0.55 + 0.45 * np.sin(2 * math.pi * 3.7 * t)
    # 少量随机重音：让电平更接近真实说话
    for _ in range(int(DURATION_S * 2.5)):
        center = rng.uniform(0, DURATION_S)
        width = rng.uniform(0.05, 0.12)
        env += 0.35 * np.exp(-((t - center) ** 2) / (2 * width ** 2))
    return np.clip(env, 0.05, 2.0)


def _phrase_gate(n: int, rng: np.random.Generator, sr: int = SR) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """把时间轴切成「说话段 / 停顿段」，返回门与说话区间。"""
    t = np.arange(n) / sr
    gate = np.zeros(n, dtype=np.float64)
    spans: list[tuple[float, float]] = []
    cursor = 0.25
    while cursor < DURATION_S - 0.4:
        length = rng.uniform(1.2, 2.6)
        start, end = cursor, min(cursor + length, DURATION_S)
        spans.append((round(start, 3), round(end, 3)))
        # 起落各 30ms 淡入淡出，避免出现合成感很强的硬边
        fade = int(0.03 * sr)
        seg = np.ones(int((end - start) * sr))
        if len(seg) > 2 * fade:
            seg[:fade] = np.linspace(0, 1, fade)
            seg[-fade:] = np.linspace(1, 0, fade)
        a, b = int(start * sr), int(start * sr) + len(seg)
        gate[a:b] = np.maximum(gate[a:b], seg)
        cursor = end + rng.uniform(0.35, 0.9)  # 停顿
    return gate, spans


def synth_speech(rng: np.random.Generator, seed_voice: int = 0) -> np.ndarray:
    """合成一段「像人声」的信号：基频 + 谐波 + 共振峰 + 音节包络。"""
    n = int(DURATION_S * SR)
    t = np.arange(n) / SR

    base_f0 = 115.0 + seed_voice * 35.0  # 男声基频，第二个种子做成偏高音
    f0 = base_f0 * (1 + 0.06 * np.sin(2 * math.pi * 0.7 * t) + 0.02 * np.sin(2 * math.pi * 2.3 * t))

    # 谐波堆（相位连续，避免爆音）
    phase = 2 * math.pi * np.cumsum(f0) / SR
    harmonic = np.zeros(n, dtype=np.float64)
    for k in range(1, 41):
        amp = 1.0 / (k ** 1.15)
        if k * base_f0 > SR / 2 - 500:
            break
        harmonic += amp * np.sin(k * phase + rng.uniform(0, 2 * math.pi))
    harmonic /= np.max(np.abs(harmonic)) + 1e-9

    # 共振峰：把谐波堆塑造成人声的频谱包络
    shaped = harmonic.astype(np.float32)
    for freq, bw, gain in ((520, 90, 1.0), (1400, 120, 0.55), (2600, 160, 0.32), (3600, 220, 0.18)):
        shaped = shaped + gain * _resonator(harmonic, freq, bw).astype(np.float32)
    shaped /= np.max(np.abs(shaped)) + 1e-9

    gate, _ = _phrase_gate(n, rng)
    env = _syllable_envelope(n, rng)
    # 摩擦音：让频谱不全是一根根谐波，更接近真实语音
    fric = rng.normal(0, 1, n) * 0.06
    speech = (shaped * (0.75 + 0.25 * env) + fric) * gate
    return normalize_db(speech.astype(np.float32), SPEECH_DB)


# ------------------------------------------------------------
#  键盘瞬态
# ------------------------------------------------------------

def synth_key_event(rng: np.random.Generator) -> np.ndarray:
    """一次按键：极快起振 + 指数衰减 + 2–6kHz 振铃 + 少量低频“咔”声。"""
    dur = rng.uniform(0.02, 0.055)
    n = int(dur * SR)
    t = np.arange(n) / SR

    # 冲击体：近似脉冲，衰减极快
    attack = int(0.0008 * SR)
    click = rng.normal(0, 1, n)
    click[:attack] *= np.linspace(0, 1, attack)
    click *= np.exp(-t / 0.004)

    # 塑料/金属外壳的振铃：几个窄带共振
    ring = np.zeros(n, dtype=np.float32)
    for freq in (rng.uniform(1800, 2600), rng.uniform(3200, 4200), rng.uniform(4800, 6200)):
        ring += _resonator(rng.normal(0, 1, n), freq, rng.uniform(240, 520)).astype(np.float32)
    ring *= np.exp(-t / rng.uniform(0.008, 0.02))
    ring /= np.max(np.abs(ring)) + 1e-9

    # 触底的“闷响”
    thud = np.sin(2 * math.pi * rng.uniform(120, 220) * t) * np.exp(-t / 0.02)

    event = click * 0.9 + ring * 0.8 + thud * 0.25
    return normalize_db(event.astype(np.float32), KEY_DB)


def synth_keyboard(rng: np.random.Generator, speech_spans: list[tuple[float, float]]) -> tuple[np.ndarray, list[float]]:
    """一串按键。**刻意让大部分按键落在说话段内** —— 这正是门限解决不了的场景。"""
    n = int(DURATION_S * SR)
    out = np.zeros(n, dtype=np.float32)
    times: list[float] = []

    def in_speech(t: float) -> bool:
        return any(a <= t <= b for a, b in speech_spans)

    t = 0.4
    while t < DURATION_S - 0.2:
        times.append(round(t, 4))
        event = synth_key_event(rng)
        start = int(t * SR)
        end = min(n, start + len(event))
        out[start:end] += event[: end - start]
        # 打字节奏：成串的快速击键 + 偶尔停顿（打游戏时更密集）
        if in_speech(t):
            t += rng.uniform(0.07, 0.22)
        else:
            t += rng.uniform(0.15, 0.5)

    return out, times


# ------------------------------------------------------------
#  主流程
# ------------------------------------------------------------

def build() -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"sample_rate": SR, "duration_s": DURATION_S, "cases": []}

    for seed in (0, 1):
        rng = np.random.default_rng(1000 + seed)
        speech = synth_speech(rng, seed_voice=seed)

        # 说话区间（用于标注）
        n = len(speech)
        frame = 480
        n_frames = n // frame
        frame_db = 10 * np.log10(
            np.maximum(np.mean(speech[: n_frames * frame].reshape(n_frames, frame) ** 2, axis=1), 1e-20)
        )
        speech_active = frame_db > (rms_db(speech) - 12)

        # 键盘：位置依赖说话区间，所以单独走一遍
        rng_k = np.random.default_rng(2000 + seed)
        t = np.arange(n) / SR
        spans: list[tuple[float, float]] = []
        cursor = 0.25
        while cursor < DURATION_S - 0.4:
            length = rng_k.uniform(1.2, 2.6)
            spans.append((cursor, min(cursor + length, DURATION_S)))
            cursor = spans[-1][1] + rng_k.uniform(0.35, 0.9)
        key_rng = np.random.default_rng(3000 + seed)
        keyboard, key_times = synth_keyboard(key_rng, spans)

        name = f"case{seed}"
        write_wav(OUT_DIR / f"{name}_speech_only.wav", speech)

        # 键盘单独一个文件：既可用于听感，也可用于测「模型对纯噪声的抑制能力」
        write_wav(OUT_DIR / f"{name}_keyboard_only.wav", keyboard)

        for snr_db in (12.0, 6.0, 0.0):
            # 按目标 SNR 混合：speech 保持固定，缩放键盘
            k_gain = 10 ** ((rms_db(speech) - snr_db - rms_db(keyboard)) / 20)
            mixed = normalize_db((speech + keyboard * k_gain).astype(np.float32), SPEECH_DB)
            write_wav(OUT_DIR / f"{name}_mixed_snr{int(snr_db):02d}.wav", mixed)

            # 电平校准：门限类方案能不能工作，完全取决于「键盘事件在检测频带里的
            # 电平」与「阈值」的相对关系。把它记下来，结论才可审计。
            calibrated = keyboard * k_gain
            key_band_db = _band_level_db(calibrated, key_times)
            manifest["cases"].append(
                {
                    "id": f"{name}_snr{int(snr_db):02d}",
                    "mix": f"{name}_mixed_snr{int(snr_db):02d}.wav",
                    "speech_only": f"{name}_speech_only.wav",
                    "keyboard_only": f"{name}_keyboard_only.wav",
                    "snr_db": snr_db,
                    "speech_spans": [[round(a, 3), round(b, 3)] for a, b in spans],
                    "key_times": key_times,
                    "speech_active_frames": _runs(speech_active.tolist(), frame, SR),
                    "levels": {
                        "speech_rms_dbfs": round(rms_db(speech), 1),
                        "keyboard_rms_dbfs": round(rms_db(calibrated), 1),
                        "keyboard_peak_dbfs": round(_peak_db(calibrated), 1),
                        # 键盘事件期间、500–4000Hz 检测带内的 RMS —— 直接和门限阈值比
                        "keyboard_band_rms_dbfs": round(key_band_db, 1),
                    },
                }
            )

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf8")
    eprint(f"已生成 {len(manifest['cases'])} 个用例 → {OUT_DIR}")
    return manifest


def _runs(mask: list[bool], frame: int, sr: int) -> list[list[float]]:
    """把布尔帧序列压成时间段 [start_s, end_s]。"""
    out: list[list[float]] = []
    start: int | None = None
    for i, v in enumerate(mask + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append([round(start * frame / sr, 3), round(i * frame / sr, 3)])
            start = None
    return out


def _peak_db(x: np.ndarray) -> float:
    return float(20 * math.log10(max(float(np.max(np.abs(x))), 1e-20)))


def _band_level_db(x: np.ndarray, times: list[float], lo: float = 500.0, hi: float = 4000.0) -> float:
    """键盘事件期间、检测频带内的 RMS 电平。

    这是与「门限阈值」直接可比的那个数：只有它明显高于阈值，门才会打开。
    """
    if not times:
        return -200.0
    freqs = np.fft.rfftfreq(len(x), 1 / SR)
    mask = (freqs >= lo) & (freqs <= hi)
    spec = np.fft.rfft(x)
    spec[~mask] = 0
    band = np.fft.irfft(spec, n=len(x))

    win = int(0.02 * SR)
    segs = []
    for t in times:
        a = int(t * SR)
        b = min(len(band), a + win)
        if b - a > 8:
            segs.append(band[a:b])
    if not segs:
        return -200.0
    joined = np.concatenate([s.astype(np.float64) for s in segs])
    return float(10 * math.log10(max(float(np.mean(joined ** 2)), 1e-20)))


if __name__ == "__main__":
    m = build()
    total_keys = sum(len(c["key_times"]) for c in m["cases"][:1])
    eprint(f"每个样例约 {total_keys} 次按键")
