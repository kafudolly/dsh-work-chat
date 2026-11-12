/**
 * 会话操作端到端验证（重命名 / 置顶 / 分享 / 删除）。
 *
 * 全程使用一条**自己新建**的临时会话，避免动到用户已有对话：
 *   建会话 → 发一句 → 重命名 → 置顶 → 取消置顶 → 分享 → 删除分享 → 删除会话
 *
 * 只打印布尔结果与耗时，不打印标题、消息正文或分享链接。
 *
 * 用法：node tools/probe-ops.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSession,
  deleteShare,
  deleteSessions,
  fetchConversations,
  createShare,
  fetchMessageIds,
  listShares,
  renameSession,
  setPinned,
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

const problems = []
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) problems.push(name)
}

const startedAt = Date.now()
const sessionId = await createSession(token)
console.log('已创建临时会话')

// 发一句话，让会话有内容可分享
let reply = ''
for await (const event of streamCompletion(token, {
  sessionId,
  prompt: '只回复两个字：收到',
  thinkingEnabled: false,
  searchEnabled: false,
})) {
  if (event.type === 'delta') reply += event.text
}
check('发送消息', reply.length > 0, `回复 ${reply.length} 字`)

// 重命名
const renamed = await renameSession(token, sessionId, 'workchat 操作验证')
check('重命名', renamed.title === 'workchat 操作验证', `title=${renamed.title}`)

// 置顶
await setPinned(token, [sessionId], true)
let list = await fetchConversations(token, { count: 100 })
let item = list.find((entry) => entry.id === sessionId)
check('置顶', item?.pinned === true, `pinned=${item?.pinned}`)

// 取消置顶
await setPinned(token, [sessionId], false)
list = await fetchConversations(token, { count: 100 })
item = list.find((entry) => entry.id === sessionId)
check('取消置顶', item?.pinned === false, `pinned=${item?.pinned}`)

// 分享
const messageIds = await fetchMessageIds(token, sessionId)
check('取消息 id', messageIds.length > 0, `${messageIds.length} 条`)
const share = await createShare(token, sessionId, messageIds)
check('创建分享', typeof share.url === 'string' && share.url.includes('/share/'), `urlLen=${share.url.length}`)
const shares = await listShares(token, sessionId)
check('分享列表包含新链接', shares.some((entry) => entry.shareId === share.shareId), `${shares.length} 条`)
await deleteShare(token, share.shareId)
const afterDelete = await listShares(token, sessionId)
check('删除分享', !afterDelete.some((entry) => entry.shareId === share.shareId))

// 删除会话
await deleteSessions(token, [sessionId])
const finalList = await fetchConversations(token, { count: 100 })
check('删除会话', !finalList.some((entry) => entry.id === sessionId))

console.log(JSON.stringify({ ok: problems.length === 0, problems, ms: Date.now() - startedAt }, null, 2))
if (problems.length > 0) process.exit(1)
