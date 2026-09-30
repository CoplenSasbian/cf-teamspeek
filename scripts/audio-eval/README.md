# 语音隔离评测台

**它回答一个问题：到底哪个模型能去掉"和语音同时发生的键盘声"。**

之所以要先建这个，而不是直接上模型：这类效果改进很容易陷入"听起来好像好一点"的
主观循环。有了可复现样本 + 客观指标，换模型才有结论，也才能防止改坏。

## 为什么场景是"同时发生"

打游戏时打字和说话是重叠的。门限类方案（现在的 `voice-gate-worklet.js`）判据是
**电平**：说话时门必然开着，键盘就原样通过。所以真实战场是
「语音进行中的键盘」，评测里专门单列了这一列（`键压低(说话中)`）。

## 跑起来

```bash
cd scripts/audio-eval
python -m pip install numpy                     # 基线评测只需要这个
python make_samples.py                          # 生成合成样本
python calibrate.py                             # 电平校准：解释门限为什么不管用
python evaluate.py                              # 跑评测，打印对比表
python evaluate.py --processor gate-30 --snr 6  # 只跑指定处理器 / 只跑 6dB SNR
python evaluate.py --processor dfn3             # 跑模型（需要额外依赖，见下）
```

样本与输出目录可用环境变量重定向到可写位置（受限环境用）：

```bash
CF_EVAL_SAMPLES=/tmp/cf-eval/samples CF_EVAL_OUT=/tmp/cf-eval/out python evaluate.py
```

## 接入一个模型

**优先用已经跑通预处理的库，不要自己重写模型的特征提取。**

原因：DeepFilterNet3 这类模型的特征提取（STFT、ERB 滤波器组、指数均值归一化）
和帧间 GRU 状态管理细节很多，手写几乎一定会错 —— 而写错的表现是
「输出一堆噪声，看起来像这个模型没用」，会让你得出完全错误的结论。

```bash
python -m pip install onnxruntime deepfilter-stream
python evaluate.py --processor dfn3
```

`models.py` 里的适配器调用 `deepfilter-stream`（DeepFilterNet3 的 ONNX 流式封装），
**每次评测都新建一条流**，避免上一段的 GRU 状态污染下一段。

如果你要试自己的 ONNX 模型，先用探测工具看清它要什么：

```bash
python tools/inspect_onnx.py path/to/model.onnx
```

它会打印输入/输出的名字、维度、类型，并提示：出现 `feat_erb` 这类输入名
说明特征提取在模型外（你得自己实现）；出现 `hidden`/`state` 说明是有状态流式模型
（每帧要把输出状态喂回输入，否则帧间不连续会有咔哒声）。

## 真实录音怎么评

合成样本只能给出**相对排序**，最终判定必须用你的录音。完整流程：

```bash
# 1. 录一段 48kHz 单声道 WAV：一边打字一边说话（越接近你的实际场景越好）
# 2. 自动标注（键盘事件 + 说话区间），然后**人工核对一遍**
python annotate.py 我的录音.wav          # → 我的录音.json
python tools/check_annotate.py           # 标注器的准确度自检（用合成样本的真值）

# 3. 用同一个文件跑不同方案，各自导出 WAV
# 4. 频带衰减对比（不需要干净参考）
python compare_real.py 原始.wav gate.wav dfn3.wav
```

### 判据：看频带衰减

键盘能量集中在 **2–8kHz**（以及 6–16kHz 的咔哒），语音根基在 **0.1–1kHz**。

| 现象 | 含义 |
|---|---|
| 2–8k 衰减 ≫ 0.1–1k 衰减 | ✅ 真的在分离 |
| 两个频段衰减接近 | ❌ 只是整体降了音量 |
| 0.1–1k 衰减比 2–8k 还大 | ❌ 语音被削得更狠 = 吞字 |

`compare_real.py` 会算「分离度评分 = 键盘衰减 − 语音衰减」，`> 6dB` 才算像分离。
同一文件自比应当得 `0.0dB` —— 这是它自己的自检。

### 手机录的、采样率不对怎么办

