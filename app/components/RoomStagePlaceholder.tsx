import { MessageSquare } from 'lucide-react';

/**
 * 房间主内容区 —— 目前占位。
 *
 * 原来这里是「成员卡片网格」（每个成员一张大头像卡）。
 * 它实际没什么用：谁在房间里侧栏就已经列出来了，卡片上的音量调整
 * 也搬进了右键菜单。这块区域之后要改成【文字聊天】。
 *
 * 语音本身不依赖这块区域：音频的发布/订阅/混音都在 `RoomController`
 * 和 `audioMixer` 里完成，与 UI 无关，所以直接留白不影响说话。
 */
export function RoomStagePlaceholder() {
  return (
    <div className="flex h-full min-h-[16rem] flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-ink-3">
        <MessageSquare className="h-5 w-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-ink-2">文字聊天</p>
        <p className="max-w-xs text-xs leading-relaxed text-ink-3">
          这里之后会改成频道文字聊天，现在先空着。
          <br />
          语音照常进行，操作都在侧栏的右键菜单里。
        </p>
      </div>
    </div>
  );
}
