/**
 * 用 userToken 验证网页端接口（不需要宿主重启、不需要改任何文件）。
 *
 * token 来源优先级：
 *   1. `--token <value>`（不推荐，会进命令历史）
 *   2. 环境变量 `DEEPSEEK_USER_TOKEN`
 *   3. 剪贴板（推荐：浏览器里复制后直接跑）
 *
 * 输出只包含：是否有效、会话条数、响应字段名（结构诊断）。
 * 绝不打印 token 原文、会话标题或消息正文。
 *
 * 用法：
 *   node tools/probe-token.mjs               # 读剪贴板
 *   node tools/probe-token.mjs --shape       # 额外打印响应字段结构
 *   node tools/probe-token.mjs --save        # 验证通过后写入 $DSH_HOME/workchat/credentials.json
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyToken } from '../src/host/sync.js'

function readClipboard () {
  if (process.platform === 'win32') {
    try {
      return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }
  try {
    return execFileSync('pbpaste', [], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const argv = process.argv.slice(2)
const flagIndex = argv.indexOf('--token')
const wantShape = argv.includes('--shape')
const wantSave = argv.includes('--save')
const wantClipboard = argv.includes('--clipboard')

function readSecretsToken () {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'secrets', 'deepseek-credentials.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof parsed?.userToken === 'string' ? parsed.userToken : ''
  } catch {
    return ''
  }
}

let token = ''
let source = ''
if (flagIndex >= 0) {
  token = argv[flagIndex + 1] ?? ''
  source = 'argv'
} else if (process.env.DEEPSEEK_USER_TOKEN) {
  token = process.env.DEEPSEEK_USER_TOKEN
  source = 'env'
} else if (!wantClipboard) {
  token = readSecretsToken()
  source = 'secrets 文件'
} else {
  token = readClipboard()
  source = 'clipboard'
}
token = token.replace(/^Bearer\s+/i, '').trim()

if (token === '') {
  console.error('没有拿到 token：请先在浏览器复制 userToken，再运行本脚本。')
  process.exit(2)
}

// 只给形态提示，不泄露内容
console.log('token 来源：' + source + '，长度 ' + token.length)

const startedAt = Date.now()
try {
  const { count } = await verifyToken(token, { fetchImpl: fetch })
  console.log('token 校验成功', { count, elapsedMs: Date.now() - startedAt })
} catch (error) {
  console.log('token 校验失败', {
    stage: error?.stage ?? 'unknown',
    message: String(error?.message ?? error),
    status: error?.meta?.status,
    code: error?.meta?.code,
  })
  process.exit(1)
}

if (wantShape) {
  try {
    const response = await fetch('https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=1', {
      headers: {
        accept: '*/*',
        origin: 'https://chat.deepseek.com',
        referer: 'https://chat.deepseek.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        authorization: `Bearer ${token}`,
      },
    })
    const json = await response.json()
    const payload = json?.data?.biz_data ?? json?.data ?? {}
    const keys = Object.keys(payload ?? {})
    const sessions = payload?.chat_sessions ?? []
    const first = sessions[0] ?? null
    console.log('响应结构：', JSON.stringify({
      code: json?.code,
      payloadKeys: keys,
      sessionCount: sessions.length,
      sessionKeys: first ? Object.keys(first) : [],
      hasMore: payload?.has_more,
    }))
  } catch (error) {
    console.log('结构探测失败：' + String(error?.message ?? error))
  }
}

if (wantSave) {
  const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'workchat', 'credentials.json')
  let previous = {}
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 首次写入 */ }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...previous, userToken: token, updatedAt: Date.now() }, null, 2) + '\n', { mode: 0o600 })
  console.log('已写入 ' + file + '（含 userToken，供宿主重启后使用）')
}
