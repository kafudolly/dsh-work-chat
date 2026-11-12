> **当前状态：已实现但默认不启用。** 方案 B 生成的原生会话会额外出现在工作区，
> 用户选择保留独立对话区，因此点击对话不再自动导入；接口保留，可用 `POST /workchat/import` 手动调用。

# M10 · 导入为真实 DSH 会话（方案 B）

## 为什么

网页端对话不是 DSH 会话，自定义面板无法做到与宿主完全一致的排版/Markdown/代码块。
方案 B 把网页端历史写成一份**合法的 DSH 会话日志**，随后用 `uiWorkspace.openSession(id)`
打开——渲染、样式、交互全部由宿主完成，天然像素级一致。

## 会话格式（实测校准）

`ctx.sessionPersistence`（服务名固定）：

```js
const handle = await persistence.create({ version, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 })
await handle.append(events)
await handle.flush?.()
await handle.close?.()
```

- `version` 从本机已有会话读出（当前 **4**），v4 需要 `delegationDepth`，v2+ 的 assistant 消息需要 `stream: []`。
- 事件形如 `{ type, seq, time, data, surfaceOp? }`，`seq` 从 0 递增、`time` 单调不减。

事件序列（每个 round）：

```
session/title { title, messageSeqs: [], source: { kind: 'user' } }
turn/start   { turn }
step/start   { turn, step: 1 }
user/message { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }   surfaceOp: 'append'
assistant/message { turn, step, message: { id, role: 'assistant',
                    content: [{type:'reasoning',text}?, {type:'text',text}],
                    source: { kind: 'model', provider: 'deepseek', model } },
                    stream: [] }                                                                  surfaceOp: 'append'
step/end { turn, step: 1 }
turn/end { turn, reason: { kind: 'completed' } }
session/end-seed {}
```

内容块：正文 `{type:'text'}`，思维链 `{type:'reasoning'}`。

## 接口

`POST /workchat/import { sessionId }` → `{ ok, dshSessionId, version, eventCount, messages }`

- 已导入过且 `persistence.stat(id)` 仍存在 → 直接复用（`reused: true`，实测通过）；
- 导入结果写回 `conversations.json` 的 `dshSessionId`；
- `cwd` 固定为 `$DSH_HOME/workchat/imported-chats`，**不混进用户的项目工作区**（该目录会在首次导入时自动创建）。

## 客户端

点击对话区条目：

1. `POST /workchat/import`；
2. 成功 → `ctx.get('uiWorkspace').openSession(dshSessionId)`，主面板切成原生会话视图；
3. 失败 → 回退到自绘面板并提示（保留兜底）。

## 已知取舍

- 导入后的会话会出现在**工作区**列表里（与网页端对话是两份记录）；
- 在导入会话里继续发消息走 DSH 模型，不会写回网页端；
- 对话区仍是网页端列表，点击只是“打开成会话”。

## 验证

`tools/probe-import.mjs`：临时网页会话 → 导入 → 断言 `dshSessionId`，随后删除临时网页会话。

实测结果：`HTTP 200`、`version 4`、`messages 2`。
