/**
 * 端到端发送测试：真实向网页端发一句很短的话，验证 PoW + SSE + 会话创建。
 *
 * 会消耗账号额度（一句话），并会在网页端创建一个新会话。
 * 只打印事件类型统计与结构，不打印消息正文。
 *
 * 用法：node tools/probe-send.mjs "你好"
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { streamCompletion, verifyToken } from '../src/host/sync.js'
import { fetchConversations } from '../src/host/sync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const prompt = process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[1]) ?? '你好'
const thinkingEnabled = process.argv.includes('--thinking')
const searchEnabled = process.argv.includes('--search')

let token = ''
try {
  const parsed = JSON.parse(fs.readFileSync(path.join(here, '..', 'secrets', 'deepseek-credentials.json'), 'utf8'))
  token = typeof parsed?.userToken === 'string' ? parsed.userToken : ''
} catch { /* ignore */ }
token = token.replace(/^Bearer\s+/i, '').trim()

if (token === '') {
  console.error('没有 userToken。')
  process.exit(2)
}

await verifyToken(token)
console.log('token 有效，开始发送测试…')

const startedAt = Date.now()
const counts = { meta: 0, ready: 0, title: 0, delta: 0, thinking: 0 }
let sessionId = null
let textLength = 0
let titlePresent = false
let error = null

try {
  for await (const event of streamCompletion(token, {
    sessionId: null,
    prompt,
    thinkingEnabled,
    searchEnabled,
  })) {
    if (event.type === 'meta') {
      counts.meta += 1
      sessionId = event.sessionId
    } else if (event.type === 'ready') {
      counts.ready += 1
    } else if (event.type === 'title') {
      counts.title += 1
      titlePresent = typeof event.title === 'string' && event.title.length > 0
    } else if (event.type === 'delta') {
      counts.delta += 1
      textLength += event.text.length
    } else if (event.type === 'thinking') {
      counts.thinking += 1
    }
  }
} catch (caught) {
  error = caught
}

console.log('发送结果', {
  ms: Date.now() - startedAt,
  counts,
  sessionIdPresent: typeof sessionId === 'string' && sessionId.length > 0,
  replyLength: textLength,
  titlePresent,
  error: error ? { stage: error.stage, message: String(error.message).slice(0, 120), status: error.meta?.status, code: error.meta?.code, detail: error.meta?.detail, raw: error.meta?.raw } : null,
})

if (sessionId) {
  const list = await fetchConversations(token, { count: 20 })
  const hit = list.find((item) => item.id === sessionId)
  console.log('会话是否出现在列表:', {
    present: Boolean(hit),
    updatedAtIsNew: hit ? Date.now() - hit.updatedAt < 5 * 60 * 1000 : null,
  })
}

if (error) process.exit(1)
