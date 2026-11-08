/**
 * `settings` 系统扩展的页面（无框架，纯 DOM）。
 *
 * 结构：**左侧树 + 右侧表单**，分区与旧内置设置页一一对应：
 * appearance / general / language / keyboard / update / network / ai / notification / extension。
 *
 * 数据来源：一次 `settings.snapshot`（主题、语言、关闭行为、全部宿主设置、快捷键、更新提供者、
 * 扩展设置页），写操作走 `settings.host.set` / `theme.set` / `keybindings.*` / 专用 op。
 *
 * 主题与语言：由 `app://obox/page.js` 统一驱动（change `unified-page-context`）——
 * token/`colorScheme` 由运行时写进 `:root`，文案用 `t()`；语言变化时重渲染整页。
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

let lastUpdateEvent = null

// 更新事件由壳子转发（下载进度只存在于渲染进程的 main 事件里）
window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'obox-update-event') return
  lastUpdateEvent = data.event || null
  if (active === 'update') render()
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

const treeEl = document.getElementById('tree')
const panelEl = document.getElementById('panel')
let snapshot = null
let active = 'appearance'
let activeExtPage = null

/** 分区 id（顺序即左侧树顺序）；标签在渲染时按 `settings.section.<id>` 取当前语言 */
const SECTION_IDS = [
  'appearance',
  'general',
  'language',
  'keyboard',
  'update',
  'network',
  'devRuntime',
  'ai',
  'notification',
  'extension'
]

/* ------------------------------- DOM 小工具 ------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function heading(text) {
  return el('h2', 'section-title', text)
}

function row(labelText, control) {
  const wrap = el('label', 'row')
  wrap.append(el('span', 'row-label', labelText), control)
  return wrap
}

function note(text) {
  return el('p', 'note', text)
}

function select(options, value, onChange) {
  const node = document.createElement('select')
  for (const option of options) {
    const item = document.createElement('option')
    item.value = option.value
    item.textContent = option.label
    if (option.value === value) item.selected = true
    node.appendChild(item)
  }
  node.addEventListener('change', () => onChange(node.value))
  return node
}

function input(value, placeholder, onChange, type = 'text') {
  const node = document.createElement('input')
  node.type = type
  node.className = 'text'
  node.value = value ?? ''
  if (placeholder) node.placeholder = placeholder
  node.addEventListener('change', () => onChange(node.value))
  return node
}

function checkbox(checked, onChange) {
  const node = document.createElement('input')
  node.type = 'checkbox'
  node.checked = Boolean(checked)
  node.addEventListener('change', () => onChange(node.checked))
  return node
}

async function setSetting(key, value) {
  await call('settings.host.set', { key, value })
  snapshot.settings[key] = value
}

function setting(key, fallback) {
  const value = snapshot.settings[key]
  return value === undefined ? fallback : value
}

/* --------------------------------- 分区渲染 -------------------------------- */

