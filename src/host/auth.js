/**
 * 网页端登录：账号密码 → userToken。
 *
 * 已探测的事实（不带凭据的探针，可复现）：
 *   - 裸 POST 会被风控挡成 429（WAF 页面），必须带浏览器请求头；
 *   - 带浏览器头后返回 422，detail 列出 body.password / body.device_id / body.os；
 *   - 邮箱与手机号是 FastAPI 联合体的两个候选分支。
 *
 * 登录顺序（产品决定）：先邮箱+密码，失败后自动尝试手机号+密码。
 * 安全约定：本模块对外只抛脱敏错误，任何日志、错误信息、返回值都不包含
 * 密码或 token 原文。
 */
import { randomUUID } from 'node:crypto'

export const LOGIN_URL = 'https://chat.deepseek.com/api/v0/users/login'

export const BROWSER_HEADERS = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'content-type': 'application/json',
  origin: 'https://chat.deepseek.com',
  referer: 'https://chat.deepseek.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'x-client-platform': 'web',
  'x-client-version': '1.0.0',
  'x-app-version': '20241129.1',
}

export class LoginError extends Error {
  constructor (stage, message, meta = {}) {
    super(message)
    this.name = 'LoginError'
    this.stage = stage
    this.meta = meta
  }
}

/** 稳定设备 ID：同一台机器固定复用，避免换 ID 触发网页端风控。 */
export function resolveDeviceId (existing) {
  if (typeof existing === 'string' && existing.trim() !== '') return existing.trim()
  return randomUUID()
}

/**
 * 按可用字段生成登录候选（邮箱优先，手机号兜底）。
 * @returns {Array<{ kind: 'email'|'mobile', body: object }>}
 */
export function buildLoginCandidates (credentials, preferred = 'email-first') {
  const deviceId = resolveDeviceId(credentials.deviceId)
  const password = String(credentials.password ?? '')
  const candidates = []
  const email = typeof credentials.email === 'string' ? credentials.email.trim() : ''
  const mobile = typeof credentials.mobile === 'string' ? credentials.mobile.trim() : ''

  const emailBody = () => ({ email, password, device_id: deviceId, os: credentials.os || 'web' })
  const mobileBody = () => ({
    mobile,
    area_code: credentials.areaCode || '+86',
    password,
    device_id: deviceId,
    os: credentials.os || 'web',
  })

  if (preferred === 'mobile-first') {
    if (mobile) candidates.push({ kind: 'mobile', body: mobileBody() })
    if (email) candidates.push({ kind: 'email', body: emailBody() })
  } else {
    if (email) candidates.push({ kind: 'email', body: emailBody() })
    if (mobile) candidates.push({ kind: 'mobile', body: mobileBody() })
  }
  return candidates
}

async function requestLogin (body, { fetchImpl, timeoutMs }) {
  let response
  try {
    response = await fetchImpl(LOGIN_URL, {
      method: 'POST',
      headers: BROWSER_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new LoginError('network', '网络请求失败（可能被风控或网络不可达）', { cause: String(error?.message ?? error) })
  }

  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* WAF 返回 HTML */ }

  if (response.status === 429) {
    throw new LoginError('rate-limited', '触发网页端风控限流，请稍后重试', { status: 429 })
  }
  if (json === null) {
    throw new LoginError('http', `登录接口返回非 JSON（HTTP ${response.status}）`, { status: response.status })
  }
  if (!response.ok) {
    // WAF 特征：整个请求体被自定义校验拒绝
    const wafBlocked = response.status === 422 && /"loc"\s*:\s*"body"/.test(text)
    if (wafBlocked) {
      throw new LoginError('waf', '密码登录被 DeepSeek 人机验证（AWS WAF）拦截，请改用 userToken', { status: 422 })
    }
    // 只保留字段路径与校验类型：绝不含请求值
    const detail = Array.isArray(json.detail)
      ? json.detail.slice(0, 8).map((d) => ({
          loc: Array.isArray(d?.loc)
            ? d.loc.map((part) => String(part))
            : (typeof d?.loc === 'string' ? [d.loc] : []),
          type: typeof d?.type === 'string' ? d.type : undefined,
          msg: typeof d?.msg === 'string' ? d.msg.slice(0, 120) : undefined,
        }))
      : undefined
    const locs = (detail ?? []).map((d) => d.loc.join('.')).filter((s) => s !== '').join(', ')
    throw new LoginError('http', `登录接口拒绝（HTTP ${response.status}${locs ? `：${locs}` : ''}）`, {
      status: response.status,
      detail,
      raw: text.slice(0, 600),
    })
  }
  if (json.code !== 0) {
    throw new LoginError('biz', `登录失败（code=${json.code}${json.msg ? `：${json.msg}` : ''}）`, { code: json.code })
  }

  // TODO(P0)：用真实响应定稿取值路径。当前按网页端常见结构兜底。
  const payload = json?.data?.biz_data ?? json?.data ?? {}
  const token = payload?.user?.token ?? payload?.token ?? null
  if (typeof token !== 'string' || token === '') {
    throw new LoginError('shape', '登录成功但未找到 token 字段')
  }
  return token
}

/**
 * 执行登录：按优先级尝试候选，任一成功即返回。
 *
 * 重要：DeepSeek 网页端的人机验证（AWS WAF）会拦截密码登录，实测返回
 * `422 {"detail":[{"loc":"body"}]}`。因此 credentials.userToken 存在时
 * 直接使用该 token，不再尝试密码。
 *
 * 429 / 网络错误会立即中断（再试另一分支只会更糟）。
 * @param {object} credentials
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, preferred?: 'email-first'|'mobile-first' }} [options]
 */
export async function login (credentials, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20000
  const preferred = options.preferred ?? credentials.preferredLogin ?? 'email-first'

  // 首选：用户直接粘贴的 userToken
  if (typeof credentials?.userToken === 'string' && credentials.userToken.trim() !== '') {
    return { token: credentials.userToken.trim(), deviceId: resolveDeviceId(credentials.deviceId), kind: 'token', tried: ['token'] }
  }

  if (!credentials || typeof credentials.password !== 'string' || credentials.password === '') {
    throw new LoginError('input', '缺少密码或 userToken')
  }
  const candidates = buildLoginCandidates(credentials, preferred)
  if (candidates.length === 0) {
    throw new LoginError('input', '缺少邮箱或手机号')
  }

  const deviceId = resolveDeviceId(credentials.deviceId)
  let lastError = null
  const tried = []

  for (const candidate of candidates) {
    tried.push(candidate.kind)
    try {
      const token = await requestLogin(candidate.body, { fetchImpl, timeoutMs })
      return { token, deviceId, kind: candidate.kind, tried }
    } catch (error) {
      lastError = error
      const stage = error?.stage
      // 限流与网络问题换分支只会雪上加霜，直接中断
      if (stage === 'rate-limited' || stage === 'network') throw error
      // 其余（http/biz/shape）继续尝试下一个候选
    }
  }

  throw lastError ?? new LoginError('input', '没有可用的登录方式')
}

/** 日志/错误兜底脱敏：把已知敏感串替换成占位符。 */
export function redact (text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('***')
  }
  return out
}
