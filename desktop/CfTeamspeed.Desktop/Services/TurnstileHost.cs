using System.Text.Json;
using System.Text.Json.Serialization;

namespace CfTeamspeed.Desktop.Services;

// ============================================================
//  Cloudflare Turnstile（人机验证）
//
//  为什么桌面端需要内嵌浏览器引擎：
//    Turnstile 的 token 由 Cloudflare 的 JS 在**真实浏览器环境**里跑出来，
//    服务端 siteverify 校验它。官方**没有** REST API、也没有原生 SDK ——
//    除了让一个浏览器引擎执行那段 JS，没有第二条路能拿到合法 token。
//
//  所以这里的 WebView2 用法是刻意收紧的：
//    · 只在「管理员 key 登录且服务端要求验证」时弹出；
//    · 只加载一个本地 HTML（内联脚本），不导航到任何站点；
//    · 拿到 token 立刻关闭，不保留窗口、不留 cookie 用途；
//    · 其余功能（大厅、房间、设置）一律是原生 WinUI，与 WebView 无关。
//
//  这与「用 WebView 套壳整个应用」是两回事 —— 后者是被明确排除的方案。
// ============================================================

/// <summary>Turnstile 校验结果。</summary>
public sealed class TurnstileOutcome
{
    private TurnstileOutcome(bool success, string? token, string? error)
    {
        Success = success;
        Token = token;
        Error = error;
    }

    public bool Success { get; }

    /// <summary>成功时的 token，交给 <c>POST /api/auth/login</c> 的 <c>turnstileToken</c>。</summary>
    public string? Token { get; }

    /// <summary>失败原因（中文，可直接展示）。</summary>
    public string? Error { get; }

    public static TurnstileOutcome Ok(string token) => new(true, token, null);

    public static TurnstileOutcome Failed(string error) => new(false, null, error);

    /// <summary>用户主动关掉了验证窗口。</summary>
    public static TurnstileOutcome Cancelled() => new(false, null, "已取消人机验证");
}

/// <summary>
/// Turnstile widget 宿主页面用到的站点参数。
/// </summary>
internal sealed class TurnstileHostOptions
{
    [JsonPropertyName("siteKey")]
    public string SiteKey { get; init; } = "";

    /// <summary>light | dark | auto</summary>
    [JsonPropertyName("theme")]
    public string Theme { get; init; } = "auto";

    /// <summary>Cloudflare 脚本地址（带 render=explicit）。</summary>
    [JsonPropertyName("scriptUrl")]
    public string ScriptUrl { get; init; } = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

    /// <summary>页面上显示的一句说明（中文）。</summary>
    [JsonPropertyName("hint")]
    public string Hint { get; init; } = "";
}

