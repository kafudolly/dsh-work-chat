/**
 * 网页端对话接口封装（列表 / 历史 / 流式补全）。
 *
 * 这些是网页端自己用的非公开接口：
 *   - 参数与响应结构可能随网页版改版而变化，全部集中在本文件，便于单点修复；
 *   - 任何 401 / 业务码 40003 都视为 token 失效（unauthorized），由调用方触发重登；
 *   - 所有出网请求经同一个串行队列，避免并发触发风控。
 */
import { BROWSER_HEADERS } from './auth.js'
import { getSolver, makeHeader } from './pow.js'

export const API_BASE = 'https://chat.deepseek.com'

export class ApiError extends Error {
  constructor (stage, message, meta = {}) {
    super(message)
    this.name = 'ApiError'
    this.stage = stage
    this.meta = meta
    /** token 失效（需要重登） */
    this.unauthorized = meta.unauthorized === true
  }
}

// ---------------------------------------------------------------------------
// 出网串行队列：同一时刻只允许一个请求在飞
// ---------------------------------------------------------------------------
let queueTail = Promise.resolve()

function enqueue (task) {
  const run = queueTail.then(task, task)
  // 队尾吞掉异常，避免一次失败让整条队列永久 reject
  queueTail = run.then(() => undefined, () => undefined)
  return run
}

export function authHeaders (token) {
  return {
    ...BROWSER_HEADERS,
    authorization: `Bearer ${token}`,
  }
}

async function rawFetch (url, init, { fetchImpl, timeoutMs }) {
  return enqueue(async () => {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new ApiError('network', '网页端请求失败', { cause: String(error?.message ?? error) })
    }
  })
}

function parseJsonOrNull (text) {
  try { return JSON.parse(text) } catch { return null }
}

async function requestJson (url, token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20000
  const attempt = async () => {
    const response = await rawFetch(url, { headers: authHeaders(token) }, { fetchImpl, timeoutMs })
    const text = await response.text()
    const json = parseJsonOrNull(text)

    if (response.status === 401 || json?.code === 40003) {
      throw new ApiError('auth', '登录状态已失效', { status: response.status, code: json?.code, unauthorized: true })
    }
    if (response.status === 429) {
      throw new ApiError('rate-limited', '触发网页端风控限流', { status: 429 })
    }
    if (json === null) {
      throw new ApiError('http', `网页端返回非 JSON（HTTP ${response.status}）`, { status: response.status })
    }
    if (!response.ok || json.code !== 0) {
      throw new ApiError('biz', `网页端接口失败（HTTP ${response.status}${json.code !== undefined ? `, code=${json.code}` : ''}）`, {
        status: response.status,
        code: json.code,
      })
    }
    // 外层 code=0 也可能是业务失败：实测 count=1 时 biz_code=1
    const bizCode = json?.data?.biz_code
    if (typeof bizCode === 'number' && bizCode !== 0) {
      throw new ApiError('biz', `网页端业务失败（biz_code=${bizCode}${json?.data?.biz_msg ? `：${json.data.biz_msg}` : ''}）`, {
        code: bizCode,
      })
    }
    return json
  }

  // 只对 5xx 重试一次（网络错误已在 rawFetch 抛 network，交给上层决定）
  try {
    return await attempt()
  } catch (error) {
    if (error instanceof ApiError && error.stage === 'http' && error.meta?.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 800))
      return await attempt()
    }
    throw error
  }
}

/** 网页端时间戳按秒返回（10 位），统一转成毫秒。 */
function toMillis (value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number < 1e12 ? Math.round(number * 1000) : Math.round(number)
}

export function normalizeSession (raw) {
  const id = raw?.id ?? raw?.chat_session_id
  const updatedAt = toMillis(raw?.updated_at ?? raw?.updatedAt)
  return {
    id: id === undefined ? '' : String(id),
    title: String(raw?.title ?? raw?.name ?? ''),
    updatedAt,
    // 列表接口没有 created_at：首屏排序只用 updatedAt，createdAt 兜底
    createdAt: toMillis(raw?.created_at ?? raw?.createdAt) || updatedAt,
    pinned: raw?.pinned === true,
    modelType: typeof raw?.model_type === 'string' ? raw.model_type : undefined,
    source: 'web',
  }
}

