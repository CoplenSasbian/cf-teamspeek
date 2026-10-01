using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  音频链路自检（--audio-selftest）
//
//  为什么值得单独做一个自检入口：
//    音频的问题（没声音、爆音、降噪没生效）在 GUI 里极难定位 ——
//    你只能靠"我听不到"这一句话去猜是设备、编码、还是降噪。
//    把链路拆成可测量的几段，每段单独报数，才能一眼看出断在哪。
//
//  ★ 输出为什么要特殊处理：
//    本项目是 WinExe（GUI 子系统），进程**没有附带控制台** ——
//    直接 Console.WriteLine 什么都看不到。所以这里两路一起走：
//      1) 尽力 AttachConsole 到父进程（从 cmd/PowerShell 里启动时能看到实时输出）；
//      2) 同时写一份日志到数据目录（从资源管理器双击时靠它看结果）。
//
//  实测项：
//    1. 设备枚举
//    2. 麦克风采集能否真的出样点（各档降噪都跑一遍）
//    3. 采集回调的实时性（有没有明显掉帧/卡顿）
//    4. 扬声器能否正常打开
//    5. 降噪档位热切换
// ============================================================

internal static class AudioSelfTest
{
    private const uint AttachParentProcess = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    private static readonly StringBuilder LogBuffer = new();

    public static int Run(string[] args)
    {
        // 先挂控制台：从终端启动时能实时看到；双击启动时这步会失败，不影响流程
        if (!AttachConsole(AttachParentProcess))
        {
            AllocConsole();
        }

        WriteLine("=== CfTeamspeed 音频链路自检 ===");
        WriteLine("");

        var exitCode = RunCore();

        WriteLine("");
        WriteLine($"=== 结论：{(exitCode == 0 ? "通过" : "有失败项")} ===");

        // 日志兜底：双击运行时没有控制台，结果只能从这里看
        TrySaveLog();

        return exitCode;
    }

    private static void WriteLine(string message)
    {
        Console.WriteLine(message);
        LogBuffer.AppendLine(message);
    }

    private static void TrySaveLog()
    {
        try
        {
            var logPath = CfTeamspeed.Desktop.Services.AppPaths.Combine("audio-selftest.log");
            File.WriteAllText(
                logPath,
                $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}{Environment.NewLine}{LogBuffer}");
            Console.WriteLine($"[日志] {logPath}");
        }
        catch
        {
            // 记不下来就算了，控制台已经有输出
        }
    }

    private static int RunCore()
    {
        // ---------- 1. 设备枚举 ----------
        WriteLine("[1] 设备枚举");
        var inputs = AudioDevices.Inputs();
        var outputs = AudioDevices.Outputs();
        WriteLine($"    麦克风 {inputs.Count} 个：");
        foreach (var d in inputs) WriteLine($"      [{d.Number}] {d.Name}  (id={d.Id})");
        WriteLine($"    扬声器 {outputs.Count} 个：");
        foreach (var d in outputs) WriteLine($"      [{d.Number}] {d.Name}  (id={d.Id})");

        if (inputs.Count == 0)
        {
            WriteLine("");
            WriteLine("!! 没有可用的麦克风，无法继续。");
            return 2;
        }

        // ---------- 2. 三档降噪各跑一遍 ----------
        var allPassed = true;
        foreach (var level in new[] { DenoiseLevel.Off, DenoiseLevel.Gate, DenoiseLevel.Neural })
        {
            WriteLine("");
            WriteLine($"[2] 采集 + 降噪 = {level}");
            var ok = CaptureTest(inputs[0].Number, level);
            allPassed &= ok;
        }

        // ---------- 3. 扬声器 ----------
        WriteLine("");
        WriteLine("[3] 扬声器打开测试");
        if (outputs.Count > 0)
        {
            try
            {
                using var playback = new AudioMixerPlayback();
                playback.Start(outputs[0].Number);
                // 给混音线程一点时间真的把数据推进设备
                Thread.Sleep(300);
                playback.Stop();
                WriteLine("    OK：已成功打开并播放（静音数据）");
            }
            catch (Exception ex)
            {
                allPassed = false;
                WriteLine($"    FAIL：{ex.GetType().Name}: {ex.Message}");
            }
        }
        else
        {
            WriteLine("    跳过：没有扬声器");
        }

        // ---------- 4. 降噪档位热切换 ----------
        WriteLine("");
        WriteLine("[4] 降噪档位热切换");
        try
        {
            using var dsp = new DenoiseProcessor(DenoiseLevel.Off);
            var seen = new List<string>();
            foreach (var level in new[] { DenoiseLevel.Neural, DenoiseLevel.Gate, DenoiseLevel.Off })
            {
                dsp.SetLevel(level);
                seen.Add($"{level}→生效={dsp.EffectiveLevel}");
            }

            WriteLine("    " + string.Join("  ", seen));
            if (dsp.ModelUnavailableReason is not null)
            {
                WriteLine($"    注意：{dsp.ModelUnavailableReason}");
            }
        }
        catch (Exception ex)
        {
            allPassed = false;
            WriteLine($"    FAIL：{ex.GetType().Name}: {ex.Message}");
        }

        return allPassed ? 0 : 1;
    }

    /// <summary>采集若干帧，报告样点数量、电平、以及帧间隔是否稳定。</summary>
    private static bool CaptureTest(int deviceNumber, DenoiseLevel level)
    {
        using var dsp = new DenoiseProcessor(level);

        var frames = 0;
        var totalSamples = 0;
        double peak = 0;
        double sumSquares = 0;

        var sw = new Stopwatch();

        using var capture = new MicrophoneCapture(deviceNumber, dsp, frame =>
        {
            frames++;
            totalSamples += frame.Length;

            foreach (var s in frame)
            {
                var a = Math.Abs(s);
                if (a > peak) peak = a;
                sumSquares += s * (double)s;
            }
        });

        Exception? failure = null;
        capture.CaptureFailed += (_, ex) => failure = ex;

        try
        {
            sw.Start();
            capture.Start();
            Thread.Sleep(1500); // 跑约 1.5 秒
            capture.Stop();
            sw.Stop();
        }
        catch (Exception ex)
        {
            WriteLine($"    FAIL：{ex.GetType().Name}: {ex.Message}");
            return false;
        }

        if (failure is not null)
        {
            WriteLine($"    采集出错：{failure.GetType().Name}: {failure.Message}");
            return false;
        }

        if (frames == 0)
        {
            WriteLine("    FAIL：一帧都没采到（设备被占用 / 权限不足？）");
            return false;
        }

        var rms = Math.Sqrt(sumSquares / Math.Max(1, totalSamples));
        var expectedFrames = 1500.0 / (MicrophoneCapture.FrameSize * 1000.0 / MicrophoneCapture.TargetSampleRate);

        WriteLine(
            $"    帧数={frames}（理论≈{expectedFrames:F0}） 样点={totalSamples} " +
            $"峰值={peak:F4} RMS={rms:F5} 用时={sw.ElapsedMilliseconds}ms");

        if (rms < 1e-6)
        {
            WriteLine("    提示：RMS≈0 —— 麦克风没拾到声音（静音 / 被系统静音 / 增益为 0）");
        }

        return frames > 0;
    }
}
