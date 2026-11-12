# dsh-work-chat

DSH 侧边栏「工作区 / 对话区」双分区 + 新会话页 Work–Chat 开关 + DeepSeek 网页端对话同步。

> 状态：**已安装到 desktop profile（0.0.1），宿主路由已验证通过；客户端待浏览器目视验收**。
> 完整设计与验收标准见 [`docs/需求与实现方案.md`](docs/需求与实现方案.md)，
> 分模块文档见 [`docs/00-overview.md`](docs/00-overview.md)。

## 能力

| 需求 | 说明 |
|---|---|
| 工作区整体折叠 | 侧栏工作区列表上方增加区头，悬停加深、点击收起/展开全部工作区，状态记忆 |
| 对话区 | 与工作区平级的第二分区，同步 DeepSeek 网页端对话，条目可折叠、点击在主面板打开 |
| Work / Chat 开关 | 新会话页顶部居中分段开关；Chat 态隐藏工作区 / Agent 预设（开发模式）/ 权限预设（审核模式） |

## 目录

```
index.js               Host 入口（webServer 就绪后挂 /workchat/*）
client.js              浏览器 bundle（ModuleLoader 工厂，当前只注册设置页）
src/host/auth.js       账号密码 → userToken（浏览器头、稳定 deviceId、脱敏）
src/host/sync.js       网页端会话列表 / 历史 / SSE 补全
src/host/store.js      $DSH_HOME/workchat/*.json 持久化（0600）
src/host/http.js       路由助手 + 同源校验
src/host/routes.js     /workchat/* 路由表
tools/probe-login.mjs  开发期登录探测，只打印脱敏结果
secrets/               本机凭据（已 gitignore，AI 不读取）
```

## 安装（确认方案后）

```powershell
# 由插件管理器安装当前目录（会写入 profile 的 package.json 与 cordis.patch.yml）
# 目标：link:<插件目录>
```

安装后刷新 `http://127.0.0.1:8795`；卸载用插件管理器的 remove。

## 安全边界

- 密码只落本机：`$DSH_HOME/workchat/credentials.json` 或插件目录 `secrets/`（开发测试）。
- **Windows 提示**：Node 的 `mode: 0o600` 在 Windows 上只影响只读位，不构成权限隔离；若需收紧，可对本机目录执行一次
  `icacls "$env:USERPROFILE\.dsh\workchat" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"`（插件未自动执行）。
- 日志、错误响应、HTTP 返回一律不含密码与 token 原文。
- 所有变更类路由要求同源（回环 + Origin 校验）。
- `secrets/*.json` 已被 `.gitignore` 排除；AI 助手不读取该文件。

## 验证记录（截至 0.0.1）

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