const renderers = {
  appearance() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.appearance')))
    frag.append(
      row(
        t('settings.appearance.theme'),
        select(
          snapshot.theme.list.map((item) => ({ value: item.id, label: item.label || item.id })),
          snapshot.theme.current,
          (id) => void call('theme.set', { themeId: id })
        )
      )
    )
    return frag
  },

  general() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.general')))
    frag.append(
      row(
        t('settings.general.closeBehavior'),
        select(
          [
            { value: 'ask', label: t('settings.general.close.ask') },
            { value: 'hide', label: t('settings.general.close.hide') },
            { value: 'quit', label: t('settings.general.close.quit') }
          ],
          snapshot.closeBehavior,
          (behavior) => void call('window.setCloseBehavior', { behavior })
        )
      )
    )
    const host = snapshot.extensionHost
    const current = host.setting === null ? 'default' : host.setting ? 'on' : 'off'
    frag.append(
      row(
        t('settings.general.extensionHost'),
        select(
          [
            {
              value: 'default',
              label: t('settings.general.host.default', {
                state: host.enabled ? t('common.enabled') : t('common.disabled')
              })
            },
            { value: 'on', label: t('settings.general.host.on') },
            { value: 'off', label: t('settings.general.host.off') }
          ],
          current,
          (value) =>
            void setSetting(
              'extensionHost.enabled',
              value === 'default' ? undefined : value === 'on'
            )
        )
      )
    )
    frag.append(note(t('settings.general.hostNote')))
    return frag
  },

  language() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.language')))
    frag.append(
      row(
        t('settings.language.ui'),
        select(
          snapshot.locale.list.map((item) => ({ value: item.code, label: item.label })),
          snapshot.locale.current,
          (code) => void call('i18n.setLocale', { code })
        )
      )
    )
    return frag
  },

  keyboard() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.keyboard')))
    frag.append(note(t('settings.keyboard.note')))
    const list = el('ul', 'keys')
    for (const item of snapshot.keybindings) {
      const li = el('li', 'key-row')
      li.append(el('span', 'key-name', item.labelKey || item.command))
      li.append(el('span', 'key-combo', item.currentKey || item.defaultKey || '—'))

      const edit = el('button', 'btn', t('settings.keyboard.edit'))
      edit.type = 'button'
      edit.addEventListener('click', () => {
        edit.textContent = t('settings.keyboard.press')
        edit.disabled = true
        const onKey = async (event) => {
          event.preventDefault()
          event.stopPropagation()
          window.removeEventListener('keydown', onKey, true)
          const parts = []
          if (event.ctrlKey) parts.push('Ctrl')
          if (event.shiftKey) parts.push('Shift')
          if (event.altKey) parts.push('Alt')
          const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
          parts.push(key)
          try {
            await call('keybindings.set', { command: item.command, combo: parts.join('+') })
            await reload()
          } catch (error) {
            noteEl(error.message)
          }
        }
        window.addEventListener('keydown', onKey, true)
      })

      const reset = el('button', 'btn', t('settings.keyboard.reset'))
      reset.type = 'button'
      reset.addEventListener('click', async () => {
        await call('keybindings.reset', { command: item.command })
        await reload()
      })

      li.append(edit, reset)
      list.appendChild(li)
    }
    frag.append(list)
    return frag
  },

  update() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.update')))
    frag.append(row(t('settings.update.currentVersion'), el('span', 'value', snapshot.app.version)))
    frag.append(
      row(
        t('settings.update.provider'),
        el('span', 'value', snapshot.update.activeId || t('settings.update.noProvider'))
      )
    )
    const providers = el('ul', 'plain')
    for (const provider of snapshot.update.providers) {
      providers.appendChild(el('li', '', provider.extensionId))
    }
    if (snapshot.update.providers.length === 0) {
      providers.appendChild(el('li', 'note', t('settings.update.noProviderDeclared')))
    }
    frag.append(providers)
    const status = el('p', 'note', '')
    const actions = el('div', 'row')
    const mkButton = (label, run) => {
      const btn = el('button', 'btn', label)
      btn.type = 'button'
      btn.addEventListener('click', async () => {
        btn.disabled = true
        status.textContent = t('settings.update.running', { label })
        try {
          const result = await run()
          status.textContent =
            result && result.ok === false
              ? t('settings.update.failedShort', {
                  error: result.error || t('common.unknownError')
                })
              : t('settings.update.done', { label })
        } catch (error) {
          status.textContent = t('settings.update.failed', { label, message: error.message })
        } finally {
          btn.disabled = false
        }
      })
      return btn
    }
    actions.append(
      mkButton(t('settings.update.check'), () => call('update.check')),
      mkButton(t('settings.update.download'), () => call('update.download')),
      mkButton(t('settings.update.install'), () => call('update.install'))
    )
    frag.append(actions, status)

    if (lastUpdateEvent) {
      const ev = lastUpdateEvent
      const line = el('p', 'note')
      if (ev.type === 'download-progress') {
        const bar = el('progress', 'progress')
        bar.max = 100
        bar.value = Number(ev.percent) || 0
        line.append(bar, document.createTextNode(` ${Math.round(Number(ev.percent) || 0)}%`))
      } else if (ev.type === 'update-downloaded') {
        line.textContent = t('settings.update.downloaded', {
          version: (ev.info && ev.info.version) || ''
        })
      } else if (ev.type === 'update-available') {
        line.textContent = t('settings.update.available', {
          version: (ev.info && ev.info.version) || ''
        })
      } else if (ev.type === 'error') {
        line.textContent = t('settings.update.error', {
          message: ev.message || t('common.unknownError')
        })
      } else {
        line.textContent = t('settings.update.event', { type: ev.type })
      }
      frag.append(line)
    }
    frag.append(note(t('settings.update.note')))
    return frag
  },

  network() {
    const proxy = setting('network.proxy', {}) || {}
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.network')))
    frag.append(
      row(
        t('settings.network.enable'),
        checkbox(proxy.enabled, (enabled) => void saveProxy({ ...proxy, enabled }))
      )
    )
    frag.append(
      row(
        t('settings.network.url'),
        input(proxy.url ?? '', 'http://127.0.0.1:7890', (url) => void saveProxy({ ...proxy, url }))
      )
    )
    frag.append(
      row(
        t('settings.network.ignoreSSL'),
        checkbox(proxy.ignoreSSL, (ignoreSSL) => void saveProxy({ ...proxy, ignoreSSL }))
      )
    )
    const noProxy = Array.isArray(proxy.noProxy) ? proxy.noProxy.join('\n') : ''
    const textarea = el('textarea', 'textarea')
    textarea.value = noProxy
    textarea.rows = 3
    textarea.placeholder = t('settings.network.noProxyPlaceholder')
    textarea.addEventListener('change', () => {
      const list = textarea.value
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
      void saveProxy({ ...proxy, noProxy: list })
    })
    frag.append(row(t('settings.network.noProxy'), textarea))
    return frag
  },

  devRuntime() {
    const data = snapshot.devRuntime || { builtin: [], local: [] }
    const DEFAULT_KEY = 'devRuntime.python.default'
    const current = String(setting(DEFAULT_KEY, ''))
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.devRuntime')))

    const install = el('button', 'btn', t('settings.devRuntime.install'))
    install.type = 'button'
    install.addEventListener('click', async () => {
      install.disabled = true
      try {
        const picked = await call('dialog.openFile', { title: t('settings.devRuntime.pickTitle') })
        if (!picked || picked.canceled) return
        const file = (picked.filePaths && picked.filePaths[0]) || ''
        if (!file) return
        const outcome = await call('extensions.installFromPath', { path: file })
        if (outcome && outcome.ok === false) {
          noteMessage(t('common.installFailed', { message: outcome.error }))
        }
        await reload()
      } catch (error) {
        noteMessage(t('common.installFailed', { message: error.message }))
      } finally {
        install.disabled = false
      }
    })
    frag.append(row(t('settings.devRuntime.installLabel'), install))
    frag.append(note(t('settings.devRuntime.note')))

    const rows = el('ul', 'plain')
    const addEntry = (key, version, detail, tag, isLocal) => {
      const li = el('li', 'key-row')
      const name = el(
        'span',
        'key-name',
        isLocal ? `${version || t('settings.devRuntime.unknownVersion')}` : `${version}（${tag}）`
      )
      name.append(document.createTextNode(`  ·  ${detail}`))
      li.append(name)
      if (key === current) {
        li.append(el('span', 'key-combo', t('settings.devRuntime.default')))
      } else {
        const btn = el('button', 'btn', t('settings.devRuntime.setDefault'))
        btn.type = 'button'
        btn.addEventListener('click', async () => {
          await setSetting(DEFAULT_KEY, key)
          await reload()
        })
        li.append(btn)
      }
      rows.appendChild(li)
    }

    for (const item of data.builtin || []) {
      addEntry(
        `builtin:${item.extensionId}`,
        item.version,
        item.hasExecutable ? item.dir : t('settings.devRuntime.missingExe', { dir: item.dir }),
        item.source === 'user'
          ? t('settings.devRuntime.tagBuiltinLegacy')
          : t('settings.devRuntime.tagBuiltin'),
        false
      )
    }
    for (const item of data.local || []) {
      addEntry(
        `local:${item.path}`,
        item.version,
        item.path,
        t('settings.devRuntime.tagLocal'),
        true
      )
    }
    if (rows.childElementCount === 0) {
      frag.append(note(t('settings.devRuntime.empty')))
    } else {
      frag.append(rows)
    }
    frag.append(note(t('settings.devRuntime.footer')))
    return frag
  },

  ai() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.ai')))
    const fields = [
      ['ai.baseUrl', t('settings.ai.baseUrl'), 'https://api.openai.com/v1'],
      ['ai.apiKey', t('settings.ai.apiKey'), 'sk-…'],
      ['ai.model', t('settings.ai.model'), 'gpt-4o-mini'],
      ['ai.contextLen', t('settings.ai.contextLen'), '8192']
    ]
    for (const [key, label, placeholder] of fields) {
      frag.append(
        row(
          label,
          input(setting(key, ''), placeholder, (value) => void setSetting(key, value))
        )
      )
    }
    frag.append(
      row(
        t('settings.ai.dailyLimit'),
        input(
          setting('ai.dailyLimit', ''),
          t('settings.ai.dailyLimitPlaceholder'),
          (value) => {
            const num = Number(value)
            void setSetting('ai.dailyLimit', Number.isFinite(num) && value !== '' ? num : undefined)
          },
          'number'
        )
      )
    )
    const aiStatus = el('p', 'note', '')
    const testBtn = el('button', 'btn', t('settings.ai.test'))
    testBtn.type = 'button'
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true
      aiStatus.textContent = t('settings.ai.testing')
      try {
        const result = await call('ai.test', {
          baseUrl: String(setting('ai.baseUrl', '')),
          apiKey: String(setting('ai.apiKey', ''))
        })
        aiStatus.textContent =
          result && result.ok
            ? t('settings.ai.ok', { message: result.message || '' })
            : t('settings.ai.failed', {
                error: (result && result.message) || t('common.unknownError')
              })
      } catch (error) {
        aiStatus.textContent = t('settings.ai.failed', { error: error.message })
      } finally {
        testBtn.disabled = false
      }
    })
    frag.append(testBtn, aiStatus)
    return frag
  },

  notification() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.notification')))
    frag.append(
      row(
        t('settings.notification.enable'),
        checkbox(
          setting('notifications.enabled', true),
          (enabled) => void setSetting('notifications.enabled', enabled)
        )
      )
    )
    frag.append(note(t('settings.notification.note')))
    const list = el('ul', 'plain')
    for (const ext of snapshot.extensions || []) {
      const li = el('li', 'key-row')
      li.append(el('span', 'key-name', ext.id))
      const toggle = checkbox(!ext.notificationDisabled, async (enabled) => {
        await call('settings.notification.set', { id: ext.id, disabled: !enabled })
        ext.notificationDisabled = !enabled
      })
      li.append(toggle)
      list.appendChild(li)
    }
    frag.append(list)
    return frag
  },

  extension() {
    const frag = document.createDocumentFragment()
    frag.append(heading(t('settings.section.extension')))
    if (snapshot.extensionPages.length === 0) {
      frag.append(note(t('settings.extension.empty')))
      return frag
    }
    for (const page of snapshot.extensionPages) {
      const box = el('div', 'ext-page')
      const title = el('h3', 'ext-title', page.title || page.id)
      box.appendChild(title)
      for (const field of page.fields || []) {
        box.append(row(field.label || field.key, fieldControl(field)))
      }
      frag.append(box)
    }
    return frag
  }
}

