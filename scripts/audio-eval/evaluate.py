"""对一个「处理器」跑客观评测，输出可比较的表格。

用法（在能写的目录里跑）：
    python evaluate.py
    python evaluate.py --processor gate --snr 6

处理器通过注册表接入：任何能 import 的 ONNX 模型（DeepFilterNet3 等）
只要实现 `process(mixed: np.ndarray) -> np.ndarray` 就能直接进来对比，
不需要改动评测逻辑 —— 这是这个文件存在的意义。

指标说明（都对照 `speech_only` 干净参考 + `mixed` 输入）：
  key_drop_db    键盘帧被压低多少 dB（越高越好；≥12 才叫「去掉了」）
  speech_drop_db 语音帧被压低多少 dB（越接近 0 越好；负得太多就是吞字）
  key_leak_db    键盘瞬态在输出里的残留（相对干净语音同刻的电平，越低越好）
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from dsp import SR, eprint, read_wav, rms_db

HERE = Path(__file__).parent
# 与 make_samples.py 一致：允许用环境变量把产物重定向到可写目录
DEFAULT_SAMPLES = Path(os.environ.get("CF_EVAL_SAMPLES") or (HERE / "samples"))
DEFAULT_OUT = Path(os.environ.get("CF_EVAL_OUT") or (HERE / "out"))


# ------------------------------------------------------------
#  处理器
# ------------------------------------------------------------

class Processor:
    name = "?"
    note = ""

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:  # pragma: no cover
        """处理一段音频。

        `case` 是可选的用例信息（含 speech_only 文件名、键盘时刻等）。
        **只有 oracle 类处理器才应该用它** —— 它是真值，真实处理器拿不到。
        提供它是为了算出「理论上限」，用来判断问题本身是否可解。
        """
        raise NotImplementedError


class Identity(Processor):
    """对照基线：什么都不做。用来确认指标本身是对的。"""
    name = "identity"
    note = "不做任何处理（基线）"

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        return mixed


class EnergyGate(Processor):
    """当前 web 客户端的语音门限的**近似复现**。

    依据 public/voice-gate-worklet.js 的结构：带通侧链检测 + 迟滞 + 保持。
    因为键盘与语音同时发生，门是开着的，所以键盘会原样通过 ——
    这个基线的作用就是把这个结论**量化出来**，而不是靠推测。
    """

    name = "gate"
    note = "能量门限（近似复现 public/voice-gate-worklet.js）"

    def __init__(self, threshold_db: float = -45.0, hysteresis_db: float = 6.0,
                 hold_s: float = 0.12, attack_s: float = 0.004, release_s: float = 0.08):
        self.threshold_db = threshold_db
        self.hysteresis_db = hysteresis_db
        self.hold_s = hold_s
        self.attack_s = attack_s
        self.release_s = release_s

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        frame = 128  # AudioWorklet 的渲染量子
        n_frames = len(mixed) // frame
        out = np.zeros(n_frames * frame, dtype=np.float32)

        # 侧链：500Hz–4kHz 带通后取电平（与 worklet 的检测支路一致）
        side = _bandpass(mixed[: n_frames * frame], sr, 500.0, 4000.0)

        open_lin = 10 ** (self.threshold_db / 20)
        close_lin = 10 ** (self.threshold_db - self.hysteresis_db) / 20
        hold_frames = max(1, int(self.hold_s * sr / frame))
        attack = 1.0 / max(1.0, self.attack_s * sr / frame)
        release = 1.0 / max(1.0, self.release_s * sr / frame)

        is_open = False
        below = 0
        gain = 0.0
        for i in range(n_frames):
            seg = side[i * frame:(i + 1) * frame]
            level = math.sqrt(float(np.mean(seg.astype(np.float64) ** 2)) + 1e-20)
            if is_open:
                if level < close_lin:
                    below += 1
                    if below >= hold_frames:
                        is_open = False
                        below = 0
                else:
                    below = 0
            else:
                if level > open_lin:
                    is_open = True
                    below = 0

            target = 1.0 if is_open else 0.0
            coeff = attack if target > gain else release
            gain += (target - gain) * coeff
            out[i * frame:(i + 1) * frame] = mixed[i * frame:(i + 1) * frame] * gain

        return out


# ------------------------------------------------------------
#  瞬态门限：用「按键检测」而不是「语音能量」来驱动门
#
#  动机来自 oracle 的实测结果（见 tools/diag_oracle.py）：
#      oracle-irm（理想时频掩码）  键盘 −10.7dB / 语音 +1.0dB
#      oracle-gate（精确时刻静音） 键盘 −20.4dB / 语音 −0.7dB
#  简单的「精确静音 12ms」**完胜**理想时频掩码。原因是键盘瞬态只占
#  几十毫秒，掐掉这一小段对语音的感知损失极小，而时频掩码要在语音存在时
#  逐 bin 分辨，反而做不到干净。
#
#  所以真正的问题不是「找一个更强的分离模型」，而是
#  **「能不能可靠地检测到按键瞬间」**。而检测器实测 100% 召回。
#
#  这个处理器就是「检测器 + 短静音」的真实（非 oracle）实现。
# ------------------------------------------------------------

class TransientGate(Processor):
    """用 6–16kHz 瞬态检测驱动的门限。

    与 EnergyGate 的本质区别：
      - EnergyGate 判的是「**有声**吗」→ 说话时必然开门，键盘原样通过；
      - TransientGate 判的是「有**咔哒**吗」→ 只掐瞬态那几毫秒，
        说话本身完全不触发它。

    实现刻意用因果（只看过去）的方式，因为真实部署必须实时：
    检测到起振后往前多掐一点（起振前 2ms），把攻击沿一并削掉。
    """

    name = "transient"
    note = "瞬态检测门限（6–16kHz 起振检测 + 短静音）"

    def __init__(self, rise_db: float = 10.0, hold_ms: float = 10.0,
                 pre_ms: float = 2.0, floor_percentile: float = 30.0,
                 attack_release_ms: float = 1.0,
                 speech_atten_db: float = 0.0, speech_hold_ms: float | None = None,
                 rise_window_ms: float = 80.0) -> None:
        self.rise_db = rise_db
        self.hold_ms = hold_ms
        self.pre_ms = pre_ms
        self.floor_percentile = floor_percentile
        self.attack_release_ms = attack_release_ms
        # 说话期间的策略：硬静音会削掉语音，所以允许改成「轻压」。
        # speech_atten_db = 0 表示与静音时相同（全静音）；
        # 负值（如 -12）表示说话期间只压 12dB —— 听感上近似「键盘变远」。
        self.speech_atten_db = speech_atten_db
        self.speech_hold_ms = speech_hold_ms if speech_hold_ms is not None else hold_ms
        self.rise_window_ms = rise_window_ms

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        frame = 240  # 5ms 分析帧（瞬态需要细分辨率）
        n = len(mixed)
        n_frames = n // frame

        seg = mixed[: n_frames * frame].reshape(n_frames, frame).astype(np.float64)
        seg = seg - np.mean(seg, axis=1, keepdims=True)
        spec = np.abs(np.fft.rfft(seg * np.hanning(frame), n=frame, axis=1))
        freqs = np.fft.rfftfreq(frame, 1 / sr)
        band = (freqs >= 6000) & (freqs <= 16000)
        env = 10 * np.log10(np.maximum(np.mean(spec[:, band] ** 2, axis=1), 1e-20))

        # 触发判据：**能量的「突增」**，而不是「能量高」。
        #
        # 踩过的坑：最初用「高带能量 > 底噪 + rise_db」，在合成语音上触发率 7%
        # （看起来很干净），到真人语音上触发率飙到 **54%**、精确率只有 43%。
        # 原因是真人语音在 6–16kHz 有明显**持续**能量（擦音、齿音），
        # 于是检测器把「有声音」当成了「有咔哒」——"说话期间轻压"退化成了
        # 整体降音量（表现为键压低 −11dB、语音变化 −10dB，两者几乎相等）。
        #
        # 正确的物理区分：键盘是瞬态（几毫秒涨 20dB 再衰减），语音是持续能量。
        # 所以看「当前相对近邻低点的抬升」——持续能量抬升小，瞬态抬升大。
        win = max(2, int(self.rise_window_ms / 1000 * sr / frame))
        rise = np.zeros(n_frames, dtype=np.float64)
        for i in range(n_frames):
            lo = max(0, i - win)
            rise[i] = env[i] - float(np.min(env[lo:i + 1]))

        triggered = rise > self.rise_db

        # 不应期：一次击键会跨几帧，只保留局部峰
        min_gap = max(1, int(0.05 * sr / frame))
        kept = np.zeros(n_frames, dtype=bool)
        last = -min_gap
        for i in range(n_frames):
            if triggered[i] and (i - last) >= min_gap:
                # 向前找峰顶
                j = i
                while j + 1 < n_frames and rise[j + 1] > rise[j]:
                    j += 1
                kept[j] = True
                last = j

        # 语音活动：**平滑后的**宽带能量 + 迟滞。
        #
        # 踩过的坑：最初用「100–1000Hz 的逐帧能量 + 两个分位夹出的门限」，
        # 在合成语音上召回 92%（看起来没问题），到真人语音上掉到 **82%**。
        # 而漏判说话帧的后果很严重：门会在说话期间施加静音窗 → 吞字
        # （实测让「说话期不动手」的配置也损失了 11.9dB 语音）。
        #
        # 真人语音的能量起伏比合成语音剧烈得多，所以这里做三件事：
        #   1. 频带加宽到 100–4000Hz（含 F1/F2，能量更稳）；
        #   2. 时间平滑（约 50ms），消除音节间隙的抖动；
        #   3. 迟滞（开门/关门阈值不同），避免在门限附近反复翻转。
        wide = (freqs >= 100) & (freqs <= 4000)
        wide_env = 10 * np.log10(
            np.maximum(
                np.mean(np.abs(np.fft.rfft(seg * np.hanning(frame), n=frame, axis=1))[:, wide] ** 2, axis=1),
                1e-20,
            )
        )
        smooth = max(1, int(0.05 * sr / frame))
        kernel = np.ones(smooth) / smooth
        wide_env = np.convolve(wide_env, kernel, mode="same")

        lo_p, hi_p = np.percentile(wide_env, 15), np.percentile(wide_env, 90)
        span = max(hi_p - lo_p, 1e-6)
        open_th = lo_p + span * 0.30
        close_th = lo_p + span * 0.18
        speech = np.zeros(n_frames, dtype=bool)
        on = False
        for i, v in enumerate(wide_env):
            if on:
                if v < close_th:
                    on = False
            elif v > open_th:
                on = True
            speech[i] = on

        # 触发点分别处理：静音期全静音，说话期按 speech_atten_db 轻压
        gain = np.ones(n, dtype=np.float64)
        hold = int(self.hold_ms / 1000 * sr)
        s_hold = int(self.speech_hold_ms / 1000 * sr)
        pre = int(self.pre_ms / 1000 * sr)
        s_gain = 10 ** (self.speech_atten_db / 20)

        for i in np.where(kept)[0]:
            a = max(0, i * frame - pre)
            if speech[i]:
                b = min(n, i * frame + s_hold)
                gain[a:b] = np.minimum(gain[a:b], s_gain)
            else:
                b = min(n, i * frame + hold)
                gain[a:b] = 0.0

        # 加一点斜坡，避免硬切产生新的咔哒声（这本身就是个音频工程常识）
        ramp = max(1, int(self.attack_release_ms / 1000 * sr))
        if ramp > 1:
            kernel = np.ones(ramp) / ramp
            gain = np.convolve(gain, kernel, mode="same")

        return (mixed * gain).astype(np.float32)


def _bandpass(x: np.ndarray, sr: int, lo: float, hi: float) -> np.ndarray:
    """频域带通（评测里不求实时，怎么简单怎么来）。"""
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    spec[(freqs < lo) | (freqs > hi)] = 0
    return np.fft.irfft(spec, n=len(x)).astype(np.float32)


# ------------------------------------------------------------
#  Oracle（理论上限）：用真值算出「最好的分离」
#
#  存在的理由：在花几周接模型之前，先确认这个问题**本身可不可解**。
#  如果连拿着真值的理想掩码都分不开，那换任何模型都是白费；
#  如果理想掩码很干净，就说明信息足够，值得投模型 —— 而且给出了目标值。
#
#  注意：这些处理器**作弊**（用了 clean speech / keyboard 真值），
#  它们不是可部署方案，只用来画上限。
# ------------------------------------------------------------

class OracleIdealRatioMask(Processor):
    """理想比值掩码（IRM）：逐时频点取 speech² / (speech² + key²)。

    这是分离问题的经典「乐观上限」：它知道每个时频点里语音和噪声各占多少。
    """
    name = "oracle-irm"
    note = "理想比值掩码（用真值，仅用于画上限）"

    def __init__(self, samples_dir: Path) -> None:
        self._dir = samples_dir

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        if case is None:
            raise ValueError("oracle 处理器需要用例信息（真值）")
        speech, _ = read_wav(self._dir / case["speech_only"])
        n = min(len(mixed), len(speech))
        mixed = mixed[:n]
        speech = speech[:n]

        # 键盘分量 = 混合 − 语音（合成数据里这个减法成立）
        key = mixed.astype(np.float64) - speech.astype(np.float64)

        s_spec = np.fft.rfft(_frames(mixed), axis=1)
        sp_spec = np.fft.rfft(_frames(speech), axis=1)
        k_spec = np.fft.rfft(_frames(key), axis=1)

        p_s = np.abs(sp_spec) ** 2
        p_k = np.abs(k_spec) ** 2
        mask = p_s / np.maximum(p_s + p_k, 1e-20)

        out = _overlap_add(s_spec * mask, n)
        return out.astype(np.float32)


class OracleIdealBinaryMask(Processor):
    """理想二值掩码（IBM）：时频点上语音占优就整块保留，否则整块丢弃。

    比 IRM 更激进，语音失真通常更大 —— 两者一并给出上限区间。
    """
    name = "oracle-ibm"
    note = "理想二值掩码（用真值，仅用于画上限）"

    def __init__(self, samples_dir: Path, threshold: float = 1.0) -> None:
        self._dir = samples_dir
        self._threshold = threshold  # speech/key 功率比门限，1.0 = 谁大留谁

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        if case is None:
            raise ValueError("oracle 处理器需要用例信息（真值）")
        speech, _ = read_wav(self._dir / case["speech_only"])
        n = min(len(mixed), len(speech))
        mixed = mixed[:n]
        speech = speech[:n]
        key = mixed.astype(np.float64) - speech.astype(np.float64)

        s_spec = np.fft.rfft(_frames(mixed), axis=1)
        sp_spec = np.fft.rfft(_frames(speech), axis=1)
        k_spec = np.fft.rfft(_frames(key), axis=1)

        p_s = np.abs(sp_spec) ** 2
        p_k = np.abs(k_spec) ** 2
        mask = (p_s > p_k * self._threshold).astype(np.float64)

        return _overlap_add(s_spec * mask, n).astype(np.float32)


class OraclePerfectGate(Processor):
    """完美门限：用真值精确知道「键盘事件发生的瞬间」，只在那几毫秒把增益打到 0。

    这是**门限方案的绝对上限** —— 比它能做到更好的门限不存在。
    拿它和真实门限对比，就能回答「门限这条路还有没有优化空间」。
    """
    name = "oracle-gate"
    note = "完美门限：精确知道键盘时刻（用真值，仅用于画上限）"

    def __init__(self, hold_ms: float = 12.0) -> None:
        self._hold = hold_ms

    def process(self, mixed: np.ndarray, sr: int, case: dict | None = None) -> np.ndarray:
        if case is None:
            raise ValueError("oracle 处理器需要用例信息（真值）")
        out = mixed.copy()
        hold = int(self._hold / 1000 * sr)
        for t in case["key_times"]:
            a = int(t * sr)
            b = min(len(out), a + hold)
            if b > a:
                out[a:b] = 0.0
        return out


def _frames(x: np.ndarray, n_fft: int = 512, hop: int = 512) -> np.ndarray:
    """分成加窗帧，供 oracle 掩码使用。"""
    from dsp import WINDOW

    n_frames = max(1, 1 + (len(x) - n_fft) // hop)
    pad = max(0, (n_frames - 1) * hop + n_fft - len(x))
    xs = np.concatenate([x, np.zeros(pad, dtype=x.dtype)])
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    return xs[idx] * WINDOW


def _overlap_add(spec: np.ndarray, length: int, n_fft: int = 512, hop: int = 512) -> np.ndarray:
    """把谱还原成时域（与 dsp.istft 同构，但接受任意长度）。"""
    from dsp import WINDOW

    frames = np.fft.irfft(spec, n=n_fft, axis=1) * WINDOW
    out_len = (frames.shape[0] - 1) * hop + n_fft
    out = np.zeros(out_len, dtype=np.float64)
    norm = np.zeros(out_len, dtype=np.float64)
    for i in range(frames.shape[0]):
        a = i * hop
        out[a:a + n_fft] += frames[i]
        norm[a:a + n_fft] += WINDOW ** 2
    norm[norm < 1e-8] = 1.0
    return (out / norm)[:length]


_PROCESSORS: dict[str, Processor] | None = None
_PROCESSORS_DIR: Path | None = None


def get_processors(samples_dir: Path | None = None) -> dict[str, Processor]:
    """取处理器注册表（进程内只构建一次）。

    缓存的原因不只是省时间：模型加载会打印探测信息，
    重复构建会让同一句提示刷两遍，干扰阅读。
    """
    global _PROCESSORS, _PROCESSORS_DIR
    target = samples_dir or DEFAULT_SAMPLES
    if _PROCESSORS is None or _PROCESSORS_DIR != target:
        _PROCESSORS = _build_processors(target)
        _PROCESSORS_DIR = target
    return _PROCESSORS


def _build_processors(samples_dir: Path) -> dict[str, Processor]:
    """处理器注册表。

    基线（identity / gate）永远可用；模型类处理器由 models.py 按依赖情况
    动态注册 —— 缺依赖时只提示、不报错，评测台照常能跑基线。

    要接入新模型，在 models.py 里加一个类并实现 `process(mixed, sr) -> out`，
    然后在 `register_optional` 里注册即可，不需要改本文件的评测逻辑。
    """
    processors: dict[str, Processor] = {
        "identity": Identity(),
        # 默认阈值：与 web 客户端设置里的默认值一致（-45 dBFS）
        "gate": EnergyGate(),
        # 敏感度分析：把门限收紧到 -30 / -20 dBFS。
        # 目的不是「调好它」，而是从数据上证明：收紧阈值确实能让门开始工作，
        # 但代价一定是把语音一起压掉 —— 因为能量判据无法区分「瞬态键盘」与「清音」。
        "gate-30": EnergyGate(threshold_db=-30.0),
        "gate-20": EnergyGate(threshold_db=-20.0),
        # 瞬态检测门限：用「有没有咔哒」而不是「有没有声音」来驱动
        "transient": TransientGate(),
        # 说话期间只轻压（-12dB）而不是硬静音：牺牲一点键盘抑制换取语音完整
        "transient-soft": TransientGate(speech_atten_db=-12.0, speech_hold_ms=6.0, hold_ms=10.0),
        # 更短的静音窗：进一步减少对语音的破坏
        "transient-short": TransientGate(hold_ms=6.0, speech_hold_ms=6.0),
        # ---- 理论上限（用真值作弊，只用来判断问题是否可解）----
        "oracle-irm": OracleIdealRatioMask(samples_dir),
        "oracle-ibm": OracleIdealBinaryMask(samples_dir),
        "oracle-gate": OraclePerfectGate(),
    }

    # 模型处理器（可选依赖）：DeepFilterNet3 等
    import models

    models.register_optional(processors)  # type: ignore[arg-type]
    return processors


# ------------------------------------------------------------
#  指标
# ------------------------------------------------------------

def _masks(mixed: np.ndarray, manifest_case: dict) -> dict[str, np.ndarray]:
    """按 manifest 的时间标注生成 10ms 帧级掩码。

    - key_silence：纯键盘（该帧无语音活动）—— 门限方案唯一能处理的场景
    - key_speech ：**语音进行中**的键盘 —— 真实战场，门限在这里完全失效
    - speech     ：语音活动帧（不论有没有键盘）
    """
    frame = 480
    n_frames = len(mixed) // frame
    centers = (np.arange(n_frames) + 0.5) * frame / SR

    key_mask = np.zeros(n_frames, dtype=bool)
    for t in manifest_case["key_times"]:
        # 键盘事件的能量大约持续 60ms
        key_mask |= (centers >= t) & (centers <= t + 0.06)

    speech_mask = np.zeros(n_frames, dtype=bool)
    for a, b in manifest_case["speech_spans"]:
        speech_mask |= (centers >= a) & (centers <= b)

    return {
        "key_silence": key_mask & ~speech_mask,
        "key_speech": key_mask & speech_mask,
        "speech": speech_mask,
    }


@dataclass
class Metrics:
    id: str
    processor: str
    key_drop_db: float
    key_speech_drop_db: float
    speech_drop_db: float
    key_leak_db: float
    speech_residual_db: float


def _frame_db(x: np.ndarray, frame: int = 480) -> np.ndarray:
    n = len(x) // frame
    seg = x[: n * frame].reshape(n, frame).astype(np.float64)
    return 10 * np.log10(np.maximum(np.mean(seg ** 2, axis=1), 1e-20))


def _self_check(case_id: str, processor: str, mixed_db: np.ndarray, out_db: np.ndarray,
                key_mask: np.ndarray, speech_mask: np.ndarray) -> None:
    """自检：identity（原样输出）必须给出全 0。

    这是指标自身的正确性证明。一个自检行不是 0，说明指标写错了 ——
    那么基于它的任何结论都不可信。早先版本就吃过这个亏
    （语音参考量尺度不对，identity 的「语音残留」显示 +10.8dB）。
    """
    if processor != "identity":
        return
    n = min(len(mixed_db), len(out_db))
    for label, mask in (("键压低", key_mask[:n]), ("语音变化", speech_mask[:n])):
        if mask.sum() < 3:
            continue
        delta = float(np.mean(out_db[:n][mask] - mixed_db[:n][mask]))
        if abs(delta) > 1e-6:
            eprint(f"  ⚠️ 指标自检失败：identity 在 {case_id} 的「{label}」= {delta:+.4f}dB（应为 0）")


def measure(case_id: str, processor: str, mixed: np.ndarray, out: np.ndarray,
            manifest_case: dict, samples_dir: Path) -> Metrics:
    """对照输入与输出算指标。

    两个决策量的语义：

      · `key_drop_db` / `key_speech_drop_db`：键盘帧上**输入→输出**的电平衰减。
        负得越多说明键盘被压得越狠。`key_speech_drop_db` 只统计**说话期间**的
        键盘帧 —— 那才是真实战场（说话时门限必然是开的）。

      · `speech_drop_db`：语音帧上输入→输出的变化，**越接近 0 越好**。
        它是同一条信号自比，因此不受任何参考尺度影响，identity 下精确为 0 ——
        判断「有没有吞字」要看它。

      · `speech_residual_db`：诊断量，**不要用于决策**（原因见下方注释）。
    """
    mixed_db = _frame_db(mixed)
    out_db = _frame_db(out)
    n = min(len(mixed_db), len(out_db))

    masks = {k: v[:n] for k, v in _masks(mixed, manifest_case).items()}
    key_mask = masks["key_silence"] | masks["key_speech"]
    speech_mask = masks["speech"]

    def mean_delta(mask: np.ndarray) -> float:
        if mask.sum() < 3:
            return float("nan")
        return float(np.mean(out_db[mask] - mixed_db[mask]))

    key_drop = mean_delta(key_mask)
    key_speech_drop = mean_delta(masks["key_speech"])
    speech_drop = mean_delta(speech_mask)

    # 键盘残留：输出在键盘帧上的绝对电平，相对输入键盘帧电平
    key_leak = (
        float(np.mean(out_db[key_mask])) - float(np.mean(mixed_db[key_mask]))
        if key_mask.sum() >= 3
        else float("nan")
    )

    # 语音残留：输出语音帧电平 vs 混合里真实语音分量的电平。
    #
    # ⚠️ **这是诊断量，不是决策量。** 它的一个固有性质：identity（什么都不做）
    # 也不会是 0 —— 因为语音分量自身的电平在不同帧上下起伏，帧平均必然产生
    # 非零差值（实测 +4~12dB，取决于语音的起伏幅度）。
    # 所以**不要**用它的绝对值判断「语音有没有被破坏」；
    # 判断语音保真请用 `speech_drop_db`（输出相对输入的帧级变化）——
    # 那是同一条信号自比，不受任何参考尺度影响，identity 下精确为 0。
    #
    # 这里用「混合 = scale × 语音 + 键盘」反解尺度，是为了让这个诊断量至少
    # 与混合同尺度（否则连量级都不可比）。
    speech_only, _ = read_wav(samples_dir / manifest_case["speech_only"])
    m = min(len(mixed), len(speech_only))
    ref = speech_only[:m].astype(np.float64)
    mix = mixed[:m].astype(np.float64)
    scale = float(np.dot(ref, mix) / max(float(np.dot(ref, ref)), 1e-20))
    speech_in_mix = ref * scale

    speech_db = _frame_db(speech_in_mix.astype(np.float32))[:n]
    speech_residual = (
        float(np.mean(out_db[speech_mask] - speech_db[speech_mask]))
        if speech_mask.sum() >= 3
        else float("nan")
    )

    _self_check(case_id, processor, mixed_db, out_db, key_mask, speech_mask)

    return Metrics(
        id=case_id,
        processor=processor,
        key_drop_db=key_drop,
        key_speech_drop_db=key_speech_drop,
        speech_drop_db=speech_drop,
        key_leak_db=key_leak,
        speech_residual_db=speech_residual,
    )


# ------------------------------------------------------------
#  主流程
# ------------------------------------------------------------

def run(processors: list[str] | None, snrs: list[int] | None, samples_dir: Path, out_dir: Path) -> list[Metrics]:
    manifest = json.loads((samples_dir / "manifest.json").read_text("utf8"))
    registry = get_processors(samples_dir)

    names = processors or list(registry)
    missing = [p for p in names if p not in registry]
    if missing:
        eprint(f"未知处理器：{missing}；可用：{sorted(registry)}")
        return []

    results: list[Metrics] = []

    out_dir.mkdir(parents=True, exist_ok=True)

    for case in manifest["cases"]:
        if snrs and int(round(case["snr_db"])) not in snrs:
            continue
        mixed, _ = read_wav(samples_dir / case["mix"])

        for name in names:
            proc = registry[name]
            try:
                out = proc.process(mixed, SR, case)
            except Exception as err:  # noqa: BLE001
                # 单个处理器崩掉不该让整场评测（尤其基线）跑不起来 ——
                # 模型类处理器依赖多、失败方式杂，这里必须兜住。
                eprint(f"  {case['id']:<14} {name:<12} 跳过：{type(err).__name__}: {err}")
                continue
            if out is None:  # pragma: no cover - 防御性
                continue
            from dsp import write_wav
            if name != "identity":
                write_wav(out_dir / f"{case['id']}__{name}.wav", out)
            m = measure(case["id"], name, mixed, out, case, samples_dir)
            results.append(m)
            eprint(f"  {case['id']:<14} {name:<12} key_drop={m.key_drop_db:+6.1f}dB  "
                   f"key@speech={m.key_speech_drop_db:+6.1f}dB  speech_drop={m.speech_drop_db:+6.1f}dB")

    return results


def report(results: list[Metrics]) -> None:
    by_case: dict[str, list[Metrics]] = {}
    for m in results:
        by_case.setdefault(m.id, []).append(m)

    for case_id, rows in by_case.items():
        print(f"\n=== {case_id} ===")
        print(f"{'处理器':<12}{'键压低(全部)':>14}{'键压低(说话中)':>16}{'语音变化':>10}{'语音残留':>10}")
        for m in rows:
            print(f"{m.processor:<12}{m.key_drop_db:>12.1f}dB{m.key_speech_drop_db:>14.1f}dB"
                  f"{m.speech_drop_db:>9.1f}dB{m.speech_residual_db:>9.1f}dB")

    print("\n读法：")
    print("  · 「键压低(说话中)」是**真实战场**：打字时你正在说话，门限必然是开的，")
    print("    所以这一列就是门限方案的死穴，也是任何新模型必须打赢的那一列。")
    print("  · 「语音变化」要接近 0、「键压低」要 ≥12dB —— 同时满足才是真分离。")
    print("  · identity 行是自检：它应当全是 0，否则指标本身有问题。")
    print("  · oracle-* 行是**理论上限**（用了真值作弊）：它回答「这个问题可不可解」。")
    print("    真实模型不可能超过 oracle；差距就是模型的能力缺口，也就是投入的方向。")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--processor", action="append", dest="processors")
    ap.add_argument("--snr", action="append", type=int, dest="snrs")
    ap.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    names = args.processors or list(get_processors(args.samples).keys())
    res = run(names, args.snrs, args.samples, args.out)
    report(res)

    if not res:
        eprint("没有产生任何结果：检查 samples/manifest.json 是否存在（先跑 make_samples.py）")
        sys.exit(1)