`dsp.py` 假定 48kHz（与语音室和 worklet 一致）。采样率不是 48k 时脚本会警告，
指标仍可比但频带划分会偏，建议先重采样。

## 指标怎么读

| 列 | 含义 | 好的方向 |
|---|---|---|
| 键压低(全部) | 键盘帧的电平被压低多少 | 越大越好，**≥12dB** 才算去掉 |
| **键压低(说话中)** | 说话期间的键盘帧被压低多少 | **真实战场**，这一列决定成败 |
| 语音变化 | 语音帧的电平变化 | 接近 0；负得多 = 吞字 |
| 语音残留 | 输出语音帧 vs 干净语音的电平差 | 越接近 0 越好 |

`identity`（什么都不做）是自检行：它必须全是 0，否则指标本身有问题。

## 已量到的结论（决策地基）

> ⚠️ **这些数字是在「真人语音 + 合成键盘」样本上测的**（`samples_real/`）。
> 早期版本用纯合成语音，结论是错的 —— 见下方「合成语音的陷阱」。

| 方案 | 键压低(说话中) | 语音变化 | 判定 |
|---|---|---|---|
| identity（自检） | 0.0dB | 0.0dB | 指标可信（必须全 0） |
| **现有能量门限** | **0.0dB** | 0.0dB | ❌ 键盘原样通过 |
| 瞬态检测门限（静止音） | 0.0dB | 0.0dB | ❌ 对同时发生的键盘无效 |
| 瞬态检测门限（说话期轻压） | −1.1dB | −0.9dB | ❌ 几乎等于整体降音量 |
| oracle-gate（精确时刻，作弊） | −6.6 ~ −9.0dB | −3.0dB | 理论上限 |
| **DeepFilterNet3（零调参）** | **−5.6 ~ −7.0dB** | −5.2 ~ −6.0dB | ✅ **唯一真在分离的方案** |

### 三条关键结论

1. **门限类方案（含你现在的实现）对「说话中打字」无效。**
   键盘事件在检测带内的电平是 −22~−34dBFS，而默认阈值 −45dBFS，
   于是 6/6 用例上门都为键盘打开（`calibrate.py`）。

2. **瞬态检测方向对，但收益不足。**
   改成「能量突增」判据后触发率降到 5%（从 54%），可它只能压掉 1.1dB ——
   因为按键与语音在时间上重叠，掐掉瞬态的窗口同时也掐掉了语音。

3. **DeepFilterNet3 有效，且是第一版就有效。**
   零调参达到 −7.0dB 键盘抑制，只比「精确知道按键时刻」的 oracle-gate
   差 5.6dB。而 oracle-gate 是**作弊**的上限（它知道真值）。
   → 结论：**这条路线值得投入**，不需要先去做原生客户端。

## 合成语音的陷阱（重要教训）

前几轮的模型结论全部作废，原因是一个**极其容易踩的坑**：

| 输入 | DFN3 输出质量（相关系数 / SI-SDR） |
|---|---|
| **真人语音** | **r=0.983~0.999，SI-SDR +14.7~+28.6dB** ✅ |
| 合成语音（共振峰谐波堆） | r=0.325，SI-SDR −9.3dB ❌ |

合成语音**不在模型的训练分布内**，模型把它当噪声处理掉了。
如果只用合成样本，会得出「DFN3 没用」的完全错误结论。

**教训**：评测样本的语音部分必须是真人录音。合成只能用于**键盘**这一侧
（键盘是可精确建模的瞬态，且需要精确时间标注）。

## ⚠️ 浏览器部署前必须解决的一件事

DFN3 的固有延迟是 **32ms**（实测，512 样本帧 + GRU 流水线），
而当前 web 链路的降噪延迟是 **13.3ms**（640 样本 @48k）。

也就是说启用 DFN3 会把端到端延迟从 ~13ms 提到 ~32ms（**翻 2.4 倍**）。
对游戏语音这是**可感知的**（约等于多 20ms 的单向延迟），必须先确认能不能接受，
再决定是否移植。这不是实现问题，是产品取舍。