/**
 * 扩展设置字段的控件（按 `SettingField.type`）。
 *
 * 为什么不是一律 text：设置项类型是扩展声明的契约（`checkbox` / `select` / `number` / 日期等），
 * 全渲染成文本框会让"布尔值存成字符串 ''"这类脏值进设置库。
 * `status` / `progress` 是**只读**展示字段（扩展自己写值），这里不给输入控件。
 */
function fieldControl(field) {
  const value = setting(field.key, field.default)
  const commit = (next) => void setSetting(field.key, next)
  switch (field.type) {
    case 'checkbox':
      return checkbox(Boolean(value), (checked) => commit(checked))
    case 'select':
      return select(
        (field.options || []).map((option) => ({ value: option.value, label: option.label })),
        String(value ?? ''),
        (next) => commit(next)
      )
    case 'number': {
      const node = input(
        value ?? '',
        field.placeholder || '',
        (next) => {
          const num = Number(next)
          commit(next === '' ? undefined : Number.isFinite(num) ? num : undefined)
        },
        'number'
      )
      return node
    }
    case 'date':
      return input(value ?? '', '', (next) => commit(next || undefined), 'date')
    case 'time':
      return input(value ?? '', '', (next) => commit(next || undefined), 'time')
    case 'textarea': {
      const node = el('textarea', 'textarea')
      node.value = value ?? ''
      node.placeholder = field.placeholder || ''
      node.addEventListener('change', () => commit(node.value))
      return node
    }
    case 'directory': {
      const wrap = el('span', 'row')
      const shown = input(value ?? '', field.placeholder || '', () => undefined)
      shown.readOnly = true
      shown.addEventListener('click', () => void browse(field, shown))
      const btn = el('button', 'btn', t('settings.field.browse'))
      btn.type = 'button'
      btn.addEventListener('click', () => void browse(field, shown))
      wrap.append(shown, btn)
      return wrap
    }
    case 'status':
      return el('span', 'value', String(value ?? t('settings.field.unset')))
    case 'progress': {
      const max = typeof field.max === 'number' && field.max > 0 ? field.max : 100
      const cur = Math.min(Math.max(Number(value) || 0, 0), max)
      const bar = el('progress', 'progress')
      bar.max = max
      bar.value = cur
      const wrap = el('span', 'value')
      wrap.append(bar, document.createTextNode(` ${Math.floor(cur)}/${max}`))
      return wrap
    }
    default:
      return input(value ?? '', field.placeholder || '', (next) => commit(next))
  }
}

