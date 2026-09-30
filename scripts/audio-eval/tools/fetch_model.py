"""可靠地下载评测用的模型权重。

为什么不用 `deepfilter_stream` 自带的下载器：它用 `urlretrieve`，**一次失败就放弃**，
而且不校验中途断流（我们第一次就遇到「只下到 12.7MB / 12.9MB」直接报错）。
模型文件 13MB 左右，网络抖动很常见，所以这里做两件它没做的事：

  1. **断点续传**：用 HTTP Range 从已下好的字节继续；
  2. **重试 + sha256 校验**：只有校验通过才算成功，避免用一个损坏的模型
     得出「这个模型没用」的错误结论。

用法：
    python tools/fetch_model.py
"""

from __future__ import annotations

import hashlib
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
MODEL_DIR = HERE / "models"

RELEASE_BASE = (
    "https://github.com/wuxuedaifu/deepfilter-stream/releases/download/model-dfn3-512-v1"
)
ASSETS = {
    "denoiser_model.onnx": "b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc",
    "initial_states.npz": "1165503707b8859a6b650b6bb0dc5b6c55d30c2779d87502f97a77102b5d3872",
    "meta.json": "f069011a01849629ad23fbb1d00f4417cf106d5e316e3f7fbcba65cce3440818",
}

MAX_ATTEMPTS = 6


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(name: str, want_sha: str) -> bool:
    dst = MODEL_DIR / name
    url = f"{RELEASE_BASE}/{name}"

    if dst.exists() and sha256_file(dst) == want_sha:
        print(f"  ✓ {name} 已存在且校验通过")
        return True

    for attempt in range(1, MAX_ATTEMPTS + 1):
        have = dst.stat().st_size if dst.exists() else 0
        headers = {"User-Agent": "cf-teamspeed-eval"}
        if have:
            headers["Range"] = f"bytes={have}-"

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as resp:
                # 服务器不支持 Range 时会返回 200 全量，这时要重头写
                mode = "ab" if (have and resp.status == 206) else "wb"
                if mode == "wb":
                    have = 0
                with open(dst, mode) as f:
                    while True:
                        chunk = resp.read(1 << 18)
                        if not chunk:
                            break
                        f.write(chunk)
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            print(f"  … {name} 第 {attempt} 次中断（已有 {have / 1e6:.1f}MB）：{err}")
            time.sleep(1.5 * attempt)
            continue

        got = sha256_file(dst)
        if got == want_sha:
            print(f"  ✓ {name} 下载完成并校验通过（{dst.stat().st_size / 1e6:.1f}MB）")
            return True

        print(f"  … {name} 校验不符，重试（got {got[:12]}…）")
        dst.unlink(missing_ok=True)
        time.sleep(1.5 * attempt)

    print(f"  ✗ {name} 下载失败")
    return False


def main() -> int:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"模型目录：{MODEL_DIR}")
    ok = all(download(name, sha) for name, sha in ASSETS.items())
    if ok:
        print(f"\n全部就绪。用法：\n  set DEEPFILTER_STREAM_MODEL_DIR={MODEL_DIR}\n")
        print("（models.py 也会自动把该目录填给 deepfilter_stream）")
        return 0
    print("\n有文件未就绪，评测无法进行。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
