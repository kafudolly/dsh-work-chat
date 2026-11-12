/**
 * /workchat/* 路由表。
 *
 * 约定：
 *   - GET 只读；POST 变更，全部过同源校验；
 *   - 任何响应都不回传密码或完整 token，只回 hasPassword / tokenPresent；
 *   - 每个 handler 自己兜住异常，避免把堆栈抛给浏览器；
 *   - 聊天走 SSE，客户端断开即 abort 上游。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeImportedSession } from './importer.js'
import { login } from './auth.js'
import {
  createShare,
  deleteSessions,
  deleteShare,
  fetchConversations,
  fetchHistory,
  fetchMessageIds,
  listShares,
  renameSession,
  setPinned,
  streamCompletion,
  verifyToken,
} from './sync.js'
import { dataDir, PACKAGE_ROOT, paths, readJson, writeJson } from './store.js'
import { readJsonBody, requireMethod, requireTrustedPost, sendJson } from './http.js'

/** 进程内状态（重启后从 auth.json / conversations.json 恢复）。 */
const state = {
  token: null,
  deviceId: null,
  lastLoginAt: 0,
  loginKind: null,
  chatting: false,
  /** 浏览器端最近一次心跳：用于在看不到页面的情况下确认客户端半侧是否加载 */
  client: null,
}

function loadAuth () {
  const saved = readJson(paths.auth, null)
  if (saved && typeof saved.token === 'string') {
    state.token = saved.token
    state.deviceId = saved.deviceId ?? null
    state.lastLoginAt = Number(saved.at ?? 0) || 0
    state.loginKind = saved.kind ?? null
  }
}

/** 运行期凭据：设置页写入的优先，缺项时回退插件目录的开发测试夹具。 */
function readCredentials () {
  const fromSettings = readJson(paths.credentials, null) ?? {}
  const fromLocal = readJson(paths.localCredentials, null) ?? {}
  const pick = (key) => {
    const a = fromSettings[key]
    if (typeof a === 'string' && a.trim() !== '') return a
    const b = fromLocal[key]
    return typeof b === 'string' ? b : ''
  }
  const credentials = {
    email: pick('email'),
    mobile: pick('mobile'),
    areaCode: pick('areaCode') || '+86',
    password: pick('password'),
    // 网页端直接复制的 token：优先于密码登录（密码登录会被 WAF 拦截）
    userToken: pick('userToken'),
    deviceId: pick('deviceId') || state.deviceId || '',
    os: pick('os') || 'web',
    preferredLogin: pick('preferredLogin') || 'email-first',
  }
  const source = typeof fromSettings.password === 'string' && fromSettings.password !== ''
    ? 'settings'
    : (credentials.password !== '' ? 'local-file' : 'none')
  return { credentials, source }
}

function publicStatus () {
  let credentials
  let source
  try {
    ({ credentials, source } = readCredentials())
  } catch {
    credentials = {}
    source = 'none'
  }
  return {
    configured: Boolean(credentials.userToken) || Boolean(credentials.password && (credentials.email || credentials.mobile)),
    source,
    email: credentials.email || '',
    mobile: credentials.mobile || '',
    areaCode: credentials.areaCode || '+86',
    hasPassword: Boolean(credentials.password),
    hasUserToken: Boolean(credentials.userToken),
    tokenPresent: Boolean(state.token),
    lastLoginAt: state.lastLoginAt,
    loginKind: state.loginKind,
  }
}

function safeError (error) {
  return {
    stage: error?.stage ?? error?.name ?? 'unknown',
    message: String(error?.message ?? '操作失败').slice(0, 300),
    code: error?.meta?.code,
    status: error?.meta?.status,
  }
}

/** 导入会话使用独立工作目录，避免混进用户的项目工作区。 */
function pickCwd (ctx) {
  const dir = path.join(dataDir(), 'imported-chats')
  try {
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch { /* 建不出来再退回工作区/主目录 */ }
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      const list = registry.list()
      if (Array.isArray(list)) {
        for (const entry of list) {
          const cwd = entry?.cwd ?? entry?.path ?? entry?.root
          if (typeof cwd === 'string' && cwd !== '') return cwd
        }
      }
    }
  } catch { /* 忽略 */ }
  return os.homedir()
}

