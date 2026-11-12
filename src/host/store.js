/**
 * 持久化：插件数据统一放 $DSH_HOME/workchat/，凭据与 token 文件权限 0600。
 *
 * 文件分工：
 *   credentials.json   设置页写入的运行期账号（含密码，明文，0600）
 *   auth.json          登录换来的 userToken + 时间戳（不含密码）
 *   conversations.json 网页端会话列表缓存
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function dshHome () {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function dataDir () {
  return path.join(dshHome(), 'workchat')
}

export const paths = {
  get credentials () { return path.join(dataDir(), 'credentials.json') },
  get auth () { return path.join(dataDir(), 'auth.json') },
  get conversations () { return path.join(dataDir(), 'conversations.json') },
  /** 开发测试夹具：仅在设置页未配置时作为兜底读取 */
  get localCredentials () { return path.join(PACKAGE_ROOT, 'secrets', 'deepseek-credentials.json') },
}

export function readJson (file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson (file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  fs.renameSync(tmp, file)
}
