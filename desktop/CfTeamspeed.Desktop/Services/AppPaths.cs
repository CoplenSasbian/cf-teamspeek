using System.Text.Json;

namespace CfTeamspeed.Desktop.Services;

// ============================================================
//  本地文件路径与原子写
//
//  所有本地状态（servers.json / settings.json）都走同一套落盘逻辑：
//  先写同目录的临时文件，再 Replace/Move 到目标位置。
//
//  为什么必须原子：这些文件在运行期被高频改写（token 滚动续期每几分钟一次），
//  直接 File.WriteAllText 一旦在写一半时崩溃/断电，档案就成了半截 JSON，
//  下次启动直接解析失败。原子替换保证「要么是旧内容，要么是新内容」。
// ============================================================

/// <summary>应用数据目录与原子 JSON 落盘工具。</summary>
public static class AppPaths
{
    private const string AppFolderName = "CfTeamspeed";

    /// <summary>
    /// 应用数据目录：优先 %LOCALAPPDATA%\CfTeamspeed。
    ///
    /// 依次尝试三个位置，取第一个**确实能写**的：
    ///   1. %LOCALAPPDATA%\CfTeamspeed  —— 正常情况
    ///   2. 环境变量 CFTEAMSPEED_DATA_DIR —— 便于测试与便携部署
    ///   3. <应用目录>\data            —— 上面都不可写时的兜底
    ///
    /// 为什么必须逐个「试写」而不是只判目录是否存在：
    /// 受限账户 / 被沙箱管控的环境里，目录可能存在但没有写权限，
    /// 这时如果直接返回它，后面所有落盘都会失败 —— 表现为
    /// 「设置改了不生效」「每次启动都要重新登录」这类难查的问题。
    /// </summary>
    public static string DataDirectory
    {
        get
        {
            if (_dataDirectory is not null) return _dataDirectory;

            foreach (var candidate in EnumerateCandidates())
            {
                if (TryPrepare(candidate))
                {
                    _dataDirectory = candidate;
                    return candidate;
                }
            }

            // 全都不行：仍然返回首选路径（后续写入会失败，但至少行为可预测）
            _dataDirectory = PreferredDirectory();
            return _dataDirectory;
        }
    }

    /// <summary>已解析的数据目录（进程内缓存，避免每次访问都做一次试写）。</summary>
    private static string? _dataDirectory;

    private static IEnumerable<string> EnumerateCandidates()
    {
        yield return PreferredDirectory();

        var custom = Environment.GetEnvironmentVariable("CFTEAMSPEED_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(custom)) yield return custom;

        yield return Path.Combine(AppContext.BaseDirectory, "data");
    }

    private static string PreferredDirectory()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        // 极端情况下（服务账户 / 精简环境）拿不到 LOCALAPPDATA
        if (string.IsNullOrWhiteSpace(root))
        {
            root = Path.Combine(AppContext.BaseDirectory, "data");
            return root;
        }

        return Path.Combine(root, AppFolderName);
    }

    /// <summary>建目录并试写一个小文件，确认真的可写。</summary>
    private static bool TryPrepare(string directory)
    {
        try
        {
            Directory.CreateDirectory(directory);

            var probe = Path.Combine(directory, ".write-probe");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch (Exception ex) when (ex is IOException
                                      or UnauthorizedAccessException
                                      or NotSupportedException
                                      or ArgumentException)
        {
            return false;
        }
    }

    /// <summary>
    /// 数据目录当前是否可写（界面可据此提示「设置无法保存」）。
    /// </summary>
    public static bool IsWritable => TryPrepare(DataDirectory);

    /// <summary>拼一个数据目录下的完整路径。</summary>
    public static string Combine(string fileName) => Path.Combine(DataDirectory, fileName);

    /// <summary>
    /// 原子写入 JSON。
    ///
    /// 步骤：写 &lt;file&gt;.tmp → File.Replace（保留旧文件为备份）；Replace 不可用时退回 Move。
    /// 注意 Replace 要求目标已存在，因此首次写入走的必然是 Move 分支。
    /// </summary>
    public static async Task WriteJsonAtomicAsync<T>(
        string filePath,
        T value,
        JsonSerializerOptions options,
        CancellationToken ct = default)
    {
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var json = JsonSerializer.Serialize(value, options);

        // 临时文件必须与目标同目录：跨卷 Move 不是原子操作，会退化成复制
        var tempPath = filePath + ".tmp";
        await File.WriteAllTextAsync(tempPath, json, ct).ConfigureAwait(false);

        try
        {
            if (File.Exists(filePath))
            {
                // 第三个参数传 null = 不做备份文件，临时文件被消耗掉
                File.Replace(tempPath, filePath, destinationBackupFileName: null);
            }
            else
            {
                File.Move(tempPath, filePath);
            }
        }
        catch (Exception ex) when (IsRecoverableReplaceFailure(ex))
        {
            // 少见情况：另一进程 / 杀软 / 同步盘短暂占用目标文件（实测会抛
            // UnauthorizedAccessException 而不只是 IOException）。
            // 退回「尽力而为」的直接覆盖：这次续期结果比原子性更重要，
            // 最坏情况是极小概率的文件截断，而 ServerStore 对损坏文件已有兜底。
            TryFallbackMove(tempPath, filePath);
        }
    }

    /// <summary>
    /// File.Replace 可能失败的那几类异常。
    ///
    /// 注意必须包含 <see cref="UnauthorizedAccessException"/>：目标文件被占用时
    /// Windows 常常报的是「拒绝访问」而不是 IOException，只捕 IOException 会让
    /// 每次 token 续期都抛出异常、直接冒到界面。
    /// </summary>
    private static bool IsRecoverableReplaceFailure(Exception ex) =>
        ex is IOException
            or UnauthorizedAccessException
            or PlatformNotSupportedException
            or NotSupportedException;

    private static void TryFallbackMove(string tempPath, string filePath)
    {
        try
        {
            File.Move(tempPath, filePath, overwrite: true);
        }
        catch (Exception ex) when (IsRecoverableReplaceFailure(ex))
        {
            // 连覆盖都失败（磁盘满 / 只读 / 被独占锁定）：清理临时文件后静默放弃。
            // 本地偏好写不进去不该让业务请求失败 —— 内存里的状态仍然是对的。
            TryDelete(tempPath);
            return;
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 残留一个 .tmp 文件无关紧要，下次写入会覆盖它
        }
    }

    /// <summary>
    /// 读取 JSON；文件不存在、为空、损坏时统一返回 null（由调用方给默认值），
    /// 损坏的文件会被改名备份而不是被删掉。
    /// </summary>
    public static async Task<T?> ReadJsonOrNullAsync<T>(
        string filePath,
        JsonSerializerOptions options,
        CancellationToken ct = default)
        where T : class
    {
        try
        {
            if (!File.Exists(filePath)) return null;

            var json = await File.ReadAllTextAsync(filePath, ct).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(json)) return null;

            return JsonSerializer.Deserialize<T>(json, options);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            BackupCorruptFile(filePath);
            return null;
        }
    }

    /// <summary>把损坏的文件改名备份（不删除，方便事后排查）。</summary>
    public static void BackupCorruptFile(string filePath)
    {
        try
        {
            if (!File.Exists(filePath)) return;
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            File.Move(filePath, $"{filePath}.corrupt-{stamp}", overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 备份失败也没有别的办法，绝不能因此抛出
        }
    }
}
