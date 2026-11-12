# 00 · 总览与模块契约

本目录是 `dsh-work-chat` 的分模块开发文档。总方案见 [`需求与实现方案.md`](../../docs/需求与实现方案.md)（v0.2）。

## 模块与推进顺序

| 模块 | 文档 | 产出 | 依赖 |
|---|---|---|---|
| M1 凭据与登录 | [01-auth.md](01-auth.md) | `src/host/auth.js`、设置页凭据表单 | — |
| M2 网页端接口 | [02-sync.md](02-sync.md) | `src/host/sync.js`（列表/历史/SSE/思考+搜索） | M1 |
| M3 宿主路由 | [03-host-routes.md](03-host-routes.md) | `src/host/routes.js` | M1 M2 |
| M4 侧边栏分区 | [04-sidebar.md](04-sidebar.md) | `client/sidebar.js`（区头、折叠、记忆） | — |
| M5 对话区与主面板 | [05-conversation-panel.md](05-conversation-panel.md) | `client/conversations.js`、`main#workchat` | M3 M4 |
| M6 Work/Chat 开关 | [06-mode-switch.md](06-mode-switch.md) | `client/mode.js` | M4 |
| M7 深度思考/智能搜索 | [07-thinking-search.md](07-thinking-search.md) | `client/toggles.js` | M5 M6 |
| M8 发送闭环与回退 | [08-send-fallback.md](08-send-fallback.md) | `client/composer.js` + 回退策略 | M1-M7 |
| M9 安装与验收 | [09-install-verify.md](09-install-verify.md) | profile 安装、逐项验收、回滚 | 全部 |

**推进规则**：每个模块完成后先 `node --check` + 自测，再进入下一个；M9 之前不安装到 profile，避免半成品进入真实界面。

## 共享数据契约

### 磁盘（`$DSH_HOME/workchat/`，全部 0600）

```
credentials.json     设置页写入的账号（明文密码；含 deviceId）
auth.json            { token, deviceId, at, kind: 'email'|'mobile' }
conversations.json   { fetchedAt, items: ConversationMeta[] }
conv/<remoteId>.json { remoteId, title, thinkingEnabled, searchEnabled, messages[] }
```

```ts
interface ConversationMeta {
  id: string          // 网页端 chat_session_id
  title: string
  updatedAt: number   // ms
  createdAt: number
  source: 'web' | 'local'
  thinkingEnabled?: boolean
  searchEnabled?: boolean
  preview?: string
}
```

### HTTP（同源回环，`/workchat/*`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/workchat/health` | — | `{ ok }` |
| GET | `/workchat/credentials` | — | 状态（不含密码） |
| POST | `/workchat/credentials` | `{ email, mobile, areaCode, password }` | 状态 |
| POST | `/workchat/login-test` | — | `{ ok, tokenPresent, kind }` |
| GET | `/workchat/conversations?refresh=1` | — | `{ fetchedAt, items }` |
| GET | `/workchat/history?sessionId=` | — | `{ messages }` |
| GET | `/workchat/chat-state?sessionId=` | — | `{ thinkingEnabled, searchEnabled }` |
| POST | `/workchat/chat-state` | `{ sessionId, thinkingEnabled, searchEnabled }` | 同上 |
| POST | `/workchat/chat` | `{ sessionId?, prompt, thinkingEnabled, searchEnabled }` | **SSE** |

SSE 事件协议（`data:` 行）：

```
data: {"type":"meta","sessionId":"<id>"}      // 新会话时先下发
data: {"type":"delta","text":"..."}           // 文本增量
data: {"type":"error","stage":"...","message":"..."}
data: {"type":"done","sessionId":"...","fallback":false}
```

### 浏览器侧

| 键 | 作用 |
|---|---|
| `html[data-workchat-mode]` | `work` / `chat`，CSS 隐藏控件与显示开关都读它 |
| `html[data-workchat-busy]` | 发送中，禁用开关与输入 |
| `localStorage['workchat.mode']` | 模式记忆 |
| `localStorage['workchat.collapsed.workspaces']` | 工作区折叠记忆 |
| `localStorage['workchat.collapsed.conversations']` | 对话区折叠记忆 |
| `[data-workchat-section="workspaces\|conversations"]` | 我们注入的区头/列表容器 |
| `[data-workchat-selected]` | 对话区当前选中项 |

## 界面锚点（官方 `data-slot`）

| 锚点 | 用途 |
|---|---|
| `[data-slot="sidebar.workspaces"]` | 定位侧栏区域，注入两个区头 |
| `[data-phase="hero"]` | 挂 Work–Chat 开关条（DOM 注入，不用 header 槽） |
| `[data-slot="conversation.hero.agentPreset"]` | Chat 态隐藏（开发模式） |
| `[data-slot="conversation.input.permission"]` | Chat 态隐藏（审核模式） |
| `[data-slot="conversation.input.plan"]` | Chat 态隐藏 |
| `[class*="heroWorkspaceRow"]` | Chat 态隐藏整行（工作区 chip + 选项） |

## 验收口径

- 每个模块的"验收"一节必须逐条可勾选，并附验证方式（脚本输出 / 截图 / DOM 断言）。
- 涉及网络与账号的验收，一律在 P0 之后用真实凭据跑；失败要记录 `stage` 与 `code`，不含敏感信息。
