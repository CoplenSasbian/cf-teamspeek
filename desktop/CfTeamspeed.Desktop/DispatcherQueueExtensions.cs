using Microsoft.UI.Dispatching;

namespace CfTeamspeed.Desktop;

/// <summary>
/// DispatcherQueue 的 await 友好封装。
///
/// 为什么需要它：
///   本项目里大量服务方法都用 <c>ConfigureAwait(false)</c>（库代码的正确写法），
///   于是调用方 await 回来时很可能落在**线程池线程**上。此时如果直接碰
///   XAML 控件，会抛 RPC_E_WRONG_THREAD (0x8001010E)——错误信息里既没有
///   「跨线程」也没有「UI」字样，只报 COM 失败，排查成本很高。
///
///   DispatcherQueue.TryEnqueue 是回调式的，套上 TaskCompletionSource 之后
///   就能 <c>await</c>，让「切回 UI 线程」这件事在调用点一目了然。
/// </summary>
public static class DispatcherQueueExtensions
{
    /// <summary>
    /// 在 UI 线程上执行一个同步动作，并等待它完成。
    ///
    /// 已经在 UI 线程上时也走队列（不做「当前线程即 UI 线程就直调」的优化）：
    /// 直调会让调用顺序变得难以推理，而这点开销相对于界面操作可以忽略。
    /// </summary>
    public static Task EnqueueAsync(this DispatcherQueue dispatcher, Action action)
    {
        ArgumentNullException.ThrowIfNull(dispatcher);
        ArgumentNullException.ThrowIfNull(action);

        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        if (!dispatcher.TryEnqueue(() =>
            {
                try
                {
                    action();
                    tcs.TrySetResult();
                }
                catch (Exception ex)
                {
                    // 把异常带回 await 的那一端，而不是让它消失在消息泵里
                    tcs.TrySetException(ex);
                }
            }))
        {
            // 队列已关闭（窗口正在销毁）：静默完成，避免调用方永久挂起
            tcs.TrySetResult();
        }

        return tcs.Task;
    }

    /// <summary>在 UI 线程上执行一个异步动作，并等待它完成。</summary>
    public static async Task EnqueueAsync(this DispatcherQueue dispatcher, Func<Task> action)
    {
        ArgumentNullException.ThrowIfNull(dispatcher);
        ArgumentNullException.ThrowIfNull(action);

        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        if (!dispatcher.TryEnqueue(async () =>
            {
                try
                {
                    await action().ConfigureAwait(true);
                    tcs.TrySetResult();
                }
                catch (Exception ex)
                {
                    tcs.TrySetException(ex);
                }
            }))
        {
            tcs.TrySetResult();
        }

        await tcs.Task.ConfigureAwait(false);
    }
}