async function ensureToken () {  if (state.token) return state.token
  const { credentials } = readCredentials()
  if (credentials.userToken) {
    state.token = credentials.userToken
    state.lastLoginAt = Date.now()
    state.loginKind = 'token'
    writeJson(paths.auth, { token: state.token, deviceId: state.deviceId, at: state.lastLoginAt, kind: 'token' }, 0o600)
    return state.token
  }
  if (!credentials.password) {
    const error = new Error('请先在设置中配置 DeepSeek 网页账号（推荐填写 userToken）')
    error.stage = 'input'
    throw error
  }
  const result = await login(credentials, { preferred: credentials.preferredLogin })
  state.token = result.token
  state.deviceId = result.deviceId
  state.lastLoginAt = Date.now()
  state.loginKind = result.kind
  writeJson(paths.auth, { token: result.token, deviceId: result.deviceId, at: state.lastLoginAt, kind: result.kind }, 0o600)
  return state.token
}

/** 单会话文件：$DSH_HOME/workchat/conv/<remoteId>.json */
function convFile (sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)
  return path.join(dataDir(), 'conv', `${safe}.json`)
}

function readConv (sessionId) {
  return readJson(convFile(sessionId), null)
}

function writeConv (sessionId, value) {
  writeJson(convFile(sessionId), value, 0o600)
}

function updateIndex (sessionId, patch) {
  const cache = readJson(paths.conversations, { fetchedAt: 0, items: [] })
  const items = Array.isArray(cache.items) ? cache.items : []
  const index = items.findIndex((item) => item.id === sessionId)
  if (index >= 0) items[index] = { ...items[index], ...patch }
  else items.unshift({ id: sessionId, source: 'web', title: patch.title ?? '未命名对话', createdAt: Date.now(), ...patch })
  writeJson(paths.conversations, { fetchedAt: cache.fetchedAt ?? 0, items }, 0o600)
}

