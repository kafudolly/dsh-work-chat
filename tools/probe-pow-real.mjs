/**
 * 用真实 challenge 验证 PoW 求解链路（需要 userToken）。
 *
 * 流程：POST /api/v0/chat/create_pow_challenge → 用网页端 wasm 求解 → 打印是否成功。
 * 只打印 challenge 的字段名、difficulty、耗时、header 长度；不打印 token、challenge 值或答案。
 *
 * 用法：node tools/probe-pow.mjs --real
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSolver, ensureWasm, makeHeader } from '../src/host/pow.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function readToken () {
  if (process.env.DEEPSEEK_USER_TOKEN) return process.env.DEEPSEEK_USER_TOKEN
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(here, '..', 'secrets', 'deepseek-credentials.json'), 'utf8'))
    return typeof parsed?.userToken === 'string' ? parsed.userToken : ''
  } catch {
    return ''
  }
}

const token = readToken().replace(/^Bearer\s+/i, '').trim()
if (token === '') {
  console.error('没有 userToken，跳过真实 challenge 测试。')
  process.exit(2)
}

const headers = {
  accept: '*/*',
  'content-type': 'application/json',
  origin: 'https://chat.deepseek.com',
  referer: 'https://chat.deepseek.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  authorization: `Bearer ${token}`,
}

const targetPath = '/api/v0/chat/completion'
const challengeStartedAt = Date.now()
const response = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
  method: 'POST',
  headers,
  body: JSON.stringify({ target_path: targetPath }),
})
const json = await response.json().catch(() => null)
const payload = json?.data?.biz_data ?? json?.data ?? {}
const challenge = payload?.challenge ?? null

if (!challenge) {
  console.log('拿不到 challenge', { http: response.status, code: json?.code, bizCode: json?.data?.biz_code, msg: json?.data?.biz_msg })
  process.exit(1)
}

console.log('challenge 获取成功', {
  ms: Date.now() - challengeStartedAt,
  keys: Object.keys(challenge),
  algorithm: challenge.algorithm,
  difficulty: challenge.difficulty,
  expireAtType: typeof challenge.expire_at,
})

const bytes = await ensureWasm()
const solver = await createSolver(bytes)
const solveStartedAt = Date.now()
try {
  const header = makeHeader(challenge, solver)
  console.log('PoW 求解成功', {
    ms: Date.now() - solveStartedAt,
    headerLength: header.length,
  })
} catch (error) {
  console.log('PoW 求解失败', {
    ms: Date.now() - solveStartedAt,
    message: String(error?.message ?? error),
  })
  process.exit(1)
}
