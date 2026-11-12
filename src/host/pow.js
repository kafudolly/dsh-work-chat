/**
 * DeepSeek 网页端 PoW（Proof of Work）求解。
 *
 * 网页端在 `POST /api/v0/chat/completion` 前要求 `x-ds-pow-response` 头：
 *   1. POST /api/v0/chat/create_pow_challenge 拿到 challenge；
 *   2. 用网页端自己的 wasm（DeepSeekHashV1）求解 answer；
 *   3. 把 {algorithm, challenge, salt, answer, signature, target_path} 的 JSON
 *      做 base64，作为请求头。
 *
 * 哈希算法是网页端定制的浮点累加，官方用 wasm 实现；这里直接跑同一份 wasm
 * （Node 内置 WebAssembly，无需额外依赖），而不是重写算法。
 *
 * wasm 的获取：优先读 $DSH_HOME/workchat 下的缓存；没有则从网页端主脚本里
 * 发现带内容哈希的文件名并下载缓存。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './store.js'
import { BROWSER_HEADERS } from './auth.js'

const WASM_RE = /static\/sha3_wasm_bg\.[0-9a-f]+\.wasm/
const MAIN_RE = /https:\/\/fe-static\.deepseek\.com\/chat\/static\/main\.[0-9a-f]+\.js/

export function cachedWasmPath () {
  try {
    const hit = fs.readdirSync(dataDir()).find((name) => /^sha3_wasm_bg\..*\.wasm$/.test(name))
    return hit ? path.join(dataDir(), hit) : null
  } catch {
    return null
  }
}

/** 返回 wasm 字节；必要时从网页端发现并缓存。 */
export async function ensureWasm (options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  if (options.force !== true) {
    const hit = cachedWasmPath()
    if (hit) return fs.readFileSync(hit)
  }

  const htmlResponse = await fetchImpl('https://chat.deepseek.com/', {
    headers: { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml' },
  })
  if (!htmlResponse.ok) throw new Error(`拿不到网页端首页（HTTP ${htmlResponse.status}）`)
  const html = await htmlResponse.text()

  const mainMatch = MAIN_RE.exec(html)
  if (mainMatch === null) throw new Error('网页端首页里找不到主脚本地址')

  const jsResponse = await fetchImpl(mainMatch[0], { headers: BROWSER_HEADERS })
  if (!jsResponse.ok) throw new Error(`拿不到主脚本（HTTP ${jsResponse.status}）`)
  const js = await jsResponse.text()

  const wasmMatch = WASM_RE.exec(js)
  if (wasmMatch === null) throw new Error('主脚本里找不到 PoW wasm 地址')

  const url = `https://fe-static.deepseek.com/chat/${wasmMatch[0]}`
  const wasmResponse = await fetchImpl(url, { headers: BROWSER_HEADERS })
  if (!wasmResponse.ok) throw new Error(`下载 PoW wasm 失败（HTTP ${wasmResponse.status}）`)
  const bytes = Buffer.from(await wasmResponse.arrayBuffer())

  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(path.join(dataDir(), path.basename(wasmMatch[0])), bytes)
  return bytes
}

/**
 * 用 wasm 实例化一个求解器。
 * 导出与网页端 wasm-bindgen 约定一致：memory / wasm_solve / malloc / 影子栈指针。
 */
export async function createSolver (bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const exported = instance.exports
  const memory = exported.memory
  const malloc = exported.__wbindgen_export_0
  const addToStack = exported.__wbindgen_add_to_stack_pointer
  const wasmSolve = exported.wasm_solve

  if (!memory || typeof malloc !== 'function' || typeof addToStack !== 'function' || typeof wasmSolve !== 'function') {
    throw new Error('PoW wasm 的导出不完整（版本可能已变化）')
  }

  const encoder = new TextEncoder()

  const writeString = (text) => {
    const data = encoder.encode(text)
    const ptr = malloc(data.length, 1)
    new Uint8Array(memory.buffer, ptr, data.length).set(data)
    return [ptr, data.length]
  }

  return {
    /** 返回整数 answer；wasm 报失败时返回 null。 */
    solve (challenge, prefix, difficulty) {
      const retptr = addToStack(-16)
      try {
        const [challengePtr, challengeLen] = writeString(challenge)
        const [prefixPtr, prefixLen] = writeString(prefix)
        wasmSolve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, Number(difficulty))
        const view = new DataView(memory.buffer)
        const status = view.getInt32(retptr, true)
        const value = view.getFloat64(retptr + 8, true)
        return status === 0 ? null : Math.trunc(value)
      } finally {
        addToStack(16)
      }
    },
  }
}

/** 由 challenge 生成 x-ds-pow-response 头值。 */
export function makeHeader (challenge, solver) {
  const prefix = `${challenge.salt}_${challenge.expire_at}_`
  const answer = solver.solve(challenge.challenge, prefix, challenge.difficulty)
  if (answer === null) throw new Error('PoW 求解失败（challenge 可能已过期）')
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/** 进程内复用：wasm 只实例化一次。 */
let solverPromise = null

export async function getSolver (options = {}) {
  if (solverPromise === null) {
    solverPromise = ensureWasm(options).then((bytes) => createSolver(bytes))
    solverPromise.catch(() => { solverPromise = null })
  }
  return solverPromise
}
