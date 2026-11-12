/**
 * 原始 SSE 帧诊断：真实发一条 completion，打印事件名与 JSON 字段名。
 * 不打印正文内容。
 *
 * 用法：node tools/probe-sse.mjs "你好"
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authHeaders, createPowHeader, createSession } from '../src/host/sync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const prompt = process.argv[2] ?? '你好'

let token = ''
try {
  const parsed = JSON.parse(fs.readFileSync(path.join(here, '..', 'secrets', 'deepseek-credentials.json'), 'utf8'))
  token = typeof parsed?.userToken === 'string' ? parsed.userToken : ''
} catch { /* ignore */ }
token = token.replace(/^Bearer\s+/i, '').trim()
if (token === '') { console.error('没有 userToken'); process.exit(2) }

const powHeader = await createPowHeader(token)
const sessionId = await createSession(token)
console.log('已创建会话（长度 ' + sessionId.length + '），PoW header 就绪')

const response = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
  method: 'POST',
  headers: { ...authHeaders(token), accept: 'text/event-stream', 'x-ds-pow-response': powHeader },
  body: JSON.stringify({
    chat_session_id: sessionId,
    prompt,
    ref_file_ids: [],
    thinking_enabled: false,
    search_enabled: false,
  }),
})

console.log('HTTP', response.status, 'content-type:', response.headers.get('content-type'))

const contentType = response.headers.get('content-type') ?? ''
if (!contentType.includes('event-stream')) {
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  console.log('非 SSE 响应', {
    length: text.length,
    code: parsed?.code,
    bizCode: parsed?.data?.biz_code,
    bizMsg: parsed?.data?.biz_msg,
    msg: typeof parsed?.msg === 'string' ? parsed.msg.slice(0, 160) : undefined,
    dataKeys: parsed?.data && typeof parsed.data === 'object' ? Object.keys(parsed.data) : [],
    topKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : [],
  })
  process.exit(0)
}

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let frameCount = 0
const seen = new Set()
const patchSeen = new Set()
let appendCount = 0
let appendChars = 0
let batchCount = 0

while (frameCount < 40) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
  const frames = buffer.split('\n\n')
  buffer = frames.pop() ?? ''
  for (const frame of frames) {
    frameCount += 1
    const lines = frame.split('\n')
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '(none)'
    const dataLine = lines.find((line) => line.startsWith('data:'))?.slice(5).trim() ?? ''
    let keys = []
    let pathHint = ''
    if (dataLine !== '' && dataLine !== '[DONE]') {
      try {
        const parsed = JSON.parse(dataLine)
        keys = Object.keys(parsed)
        // 只看结构：把 path 形式的字段列出来（不含值）
        const paths = []
        const walk = (value, prefix, depth) => {
          if (depth > 2 || value === null || typeof value !== 'object') return
          if (Array.isArray(value)) { paths.push(prefix + '[]'); return }
          for (const key of Object.keys(value)) { paths.push(prefix + key); walk(value[key], prefix + key + '.', depth + 1) }
        }
        walk(parsed, '', 0)
        pathHint = paths.slice(0, 14).join(',')
      } catch { pathHint = '(非 JSON)' }
    }
    const signature = eventName + '|' + keys.join(',')
    if (!seen.has(signature)) {
      seen.add(signature)
      console.log(JSON.stringify({ event: eventName, keys, paths: pathHint }))
    }
    if (dataLine !== '' && dataLine !== '[DONE]') {
      try {
        const parsed = JSON.parse(dataLine)
        if (typeof parsed?.p === 'string') {
          const isContentAppend = parsed.o === 'APPEND' && String(parsed.p).endsWith('/content')
          if (isContentAppend) { appendCount += 1; appendChars += String(parsed.v ?? '').length }
          if (parsed.o === 'BATCH') batchCount += 1
          const patchKey = `${parsed.p}|${parsed.o}|${typeof parsed.v}`
          if (!patchSeen.has(patchKey)) {
            patchSeen.add(patchKey)
            console.log('PATCH', JSON.stringify({ p: parsed.p, o: parsed.o, vType: typeof parsed.v, vLen: typeof parsed.v === 'string' ? parsed.v.length : undefined }))
          }
          if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
            for (const sub of parsed.v) {
              const subKey = `  ${sub?.p}|${sub?.o}|${typeof sub?.v}`
              if (!patchSeen.has(subKey)) {
                patchSeen.add(subKey)
                console.log('  SUB', JSON.stringify({ p: sub?.p, o: sub?.o, vType: typeof sub?.v, vLen: typeof sub?.v === 'string' ? sub.v.length : undefined }))
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  }
}

console.log('总帧数（采样上限 40）：', frameCount, '不同事件形态：', seen.size)
console.log('内容 APPEND 次数：', appendCount, '累计字符：', appendChars, 'BATCH 次数：', batchCount)