/// <summary>
/// 生成承载 Turnstile 的本机 HTML。
///
/// 单独抽出来是为了能被单测直接验证（无需真的开窗口），
/// 也方便把「为什么这么写」的注释集中在一处。
/// </summary>
internal static class TurnstileHostPage
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// 构造页面 HTML。
    ///
    /// 关键设计：
    ///   · 用 <c>render=explicit</c> 手动渲染，这样才能在回调里精确拿到 token；
    ///   · 成功/失败/过期都通过 <c>window.chrome.webview.postMessage</c> 回传宿主，
    ///     宿主再解析 —— 不依赖任何 WebView2 的 .NET JS 互操作 API，
    ///     这样页面本身可以用纯字符串拼装，不引入额外依赖；
    ///   · 主题跟随调用方传入的 theme；
    ///   · 页面底色用透明，让 Widget 与桌面端深色主题不冲突。
    /// </summary>
    public static string Build(TurnstileHostOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        // 只把需要的字段传给页面：用 JSON 而不是字符串拼接，
        // 避免 siteKey 里的引号等字符破坏脚本。
        var payload = JsonSerializer.Serialize(
            new
            {
                siteKey = options.SiteKey,
                theme = options.Theme,
                scriptUrl = options.ScriptUrl,
                hint = options.Hint,
            },
            JsonOptions);

        return $$"""
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html, body {
                  margin: 0; padding: 0; height: 100%;
                  background: transparent;
                  font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif;
                  color: #e6ebf5;
                  overflow: hidden;
                }
                .wrap {
                  display: flex; flex-direction: column; align-items: center;
                  justify-content: center; gap: 12px; height: 100%; padding: 16px;
                  box-sizing: border-box;
                }
                .hint { font-size: 12px; opacity: .8; text-align: center; line-height: 1.6; }
                .status { font-size: 12px; min-height: 16px; }
                .status.err { color: #f87171; }
                .status.ok { color: #34d399; }
                #widget { display: flex; justify-content: center; }
              </style>
            </head>
            <body>
              <div class="wrap">
                <div id="widget"></div>
                <div class="status" id="status"></div>
                <div class="hint" id="hint"></div>
              </div>
              <script>
              (function () {
                var OPTS = {{payload}};
                var statusEl = document.getElementById('status');
                var hintEl = document.getElementById('hint');
                if (OPTS.hint) hintEl.textContent = OPTS.hint;

                // 统一回传通道：WebView2 的 postMessage 在宿主侧触发 WebMessageReceived
                function post(kind, data) {
                  try {
                    window.chrome.webview.postMessage(JSON.stringify({
                      kind: kind,
                      token: data && data.token ? data.token : null,
                      detail: data && data.detail ? String(data.detail) : null
                    }));
                  } catch (e) {
                    // 宿主已关闭：忽略
                  }
                }

                function setStatus(text, cls) {
                  statusEl.textContent = text || '';
                  statusEl.className = 'status' + (cls ? ' ' + cls : '');
                }

                function onSuccess(token) {
                  setStatus('验证通过，正在登录…', 'ok');
                  post('success', { token: token });
                }
                function onError(code) {
                  var text = String(code || '');
                  var isRetryable =
                    text.indexOf('300') === 0 ||
                    text.indexOf('600') === 0 ||
                    text === 'internal-error';

                  if (isRetryable) {
                    // 可重试的错误（300xxx / 600xxx 系列）Cloudflare 会自己重来，
                    // 回调也可能被多次触发。这里只提示、不判死，
                    // 否则界面会在「失败 ↔ 成功」之间来回闪。
                    setStatus('验证暂时失败，正在自动重试…', 'err');
                    return;
                  }
                  setStatus('验证失败，请重试', 'err');
                  post('error', { detail: code });
                }
                function onExpired() {
                  // token 会过期：告诉宿主，让用户重新勾选
                  setStatus('验证已过期，请重新验证', 'err');
                  post('expired', {});
                }

                function renderWidget() {
                  if (!window.turnstile) {
                    setStatus('验证组件加载失败', 'err');
                    post('error', { detail: 'script-not-loaded' });
                    return;
                  }
                  try {
                    window.turnstile.render('#widget', {
                      sitekey: OPTS.siteKey,
                      theme: OPTS.theme,
                      callback: onSuccess,
                      'error-callback': onError,
                      'expired-callback': onExpired
                    });
                  } catch (e) {
                    setStatus('验证组件初始化失败', 'err');
                    post('error', { detail: 'render-failed: ' + (e && e.message ? e.message : e) });
                  }
                }

                // 动态加载 Cloudflare 脚本；加载失败要明确告知，不能干等
                var s = document.createElement('script');
                s.src = OPTS.scriptUrl;
                s.async = true;
                s.defer = true;
                s.onload = renderWidget;
                s.onerror = function () {
                  setStatus('无法加载验证脚本，请检查网络', 'err');
                  post('error', { detail: 'script-load-failed' });
                };
                document.head.appendChild(s);

                // 兜底看门狗 —— 只盯「组件有没有渲染出来」，不盯「用户有没有勾完」。
                //
                // ★ 这里有个很容易写错、后果又严重的点：
                //   「渲染成功」与「验证完成」是两件事。人机验证需要用户自己去看
                //   窗口、点一下复选框，Managed 模式经常要十几秒。若用一个固定
                //   15 秒的定时器判「超时 → 失败」，它会在用户还在操作时就把界面
                //   改成错误态并收起加载遮罩 —— 用户以为自己失败了就去点取消，
                //   一次本来能成功的验证就此丢掉。
                //
                //   正确做法：
                //     · iframe 一出现就立刻停表（组件已正常渲染）；
                //     · 之后无论用户花多久都不再判超时；
                //     · 只有「一直没渲染出来」才报错。
                var renderWatchdog = setInterval(function () {
                  if (document.querySelector('#widget iframe')) {
                    clearInterval(renderWatchdog);
                    clearTimeout(renderDeadline);
                    setStatus('请完成上方验证', '');
                  }
                }, 300);

                // 30 秒内组件始终没渲染出来，才判定为加载失败
                var renderDeadline = setTimeout(function () {
                  clearInterval(renderWatchdog);
                  // 已经渲染出来就什么都不做（用户可能正在慢慢操作）
                  if (document.querySelector('#widget iframe')) return;

                  setStatus('验证组件加载超时，请检查网络后重试', 'err');
                  post('error', { detail: 'timeout' });
                }, 30000);
              })();
              </script>
            </body>
            </html>
            """;
    }
}
