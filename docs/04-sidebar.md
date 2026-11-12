# M4 · 侧边栏分区（工作区 / 对话区）

## 目标

侧栏出现两个可折叠分区：**工作区**（包裹原有工作区列表）与**对话区**（我们的网页端对话列表），交互与现有侧栏行一致：悬停加深、点击整体收起、状态记忆、键盘可达。

## 约束（已核实）

- `sidebar.workspaces` 是 **single** 槽，被 ui-workspace 独占，**不能**在槽内加标题。
- 侧栏外壳把该槽渲染在 `regionArea`（div）里，槽输出本身是 `<div data-slot="sidebar.workspaces" style="display:contents">`。
- 侧栏收成 56px 轨道时 `regionArea` 内容整体不渲染。

## 方案

在 `regionArea` 内、工作区槽**之前**插区头；在槽之后插对话区（区头 + 列表）。不移动、不包裹 React 管理的节点，只做兄弟节点增删。

```
div.regionArea
├── div[data-workchat-section="workspaces"]      ← 我们插入（仅区头）
├── div[data-slot="sidebar.workspaces"]          ← 原有，保持原位
├── div[data-workchat-section="conversations"]   ← 我们插入（区头 + 列表）
└── (其余原有内容)
```

### 注入流程

1. `apply()` 后等待 `[data-slot="sidebar.workspaces"]` 出现（`MutationObserver` + 首帧 `querySelector`）。
2. `ensureSections()`：
   - 取 `slotEl.parentElement`（`regionArea`）；
   - 缺工作区区头 → `regionArea.insertBefore(header, slotEl)`；
   - 缺对话区节点 → `slotEl.after(section)`；
   - 任一节点已存在则跳过（幂等）。
3. `MutationObserver(regionArea, { childList: true })`：React 重渲染把节点冲掉时重跑 `ensureSections()`，用 `requestAnimationFrame` 合并抖动，插入期间置 `inserting` 标志避免自触发。
4. 组件卸载（`ctx.effect` 的 dispose）：断开 observer、移除节点与 `<style>`。

### 区头交互

| 行为 | 实现 |
|---|---|
| 悬停加深 | `:hover` 背景 `--dsw-alias-bg-secondary`（兜底 `rgba(128,128,128,.12)`），左右内缩 3px、圆角 6px |
| 点击折叠 | 切换 `html[data-workchat-collapsed-<section>]`，CSS 隐藏对应内容 |
| 箭头 | `▸` 旋转 90° → `▾`，`transform` 180ms；`prefers-reduced-motion` 时无过渡 |
| 键盘 | 用 `<button>`，原生 Enter/Space；`:focus-visible` 描边 |
| 无障碍 | `aria-expanded`、`aria-controls` 指向内容容器 id |
| 记忆 | `localStorage['workchat.collapsed.workspaces'\|'.conversations']` |

### 折叠 CSS

```css
html[data-workchat-collapsed-workspaces] [data-slot="sidebar.workspaces"] { display: none; }
html[data-workchat-collapsed-conversations] [data-workchat-list="conversations"] { display: none; }
```

### 样式隔离

所有样式挂在 `<style data-workchat-style>` 下，选择器一律带 `[data-workchat-*]` 前缀，不写全局元素选择器，避免影响宿主。

## 边界情况

- **首次渲染时序**：槽位可能晚于插件就绪 → observer 兜底，最多重试 20 次后放弃并记一条 debug 日志。
- **重复注入**：`ensureSections` 幂等；页面切换（全局面板）导致 regionArea 重建时自动补回。
- **轨道态**：节点仍在 DOM 但父容器隐藏，无需特殊处理。
- **DSH 升级**：只依赖 `data-slot` 锚点；锚点消失时降级为"仅对话区、不折叠工作区"并提示。

## 验收

- [ ] 侧栏出现「工作区」「对话区」两行，悬停底色加深、圆角与现有行一致。
- [ ] 点「工作区」→ 工作区列表消失，再点恢复；「对话区」独立。
- [ ] 刷新页面后折叠状态保持。
- [ ] Tab 可聚焦两个区头，Enter/Space 可切换。
- [ ] 侧栏收成轨道再展开，两个区头仍在且状态正确。
- [ ] 打开全局面板（插件页）再回到会话，区头未被冲掉。