模型侧的可行性数据（已确认）：
- ONNX 图 **自包含**：输入 `input_frame`(512) + 内部状态 → `enhanced_audio_frame`(512)，
  **特征提取在模型内部**，浏览器侧不需要自己实现 STFT/ERB；
- 权重 12.9MB，单核 CPU 约 **7× 实时**（官方数据）；
- 但状态里有 `rolling_spec_buf_x [5,513,2]` 这类张量，逐帧复制有一定开销。

## ✅ JS 侧移植路径已打通（本轮完成）

浏览器要用的机制（`session.run(feeds)` + 手工状态穿线）已在 Node 里**验证通过**：

```bash
cd scripts/audio-eval
npm --prefix ../.. install --no-save onnxruntime-node   # 只用于验证
node js/bench.mjs
```

结果（与 Python 侧逐位一致）：

| 文件 | 延迟 | r | SI-SDR | Python 侧同项 |
|---|---|---|---|---|
| harvard_m1 | 32.0ms | 0.983 | +14.7 dB | 0.983 / +14.7 dB ✅ |
| harvard_m2 | 32.0ms | 0.999 | +28.6 dB | 0.999 / +28.6 dB ✅ |
| harvard_f1 | 32.0ms | 0.998 | +25.1 dB | — |

**性能**：RTF **0.186**（5.4× 实时），单帧 **1.94ms** / 10.67ms 预算 → **占用 18%**。

→ 即使浏览器 WASM 比原生 CPU 慢 3 倍，仍有 1.8× 余量。**性能不是障碍。**

### 移植时踩到的三个坑（都已解决，写在这里省得重踩）

1. **必须重采样到 48kHz。** 我第一版忘了，把 8kHz 录音按 48kHz 喂进模型，
   得到 r≈0.4 的垃圾输出，看起来像"状态穿线有 bug"。
   而状态对比证明穿线完全正确 —— **喂错采样率的表现和"模型坏了"一模一样**。
2. **必须做输入增益归一化**（对齐到 −26dBFS）。DFN3 内部的归一化状态对电平敏感，
   电平不对会判成噪声。真实部署时必须做，否则换个麦克风就失效。
3. **状态必须逐帧复制**（`Float32Array.from`）。ORT 的输出缓冲会在下次 `run` 时复用，
   直接持有引用会串帧。另外 `session.run` 返回 **Promise**（Node 与 Web 都是）。

### 单帧开销分解（实测，`js/bench-breakdown.mjs`）

| 环节 | 每帧 | 占 10.67ms 预算 |
|---|---|---|
| 纯推理 | 1625µs | 15.2% |
| 状态拷贝（180.2 KB/帧，16.5 MB/s） | **146µs** | **1.4%** |
| 张量构造（12 个/帧） | **2µs** | ~0% |
| **完整路径** | **2007µs** | **18.8%** |

**结论：状态穿线的开销可忽略**（占完整路径的 7%）。真正的成本全在推理本身。
我先前把「每帧 180KB 状态」标为「需要认真设计」是**过度担心** —— 实测数据推翻了它。

这条结论对 worklet 设计有直接影响：不需要为状态传输做特殊优化，
重点应当放在「让推理本身在 worker 里高效跑」。

### 浏览器端的剩余风险（诚实评估）

唯一没验证的是 **WASM/多线程在浏览器里的实际性能**。按 18.8% 的当前占用：

- 若 WASM 比原生 CPU EP **慢 3 倍** → 占预算 56%，仍可实时，但余量不大；
- 若慢 **5 倍** → 94%，边缘；
- 若慢 5 倍以上 → 不可行。

所以浏览器实测是**必须做的一步**，我不能靠推断替代它。这也是当前唯一的未知项。

## 浏览器集成的现状与计划

### 已经验证的（不需要浏览器）

