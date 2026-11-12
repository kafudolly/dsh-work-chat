# M9 · 安装、验收与回滚

## 安装

1. 确认工程目录：`<插件目录>`
2. 用插件管理器安装（当前 profile：`desktop`）：

```
plugin_manager install_bundle target = <插件目录>
```

3. 读取返回的 `application` 与 `warnings`；`application: applied` 才算生效。
4. **刷新要刷「桌面应用窗口」**，不要用浏览器打开 `http://127.0.0.1:8795`：
   该 HTTP 端口只接受启动时打印的 `/connect?token=…` 一次性令牌，浏览器直开只会得到
   `dsh web authentication required` 401 页，且不会执行任何插件 JS。

## 客户端加载自检（看不到浏览器时用）

| 端点 | 用途 |
|---|---|
| `GET /workchat/debug/client-graph` | 宿主侧确认 `dsh-work-chat` 是否进入客户端条目图 |
| `GET /workchat/status` | `client` 字段是浏览器心跳；`null` = 页面还没执行插件 |
| `POST /workchat/client-heartbeat` | 通道自测（手动发一条应立刻回显） |

实测（2026-11-12）：

- 条目图 78 条，含 `dsh-work-chat`，`inject:[]`、`immediately:true`
- bundle 可取：`GET /plugins/??dsh-work-chat/client.js&rev=…` → 200，内容与本仓库 `client.js` 一致
- 心跳通道自测通过
- 浏览器真实心跳：**等待在桌面应用窗口里重载**

> 安装会写入 profile 的 `package.json` 与 `cordis.patch.yml`，并对所有会话生效；这是长期插件，不做临时预览。

## 验收清单

### A. 需求 1 —— 工作区整体折叠

- [ ] 侧栏出现「工作区」区头，悬停底色加深（截图对比）
- [ ] 点击后所有工作区与会话收起，箭头旋转
- [ ] 再次点击展开，内容完整
- [ ] 刷新后折叠状态保持
- [ ] Tab 聚焦 + Enter 可切换

### B. 需求 2 —— 对话区

- [ ] 「对话区」在工作区之下、设置之上
- [ ] 列出网页端全部对话，按时间倒序
- [ ] 独立折叠，状态记忆
- [ ] 点击条目 → 主面板打开，消息正确
- [ ] 空态 / 未登录 / 同步失败三种提示正确

### C. 需求 3 —— Work / Chat 开关

- [ ] 新会话页顶部居中显示开关
- [ ] Work 态与改造前完全一致
- [ ] Chat 态工作区、Agent 预设、权限预设消失
- [ ] Chat 发送 → 创建网页端对话 → 出现在对话区
- [ ] 刷新后模式保持

### D. 新增 —— 深度思考 / 智能搜索

- [ ] 新建 Chat 页有两个开关，默认关闭
- [ ] 对话页可见且能切换
- [ ] 切换后刷新/重开保持
- [ ] 发送请求携带对应参数（宿主断点确认，日志不含正文）

### E. 回退

- [ ] 断网或错密码发送 → 回退本地会话 + toast
- [ ] 不产生重复消息

## 验证手段

| 手段 | 用途 |
|---|---|
| 页面截图 | A/B/C/D 的视觉与状态 |
| DevTools Network | `/workchat/*` 状态码、SSE 逐帧 |
| 宿主日志 | 路由命中、失败 stage（无正文、无凭据） |
| `node --check` | 每次改动后的语法门禁 |
| `tools/probe-login.mjs` | 登录链路独立验证 |

## 回滚

```
plugin_manager remove_bundle target = dsh-work-chat
```

- 卸载后侧栏注入节点随插件卸载消失（`ctx.effect` 清理），`html[data-workchat-*]` 与 `<style>` 一并移除。
- 数据仍在本机：`$DSH_HOME/workchat/`；不需要时可整体删除。
- 若客户端注入残留（极端情况）：刷新页面即可，注入逻辑幂等且不写死 DOM。

## 已知限制（首版）

- 网页端接口非公开，字段可能随版本变化；接口层集中在 `sync.js`。
- 侧栏注入依赖 `data-slot` 锚点与 `regionArea` 结构；DSH 大版本升级后需回归 A/B。
- 思考过程以折叠块展示，不做网页端同款渲染。
- 不支持附件上传（首版）。