/**
 * 把一条网页端消息归一化为前端使用的形态。
 *
 * 实测结构（2026-11）：消息本身没有 content，正文在 fragments 里：
 *   USER      → fragments[type=REQUEST].content
 *   ASSISTANT → fragments[type=RESPONSE].content，思考在 fragments[type=THINK].content
 *   FILE      → 只有附件，没有文字
 */
export function normalizeMessage (raw) {
  const role = (raw?.role ?? '').toUpperCase() === 'USER' ? 'user' : 'assistant'
  const fragments = Array.isArray(raw?.fragments) ? raw.fragments : []
  const collect = (type) => fragments
    .filter((fragment) => fragment?.type === type && typeof fragment?.content === 'string')
    .map((fragment) => fragment.content)
    .join('')

  let content = collect(role === 'user' ? 'REQUEST' : 'RESPONSE')
  if (content === '' && typeof raw?.content === 'string') content = raw.content

  const thinking = collect('THINK')

  return {
    role,
    content,
    thinking: thinking === '' ? undefined : thinking,
    at: toMillis(raw?.inserted_at ?? raw?.updated_at ?? raw?.created_at),
  }
}

/**
 * 拉取会话列表。
 * TODO(P0)：用真实账号确认 query 参数（分页游标 / count 名称）与字段名。
 */
export async function fetchConversations (token, options = {}) {
  // 实测 count=1 会返回 biz_code=1，最小有效值为 2
  const count = Math.max(2, Number(options.count ?? 100) || 100)
  const url = `${API_BASE}/api/v0/chat_session/fetch_page?count=${encodeURIComponent(count)}`
  const json = await requestJson(url, token, options)
  const payload = json?.data?.biz_data ?? json?.data ?? {}
  const list = payload?.chat_sessions ?? payload?.sessions ?? []
  return Array.isArray(list)
    ? list.map(normalizeSession).filter((item) => item.id !== '')
    : []
}

