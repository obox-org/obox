/**
 * `ext-manager` 页面脚本（无框架，纯 DOM）。
 *
 * 与壳子的协议：`postMessage({ type: 'obox:page-call', id, op, args })` →
 * 壳子用 `runHostQuery(op, args)` 回答 `{ type: 'obox:page-reply', id, ok, result, error }`。
 * 页面不直接碰 Node/DOM 之外的宿主能力（与宿主里的扩展共享同一批 op）。
 *
 * 主题与语言：由 `app://obox/page.js` 统一驱动（change `unified-page-context`）——
 * token 写进 `:root`、`colorScheme` 设好、`t()` 取当前语言；页面不再自建 `obox-theme` 监听。
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
const listEl = document.getElementById('list')
const titleEl = document.getElementById('title')
const installBtn = document.getElementById('install')
const restartBtn = document.getElementById('restart')
/** 最近一次列表（语言/主题变化时据此重渲染，不必重新拉取） */
let exts = []

/** 建元素小工具（本页独立，不依赖其它扩展） */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function sourceLabel(source, runtime) {
  if (runtime) return t('ext.badge.runtime')
  return source === 'system' ? t('ext.badge.system') : t('ext.badge.user')
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
    ? t('ext.state.shadowed')
    : ext.enabled === false
      ? t('ext.state.disabled')
      : ext.error
        ? t('ext.state.invalid', { message: ext.error })
        : ext.isActive
          ? t('ext.state.active')
          : t('ext.state.enabled')
  meta.appendChild(state)

  // 详情（点击行展开）：版本/作者/入口/描述/校验错误——排障时最常看这几项
  const details = document.createElement('dl')
  details.className = 'ext-details'
  const manifest = ext.manifest || {}
  const addRow = (label, value) => {
    if (value === undefined || value === null || value === '') return
    details.append(el('dt', '', label), el('dd', '', String(value)))
  }
  addRow(t('ext.detail.version'), manifest.version)
  addRow(t('ext.detail.author'), manifest.author)
  addRow(t('ext.detail.entry'), manifest.main)
  addRow(t('ext.detail.description'), manifest.description || manifest.displayName)
  const sourceText = isRuntime
    ? t('ext.source.runtime')
    : ext.source === 'system'
      ? t('ext.source.system')
      : t('ext.source.user')
  addRow(t('ext.detail.source'), sourceText)
  if (ext.requiresRestart) addRow(t('ext.detail.state'), t('ext.restartRequired'))
  for (const v of ext.validations || []) {
    if (v && v.severity === 'error') addRow(t('ext.detail.validationError'), v.message)
  }

  const toggleDetails = () => {
    const open = details.classList.toggle('open')
    li.classList.toggle('expanded', open)
  }
  meta.addEventListener('click', toggleDetails)
  li.appendChild(meta)
  li.appendChild(details)

  // 系统扩展不渲染操作按钮（底层也拒绝）；运行时包例外——它由用户手动安装，必须可卸载/升级
  if ((ext.source !== 'system' || isRuntime) && !ext.shadowed) {
    const actions = document.createElement('div')
    actions.className = 'ext-actions'

    const toggle = document.createElement('button')
    toggle.className = 'btn'
    toggle.type = 'button'
    toggle.textContent = ext.enabled === false ? t('ext.action.enable') : t('ext.action.disable')
    toggle.addEventListener('click', async () => {
      toggle.disabled = true
      try {
        await call('extensions.setEnabled', { id: ext.id, enabled: ext.enabled === false })
        await refresh()
      } catch (error) {
        statusEl.textContent = t('ext.action.failed', { message: error.message })
      } finally {
        toggle.disabled = false
      }
    })
    actions.appendChild(toggle)

    const remove = document.createElement('button')
    remove.className = 'btn danger'
    remove.type = 'button'
    remove.textContent = t('ext.action.uninstall')
    remove.addEventListener('click', async () => {
      remove.disabled = true
      try {
        await call('extensions.uninstall', { id: ext.id })
        await refresh()
      } catch (error) {
        statusEl.textContent = t('ext.uninstall.failed', { message: error.message })
      } finally {
        remove.disabled = false
      }
    })
    actions.appendChild(remove)
    li.appendChild(actions)
  }
  return li
}

function render() {
  statusEl.textContent =
    exts.length === 0 ? t('ext.status.loading') : t('ext.status.count', { count: exts.length })
  listEl.replaceChildren(...exts.map(row))
}

/**
 * 静态文案（`index.html` 的 title / h1 / 按钮 / 首屏状态）：语言确定后覆盖兜底文本。
 */
function applyStaticText() {
  const title = t('ext.title')
  document.title = title
  if (titleEl) titleEl.textContent = title
  installBtn.textContent = t('ext.install')
  restartBtn.textContent = t('ext.restart')
  document.documentElement.lang = pageContext.getContext()?.locale === 'en' ? 'en' : 'zh-CN'
  statusEl.dataset.i18nFallback = 'ready'
}

async function refresh() {
  try {
    const list = await call('extensions.list')
    exts = Array.isArray(list) ? list : []
    render()
  } catch (error) {
    statusEl.textContent = t('common.readFailed', { message: error.message })
  }
}

installBtn.addEventListener('click', async () => {
  try {
    const outcome = await call('extensions.install')
    // 用户在文件选择器里取消时返回 null：不是错误，什么都不做
    if (outcome && outcome.ok === false) {
      statusEl.textContent = t('ext.install.failed', { message: outcome.error })
    }
    await refresh()
  } catch (error) {
    statusEl.textContent = t('ext.install.failed', { message: error.message })
  }
})

restartBtn.addEventListener('click', () => {
  void call('extensions.restartHost')
})

applyStaticText()
void refresh()
