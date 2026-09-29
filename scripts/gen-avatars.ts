/**
 * 生成 12 个预设头像 SVG 到 assets/avatars/
 *
 * 用法：
 *   npm run gen:avatars
 *
 * 设计要点：
 *   - 用 DiceBear 在构建期本地渲染，不调用外部 API
 *   - 输出纯 SVG，随静态资源免费无限分发
 *   - 同时生成 LICENSE.md 标注每个风格的许可
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAvatar } from '@dicebear/core';
import type { Style } from '@dicebear/core';
import {
  adventurer,
  bottts,
  funEmoji,
  identicon,
  lorelei,
  pixelArt,
  shapes,
} from '@dicebear/collection';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 输出到 public/，Vite 会原样拷贝到 build/client/，随静态资源免费分发
const OUT_DIR = join(__dirname, '..', 'public', 'avatars');

// 与 shared/constants.ts 的 PRESET_AVATAR_SPECS 保持一致
const SPECS: Array<{
  id: string;
  style: string;
  seed: string;
  collection: Style<Record<string, unknown>>;
}> = [
  { id: 'bottts-01', style: 'bottts', seed: 'Nova', collection: bottts },
  { id: 'bottts-02', style: 'bottts', seed: 'Pixel', collection: bottts },
  { id: 'pixel-art-01', style: 'pixelArt', seed: 'Knight', collection: pixelArt },
  { id: 'pixel-art-02', style: 'pixelArt', seed: 'Mage', collection: pixelArt },
  { id: 'adventurer-01', style: 'adventurer', seed: 'Scout', collection: adventurer },
  { id: 'adventurer-02', style: 'adventurer', seed: 'Ranger', collection: adventurer },
  { id: 'lorelei-01', style: 'lorelei', seed: 'Aria', collection: lorelei },
  { id: 'lorelei-02', style: 'lorelei', seed: 'Luna', collection: lorelei },
  { id: 'fun-emoji-01', style: 'funEmoji', seed: 'Happy', collection: funEmoji },
  { id: 'fun-emoji-02', style: 'funEmoji', seed: 'Cool', collection: funEmoji },
  { id: 'shapes-01', style: 'shapes', seed: 'Geo', collection: shapes },
  { id: 'identicon-01', style: 'identicon', seed: 'Meta', collection: identicon },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const manifest: Array<{ id: string; style: string; seed: string }> = [];

  for (const spec of SPECS) {
    const svg = createAvatar(spec.collection, {
      seed: spec.seed,
      size: 128,
      // 圆角由 CSS 负责，这里保持方形 viewBox
    }).toString();

    await writeFile(join(OUT_DIR, `${spec.id}.svg`), svg, 'utf8');
    manifest.push({ id: spec.id, style: spec.style, seed: spec.seed });
    console.log(`  ✓ ${spec.id}.svg  (${spec.style} / ${spec.seed})`);
  }

  // 清单文件，供前端枚举
  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ avatars: manifest }, null, 2),
    'utf8',
  );

  // 许可说明
  const license = `# 预设头像来源与许可

本目录下的 SVG 头像由 [DiceBear](https://www.dicebear.com/) 在**构建期本地渲染**生成，
不依赖任何外部 API。生成脚本见 \`scripts/gen-avatars.ts\`。

## 各风格许可

| 风格 | DiceBear 标识 | 许可 | 可商用 |
|---|---|---|---|
| Bottts | \`bottts\` | CC0 1.0 | ✅ |
| Pixel Art | \`pixelArt\` | CC0 1.0 | ✅ |
| Adventurer | \`adventurer\` | CC BY 4.0 | ✅（需署名） |
| Lorelei | \`lorelei\` | CC0 1.0 | ✅ |
| Fun Emoji | \`funEmoji\` | CC0 1.0 | ✅ |
| Shapes | \`shapes\` | CC0 1.0 | ✅ |
| Identicon | \`identicon\` | CC0 1.0 | ✅ |

## 署名要求

\`adventurer\` 风格（Lisa Wischofsky）采用 CC BY 4.0，要求在使用处署名。
本项目已在 README 与后台「关于」区域保留署名：

> Avatars: "Adventurer" by Lisa Wischofsky, licensed under CC BY 4.0.

其余风格为 CC0，无需署名。

## 重新生成

\`\`\`bash
npm run gen:avatars
\`\`\`
`;

  await writeFile(join(OUT_DIR, 'LICENSE.md'), license, 'utf8');

  console.log(`\n生成完成：${SPECS.length} 个头像 → public/avatars/`);
}

main().catch((err) => {
  console.error('生成头像失败：', err);
  process.exit(1);
});
