/**
 * PoW 求解器自检：加载缓存的 wasm，用一个合成 challenge 跑一遍。
 *
 * 只验证"能实例化、能求解、能生成 base64 头"，不校验服务端答案正确性
 * （那需要真实 token 换到的 challenge）。
 *
 * 用法：node tools/probe-pow.mjs
 */
import { ensureWasm, createSolver, makeHeader, cachedWasmPath } from '../src/host/pow.js'

const cached = cachedWasmPath()
console.log('缓存 wasm：' + (cached ? '已存在' : '无，将从网页端下载'))

const startedAt = Date.now()
const bytes = await ensureWasm()
console.log('wasm 读取完成', { bytes: bytes.length, elapsedMs: Date.now() - startedAt })

const solver = await createSolver(bytes)
console.log('实例化成功', { exports: ['memory', 'wasm_solve', 'malloc', 'addToStack'] })

const expireAt = Math.floor(Date.now() / 1000) + 300
const challenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: 'test-challenge-0123456789abcdef',
  salt: 'test-salt',
  expire_at: expireAt,
  difficulty: 100,
  signature: 'test-signature',
  target_path: '/api/v0/chat/completion',
}

const solveStarted = Date.now()
try {
  const header = makeHeader(challenge, solver)
  console.log('合成 challenge 求解成功', {
    headerLength: header.length,
    elapsedMs: Date.now() - solveStarted,
    // 不回显 answer / header 内容
  })
} catch (error) {
  console.log('求解失败：' + String(error?.message ?? error))
  process.exit(1)
}