function writeSse (response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export function mountRoutes (webServer, ctx = null) {
  loadAuth()

  const routes = [
    {
      kind: 'exact',
      path: '/workchat/health',
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        sendJson(response, 200, { ok: true, version: '0.0.1' })
      },
    },

    // --------------------------------------------------- 客户端心跳 / 自检
    {
      kind: 'exact',
      path: '/workchat/client-heartbeat',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const source = typeof body === 'object' && body !== null ? body : {}
          const detail = {}
          for (const [key, value] of Object.entries(source)) {
            if (key === 'phase' || key === 'mode' || key === 'slots' || key === 'ua' || key === 'error') continue
            if (typeof value === 'string') detail[key] = value.slice(0, 120)
            else if (typeof value === 'number' || typeof value === 'boolean') detail[key] = value
            if (Object.keys(detail).length >= 20) break
          }
          state.client = {
            at: Date.now(),
            phase: typeof source.phase === 'string' ? source.phase.slice(0, 24) : 'unknown',
            mode: source.mode === 'chat' ? 'chat' : 'work',
            slots: Array.isArray(source.slots) ? source.slots.filter((s) => typeof s === 'string').slice(0, 12) : [],
            sidebar: source.sidebar === true,
            modeBar: source.modeBar === true,
            style: source.style === true,
            error: typeof source.error === 'string' ? source.error.slice(0, 200) : undefined,
            ua: typeof source.ua === 'string' ? source.ua.slice(0, 80) : '',
            detail,
          }
          sendJson(response, 200, { ok: true })
        } catch (error) {
          sendJson(response, 400, { error: 'invalid request', ...safeError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/workchat/status',
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const status = publicStatus()
        sendJson(response, 200, {
          ok: true,
          version: '0.0.1',
          configured: status.configured,
          tokenPresent: status.tokenPresent,
          loginKind: status.loginKind,
          chatting: state.chatting,
          client: state.client,
          cacheItems: (readJson(paths.conversations, { items: [] }).items ?? []).length,
        })
      },
    },
    {
      // 只读诊断：确认客户端 bundle 是否进入宿主的客户端条目图
      kind: 'exact',
      path: '/workchat/debug/client-graph',
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const out = { hasService: false }
        try {
          const service = ctx?.get?.('clientModules')
          out.hasService = Boolean(service)
          if (service && typeof service.graph === 'function') {
            const graph = service.graph()
            out.graphKeys = graph && typeof graph === 'object' ? Object.keys(graph) : []
            const serialized = JSON.stringify(graph ?? null) ?? ''
            out.includesWorkchat = serialized.includes('dsh-work-chat')
            const entries = Array.isArray(graph?.entries) ? graph.entries : (Array.isArray(graph?.rows) ? graph.rows : null)
            if (entries) {
              out.entryCount = entries.length
              out.ids = entries.map((entry) => entry?.id ?? entry?.name ?? entry?.options?.name ?? '?').slice(0, 40)
            }
          }
        } catch (error) {
          out.error = String(error?.message ?? error).slice(0, 200)
        }
        sendJson(response, 200, out)
      },
    },

    // ----------------------------------------------------------------- 凭据
    {
      kind: 'exact',
      path: '/workchat/credentials',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, publicStatus())
          return
        }
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const source = typeof body === 'object' && body !== null ? body : {}
          const previous = readJson(paths.credentials, {}) ?? {}
          const next = {
            email: typeof source.email === 'string' ? source.email.trim() : (previous.email ?? ''),
            mobile: typeof source.mobile === 'string' ? source.mobile.trim() : (previous.mobile ?? ''),
            areaCode: typeof source.areaCode === 'string' && source.areaCode.trim() !== ''
              ? source.areaCode.trim()
              : (previous.areaCode ?? '+86'),
            // 空密码表示"保持原值"，避免设置页只改邮箱时把密码清掉
            password: typeof source.password === 'string' && source.password !== ''
              ? source.password
              : (previous.password ?? ''),
            preferredLogin: source.preferredLogin === 'mobile-first' ? 'mobile-first' : (previous.preferredLogin ?? 'email-first'),
            userToken: source.clearUserToken === true
              ? ''
              : (typeof source.userToken === 'string' && source.userToken.trim() !== ''
                  ? source.userToken.trim()
                  : (previous.userToken ?? '')),
            deviceId: previous.deviceId || state.deviceId || '',
            os: previous.os || 'web',
            updatedAt: Date.now(),
          }
          writeJson(paths.credentials, next, 0o600)
          sendJson(response, 200, publicStatus())
        } catch (error) {
          sendJson(response, 400, { error: 'invalid request', ...safeError(error) })
        }
      },
    },

    // ----------------------------------------------------------------- 登录
    {
      kind: 'exact',
      path: '/workchat/login-test',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          const { credentials } = readCredentials()
          let result
          if (credentials.userToken) {
            const verified = await verifyToken(credentials.userToken)
            result = { token: credentials.userToken, deviceId: state.deviceId ?? '', kind: 'token', count: verified.count }
          } else {
            result = await login(credentials, { preferred: credentials.preferredLogin })
          }
          state.token = result.token
          state.deviceId = result.deviceId ?? state.deviceId
          state.lastLoginAt = Date.now()
          state.loginKind = result.kind
          writeJson(paths.auth, { token: result.token, deviceId: state.deviceId, at: state.lastLoginAt, kind: result.kind }, 0o600)
          const saved = readJson(paths.credentials, {}) ?? {}
          writeJson(paths.credentials, { ...saved, deviceId: state.deviceId, os: saved.os || 'web' }, 0o600)
          sendJson(response, 200, { ok: true, tokenPresent: true, kind: result.kind, at: state.lastLoginAt, count: result.count })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },

    // ----------------------------------------------------------------- 列表
    {
      kind: 'exact',
      path: '/workchat/conversations',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const refresh = (request.url ?? '').includes('refresh=1')
        if (refresh) {
          try {
            const token = await ensureToken()
            const list = await fetchConversations(token, { count: 100 })
            const previous = readJson(paths.conversations, { items: [] })
            const oldById = new Map((previous.items ?? []).map((item) => [item.id, item]))
            const merged = list.map((item) => ({
              ...item,
              thinkingEnabled: oldById.get(item.id)?.thinkingEnabled,
              searchEnabled: oldById.get(item.id)?.searchEnabled,
              preview: oldById.get(item.id)?.preview,
            }))
            writeJson(paths.conversations, { fetchedAt: Date.now(), items: merged }, 0o600)
          } catch (error) {
            sendJson(response, 502, {
              error: 'sync failed',
              ...safeError(error),
              cached: readJson(paths.conversations, { fetchedAt: 0, items: [] }),
            })
            return
          }
        }
        sendJson(response, 200, readJson(paths.conversations, { fetchedAt: 0, items: [] }))
      },
    },

    // ----------------------------------------------------------------- 历史
    {
      kind: 'exact',
      path: '/workchat/history',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          sendJson(response, 400, { error: 'sessionId required' })
          return
        }
        const cached = readConv(sessionId)
        if (url.searchParams.get('refresh') !== '1' && cached) {
          sendJson(response, 200, { messages: cached.messages ?? [], thinkingEnabled: cached.thinkingEnabled, searchEnabled: cached.searchEnabled, cached: true })
          return
        }
        try {
          const token = await ensureToken()
          const messages = await fetchHistory(token, sessionId)
          const next = {
            remoteId: sessionId,
            title: cached?.title ?? '',
            thinkingEnabled: cached?.thinkingEnabled ?? false,
            searchEnabled: cached?.searchEnabled ?? false,
            messages,
            updatedAt: Date.now(),
          }
          writeConv(sessionId, next)
          sendJson(response, 200, { messages, thinkingEnabled: next.thinkingEnabled, searchEnabled: next.searchEnabled, cached: false })
        } catch (error) {
          if (cached) {
            sendJson(response, 502, { ...safeError(error), messages: cached.messages ?? [], stale: true })
            return
          }
          sendJson(response, 502, safeError(error))
        }
      },
    },

    // ------------------------------------------------------- 思考/搜索偏好
    {
      kind: 'exact',
      path: '/workchat/chat-state',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const conv = sessionId === '' ? null : readConv(sessionId)
          sendJson(response, 200, {
            thinkingEnabled: conv?.thinkingEnabled === true,
            searchEnabled: conv?.searchEnabled === true,
          })
          return
        }
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') {
            sendJson(response, 400, { error: 'sessionId required' })
            return
          }
          const conv = readConv(sessionId) ?? { remoteId: sessionId, title: '', messages: [] }
          conv.thinkingEnabled = body?.thinkingEnabled === true
          conv.searchEnabled = body?.searchEnabled === true
          conv.updatedAt = conv.updatedAt ?? Date.now()
          writeConv(sessionId, conv)
          updateIndex(sessionId, {
            thinkingEnabled: conv.thinkingEnabled,
            searchEnabled: conv.searchEnabled,
          })
          sendJson(response, 200, { thinkingEnabled: conv.thinkingEnabled, searchEnabled: conv.searchEnabled })
        } catch (error) {
          sendJson(response, 400, { error: 'invalid request', ...safeError(error) })
        }
      },
    },

    // ----------------------------------------------------- 会话操作（网页端）
    {
      kind: 'exact',
      path: '/workchat/session/rename',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const title = typeof body?.title === 'string' ? body.title.trim() : ''
          if (sessionId === '' || title === '') {
            sendJson(response, 400, { error: 'sessionId and title required' })
            return
          }
          const token = await ensureToken()
          const result = await renameSession(token, sessionId, title)
          updateIndex(sessionId, { title: result.title, updatedAt: result.updatedAt || Date.now() })
          const conv = readConv(sessionId)
          if (conv) writeConv(sessionId, { ...conv, title: result.title, updatedAt: Date.now() })
          sendJson(response, 200, { ok: true, title: result.title })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/workchat/session/pin',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds.filter((id) => typeof id === 'string') : []
          if (sessionIds.length === 0) {
            sendJson(response, 400, { error: 'sessionIds required' })
            return
          }
          const pinned = body?.pinned === true
          const token = await ensureToken()
          const result = await setPinned(token, sessionIds, pinned)
          for (const id of sessionIds) updateIndex(id, { pinned })
          sendJson(response, 200, { ok: true, pinned, illegal: result.illegal, ignored: result.ignored })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/workchat/session/delete',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds.filter((id) => typeof id === 'string') : []
          if (sessionIds.length === 0) {
            sendJson(response, 400, { error: 'sessionIds required' })
            return
          }
          const token = await ensureToken()
          await deleteSessions(token, sessionIds)
          // 清理本地缓存与单会话文件
          const cache = readJson(paths.conversations, { fetchedAt: 0, items: [] })
          const remaining = (cache.items ?? []).filter((item) => !sessionIds.includes(item.id))
          writeJson(paths.conversations, { fetchedAt: cache.fetchedAt ?? 0, items: remaining }, 0o600)
          for (const id of sessionIds) {
            try { fs.rmSync(convFile(id), { force: true }) } catch { /* 忽略 */ }
          }
          sendJson(response, 200, { ok: true, deleted: sessionIds })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/workchat/session/share',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const sessionId = url.searchParams.get('sessionId') ?? undefined
            const token = await ensureToken()
            const shares = await listShares(token, sessionId)
            sendJson(response, 200, { ok: true, shares })
          } catch (error) {
            sendJson(response, 502, { ok: false, ...safeError(error) })
          }
          return
        }
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') {
            sendJson(response, 400, { error: 'sessionId required' })
            return
          }
          const token = await ensureToken()
          const messageIds = await fetchMessageIds(token, sessionId)
          const share = await createShare(token, sessionId, messageIds)
          sendJson(response, 200, { ok: true, shareId: share.shareId, url: share.url })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/workchat/session/share/delete',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const shareId = typeof body?.shareId === 'string' ? body.shareId : ''
          if (shareId === '') {
            sendJson(response, 400, { error: 'shareId required' })
            return
          }
          const token = await ensureToken()
          await deleteShare(token, shareId)
          sendJson(response, 200, { ok: true })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },

    // --------------------------------------------- 导入为真实 DSH 会话（方案 B）
    {
      kind: 'exact',
      path: '/workchat/import',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') {
            sendJson(response, 400, { ok: false, error: 'sessionId required' })
            return
          }
          const persistence = ctx?.get?.('sessionPersistence')
          if (!persistence) {
            sendJson(response, 501, { ok: false, stage: 'unsupported', message: '宿主没有 sessionPersistence 服务' })
            return
          }
          // 已导入过且会话还在就直接复用
          const cache = readJson(paths.conversations, { items: [] })
          const cachedItem = (cache.items ?? []).find((item) => item.id === sessionId)
          if (cachedItem?.dshSessionId) {
            try {
              const stat = typeof persistence.stat === 'function' ? await persistence.stat(cachedItem.dshSessionId) : null
              if (stat !== undefined && stat !== null) {
                sendJson(response, 200, { ok: true, dshSessionId: cachedItem.dshSessionId, reused: true })
                return
              }
            } catch { /* 读不到就重新导入 */ }
          }

          const token = await ensureToken()
          const messages = await fetchHistory(token, sessionId)
          if (messages.length === 0) {
            sendJson(response, 502, { ok: false, stage: 'empty', message: '该对话没有可导入的消息' })
            return
          }
          const title = cachedItem?.title ?? 'DeepSeek 网页对话'
          const result = await writeImportedSession(persistence, {
            title,
            messages,
            cwd: pickCwd(ctx),
          })
          updateIndex(sessionId, { dshSessionId: result.id })
          sendJson(response, 200, {
            ok: true,
            dshSessionId: result.id,
            version: result.version,
            eventCount: result.eventCount,
            messages: messages.length,
          })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },

    // ------------------------------------------------- 导入结果回读（诊断）
    {
      kind: 'exact',
      path: '/workchat/import/probe',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        try {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const id = url.searchParams.get('id') ?? ''
          const persistence = ctx?.get?.('sessionPersistence')
          if (!persistence || typeof persistence.open !== 'function') {
            sendJson(response, 501, { ok: false, stage: 'unsupported' })
            return
          }
          if (id === '') {
            sendJson(response, 400, { ok: false, error: 'id required' })
            return
          }
          const handle = await persistence.open(id, 'read')
          const result = await handle.read()
          const events = Array.isArray(result?.events) ? result.events : []
          const types = {}
          for (const event of events) types[event?.type ?? '?'] = (types[event?.type ?? '?'] ?? 0) + 1
          if (typeof handle.close === 'function') await handle.close()
          sendJson(response, 200, { ok: true, eventCount: events.length, types })
        } catch (error) {
          sendJson(response, 502, { ok: false, ...safeError(error) })
        }
      },
    },

    // ------------------------------------------- vendor 静态资源（MD/LaTeX）
    {
      kind: 'prefix',
      path: '/workchat/assets',
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const relative = decodeURIComponent(url.pathname.replace(/^\/workchat\/assets\/?/, ''))
        const types = {
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.woff2': 'font/woff2',
          '.woff': 'font/woff',
          '.ttf': 'font/ttf',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
        }
        const ext = path.extname(relative).toLowerCase()
        if (!(ext in types) || relative.includes('..')) {
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('not found')
          return
        }
        const file = path.join(PACKAGE_ROOT, 'assets', relative)
        fs.stat(file, (error, stat) => {
          if (error !== null || !stat.isFile()) {
            response.writeHead(404, { 'content-type': 'text/plain' })
            response.end('not found')
            return
          }
          response.writeHead(200, {
            'content-type': types[ext],
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': stat.size,
          })
          if (request.method === 'HEAD') { response.end(); return }
          fs.createReadStream(file).pipe(response)
        })
      },
    },

    // ----------------------------------------------------------------- 聊天
    {
      kind: 'exact',
      path: '/workchat/chat',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        if (state.chatting) {
          sendJson(response, 409, { error: 'busy' })
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, { error: 'invalid body', ...safeError(error) })
          return
        }
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          sendJson(response, 400, { error: 'empty prompt' })
          return
        }

        state.chatting = true
        const controller = new AbortController()
        request.on('close', () => controller.abort())

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })

        const sessionId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null
        const thinkingEnabled = body?.thinkingEnabled === true
        const searchEnabled = body?.searchEnabled === true
        let resolvedId = sessionId
        let assistantText = ''
        let assistantThinking = ''
        let resolvedTitle = ''
        let lastResponseMessageId = null

        const convs = readJson(paths.conversations, { fetchedAt: 0, items: [] })
        const cachedTitle = (convs.items ?? []).find((item) => item.id === sessionId)?.title
        const existing = sessionId ? readConv(sessionId) : null
        // 续聊需要带上一轮助手消息 id，网页端才知道接在哪个分支之后
        const parentMessageId = typeof existing?.lastResponseMessageId === 'number'
          ? existing.lastResponseMessageId
          : undefined

        writeSse(response, { type: 'open', sessionId })

        try {
          let token = await ensureToken()
          let iterator = streamCompletion(token, {
            sessionId,
            prompt,
            thinkingEnabled,
            searchEnabled,
            parentMessageId,
          }, { signal: controller.signal })

          let retriedAuth = false
          while (true) {
            let step
            try {
              step = await iterator.next()
            } catch (error) {
              if (error?.unauthorized === true && !retriedAuth) {
                retriedAuth = true
                state.token = null
                token = await ensureToken()
                iterator = streamCompletion(token, { sessionId: resolvedId, prompt, thinkingEnabled, searchEnabled, parentMessageId }, { signal: controller.signal })
                continue
              }
              throw error
            }
            if (step.done) break
            const event = step.value
            if (event.type === 'meta') {
              resolvedId = event.sessionId
              writeSse(response, { type: 'meta', sessionId: resolvedId })
            } else if (event.type === 'ready') {
              if (typeof event.responseMessageId === 'number') lastResponseMessageId = event.responseMessageId
              writeSse(response, { type: 'ready', responseMessageId: lastResponseMessageId ?? null })
            } else if (event.type === 'title') {
              resolvedTitle = event.title
              writeSse(response, { type: 'title', title: resolvedTitle })
            } else if (event.type === 'delta') {
              assistantText += event.text
              writeSse(response, { type: 'delta', text: event.text })
            } else if (event.type === 'thinking') {
              assistantThinking += event.text
              writeSse(response, { type: 'thinking', text: event.text })
            }
          }

          // 落盘：优先用服务端历史做权威数据，失败时退回本地拼装
          if (resolvedId) {
            let messages = null
            try {
              messages = await fetchHistory(token, resolvedId)
            } catch { /* 用本地拼装兜底 */ }
            if (!Array.isArray(messages) || messages.length === 0) {
              messages = Array.isArray(existing?.messages) ? [...existing.messages] : []
              messages.push({ role: 'user', content: prompt, at: Date.now() })
              messages.push({
                role: 'assistant',
                content: assistantText,
                thinking: assistantThinking === '' ? undefined : assistantThinking,
                at: Date.now(),
              })
            }
            const title = resolvedTitle || cachedTitle || prompt.slice(0, 24)
            writeConv(resolvedId, {
              remoteId: resolvedId,
              title,
              thinkingEnabled,
              searchEnabled,
              lastResponseMessageId,
              messages,
              updatedAt: Date.now(),
            })
            updateIndex(resolvedId, {
              title,
              updatedAt: Date.now(),
              preview: assistantText.slice(0, 60),
              thinkingEnabled,
              searchEnabled,
            })
          }

          writeSse(response, { type: 'done', sessionId: resolvedId, title: resolvedTitle || cachedTitle || null, fallback: false })
          response.end()
        } catch (error) {
          const stage = error?.stage ?? 'unknown'
          const fallback = stage === 'network' || stage === 'auth' || stage === 'rate-limited' || stage === 'input'
          writeSse(response, { type: 'error', ...safeError(error), fallback })
          response.end()
        } finally {
          state.chatting = false
        }
      },
    },
  ]

  const disposers = routes.map((route) => {
    try {
      return webServer.register(route)
    } catch (error) {
      console.warn(`[workchat] 路由注册失败 ${route.path}: ${error?.message ?? error}`)
      return null
    }
  }).filter(Boolean)
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载期忽略 */ }
    }
  }
}
