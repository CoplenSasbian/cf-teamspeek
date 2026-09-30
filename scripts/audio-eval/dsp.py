"""最小音频处理工具（只依赖 numpy）。

刻意不引入 scipy / librosa / soundfile：
  - 评测脚本要在任何机器上直接跑，依赖越多越容易卡住；
  - WAV 读写用标准库 `wave` 就够（16-bit PCM 单声道，正好是语音室的格式）。
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np

SR = 48_000  # 语音室全程 48kHz（见 shared/constants.ts 与 worklet 假定）


# ------------------------------------------------------------
#  WAV 读写
# ------------------------------------------------------------

def write_wav(path: Path, samples: np.ndarray, sr: int = SR) -> None:
    """写 16-bit PCM 单声道 WAV。samples 为 [-1, 1] 的 float。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    """读 WAV（16-bit PCM），返回 (float32 samples, sr)。"""
    with wave.open(str(path), "rb") as f:
        if f.getsampwidth() != 2:
            raise ValueError(f"只支持 16-bit PCM：{path}")
        sr = f.getframerate()
        raw = f.readframes(f.getnframes())
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return data, sr


# ------------------------------------------------------------
#  STFT / iSTFT（与 DeepFilterNet 一致的参数：512 窗、512 跳、Hann）
# ------------------------------------------------------------

N_FFT = 512
HOP = 512
WINDOW = np.hanning(N_FFT + 1)[:-1].astype(np.float32)  # 周期 Hann，长度 512


def stft(x: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """返回复数谱，形状 (帧数, n_fft//2+1)。"""
    n_frames = max(1, 1 + (len(x) - n_fft) // hop)
    pad = max(0, (n_frames - 1) * hop + n_fft - len(x))
    xs = np.concatenate([x, np.zeros(pad, dtype=x.dtype)])
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = xs[idx] * WINDOW
    return np.fft.rfft(frames, n=n_fft, axis=1)


def istft(spec: np.ndarray, n_fft: int = N_FFT, hop: int = HOP, length: int | None = None) -> np.ndarray:
    """重叠相加重建。窗满足 COLA（Hann + 50% 重叠），直接归一化即可。"""
    frames = np.fft.irfft(spec, n=n_fft, axis=1) * WINDOW
    n_frames = frames.shape[0]
    out_len = (n_frames - 1) * hop + n_fft
    out = np.zeros(out_len, dtype=np.float64)
    norm = np.zeros(out_len, dtype=np.float64)
    for i in range(n_frames):
        start = i * hop
        out[start:start + n_fft] += frames[i]
        norm[start:start + n_fft] += WINDOW ** 2
    norm[norm < 1e-8] = 1.0
    out /= norm
    return (out[:length] if length is not None else out).astype(np.float32)


def band_energy_db(spec: np.ndarray, sr: int = SR, lo: int = 0, hi: int | None = None) -> np.ndarray:
    """逐帧指定频带能量（dB），形状 (帧数,)。用于看频谱上「键盘那一块」被压掉多少。"""
    freqs = np.fft.rfftfreq(N_FFT, 1 / sr)
    hi = hi if hi is not None else int(freqs[-1])
    mask = (freqs >= lo) & (freqs <= hi)
    power = np.abs(spec[:, mask]) ** 2
    return 10 * np.log10(np.maximum(power.sum(axis=1), 1e-20))


# ------------------------------------------------------------
#  电平工具
# ------------------------------------------------------------

def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10(max(float(np.mean(x.astype(np.float64) ** 2)), 1e-20)))


def peak_db(x: np.ndarray) -> float:
    return float(20 * np.log10(max(float(np.max(np.abs(x))), 1e-20)))


def normalize_db(x: np.ndarray, target_db: float) -> np.ndarray:
    """按 RMS 归一化到目标电平。"""
    cur = rms_db(x)
    return (x * (10 ** ((target_db - cur) / 20))).astype(np.float32)


def frame_energy_db(x: np.ndarray, frame: int = 480, hop: int | None = None) -> np.ndarray:
    """短时能量（dB），用于按时间片段分析（默认 10ms 帧）。"""
    hop = hop or frame
    n = 1 + max(0, (len(x) - frame) // hop)
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    seg = x[idx].astype(np.float64)
    return 10 * np.log10(np.maximum(np.mean(seg ** 2, axis=1), 1e-20))


def eprint(*args: object) -> None:
    """输出到 stderr —— 避免污染 stdout 里给机器读的 JSON。"""
    print(*args, file=sys.stderr)
