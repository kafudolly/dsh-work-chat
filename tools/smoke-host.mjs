/**
 * 宿主插件冒烟测试：用最小 ctx 执行 index.js 的 apply，断言路由全部挂上。
 * 用法：node tools/smoke-host.mjs
 */
import { apply } from '../index.js'

const registered = []
const webServer = {
  register(route) {
    registered.push(route)
    return () => {}
  },
}

const ctx = {
  inject(services, callback) {
    if (!services.includes('webServer')) throw new Error('缺少 webServer 依赖声明')
    callback({
      webServer,
      effect(fn) { fn() },
    })
  },
}

apply(ctx)

const paths = registered.map((route) => route.path).sort()
const expected = [
  '/workchat/health',
  '/workchat/client-heartbeat',
  '/workchat/status',
  '/workchat/credentials',
  '/workchat/login-test',
  '/workchat/conversations',
  '/workchat/history',
  '/workchat/chat-state',
  '/workchat/chat',
]

const missing = expected.filter((path) => !paths.includes(path))
console.log(JSON.stringify({ count: paths.length, paths, missing, ok: missing.length === 0 }, null, 2))
if (missing.length > 0) process.exit(1)
