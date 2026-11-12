/**
 * 把网页端对话导入成真实的 DSH 会话。
 *
 * 这样对话内容直接由 DSH 自己的会话界面渲染（排版、Markdown、代码块、工具卡片
 * 全部原生），不再需要我们自绘面板。
 *
 * 事件序列与字段取自 DSH 会话格式 v4（并兼容 v2/v3 的差异）：
 *   session/title → (turn/start → step/start → user/message
 *                    → assistant/message → step/end → turn/end)* → session/end-seed
 * 其中消息事件带 `surfaceOp: "append"`，assistant 消息在 v2+ 需要 `stream: []`。
 */
import { randomUUID } from 'node:crypto'

const EMPTY_PROMPT = '（这条消息在 DeepSeek 网页端没有文字）'
const EMPTY_ANSWER = '（这条回复在 DeepSeek 网页端没有正文）'

/**
 * 读出本机 DSH 正在使用的会话格式版本。
 * @param {any} persistence sessionPersistence 服务
 * @returns {Promise<number>}
 */
export async function resolveFormatVersion (persistence) {
  try {
    const listed = await persistence.list()
    for (const item of Array.isArray(listed) ? listed : []) {
      const header = item && item.header !== undefined ? item.header : item
      if (header && Number.isInteger(header.version) && header.version >= 0) return header.version
    }
  } catch { /* 列不出就按当前版本写 */ }
  return 4
}

/**
 * 把归一化后的消息翻译成 DSH 会话事件。
 * @param {Array<{role: string, content: string, thinking?: string, at?: number}>} messages
 * @param {string} title
 * @param {number} version
 */
export function buildSessionEvents (messages, title, version) {
  const events = []
  let seq = 0
  let lastTime = 0
  let turn = 0
  let openStep = false
  const base = messages.find((message) => Number(message.at) > 0)?.at ?? Date.now()
  const useStream = version >= 2

  const push = (type, data, surfaceOp, time) => {
    const wanted = Number.isFinite(time) && time > 0 ? time : (lastTime || base)
    const at = Math.max(wanted, lastTime)
    lastTime = at
    const event = { type, seq, time: at, data }
    seq += 1
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
  }

  push('session/title', {
    title: title && title.trim() !== '' ? title.trim() : 'DeepSeek 网页对话',
    messageSeqs: [],
    source: { kind: 'user' },
  })

  for (const message of messages) {
    const time = message.at
    if (message.role === 'user') {
      if (openStep) {
        push('step/end', { turn, step: 1 }, undefined, time)
        push('turn/end', { turn, reason: { kind: 'completed' } }, undefined, time)
        openStep = false
      }
      turn += 1
      push('turn/start', { turn }, undefined, time)
      push('step/start', { turn, step: 1 }, undefined, time)
      push('user/message', {
        id: `msg-${turn}-u`,
        role: 'user',
        content: [{ type: 'text', text: message.content && message.content.trim() !== '' ? message.content : EMPTY_PROMPT }],
        source: { kind: 'user' },
      }, 'append', time)
      openStep = true
      continue
    }

    if (!openStep) {
      turn += 1
      push('turn/start', { turn }, undefined, time)
      push('step/start', { turn, step: 1 }, undefined, time)
      openStep = true
    }
    const blocks = []
    if (message.thinking) blocks.push({ type: 'reasoning', text: message.thinking })
    if (message.content) blocks.push({ type: 'text', text: message.content })
    if (blocks.length === 0) blocks.push({ type: 'text', text: EMPTY_ANSWER })
    const data = {
      turn,
      step: 1,
      message: {
        id: `msg-${turn}-a`,
        role: 'assistant',
        content: blocks,
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    }
    if (useStream) data.stream = []
    push('assistant/message', data, 'append', time)
    push('step/end', { turn, step: 1 }, undefined, time)
    push('turn/end', { turn, reason: { kind: 'completed' } }, undefined, time)
    openStep = false
  }

  push('session/end-seed', {})
  return events
}

/**
 * 写入一个新会话，返回会话 id。
 * @param {any} persistence sessionPersistence 服务
 * @param {{title: string, messages: object[], cwd: string}} input
 */
export async function writeImportedSession (persistence, input) {
  const version = await resolveFormatVersion(persistence)
  const id = randomUUID()
  const header = {
    version,
    id,
    createdAt: Date.now(),
    cwd: input.cwd,
    isSeeded: false,
  }
  if (version >= 4) header.delegationDepth = 0

  const events = buildSessionEvents(input.messages, input.title, version)
  const created = await persistence.create(header)

  if (created && typeof created.append === 'function') {
    await created.append(events)
    if (typeof created.flush === 'function') await created.flush()
    if (typeof created.close === 'function') await created.close()
  } else if (typeof persistence.append === 'function') {
    await persistence.append(id, events)
  } else {
    throw new Error('sessionPersistence 既没有可写句柄，也没有 append')
  }

  return { id, version, eventCount: events.length }
}
