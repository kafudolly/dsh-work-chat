/**
 * dsh-work-chat —— Host 入口
 *
 * 职责：在宿主 webServer 就绪后挂载 /workchat/* 路由，供浏览器端
 * 读写凭据、测试登录、拉取网页端对话缓存。
 *
 * 浏览器端（client.js）只访问同源回环路由，不直接出网。
 */
import { mountRoutes } from './src/host/routes.js'

export const name = 'dsh-work-chat'

/**
 * @param {any} ctx cordis 宿主上下文
 */
export function apply (ctx) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => mountRoutes(host.webServer, host), 'dsh-work-chat: http routes')
  })
}
