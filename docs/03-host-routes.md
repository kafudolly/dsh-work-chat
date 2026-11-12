# M3 · 宿主路由与流式代理

## 目标

把 M1/M2 的能力暴露给浏览器端：凭据状态、登录测试、会话列表、历史、思考/搜索偏好、以及**SSE 聊天代理**。

## 涉及文件

- `src/host/routes.js`
- `src/host/http.js`（同源校验、JSON 收发）

## 路由表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workchat/health` | 存活探针 |
| GET | `/workchat/credentials` | 状态：`configured/source/email/mobile/areaCode/hasPassword/tokenPresent/lastLoginAt` |
| POST | `/workchat/credentials` | 白名单字段写入；空密码=保持原值 |
| POST | `/workchat/login-test` | 登录并落 `auth.json` |
| GET | `/workchat/conversations` | 读缓存；`?refresh=1` 时先拉远端 |
| GET | `/workchat/history` | `?sessionId=` 拉历史，落 `conv/<id>.json` |
| GET | `/workchat/chat-state` | 读会话的思考/搜索偏好 |
| POST | `/workchat/chat-state` | 写偏好（开关变化时调用） |
| POST | `/workchat/chat` | **SSE**：转发补全流 |

## 实现要点

1. **同源校验**：所有 POST 走 `requireTrustedPost`（回环 Host + Origin 比较，放行 `dsh-app:`）。
2. **SSE 响应头**：`content-type: text/event-stream`、`cache-control: no-store`、`connection: keep-alive`、`x-accel-buffering: no`；每帧 `res.write()` 后 `flushHeaders()`。
3. **客户端断开**：监听 `request.on('close')` → `AbortController.abort()`，停止上游读取，避免浪费额度。
4. **错误帧**：任何异常以 `data:{"type":"error"...}` 下发后 `res.end()`，不抛 HTML 错误页。
5. **单飞**：同一时刻只允许一个 `/workchat/chat`；第二个返回 409 `{ error:'busy' }`。
6. **落盘时机**：`done` 后写 `conv/<id>.json`（含 messages、thinking/search 偏好），并更新 `conversations.json` 的时间与摘要。
7. **安全**：`safeError()` 只放行 `stage/message/code/status`；日志不写 prompt 正文。
8. **权限**：`credentials.json` / `auth.json` / `conv/*` 全部 `0600`。

## 请求/响应示例

```http
POST /workchat/chat
Content-Type: application/json
Origin: http://127.0.0.1:8795

{"sessionId":null,"prompt":"帮我润色这段话","thinkingEnabled":true,"searchEnabled":false}
```

```
data: {"type":"meta","sessionId":"abc123"}
data: {"type":"delta","text":"好的，"}
data: {"type":"delta","text":"这段可以..."}
data: {"type":"done","sessionId":"abc123","fallback":false}
```

## 测试计划

| 用例 | 期望 |
|---|---|
| 跨站 POST | 403 `untrusted origin` |
| 无凭据登录测试 | 502，`stage=input` |
| `/chat` 客户端中途断开 | 上游请求被 abort，进程无悬挂 |
| 并发两次 `/chat` | 第二次 409 |
| 上游 401 | 先自动重登再续跑；仍失败下发 error 帧并 `fallback:true`（交给 M8 回退） |

## 验收

- [ ] `curl http://127.0.0.1:8795/workchat/health` 返回 `{"ok":true}`（安装后）。
- [ ] 浏览器 DevTools 里 `/workchat/chat` 为 `text/event-stream`，逐帧到达。
- [ ] 断开页面后宿主无 err 日志堆积。

## 风险

- 代理层若被后续加装的反向代理缓冲，SSE 会被攒包：已加 `x-accel-buffering: no`，验收时确认逐帧。
