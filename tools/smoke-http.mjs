/**
 * 宿主路由端到端冒烟：进程内起一个最小 HTTP server，挂载 /workchat/*，
 * 用真实 token 走一遍 状态 → 列表 → 发送。
 *
 * 会真实发一条很短的测试消息（会在网页端创建会话）。
 * 只打印统计（条数、事件类型计数、耗时），不打印标题或正文。
 *
 * 用法：node tools/smoke-http.mjs
 */
import http from 'node:http'
import { mountRoutes } from '../src/host/routes.js'

const routes = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}
const dispose = mountRoutes(webServer)

const server = http.createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0]
  const route = routes.find((item) => item.kind === 'exact' && item.path === path)
  if (!route) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
    return
  }
  Promise.resolve(route.handler(request, response)).catch((error) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: String(error?.message ?? error) }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
console.log('测试服务器:', base, '路由数:', routes.length)

const problems = []

// 1) 状态
const statusResponse = await fetch(`${base}/workchat/status`)
const status = await statusResponse.json()
console.log('status:', { ok: status.ok, configured: status.configured, tokenPresent: status.tokenPresent, cacheItems: status.cacheItems })
if (status.configured !== true) problems.push('status.configured 应为 true')

// 2) 列表刷新
const listStarted = Date.now()
const listResponse = await fetch(`${base}/workchat/conversations?refresh=1`)
const list = await listResponse.json()
const itemCount = Array.isArray(list.items) ? list.items.length : 0
console.log('conversations:', { http: listResponse.status, items: itemCount, ms: Date.now() - listStarted })
if (itemCount === 0) problems.push('刷新后列表为空')
const firstItem = list.items?.[0]
if (firstItem && (firstItem.updatedAt ?? 0) < 1e12) problems.push('updatedAt 未转换成毫秒')

// 3) 发送
const chatStarted = Date.now()
const chatResponse = await fetch(`${base}/workchat/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: null, prompt: '只回复两个字：收到', thinkingEnabled: false, searchEnabled: false }),
})
const chatText = await chatResponse.text()
const counts = { open: 0, meta: 0, ready: 0, title: 0, delta: 0, thinking: 0, done: 0, error: 0 }
let replyChars = 0
let donePayload = null
for (const line of chatText.split('\n')) {
  if (!line.startsWith('data:')) continue
  let event = null
  try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
  if (event?.type in counts) counts[event.type] += 1
  if (event?.type === 'delta') replyChars += String(event.text ?? '').length
  if (event?.type === 'done') donePayload = event
}
console.log('chat:', { http: chatResponse.status, counts, replyChars, ms: Date.now() - chatStarted, hasSessionId: Boolean(donePayload?.sessionId), hasTitle: Boolean(donePayload?.title) })
if (chatResponse.status !== 200) problems.push(`/workchat/chat HTTP ${chatResponse.status}`)
if (counts.meta !== 1) problems.push('缺少 meta 事件')
if (counts.done !== 1) problems.push('缺少 done 事件')
if (counts.error !== 0) problems.push('出现 error 事件')
if (replyChars === 0) problems.push('回复为空')

// 4) 历史（用刚建的会话）
if (donePayload?.sessionId) {
  const historyResponse = await fetch(`${base}/workchat/history?sessionId=${encodeURIComponent(donePayload.sessionId)}&refresh=1`)
  const history = await historyResponse.json()
  const messageCount = Array.isArray(history.messages) ? history.messages.length : 0
  const assistantWithContent = (history.messages ?? []).filter((m) => m.role === 'assistant' && (m.content ?? '').length > 0).length
  console.log('history:', { http: historyResponse.status, messages: messageCount, assistantWithContent })
  if (messageCount < 2) problems.push('历史消息不足 2 条')
  if (assistantWithContent === 0) problems.push('历史里没有助手正文（fragments 解析可能未生效）')
}

server.close()
dispose()

console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2))
if (problems.length > 0) process.exit(1)
