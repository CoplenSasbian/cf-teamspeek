/**
 * 进房前音频卡片的渲染冒烟测试。
 *
 *   npx tsx scripts/smoke-prejoin.tsx
 *
 * 为什么需要：首页是客户端渲染的，HTTP 抓下来只有一个空壳，
 * 所以「这张卡片到底会不会在浏览器里炸」用 curl 验证不了。
 * 这里用 react-dom/server 把它真渲染一遍 —— 能抓住渲染期的崩溃
 * （比如在渲染体里碰了 navigator / HTMLMediaElement 这类浏览器全局）。
 *
 * 注意：它只验证「渲染不炸 + 关键控件都在」，不验证交互。
 */
import { renderToString } from 'react-dom/server';
import { PrejoinAudio } from '../app/components/PrejoinAudio';

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\n[渲染] PrejoinAudio 在无浏览器环境下渲染');
{
  const html = renderToString(
    <PrejoinAudio
      denoise="gtcrn"
      onDenoiseChange={() => {}}
      notify={() => {}}
      onOpenFullSettings={() => {}}
    />,
  );
  check(html.length > 0, '渲染出内容', `${html.length} 字符`);
  check(html.includes('麦克风与降噪'), '标题在');
  check(html.includes('输入设备'), '输入设备选择在');
  check(html.includes('输出设备'), '输出设备选择在');
  check(html.includes('试麦'), '试麦按钮在');
  check(html.includes('降噪算法'), '降噪算法在');
  check(html.includes('GTCRN'), 'GTCRN 选项在');
  check(html.includes('RNNoise'), 'RNNoise 选项在');
  check(html.includes('全部音频设置'), '打开完整设置的入口在');
  check(!html.includes('undefined'), '没有 undefined 漏进 markup');
}

console.log('\n[渲染] 默认设备（未选择任何设备）时也不炸');
{
  const html = renderToString(
    <PrejoinAudio
      denoise="off"
      onDenoiseChange={() => {}}
      notify={() => {}}
      onOpenFullSettings={() => {}}
    />,
  );
  check(html.includes('默认设备（浏览器）'), '有「默认设备」选项');
  check(html.includes('试麦'), '试麦按钮仍在');
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
