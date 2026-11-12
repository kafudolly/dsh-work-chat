/**
 * vendor 渲染库自检：在 Node 的 vm 上下文里加载插件自带的 marked / KaTeX，验证能出 HTML。
 * 浏览器侧另有 render-self-test 心跳（会真的把 Markdown 与公式渲染进 DOM）。
 *
 * 用法：node tools/smoke-vendor.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const vendor = path.join(here, '..', 'assets', 'vendor')

function contextFor (file) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout })
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file })
  return ctx
}

const problems = []

const markedCtx = contextFor(path.join(vendor, 'marked', 'marked.min.js'))
const hasParse = vm.runInContext('typeof marked !== "undefined" && typeof marked.parse === "function"', markedCtx)
if (!hasParse) {
  problems.push('marked 未导出 parse')
} else {
  const html = vm.runInContext('marked.parse("**粗体** 与 `code`\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |", { gfm: true })', markedCtx)
  const ok = html.includes('<strong>') && html.includes('<code>') && html.includes('<table>')
  console.log('marked:', ok ? 'PASS' : 'FAIL', '样例长度', html.length)
  if (!ok) problems.push('marked 输出不符合预期')
}

const katexCtx = contextFor(path.join(vendor, 'katex', 'katex.min.js'))
const hasKb = vm.runInContext('typeof katex !== "undefined" && typeof katex.renderToString === "function"', katexCtx)
if (!hasKb) {
  problems.push('katex 未导出 renderToString')
} else {
  const html = vm.runInContext('katex.renderToString("x^2", { throwOnError: false })', katexCtx)
  const ok = html.includes('katex')
  console.log('katex:', ok ? 'PASS' : 'FAIL', '输出长度', html.length)
  if (!ok) problems.push('katex 输出不含 katex 标记')
}

const cssSize = fs.statSync(path.join(vendor, 'katex', 'katex.min.css')).size
const fontDir = path.join(vendor, 'katex', 'fonts')
const fonts = fs.existsSync(fontDir) ? fs.readdirSync(fontDir).filter((name) => name.endsWith('.woff2')) : []
console.log('katex.min.css:', cssSize, 'bytes；woff2 字体:', fonts.length, '个')
if (cssSize === 0 || fonts.length === 0) problems.push('KaTeX 样式或字体缺失')

console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2))
if (problems.length > 0) process.exit(1)
