/**
 * `app` 系统扩展的首页（无框架，纯 DOM）。
 *
 * 数据来自 `apps.list`（appStore 的卡片表），点击卡片走 `apps.open`（与旧 AppView 的
 * `window.api.openAppWindow` 同一条路）。
 *
 * 主题与语言：由页面运行时 `app://obox/page.js` 统一驱动（change `unified-page-context`）——
 * 它把 `obox:context` 里的 25 个 token 写进 `:root`、设 `colorScheme`，并给出 `t()`。
 * 页面**不再自己监听 `obox-theme`**（旧协议由壳子继续发，但新页面只认上下文）。
 */
import { startPageContext } from 'app://obox/page.js'

const pending = new Map()
let seq = 0

const pageContext = startPageContext({
  onChange: () => {
    applyStaticText()
    render()
  }
})
/** 当前语言取词（缺 key 回退 key；参数用 `{name}` 插值） */
const t = (key, params) => pageContext.t(key, params)

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'obox:page-reply') return
  const entry = pending.get(data.id)
  if (!entry) return
  pending.delete(data.id)
  if (data.ok) entry.resolve(data.result)
  else entry.reject(new Error(data.error || t('common.callFailed')))
})

function call(op, args = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parent.postMessage({ type: 'obox:page-call', id, op, args }, '*')
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(t('common.callTimeout', { op })))
    }, 15000)
  })
}

const statusEl = document.getElementById('status')
const gridEl = document.getElementById('grid')
const searchEl = document.getElementById('search')
const titleEl = document.getElementById('title')
let all = []

function isSvg(icon) {
  return typeof icon === 'string' && icon.trim().startsWith('<svg')
}

function card(item) {
  const el = document.createElement('button')
  el.className = 'obox-card app-card'
  el.type = 'button'
  el.title = item.description || item.name

  const icon = document.createElement('span')
  icon.className = 'app-card__icon'
  if (isSvg(item.icon)) icon.innerHTML = item.icon
  else icon.textContent = (item.name || '?').slice(0, 1)
  el.appendChild(icon)

  const name = document.createElement('span')
  name.className = 'app-card__name'
  name.textContent = item.name || item.id
  el.appendChild(name)

  const desc = document.createElement('span')
  desc.className = 'app-card__desc'
  desc.textContent = item.description || ''
  el.appendChild(desc)

  const open = async () => {
    el.disabled = true
    try {
      await call('apps.open', { id: item.id })
    } catch (error) {
      statusEl.textContent = t('app.openFailed', { message: error.message })
    } finally {
      el.disabled = false
    }
  }
  el.addEventListener('click', () => void open())
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    showMenu(event.clientX, event.clientY, [
      { label: t('app.menu.open'), run: open },
      {
        label: t('app.menu.viewInManager'),
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
  menuEl.className = 'obox-menu ctx-menu'
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'obox-menu__item'
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
      ? t('app.status.empty')
      : q
        ? t('app.status.filtered', { matched: items.length, total: all.length })
        : t('app.status.count', { total: all.length })
}

/**
 * 静态文案（`index.html` 里的 title / h1 / 搜索框 placeholder / 首屏状态）：
 * 它们在文档里是**兜底文本**，语言确定后由这里覆盖，避免"英文界面里出现中文标题"。
 */
function applyStaticText() {
  const title = t('app.title')
  document.title = title
  if (titleEl) titleEl.textContent = title
  searchEl.placeholder = t('app.searchPlaceholder')
  document.documentElement.lang = pageContext.getContext()?.locale === 'en' ? 'en' : 'zh-CN'
  if (statusEl.textContent === '' || statusEl.dataset.i18nFallback !== 'ready') {
    statusEl.textContent = t('app.status.loading')
    statusEl.dataset.i18nFallback = 'ready'
  }
}

async function refresh() {
  try {
    const list = await call('apps.list')
    all = Array.isArray(list) ? list : []
    render()
  } catch (error) {
    statusEl.textContent = t('common.readFailed', { message: error.message })
  }
}

searchEl.addEventListener('input', render)
applyStaticText()
void refresh()
