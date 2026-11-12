/**
 * 导入链路验证：网页端对话 → 真实 DSH 会话。
 *
 * 自己新建一条临时网页会话并发一句，随后调用宿主 /workchat/import，
 * 断言返回 dshSessionId；最后删除临时网页会话。
 *
 * 用法：node tools/probe-import.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSession,
  deleteSessions,
  streamCompletion,
} from '../src/host/sync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let token = ''
try {
  const parsed = JSON.parse(fs.readFileSync(path.join(here, '..', 'secrets', 'deepseek-credentials.json'), 'utf8'))
  token = typeof parsed?.userToken === 'string' ? parsed.userToken : ''
} catch { /* ignore */ }
token = token.replace(/^Bearer\s+/i, '').trim()
if (token === '') { console.error('没有 userToken'); process.exit(2) }

const base = process.env.WORKCHAT_BASE ?? 'http://127.0.0.1:2914'

const sessionId = await createSession(token)
console.log('临时网页会话已创建')
let reply = ''
for await (const event of streamCompletion(token, {
  sessionId,
  prompt: '只回复两个字：收到',
  thinkingEnabled: false,
  searchEnabled: false,
})) {
  if (event.type === 'delta') reply += event.text
}
console.log('已发送测试消息，回复 ' + reply.length + ' 字')

const problems = []
try {
  const response = await fetch(`${base}/workchat/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  const json = await response.json().catch(() => null)
  console.log('import 响应:', JSON.stringify({ http: response.status, ok: json?.ok, version: json?.version, messages: json?.messages, stage: json?.stage, message: json?.message }))
  if (response.status !== 200 || !json?.ok) {
    problems.push(`导入失败 HTTP ${response.status}: ${json?.message ?? ''}`)
  } else {
    console.log('DSH 会话 id 长度:', String(json.dshSessionId).length, '事件数:', json.eventCount ?? 'n/a')
    // 再调一次，验证复用
    const again = await fetch(`${base}/workchat/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const againJson = await again.json().catch(() => null)
    console.log('二次导入:', JSON.stringify({ ok: againJson?.ok, reused: againJson?.reused, same: againJson?.dshSessionId === json.dshSessionId }))
  }
} finally {
  await deleteSessions(token, [sessionId]).catch(() => {})
  console.log('临时网页会话已删除')
}

console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2))
if (problems.length > 0) process.exit(1)