| 项 | 结论 | 证据 |
|---|---|---|
| 模型质量 | ✅ 真人语音上 r=0.983~0.999、SI-SDR +14.7~+28.6dB | `tools/real_speech_check.py` |
| 键盘抑制 | ✅ 零调参 −5.6~−7.0dB（说话中），接近作弊上限 | `evaluate.py --samples samples_real` |
| JS 流式实现 | ✅ 与 Python **逐样本一致**（r=1.000000） | `js/bench.mjs` + `js/dump-states.mjs` |
| 性能 | ✅ RTF 0.186（5.4× 实时），单帧占预算 18% | `js/bench.mjs` |
| 延迟 | ⚠️ **32.0ms**（实测，不可调） | 同上 |

### 还没做的（需要浏览器，我在这里无法验证）

浏览器 `AudioWorklet` 的 `process()` **必须同步**，而 ONNX Runtime Web 的
`session.run()` 返回 **Promise**。所以需要：

```
AudioWorklet（音频线程，同步）
   │  写环形缓冲（SharedArrayBuffer）
   ▼
Web Worker（推理线程）
   │  await session.run()  ← 这里可以异步
   ▲  写回输出环形缓冲
   │
AudioWorklet 读回，按延迟对齐输出（补 FRAME_SIZE 个样本）
```

关键点：**推理必须整个放在 worker 里**（每帧要穿线 180KB 状态，
用 postMessage 传状态会成为瓶颈）。需要 `SharedArrayBuffer`，
因此页面要带 **COOP/COEP** 响应头（`Cross-Origin-Opener-Policy: same-origin`
+ `Cross-Origin-Embedder-Policy: require-corp`）。

### 部署体积（已实测，决定分发方式很重要）

| 产物 | 大小 | 说明 |
|---|---|---|
| `ort-wasm-simd-threaded.wasm` | **10.69 MB** | 需要的那个（SIMD + 多线程） |
| `ort-wasm-simd-threaded.jsep.wasm` | 20.86 MB | WebGPU 版，接近 Cloudflare 的 25 MiB 单文件上限 |
| `ort.min.js` | 0.34 MB | — |
| `denoiser_model.onnx` | 12.9 MB | 模型本体 |

合计约 **24 MB**（用 WASM 版而非 WebGPU 版）。Cloudflare 静态资源会自动 gzip，
实际传输量远小于此，但**首次加载需要下载 24MB** —— 这是产品决策的一部分：
建议做成「用户主动开启的高质量模式」，而不是默认加载。

### 集成点（已确认可行）

`app/lib/audio-mixer.ts` 已有 **降噪延迟补偿** 机制
（`DENOISE_LATENCY_SAMPLES` + `preDelay`：把干信号延迟到与降噪输出对齐）。
DFN3 的 32ms 可以直接复用它 —— 只要把 `DENOISE_LATENCY_SAMPLES`
改成按引擎取值即可。这一点显著降低了集成难度。

`app/lib/denoise.ts` 的 `DenoiseEngine` 目前是 `'off' | 'gtcrn' | 'rnnoise'`，
加 `'dfn3'` 后：

- `assetsOf()` 需要分支（DFN3 不是"一个 worklet + 一个 wasm"的形态）；
- `createDenoiseNode()` 需要返回一个**自定义 AudioWorkletNode**（而非库提供的）；
- `attachDenoise()` 的「先建后切」逻辑可以原样复用。

## ✅ 线程架构已在 Node 验证（本轮完成）

浏览器里 `AudioWorklet` 的胶水层无法在这里验证，但**线程协议本身**可以 ——
`worker_threads` 与 `Worker` 的语义一致，环形缓冲与状态穿线完全同构。
所以我把这部分抽成前后端共用的模块，在 Node 里验证透：

```
client/dfn3/ring-buffer.mjs       单生产者单消费者环形缓冲（SharedArrayBuffer + Atomics）
client/dfn3/inference-worker.mjs  DFN3 推理线程（Node / 浏览器共用同一份）
```

| 验证项 | 结果 |
|---|---|
| 样本数守恒 | ✓ 输入 196608 → 输出 196608 |
| **与直接路径逐样本一致** | ✓ **r = 1.000000** |
| 调度 + 跨线程开销 | 61ms / 814ms（**8%**，单帧 160µs） |
| 线程化总代价 | **+12~15%**（1891µs → 2120µs 单帧） |
| 丢弃样本 | 0 |

