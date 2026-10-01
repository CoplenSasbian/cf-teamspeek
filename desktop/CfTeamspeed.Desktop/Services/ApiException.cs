using CfTeamspeed.Desktop.Models;

namespace CfTeamspeed.Desktop.Services;

/// <summary>
/// API 调用失败。
///
/// 区分「错误码」与「HTTP 状态」两件事：
///   - <see cref="Code"/> 是稳定契约（ErrorCodes.*），分支判断只认它；
///   - <see cref="HttpStatus"/> 用于区分「服务端说不」与「压根没连上」（0）。
/// <see cref="Message"/> 是可直接展示的中文文案，但可能随版本变化，不要拿它做判断。
/// </summary>
public sealed class ApiException : Exception
{
    public ApiException(string message, string? code = null, int httpStatus = 0, Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
        HttpStatus = httpStatus;
    }

    /// <summary>稳定错误码，见 <see cref="ErrorCodes"/>；网络层失败时为 null。</summary>
    public string? Code { get; }

    /// <summary>HTTP 状态码；0 表示请求根本没到服务端（DNS / 连接 / 取消）。</summary>
    public int HttpStatus { get; }

    /// <summary>请求被取消（用户切服务器、窗口关闭等），调用方通常应当静默忽略。</summary>
    public bool IsCanceled => HttpStatus == 0 && Code is null && InnerException is OperationCanceledException;

    /// <summary>
    /// 会话不可用，需要重新登录。只有 401 才算 ——
    /// 403（权限不足）不该把人踢下线。
    /// </summary>
    public bool IsAuthFailure => HttpStatus == 401;

    /// <summary>
    /// 会话超出绝对寿命：必须用 key 重新登录，而不是重试或续期。
    /// </summary>
    public bool IsSessionExpired =>
        string.Equals(Code, ErrorCodes.SessionExpired, StringComparison.Ordinal);

    /// <summary>已被移出服务器（封禁）：清理会话并给出明确提示。</summary>
    public bool IsBanned => string.Equals(Code, ErrorCodes.Banned, StringComparison.Ordinal);

    /// <summary>网络层失败（连不上 / 超时），与「服务端返回了错误」区分开，界面提示不同。</summary>
    public bool IsTransportFailure => HttpStatus == 0 && !IsCanceled;

    /// <summary>请求过于频繁：应当退避后重试，而不是弹错误框。</summary>
    public bool IsRateLimited => string.Equals(Code, ErrorCodes.RateLimited, StringComparison.Ordinal);

    /// <summary>WebSocket 票据失效/过期/已用：重新领一张即可。</summary>
    public bool IsBadTicket => string.Equals(Code, ErrorCodes.BadTicket, StringComparison.Ordinal);

    /// <summary>
    /// 服务端附带的原始详情（信封里的 <c>detail</c> 字段）。
    ///
    /// 为什么要留它：SFU 这类上游错误，服务端只把「SFU 调用失败」当 <c>error</c> 返回，
    /// 真正有用的信息（Cloudflare 的原话，比如 "sessionDescription is required"）
    /// 全在 <c>detail</c> 里。丢掉它就只能看到一句笼统的话，
    /// 排查时等于什么都没说 —— 实测就是靠它才定位到 renegotiate 的真实原因。
    /// </summary>
    public string? Detail { get; init; }

    /// <summary>构造「拿不到响应」的异常（网络层）。</summary>
    public static ApiException Transport(string message, Exception? inner = null)
        => new(message, code: null, httpStatus: 0, innerException: inner);

    /// <summary>构造「响应不是合法信封」的异常。</summary>
    public static ApiException Malformed(int status, Exception? inner = null)
        => new("服务器返回了无法解析的响应", code: null, httpStatus: status, innerException: inner);

    /// <summary>构造「服务端明确报错」的异常。</summary>
    public static ApiException FromEnvelope(string? error, string? code, int status, string? detail = null)
        => new(
            string.IsNullOrWhiteSpace(error) ? $"请求失败（{status}）" : error!,
            code,
            status)
        {
            Detail = detail,
        };

    /// <summary>带详情的一句话（用于日志与自检输出）。</summary>
    public string Describe() =>
        string.IsNullOrWhiteSpace(Detail) ? Message : $"{Message} —— 详情：{Detail}";
}
