using System;
using System.IO;
using CfTeamspeed.Desktop.Services.Audio;
using CfTeamspeed.Desktop.Services.Audio.Dsp;

// ============================================================
//  降噪正确性自检（--denoise-selftest）
//
//  为什么必须做这个：前一个自检只能证明「模型加载了、推理跑完了」，
//  但**推理跑完 ≠ 输出正确**。一个把音频喂错形状、状态没接上、
//  或根本没做变换的实现，照样能「成功跑完 140 帧」。
//
//  做法：拿官方参考实现的测试样本（noisy_2s_48k.wav）过本项目的 C# 链路，
//  再与官方参考输出（reference_2s_48k.wav）逐样点对比。
//  两者都来自同一个模型 + 同一份初始状态，因此应当高度一致；
//  差异大就说明我们的状态传递或帧对齐写错了。
// ============================================================

internal static class DenoiseSelfTest
{
    public static int Run(string[] args)
    {
        Console.WriteLine("=== 降噪正确性自检（对照官方参考输出）===");
        Console.WriteLine();

        var modelDir = Dfn3Model.ResolveModelDirectory();
        Console.WriteLine($"[1] 模型目录：{modelDir ?? "(未找到)"}");
        if (modelDir is null)
        {
            Console.WriteLine("    FAIL：找不到模型目录，无法继续。");
            return 2;
        }

        // 测试样本放在模型目录下（随构建拷贝）
        var noisyPath = Path.Combine(modelDir, "test-noisy.wav");
        var refPath = Path.Combine(modelDir, "test-reference.wav");

        if (!File.Exists(noisyPath) || !File.Exists(refPath))
        {
            Console.WriteLine("    FAIL：缺少测试样本（test-noisy.wav / test-reference.wav）。");
            return 2;
        }

        var noisy = ReadWavMono16(noisyPath);
        var reference = ReadWavMono16(refPath);

        Console.WriteLine($"[2] 输入 {noisy.Length} 样点，参考输出 {reference.Length} 样点");

        // ---- 用本项目链路处理 ----
        //
        // ★ 对齐协议（照抄官方参考实现，别凭直觉改）：
        //   1) 尾部补零补到「帧长整数倍 + fft 长度」，其中 fft = 2 × frame；
        //   2) 全部帧跑完后，丢掉开头 d = fft - frame = frame 个样点
        //      —— 这 d 个样点就是算法的固有延迟。
        //
        //   不做这两步的话，输出与参考会整体错位 512 样点，
        //   表现为波形对不上（相关系数很低），而不是听起来坏掉。
        const int frameSize = DenoiseProcessor.FrameSize;
        const int fftSize = frameSize * 2;

        var orig = noisy.Length;
        var padDiv = (frameSize - orig % frameSize) % frameSize;
        var origPadded = orig + padDiv;

        // 输入末尾补 fftSize + padDiv 个零
        var padded = new float[origPadded + fftSize];
        Array.Copy(noisy, padded, orig);

        using var model = new Dfn3Model(
            Path.Combine(modelDir, "denoiser_model.onnx"),
            Path.Combine(modelDir, "initial_states.npz"));

        var frame = new float[frameSize];
        var framesProcessed = padded.Length / frameSize;
        var raw = new float[framesProcessed * frameSize];

        for (var k = 0; k < framesProcessed; k++)
        {
            Array.Copy(padded, k * frameSize, frame, 0, frameSize);
            model.Process(frame);
            Array.Copy(frame, 0, raw, k * frameSize, frameSize);
        }

        // 丢掉开头 d = fftSize - frameSize 个样点，再取 origPadded 长度
        const int delay = fftSize - frameSize;
        var output = new float[origPadded];
        Array.Copy(raw, delay, output, 0, origPadded);

        var compareCount = Math.Min(output.Length, reference.Length);

        Console.WriteLine($"[3] 已处理 {framesProcessed} 帧，对齐后取 {compareCount} 样点");

        // ---- 与参考输出对比 ----
        // 指标 1：相对误差（整体幅度是否对得上）
        double signalEnergy = 0, errorEnergy = 0;
        for (var i = 0; i < compareCount; i++)
        {
            signalEnergy += reference[i] * (double)reference[i];
            var diff = output[i] - reference[i];
            errorEnergy += diff * diff;
        }

        var nmse = signalEnergy > 0 ? errorEnergy / signalEnergy : double.PositiveInfinity;
        var correlation = Correlation(output, reference, compareCount);

        Console.WriteLine();
        Console.WriteLine("[4] 与官方参考输出的差异");
        Console.WriteLine($"    归一化均方误差 NMSE = {nmse:E3}   （越小越好，<0.01 可认为一致）");
        Console.WriteLine($"    皮尔逊相关系数 r    = {correlation:F6}  （越接近 1 越好）");

        // ---- 指标 3：降噪是否真的起作用（对比输入/输出的残余能量）----
        // 只在两者都存在的区间上比 —— 输出比输入长（含尾部补零段），
        // 直接用 compareCount 会越界。
        var energyCount = Math.Min(compareCount, noisy.Length);
        double inputEnergy = 0, outputEnergy = 0;
        for (var i = 0; i < energyCount; i++)
        {
            inputEnergy += noisy[i] * (double)noisy[i];
            outputEnergy += output[i] * (double)output[i];
        }

        var reductionDb = inputEnergy > 0 && outputEnergy > 0
            ? 10.0 * Math.Log10(inputEnergy / outputEnergy)
            : 0;

        Console.WriteLine();
        Console.WriteLine("[5] 降噪强度（输入能量 vs 输出能量）");
        Console.WriteLine($"    输入 RMS = {Math.Sqrt(inputEnergy / energyCount):F6}");
        Console.WriteLine($"    输出 RMS = {Math.Sqrt(outputEnergy / energyCount):F6}");
        Console.WriteLine($"    能量差   = {reductionDb:F2} dB");

        // ---- 结论 ----
        var passed = correlation > 0.9 && nmse < 0.05;
        Console.WriteLine();
        Console.WriteLine(passed
            ? "=== 通过：输出与官方参考高度一致，状态传递与帧对齐正确 ==="
            : "=== 失败：输出与参考不一致，需检查状态传递 / 帧对齐 ===");

        return passed ? 0 : 1;
    }

