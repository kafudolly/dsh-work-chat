# dsh-work-chat

把 DeepSeek 网页端对话接进 DSH 侧边栏：可折叠的「工作区 / 对话区」、Work–Chat 新会话开关、深度思考与联网搜索、Markdown/LaTeX 渲染。

## 关于

`dsh-work-chat` 是一个 DSH（DeepSeek Harness）Web 客户端插件，把「网页端对话」变成侧边栏里的一等公民：

- **双分区侧栏**：工作区与对话区各占一个可折叠分区，悬停加深、点击整体收起、状态记忆；
- **对话区同步**：读取 `chat.deepseek.com` 当前账号的对话，按「置顶 / 今天 / 昨天 / 近 7 天 / 更早」分组，支持手动刷新、重命名、置顶、分享、多选删除；
- **Work / Chat 开关**：新会话页顶部分段开关。Work 保持 DSH 原有创建流程；Chat 进入独立的对话首页（鱼形标记 + slogan + 居中输入框）；
- **深度思考 / 联网搜索**：两个开关随消息透传到网页端接口，Chat 页与对话页都可切换；
- **完整渲染**：Markdown（GFM）+ LaTeX（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`），本地打包 marked 与 KaTeX，离线可用。

分工上：Host 半侧负责凭据、网页端接口、SSE 流式发送、PoW 求解与本地持久化；Client 半侧只通过同源 `/workchat/*` 路由访问宿主，不直接出网。鉴权使用网页端 `userToken`（账号密码登录会被人机验证拦截）。

> **状态**：已在 DSH `0.2.2-rc.1` / `desktop` profile 安装验证；设计文档见 [`docs/需求与实现方案.md`](docs/需求与实现方案.md)，分模块文档见 [`docs/00-overview.md`](docs/00-overview.md)，验收清单与已知问题见 [`docs/11-验收与已知问题.md`](docs/11-验收与已知问题.md)。

## 能力

| 需求 | 说明 |
|---|---|
| 工作区整体折叠 | 侧栏工作区列表上方增加区头，悬停加深、点击收起/展开全部工作区，状态记忆 |
| 对话区 | 与工作区平级的第二分区，同步网页端对话；按日期分组、刷新、重命名、置顶、分享、多选删除 |
| Work / Chat 开关 | 新会话页顶部居中分段开关；Chat 进入独立首页，输入框内含深度思考 / 联网搜索 |
| 对话渲染 | Markdown + LaTeX，本地 vendor，离线可用；思维链折叠展示 |
| 发送与回退 | 网页端 SSE 流式回复；不可用时回退本地会话 |

## 目录

```
index.js                 Host 入口（webServer 就绪后挂 /workchat/*）
client.js                浏览器 bundle：侧栏注入、模式开关、对话面板、设置页、Markdown/LaTeX 渲染
src/host/auth.js         网页端登录 / userToken / 脱敏
src/host/sync.js         会话列表、历史、SSE 补全、PoW 头、会话操作
src/host/pow.js          DeepSeekHashV1 wasm 求解（本地缓存）
src/host/importer.js     网页端对话 → DSH 会话事件（可选能力）
src/host/routes.js       /workchat/* 路由表
src/host/store.js        $DSH_HOME/workchat/* 持久化
assets/vendor/           本地 marked + KaTeX（含字体）
tools/                   自检脚本：smoke-* / probe-*
secrets/                 本机凭据（已 gitignore）
```

## 安装

### 方式一：从 Release 安装（推荐）

1. 到 [Releases](https://github.com/kafudolly/dsh-work-chat/releases) 下载 `dsh-work-chat-0.1.0.zip`（Windows 推荐）或 `dsh-work-chat-0.1.0.tar.gz`；
2. 解压到一个固定目录，例如 `%USERPROFILE%\plugins\dsh-work-chat`（解压后该目录里应能直接看到 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`）；
3. 打开 DSH → **插件管理器** → 安装本地插件（install bundle），目标选择**解压后的目录**；
4. 安装成功后刷新 DSH 的桌面窗口（不是浏览器里的 `127.0.0.1` 地址）。

> `desktop` profile 由 Electron 独占管理，`dsh --profile desktop ...` 命令行会拒绝修改；请使用应用内插件管理器。

### 方式二：从源码安装（可跟随更新）

```powershell
git clone https://github.com/kafudolly/dsh-work-chat.git
```

然后把仓库目录按上面的第 3 步安装。

### 安装后配置（必做）

1. DSH → 设置 → **DeepSeek 网页账号**；
2. 粘贴网页端 `userToken`：
   浏览器打开 <https://chat.deepseek.com> → F12 → Application → Local Storage → `userToken`，
   或 Network 里任一请求的 `authorization: Bearer <token>`；
3. 点「保存」→「测试连接」，提示“连接成功（userToken 方式，最近 N 条）”；
4. 侧栏会出现「工作区 / 对话区」两个分区；点对话区标题栏的 ⟳ 拉取对话列表。

> 账号密码登录会被 DeepSeek 的人机验证（AWS WAF）拦截，所以只支持 `userToken`。

### 卸载

在插件管理器里移除插件，或删除安装目录。运行期数据在 `$DSH_HOME/workchat/`（凭据、缓存、PoW wasm），不需要时可整体删除。

### 环境要求

- DSH `0.2.2-rc.1`（Web / Desktop 均可，插件按 web 客户端加载）；
- 首次渲染对话时会从插件自身加载 marked + KaTeX（约 0.55MB，本地文件，离线可用）。

## 安全边界

- 密码只落本机：`$DSH_HOME/workchat/credentials.json` 或插件目录 `secrets/`（开发测试）。
- **Windows 提示**：Node 的 `mode: 0o600` 在 Windows 上只影响只读位，不构成权限隔离；若需收紧，可对本机目录执行一次
  `icacls "$env:USERPROFILE\.dsh\workchat" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"`（插件未自动执行）。
- 日志、错误响应、HTTP 返回一律不含密码与 token 原文。
- 所有变更类路由要求同源（回环 + Origin 校验）。
- `secrets/*.json` 已被 `.gitignore` 排除；AI 助手不读取该文件。

## 验证记录（截至 0.1.0）

| 项 | 结果 |
|---|---|
| 安装 | `install_bundle` → `application: applied`，`warnings: []`，profile 内为软链 |
| 宿主存活 | `GET /workchat/health` → `200 {"ok":true}` |
| 路由注册 | `tools/smoke-host.mjs` → 9/9 |
| 凭据脱敏 | POST/GET `/workchat/credentials` 均无 `password` 字段（`hasPassword: true`） |
| 跨站防护 | 异源 POST → `403 untrusted origin` |
| SSE 回退 | 无凭据 POST `/workchat/chat` → `open` + `error{stage:input, fallback:true}` |
| 侧栏注入 | `tools/smoke-sidebar.mjs` → 区头顺序、折叠记忆、开关挂载、模式切换全部通过 |
| 槽位注册 | `tools/smoke-client.mjs` → `settings.section` / `main(workchat)` / `conversation.composer` |
| 真实登录 | userToken 校验通过（`code:0`，列表可读） |
| PoW | 真实 challenge 求解成功（difficulty 144000，约 44ms） |
| 发送链路 | `tools/smoke-http.mjs`：建会话 → SSE `meta/ready/title/delta/done` → 历史可读 |
| 深度思考 | 开启后收到 `thinking` 增量 |
| 会话操作 | `tools/probe-ops.mjs`：重命名/置顶/分享/删除全部 PASS（临时会话，已清理） |
| 侧栏列表渲染 | 心跳 `convRows:100`：100 条对话实际渲染进 DOM |
| 折叠修复 | CSS 选择器改为 `="1"` 才隐藏，避免默认把工作区列表藏掉 |
| Markdown/LaTeX | `tools/smoke-vendor.mjs`：marked 输出 strong/code/table，KaTeX 渲染出 767 字节 HTML，20 个 woff2 字体 |
| vendor 资源 | `/workchat/assets/*` 5 个文件全部 200（marked/katex/css/auto-render/字体） |
| 浏览器目视 | 侧栏区头/折叠已由心跳确认（`sidebar:true`、`convRows:100`）；对话面板输入框已确认（`panelComposer:true`） |
| 导入为会话 | `POST /workchat/import` → HTTP 200、`version 4`；读回事件流 92 条（15 轮）完整 |
| Chat 模式 | 切 Chat 自动打开对话区面板，`phase=composer-panel`、`panelComposer:true` |

## 获取 userToken（P0 结论：密码登录不可用）

DeepSeek 网页端前置 AWS WAF，密码登录会被拦截（实测 `422 {"detail":[{"loc":"body"}]}`）。
请改用 token：

1. 浏览器打开 <https://chat.deepseek.com> 并登录；
2. F12 → **Application → Local Storage → https://chat.deepseek.com** → 找 `userToken`；
   或 Network 面板任选一个请求，复制请求头 `authorization: Bearer <token>` 的值；
3. 粘贴到 **设置 → DeepSeek 网页账号 → userToken**，或写进 `secrets/deepseek-credentials.json` 的 `userToken` 字段；
4. token 有效期约数小时到数天，失效后重新复制。

## 开发

```powershell
# 校验语法
node --check index.js
node --check client.js
node --check src/host/routes.js

# 客户端 bundle 冒烟测试（桩环境跑 apply，断言槽位注册）
node tools/smoke-client.mjs

# P0：用真实账号验证登录链路（只打印脱敏结果）
node tools/probe-login.mjs
```

## 已实现模块

| 模块 | 文件 | 状态 |
|---|---|---|
| 登录（邮箱→手机号回退） | `src/host/auth.js` | 已实现，待真实账号验证 |
| 网页端接口 | `src/host/sync.js` | 已实现，字段待 P0 定稿 |
| 宿主路由 | `src/host/routes.js` | 已实现，`/workchat/health` 已验证 200 |
| 侧栏双分区 | `client.js`（mountSidebar） | 已实现，待目视验收 |
| 对话区 + 主面板 | `client.js`（WorkChatPanel） | 已实现，待目视验收 |
| Work/Chat 开关 | `client.js`（createModeBar） | 已实现，待目视验收 |
| 深度思考/智能搜索 | `client.js`（PrefToggles） | 已实现，待目视验收 |
| 发送闭环与回退 | `client.js`（ChatComposer） | 已实现，待真实账号验证 |

## 已知风险

DeepSeek 网页端接口非公开：可能改版、可能触发风控（429）、可能要求 PoW 挑战。接口层集中在
`src/host/sync.js` 与 `src/host/auth.js`，便于单点修复；失败时降级为只读缓存并明确提示。
