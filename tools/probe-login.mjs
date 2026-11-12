/**
 * 开发期凭据探测脚本（P0 用）。
 *
 * 读取 secrets/deepseek-credentials.json（或 argv 指定的文件），按可用方式验证：
 *   1. 有 userToken → 调一次最小列表请求验证 token；
 *   2. 否则走账号密码登录（注：DeepSeek 的 AWS WAF 通常会拦截密码登录）。
 *
 * 只打印脱敏结果：状态码、业务码、条目数、耗时。
 * 绝不打印：密码、token 原文、完整响应体（响应体先擦除已知凭据再打印）。
 *
 * 注意：本脚本是"程序读取凭据"，不是 AI 读取；AI 助手不会被要求打开该文件。
 *
 * 用法：
 *   node tools/probe-login.mjs                 # 默认读 secrets/deepseek-credentials.json
 *   node tools/probe-login.mjs <path-to-json>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { login } from '../src/host/auth.js'
import { verifyToken } from '../src/host/sync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] ?? path.join(here, '..', 'secrets', 'deepseek-credentials.json')

let raw
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`无法读取凭据文件：${path.basename(file)}（${error?.code ?? 'parse error'}）`)
  process.exit(2)
}

const credentials = {
  email: raw.email || '',
  mobile: raw.mobile || '',
  areaCode: raw.areaCode || '+86',
  password: raw.password || '',
  userToken: raw.userToken || '',
  deviceId: raw.deviceId || '',
  os: raw.os || 'web',
}

/** 打印前擦除所有已知凭据值。 */
function scrub(text) {
  let out = String(text ?? '')
  for (const secret of [credentials.password, credentials.userToken, credentials.email, credentials.mobile]) {
    if (typeof secret === 'string' && secret.length >= 3) out = out.split(secret).join('***')
  }
  return out
}

function reportFailure(error) {
  console.log('验证失败', {
    stage: error?.stage ?? error?.name ?? 'unknown',
    message: scrub(error?.message ?? error),
    status: error?.meta?.status,
    code: error?.meta?.code,
  })
  const detail = error?.meta?.detail
  if (Array.isArray(detail) && detail.length > 0) {
    console.log('字段校验：', JSON.stringify(detail.map((d) => ({ loc: d.loc, type: d.type }))))
  }
  const rawBody = error?.meta?.raw
  if (typeof rawBody === 'string' && rawBody !== '') {
    console.log('响应体（已擦除凭据）：', scrub(rawBody))
  }
}

const startedAt = Date.now()

if (credentials.userToken !== '') {
  console.log('读取凭据：userToken 模式')
  try {
    const { count } = await verifyToken(credentials.userToken)
    console.log('token 校验成功', { tokenPresent: true, count, elapsedMs: Date.now() - startedAt })
  } catch (error) {
    reportFailure(error)
    process.exit(1)
  }
} else if (credentials.password !== '') {
  const mode = credentials.email ? '邮箱模式' : credentials.mobile ? '手机号模式' : '缺少账号'
  console.log(`读取凭据：${mode}（密码登录，可能被 WAF 拦截）`)
  try {
    const { token, deviceId, kind } = await login(credentials)
    console.log('登录成功', {
      tokenPresent: typeof token === 'string' && token.length > 0,
      kind,
      deviceIdTail: String(deviceId).slice(-6),
      elapsedMs: Date.now() - startedAt,
    })
  } catch (error) {
    reportFailure(error)
    process.exit(1)
  }
} else {
  console.error('凭据文件里既没有 userToken 也没有 password，请先填写。')
  process.exit(2)
}
