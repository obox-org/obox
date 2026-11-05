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

function sourceLabel(source) {
  return source === 'system' ? '系统' : '用户'
}

function row(ext) {
  const li = document.createElement('li')
  li.className = 'ext-row'

  const meta = document.createElement('div')
  meta.className = 'ext-meta'
  const title = document.createElement('div')
  title.className = 'ext-title'
  title.textContent = ext.id
  const badge = document.createElement('span')
  badge.className = ext.source === 'system' ? 'badge system' : 'badge'
  badge.textContent = sourceLabel(ext.source)
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
        : '已启用'
  meta.appendChild(state)
  li.appendChild(meta)

  if (ext.source !== 'system' && !ext.shadowed) {
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

document.getElementById('restart').addEventListener('click', () => {
  void call('extensions.restartHost')
})

void refresh()