/** directory 字段：选目录（取消不改值） */
async function browse(field, shown) {
  try {
    const result = await call('dialog.openDirectory', {
      title: field.label || t('settings.field.pickDirectory')
    })
    if (!result || result.canceled) return
    const picked = (result.filePaths && result.filePaths[0]) || ''
    if (!picked) return
    shown.value = picked
    await setSetting(field.key, picked)
  } catch (error) {
    shown.value = String(setting(field.key, ''))
    noteMessage(t('settings.field.pickDirectoryFailed', { message: error.message }))
  }
}

async function saveProxy(proxy) {
  await setSetting('network.proxy', proxy)
  render()
}

let noteEl = () => undefined

function noteMessage(text) {
  const p = el('p', 'note', text)
  panelEl.prepend(p)
  setTimeout(() => p.remove(), 4000)
}

/* --------------------------------- 树与渲染 -------------------------------- */

function renderTree() {
  treeEl.replaceChildren(
    ...SECTION_IDS.map((id) => {
      const node = el('div', 'tree-node', t(`settings.section.${id}`))
      if (id === active) node.classList.add('active')
      node.addEventListener('click', () => {
        active = id
        activeExtPage = null
        render()
      })
      return node
    })
  )
}

function render() {
  renderTree()
  panelEl.replaceChildren()
  const renderer = renderers[active]
  if (!renderer) {
    panelEl.append(note(t('settings.unknownSection')))
    return
  }
  panelEl.append(renderer())
}

/**
 * 静态文案（`index.html` 的 title / 树 aria-label / 首屏 loading）：语言确定后覆盖兜底文本。
 */
function applyStaticText() {
  const title = t('settings.title')
  document.title = title
  treeEl.setAttribute('aria-label', t('settings.treeAria'))
  document.documentElement.lang = pageContext.getContext()?.locale === 'en' ? 'en' : 'zh-CN'
  if (snapshot === null) {
    panelEl.replaceChildren(note(t('settings.loading')))
  }
}

async function reload() {
  snapshot = await call('settings.snapshot')
  render()
}

async function init() {
  noteEl = noteMessage
  applyStaticText()
  try {
    await reload()
  } catch (error) {
    panelEl.replaceChildren(note(t('common.readFailed', { message: error.message })))
  }
}

// 深链切换：只改 hash 不会重载页面，靠 hashchange 重新渲染
window.addEventListener('hashchange', () => {
  const next = (location.hash || '#appearance').slice(1) || 'appearance'
  if (!renderers[next]) return
  active = next
  render()
})

void init()
