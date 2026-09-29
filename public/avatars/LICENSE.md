# 预设头像来源与许可

本目录下的 SVG 头像由 [DiceBear](https://www.dicebear.com/) 在**构建期本地渲染**生成，
不依赖任何外部 API。生成脚本见 `scripts/gen-avatars.ts`。

## 各风格许可

| 风格 | DiceBear 标识 | 许可 | 可商用 |
|---|---|---|---|
| Bottts | `bottts` | CC0 1.0 | ✅ |
| Pixel Art | `pixelArt` | CC0 1.0 | ✅ |
| Adventurer | `adventurer` | CC BY 4.0 | ✅（需署名） |
| Lorelei | `lorelei` | CC0 1.0 | ✅ |
| Fun Emoji | `funEmoji` | CC0 1.0 | ✅ |
| Shapes | `shapes` | CC0 1.0 | ✅ |
| Identicon | `identicon` | CC0 1.0 | ✅ |

## 署名要求

`adventurer` 风格（Lisa Wischofsky）采用 CC BY 4.0，要求在使用处署名。
本项目已在 README 与后台「关于」区域保留署名：

> Avatars: "Adventurer" by Lisa Wischofsky, licensed under CC BY 4.0.

其余风格为 CC0，无需署名。

## 重新生成

```bash
npm run gen:avatars
```