    /// <summary>皮尔逊相关系数（衡量波形形状是否一致）。</summary>
    private static double Correlation(float[] a, float[] b, int length)
    {
        double ma = 0, mb = 0;
        for (var i = 0; i < length; i++) { ma += a[i]; mb += b[i]; }
        ma /= length; mb /= length;

        double num = 0, da = 0, db = 0;
        for (var i = 0; i < length; i++)
        {
            var x = a[i] - ma;
            var y = b[i] - mb;
            num += x * y;
            da += x * x;
            db += y * y;
        }

        var denom = Math.Sqrt(da * db);
        return denom > 0 ? num / denom : 0;
    }

    /// <summary>读 16-bit PCM 单声道 WAV（跳过头部，按 data chunk 定位）。</summary>
    private static float[] ReadWavMono16(string path)
    {
        var bytes = File.ReadAllBytes(path);

        // 从头遍历 chunk，找到 data
        var pos = 12; // 跳过 RIFF/WAVE 头
        int dataOffset = -1, dataLength = 0;
        int channels = 1, bitsPerSample = 16;

        while (pos + 8 <= bytes.Length)
        {
            var id = System.Text.Encoding.ASCII.GetString(bytes, pos, 4);
            var size = BitConverter.ToInt32(bytes, pos + 4);

            if (id == "fmt ")
            {
                channels = BitConverter.ToInt16(bytes, pos + 10);
                bitsPerSample = BitConverter.ToInt16(bytes, pos + 22);
            }
            else if (id == "data")
            {
                dataOffset = pos + 8;
                dataLength = Math.Min(size, bytes.Length - dataOffset);
                break;
            }

            pos += 8 + size + (size % 2);
        }

        if (dataOffset < 0)
        {
            throw new InvalidDataException($"WAV 里找不到 data chunk：{path}");
        }

        if (bitsPerSample != 16 || channels != 1)
        {
            throw new InvalidDataException(
                $"测试样本需要 16-bit 单声道，实际 {bitsPerSample}-bit / {channels}ch");
        }

        var count = dataLength / 2;
        var samples = new float[count];
        for (var i = 0; i < count; i++)
        {
            samples[i] = BitConverter.ToInt16(bytes, dataOffset + i * 2) / 32768f;
        }

        return samples;
    }
}
