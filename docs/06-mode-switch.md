# M6 · Work / Chat 开关

## 目标

新会话页顶部居中一个分段开关：左 Work、右 Chat。Work 保持现有格式；Chat 隐藏工作区 / 开发模式（Agent 预设）/ 审核模式（权限预设），并把发送导向网页端。

## 落点

- **实现方式：DOM 注入**（与侧栏同一套策略）。`conversation.header` 是 ui-conversation 注册的 **single** 槽（其内部还声明了 leading / session.header 子槽），再注册会顶掉原会话头，因此不占用该槽。
- 定位 `[data-phase="hero"]`（空白会话页根节点），把开关条插为它的第一个子节点；页面切到已有会话（phase 变为 active/settling）时移除，回到空白页再补回。
- 居中：`[data-workchat-mode-bar]` 自身 `display:flex; justify-content:center`。

## 状态

| 项 | 实现 |
|---|---|
| 当前模式 | `localStorage['workchat.mode']`，默认 `work` |
| 全局标记 | `<html data-workchat-mode="work\|chat">` |
| 组件订阅 | 模块内 `modeStore`（getSnapshot/subscribe），开关与 CSS 属性同源 |
| 记忆范围 | 全局记忆；进入某个对话页不改变全局模式 |

## Chat 态隐藏的控件

```css
html[data-workchat-mode="chat"] [class*="heroWorkspaceRow"],
html[data-workchat-mode="chat"] [data-slot="conversation.hero.agentPreset"],
html[data-workchat-mode="chat"] [data-slot="conversation.input.permission"],
html[data-workchat-mode="chat"] [data-slot="conversation.input.plan"] { display: none; }
```

> `heroWorkspaceRow` 同时含工作区 chip 与选项行，整行隐藏最稳；若类名变化，只改这一条选择器。

## composer 接管（Chat 输入框）

默认 composer 会把回车发给 DSH 会话；Chat 模式必须换成我们的输入框。

- 向 `conversation.composer` **chain** 注册一个 take-over：

```js
const select = (owner) => modeStore.get() === 'chat' && owner.sessionId === undefined
  ? { kind: 'workchat' }
  : null
```

- 选中时渲染 `<ChatComposer context="hero" />`（含 M7 的思考/搜索开关）。
- **模式切换后重新注册一次**（dispose → register），强制链重新选举；步骤封装在 `applyComposerTakeover()`。
- **降级方案（takeover 失效时）**：在 `conversation.composer.dock` 渲染输入框，并 CSS 隐藏原 composer 的编辑区；两者不同时启用。

## 交互细节

- 开关：两段胶囊，滑块 180ms 平移；当前段文字加深；键盘 ←/→ 切换，`role="tablist"` + `aria-selected`。
- 切到 Chat：隐藏控件、接管 composer、把焦点移入 Chat 输入框。
- 切回 Work：恢复默认 composer 与控件，保留已输入文字（Chat 草稿存 localStorage，切回 Work 不丢失）。

## 验收

- [ ] 空白新会话页顶部居中显示开关；进入已有会话后不显示。
- [ ] 切 Chat：工作区 chip、Agent 预设、权限预设、计划模式全部消失；模型选择保留。
- [ ] 切回 Work：全部复原，页面与原来一致。
- [ ] 刷新后模式保持。
- [ ] Chat 模式下输入框回车不会创建 DSH 会话。
- [ ] 键盘可切换且焦点顺序合理。

## 风险

- chain 重新选举依赖注册变更通知；若切换后不生效，改为「始终注册、selector 读 store」并在 store 变更时 `ctx.slots.refresh?.()`（以实际 API 为准），仍不行则走降级方案。

## 实测修正：composer 接管在空白页不可行

宿主对 `conversation.composer` 的渲染是：

```js
renderSlotChain("conversation.composer", owner, {
  fallback: composerBar,
  fallbackOnly: sessionId === undefined,   // ← 关键
  overlay: true,
})
```

空白新会话页没有 sessionId 时 **fallbackOnly 为真，链式接管被整体跳过**，无论优先级多高都不会渲染。
因此 Chat 模式的输入框改由「对话区面板」承载：

- 切到 Chat → `ctx.layout.selectPanel('workchat')`，面板里有输入框 + 深度思考 / 联网搜索；
- 切回 Work → `ctx.layout.selectPanel(null)` 回到会话界面；
- 发送后立即 `/workchat/import`，把新对话导入成原生会话并打开（方案 B）。

实测心跳：`phase=composer-panel`、`panelComposer=true`，说明面板输入框确实渲染。
