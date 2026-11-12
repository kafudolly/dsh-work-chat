/**
 * 侧栏注入的 DOM 集成测试（不启动浏览器）。
 *
 * 用一个最小 DOM 桩模拟 DSH 侧栏结构：
 *   body
 *   └─ div.regionArea
 *      └─ div[data-slot="sidebar.workspaces"]
 * 以及空白会话页：div[data-phase="hero"]
 *
 * 断言：
 *   1. 工作区区头插在原生槽位之前；
 *   2. 对话区（区头+列表）插在原生槽位之后；
 *   3. 点击区头会切换 html[data-workchat-collapsed-*] 并写 localStorage；
 *   4. 模式开关条挂到 hero 的第一个子节点；
 *   5. 开关点击会更新模式与 html[data-workchat-mode]。
 *
 * 用法：node tools/smoke-sidebar.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const kebab = (name) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
const SEL_RE = /^\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/

class El {
  constructor(tag) {
    this.tagName = tag
    this.attrs = Object.create(null)
    this.children = []
    this.parent = null
    this.hidden = false
    this.id = ''
    this.type = ''
    this.style = {}
    this._text = ''
    this._listeners = Object.create(null)
    this._dataset = Object.create(null)
    const self = this
    this.dataset = new Proxy(this._dataset, {
      get: (target, key) => target[key],
      set: (target, key, value) => {
        target[key] = String(value)
        self.attrs[`data-${kebab(key)}`] = String(value)
        return true
      },
      deleteProperty: (target, key) => {
        delete target[key]
        delete self.attrs[`data-${kebab(key)}`]
        return true
      },
      has: (target, key) => key in target,
    })
  }

  get isConnected() { return this.parent !== null || this === documentStub.body }
  get parentElement() { return this.parent }
  get firstElementChild() { return this.children[0] ?? null }
  get nextSibling() {
    if (this.parent === null) return null
    const index = this.parent.children.indexOf(this)
    return this.parent.children[index + 1] ?? null
  }

  set textContent(value) {
    this._text = String(value)
    for (const child of this.children) child.parent = null
    this.children = []
  }
  get textContent() { return this._text }

  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }
  insertBefore(child, reference) {
    child.parent = this
    const index = reference == null ? this.children.length : this.children.indexOf(reference)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    return child
  }
  after(node) {
    if (this.parent === null) return
    const index = this.parent.children.indexOf(this)
    this.parent.children.splice(index + 1, 0, node)
    node.parent = this.parent
  }
  remove() {
    if (this.parent === null) return
    const index = this.parent.children.indexOf(this)
    if (index >= 0) this.parent.children.splice(index, 1)
    this.parent = null
  }
  getBoundingClientRect() { return { left: 10, right: 210, top: 40, bottom: 64, width: 200, height: 24 } }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] ?? null }
  addEventListener(type, handler) {
    ;(this._listeners[type] ||= []).push(handler)
  }
  click() {
    for (const handler of this._listeners.click ?? []) {
      handler({ target: this, preventDefault() {}, stopPropagation() {}, key: '', nativeEvent: {} })
    }
  }

  matches(selector) {
    const match = SEL_RE.exec(selector.trim())
    if (match === null) return selector === this.tagName
    const [, name, value] = match
    if (!(name in this.attrs)) return false
    return value === undefined ? true : this.attrs[name] === value
  }

  *walk() {
    for (const child of this.children) {
      yield child
      yield * child.walk()
    }
  }

  querySelectorAll(selector) { return [...this.walk()].filter((node) => node.matches(selector)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}

const body = new El('body')
const documentStub = {
  head: new El('head'),
  body,
  documentElement: new El('html'),
  visibilityState: 'visible',
  createElement: (tag) => new El(tag),
  querySelector: (selector) => body.querySelector(selector) ?? documentStub.documentElement.querySelector(selector),
  querySelectorAll: (selector) => [...body.querySelectorAll(selector), ...documentStub.documentElement.querySelectorAll(selector)],
  addEventListener() {},
  removeEventListener() {},
}

// ---- 模拟宿主结构 ---------------------------------------------------------
const region = new El('div')
const slot = new El('div')
slot.dataset.slot = 'sidebar.workspaces'
region.appendChild(slot)
body.appendChild(region)

const mainColumn = new El('div')
const mainOutlet = new El('div')
mainOutlet.dataset.slot = 'main'
mainColumn.appendChild(mainOutlet)
body.appendChild(mainColumn)

const hero = new El('div')
hero.dataset.phase = 'hero'
const heroChild = new El('div')
hero.appendChild(heroChild)
body.appendChild(hero)

const localStorageStub = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, String(value)) },
  removeItem(key) { this.store.delete(key) },
}

const ReactStub = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useCallback: (fn) => fn,
  Fragment: 'fragment',
}

const sandbox = {
  window: {
    localStorage: localStorageStub,
    __selectCalls: [],
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load(definition) {
        const plugin = definition.factory((id) => {
          if (id === 'react') return ReactStub
          throw new Error(`未预期的 require(${id})`)
        })
        plugin.apply({
          slots: { inject(_name, fn) { fn() }, register() { return () => {} } },
          layout: { selectPanel(id) { sandbox.window.__selectCalls.push(id) } },
          effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
          get() { return undefined },
        })
      },
    },
  },
  document: documentStub,
  localStorage: localStorageStub,
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: (fn) => { fn(); return 0 },
  cancelAnimationFrame: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async (url) => {
    if (String(url).includes('/workchat/conversations')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          fetchedAt: Date.now(),
          items: [
            { id: 'conv-a', title: '测试对话 A', updatedAt: Date.now(), pinned: false },
            { id: 'conv-b', title: '置顶对话 B', updatedAt: Date.now() - 86_400_000, pinned: true },
          ],
        }),
      }
    }
    return { ok: false, status: 502, text: async () => JSON.stringify({ stage: 'input' }) }
  },
  console,
}

vm.createContext(sandbox)
new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

// 等待一次注入（客户端用 setTimeout 调度）
await new Promise((resolve) => setTimeout(resolve, 120))

// ---- 断言 -----------------------------------------------------------------
const problems = []

const workspacesSection = region.querySelector('[data-workchat-section="workspaces"]')
const workspacesHeader = region.querySelector('[data-workchat-header="workspaces"]')
const conversations = region.querySelector('[data-workchat-section="conversations"]')
const conversationsList = region.querySelector('[data-workchat-list="conversations"]')

if (workspacesSection === null) problems.push('工作区区头未插入')
else {
  const index = region.children.indexOf(workspacesSection)
  const slotIndex = region.children.indexOf(slot)
  if (index > slotIndex) problems.push('工作区区头应位于原生槽位之前')
}
if (workspacesHeader === null) problems.push('工作区区头按钮缺失')
if (conversations === null) problems.push('对话区未插入')
else {
  const index = region.children.indexOf(conversations)
  const slotIndex = region.children.indexOf(slot)
  if (index < slotIndex) problems.push('对话区应位于原生槽位之后')
}
if (conversationsList === null) problems.push('对话区列表容器缺失')
if (conversations !== null && conversations.querySelector('[data-workchat-refresh="conversations"]') === null) {
  problems.push('对话区缺少同步刷新按钮')
}

// 折叠切换
if (workspacesHeader !== null) {
  workspacesHeader.click()
  const collapsed = documentStub.documentElement.dataset.workchatCollapsedWorkspaces
  if (collapsed !== '1') problems.push(`点击后折叠标记应为 1，实际 ${collapsed}`)
  if (localStorageStub.getItem('workchat.collapsed.workspaces') !== '1') problems.push('折叠状态未写入 localStorage')
  workspacesHeader.click()
  if (documentStub.documentElement.dataset.workchatCollapsedWorkspaces !== '0') problems.push('再次点击未展开')
}

// 模式开关条
const modeBar = mainColumn.querySelector('[data-workchat-mode-bar]')
if (modeBar === null) problems.push('模式开关条未挂到主内容列')

const chatButton = modeBar?.querySelector('[data-workchat-mode-option="chat"]')
if (chatButton === undefined || chatButton === null) problems.push('找不到 Chat 按钮')
else {
  chatButton.click()
  if (documentStub.documentElement.dataset.workchatMode !== 'chat') {
    problems.push(`点击 Chat 后 html[data-workchat-mode] 应为 chat，实际 ${documentStub.documentElement.dataset.workchatMode}`)
  }
}

// 等列表数据加载（fetch 桩是同步 resolve 的异步函数）
await new Promise((resolve) => setTimeout(resolve, 50))

const rows = body.querySelectorAll('[data-workchat-row]')
if (rows[0]?.dataset?.workchatRow !== 'conv-b') problems.push('置顶对话应排在第一行')
if (rows.length !== 2) problems.push(`应渲染 2 行对话，实际 ${rows.length}`)

const groupLabels = body.querySelectorAll('[data-workchat-group]').map((node) => node.textContent)
if (!groupLabels.includes('置顶')) problems.push('缺少「置顶」分组')
if (!groupLabels.includes('今天')) problems.push('缺少「今天」分组')

const moreButton = rows[0]?.querySelector('[data-workchat-more]')
if (!moreButton) {
  problems.push('行内缺少 ⋯ 按钮')
} else {
  moreButton.click()
  const menu = body.querySelector('[data-workchat-menu]')
  if (!menu) {
    problems.push('点击 ⋯ 未弹出菜单')
  } else {
    const labels = menu.querySelectorAll('button').map((node) => node.textContent)
    // 第一行是置顶项，菜单里应是「取消置顶」
    if (!labels.includes('取消置顶')) problems.push('置顶行的菜单应显示「取消置顶」')
    for (const label of ['重命名', '分享', '多选', '删除']) {
      if (!labels.includes(label)) problems.push('菜单缺少「' + label + '」')
    }
    const multi = menu.querySelectorAll('button').find((node) => node.textContent === '多选')
    multi?.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const bulk = body.querySelector('[data-workchat-bulk]')
    if (!bulk || bulk.hidden !== false) problems.push('多选栏未显示')
    const checks = body.querySelectorAll('[data-workchat-check]')
    if (checks.length !== 2) problems.push(`多选模式应有 2 个复选框，实际 ${checks.length}`)
  }
}

// 退出多选，再点一行，验证点击能打开面板
const cancelButton = body.querySelector('[data-workchat-bulk]')?.querySelectorAll('button').find((node) => node.textContent === '取消')
cancelButton?.click()
await new Promise((resolve) => setTimeout(resolve, 20))
const firstRow = body.querySelector('[data-workchat-row]')
firstRow?.click()
await new Promise((resolve) => setTimeout(resolve, 30))
const selectCalls = sandbox.window.__selectCalls ?? []
if (!selectCalls.includes('workchat')) problems.push('点击对话行没有调用 selectPanel(\'workchat\')')

console.log(JSON.stringify({
  ok: problems.length === 0,
  problems,
  regionChildren: region.children.map((node) => node.dataset.workchatHeader ?? node.dataset.workchatSection ?? node.dataset.slot ?? node.tagName),
  modeBarInColumn: Boolean(mainColumn.querySelector('[data-workchat-mode-bar]')),
  mode: documentStub.documentElement.dataset.workchatMode ?? null,
}, null, 2))

if (problems.length > 0) process.exit(1)
