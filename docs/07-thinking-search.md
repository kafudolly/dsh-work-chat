# M7 · 深度思考 / 智能搜索开关

## 目标

在新 Chat 页与对话页保留网页端的两个开关：**深度思考**（`thinking_enabled`）与**智能搜索**（`search_enabled`），可随时切换，并作为请求参数随消息发送。

## 位置

| 页面 | 载体 |
|---|---|
| 新建 Chat（hero） | `ChatComposer` 工具条（M6 接管的 composer 内） |
| 对话页（主面板） | 面板 composer 工具条，与新建页同一个组件 |

不放进 `conversation.input.*` 槽，因为它们属于 DSH 会话的工具条，而 Chat 输入框是我们自己的组件——放进去会出现两个来源的控件混排。

## 状态模型

```ts
interface ChatPrefs { thinkingEnabled: boolean; searchEnabled: boolean }
```

- **默认值**：两项均 `false`（与网页端默认一致）。
- **全局记忆**：`localStorage['workchat.prefs']`，新建页使用。
- **会话级覆盖**：`conv/<id>.json` 与 `GET/POST /workchat/chat-state`；打开对话时以会话值为准，切换即写回。
- **发送锁定**：`data-workchat-busy` 期间开关 `disabled`，避免请求参数与界面不一致。

## UI

```
┌──────────────────────────────────────────────┐
│ [💡 深度思考]  [🌐 智能搜索]        [发送 ▸] │
└──────────────────────────────────────────────┘
```

- 两个 pill 按钮：默认灰底；激活为主题蓝底/描边，图标与文字同时加深（不只靠颜色，满足可达性）。
- 激活时 `aria-pressed="true"`。
- 悬停显示说明气泡（portal 到 body，避免被 composer 合成层裁切）：
  - 深度思考：先推理再回答，耗时更长。
  - 智能搜索：联网检索后再回答。

## 数据流

```
切换 → 更新 store（本地立即生效）
     → CPU 空闲时 POST /workchat/chat-state { sessionId, thinkingEnabled, searchEnabled }
发送 → POST /workchat/chat { sessionId, prompt, thinkingEnabled, searchEnabled }
     → 宿主 → 网页端 chat/completion 的同名参数
```

## 边界

- **新建页**（`sessionId` 为空）：只更新全局 `workchat.prefs`，不发 `chat-state`；首个 `meta` 事件拿到新 id 后，把当时的偏好写进该会话文件。
- **切换会话**：以该会话记录的偏好刷新开关，不沿用上一个会话。
- **同步失败**：仅 console 提示，不打断输入；下次发送仍以当前界面值为准。
- **回退到本地模型**（M8）：两个开关禁用并保留选中态，气泡说明「本地回退不支持该能力」。

## 验收

- [ ] 新建 Chat 页可见两个开关，默认均关闭。
- [ ] 打开/关闭后立即有激活态，刷新页面新建页保持上次选择。
- [ ] 在会话页切换后，重新打开同一会话状态一致（持久化成功）。
- [ ] 发送请求体里 `thinking_enabled` / `search_enabled` 与界面一致（宿主日志断点验证，日志不含正文）。
- [ ] 发送中开关不可点。
- [ ] 回退时开关禁用且有说明。
