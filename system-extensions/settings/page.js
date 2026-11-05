/**
 * `settings` 系统扩展的页面脚本（无框架）。
 *
 * 全部能力来自公共 API（经壳子的 `obox:page-call` 桥）：
 * - `theme.list/current/set`：主题；
 * - `keybindings.list/reset`：快捷键；
 * - `settings.host.get/set`：宿主级设置（JSON 值，例如 `network.proxy`）。
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

const themeEl = document.getElementById('theme')
const keysEl = document.getElementById('keys')
const keyEl = document.getElementById('setting-key')
const valueEl = document.getElementById('setting-value')
const setStatusEl = document.getElementById('setting-status')

async function loadThemes() {
  const [list, current] = await Promise.all([call('theme.list'), call('theme.current')])
  const themes = Array.isArray(list) ? list : []
  themeEl.replaceChildren(
    ...themes.map((t) => {
      const option = document.createElement('option')
      option.value = t.id
      option.textContent = t.label || t.id
      if (t.id === current) option.selected = true
      return option
    })
  )
}

themeEl.addEventListener('change', async () => {
  try {
    await call('theme.set', { themeId: themeEl.value })
  } catch (error) {
    setStatusEl.textContent = `切换失败：${error.message}`
  }
})

async function loadKeys() {
  const list = await call('keybindings.list')
  const items = Array.isArray(list) ? list : []
  keysEl.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li')
      li.className = 'key-row'
      const name = document.createElement('span')
      name.className = 'key-name'
      name.textContent = item.labelKey || item.command
      const combo = document.createElement('span')
      combo.className = 'key-combo'
      combo.textContent = item.currentKey || item.defaultKey || '—'
      const reset = document.createElement('button')
      reset.className = 'btn'
      reset.type = 'button'
      reset.textContent = '重置'
      reset.addEventListener('click', async () => {
        reset.disabled = true
        try {
          await call('keybindings.reset', { command: item.command })
          await loadKeys()
        } catch (error) {
          setStatusEl.textContent = `重置失败：${error.message}`
        } finally {
          reset.disabled = false
        }
      })
      li.append(name, combo, reset)
      return li
    })
  )
}

document.getElementById('setting-load').addEventListener('click', async () => {
  const key = keyEl.value.trim()
  if (!key) return
  try {
    const value = await call('settings.host.get', { key })
    valueEl.value = value === undefined ? '' : JSON.stringify(value, null, 2)
    setStatusEl.textContent = value === undefined ? '（尚未设置）' : '已读取'
  } catch (error) {
    setStatusEl.textContent = `读取失败：${error.message}`
  }
})

document.getElementById('setting-save').addEventListener('click', async () => {
  const key = keyEl.value.trim()
  if (!key) {
    setStatusEl.textContent = '请先填设置键'
    return
  }
  let value
  const raw = valueEl.value.trim()
  try {
    value = raw === '' ? undefined : JSON.parse(raw)
  } catch {
    setStatusEl.textContent = '值不是合法 JSON'
    return
  }
  try {
    await call('settings.host.set', { key, value })
    setStatusEl.textContent = '已保存（立即生效）'
  } catch (error) {
    setStatusEl.textContent = `保存失败：${error.message}`
  }
})

async function init() {
  try {
    await loadThemes()
    await loadKeys()
  } catch (error) {
    setStatusEl.textContent = `初始化失败：${error.message}`
  }
}

void init()