复现：

```bash
cd scripts/audio-eval
node js/test-threaded.mjs            # 全链路正确性（r=1.000000）
node js/check-threading-overhead.mjs # 开销核验
```

**结论**：加上线程化之后 RTF 从 0.177 变 0.199。即使浏览器 WASM 比原生
CPU 慢 3 倍，也只有约 **60%** 的帧预算占用 —— 仍可实时。

### 这一步为什么值得做

它把「无法验证的浏览器代码」压缩到了**只剩纯浏览器 API 的薄胶水层**
（`AudioWorkletProcessor` 的 `process()` 里读写信道 + `port.postMessage`）。
剩下的风险从「整套线程架构对不对」缩小到「WASM 在浏览器里跑多快」——
**一次测量就能定论**，而不是方向性的不确定。

### 测试台自身踩过的坑（写下来省得重踩）

第一版把 4 秒的处理报成了 **30 秒**，因为收尾循环里反复
`worker.once('exit', ...)` —— 每次都新增监听器，既触发
`MaxListenersExceededWarning`，又让墙钟完全失真。
**worker 自报的单帧推理（2.2ms）与那个 30 秒是矛盾的**，
正是这个矛盾暴露了测试台的问题。改成靠 worker 的最终 stats 消息收敛后，
墙钟从 30.9s 变成 928ms。

## ✅ 已集成进应用（本轮完成）

DFN3 现在是**用户可选的降噪引擎**，接进了正常的引擎切换链路：

| 改动 | 文件 |
|---|---|
| 引擎类型加 `'dfn3'`；延迟按引擎取值（`denoiseLatencySamples()`） | `app/lib/denoise.ts` |
| 引擎句柄统一（DFN3 句柄**本身就是 AudioNode**，挂 `dispose`/`stats`） | `app/lib/denoise.ts` |
| 补偿分析器的延迟对齐改用按引擎取值 | `app/lib/audio-mixer.ts` |
| 设置项类型 | `app/lib/settings.ts` |
| 选项列表 + `denoiseLabel()` | `app/components/audio-shared.ts` |
| 引擎轮换顺序、提示文案 | `app/routes/app-shell.tsx` |
| 文案去硬编码（原先散落六七处） | `SettingsPanel.tsx`、`VoiceStatusPanel.tsx` |

> **为什么做成可选而不是默认**：启用 DFN3 会把端到端延迟从 ~13ms 提到 ~32ms，
> 对游戏语音是可感知的。做成选项后，「要延迟还是要音质」由用户在设置里选，
> 两个目标都保住 —— 不需要替他二选一。

**顺带修掉的维护性问题**：引擎名原先在 UI 里硬编码了六七处嵌套三元表达式，
每加一个引擎都要挨个改（加 DFN3 时又一次漏掉）。现在统一从
`DENOISE_OPTIONS` 派生，以后只改一处。

**刻意不预热 DFN3**：它要下载约 24MB，为一个「可能不会切过去」的选项预先拉
这么多流量不划算。首次切换会等下载，所以 `createDfn3Node` 提供 `onProgress`
回调用于给出进度反馈。

### 文件与验证状态

| 文件 | 作用 | 验证 |
|---|---|---|
| `client/dfn3/ring-buffer.mjs` | 环形缓冲（SharedArrayBuffer + Atomics，无锁） | ✅ Node 线程测试 |
| `client/dfn3/inference-worker.mjs` | 推理线程（Node + 浏览器共用） | ✅ r=1.000000 |
| `client/dfn3/channel.mjs` | **worklet 纯逻辑**（帧装配/相位/欠载兜底） | ✅ **10/10 确定性测试** |
| `client/dfn3/dfn3-worklet.mjs` | AudioWorkletProcessor（只剩薄胶水） | ⬜ 需浏览器 |
| `app/lib/dfn3-engine.ts` | 主线程装配（环境检测/加载/回退） | ✅ 类型检查 |
| `public/_headers` | COOP/COEP 响应头 | ⬜ 需浏览器 |
| `tools/prepare_web_assets.py` | 生成 `public/dfn3/`（24.5MB） | ✅ 已跑通 |