/** 通用 POST 助手：带 token 与浏览器头，返回 biz_data。 */
async function postBiz (path, token, body, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await enqueue(async () => {
    try {
      return await fetchImpl(`${API_BASE}${path}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
      })
    } catch (error) {
      throw new ApiError('network', '网页端请求失败', { cause: String(error?.message ?? error) })
    }
  })
  const text = await response.text()
  const json = parseJsonOrNull(text)
  if (response.status === 401 || json?.code === 40003) {
    throw new ApiError('auth', '登录状态已失效', { status: response.status, code: json?.code, unauthorized: true })
  }
  if (!response.ok || json === null) {
    throw new ApiError('http', `网页端接口失败（HTTP ${response.status}）`, { status: response.status })
  }
  const bizCode = json?.data?.biz_code
  if (typeof bizCode === 'number' && bizCode !== 0) {
    throw new ApiError('biz', `网页端业务失败（biz_code=${bizCode}${json?.data?.biz_msg ? `：${json.data.biz_msg}` : ''}）`, { code: bizCode })
  }
  return json?.data?.biz_data ?? {}
}

/** 重命名会话。 */
export async function renameSession (token, sessionId, title, options = {}) {
  const data = await postBiz('/api/v0/chat_session/update_title', token, {
    chat_session_id: sessionId,
    title,
  }, options)
  return {
    title: typeof data?.title === 'string' ? data.title : title,
    updatedAt: toMillis(data?.chat_session_updated_at),
  }
}

/** 置顶 / 取消置顶（支持批量）。 */
export async function setPinned (token, sessionIds, pinned, options = {}) {
  const data = await postBiz('/api/v0/chat_session/batch_update_pinned', token, {
    chat_session_ids: sessionIds,
    pinned: pinned === true,
  }, options)
  return {
    illegal: Array.isArray(data?.illegal_chat_session_ids) ? data.illegal_chat_session_ids : [],
    ignored: Array.isArray(data?.ignored_chat_session_ids) ? data.ignored_chat_session_ids : [],
  }
}

/** 删除会话（支持批量）。 */
export async function deleteSessions (token, sessionIds, options = {}) {
  await postBiz('/api/v0/chat_session/delete', token, { chat_session_ids: sessionIds }, options)
  return { deleted: sessionIds }
}

/** 创建分享链接；messageIds 为空数组时由调用方补齐。 */
export async function createShare (token, sessionId, messageIds, options = {}) {
  const data = await postBiz('/api/v0/share/create', token, {
    chat_session_id: sessionId,
    message_ids: messageIds,
  }, options)
  const shareId = typeof data?.share_id === 'string' ? data.share_id : ''
  if (shareId === '') throw new ApiError('biz', '分享创建成功但未返回 share_id')
  return { shareId, url: `https://chat.deepseek.com/share/${shareId}` }
}

/** 该会话已有的分享链接。 */
export async function listShares (token, chatSessionId, options = {}) {
  const response = await enqueue(async () => {
    try {
      return await fetchImplOrFetch(`${API_BASE}/api/v0/share/list?count=50`, token, options)
    } catch (error) {
      throw new ApiError('network', '网页端请求失败', { cause: String(error?.message ?? error) })
    }
  })
  const json = await response.json().catch(() => null)
  const shares = json?.data?.biz_data?.shares
  if (!Array.isArray(shares)) return []
  return shares
    .filter((item) => typeof item?.share_id === 'string')
    .map((item) => ({
      shareId: item.share_id,
      chatSessionId: item.chat_session_id,
      createdAt: toMillis(item.created_at),
      hint: typeof item.hint === 'string' ? item.hint : '',
    }))
    .filter((item) => chatSessionId === undefined || item.chatSessionId === chatSessionId)
}

/** 删除分享链接。 */
export async function deleteShare (token, shareId, options = {}) {
  await postBiz('/api/v0/share/delete', token, { share_id: shareId }, options)
  return { deleted: shareId }
}

/** 网页端消息 id 列表（分享需要）。 */
export async function fetchMessageIds (token, sessionId, options = {}) {
  const response = await enqueue(async () => {
    try {
      return await fetchImplOrFetch(`${API_BASE}/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`, token, options)
    } catch (error) {
      throw new ApiError('network', '网页端请求失败', { cause: String(error?.message ?? error) })
    }
  })
  const json = await response.json().catch(() => null)
  const messages = json?.data?.biz_data?.chat_messages
  if (!Array.isArray(messages)) return []
  return messages.map((message) => message?.message_id).filter((id) => typeof id === 'number')
}

/** GET 助手（内部复用）。 */
async function fetchImplOrFetch (url, token, options) {
  const fetchImpl = options.fetchImpl ?? fetch
  return fetchImpl(url, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  })
}
export async function verifyToken (token, options = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ApiError('input', '缺少 userToken')
  }
  const list = await fetchConversations(token, { count: 2, ...options })
  return { ok: true, count: list.length }
}

/**
 * 拉取单个会话的历史消息。
 * TODO(P0)：确认参数名（chat_session_id）与消息字段。
 */
export async function fetchHistory (token, sessionId, options = {}) {
  const url = `${API_BASE}/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`
  const json = await requestJson(url, token, options)
  const payload = json?.data?.biz_data ?? json?.data ?? {}
  const list = payload?.chat_messages ?? payload?.messages ?? []
  return Array.isArray(list) ? list.map(normalizeMessage) : []
}

/**
 * 新建一个网页端会话，返回聊天会话 id。
 * 实测：completion 的 chat_session_id 必须是已存在的 UUID，客户端不能自己编。
 */
export async function createSession (token, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_BASE}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: authHeaders(token),
    body: '{}',
  })
  const json = await response.json().catch(() => null)
  const id = json?.data?.biz_data?.chat_session?.id
  if (typeof id !== 'string' || id === '') {
    throw new ApiError('create', '创建网页端会话失败', {
      status: response.status,
      code: json?.code,
      bizCode: json?.data?.biz_code,
    })
  }
  return id
}

/**
 * 取一个新的 PoW challenge 并求解，返回 x-ds-pow-response 头值。
 * 每次发送都现取现解（实测约 40~80ms，避免缓存导致 header 过期失败）。
 */
export async function createPowHeader (token, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_BASE}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  })
  const json = await response.json().catch(() => null)
  const challenge = json?.data?.biz_data?.challenge
  if (!challenge || typeof challenge.challenge !== 'string') {
    throw new ApiError('pow', '拿不到 PoW challenge', {
      status: response.status,
      code: json?.code,
      bizCode: json?.data?.biz_code,
    })
  }
  const solver = await getSolver({ fetchImpl })
  return makeHeader(challenge, solver)
}

