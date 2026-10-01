using System.IO.Compression;
using System.Text;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace CfTeamspeed.Desktop.Services.Audio.Dsp;

// ============================================================
//  DeepFilterNet3 推理封装
//
//  模型来源：https://github.com/Rikorose/DeepFilterNet （MIT / Apache-2.0 双许可）
//  ONNX 导出与初始状态：https://github.com/wuxuedaifu/deepfilter-stream
//    （release tag: model-dfn3-512-v1，带 sha256 校验）
//
//  ★ 模型文件刻意【不】进仓库（13MB 二进制、可再生成）：
//    查找顺序见 ResolveModelPath()。
//
//  ★ 精确契约（照抄参考实现，别凭直觉改）：
//    输入 13 个：
//      input_frame                    float32[512]              ← 每帧音频
//      erb_norm_state                 float32[32]
//      band_unit_norm_state           float32[1,96,1]
//      analysis_mem                   float32[512]
//      synthesis_mem                  float32[512]
//      rolling_erb_buf                float32[1,1,3,32]
//      rolling_feat_spec_buf          float32[1,2,3,96]
//      rolling_c0_buf                 float32[1,64,5,96]
//      rolling_spec_buf_x             float32[5,513,2]
//      rolling_spec_buf_y             float32[7,513,2]
//      enc_hidden                     float32[1,1,256]
//      erb_dec_hidden                 float32[2,1,256]
//      df_dec_hidden                  float32[2,1,256]
//
//    输出 13 个：
//      enhanced_audio_frame           float32[512]              ← 降噪结果
//      new_* × 12                                                ← 下一帧的状态
//
//    状态必须【跨帧保持】—— 这正是它能流式降噪、而不是每帧独立处理的原因。
//    状态名映射规律：输入是 X，输出就是 new_X，按顺序一一对应。
//
//  ★ 初始状态不是全零！
//    必须从 initial_states.npz 读（滚动缓冲有非零初值）。
//    用全零初始化会让前若干帧出现可听的杂音 —— 这也是为什么
//    这个类要显式加载 npz，而不是「new 一个零张量」了事。
// ============================================================

/// <summary>
/// DeepFilterNet3 的 ONNX 会话。
///
/// 线程模型：<b>非线程安全</b>。状态跨帧可变，必须一个实例一个线程。
/// </summary>
internal sealed class Dfn3Model : IDisposable
{
    /// <summary>音频帧长（48kHz）。</summary>
    public const int FrameSize = 512;

    private readonly InferenceSession _session;

    /// <summary>输入名（第 0 个是 input_frame，其余是状态）。</summary>
    private readonly string[] _inputNames;

    /// <summary>输出名（第 0 个是增强音频，其余是 new_* 状态）。</summary>
    private readonly string[] _outputNames;

    /// <summary>初始状态（从 npz 读一次，之后每帧复用副本）。</summary>
    private readonly Dictionary<string, float[]> _initialState = new(StringComparer.Ordinal);

    /// <summary>状态形状（按输入名索引），用于重建张量。</summary>
    private readonly Dictionary<string, int[]> _stateShapes = new(StringComparer.Ordinal);

    /// <summary>当前帧的输入张量（复用，避免每帧分配）。</summary>
    private readonly DenseTensor<float> _inputTensor = new(new[] { FrameSize });

    /// <summary>跨帧状态：名字 → 当前值。</summary>
    private readonly Dictionary<string, float[]> _state = new(StringComparer.Ordinal);

    public Dfn3Model(string modelPath, string initialStatePath)
    {
        var options = new SessionOptions
        {
            // 硬实时场景：单帧推理本来只有几毫秒，线程开多了反而互相抢、
            // 还会增加调度抖动（听感上是随机爆音）。
            IntraOpNumThreads = 1,
            InterOpNumThreads = 1,
            GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL,
        };

        _session = new InferenceSession(modelPath, options);

        _inputNames = _session.InputMetadata.Keys.ToArray();
        _outputNames = _session.OutputMetadata.Keys.ToArray();

        ValidateContract();
        LoadInitialStates(initialStatePath);
        ResetState();
    }

    /// <summary>模型文件所在目录的解析（返回 null 表示没找到）。</summary>
    public static string? ResolveModelDirectory()
    {
        // 1) 环境变量优先（测试 / 便携部署）
        var fromEnv = Environment.GetEnvironmentVariable("CFTEAMSPEED_DFN_MODEL_DIR");
        if (!string.IsNullOrWhiteSpace(fromEnv) && Directory.Exists(fromEnv)) return fromEnv;

        // 2) 应用目录下的 models/（随发布一起拷贝）
        var local = Path.Combine(AppContext.BaseDirectory, "models");
        if (File.Exists(Path.Combine(local, "denoiser_model.onnx"))) return local;

        // 3) 数据目录（用户自己放）
        try
        {
            var data = Path.Combine(AppPaths.DataDirectory, "models");
            if (File.Exists(Path.Combine(data, "denoiser_model.onnx"))) return data;
        }
        catch
        {
            // 数据目录取不到时继续
        }

        return null;
    }