**关键设计**：把所有容易出错的逻辑（帧装配、相位切换、干湿对齐、欠载兜底）
都放进 `channel.mjs`，用 Node 做了**确定性测试**（脚本化假推理端，
每个量子可复现）。所以 `dfn3-worklet.mjs` 里只剩「浏览器 API → 纯逻辑」的绑定，
**无法验证的代码被压到最小**。

### 相位设计（最容易出错的地方）

模型对同一段音频的输入输出差 512 样本，所以「湿信号」天然比干信号晚 512 样本：

- **启动期**（worker 还在下载模型 / 推理）：把输入延迟 512 样本直接输出（纯干信号）；
- **就绪后**：改输出湿信号 —— 两者时间轴一致，切换点连续；
- 切换处做 1 个量子的交叉淡入，避免爆音；
- **欠载时用干信号兜底**并计数（不是输出空洞）—— 欠载频繁说明推理跟不上，
  上层据此降级到更轻的引擎。

### 运行条件（缺一不可）

1. **COOP/COEP 响应头**（`public/_headers` 已配）：SharedArrayBuffer 需要跨源隔离；
2. **48kHz AudioContext**：模型硬约束（当前链路本来就是 48k）；
3. **约 24.5MB 资产**：`python tools/prepare_web_assets.py` 生成（不入库）。

### ⚠️ 上线前必须验证的一点

`require-corp` 会影响到**页面上所有跨源资源**。当前用到跨源资源的地方是
**Turnstile**（`challenges.cloudflare.com`）。Cloudflare 的响应带 CORS 头，
理论上不受影响，但**必须实际点一次管理员登录验证**——否则表现是
「后台登录时人机验证加载不出来」，而且原因很难猜。
若确实被拦，可改用 `Cross-Origin-Embedder-Policy: credentialless`（Chrome/Firefox 支持）。

## 第三方来源与许可

| 素材 | 用途 | 许可 |
|---|---|---|
| **DeepFilterNet3**（Rikorose/DeepFilterNet，经 wuxuedaifu/deepfilter-stream 的 ONNX 导出） | 被评测与集成的分离模型 | MIT / Apache-2.0 双许可 |
| **onnxruntime-node / onnxruntime-web** | 推理运行时 | MIT |
| **Harvard Sentences**（IEEE 推荐语句表，录音取自 voiptroubleshooter.com） | 评测用的真人语音 | 该录音集为公开的标准语音测试材料，仅本地用于评测，**不入库** |

模型权重与录音都**不进仓库**：前者 12.9MB 可用 `tools/fetch_model.py` 重新下载，
后者是你自己的录音或公开测试音频。仓库里只有脚本、结论与说明。

## 目录

