# M2 · 网页端接口与同步（已按真实接口定稿）

> 本文档已用真实 userToken 实测校准，替换了最初的猜测版。

## 实测契约

| 能力 | 请求 | 说明 |
|---|---|---|
| 会话列表 | `GET /api/v0/chat_session/fetch_page?count=N` | **count 最小为 2**（传 1 会返回 `biz_code:1`）；实测上限 100 |
| 建会话 | `POST /api/v0/chat_session/create`，body `{}` | 返回 `data.biz_data.chat_session.id` |
| 历史 | `GET /api/v0/chat/history_messages?chat_session_id=<uuid>` | 返回 `chat_session` + `chat_messages[]` |
| 发消息 | `POST /api/v0/chat/completion`，SSE | 必须先建会话 + 带 PoW 头 |

### 响应分层

```
{ code, msg, data: { biz_code, biz_msg, biz_data: {...} } }
```

- 外层 `code:0` **不代表成功**，还要看 `data.biz_code`（实测 1 = 「invalid chat session id」）。
- 时间戳是**秒**（`updated_at` / `inserted_at`），需要 ×1000 转毫秒。

### 会话字段

`{ id, title, title_type, model_type, pinned, updated_at }` —— 没有 `created_at`。

### 消息字段（正文在 fragments 里）

消息本身没有 `content`，正文按分片类型取：

| 分片 type | 含义 | 取用 |
|---|---|---|
| `REQUEST` | 用户提问 | user 消息正文 |
| `RESPONSE` | 助手回答 | assistant 消息正文 |
| `THINK` | 思维链 | assistant 的 thinking |
| `FILE` | 附件 | 首版忽略 |

### 发送请求体

```json
{
  "chat_session_id": "<已存在的 uuid>",
  "prompt": "…",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false
}
```

- `chat_session_id` **必填且必须是服务端已存在的 UUID**：传 `null` → 422；自己编 UUID → `biz_code:1 invalid chat session id`。
- 续聊要带 `parent_message_id`（上一轮 `ready` 事件里的 `response_message_id`）。

### SSE 帧格式（实测）

| 帧 | 内容 |
|---|---|
| `event: ready` | `{request_message_id, response_message_id, model_type}` |
| `event: update_session` | `{updated_at}` |
| 快照帧 | `{v:{response:{...fragments}}}`：整条消息快照 |
| 文本分片 | `{v:"…"}`：纯文本增量；也可以是 `{p:"response/fragments/-1/content", o:"APPEND", v:"…"}` |
| `event: title` | `{content}`：网页端自动生成的会话标题 |
| `event: close` | 结束 |

解析策略：快照用于首帧，之后按 `{v:string}` 累加；两者都写进同一个累积串，避免重复。

## PoW（发送前置）

- `POST /api/v0/chat/create_pow_challenge`，body `{"target_path":"/api/v0/chat/completion"}`。
- 返回 `challenge`：`{algorithm:"DeepSeekHashV1", challenge, salt, signature, difficulty, expire_at, expire_after, target_path}`。
- 求解：跑网页端自己的 wasm（`fe-static.deepseek.com/.../sha3_wasm_bg.*.wasm`），导出 `wasm_solve` /
  `__wbindgen_export_0`(malloc) / `__wbindgen_add_to_stack_pointer`，prefix = `${salt}_${expire_at}_`。
  实测 difficulty ≈ 144000，求解 40~80ms。
- 结果：`{algorithm, challenge, salt, answer, signature, target_path}` 的 JSON 做 base64，作为
  `x-ds-pow-response` 头。
- wasm 首次使用时从网页端主脚本里发现带哈希的文件名并缓存到 `$DSH_HOME/workchat/`。

## 实现要点

1. 所有出网请求串行队列；`40003/401` 抛 `unauthorized` 触发重登（重登 = 复用已存 userToken）。
2. `refresh=1` 才打远端，其余读缓存；列表最多 100 条（接口无可用游标）。
3. 发送完成后用服务端历史做权威落盘，失败才退回本地拼装。
4. 会话 id 在 `chat_session/create` 阶段确定，先发 `meta` 再开始流式。

## 验收

- [x] 列表返回 100 条、`updatedAt` 为毫秒
- [x] 新建会话 → 发送 → 收到 `meta/ready/title/delta/done`
- [x] 历史里 user/assistant 正文正确（fragments 解析）
- [x] 深度思考开启时收到 `thinking` 增量
- [x] PoW 真实 challenge 求解成功