    /// <summary>校验模型的输入输出个数是否与预期契约一致。</summary>
    private void ValidateContract()
    {
        // 13 进 13 出。数量不对说明模型文件不对，早报错好过在通话中炸。
        if (_inputNames.Length != 13 || _outputNames.Length != 13)
        {
            throw new InvalidDataException(
                $"降噪模型契约不符：期望 13 路输入 / 13 路输出，" +
                $"实际 {_inputNames.Length} / {_outputNames.Length}。模型文件可能不对。");
        }

        if (_inputNames[0] != "input_frame")
        {
            throw new InvalidDataException(
                $"降噪模型第 0 路输入应为 input_frame，实际是 {_inputNames[0]}。");
        }
    }

    /// <summary>
    /// 从 initial_states.npz 读取初值。
    ///
    /// .npz 本质是个 zip，里面每个成员是一个 .npy。这里手工解析 .npy
    /// 头部拿 dtype/形状 —— 只为读几十个 float 而引入 Python 或
    /// 第三方数组库不划算。
    /// </summary>
    private void LoadInitialStates(string npzPath)
    {
        using var zip = ZipFile.OpenRead(npzPath);

        for (var i = 1; i < _inputNames.Length; i++)
        {
            var name = _inputNames[i];

            var entry = zip.GetEntry(name + ".npy")
                ?? throw new InvalidDataException($"initial_states.npz 缺少 {name}.npy");

            using var stream = entry.Open();
            var (shape, data) = ReadNpy(stream);

            _initialState[name] = data;
            _stateShapes[name] = shape;
        }
    }

    /// <summary>解析单个 .npy（只支持 float32、C 顺序、无结构化 dtype）。</summary>
    private static (int[] Shape, float[] Data) ReadNpy(Stream stream)
    {
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        var bytes = ms.ToArray();

        // magic: \x93NUMPY, 版本 2 字节，之后 2 字节小端 header 长度
        if (bytes.Length < 10 || bytes[0] != 0x93 || Encoding.ASCII.GetString(bytes, 1, 5) != "NUMPY")
        {
            throw new InvalidDataException("不是合法的 .npy 文件");
        }

        var headerLen = BitConverter.ToUInt16(bytes, 8);
        var header = Encoding.ASCII.GetString(bytes, 10, headerLen);

        if (!header.Contains("<f4"))
        {
            throw new InvalidDataException($".npy 的 dtype 不是 float32：{header.Trim()}");
        }

        // shape: (32,) / (1, 1, 3, 32) …
        var start = header.IndexOf('(');
        var end = header.IndexOf(')', start);
        var shapeText = header.Substring(start + 1, end - start - 1);

        var shape = shapeText
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(int.Parse)
            .ToArray();

        var count = shape.Length == 0 ? 1 : shape.Aggregate(1, (a, b) => a * b);
        var dataStart = 10 + headerLen;
        var data = new float[count];

        for (var i = 0; i < count; i++)
        {
            data[i] = BitConverter.ToSingle(bytes, dataStart + i * 4);
        }

        return (shape, data);
    }

    /// <summary>把状态重置回初值（换设备 / 重新进房时调用）。</summary>
    public void ResetState()
    {
        foreach (var (name, values) in _initialState)
        {
            _state[name] = (float[])values.Clone();
        }
    }

    /// <summary>处理一帧（原地修改）。输入必须是 512 样点 @48kHz。</summary>
    public void Process(Span<float> frame)
    {
        if (frame.Length != FrameSize) return;

        for (var i = 0; i < FrameSize; i++) _inputTensor[i] = frame[i];

        var feeds = new List<NamedOnnxValue>(_inputNames.Length)
        {
            NamedOnnxValue.CreateFromTensor(_inputNames[0], _inputTensor),
        };

        // 状态按输入顺序喂进去
        for (var i = 1; i < _inputNames.Length; i++)
        {
            var name = _inputNames[i];
            var shape = _stateShapes[name];
            var values = _state[name];

            var tensor = new DenseTensor<float>(shape);
            values.AsSpan().CopyTo(tensor.Buffer.Span);
            feeds.Add(NamedOnnxValue.CreateFromTensor(name, tensor));
        }

        using var results = _session.Run(feeds);

        // 输出 0 = 增强后的音频
        var enhanced = results[0].AsTensor<float>();
        for (var i = 0; i < FrameSize; i++) frame[i] = enhanced.GetValue(i);

        // 输出 1..N 回写为下一帧的状态。
        // 契约：输出顺序与输入顺序一一对应（输入 X → 输出 new_X）。
        for (var i = 1; i < _outputNames.Length && i < _inputNames.Length; i++)
        {
            var name = _inputNames[i];
            var incoming = results[i].AsTensor<float>();

            var buffer = _state[name];
            var count = Math.Min(buffer.Length, (int)incoming.Length);
            for (var j = 0; j < count; j++) buffer[j] = incoming.GetValue(j);
        }
    }

    public void Dispose() => _session.Dispose();
}
