/**
 * 宿主 HTTP 小工具：路由类型、JSON 收发、同源校验。
 *
 * 与 DSH 生态里其它插件一致：只服务本机回环，变更类请求必须过同源校验，
 * 这是全部的 CSRF 防御。
 */
import process from 'node:process'

const BODY_LIMIT_BYTES = 64 * 1024

/** @typedef {{ kind: 'exact', path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }} WebRoute */

export function sendJson (response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function loopbackAuthority (authority) {
  try {
    const parsed = new URL(`http://${authority}`)
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null
    return `loopback:${parsed.port === '' ? '80' : parsed.port}`
  } catch {
    return null
  }
}

export function isSameOrigin (request) {
  const host = request.headers.host
  const hostKey = host === undefined ? null : loopbackAuthority(host)
  if (hostKey === null) return false
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    const url = new URL(origin)
    if (url.protocol === 'dsh-app:') return true
    return loopbackAuthority(url.host) === hostKey
  } catch {
    return false
  }
}

export function requireMethod (request, response, method) {
  if (request.method === method) return true
  response.writeHead(405, { allow: method })
  response.end()
  return false
}

export function requireTrustedPost (request, response) {
  if (!requireMethod(request, response, 'POST')) return false
  if (isSameOrigin(request)) return true
  sendJson(response, 403, { error: 'untrusted origin' })
  return false
}

export async function readJsonBody (request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** 当前是否为桌面宿主管进程（仅用于日志措辞，不参与鉴权）。 */
export function isDesktopHost () {
  return process.env.ELECTRON_RUN_AS_NODE === '1'
}