| 文件 | 作用 |
|---|---|
| `dsp.py` | 最小音频工具（WAV 读写、STFT/iSTFT、电平），只依赖 numpy |
| `make_samples.py` | 生成合成样本（语音 + 键盘，含真实重叠与时间标注） |
| `calibrate.py` | 电平校准表：门限阈值与键盘电平的相对关系 |
| `evaluate.py` | 评测主流程：处理器注册表 + 指标计算 + 对比表 |
| `models.py` | 模型接入（DeepFilterNet3 等），可选依赖，缺了也不影响基线 |
| `annotate.py` | 给真实录音自动生成标注（按键时刻 + 说话区间） |
| `compare_real.py` | 真实录音的频带衰减对比（不需要干净参考） |
| `tools/inspect_onnx.py` | 打印 ONNX 模型的确切 I/O 契约 |
| `tools/check_annotate.py` | 标注器准确度自检（用合成样本的真值） |
| `tools/diag_keys.py` | 诊断键盘瞬态在混合信号里到底有多突出 |
| `tools/diag_oracle.py` | 验证「混合 = 语音 + 键盘」前提，并量出各方案对分量的真实作用 |
| `tools/diag_scale.py` | 判断输出是否只是「整体变了音量」 |
| `tools/probe_model.py` | 对齐延迟后的 SI-SDR / 相关系数（含干净语音身份测试） |
| `tools/probe_frames.py` | 绕过封装直接按帧喂，隔离封装层嫌疑 |
| `tools/real_speech_check.py` | **用真人语音判定模型能否工作**（当前阻塞点） |
| `tools/fetch_model.py` | 带断点续传与 sha256 校验的权重下载器 |
| `tools/tune_transient.py` | 瞬态门限的参数搜索（含语音损失预算） |
| `tools/tune_bandsplit.py` | 分频处理的参数搜索（结论：无效） |
| `tools/diag_vad.py` | 内部语音检测器的准度自检（真人语音上曾只有 82% 召回） |
| `tools/diag_transient.py` | 瞬态检测器的触发率与精确率（真人语音上曾 54% 误触发） |
| `tools/dump_states.py` | 导出 Python 侧状态演化，用于与 JS 对齐 |
| `js/dfn-stream.mjs` | **DFN3 流式推理的 JS 实现**（浏览器移植的基础） |
| `js/bench.mjs` | JS 侧质量 + 实时率基准 |
| `js/bench-breakdown.mjs` | 单帧开销分解（推理 / 状态拷贝 / 张量构造） |
| `js/test-threaded.mjs` | **线程架构全链路验证**（环形缓冲 + worker，r=1.000000） |
| `js/check-threading-overhead.mjs` | 线程化开销核验（调度 + 缓冲占比） |
| `js/dump-states.mjs` | 导出 JS 侧状态演化（与 Python 逐帧对比用） |
| `make_real_samples.py` | 生成「真人语音 + 合成键盘」样本（当前评测基准） |

## 前后端共用模块（不在评测台里）

| 文件 | 作用 |
|---|---|
| `client/dfn3/ring-buffer.mjs` | 单生产者单消费者环形缓冲（SharedArrayBuffer + Atomics，无锁） |
| `client/dfn3/inference-worker.mjs` | DFN3 推理线程（Node `worker_threads` 与浏览器 `Worker` 共用） |

## 已量到的两个事实（后续决策的地基）

1. **门限方案在原理上无效**（`evaluate.py` + `calibrate.py`）：
   默认 −45dBFS 阈值下，键盘事件在检测带内是 −22~−34dBFS，
   **6/6 个用例上门都会为键盘打开** → 键压低 0.0dB。
   收紧到 −20dBFS 时键盘被压掉了，但语音同时被压掉 165dB（全静音）。
   → 结论：这不是调参问题，能量判据无法区分瞬态键盘与语音。

2. **键盘瞬态本身是清晰可分的**（`tools/diag_keys.py`）：
   在 6–16kHz 上，按键相对安静底噪抬高 **+20~25dB**，
   **0% 的按键抬高不足 3dB** —— 也就是说信息一直在，
   缺的不是信息，而是一个「知道该保留什么」的模型。
   → 这也是自动标注能达到 100% 召回的原因。

## 接入一个新处理器

只要实现一个 `process(mixed, sr) -> out`，就能进来对比 —— 不需要改评测逻辑。
在 `models.py` 里加类，然后在 `register_optional()` 里注册。

**关键**：离线评测用的 ONNX 图与将来放进浏览器 worklet 的**是同一个**。
这里的结论可以直接指导浏览器端的取舍，不必先写 JS。

## 合成样本的局限（必须知道）

- 语音是**共振峰谐波合成的**，不是真人录音：它能代表"谐波结构 + 音节起伏"这类
  关键特征，但不含真实语音的全部细节。因此**结论要看相对排序，不要看绝对值**。
- 键盘是**参数化瞬态合成**的：快起振 + 衰减振铃 + 2–6kHz 能量，接近机械轴，
  但不等于你的具体键盘。

所以流程是：**先用它筛掉不行的方案，再用你的真实录音做最终判定**。
真实录音进来时，把 WAV 放进 `samples/` 并补一条 manifest 记录即可复用同一套指标。
