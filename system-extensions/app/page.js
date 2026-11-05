/**
 * `app` 系统扩展的首页（无框架，纯 DOM）。
 *
 * 数据来自 `apps.list`（appStore 的卡片表），点击卡片走 `apps.open`（与旧 AppView 的
 * `window.api.openAppWindow` 同一条路）。
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
const gridEl = document.getElementById('grid')
const searchEl = document.getElementById('search')
let all = []

function isSvg(icon) {
  return typeof icon === 'string' && icon.trim().startsWith('<svg')
}

function card(item) {
  const el = document.createElement('button')
  el.className = 'card'
  el.type = 'button'
  el.title = item.description || item.name

  const icon = document.createElement('span')
  icon.className = 'card-icon'
  if (isSvg(item.icon)) icon.innerHTML = item.icon
  else icon.textContent = (item.name || '?').slice(0, 1)
  el.appendChild(icon)

  const name = document.createElement('span')
  name.className = 'card-name'
  name.textContent = item.name || item.id
  el.appendChild(name)

  const desc = document.createElement('span')
  desc.className = 'card-desc'
  desc.textContent = item.description || ''
  el.appendChild(desc)

  const open = async () => {
    el.disabled = true
    try {
      await call('apps.open', { id: item.id })
    } catch (error) {
      statusEl.textContent = `打开失败：${error.message}`
    } finally {
      el.disabled = false
    }
  }
  el.addEventListener('click', () => void open())
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    showMenu(event.clientX, event.clientY, [
      { label: '打开', run: open },
      {
        label: '在扩展管理中查看',
        run: async () => {
          await call('pages.open', { pageId: 'ext-manager' })
        }
      }
    ])
  })
  return el
}

/** 卡片右键菜单（页面内自绘；点空白处关闭） */
let menuEl = null
function closeMenu() {
  menuEl?.remove()
  menuEl = null
}
function showMenu(x, y, items) {
  closeMenu()
  menuEl = document.createElement('div')
  menuEl.className = 'ctx-menu'
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ctx-item'
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      closeMenu()
      void item.run()
    })
    menuEl.appendChild(btn)
  }
  menuEl.style.left = `${x}px`
  menuEl.style.top = `${y}px`
  document.body.appendChild(menuEl)
}
window.addEventListener('click', closeMenu)
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu()
})

function render() {
  const q = (searchEl.value || '').trim().toLowerCase()
  const items = q
    ? all.filter(
        (i) =>
          String(i.name || '')
            .toLowerCase()
            .includes(q) ||
          String(i.description || '')
            .toLowerCase()
            .includes(q)
      )
    : all
  gridEl.replaceChildren(...items.map(card))
  statusEl.textContent =
    all.length === 0
      ? '暂无已注册的应用（扩展可经 api.app.register 注册卡片）'
      : q
        ? `匹配 ${items.length} / ${all.length} 个应用`
        : `共 ${all.length} 个应用`
}

async function refresh() {
  try {
    const list = await call('apps.list')
    all = Array.isArray(list) ? list : []
    render()
  } catch (error) {
    statusEl.textContent = `读取失败：${error.message}`
  }
}

searchEl.addEventListener('input', render)
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
