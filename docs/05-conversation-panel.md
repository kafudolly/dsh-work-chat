# M5 · 对话区列表与主面板对话视图

## 目标

「对话区」列出账号下**全部**网页端对话（你的确认 4），点击在主面板内打开（你的确认 3），可继续对话。

## 涉及文件

- `client/conversations.js`：列表数据与行渲染
- `client/panel.js`：`main` keyed 面板（对话视图）
- `client/store.js`：浏览器侧共享状态（选中项、刷新时间）

## 数据流

```
侧栏列表 ──GET /workchat/conversations──→ 宿主缓存 ←──定时/手动── sync.fetchConversations
   │ 点击
   ▼
selected = id ──ctx.layout.selectPanel('workchat')──→ 主面板
                                                    │ GET /workchat/history?sessionId
                                                    ▼
                                              渲染消息 + 输入框
```

## 行内操作（与网页端对齐）

| 操作 | 接口 | 行为 |
|---|---|---|
| 重命名 | `POST /chat_session/update_title` `{chat_session_id,title}` | 弹输入框（预填当前标题），回车保存，本地列表即时更新 |
| 置顶 / 取消 | `POST /chat_session/batch_update_pinned` `{chat_session_ids,pinned}` | 📌 标记 + 整体排到「置顶」组 |
| 分享 | `POST /share/create` `{chat_session_id,message_ids}` | 先取历史里的 `message_id` 列表，创建后复制 `https://chat.deepseek.com/share/<id>` |
| 删除 | `POST /chat_session/delete` `{chat_session_ids}` | 二次确认（列出标题）后删除，并从列表与本地缓存移除 |
| 多选 | — | 行前出现复选框，底部「已选 N / 全选 / 删除 / 取消」 |

`⋯` 菜单在行悬停/聚焦时出现；菜单与对话框都用宿主主题 token，支持 Escape、点击遮罩关闭。

## 按日期分组

顺序：**置顶 → 今天 → 昨天 → 近 7 天 → 更早**，组内按 `updatedAt` 倒序。
分组标题是 `[data-workchat-group]`，样式走 `--dsw-alias-label-caption`。

## 接口实测（tools/probe-ops.mjs）

用一条**自己新建的临时会话**逐项验证后清理，不触碰用户已有对话：

```
PASS 发送消息 / 重命名 / 置顶 / 取消置顶 / 取消息 id / 创建分享 / 分享列表 / 删除分享 / 删除会话
```


## 内容渲染（本地 vendor）

- Markdown：`marked 12`，开启 `gfm` + `breaks`；
- 数学公式：`KaTeX 0.16.11` + `auto-render`，支持 `$…# M5 · 对话区列表与主面板对话视图

## 目标

「对话区」列出账号下**全部**网页端对话（你的确认 4），点击在主面板内打开（你的确认 3），可继续对话。

## 涉及文件

- `client/conversations.js`：列表数据与行渲染
- `client/panel.js`：`main` keyed 面板（对话视图）
- `client/store.js`：浏览器侧共享状态（选中项、刷新时间）

## 数据流

```
侧栏列表 ──GET /workchat/conversations──→ 宿主缓存 ←──定时/手动── sync.fetchConversations
   │ 点击
   ▼
selected = id ──ctx.layout.selectPanel('workchat')──→ 主面板
                                                    │ GET /workchat/history?sessionId
                                                    ▼
                                              渲染消息 + 输入框
```

## 行内操作（与网页端对齐）

| 操作 | 接口 | 行为 |
|---|---|---|
| 重命名 | `POST /chat_session/update_title` `{chat_session_id,title}` | 弹输入框（预填当前标题），回车保存，本地列表即时更新 |
| 置顶 / 取消 | `POST /chat_session/batch_update_pinned` `{chat_session_ids,pinned}` | 📌 标记 + 整体排到「置顶」组 |
| 分享 | `POST /share/create` `{chat_session_id,message_ids}` | 先取历史里的 `message_id` 列表，创建后复制 `https://chat.deepseek.com/share/<id>` |
| 删除 | `POST /chat_session/delete` `{chat_session_ids}` | 二次确认（列出标题）后删除，并从列表与本地缓存移除 |
| 多选 | — | 行前出现复选框，底部「已选 N / 全选 / 删除 / 取消」 |

`⋯` 菜单在行悬停/聚焦时出现；菜单与对话框都用宿主主题 token，支持 Escape、点击遮罩关闭。

## 按日期分组

顺序：**置顶 → 今天 → 昨天 → 近 7 天 → 更早**，组内按 `updatedAt` 倒序。
分组标题是 `[data-workchat-group]`，样式走 `--dsw-alias-label-caption`。

