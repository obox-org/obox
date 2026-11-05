/**
 * `settings` 系统扩展的页面（无框架，纯 DOM）。
 *
 * 结构：**左侧树 + 右侧表单**，分区与旧内置设置页一一对应：
 * appearance / general / language / keyboard / update / network / ai / notification / extension。
 *
 * 数据来源：一次 `settings.snapshot`（主题、语言、关闭行为、全部宿主设置、快捷键、更新提供者、
 * 扩展设置页），写操作走 `settings.host.set` / `theme.set` / `keybindings.*` / 专用 op。
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

const treeEl = document.getElementById('tree')
const panelEl = document.getElementById('panel')
let snapshot = null
let active = 'appearance'
let activeExtPage = null

const SECTIONS = [
  { id: 'appearance', label: '外观' },
  { id: 'general', label: '常规' },
  { id: 'language', label: '语言' },
  { id: 'keyboard', label: '快捷键' },
  { id: 'update', label: '更新' },
  { id: 'network', label: '网络' },
  { id: 'ai', label: 'AI' },
  { id: 'notification', label: '通知' },
  { id: 'extension', label: '扩展' }
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
    frag.append(heading('外观'))
    frag.append(
      row(
        '主题',
        select(
          snapshot.theme.list.map((t) => ({ value: t.id, label: t.label || t.id })),
          snapshot.theme.current,
          (id) => void call('theme.set', { themeId: id })
        )
      )
    )
    return frag
  },

  general() {
    const frag = document.createDocumentFragment()
    frag.append(heading('常规'))
    frag.append(
      row(
        '关闭窗口时',
        select(
          [
            { value: 'ask', label: '每次询问' },
            { value: 'hide', label: '最小化到托盘' },
            { value: 'quit', label: '退出应用' }
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
        '扩展宿主',
        select(
          [
            { value: 'default', label: `跟随默认（当前${host.enabled ? '启用' : '关闭'}）` },
            { value: 'on', label: '强制启用' },
            { value: 'off', label: '强制关闭' }
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
    frag.append(note('扩展宿主在下次启动生效；关闭后用户扩展改为在渲染进程执行（兼容模式）。'))
    return frag
  },

  language() {
    const frag = document.createDocumentFragment()
    frag.append(heading('语言'))
    frag.append(
      row(
        '界面语言',
        select(
          snapshot.locale.list.map((l) => ({ value: l.code, label: l.label })),
          snapshot.locale.current,
          (code) => void call('i18n.setLocale', { code })
        )
      )
    )
    return frag
  },

  keyboard() {
    const frag = document.createDocumentFragment()
    frag.append(heading('快捷键'))
    frag.append(note('点击「修改」后直接按下组合键；「重置」恢复默认。'))
    const list = el('ul', 'keys')
    for (const item of snapshot.keybindings) {
      const li = el('li', 'key-row')
      li.append(el('span', 'key-name', item.labelKey || item.command))
      li.append(el('span', 'key-combo', item.currentKey || item.defaultKey || '—'))

      const edit = el('button', 'btn', '修改')
      edit.type = 'button'
      edit.addEventListener('click', () => {
        edit.textContent = '请按键…'
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

      const reset = el('button', 'btn', '重置')
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
    frag.append(heading('更新'))
    frag.append(row('当前版本', el('span', 'value', snapshot.app.version)))
    frag.append(row('更新提供者', el('span', 'value', snapshot.update.activeId || '未选择')))
    const providers = el('ul', 'plain')
    for (const p of snapshot.update.providers) {
      providers.appendChild(el('li', '', p.extensionId))
    }
    if (snapshot.update.providers.length === 0) {
      providers.appendChild(el('li', 'note', '暂无扩展声明更新提供者'))
    }
    frag.append(providers)
    const status = el('p', 'note', '')
    const actions = el('div', 'row')
    const mkButton = (label, run) => {
      const btn = el('button', 'btn', label)
      btn.type = 'button'
      btn.addEventListener('click', async () => {
        btn.disabled = true
        status.textContent = `${label}…`
        try {
          const result = await run()
          status.textContent =
            result && result.ok === false ? `失败：${result.error || '未知错误'}` : `${label}：完成`
        } catch (error) {
          status.textContent = `${label}失败：${error.message}`
        } finally {
          btn.disabled = false
        }
      })
      return btn
    }
    actions.append(
      mkButton('检查更新', () => call('update.check')),
      mkButton('下载更新', () => call('update.download')),
      mkButton('安装并重启', () => call('update.install'))
    )
    frag.append(actions, status)
    frag.append(note('更新由当前生效的「更新提供者」扩展驱动；没有提供者时检查会提示。'))
    return frag
  },

  network() {
    const proxy = setting('network.proxy', {}) || {}
    const frag = document.createDocumentFragment()
    frag.append(heading('网络'))
    frag.append(
      row(
        '启用代理',
        checkbox(proxy.enabled, (enabled) => void saveProxy({ ...proxy, enabled }))
      )
    )
    frag.append(
      row(
        '代理地址',
        input(proxy.url ?? '', 'http://127.0.0.1:7890', (url) => void saveProxy({ ...proxy, url }))
      )
    )
    frag.append(
      row(
        '忽略 SSL 证书错误',
        checkbox(proxy.ignoreSSL, (ignoreSSL) => void saveProxy({ ...proxy, ignoreSSL }))
      )
    )
    const noProxy = Array.isArray(proxy.noProxy) ? proxy.noProxy.join('\n') : ''
    const textarea = el('textarea', 'textarea')
    textarea.value = noProxy
    textarea.rows = 3
    textarea.placeholder = '每行一个域名，如 example.com'
    textarea.addEventListener('change', () => {
      const list = textarea.value
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean)
      void saveProxy({ ...proxy, noProxy: list })
    })
    frag.append(row('不代理的域名', textarea))
    return frag
  },

  ai() {
    const frag = document.createDocumentFragment()
    frag.append(heading('AI'))
    const fields = [
      ['ai.baseUrl', '服务地址', 'https://api.openai.com/v1'],
      ['ai.apiKey', 'API Key', 'sk-…'],
      ['ai.model', '模型', 'gpt-4o-mini'],
      ['ai.contextLen', '上下文长度', '8192']
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
        '每日请求上限',
        input(
          setting('ai.dailyLimit', ''),
          '0 = 不限制',
          (value) => {
            const num = Number(value)
            void setSetting('ai.dailyLimit', Number.isFinite(num) && value !== '' ? num : undefined)
          },
          'number'
        )
      )
    )
    const aiStatus = el('p', 'note', '')
    const testBtn = el('button', 'btn', '测试连接')
    testBtn.type = 'button'
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true
      aiStatus.textContent = '测试中…'
      try {
        const result = await call('ai.test', {
          baseUrl: String(setting('ai.baseUrl', '')),
          apiKey: String(setting('ai.apiKey', ''))
        })
        aiStatus.textContent =
          result && result.ok
            ? `连接成功：${result.message || ''}`
            : `失败：${(result && result.message) || '未知错误'}`
      } catch (error) {
        aiStatus.textContent = `失败：${error.message}`
      } finally {
        testBtn.disabled = false
      }
    })
    frag.append(testBtn, aiStatus)
    return frag
  },

  notification() {
    const frag = document.createDocumentFragment()
    frag.append(heading('通知'))
    frag.append(
      row(
        '启用通知',
        checkbox(
          setting('notifications.enabled', true),
          (enabled) => void setSetting('notifications.enabled', enabled)
        )
      )
    )
    frag.append(note('以下按扩展屏蔽：取消勾选后该扩展的 toast 不再显示。'))
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
    frag.append(heading('扩展'))
    if (snapshot.extensionPages.length === 0) {
      frag.append(note('暂无扩展声明设置项（扩展可经 api.settings.register 或清单声明）。'))
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
        (field.options || []).map((o) => ({ value: o.value, label: o.label })),
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
      const btn = el('button', 'btn', '浏览…')
      btn.type = 'button'
      btn.addEventListener('click', () => void browse(field, shown))
      wrap.append(shown, btn)
      return wrap
    }
    case 'status':
      return el('span', 'value', String(value ?? '（未设置）'))
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
    const result = await call('dialog.openDirectory', { title: field.label || '选择目录' })
    if (!result || result.canceled) return
    const picked = (result.filePaths && result.filePaths[0]) || ''
    if (!picked) return
    shown.value = picked
    await setSetting(field.key, picked)
  } catch (error) {
    shown.value = String(setting(field.key, ''))
    noteMessage(`选择目录失败：${error.message}`)
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
    ...SECTIONS.map((section) => {
      const node = el('div', 'tree-node', section.label)
      if (section.id === active) node.classList.add('active')
      node.addEventListener('click', () => {
        active = section.id
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
    panelEl.append(note('未知分区'))
    return
  }
  panelEl.append(renderer())
}

async function reload() {
  snapshot = await call('settings.snapshot')
  render()
}

async function init() {
  noteEl = noteMessage
  try {
    await reload()
  } catch (error) {
    panelEl.replaceChildren(note(`读取失败：${error.message}`))
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
