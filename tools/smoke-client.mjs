/**
 * 客户端 bundle 冒烟测试（不启动浏览器）。
 *
 * 用最小化的 window/document/React 桩执行 client.js 的 factory 与 apply，
 * 断言四个槽位注册都发生、且没有抛错。
 *
 * 用法：node tools/smoke-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const registrations = []
let effectRuns = 0

function fakeElement() {
  const node = {
    dataset: {},
    style: {},
    children: [],
    hidden: false,
    id: '',
    textContent: '',
    append(...nodes) { node.children.push(...nodes) },
    appendChild(child) { node.children.push(child); return child },
    insertBefore(child) { node.children.push(child); return child },
    remove() {},
    setAttribute() {},
    addEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    isConnected: true,
    after() {},
  }
  return node
}

const documentStub = {
  head: fakeElement(),
  body: fakeElement(),
  documentElement: { dataset: {} },
  visibilityState: 'visible',
  createElement: () => fakeElement(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}

const localStorageStub = {
  store: new Map([['workchat.mode', 'chat']]),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, String(value)) },
  removeItem(key) { this.store.delete(key) },
}

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
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
    __ModuleLoader__: {
      load(definition) {
        if (!definition || typeof definition.factory !== 'function') {
          throw new Error('ModuleLoader.load 收到非法定义')
        }
        const plugin = definition.factory((id) => {
          if (id === 'react') return ReactStub
          throw new Error(`未预期的 require(${id})`)
        })
        if (!plugin || typeof plugin.apply !== 'function') throw new Error('factory 没有返回 apply')
        runApply(plugin)
      },
    },
  },
  document: documentStub,
  localStorage: localStorageStub,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: (fn) => { fn(); return 0 },
  cancelAnimationFrame: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({ ok: false, status: 500, text: async () => '{}' }),
  console,
}

function runApply(plugin) {
  const ctx = {
    slots: {
      inject(_name, fn) { fn() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    layout: { selectPanel() {} },
    effect(fn) {
      effectRuns += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() { return undefined },
  }
  plugin.apply(ctx)
}

vm.createContext(sandbox)
new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

const slots = registrations.map((item) => item.options?.name).filter(Boolean)
const expected = ['settings.section', 'main', 'conversation.composer']
const missing = expected.filter((name) => !slots.includes(name))
const panic = []

if (missing.length > 0) panic.push(`缺少槽位注册：${missing.join(', ')}`)
if (!registrations.some((item) => item.options?.name === 'main' && item.options?.key === 'workchat')) {
  panic.push('main 面板缺少 key=workchat')
}
if (registrations.every((item) => typeof item.component !== 'function')) {
  panic.push('没有任何组件被注册')
}

console.log(JSON.stringify({
  registeredSlots: slots,
  mainKey: registrations.find((item) => item.options?.name === 'main')?.options?.key ?? null,
  effects: effectRuns,
  ok: panic.length === 0,
  problems: panic,
}, null, 2))

if (panic.length > 0) process.exit(1)
