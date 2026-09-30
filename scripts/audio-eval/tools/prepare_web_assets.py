"""准备 DFN3 的前端资产：把 ORT 运行时、模型、以及 worklet/worker 脚本放到 public/dfn3/。

为什么需要这一步：这些是**二进制与大文件**（ORT wasm 10.7MB + 模型 12.9MB 等），
不适合提交进仓库，但部署时必须能被浏览器请求到。所以按与 `gen:avatars` 同样的
思路：脚本化准备 + gitignore。

产物（public/dfn3/）：
    denoiser_model.onnx          模型本体（12.9MB）
    initial_states.npz           流式初始状态
    ort/                          ONNX Runtime Web 的 js + wasm
    dfn3-worklet.mjs             AudioWorklet 处理器
    channel.mjs                  worklet 的纯逻辑（被 worklet import）
    ring-buffer.mjs              环形缓冲（worklet 与 worker 共用）
    inference-worker.mjs         推理线程

用法：
    python tools/prepare_web_assets.py
    python tools/prepare_web_assets.py --ort-version 1.22.0
"""

from __future__ import annotations

import argparse
import shutil
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
REPO_ROOT = HERE.parent.parent          # cf-teamspeed/
PUBLIC = REPO_ROOT / "public" / "dfn3"
CLIENT = REPO_ROOT / "client" / "dfn3"
MODELS = HERE / "models"

# ONNX Runtime Web 的 CDN 源。只取 **SIMD + 多线程** 那一份：
# jsep（WebGPU）版 20.9MB，接近 Cloudflare 单文件上限，且 CPU 版已够用。
ORT_FILES = [
    "ort.min.js",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
]

# 需要随包分发的 JS（worklet 与 worker 及其依赖）
JS_FILES = ["channel.mjs", "ring-buffer.mjs", "dfn3-worklet.mjs", "inference-worker.mjs"]


def fetch(url: str, dst: Path, label: str) -> bool:
    """下载（带简单重试）。已存在且非空则跳过。"""
    if dst.exists() and dst.stat().st_size > 1024:
        print(f"  ✓ {label} 已存在（{dst.stat().st_size / 1e6:.1f}MB）")
        return True

    dst.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 4):
        try:
            # 注意：某些源对 Accept 头敏感（返回 406），所以只发最朴素的请求
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=120) as resp, open(dst, "wb") as f:
                shutil.copyfileobj(resp, f)
            print(f"  ✓ {label} 下载完成（{dst.stat().st_size / 1e6:.1f}MB）")
            return True
        except Exception as err:  # noqa: BLE001
            print(f"  … {label} 第 {attempt} 次失败：{err}")
            if dst.exists():
                dst.unlink()
    print(f"  ✗ {label} 下载失败")
    return False


def copy_local(src: Path, dst: Path) -> bool:
    if not src.exists():
        print(f"  ✗ 缺少 {src}")
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"  ✓ {dst.name}（{src.stat().st_size / 1e3:.0f}KB）")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ort-version", default="1.22.0")
    args = ap.parse_args()

    ok = True

    print("1) ONNX Runtime Web")
    base = f"https://cdn.jsdelivr.net/npm/onnxruntime-web@{args.ort_version}/dist"
    for name in ORT_FILES:
        if not fetch(f"{base}/{name}", PUBLIC / "ort" / name, f"ort/{name}"):
            ok = False

    print("\n2) 模型与初始状态")
    for name in ("denoiser_model.onnx", "initial_states.npz"):
        if not copy_local(MODELS / name, PUBLIC / name):
            print("     （先跑 python tools/fetch_model.py 下载模型）")
            ok = False

    print("\n3) worklet / worker 脚本")
    for name in JS_FILES:
        if not copy_local(CLIENT / name, PUBLIC / name):
            ok = False

    if not ok:
        print("\n有资产缺失，DFN3 引擎会在运行时回退到其他引擎（不会崩，但不可用）。")
        return 1

    total = sum(f.stat().st_size for f in PUBLIC.rglob("*") if f.is_file())
    print(f"\n全部就绪 → {PUBLIC}")
    print(f"合计 {total / 1e6:.1f}MB（首次访问需下载这些；Cloudflare 静态资源会自动 gzip）")
    print("\n⚠️ 还需要响应头才能启用 SharedArrayBuffer（见 public/_headers）：")
    print("     Cross-Origin-Opener-Policy: same-origin")
    print("     Cross-Origin-Embedder-Policy: require-corp")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