## 接口实测（tools/probe-ops.mjs）

用一条**自己新建的临时会话**逐项验证后清理，不触碰用户已有对话：

```
PASS 发送消息 / 重命名 / 置顶 / 取消置顶 / 取消息 id / 创建分享 / 分享列表 / 删除分享 / 删除会话
```

 / `$…$` / `\(…\)` / `\[…\]`；
- 渲染前清洗 HTML：移除 script/iframe/object/embed/style/form 与 `on*` 事件、`javascript:` 链接；
- 渲染失败自动退回纯文本；
- 资源由插件自带并通过 `/workchat/assets/*` 前缀路由提供（宿主资产路由只放行图片）。

浏览器自检心跳：`mdReady` / `katexReady`，实测均为 true。


### 公式为什么要先抽出来

Markdown 会把 `\[` 里的反斜杠当转义吃掉，KaTeX 拿到时只剩 `[`，所以公式永远渲染不出来。
现在的顺序是：

1. 先按代码围栏切分，**代码块内不处理**；
2. 在正文里把 `$…$`、`\[…\]`（块级）与 `\(…\)`、`$…# M5 · 对话区列表与主面板对话视图

## 目标

「对话区」列出账号下**全部**网页端对话（你的确认 4），点击在主面板内打开（你的确认 3），可继续对话。

## 涉及文件

- `client/conversations.js`：列表数据与行渲染
- `client/panel.js`：`main` keyed 面板（对话视图）
- `client/store.js`：浏览器侧共享状态（选中项、刷新时间）

## 数据流

```
侧栏列表 ──GET /workchat/conversations──→ 宿主缓存 ←──定时/手动── sync.fetchConversations
   │ 点击
   ▼
selected = id ──ctx.layout.selectPanel('workchat')──→ 主面板
                                                    │ GET /workchat/history?sessionId
                                                    ▼
                                              渲染消息 + 输入框
```

## 行内操作（与网页端对齐）

| 操作 | 接口 | 行为 |
|---|---|---|
| 重命名 | `POST /chat_session/update_title` `{chat_session_id,title}` | 弹输入框（预填当前标题），回车保存，本地列表即时更新 |
| 置顶 / 取消 | `POST /chat_session/batch_update_pinned` `{chat_session_ids,pinned}` | 📌 标记 + 整体排到「置顶」组 |
| 分享 | `POST /share/create` `{chat_session_id,message_ids}` | 先取历史里的 `message_id` 列表，创建后复制 `https://chat.deepseek.com/share/<id>` |
| 删除 | `POST /chat_session/delete` `{chat_session_ids}` | 二次确认（列出标题）后删除，并从列表与本地缓存移除 |
| 多选 | — | 行前出现复选框，底部「已选 N / 全选 / 删除 / 取消」 |

`⋯` 菜单在行悬停/聚焦时出现；菜单与对话框都用宿主主题 token，支持 Escape、点击遮罩关闭。

## 按日期分组

顺序：**置顶 → 今天 → 昨天 → 近 7 天 → 更早**，组内按 `updatedAt` 倒序。
分组标题是 `[data-workchat-group]`，样式走 `--dsw-alias-label-caption`。

## 接口实测（tools/probe-ops.mjs）

用一条**自己新建的临时会话**逐项验证后清理，不触碰用户已有对话：

```
PASS 发送消息 / 重命名 / 置顶 / 取消置顶 / 取消息 id / 创建分享 / 分享列表 / 删除分享 / 删除会话
```


## 内容渲染（本地 vendor）

- Markdown：`marked 12`，开启 `gfm` + `breaks`；
- 数学公式：`KaTeX 0.16.11` + `auto-render`，支持 `$…# M5 · 对话区列表与主面板对话视图

## 目标

「对话区」列出账号下**全部**网页端对话（你的确认 4），点击在主面板内打开（你的确认 3），可继续对话。

## 涉及文件

- `client/conversations.js`：列表数据与行渲染
- `client/panel.js`：`main` keyed 面板（对话视图）
- `client/store.js`：浏览器侧共享状态（选中项、刷新时间）

## 数据流

```
侧栏列表 ──GET /workchat/conversations──→ 宿主缓存 ←──定时/手动── sync.fetchConversations
   │ 点击
   ▼
selected = id ──ctx.layout.selectPanel('workchat')──→ 主面板
                                                    │ GET /workchat/history?sessionId
                                                    ▼
                                              渲染消息 + 输入框