/**
 * 发送消息并读取 SSE 流。
 * 产出事件：
 *   { type:'meta', sessionId }
 *   { type:'delta', text }
 *   { type:'thinking', text }   （若网页端把思考内容单独下发）
 * TODO(P0)：确认请求体字段与 SSE 分帧格式。
 */
export async function * streamCompletion (token, input, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  // 实测：chat_session_id 必须是已存在的 UUID；新会话先调 chat_session/create
  const resolvedInputId = typeof input.sessionId === 'string' && input.sessionId !== ''
    ? input.sessionId
    : await createSession(token, fetchImpl)

  const body = {
    chat_session_id: resolvedInputId,
    prompt: input.prompt,
    ref_file_ids: [],
    thinking_enabled: input.thinkingEnabled === true,
    search_enabled: input.searchEnabled === true,
  }
  if (typeof input.parentMessageId === 'string' && input.parentMessageId !== '') body.parent_message_id = input.parentMessageId

  const powHeader = await createPowHeader(token, fetchImpl)

  const response = await enqueue(async () => {
    try {
      return await fetchImpl(`${API_BASE}/api/v0/chat/completion`, {
        method: 'POST',
        headers: { ...authHeaders(token), accept: 'text/event-stream', 'x-ds-pow-response': powHeader },
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 180000),
      })
    } catch (error) {
      throw new ApiError('network', '发送失败：网络不可达', { cause: String(error?.message ?? error) })
    }
  })

  if (response.status === 401) {
    throw new ApiError('auth', '登录状态已失效', { status: 401, unauthorized: true })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let detail = null
    try { detail = JSON.parse(text)?.detail ?? null } catch { /* 非 JSON */ }
    throw new ApiError('http', `发送失败（HTTP ${response.status}）`, {
      status: response.status,
      raw: text.slice(0, 400),
      detail,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sessionId = resolvedInputId
  let contentSoFar = ''
  let thinkingSoFar = ''
  let sawChunk = false
  // 会话 id 在发请求前就已确定，先通知调用方
  yield { type: 'meta', sessionId }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const lines = frame.split('\n')
      const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? ''
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
      if (dataLines.length === 0) continue
      const raw = dataLines.join('\n')
      if (raw === '' || raw === '[DONE]') continue
      const event = parseJsonOrNull(raw)
      if (event === null) continue

      // ready：会话/消息 id
      if (eventName === 'ready') {
        yield {
          type: 'ready',
          requestMessageId: event.request_message_id,
          responseMessageId: event.response_message_id,
          modelType: event.model_type,
        }
        continue
      }
      // title：网页端自动生成的会话标题
      if (eventName === 'title' && typeof event.content === 'string') {
        yield { type: 'title', title: event.content }
        continue
      }
      // update_session / close：仅时间戳或状态，忽略
      if (eventName === 'update_session' || eventName === 'close') continue

      // 纯文本分片：网页端在首帧快照之后用 `{v:"..."}` 推流
      if (typeof event.v === 'string') {
        const isThinking = typeof event.p === 'string' && event.p.includes('thinking')
        if (isThinking) {
          thinkingSoFar += event.v
          yield { type: 'thinking', text: event.v }
        } else {
          contentSoFar += event.v
          yield { type: 'delta', text: event.v }
        }
        sawChunk = true
        continue
      }

      // 其余补丁帧（非字符串）不参与正文拼装
      if (typeof event.p === 'string') continue

      // 正文：网页端首帧是「整条消息快照」，用长度差分转成增量
      const snapshot = event?.v?.response
      if (snapshot && typeof snapshot === 'object') {
        const fragments = Array.isArray(snapshot.fragments) ? snapshot.fragments : []
        const joinBy = (type) => fragments
          .filter((fragment) => fragment?.type === type && typeof fragment?.content === 'string')
          .map((fragment) => fragment.content)
          .join('')

        if (!sawChunk) {
          const nextContent = joinBy('RESPONSE')
          if (nextContent.length > contentSoFar.length && contentSoFar === '') {
            yield { type: 'delta', text: nextContent }
            contentSoFar = nextContent
          }
        }

        const nextThinking = joinBy('THINK')
        if (!sawChunk && nextThinking.length > thinkingSoFar.length) {
          yield { type: 'thinking', text: nextThinking.slice(thinkingSoFar.length) }
          thinkingSoFar = nextThinking
        }
        continue
      }
    }
  }

  return { sessionId }
}
