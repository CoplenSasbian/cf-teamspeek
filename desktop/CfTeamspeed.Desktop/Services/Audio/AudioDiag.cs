namespace CfTeamspeed.Desktop.Services.Audio;

// ============================================================
//  音频链路诊断日志
//
//  为什么需要它（实测踩到）：
//    SFU 协商失败时，客户端异常里只有一句
//    「SFU PUT /sessions/{id}/renegotiate failed」，
//    真正的原因（例如 "SDP contains no ice-ufrag"）在服务端透传的
//    detail 里，而 SDP 本身长什么样只能靠日志。
//    没有这层日志，这类问题只能靠猜。
//
//  输出：数据目录下 audio.log（与问题发生的位置、时刻对应）
//  注意：只记长度与关键标记，**不记完整 SDP** —— SDP 里有 ICE 凭据
//        （ice-ufrag / ice-pwd），属于连接期凭据，不该长期落盘。
// ============================================================

internal static class AudioDiag
{
    private static readonly object Gate = new();

    /// <summary>是否启用（默认开；排查完可以把文件删掉，不影响运行）。</summary>
    public static bool Enabled { get; set; } = true;

    public static void Write(string message)
    {
        if (!Enabled) return;

        try
        {
            var line = $"{DateTimeOffset.Now:HH:mm:ss.fff} {message}{Environment.NewLine}";

            lock (Gate)
            {
                File.AppendAllText(AppPaths.Combine("audio.log"), line);
            }
        }
        catch
        {
            // 日志失败绝不影响音频链路
        }
    }
}
