# Third-party notices

本插件以 MIT 许可发布（见 `LICENSE`），并随包分发下列第三方资源：

## marked

- 文件：`assets/vendor/marked/marked.min.js`（v12.0.2）
- 许可：MIT
- 版权：Copyright (c) 2011-2024, Christopher Jeffrey
- 来源：<https://github.com/markedjs/marked>

## KaTeX

- 文件：`assets/vendor/katex/katex.min.js`、`katex.min.css`、`fonts/*.woff2`（v0.16.11）
- 许可：MIT
- 版权：Copyright (c) 2013-2020 Khan Academy and other contributors
- 来源：<https://github.com/KaTeX/KaTeX>

## DeepSeek 鱼形标记路径

- 位置：`client.js` 中的 `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX`
- 许可：MIT
- 版权：Copyright (c) 2026 DeepSeek
- 来源：`@deepseek-ai/dsh-web-frontend`（DeepSeek Harness 发布产物）

仅复制了 SVG 路径数据用于在 Chat 首页复刻官方标记，未引入其运行时组件。

## 参考实现

会话导入的格式细节参考了社区插件 `CwavGuy/deepseek-web-import` 的公开文档与实现思路
（MIT）。本仓库未直接复制其代码。
