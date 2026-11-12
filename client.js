/**
 * dsh-work-chat —— 浏览器 bundle
 *
 * 结构（自上而下）：
 *   1. 常量与存储键
 *   2. 极简 store / 工具
 *   3. 样式（全部带 [data-workchat-*] 前缀，避免污染宿主）
 *   4. 侧栏注入（工作区 / 对话区区头，DOM 实现，不依赖 react-dom）
 *   5. UI 组件：模式开关、Chat 输入框（含深度思考/智能搜索）、对话面板、设置页
 *   6. apply：注册槽位、安装注入、接管 composer
 *
 * 只使用宿主提供的模块表（react），不引入额外运行时依赖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-work-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useSyncExternalStore, useCallback } = React

    // ------------------------------------------------------------------
    // 1. 常量
    // ------------------------------------------------------------------
    const NS = 'workchat'
    const KEYS = {
      mode: 'workchat.mode',
      prefs: 'workchat.prefs',
      collapsedWorkspaces: 'workchat.collapsed.workspaces',
      collapsedConversations: 'workchat.collapsed.conversations',
    }

    const readLocal = (key, fallback) => {
      try {
        const value = window.localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }
    const writeLocal = (key, value) => {
      try { window.localStorage.setItem(key, value) } catch { /* 隐私模式忽略 */ }
    }

    // ------------------------------------------------------------------
    // 2. store 与工具
    // ------------------------------------------------------------------
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        getSnapshot: () => state,
        set: (patch) => {
          const next = typeof patch === 'function' ? patch(state) : patch
          state = { ...state, ...next }
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const modeStore = createStore({ mode: readLocal(KEYS.mode, 'work') === 'chat' ? 'chat' : 'work' })
    const prefsStore = createStore({
      thinkingEnabled: readLocal(KEYS.prefs, '') === 'thinking',
      searchEnabled: readLocal(KEYS.prefs, '') === 'search',
    })
    const conversationStore = createStore({
      items: [],
      status: 'idle', // idle | loading | ready | error | unconfigured
      error: null,
      fetchedAt: 0,
      selected: null,
      selecting: false,
      selectedIds: [],
    })

    function applyModeAttribute(mode) {
      document.documentElement.dataset.workchatMode = mode
    }

    async function apiGet(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const text = await response.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* ignore */ }
      return { ok: response.ok, status: response.status, json }
    }

    async function apiPost(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const text = await response.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* ignore */ }
      return { ok: response.ok, status: response.status, json }
    }

    // 由 apply 赋值的回调：页面阶段变化时重新注册 composer 接管
    let refreshComposerRegistration = null
    // Chat 模式是否由我们切到了对话区面板（切回 Work 时据此还原）
    let modeOpenedPanel = false
    // 链式选择器的最近一次判定，随心跳上报用于诊断
    let composerProbe = 'none'

    /** 采集一次界面快照，随心跳上报（看不到浏览器时用来验证渲染结果）。 */
    let ensureLastError = null
    let rowClicks = 0
    let lastOpenError = null
    let lastClickId = ''
    let ensureRuns = 0
    let scheduleRuns = 0
    function uiSnapshot() {
      let workspaceVisible = false
      try {
        const slot = document.querySelector('[data-slot="sidebar.workspaces"]')
        workspaceVisible = Boolean(slot) && window.getComputedStyle(slot).display !== 'none'
      } catch { /* 计算样式失败则按不可见处理 */ }
      return {
        convRows: document.querySelectorAll('[data-workchat-row]').length,
        convHeader: Boolean(document.querySelector('[data-workchat-header="conversations"]')),
        refreshBtn: Boolean(document.querySelector('[data-workchat-refresh="conversations"]')),
        heroComposer: Boolean(document.querySelector('[data-workchat-composer="hero"]')),
        panelComposer: Boolean(document.querySelector('[data-workchat-composer="panel"]')),
        homeVisible: Boolean(document.querySelector('[data-workchat-home]')),
        selectedId: conversationStore.get().selected ? String(conversationStore.get().selected).slice(0, 8) : null,
        rowClicks,
        lastClickId,
        selecting: conversationStore.get().selecting,
        lastOpenError: lastOpenError,
        panelModeToggle: Boolean(document.querySelector('[data-workchat-panel] [data-workchat-mode-toggle]')),
        slotFound: Boolean(document.querySelector('[data-slot="sidebar.workspaces"]')),
        slotParentFound: Boolean(document.querySelector('[data-slot="sidebar.workspaces"]')?.parentElement),
        slotCount: document.querySelectorAll('[data-slot="sidebar.workspaces"]').length,
        sectionCount: document.querySelectorAll('[data-workchat-section="conversations"]').length,
        ensureRuns,
        scheduleRuns,
        ensureError: ensureLastError,
        vendorMarked: typeof window.marked !== 'undefined',
        vendorKatex: typeof window.katex !== 'undefined',
        mdReady: renderSelfTestResult.mdReady,
        katexReady: renderSelfTestResult.katexReady,
        displayMathReady: renderSelfTestResult.displayMathReady,
        mdBlocks: document.querySelectorAll('[data-workchat-bubble] p, [data-workchat-bubble] pre, [data-workchat-bubble] table, [data-workchat-bubble] ul, [data-workchat-bubble] ol').length,
        katexNodes: document.querySelectorAll('[data-workchat-bubble] .katex').length,
        composerProbe,
        workspaceVisible,
        collapsedWs: document.documentElement.dataset.workchatCollapsedWorkspaces ?? '',
        collapsedConv: document.documentElement.dataset.workchatCollapsedConversations ?? '',
      }
    }

    /** 客户端自检心跳：让宿主（以及看不到页面的维护者）确认浏览器半侧已加载。 */
    const reportedPhases = new Set()
    function reportClient(payload) {
      if (payload.phase !== undefined && reportedPhases.has(payload.phase)) return
      if (payload.phase !== undefined) reportedPhases.add(payload.phase)
      try {
        const snapshot = uiSnapshot()
        const sidebar = Boolean(document.querySelector('[data-workchat-section="conversations"]'))
        const modeBar = Boolean(document.querySelector('[data-workchat-mode-bar]'))
        const style = Boolean(document.querySelector('style[data-workchat-style]'))
        fetch('/workchat/client-heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sidebar,
            modeBar,
            style,
            ...snapshot,
            ...payload,
            mode: modeStore.get().mode,
            ua: typeof navigator === 'undefined' ? '' : String(navigator.userAgent ?? ''),
          }),
        }).catch(() => { /* 心跳失败不影响功能 */ })
      } catch { /* 同上 */ }
    }

    // ------------------------------------------------------------------
    // 渲染：Markdown + LaTeX（本地 vendor 资源，离线可用）
    // ------------------------------------------------------------------
    const ASSET_BASE = '/workchat/assets/vendor'

    // DeepSeek 官方鱼形标记（MIT，取自 @deepseek-ai/dsh-web-frontend 的 FISH_LOGO_PATH）
    const FISH_LOGO_PATH = "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z"
    const FISH_LOGO_VIEWBOX = '0 0 23.16 17.04'

    // Chat 首页文案（与宿主 hero 一致）
    const HERO_HEADLINE = '探索未至之境'
    let vendorPromise = null

    function loadScript (src) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.async = true
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('无法加载 ' + src))
        document.head.appendChild(script)
      })
    }

    function loadVendor () {
      if (vendorPromise !== null) return vendorPromise
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = `${ASSET_BASE}/katex/katex.min.css`
      document.head.appendChild(link)

      vendorPromise = loadScript(`${ASSET_BASE}/marked/marked.min.js`)
        .then(() => loadScript(`${ASSET_BASE}/katex/katex.min.js`))
        .then(() => ({
          marked: window.marked,
          katex: window.katex,
        }))
        .catch((error) => {
          vendorPromise = null
          throw error
        })
      return vendorPromise
    }

    /** 去掉脚本/事件属性等危险内容（网页端消息也可能是不可信文本）。 */
    function sanitizeHtml (html) {
      const template = document.createElement('template')
      template.innerHTML = html
      const blocked = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'STYLE', 'FORM', 'BASE'])
      const walk = (node) => {
        for (const child of [...node.children]) {
          if (blocked.has(child.tagName)) { child.remove(); continue }
          for (const attr of [...child.attributes]) {
            const name = attr.name.toLowerCase()
            const value = String(attr.value)
            const dangerous =
              name.startsWith('on') ||
              name === 'srcdoc' ||
              ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value))
            if (dangerous) child.removeAttribute(attr.name)
          }
          walk(child)
        }
      }
      walk(template.content)
      return template.innerHTML
    }

    /** 把公式从 Markdown 里抽出来占位，避免 `\\[` 被 Markdown 当转义吃掉。 */
    function escapeAttribute (value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function transformMath (text) {
      const splitCode = (source) => {
        const parts = []
        const fence = /(^|\n)(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
        let last = 0
        let match
        while ((match = fence.exec(source)) !== null) {
          const start = match.index + (match[1] ? match[1].length : 0)
          if (start > last) parts.push({ code: false, text: source.slice(last, start) })
          parts.push({ code: true, text: match[2] })
          last = start + match[2].length
        }
        if (last < source.length) parts.push({ code: false, text: source.slice(last) })
        return parts
      }

      const placeholder = (tex, display) =>
        `<span data-workchat-math="1" data-display="${display ? 1 : 0}" data-tex="${escapeAttribute(tex)}"></span>`

      const replaceMath = (segment) => segment
        // 块级：$$...$$ 与 \[...\]
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => placeholder(tex.trim(), true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => placeholder(tex.trim(), true))
        // 行内：\(...\) 与 $...$
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => placeholder(tex.trim(), false))
        .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (match, prefix, tex) => `${prefix}${placeholder(tex.trim(), false)}`)

      return splitCode(text).map((part) => (part.code ? part.text : replaceMath(part.text))).join('')
    }

    /** 把纯文本渲染成 Markdown + 公式；失败时退回纯文本。 */
    async function renderRichText (element, text) {
      const source = String(text ?? '')
      if (source === '') {
        element.textContent = ''
        delete element.dataset.workchatRendered
        return
      }
      element.textContent = source
      delete element.dataset.workchatRendered
      try {
        const { marked, katex } = await loadVendor()
        if (!marked || typeof marked.parse !== 'function') return
        // breaks:true 保留单换行；空行由 marked 拆成独立 <p>，靠 CSS 控制段距。
        const normalized = source.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
        const withPlaceholders = transformMath(normalized)
        element.innerHTML = sanitizeHtml(marked.parse(withPlaceholders, { breaks: true, gfm: true }))
        // 关键：渲染后必须关掉 pre-wrap，否则 marked 输出里的换行符会被当成可见空行
        element.dataset.workchatRendered = '1'

        // 再把占位填成真正的公式
        for (const node of element.querySelectorAll('[data-workchat-math]')) {
          const tex = node.dataset.tex ?? ''
          const displayMode = node.dataset.display === '1'
          try {
            katex.render(tex, node, { displayMode, throwOnError: false })
          } catch {
            node.textContent = tex
          }
        }
      } catch {
        element.textContent = source
        delete element.dataset.workchatRendered
      }
    }

    /** 渲染自检：在离屏元素里跑一遍 Markdown + 公式，结果随心跳上报。 */
    let selfTestDone = false
    const renderSelfTestResult = { mdReady: null, katexReady: null, displayMathReady: null }
    async function selfTestRenderer () {
      if (selfTestDone) return
      selfTestDone = true
      try {
        const probe = document.createElement('div')
        await renderRichText(probe, '**粗体** 与 $x^2$ 与 \\[\\sum_{v\\in V}\\deg(v)\\ge 2n-2\\]')
        renderSelfTestResult.mdReady = Boolean(probe.querySelector('strong'))
        renderSelfTestResult.katexReady = Boolean(probe.querySelector('.katex'))
        renderSelfTestResult.displayMathReady = Boolean(probe.querySelector('.katex-display'))
        reportClient({
          phase: `render-self-${renderSelfTestResult.mdReady ? 1 : 0}${renderSelfTestResult.katexReady ? 1 : 0}${renderSelfTestResult.displayMathReady ? 1 : 0}`,
          mdReady: renderSelfTestResult.mdReady,
          katexReady: renderSelfTestResult.katexReady,
          displayMathReady: renderSelfTestResult.displayMathReady,
        })
      } catch (error) {
        renderSelfTestResult.mdReady = false
        renderSelfTestResult.katexReady = false
        reportClient({ phase: 'render-self-error', mdReady: false, katexReady: false, error: String(error?.message ?? error).slice(0, 160) })
      }
    }

    function MessageBody ({ text }) {
      const ref = useRef(null)
      useEffect(() => {
        const element = ref.current
        if (!element) return
        renderRichText(element, text)
      }, [text])
      return h('div', { 'data-workchat-bubble': '1', ref })
    }

    /** 轻量 toast：不依赖宿主的 primitives 包。 */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* 继续降级 */ }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.cssText = 'position:fixed;left:-9999px;top:0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    /** 通用对话框：confirm（无 input）/ prompt（有 input）。 */
    function openDialog({ title, message, input, confirmText = '确定', cancelText = '取消', danger = false, placeholder = '' }) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div')
        overlay.dataset.workchatOverlay = '1'
        const dialog = document.createElement('div')
        dialog.dataset.workchatDialog = '1'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')

        const titleNode = document.createElement('div')
        titleNode.dataset.workchatDialogTitle = '1'
        titleNode.textContent = title
        dialog.appendChild(titleNode)

        if (message) {
          const messageNode = document.createElement('div')
          messageNode.dataset.workchatDialogMessage = '1'
          messageNode.textContent = message
          dialog.appendChild(messageNode)
        }

        let inputNode = null
        if (input !== undefined) {
          inputNode = document.createElement('input')
          inputNode.value = input ?? ''
          inputNode.placeholder = placeholder
          inputNode.maxLength = 100
          dialog.appendChild(inputNode)
        }

        const actions = document.createElement('div')
        actions.dataset.workchatDialogActions = '1'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = cancelText
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.textContent = confirmText
        if (danger) confirm.dataset.danger = '1'
        else confirm.dataset.primary = '1'
        actions.append(cancel, confirm)
        dialog.appendChild(actions)
        overlay.appendChild(dialog)
        document.body.appendChild(overlay)

        const close = (value) => {
          document.removeEventListener('keydown', onKey, true)
          overlay.remove()
          resolve(value)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close(inputNode ? null : false)
          }
          if (event.key === 'Enter' && inputNode) {
            event.preventDefault()
            const value = inputNode.value.trim()
            close(value === '' ? null : value)
          }
        }
        document.addEventListener('keydown', onKey, true)
        cancel.addEventListener('click', () => close(inputNode ? null : false))
        confirm.addEventListener('click', () => {
          if (!inputNode) { close(true); return }
          const value = inputNode.value.trim()
          close(value === '' ? null : value)
        })
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close(inputNode ? null : false)
        })
        setTimeout(() => {
          if (inputNode) { inputNode.focus(); inputNode.select() } else confirm.focus()
        }, 0)
      })
    }

    /** 行内弹出菜单。 */
    function openRowMenu(anchor, items) {
      document.querySelectorAll('[data-workchat-menu]').forEach((node) => node.remove())
      const menu = document.createElement('div')
      menu.dataset.workchatMenu = '1'
      menu.setAttribute('role', 'menu')

      const close = () => {
        document.removeEventListener('mousedown', onOutside, true)
        document.removeEventListener('keydown', onKey, true)
        window.removeEventListener('resize', close)
        menu.remove()
      }
      const onOutside = (event) => {
        if (!menu.contains(event.target) && event.target !== anchor) close()
      }
      const onKey = (event) => { if (event.key === 'Escape') close() }

      for (const item of items) {
        if (item.separator) { menu.appendChild(document.createElement('hr')); continue }
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        if (item.danger) button.dataset.danger = '1'
        button.textContent = item.label
        button.addEventListener('click', () => {
          close()
          Promise.resolve(item.onSelect()).catch((error) => toast(String(error?.message ?? error), 'error'))
        })
        menu.appendChild(button)
      }

      document.body.appendChild(menu)
      const rect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      let left = rect.right - menuRect.width
      let top = rect.bottom + 4
      if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4)
      if (left < 8) left = 8
      menu.style.left = `${left}px`
      menu.style.top = `${top}px`

      document.addEventListener('mousedown', onOutside, true)
      document.addEventListener('keydown', onKey, true)
      window.addEventListener('resize', close)
    }
    let toastTimer = null
    function toast(text, tone = 'info') {
      let node = document.querySelector('[data-workchat-toast]')
      if (!node) {
        node = document.createElement('div')
        node.dataset.workchatToast = '1'
        node.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
          'z-index:2147483000', 'max-width:70vw', 'padding:8px 14px', 'border-radius:10px',
          'font-size:13px', 'line-height:1.4', 'color:#fff', 'pointer-events:none',
          'box-shadow:0 6px 24px rgba(0,0,0,.22)', 'transition:opacity .2s ease',
        ].join(';')
        document.body.appendChild(node)
      }
      node.style.background = tone === 'error' ? 'rgba(214,69,69,.95)' : 'rgba(30,30,30,.92)'
      node.textContent = text
      node.style.opacity = '1'
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        node.style.opacity = '0'
        setTimeout(() => node.remove(), 220)
      }, 2600)
    }

    // ------------------------------------------------------------------
    // 3. 样式
    // ------------------------------------------------------------------
    const CSS = `
      /* Chat 态：隐藏工作区 / 开发模式 / 审核模式 / 计划模式 */
      html[data-workchat-mode="chat"] [class*="heroWorkspaceRow"],
      html[data-workchat-mode="chat"] [data-slot="conversation.hero.agentPreset"],
      html[data-workchat-mode="chat"] [data-slot="conversation.input.permission"],
      html[data-workchat-mode="chat"] [data-slot="conversation.input.plan"] { display: none !important; }

      /* 折叠：必须匹配 ="1"，否则属性存在（值为 0）也会把列表藏掉 */
      html[data-workchat-collapsed-workspaces="1"] [data-slot="sidebar.workspaces"] { display: none !important; }
      html[data-workchat-collapsed-conversations="1"] [data-workchat-list="conversations"] { display: none !important; }

      /* 区头行（区头按钮 + 右侧操作按钮） */
      [data-workchat-headerrow] {
        display: flex; align-items: center; gap: 2px;
        width: calc(100% - 8px); margin: 2px 4px; flex: none;
      }
      [data-workchat-refresh] {
        flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px;
        background: transparent; color: inherit; opacity: .55; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 13px; line-height: 1; padding: 0;
      }
      [data-workchat-refresh]:hover { opacity: 1; background: var(--dsw-alias-bg-secondary, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))); }
      [data-workchat-refresh]:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3a82f7); outline-offset: 1px; }
      [data-workchat-refresh][data-spinning="1"] { opacity: 1; animation: workchat-spin .8s linear infinite; }
      @keyframes workchat-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { [data-workchat-refresh][data-spinning="1"] { animation: none; } }

      /* 区头 */
      [data-workchat-header] {
        display: flex; align-items: center; gap: 6px; width: auto; flex: 1 1 auto;
        margin: 0; padding: 6px 9px; border: 0; border-radius: 6px;
        background: transparent; color: inherit; font: inherit; font-size: 12px;
        font-weight: 600; letter-spacing: .02em; opacity: .72; cursor: pointer;
        text-align: left; transition: background-color .12s ease, opacity .12s ease;
        min-width: 0;
      }
      [data-workchat-header]:hover { background: var(--dsw-alias-bg-secondary, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))); opacity: 1; }
      [data-workchat-header]:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3a82f7); outline-offset: 1px; }
      [data-workchat-chevron] { display: inline-block; width: 12px; font-size: 10px; opacity: .8; }

      /* 分区高度分配：regionArea 是 flex column + overflow:hidden，
         原生工作区浏览器默认吃满高度，对话区必须显式占位并自带滚动，
         否则会压在工作区列表上。 */
      [data-workchat-section="conversations"] {
        display: flex; flex-direction: column; flex: 0 1 45%;
        min-height: 0; overflow: hidden;
      }
      /* 工作区收起时，对话区独占剩余空间 */
      html[data-workchat-collapsed-workspaces="1"] [data-workchat-section="conversations"] { flex: 1 1 auto; }
      /* 原生工作区浏览器（slot 是 display:contents，其子元素即浏览器根）允许收缩 */
      [data-slot="sidebar.workspaces"] > * { min-height: 0; }

      /* 对话列表 */
      [data-workchat-list] {
        display: flex; flex-direction: column; gap: 1px; padding: 0 4px 4px;
        flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
        scrollbar-gutter: stable; padding-right: 8px;
      }
      [data-workchat-list]::-webkit-scrollbar { width: 8px; }
      [data-workchat-list]::-webkit-scrollbar-thumb {
        background: var(--dsh-scrollbar-thumb, rgba(128,128,128,.35));
        border-radius: 4px;
      }
      [data-workchat-list]::-webkit-scrollbar-track { background: transparent; }
      [data-workchat-row] {
        display: flex; align-items: center; gap: 8px; width: 100%; border: 0;
        background: transparent; color: inherit; font: inherit; font-size: 13px;
        padding: 6px 6px 6px 9px; border-radius: 6px; cursor: pointer; text-align: left;
        transition: background-color .12s ease; min-width: 0;
      }
      [data-workchat-row]:hover { background: var(--dsw-alias-bg-secondary, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))); }
      [data-workchat-row][aria-current="true"] { background: var(--dsw-alias-bg-tertiary, rgba(128,128,128,.24)); }
      [data-workchat-badge] {
        font-size: 10px; padding: 1px 6px; border-radius: 999px; flex: none;
        background: var(--dsw-alias-interactive-bg-hover-solid, rgba(58,130,247,.14)); color: var(--dsw-alias-state-business-primary, #3a82f7);
      }
      [data-workchat-title] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
      [data-workchat-time] { margin-left: auto; font-size: 11px; opacity: .55; flex: none; }
      [data-workchat-more] { margin-right: -2px; }
      [data-workchat-empty] { padding: 6px 10px 10px; font-size: 12px; opacity: .55; line-height: 1.5; }

      /* 模式开关 */
      [data-workchat-mode-bar] {
        position: absolute; top: 8px; left: 0; right: 0; z-index: 40;
        display: flex; justify-content: center; padding: 0; pointer-events: none;
      }
      [data-workchat-mode-bar] > * { pointer-events: auto; }
      [data-workchat-mode-toggle] {
        display: inline-flex; align-items: center; gap: 2px; padding: 2px;
        border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));
      }
      [data-workchat-mode-option] {
        border: 0; background: transparent; color: inherit; font: inherit; font-size: 12px;
        padding: 3px 12px; border-radius: 999px; cursor: pointer; opacity: .7;
      }
      [data-workchat-mode-option][aria-selected="true"] {
        background: var(--dsw-alias-bg-base, #fff); color: inherit; opacity: 1;
        box-shadow: 0 1px 3px rgba(0,0,0,.16);
      }

      /* Chat 输入框：对齐工作区输入卡的观感 */
      [data-workchat-composer] {
        display: flex; flex-direction: column; gap: 10px;
        width: min(var(--dsh-chat-content-width, 760px), calc(100% - 32px));
        max-width: var(--dsh-chat-content-width, 760px);
        margin-left: auto; margin-right: auto;
        padding: 12px 14px; border-radius: 16px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));
        background: var(--dsw-alias-bg-elevated, rgba(128,128,128,.06));
        box-shadow: 0 1px 2px rgba(0,0,0,.05);
        transition: border-color .15s ease, box-shadow .15s ease;
      }
      [data-workchat-composer]:focus-within {
        border-color: var(--dsw-alias-state-business-primary, #3a82f7);
        box-shadow: 0 0 0 3px var(--dsw-alias-interactive-bg-hover-solid, rgba(58,130,247,.12));
      }
      [data-workchat-composer] textarea {
        width: 100%; min-height: 48px; max-height: 240px; resize: none;
        border: 0; outline: none; background: transparent; color: inherit;
        font: inherit; font-size: var(--dsh-content-font-size, 14.5px); line-height: 1.6; padding: 0;
      }
      [data-workchat-composer] textarea::placeholder { opacity: .45; }
      [data-workchat-composer-bar] { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      [data-workchat-pill] {
        display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px;
        padding: 4px 10px; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background: transparent; color: inherit;
        opacity: .78; transition: all .12s ease;
      }
      [data-workchat-pill] svg { flex: none; }
      [data-workchat-pill]:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
      [data-workchat-pill][aria-pressed="true"] {
        opacity: 1; border-color: transparent;
        background: var(--dsw-alias-state-business-primary, #3a82f7); color: #fff;
      }
      [data-workchat-pill]:disabled { cursor: not-allowed; opacity: .4; }
      [data-workchat-send] {
        margin-left: auto; width: 32px; height: 32px; flex: none;
        display: inline-flex; align-items: center; justify-content: center;
        border: 0; border-radius: 50%; padding: 0;
        background: var(--dsw-alias-state-business-primary, #3a82f7); color: #fff;
        cursor: pointer; transition: opacity .12s ease, transform .12s ease;
      }
      [data-workchat-send]:hover:not(:disabled) { transform: translateY(-1px); }
      [data-workchat-send]:disabled { opacity: .35; cursor: not-allowed; }

      /* 文本层级：全部走宿主 label token */
      [data-workchat-panel] { color: var(--dsw-alias-label-primary, inherit); }
      [data-workchat-header] { color: var(--dsw-alias-label-secondary, inherit); }
      [data-workchat-group] { color: var(--dsw-alias-label-caption, inherit); }
      [data-workchat-time], [data-workchat-empty] { color: var(--dsw-alias-label-tertiary, inherit); }
      [data-workchat-row] { color: var(--dsw-alias-label-primary, inherit); }
      [data-workchat-thinking] { color: var(--dsw-alias-label-secondary, inherit); }
      /* 面板内的模式开关 */
      [data-workchat-panel-topbar] { display: flex; justify-content: center; padding: 14px 0 0; flex: none; }
      [data-workchat-panel-head] [data-workchat-mode-toggle] { transform: scale(.92); }

      /* Chat 首页：模仿 Work 首页的居中布局 */
      [data-workchat-home] {
        flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
        padding: 48px 24px 96px; overflow-y: auto;
      }
      [data-workchat-home-stack] {
        width: 100%; max-width: var(--dsh-chat-content-width, 760px);
        display: flex; flex-direction: column; align-items: center; gap: 32px;
      }
      [data-workchat-home-brand] {
        display: inline-flex; align-items: center; gap: 12px;
        color: var(--dsw-alias-label-primary, inherit);
      }
      [data-workchat-home-title] { font-size: 22px; font-weight: 500; letter-spacing: .02em; }
      [data-workchat-home-composer] { width: 100%; }

      /* 对话面板 */
      [data-workchat-panel] { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      [data-workchat-panel-head] {
        display: flex; align-items: center; gap: 10px; padding: 10px 18px;
        border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); flex: none;
      }
      [data-workchat-panel-title] { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      [data-workchat-panel-body] { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 18px 8px; }
      [data-workchat-panel-body] > * { max-width: var(--dsh-chat-content-width, 760px); margin-left: auto; margin-right: auto; }
      [data-workchat-msg] { display: flex; margin-bottom: 18px; }
      [data-workchat-msg="user"] { justify-content: flex-end; }
      [data-workchat-bubble] {
        max-width: min(688px, 100%); font-size: var(--dsh-content-font-size, 14.5px); line-height: 1.75;
        white-space: pre-wrap; word-break: break-word;
      }
      /* 渲染成 HTML 之后，HTML 源码里的换行不能再当成可见空行 */
      [data-workchat-bubble][data-workchat-rendered="1"] { white-space: normal; }
      [data-workchat-msg="user"] [data-workchat-bubble] {
        padding: 9px 14px; border-radius: 14px;
        background: var(--dsw-alias-interactive-bg-hover-solid, rgba(58,130,247,.12));
      }
      [data-workchat-msg="assistant"] [data-workchat-bubble] { padding: 0; background: transparent; }
      /* Markdown / 公式排版 */
      [data-workchat-bubble] > :first-child { margin-top: 0; }
      [data-workchat-bubble] > :last-child { margin-bottom: 0; }
      [data-workchat-bubble] p { margin: 0 0 10px; }
      [data-workchat-bubble] h1, [data-workchat-bubble] h2, [data-workchat-bubble] h3, [data-workchat-bubble] h4 {
        margin: 18px 0 8px; line-height: 1.35; font-weight: 600;
      }
      [data-workchat-bubble] h1 { font-size: 1.35em; }
      [data-workchat-bubble] h2 { font-size: 1.22em; }
      [data-workchat-bubble] h3 { font-size: 1.1em; }
      [data-workchat-bubble] ul, [data-workchat-bubble] ol { margin: 0 0 10px; padding-left: 22px; }
      [data-workchat-bubble] li { margin: 3px 0; }
      [data-workchat-bubble] code {
        font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: .92em; padding: 1px 5px; border-radius: 4px;
        background: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.16));
      }
      [data-workchat-bubble] pre {
        margin: 0 0 12px; padding: 12px 14px; border-radius: 10px; overflow-x: auto;
        background: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.12));
      }
      [data-workchat-bubble] pre code { background: transparent; padding: 0; font-size: 12.8px; line-height: 1.6; }
      [data-workchat-bubble] table { border-collapse: collapse; margin: 0 0 12px; font-size: .95em; }
      [data-workchat-bubble] th, [data-workchat-bubble] td {
        border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); padding: 6px 10px;
      }
      [data-workchat-bubble] blockquote {
        margin: 0 0 10px; padding-left: 12px;
        border-left: 3px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3));
        color: var(--dsw-alias-label-secondary, inherit);
      }
      [data-workchat-bubble] a { color: var(--dsw-alias-state-business-primary, #3a82f7); }
      [data-workchat-bubble] img { max-width: 100%; border-radius: 8px; }
      [data-workchat-bubble] hr { border: 0; border-top: 1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,.2)); margin: 14px 0; }
      [data-workchat-bubble] .katex-display { overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
      [data-workchat-thinking] {
        margin: -10px 0 14px; font-size: 12.5px; line-height: 1.6; opacity: .7;
        white-space: pre-wrap; padding-left: 12px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
      }
      [data-workchat-panel-foot] { flex: none; padding: 12px 18px 18px; }
      [data-workchat-panel-foot] [data-workchat-composer] { max-width: var(--dsh-chat-content-width, 760px); margin: 0 auto; }
      [data-workchat-linkbtn] {
        border: 0; background: transparent; color: inherit; opacity: .65; font: inherit;
        font-size: 12px; cursor: pointer; padding: 4px 8px; border-radius: 6px;
      }
      [data-workchat-linkbtn]:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
      [data-workchat-skeleton] { height: 64px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.10)); margin-bottom: 12px; }

      /* 日期分组标题 */
      [data-workchat-group] {
        padding: 8px 10px 3px; font-size: 11px; font-weight: 600;
        letter-spacing: .04em; opacity: .45; flex: none;
      }
      /* 行内操作 */
      [data-workchat-row] { position: relative; }
      [data-workchat-pin] { flex: none; font-size: 10px; opacity: .8; }
      [data-workchat-more] {
        flex: none; width: 20px; height: 20px; border: 0; border-radius: 5px;
        background: transparent; color: inherit; cursor: pointer; font-size: 14px;
        line-height: 1; padding: 0; opacity: 0; transition: opacity .12s ease;
        display: inline-flex; align-items: center; justify-content: center;
      }
      [data-workchat-row]:hover [data-workchat-more],
      [data-workchat-row]:focus-within [data-workchat-more],
      [data-workchat-more]:focus-visible { opacity: .7; }
      [data-workchat-more]:hover { opacity: 1; background: var(--dsw-alias-separator-primary, rgba(128,128,128,.2)); }
      [data-workchat-check] { flex: none; margin: 0 2px 0 0; }

      /* 多选底栏 */
      [data-workchat-bulk] {
        display: flex; align-items: center; gap: 8px; flex: none;
        padding: 8px 10px; margin: 4px 4px 2px; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)));
        font-size: 12px;
      }
      [data-workchat-bulk] button {
        border: 0; border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 12px;
        background: transparent; color: inherit; cursor: pointer;
      }
      [data-workchat-bulk] button:hover { background: var(--dsw-alias-separator-primary, rgba(128,128,128,.2)); }
      [data-workchat-bulk] button[data-danger] { color: var(--dsw-alias-state-error-primary, #e5484d); }
      [data-workchat-bulk] span { opacity: .7; }

      /* 行菜单 */
      [data-workchat-menu] {
        position: fixed; z-index: 2147482500; min-width: 148px; padding: 4px;
        display: flex; flex-direction: column; gap: 1px;
        border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #262626);
        color: var(--dsw-alias-label-primary, inherit);
        box-shadow: 0 10px 32px rgba(0,0,0,.38); border: 1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,.2));
      }
      [data-workchat-menu] button {
        display: flex; align-items: center; gap: 8px; width: 100%;
        border: 0; border-radius: 6px; padding: 7px 10px;
        background: transparent; color: inherit; font: inherit; font-size: 13px;
        text-align: left; cursor: pointer;
      }
      [data-workchat-menu] button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); }
      [data-workchat-menu] button[data-danger] { color: var(--dsw-alias-state-error-primary, #e5484d); }
      [data-workchat-menu] hr { border: 0; border-top: 1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,.2)); margin: 4px 2px; }

      /* 对话框 */
      [data-workchat-overlay] {
        position: fixed; inset: 0; z-index: 2147483000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,.35); backdrop-filter: blur(2px);
      }
      [data-workchat-dialog] {
        min-width: 320px; max-width: min(460px, 90vw); padding: 18px;
        border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #262626);
        color: var(--dsw-alias-label-primary, inherit);
        box-shadow: 0 24px 60px rgba(0,0,0,.5);
        border: 1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,.2)); font-size: 13px;
      }
      [data-workchat-dialog] [data-workchat-dialog-title] { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
      [data-workchat-dialog] [data-workchat-dialog-message] { opacity: .72; line-height: 1.55; word-break: break-word; }
      [data-workchat-dialog] input {
        width: 100%; box-sizing: border-box; margin: 12px 0 4px; padding: 8px 10px;
        border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
        background: transparent; color: inherit; font: inherit; outline: none;
      }
      [data-workchat-dialog] input:focus { border-color: var(--dsw-alias-state-business-primary, #3a82f7); }
      [data-workchat-dialog] [data-workchat-dialog-actions] {
        display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;
      }
      [data-workchat-dialog] button {
        border-radius: 8px; padding: 7px 14px; font: inherit; font-size: 13px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background: transparent;
        color: inherit; cursor: pointer;
      }
      [data-workchat-dialog] button[data-primary] {
        border-color: transparent; background: var(--dsw-alias-state-business-primary, #3a82f7); color: #fff;
      }
      [data-workchat-dialog] button[data-danger] {
        border-color: transparent; background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff;
      }
    `

    // ------------------------------------------------------------------
    // 4. 侧边栏注入
    // ------------------------------------------------------------------
    let sectionCounter = 0

    function createSectionHeader(kind, label, controlsId, collapsedKey, storageKey, actions = []) {
      const wrapper = document.createElement('div')
      wrapper.dataset.workchatHeaderrow = kind

      const header = document.createElement('button')
      header.type = 'button'
      header.dataset.workchatHeader = kind
      header.setAttribute('aria-controls', controlsId)
      const chevron = document.createElement('span')
      chevron.dataset.workchatChevron = '1'
      const text = document.createElement('span')
      text.textContent = label
      header.append(chevron, text)

      const paint = () => {
        const collapsed = document.documentElement.dataset[collapsedKey] === '1'
        header.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
        chevron.textContent = collapsed ? '▸' : '▾'
      }
      paint()

      header.addEventListener('click', () => {
        const collapsed = document.documentElement.dataset[collapsedKey] === '1'
        const next = collapsed ? '0' : '1'
        document.documentElement.dataset[collapsedKey] = next
        writeLocal(storageKey, next)
        paint()
      })

      wrapper.appendChild(header)

      for (const action of actions) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.workchatRefresh = action.kind
        button.title = action.title
        button.setAttribute('aria-label', action.title)
        button.textContent = action.label
        button.addEventListener('click', async (event) => {
          event.stopPropagation()
          if (button.disabled === true) return
          button.disabled = true
          button.dataset.spinning = '1'
          try {
            await action.onClick()
          } finally {
            button.disabled = false
            delete button.dataset.spinning
          }
        })
        wrapper.appendChild(button)
      }

      return wrapper
    }

    /** 主动与网页端同步一次对话列表。 */
    async function refreshConversations() {
      const before = conversationStore.get().items.length
      await loadConversations(true)
      const state = conversationStore.get()
      if (state.status === 'error') {
        toast(`同步失败：${state.error ?? '未知错误'}`, 'error')
        return
      }
      if (state.status === 'unconfigured') {
        toast('未配置网页账号，去「设置 → DeepSeek 网页账号」填写 userToken', 'error')
        return
      }
      const after = state.items.length
      toast(after === before ? `已同步，共 ${after} 条对话` : `已同步，新增 ${after - before} 条（共 ${after} 条）`)
    }

    function patchConversation(id, patch) {
      conversationStore.set((state) => ({
        items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      }))
    }

    async function renameConversation(item) {
      const name = await openDialog({
        title: '重命名对话',
        message: '会同步到网页端',
        input: item.title ?? '',
        placeholder: '对话标题',
        confirmText: '保存',
      })
      if (name === null) return
      const { ok, json } = await apiPost('/workchat/session/rename', { sessionId: item.id, title: name })
      if (!ok || !json?.ok) {
        toast(json?.message ?? '重命名失败', 'error')
        return
      }
      patchConversation(item.id, { title: json.title ?? name })
      toast('已重命名')
    }

    async function togglePin(item) {
      const next = !item.pinned
      const { ok, json } = await apiPost('/workchat/session/pin', { sessionIds: [item.id], pinned: next })
      if (!ok || !json?.ok) {
        toast(json?.message ?? '操作失败', 'error')
        return
      }
      patchConversation(item.id, { pinned: next })
      toast(next ? '已置顶' : '已取消置顶')
    }

    async function shareConversation(item) {
      const { ok, json } = await apiPost('/workchat/session/share', { sessionId: item.id })
      if (!ok || !json?.ok) {
        toast(json?.message ?? '分享失败', 'error')
        return
      }
      const copied = await copyText(json.url)
      toast(copied ? '分享链接已复制到剪贴板' : `分享链接：${json.url}`)
    }

    async function deleteConversations(items) {
      if (items.length === 0) return
      const names = items.map((item) => item.title || '未命名对话')
      const confirmed = await openDialog({
        title: items.length === 1 ? '删除对话' : `删除 ${items.length} 条对话`,
        message: `将从网页端永久删除：\n${names.slice(0, 5).join('\n')}${names.length > 5 ? '\n…' : ''}`,
        confirmText: '删除',
        danger: true,
      })
      if (!confirmed) return
      const ids = items.map((item) => item.id)
      const { ok, json } = await apiPost('/workchat/session/delete', { sessionIds: ids })
      if (!ok || !json?.ok) {
        toast(json?.message ?? '删除失败', 'error')
        return
      }
      conversationStore.set((state) => ({
        items: state.items.filter((item) => !ids.includes(item.id)),
        selected: ids.includes(state.selected) ? null : state.selected,
        selectedIds: state.selectedIds.filter((id) => !ids.includes(id)),
        selecting: false,
      }))
      toast(`已删除 ${ids.length} 条对话`)
    }

    function toggleSelected(id) {
      conversationStore.set((state) => {
        const exists = state.selectedIds.includes(id)
        return { selectedIds: exists ? state.selectedIds.filter((item) => item !== id) : [...state.selectedIds, id] }
      })
    }

    /** 按「置顶 / 今天 / 昨天 / 近 7 天 / 更早」分组。 */
    function groupItems(items) {
      const now = new Date()
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const day = 86_400_000
      const pinned = items.filter((item) => item.pinned)
      const rest = items.filter((item) => !item.pinned)
      return [
        { key: 'pinned', label: '置顶', items: pinned },
        { key: 'today', label: '今天', items: rest.filter((item) => item.updatedAt >= startOfToday) },
        { key: 'yesterday', label: '昨天', items: rest.filter((item) => item.updatedAt >= startOfToday - day && item.updatedAt < startOfToday) },
        { key: 'week', label: '近 7 天', items: rest.filter((item) => item.updatedAt >= startOfToday - 7 * day && item.updatedAt < startOfToday - day) },
        { key: 'older', label: '更早', items: rest.filter((item) => item.updatedAt < startOfToday - 7 * day) },
      ].filter((group) => group.items.length > 0)
    }

    function conversationRow(item, onOpen) {
      const { selecting, selectedIds, selected } = conversationStore.get()
      const row = document.createElement('div')
      row.dataset.workchatRow = item.id
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      row.setAttribute('aria-current', selected === item.id ? 'true' : 'false')
      if (selecting) row.setAttribute('aria-checked', selectedIds.includes(item.id) ? 'true' : 'false')

      if (selecting) {
        const check = document.createElement('input')
        check.type = 'checkbox'
        check.dataset.workchatCheck = '1'
        check.checked = selectedIds.includes(item.id)
        check.addEventListener('click', (event) => event.stopPropagation())
        check.addEventListener('change', () => toggleSelected(item.id))
        row.appendChild(check)
      } else {
        const badge = document.createElement('span')
        badge.dataset.workchatBadge = '1'
        badge.textContent = '网页'
        row.appendChild(badge)
      }

      if (item.pinned) {
        const pin = document.createElement('span')
        pin.dataset.workchatPin = '1'
        pin.textContent = '📌'
        pin.title = '已置顶'
        row.appendChild(pin)
      }

      const title = document.createElement('span')
      title.dataset.workchatTitle = '1'
      title.textContent = item.title || '未命名对话'
      title.title = item.title || ''
      row.appendChild(title)

      const time = document.createElement('span')
      time.dataset.workchatTime = '1'
      time.textContent = relativeTime(item.updatedAt)
      row.appendChild(time)

      if (!selecting) {
        const more = document.createElement('button')
        more.type = 'button'
        more.dataset.workchatMore = '1'
        more.textContent = '⋯'
        more.title = '更多操作'
        more.setAttribute('aria-label', '更多操作')
        more.addEventListener('click', (event) => {
          event.stopPropagation()
          openRowMenu(more, [
            { label: '重命名', onSelect: () => renameConversation(item) },
            { label: item.pinned ? '取消置顶' : '置顶', onSelect: () => togglePin(item) },
            { label: '分享', onSelect: () => shareConversation(item) },
            { separator: true },
            { label: '多选', onSelect: () => conversationStore.set({ selecting: true, selectedIds: [item.id] }) },
            { label: '删除', danger: true, onSelect: () => deleteConversations([item]) },
          ])
        })
        row.appendChild(more)
      }

      const activate = () => {
        rowClicks += 1
        lastClickId = String(item.id).slice(0, 8)
        if (conversationStore.get().selecting) toggleSelected(item.id)
        else onOpen(item.id)
      }
      row.addEventListener('click', activate)
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      })
      return row
    }

    function relativeTime(ms) {
      if (!ms) return ''
      const diff = Date.now() - Number(ms)
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      const date = new Date(Number(ms))
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    function mountSidebar(ctx, onOpenConversation) {
      const style = document.createElement('style')
      style.dataset.workchatStyle = '1'
      style.textContent = CSS
      document.head.appendChild(style)

      const restoreCollapse = () => {
        document.documentElement.dataset.workchatCollapsedWorkspaces = readLocal(KEYS.collapsedWorkspaces, '0') === '1' ? '1' : '0'
        document.documentElement.dataset.workchatCollapsedConversations = readLocal(KEYS.collapsedConversations, '0') === '1' ? '1' : '0'
      }
      restoreCollapse()

      let listNode = null
      let emptyNode = null
      let bulkNode = null
      let queued = false
      const modeBar = createModeBar()

      /**
       * 模式开关只挂在空白会话页（[data-phase="hero"]）的顶部。
       * 页面切到已有会话时移除，回到空白页时补回。
       */
      const ensureModeBar = () => {
        const outlet = document.querySelector('[data-slot="main"]')
        const column = outlet?.parentElement
        if (!column) return
        if (column.dataset.workchatAnchor !== '1') {
          column.dataset.workchatAnchor = '1'
          if (!column.style.position || column.style.position === 'static') column.style.position = 'relative'
        }
        if (!modeBar.bar.isConnected) column.appendChild(modeBar.bar)
        // 只在新会话页出现：Work 的 hero 或 Chat 的新对话首页；打开具体对话后隐藏
        const heroPage = Boolean(document.querySelector('[data-phase="hero"]'))
        const chatHome = Boolean(document.querySelector('[data-workchat-home]'))
        modeBar.bar.style.display = (heroPage || chatHome) ? 'flex' : 'none'
      }

      const updateBulk = () => {
        if (!bulkNode) return
        const { selecting, selectedIds, items } = conversationStore.get()
        bulkNode.textContent = ''
        bulkNode.hidden = !selecting
        if (!selecting) return
        const info = document.createElement('span')
        info.textContent = `已选 ${selectedIds.length} 项`
        const all = document.createElement('button')
        all.type = 'button'
        all.textContent = selectedIds.length === items.length ? '全不选' : '全选'
        all.addEventListener('click', () => {
          conversationStore.set({ selectedIds: selectedIds.length === items.length ? [] : items.map((item) => item.id) })
        })
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.dataset.danger = '1'
        remove.textContent = '删除'
        remove.disabled = selectedIds.length === 0
        remove.addEventListener('click', () => {
          const target = items.filter((item) => selectedIds.includes(item.id))
          deleteConversations(target).catch((error) => toast(String(error?.message ?? error), 'error'))
        })
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = '取消'
        cancel.addEventListener('click', () => conversationStore.set({ selecting: false, selectedIds: [] }))
        bulkNode.append(info, all, remove, cancel)
      }

      const renderList = () => {
        if (!listNode) return
        const { items, status, error, selecting } = conversationStore.get()
        listNode.textContent = ''
        listNode.hidden = false
        if (emptyNode) {
          const unconfigured = status === 'unconfigured'
          const loading = status === 'loading' && items.length === 0
          emptyNode.hidden = loading || (!(status === 'ready' && items.length === 0) && !unconfigured && !(status === 'error'))
          if (status === 'error') emptyNode.textContent = `同步失败${error ? `：${error}` : ''}`
          else if (unconfigured) emptyNode.textContent = '未配置网页账号，去「设置 → DeepSeek 网页账号」填写 userToken'
          else if (status === 'ready' && items.length === 0) emptyNode.textContent = '暂无对话'
        }
        if (status === 'loading' && items.length === 0) {
          const skeleton = document.createElement('div')
          skeleton.dataset.workchatEmpty = '1'
          skeleton.textContent = '同步中…'
          listNode.appendChild(skeleton)
          updateBulk()
          return
        }
        const sorted = [...items].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        for (const group of groupItems(sorted)) {
          const label = document.createElement('div')
          label.dataset.workchatGroup = group.key
          label.textContent = group.label
          listNode.appendChild(label)
          for (const item of group.items) listNode.appendChild(conversationRow(item, onOpenConversation))
        }
        if (selecting) listNode.dataset.workchatSelecting = '1'
        else delete listNode.dataset.workchatSelecting
        updateBulk()
        reportClient({ phase: `rows-${items.length}`, ...uiSnapshot() })
      }

      const ensure = () => {
        ensureRuns += 1
        const slotEl = document.querySelector('[data-slot="sidebar.workspaces"]')
        const region = slotEl?.parentElement
        if (!slotEl || !region) return

        const regionId = region.dataset.workchatRegion || (region.dataset.workchatRegion = String(++sectionCounter))
        const workspacesId = `workchat-workspaces-body-${regionId}`
        const conversationsId = `workchat-conversations-body-${regionId}`

        // 工作区区头：插在原生槽位之前
        let workspacesHeader = region.querySelector('[data-workchat-header="workspaces"]')
        if (!workspacesHeader || !workspacesHeader.isConnected) {
          workspacesHeader = createSectionHeader('workspaces', '工作区', workspacesId, 'workchatCollapsedWorkspaces', KEYS.collapsedWorkspaces)
          workspacesHeader.dataset.workchatSection = 'workspaces'
          region.insertBefore(workspacesHeader, slotEl)
        }
        if (!slotEl.id) slotEl.id = workspacesId

        // 对话区：区头 + 列表，插在工作区槽位之后
        let conversationsSection = region.querySelector('[data-workchat-section="conversations"]')
        if (!conversationsSection || !conversationsSection.isConnected) {
          conversationsSection = document.createElement('div')
          conversationsSection.dataset.workchatSection = 'conversations'
          const header = createSectionHeader('conversations', '对话区', conversationsId, 'workchatCollapsedConversations', KEYS.collapsedConversations, [
            { kind: 'conversations', label: '⟳', title: '与网页端同步对话', onClick: refreshConversations },
          ])
          listNode = document.createElement('div')
          listNode.dataset.workchatList = 'conversations'
          listNode.id = conversationsId
          emptyNode = document.createElement('div')
          emptyNode.dataset.workchatEmpty = '1'
          emptyNode.textContent = '暂无对话'
          bulkNode = document.createElement('div')
          bulkNode.dataset.workchatBulk = '1'
          bulkNode.hidden = true
          conversationsSection.append(header, listNode, emptyNode, bulkNode)
          region.insertBefore(conversationsSection, slotEl.nextSibling)
          renderList()
        } else if (!listNode || !listNode.isConnected) {
          listNode = conversationsSection.querySelector('[data-workchat-list="conversations"]')
          emptyNode = conversationsSection.querySelector('[data-workchat-empty]')
          bulkNode = conversationsSection.querySelector('[data-workchat-bulk]')
          renderList()
        }
      }

      const schedule = () => {
        scheduleRuns += 1
        if (queued) return
        queued = true
        setTimeout(() => {
          queued = false
          try {
            ensure()
            ensureModeBar()
            ensureLastError = null
          } catch (error) {
            ensureLastError = String(error?.message ?? error).slice(0, 160)
            console.warn('[workchat] 侧栏注入失败', error)
          }
          // 注入成功后立刻上报一次（1.5s 的定时探测可能早于侧栏挂载）
          const sidebarReady = Boolean(document.querySelector('[data-workchat-section="conversations"]'))
          const modeBarReady = Boolean(document.querySelector('[data-workchat-mode-bar]'))
          if (sidebarReady || modeBarReady) {
            reportClient({
              phase: `injected-${sidebarReady ? 1 : 0}${modeBarReady ? 1 : 0}`,
              slots: [],
              sidebar: sidebarReady,
              modeBar: modeBarReady,
              style: Boolean(document.querySelector('style[data-workchat-style]')),
              ...uiSnapshot(),
            })
          }
        }, 16)
      }

      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      schedule()

      const unsubscribe = conversationStore.subscribe(() => {
        renderList()
        // 选中态同步
        if (listNode) {
          const selected = conversationStore.get().selected
          for (const row of listNode.querySelectorAll('[data-workchat-row]')) {
            row.setAttribute('aria-current', row.dataset.workchatRow === selected ? 'true' : 'false')
          }
        }
      })

      return () => {
        unsubscribe()
        observer.disconnect()
        style.remove()
        modeBar.dispose()
        modeBar.bar.remove()
        document.querySelectorAll('[data-workchat-section="workspaces"]').forEach((node) => node.remove())
        document.querySelectorAll('[data-workchat-section="conversations"]').forEach((node) => node.remove())
        delete document.documentElement.dataset.workchatMode
      }
    }

    // ------------------------------------------------------------------
    // 5. UI 组件
    // ------------------------------------------------------------------

    /** 模式开关：DOM 实现，挂在空白会话页顶部（避开 single 槽的冲突）。 */
    function createModeBar() {
      const bar = document.createElement('div')
      bar.dataset.workchatModeBar = '1'
      const toggle = document.createElement('div')
      toggle.dataset.workchatModeToggle = '1'
      toggle.setAttribute('role', 'tablist')
      toggle.setAttribute('aria-label', '会话模式')

      const makeOption = (value, label) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.workchatModeOption = value
        button.textContent = label
        button.setAttribute('role', 'tab')
        button.addEventListener('click', () => modeStore.set({ mode: value }))
        return button
      }
      const work = makeOption('work', 'Work')
      const chat = makeOption('chat', 'Chat')
      toggle.append(work, chat)
      bar.append(toggle)

      const paint = () => {
        const mode = modeStore.get().mode
        work.setAttribute('aria-selected', mode === 'work' ? 'true' : 'false')
        chat.setAttribute('aria-selected', mode === 'chat' ? 'true' : 'false')
      }
      paint()
      const unsubscribe = modeStore.subscribe(paint)
      return { bar, dispose: unsubscribe }
    }

    /** 深度思考 / 智能搜索（图标 + 文案，与网页端语义一致）。 */
    function PrefIcon({ name }) {
      const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
      if (name === 'thinking') {
        return h('svg', common,
          h('path', { d: 'M9 18h6' }),
          h('path', { d: 'M10 21h4' }),
          h('path', { d: 'M12 3a6 6 0 0 0-3.5 10.9c.6.4.9 1 .9 1.7v.4h5.2v-.4c0-.7.3-1.3.9-1.7A6 6 0 0 0 12 3Z' }),
        )
      }
      return h('svg', common,
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'm20 20-3.2-3.2' }),
      )
    }

    function PrefToggles({ value, disabled, onChange }) {
      const toggle = (key) => {
        const next = { ...value, [key]: !value[key] }
        onChange(next)
      }
      return h('div', { style: { display: 'flex', gap: 6 } },
        h('button', {
          type: 'button',
          'data-workchat-pill': 'thinking',
          'aria-pressed': value.thinkingEnabled ? 'true' : 'false',
          disabled: Boolean(disabled),
          title: '深度思考：先推理再回答，耗时更长',
          onClick: () => toggle('thinkingEnabled'),
        }, h(PrefIcon, { name: 'thinking' }), h('span', null, '深度思考')),
        h('button', {
          type: 'button',
          'data-workchat-pill': 'search',
          'aria-pressed': value.searchEnabled ? 'true' : 'false',
          disabled: Boolean(disabled),
          title: '智能搜索：联网检索后再回答',
          onClick: () => toggle('searchEnabled'),
        }, h(PrefIcon, { name: 'search' }), h('span', null, '联网搜索')),
      )
    }

    /**
     * Chat 输入框。
     * context: 'hero' 新建页 | 'panel' 对话页
     */
    function ChatComposer({ context, sessionId, initialPrefs, onConversation, disabled: parentDisabled }) {
      const [text, setText] = useState('')
      const [prefs, setPrefs] = useState(initialPrefs ?? prefsStore.get())
      const [busy, setBusy] = useState(false)
      const abortRef = useRef(null)
      const textareaRef = useRef(null)

      useEffect(() => {
        if (context === 'hero') textareaRef.current?.focus()
        reportClient({ phase: `composer-${context}` })
      }, [context])

      // 面板加载完历史后，把会话记录的偏好同步进输入框
      useEffect(() => {
        if (initialPrefs) {
          setPrefs({
            thinkingEnabled: initialPrefs.thinkingEnabled === true,
            searchEnabled: initialPrefs.searchEnabled === true,
          })
        }
      }, [initialPrefs?.thinkingEnabled, initialPrefs?.searchEnabled])

      const setPrefsAndPersist = (next) => {
        setPrefs(next)
        if (context === 'hero') {
          prefsStore.set(next)
          const parts = []
          if (next.thinkingEnabled) parts.push('thinking')
          if (next.searchEnabled) parts.push('search')
          writeLocal(KEYS.prefs, parts.join(','))
        }
        if (context === 'panel' && sessionId) {
          apiPost('/workchat/chat-state', {
            sessionId,
            thinkingEnabled: next.thinkingEnabled,
            searchEnabled: next.searchEnabled,
          }).catch(() => { /* 失败不打断输入 */ })
        }
      }

      const stop = () => {
        abortRef.current?.abort()
      }

      const send = async () => {
        const prompt = text.trim()
        if (prompt === '' || busy) return
        setBusy(true)
        setText('')
        const controller = new AbortController()
        abortRef.current = controller
        let assistant = ''
        let resolved = sessionId ?? null

        const finishFallback = async (reason) => {
          setBusy(false)
          abortRef.current = null
          toast(reason || '网页端不可用，已切换为本地会话', 'error')
          try {
            const workspace = ctxRef?.uiWorkspace ?? ctxRef?.get?.('uiWorkspace')
            workspace?.startSession?.(undefined, { prompt })
          } catch { /* 服务缺失时只提示 */ }
          modeStore.set({ mode: 'work' })
          applyModeAttribute('work')
          writeLocal(KEYS.mode, 'work')
        }

        try {
          const response = await fetch('/workchat/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              prompt,
              thinkingEnabled: prefs.thinkingEnabled,
              searchEnabled: prefs.searchEnabled,
            }),
            signal: controller.signal,
          })
          if (response.status === 409) {
            toast('上一条还在生成中，请稍候')
            setBusy(false)
            return
          }
          if (!response.ok || !response.body) {
            await finishFallback(`网页端不可用（HTTP ${response.status}）`)
            return
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let failed = null

          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
            const frames = buffer.split('\n\n')
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              const line = frame.split('\n').find((item) => item.startsWith('data:'))
              if (!line) continue
              let event = null
              try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
              if (event.type === 'meta') {
                resolved = event.sessionId
                onConversation?.(resolved, { prompt, prefs })
                // 更新地址栏选中态，列表稍后刷新
                loadConversations(true)
              } else if (event.type === 'delta') {
                assistant += event.text
                onStream?.({ sessionId: resolved, text: assistant })
              } else if (event.type === 'thinking') {
                onStream?.({ sessionId: resolved, thinking: event.text })
              } else if (event.type === 'error') {
                failed = event
              } else if (event.type === 'done') {
                resolved = event.sessionId ?? resolved
              }
            }
          }

          if (failed) {
            if (failed.fallback) await finishFallback(failed.message)
            else toast(failed.message || '发送失败')
          } else if (resolved) {
            onConversation?.(resolved, { prompt, prefs })
            loadConversations(true)
          }
        } catch (error) {
          if (error?.name === 'AbortError') toast('已停止生成')
          else await finishFallback(String(error?.message ?? error))
        } finally {
          setBusy(false)
          abortRef.current = null
        }
      }

      return h('div', { 'data-workchat-composer': context },
        h('textarea', {
          ref: textareaRef,
          value: text,
          placeholder: context === 'hero' ? '和 DeepSeek 网页端聊天…' : '继续对话…',
          rows: 1,
          disabled: busy || parentDisabled,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
              event.preventDefault()
              send()
            }
          },
        }),
        h('div', { 'data-workchat-composer-bar': '1' },
          h(PrefToggles, { value: prefs, disabled: busy, onChange: setPrefsAndPersist }),
          h('button', {
            type: 'button',
            'data-workchat-send': '1',
            'aria-label': busy ? '停止生成' : '发送',
            disabled: busy ? false : text.trim() === '',
            onClick: busy ? stop : send,
          }, busy
            ? h('span', { style: { width: 10, height: 10, background: 'currentColor', borderRadius: 2, display: 'block' } })
            : h('svg', {
                width: 16,
                height: 16,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 2.2,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true,
              },
                h('path', { d: 'M12 19V5' }),
                h('path', { d: 'm5 12 7-7 7 7' }),
              )),
        ),
      )
    }

    // ctx 在 apply 里注入给组件（bundle 内共享）
    let ctxRef = null
    let onStream = null

    /** 主面板：网页端对话视图。 */
    function WorkChatPanel() {
      const { selected } = useSyncExternalStore(conversationStore.subscribe, conversationStore.getSnapshot)
      const [messages, setMessages] = useState([])
      const [status, setStatus] = useState('idle')
      const [error, setError] = useState(null)
      const [prefs, setPrefs] = useState(prefsStore.get())
      const [liveText, setLiveText] = useState('')
      const bodyRef = useRef(null)

      const load = useCallback(async (sessionId) => {
        if (!sessionId) { setMessages([]); setStatus('idle'); return }
        setStatus('loading')
        setError(null)
        const { ok, json } = await apiGet(`/workchat/history?sessionId=${encodeURIComponent(sessionId)}`)
        if (!ok || !json) {
          setStatus('error')
          setError(json?.message ?? '加载失败')
          return
        }
        setMessages(Array.isArray(json.messages) ? json.messages : [])
        setPrefs({
          thinkingEnabled: json.thinkingEnabled === true,
          searchEnabled: json.searchEnabled === true,
        })
        setStatus('ready')
      }, [])

      useEffect(() => { load(selected) }, [selected, load])

      // 面板首次出现时做一次渲染自检（Markdown + 公式）
      useEffect(() => { selfTestRenderer() }, [])

      useEffect(() => {
        onStream = ({ text }) => {
          if (typeof text === 'string') setLiveText(text)
        }
        return () => { onStream = null }
      }, [selected])

      useEffect(() => {
        const body = bodyRef.current
        if (body) body.scrollTop = body.scrollHeight
      }, [messages, liveText])

      const title = conversationStore.get().items.find((item) => item.id === selected)?.title ?? '对话区'

      const composer = h(ChatComposer, {
        context: 'panel',
        sessionId: selected ?? undefined,
        initialPrefs: prefs,
        onConversation: (id) => {
          setLiveText('')
          loadConversations(true)
          openConversation(ctxRef, id).catch((error) => console.warn('[workchat] open failed', error))
        },
      })

      // 未选中对话：模仿 Work 首页的居中布局（鱼形标记 + slogan + 输入框）
      if (selected === null) {
        return h('div', { 'data-workchat-panel': '1', 'data-workchat-home': '1' },
          h('div', { 'data-workchat-home-stack': '1' },
            h('div', { 'data-workchat-home-brand': '1' },
              h('svg', {
                viewBox: FISH_LOGO_VIEWBOX,
                width: 34,
                height: 25,
                fill: 'none',
                'aria-hidden': true,
              }, h('path', { d: FISH_LOGO_PATH, fill: 'currentColor' })),
              h('span', { 'data-workchat-home-title': '1' }, HERO_HEADLINE),
            ),
            h('div', { 'data-workchat-home-composer': '1' }, composer),
          ),
        )
      }

      return h('div', { 'data-workchat-panel': '1' },
        h('div', { 'data-workchat-panel-head': '1' },
          h('button', {
            type: 'button',
            'data-workchat-linkbtn': '1',
            onClick: () => {
              conversationStore.set({ selected: null })
            },
          }, '← 新对话'),
          h('div', { 'data-workchat-panel-title': '1' }, title),
          h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', {
              type: 'button',
              'data-workchat-linkbtn': '1',
              onClick: () => load(selected),
            }, '刷新'),
          ),
        ),
        h('div', { 'data-workchat-panel-body': '1', ref: bodyRef },
          status === 'loading'
            ? h('div', null, h('div', { 'data-workchat-skeleton': '1' }), h('div', { 'data-workchat-skeleton': '1' }))
            : status === 'error'
              ? h('div', { 'data-workchat-empty': '1' }, `加载失败：${error ?? ''}`)
              : messages.length === 0 && liveText === ''
                ? h('div', { 'data-workchat-empty': '1' }, '这个对话还没有消息，直接在下方输入即可。')
                : messages.map((message, index) => h(MessageRow, { key: `${index}-${message.at ?? 0}`, message })),
          liveText !== ''
            ? h('div', { 'data-workchat-msg': 'assistant' },
                h('div', { 'data-workchat-bubble': '1' }, liveText))
            : null,
        ),
        h('div', { 'data-workchat-panel-foot': '1' }, composer),
      )
    }

    function MessageRow({ message }) {
      return h('div', { 'data-workchat-msg': message.role },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 'min(680px, 86%)' } },
          message.thinking
            ? h('details', { 'data-workchat-thinking': '1' },
                h('summary', { style: { cursor: 'pointer', fontSize: 12, opacity: .62 } }, '深度思考'),
                h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6, fontSize: 12, opacity: .72 } }, message.thinking),
              )
            : null,
          h(MessageBody, { text: message.content ?? '' }),
        ),
      )
    }

    /** 设置页：DeepSeek 网页账号。 */
    function DeepSeekAccountSection() {
      const [form, setForm] = useState({ email: '', mobile: '', areaCode: '+86', password: '', userToken: '' })
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)

      useEffect(() => {
        let alive = true
        apiGet('/workchat/credentials').then(({ json }) => {
          if (!alive || !json) return
          setStatus(json)
          setForm((prev) => ({ ...prev, email: json.email || '', mobile: json.mobile || '', areaCode: json.areaCode || '+86' }))
        }).catch(() => {})
        return () => { alive = false }
      }, [])

      const patch = (key) => (event) => {
        const value = event.target.value
        setForm((prev) => ({ ...prev, [key]: value }))
      }

      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          const { ok, json } = await apiPost('/workchat/credentials', form)
          if (!ok) throw new Error(json?.message || '保存失败')
          setStatus(json)
          setForm((prev) => ({ ...prev, password: '', userToken: '' }))
          setMessage({ tone: 'ok', text: '已保存到本机（$DSH_HOME/workchat/credentials.json）' })
          loadConversations(true)
        } catch (error) {
          setMessage({ tone: 'error', text: String(error?.message || error) })
        } finally { setBusy('') }
      }

      const test = async () => {
        setBusy('test')
        setMessage(null)
        try {
          const { ok, json } = await apiPost('/workchat/login-test')
          if (!ok || !json?.ok) throw new Error([json?.stage, json?.message].filter(Boolean).join('：') || '登录失败')
          const label = json.kind === 'token' ? 'userToken' : json.kind === 'mobile' ? '手机号' : '邮箱'
          const suffix = typeof json.count === 'number' ? `，最近 ${json.count} 条` : ''
          setMessage({ tone: 'ok', text: `连接成功（${label} 方式${suffix}）` })
          const refreshed = await apiGet('/workchat/credentials')
          if (refreshed.json) setStatus(refreshed.json)
        } catch (error) {
          setMessage({ tone: 'error', text: String(error?.message || error) })
        } finally { setBusy('') }
      }

      const stateText = status?.tokenPresent ? '已登录' : (status?.hasUserToken || status?.configured) ? '已配置，未验证' : '未配置'

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 } },
        h('div', { style: { fontSize: 12, opacity: .62, lineHeight: 1.6 } },
          '推荐方式：从网页版复制 userToken（网页版按 F12 → Application → Local Storage → userToken，或任意请求头里的 Bearer 值）。',
          h('br'),
          '密码登录会被 DeepSeek 的人机验证（AWS WAF）拦截，仅作备用。凭据只保存在本机。'),
        h('label', { style: { fontSize: 12, opacity: .72 } }, 'userToken（推荐）'),
        h('input', {
          value: form.userToken,
          onChange: patch('userToken'),
          placeholder: status?.hasUserToken ? '已保存，留空表示不修改' : '粘贴 userToken',
          style: inputStyle,
          autoComplete: 'off',
        }),
        h('label', { style: { fontSize: 12, opacity: .72 } }, '邮箱'),
        h('input', { value: form.email, onChange: patch('email'), placeholder: 'name@example.com', style: inputStyle }),
        h('label', { style: { fontSize: 12, opacity: .72 } }, '手机号（与邮箱二选一）'),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', { value: form.areaCode, onChange: patch('areaCode'), placeholder: '+86', style: { ...inputStyle, width: 84 } }),
          h('input', { value: form.mobile, onChange: patch('mobile'), placeholder: '13800000000', style: inputStyle }),
        ),
        h('label', { style: { fontSize: 12, opacity: .72 } }, '密码'),
        h('input', {
          type: 'password',
          value: form.password,
          onChange: patch('password'),
          placeholder: status?.hasPassword ? '已保存，留空表示不修改' : '账号密码',
          style: inputStyle,
        }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { onClick: save, disabled: Boolean(busy), style: { ...buttonStyle, opacity: busy ? .6 : 1 } }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { onClick: test, disabled: Boolean(busy), style: { ...buttonStyle, opacity: busy ? .6 : 1 } }, busy === 'test' ? '测试中…' : '测试连接'),
          h('span', { style: { fontSize: 12, opacity: .6 } }, stateText),
        ),
        message ? h('div', { style: { fontSize: 12, color: message.tone === 'error' ? '#e74c3c' : 'inherit', opacity: message.tone === 'error' ? 1 : .7 } }, message.text) : null,
      )
    }

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))', background: 'transparent',
      color: 'inherit', fontSize: 13, outline: 'none',
    }
    const buttonStyle = {
      padding: '7px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      background: 'rgba(128,128,128,.08)', color: 'inherit', fontSize: 13, cursor: 'pointer',
    }

    // ------------------------------------------------------------------
    // 6. 数据加载
    // ------------------------------------------------------------------
    let loadTimer = null

    // bundle 一进来就报一次，用于区分"bundle 没加载"和"apply 出错"
    reportClient({ phase: 'boot' })

    async function loadConversations(force = false) {
      if (conversationStore.get().status === 'loading') return
      conversationStore.set({ status: 'loading' })
      try {
        const { ok, json } = await apiGet(`/workchat/conversations${force ? '?refresh=1' : ''}`)
        if (!ok || !json) {
          const stage = json?.stage
          if (stage === 'input' || stage === 'auth') {
            conversationStore.set({ status: 'unconfigured', error: json?.message ?? null })
            return
          }
          conversationStore.set({
            status: 'error',
            error: json?.message ?? `HTTP ${ok ? 200 : 'error'}`,
            items: json?.cached?.items ?? conversationStore.get().items,
          })
          return
        }
        conversationStore.set({
          items: Array.isArray(json.items) ? json.items : [],
          status: 'ready',
          error: null,
          fetchedAt: json.fetchedAt ?? 0,
        })
        // Chat 模式按需自动选中最近一条（已移除：切到 Chat 应保持空白新对话）
      } catch (error) {
        conversationStore.set({ status: 'error', error: String(error?.message ?? error) })
      }
    }

    function startPolling() {
      const tick = () => {
        if (document.visibilityState === 'visible') loadConversations(false)
      }
      loadConversations(true)
      loadTimer = setInterval(tick, 60_000)
      const onVisible = () => { if (document.visibilityState === 'visible') loadConversations(false) }
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        clearInterval(loadTimer)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }

    async function openConversation(ctx, id) {
      reportClient({ phase: `open-enter-${Date.now()}`, enteringId: String(id).slice(0, 8) })
      conversationStore.set({ selected: id })
      try {
        ctx.layout.selectPanel('workchat')
        reportClient({ phase: `open-${Date.now()}`, selectedId: String(id).slice(0, 8), openOk: true })
      } catch (error) {
        console.warn('[workchat] selectPanel failed', error)
        lastOpenError = String(error?.message ?? error).slice(0, 120)
        reportClient({ phase: `open-err-${Date.now()}`, selectedId: String(id).slice(0, 8), openOk: false, openError: lastOpenError })
        toast('打不开对话：' + String(error?.message ?? error), 'error')
      }
    }

    // ------------------------------------------------------------------
    // 7. apply
    // ------------------------------------------------------------------
    return {
      name: 'dsh-work-chat',
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctxRef = null
        try {
          // 运行期把 ctx 暴露给组件闭包
          ctxRef = ctx
          applyModeAttribute(modeStore.get().mode)

          // 单个槽位注册失败不应拖垮整个插件
          const registeredSlots = []
          const safeRegister = (label, fn) => {
            try {
              const result = fn()
              registeredSlots.push(label)
              return result
            } catch (error) {
              console.warn(`[workchat] ${label} 注册失败`, error)
              return null
            }
          }

          // 设置页
          safeRegister('settings.section', () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'workchat',
            order: 70,
            label: () => 'DeepSeek 网页账号',
          }, DeepSeekAccountSection)))

          // 新会话页顶部开关由侧栏注入统一挂载（DOM），这里不再注册 header 槽

          // 主面板
          safeRegister('main', () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'workchat',
            id: 'workchat-panel',
          }, WorkChatPanel)))

          // 侧栏注入 + 轮询
          ctx.effect(() => {
            const disposeSidebar = mountSidebar(ctx, (id) => openConversation(ctx, id))
            const stopPolling = startPolling()
            const heartbeatTimer = setTimeout(() => {
              reportClient({
                phase: 'mounted',
                slots: registeredSlots,
                sidebar: Boolean(document.querySelector('[data-workchat-section="conversations"]')),
                modeBar: Boolean(document.querySelector('[data-workchat-mode-bar]')),
                style: Boolean(document.querySelector('style[data-workchat-style]')),
              })
            }, 1500)
            // 低频周期快照：方便在看不到浏览器时持续核对界面状态
            const tickTimer = setInterval(() => {
              reportClient({ phase: `tick-${Math.floor(Date.now() / 60000)}`, slots: registeredSlots })
            }, 60_000)
            return () => { clearTimeout(heartbeatTimer); clearInterval(tickTimer); disposeSidebar(); stopPolling() }
          }, 'dsh-work-chat: sidebar')

          // 模式变化：同步属性 + 重新注册 composer 接管
          let composerDispose = null
          let composerInjectDispose = null
          const applyComposer = () => {
            try { composerDispose?.() } catch { /* ignore */ }
            composerDispose = null
            try { composerInjectDispose?.() } catch { /* ignore */ }
            composerInjectDispose = null
            if (modeStore.get().mode !== 'chat') return
            try {
              // 声明感知：槽位就绪（或重建）后再注册，避免启动时序丢失
              composerInjectDispose = ctx.slots.inject('conversation.composer', () => {
                composerDispose = ctx.slots.register({
                  name: 'conversation.composer',
                  // 比默认输入框更靠前，否则默认 selector 先命中
                  priority: -10,
                  select: (owner) => {
                    if (modeStore.get().mode !== 'chat') return null
                    if (!owner) return null
                    if (owner.pendingInteraction) return null
                    // 空白新会话页有两种形态：无 sessionId，或有 id 但页面处于 hero 阶段
                    let heroPage = false
                    try { heroPage = document.querySelector('[data-phase="hero"]') !== null } catch { /* SSR/无 DOM */ }
                    const blank = owner.sessionId === undefined || owner.session?.blank === true
                    return (blank || heroPage) ? { kind: 'workchat' } : null
                  },
                }, () => h(ChatComposer, {
                  context: 'hero',
                  onConversation: (id) => {
                    conversationStore.set({ selected: id })
                    openConversation(ctx, id).catch((error) => console.warn('[workchat] open imported failed', error))
                  },
                }))
                if (!registeredSlots.includes('conversation.composer')) registeredSlots.push('conversation.composer')
                return () => {
                  try { composerDispose?.() } catch { /* ignore */ }
                  composerDispose = null
                }
              })
            } catch (error) {
              console.warn('[workchat] composer takeover failed', error)
              reportClient({ phase: 'composer-error', error: String(error?.message ?? error).slice(0, 160) })
            }
          }
          applyComposer()

          let appliedMode = modeStore.get().mode
          const unsubscribeMode = modeStore.subscribe(() => {
            const mode = modeStore.get().mode
            // 点击当前已选中的那一段：什么都不做（不导航、不重渲染）
            if (mode === appliedMode) return
            appliedMode = mode
            applyModeAttribute(mode)
            writeLocal(KEYS.mode, mode)
            applyComposer()
            // Chat 模式切到对话区面板；进入时清空选中，保持空白新对话
            try {
              if (mode === 'chat') {
                conversationStore.set({ selected: null })
                ctx.layout.selectPanel('workchat')
                modeOpenedPanel = true
              } else if (modeOpenedPanel) {
                ctx.layout.selectPanel(null)
                modeOpenedPanel = false
              }
            } catch (error) {
              console.warn('[workchat] mode navigation failed', error)
            }
            reportClient({ phase: `mode-${mode}`, slots: registeredSlots })
          })

          // 启动后跑一次渲染自检（Markdown + 公式），结果随心跳上报
          setTimeout(() => { selfTestRenderer().catch(() => {}) }, 800)

          // 上次停在 Chat 模式时，启动后自动回到对话区面板
          if (modeStore.get().mode === 'chat') {
            setTimeout(() => {
              try {
                ctx.layout.selectPanel('workchat')
                modeOpenedPanel = true
              } catch (error) {
                console.warn('[workchat] auto open panel failed', error)
              }
            }, 900)
          }

          reportClient({ phase: 'apply', slots: registeredSlots })

          ctx.effect(() => () => {
            unsubscribeMode()
            try { composerDispose?.() } catch { /* ignore */ }
          }, 'dsh-work-chat: composer')
        } catch (error) {
          console.error('[workchat] apply failed', error)
          try {
            reportClient({
              phase: 'apply-error',
              error: String(error?.message ?? error).slice(0, 160),
            })
          } catch { /* 心跳本身失败则放弃 */ }
        } finally {
          ctxRef = ctx
        }
      },
    }
  },
})