```

## 行内操作（与网页端对齐）

| 操作 | 接口 | 行为 |
|---|---|---|
| 重命名 | `POST /chat_session/update_title` `{chat_session_id,title}` | 弹输入框（预填当前标题），回车保存，本地列表即时更新 |
| 置顶 / 取消 | `POST /chat_session/batch_update_pinned` `{chat_session_ids,pinned}` | 📌 标记 + 整体排到「置顶」组 |
| 分享 | `POST /share/create` `{chat_session_id,message_ids}` | 先取历史里的 `message_id` 列表，创建后复制 `https://chat.deepseek.com/share/<id>` |
| 删除 | `POST /chat_session/delete` `{chat_session_ids}` | 二次确认（列出标题）后删除，并从列表与本地缓存移除 |
| 多选 | — | 行前出现复选框，底部「已选 N / 全选 / 删除 / 取消」 |

`⋯` 菜单在行悬停/聚焦时出现；菜单与对话框都用宿主主题 token，支持 Escape、点击遮罩关闭。

## 按日期分组

顺序：**置顶 → 今天 → 昨天 → 近 7 天 → 更早**，组内按 `updatedAt` 倒序。
分组标题是 `[data-workchat-group]`，样式走 `--dsw-alias-label-caption`。

## 接口实测（tools/probe-ops.mjs）

用一条**自己新建的临时会话**逐项验证后清理，不触碰用户已有对话：

```
PASS 发送消息 / 重命名 / 置顶 / 取消置顶 / 取消息 id / 创建分享 / 分享列表 / 删除分享 / 删除会话
```

 / `$…$` / `\(…\)` / `\[…\]`；
- 渲染前清洗 HTML：移除 script/iframe/object/embed/style/form 与 `on*` 事件、`javascript:` 链接；
- 渲染失败自动退回纯文本；
- 资源由插件自带并通过 `/workchat/assets/*` 前缀路由提供（宿主资产路由只放行图片）。

浏览器自检心跳：`mdReady` / `katexReady`，实测均为 true。

（行内）替换成
   `<span data-workchat-math data-display data-tex="…">` 占位；
3. 交给 marked 解析成 HTML，再清洗；
4. 最后对每个占位调用 `katex.render(tex, node, { displayMode })`。

浏览器自检心跳新增 `displayMathReady`，实测 `true`（`.katex-display` 节点存在）。

## 列表实现

| 项 | 规则 |
|---|---|
| 数据源 | `GET /workchat/conversations`；挂载时拉一次 |
| 刷新 | 60s 轮询（页面隐藏时暂停，`document.visibilityState`）；发送完成后立即刷新一次 |
| 排序 | `updatedAt` 倒序 |
| 行内容 | 标题（省略 + 悬停滚动）、相对时间、来源徽标 `网页` |
| 选中态 | `[data-workchat-selected]`，与侧栏现有选中底色一致 |
| 空态 | 未登录 → "未配置网页账号，去设置"；已登录无数据 → "暂无对话" |
| 错误态 | "同步失败 + 重试"（保留上次缓存） |

## 主面板实现

1. **注册**：`ctx.slots.register({ name: 'main', key: 'workchat' }, WorkChatPanel)`；`key` 不能是保留的 `conversation`。
2. **打开**：`ctx.layout.selectPanel('workchat')`；点侧栏条目时先写 `selected`，再选面板。
3. **加载**：读 `selected` → `GET /workchat/history` → 渲染；加载中骨架屏，失败可重试。
4. **渲染**：
   - 用户消息右对齐气泡；助手消息左对齐，Markdown 段落（首版纯文本 + 换行，M7 再升级）；
   - `thinking` 字段放折叠块（默认收起，标题「深度思考」）；
   - 空会话显示引导文案。
5. **继续对话**：底部 composer（复用 M6/M7 组件），发送走 `/workchat/chat`。
6. **滚动**：新消息到达自动滚到底；用户上滚后不再强制。

## 返回会话界面的方式

面板顶部提供「← 返回会话」：`ctx.layout.selectPanel(null)`（布局文档：`null` 选中会话界面）。

## 验收

- [ ] 侧栏对话区条目与网页端一致（含手机/浏览器创建的）。
- [ ] 点条目 → 主面板打开该对话，消息顺序与角色正确。
- [ ] 选中的条目在侧栏有选中态。
- [ ] 空态/错误态/加载态三种文案正确。
- [ ] 面板内发消息后，消息即时出现，侧栏该条时间刷新。
- [ ] 「返回会话」回到原来的会话视图，不丢失当前会话。

## 风险

- `main` keyed 槽注册参数以实际 API 为准（`key` vs `id`），首版以 `slots.register({ name:'main', key })` 落地，注册失败会抛出可见错误，届时按 console 修正。
- 历史消息字段差异（`thinking_content` vs `thinking`）在 `normalizeMessage()` 统一。
