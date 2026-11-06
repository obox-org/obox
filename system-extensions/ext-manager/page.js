/**
 * `ext-manager` 页面脚本（无框架，纯 DOM）。
 *
 * 与壳子的协议：`postMessage({ type: 'obox:page-call', id, op, args })` →
 * 壳子用 `runHostQuery(op, args)` 回答 `{ type: 'obox:page-reply', id, ok, result, error }`。
 * 页面不直接碰 Node/DOM 之外的宿主能力（与宿主里的扩展共享同一批 op）。
 */
const pending = new Map()
let seq = 0

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'obox:page-reply') return
  const entry = pending.get(data.id)
  if (!entry) return
  pending.delete(data.id)
  if (data.ok) entry.resolve(data.result)
  else entry.reject(new Error(data.error || '调用失败'))
})

function call(op, args = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parent.postMessage({ type: 'obox:page-call', id, op, args }, '*')
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`调用超时：${op}`))
    }, 15000)
  })
}

const statusEl = document.getElementById('status')
const listEl = document.getElementById('list')

/** 建元素小工具（本页独立，不依赖其它扩展） */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function sourceLabel(source, runtime) {
  if (runtime) return '运行时'
  return source === 'system' ? '系统' : '用户'
}

function row(ext) {
  const li = document.createElement('li')
  li.className = 'ext-row'
  // 运行时包（目录根有 runtime.json）：落在系统扩展目录，但**不随安装包分发** ⇒ 允许卸载/覆盖升级
  const isRuntime = ext.runtime === true

  const meta = document.createElement('div')
  meta.className = 'ext-meta'
  const title = document.createElement('div')
  title.className = 'ext-title'
  title.textContent = ext.id
  const badge = document.createElement('span')
  badge.className = ext.source === 'system' ? 'badge system' : 'badge'
  badge.textContent = sourceLabel(ext.source, isRuntime)
  title.appendChild(badge)
  meta.appendChild(title)

  const state = document.createElement('div')
  state.className = 'ext-state'
  state.textContent = ext.shadowed
    ? '已被系统扩展遮蔽'
    : ext.enabled === false
      ? '已禁用'
      : ext.error
        ? `清单错误：${ext.error}`
        : ext.isActive
          ? '已启用 · 运行中'
          : '已启用'
  meta.appendChild(state)

  // 详情（点击行展开）：版本/作者/入口/描述/校验错误——排障时最常看这几项
  const details = document.createElement('dl')
  details.className = 'ext-details'
  const manifest = ext.manifest || {}
  const addRow = (label, value) => {
    if (value === undefined || value === null || value === '') return
    details.append(el('dt', '', label), el('dd', '', String(value)))
  }
  addRow('版本', manifest.version)
  addRow('作者', manifest.author)
  addRow('入口', manifest.main)
  addRow('描述', manifest.description || manifest.displayName)
  const sourceText = isRuntime
    ? '运行时包（安装目录·手动安装）'
    : ext.source === 'system'
      ? '系统扩展（安装目录）'
      : '用户扩展（userData）'
  addRow('来源', sourceText)
  if (ext.requiresRestart) addRow('状态', '需重启生效')
  for (const v of ext.validations || []) {
    if (v && v.severity === 'error') addRow('校验错误', v.message)
  }

  const toggle = () => {
    const open = details.classList.toggle('open')
    li.classList.toggle('expanded', open)
  }
  meta.addEventListener('click', toggle)
  li.appendChild(meta)
  li.appendChild(details)

  // 系统扩展不渲染操作按钮（底层也拒绝）；运行时包例外——它由用户手动安装，必须可卸载/升级
  if ((ext.source !== 'system' || isRuntime) && !ext.shadowed) {
    const actions = document.createElement('div')
    actions.className = 'ext-actions'

    const toggle = document.createElement('button')
    toggle.className = 'btn'
    toggle.type = 'button'
    toggle.textContent = ext.enabled === false ? '启用' : '禁用'
    toggle.addEventListener('click', async () => {
      toggle.disabled = true
      try {
        await call('extensions.setEnabled', { id: ext.id, enabled: ext.enabled === false })
        await refresh()
      } catch (error) {
        statusEl.textContent = `操作失败：${error.message}`
      } finally {
        toggle.disabled = false
      }
    })
    actions.appendChild(toggle)

    const remove = document.createElement('button')
    remove.className = 'btn danger'
    remove.type = 'button'
    remove.textContent = '卸载'
    remove.addEventListener('click', async () => {
      remove.disabled = true
      try {
        await call('extensions.uninstall', { id: ext.id })
        await refresh()
      } catch (error) {
        statusEl.textContent = `卸载失败：${error.message}`
      } finally {
        remove.disabled = false
      }
    })
    actions.appendChild(remove)
    li.appendChild(actions)
  }
  return li
}

async function refresh() {
  try {
    const list = await call('extensions.list')
    const exts = Array.isArray(list) ? list : []
    statusEl.textContent = `共 ${exts.length} 个扩展（系统扩展不可卸载/禁用）`
    listEl.replaceChildren(...exts.map(row))
  } catch (error) {
    statusEl.textContent = `读取失败：${error.message}`
  }
}

document.getElementById('install').addEventListener('click', async () => {
  try {
    const outcome = await call('extensions.install')
    // 用户在文件选择器里取消时返回 null：不是错误，什么都不做
    if (outcome && outcome.ok === false) statusEl.textContent = `安装失败：${outcome.error}`
    await refresh()
  } catch (error) {
    statusEl.textContent = `安装失败：${error.message}`
  }
})

document.getElementById('restart').addEventListener('click', () => {
  void call('extensions.restartHost')
})

void refresh()
/**
 * 主题跟随：CSS 变量不跨文档，壳子在 iframe 加载后以 `obox-theme` 下发 token。
 * 这里把 token 写到根元素上（`--x` 形式），页面样式直接用 `var(--x)`。
 */
window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'obox-theme' || !data.tokens) return
  for (const [key, value] of Object.entries(data.tokens)) {
    if (typeof value === 'string') document.documentElement.style.setProperty(`--${key}`, value)
  }
})
