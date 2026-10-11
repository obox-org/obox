#!/usr/bin/env node
/**
 * create-user-extension — Obox **用户扩展**脚手架（纯 ESM JavaScript + `.oix` 打包）。
 *
 * 用法：
 *   node skills/obox-ext-dev/scripts/create-user-extension.mjs <id> [选项]
 *
 * 选项：
 *   --title "显示名"   扩展显示名（默认 = id）
 *   --author "作者"    作者（默认留空；.oix 安装目录名 = <name>_<author>，见 src/main/oixCore.ts:51）
 *   --desc "简介"      简介
 *   --dir <父目录>     生成到哪个父目录下的 <id>/（默认 <仓库根>/extensions/）
 *   --vue              额外生成 Vue 子应用骨架（Vite 构建期依赖；运行时入口仍是纯 ESM）
 *
 * 生成物（生成即可用，零运行时依赖）：
 *   <id>/manifest.json          views/commands/statusBarItems/i18n 声明（main: "./index.js"）
 *   <id>/index.js               纯 ESM：default 插件函数 + 具名导出 greet + cleanup
 *   <id>/page.html + page.js    App 卡片子窗口的静态页（脚本是**独立文件**，不是内联）
 *   <id>/theme.js               子窗口主题接收桥（宿主 obox-theme 推送；协议见 themes-settings.md）
 *   <id>/test/extension.test.js node --test + mock api（零依赖）
 *   <id>/scripts/pack.mjs       zip → out/<id>-<version>.oix（零依赖，自己写 zip）
 *   <id>/package.json           type: module；scripts: test / pack / release
 *   <id>/README.md              安装、调试、贡献点与 i18n 说明
 *
 * 退出码：0 = 生成成功｜1 = 生成失败（id 非法 / 目录已存在）｜2 = 用法错误
 *
 * 与 create-extension.mjs（内置扩展，TS + Vite、随应用打包）的区别见 references/guides-user.md。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
/** 仓库根：skills/obox-ext-dev/scripts → 上三级 */
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..')

/**
 * 脚手架自己的 id 校验：**仍带 `i`**（未与宿主同步，见 scripts/README.md 与 issue #77）。
 * 宿主 `core/manifest.ts:11` 的 `NAME_RE` 已**不带 `i`**（大写 id 非法）——请传小写 id。
 */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i

const HELP = [
  '用法:',
  '  node skills/obox-ext-dev/scripts/create-user-extension.mjs <id> [--title "显示名"]',
  '       [--author "作者"] [--desc "简介"] [--dir <父目录>] [--vue]',
  '',
  '说明: 生成 <父目录>/<id>/（默认 <仓库根>/extensions/<id>/）—— 纯 ESM 用户扩展 + .oix 打包脚本。',
  '      <id> 须匹配 ^[a-z0-9][a-z0-9._-]*$（宿主 NAME_RE 已不带 i：含大写即清单无效，请用小写）',
  '',
  '退出码: 0 = 成功｜1 = 生成失败｜2 = 用法错误'
].join('\n')

function fail(msg, code = 1) {
  console.error(`[create-user-extension] 错误: ${msg}`)
  if (code === 2) console.error(HELP)
  process.exit(code)
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 把任意字符串安全嵌入生成的 JS/TS 源码（JSON 字符串字面量就是合法的 JS 字面量） */
function jsLiteral(value) {
  return JSON.stringify(String(value))
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** JS 标识符安全化：NAME_RE 允许首字符是数字（如 `2cool`），但标识符不行 */
function safeIdentifier(name) {
  return /^[0-9]/.test(name) ? `_${name}` : name
}

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2)
const positionals = []
let title
let author = ''
let description = ''
let dirArg
let vue = false

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '-h' || arg === '--help') {
    console.log(HELP)
    process.exit(0)
  } else if (arg === '--vue') {
    vue = true
  } else if (arg === '--title' || arg === '--author' || arg === '--desc' || arg === '--dir') {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`${arg} 需要一个参数`, 2)
    const value = argv[++i]
    if (arg === '--title') title = value
    else if (arg === '--author') author = value
    else if (arg === '--desc') description = value
    else dirArg = value
  } else if (arg.startsWith('-') && arg !== '-') {
    fail(`未知选项: ${arg}`, 2)
  } else {
    positionals.push(arg)
  }
}

if (positionals.length === 0) fail('缺少扩展 id', 2)
if (positionals.length > 1) fail(`只接受一个扩展 id，多给了: ${positionals.slice(1).join(' ')}`, 2)

const id = positionals[0]
const displayName = title ?? id

if (!ID_RE.test(id)) {
  fail(`扩展 id 非法: ${id}（须匹配 ^[a-z0-9][a-z0-9._-]*$，与宿主 NAME_RE 一致）`)
}

const parentDir = resolve(dirArg ?? join(REPO_ROOT, 'extensions'))
const extDir = join(parentDir, id)

try {
  await stat(extDir)
  fail(`扩展目录已存在: ${extDir}`)
} catch (err) {
  if (err && err.code !== 'ENOENT') fail(`无法检查目录 ${extDir}: ${err.message}`)
}

// 默认父目录 = <仓库根>/extensions/：如果这里根本不是 obox 仓库，给个提示（用户扩展通常是独立仓库）
if (!dirArg) {
  try {
    const pkg = JSON.parse(stripBom(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')))
    if (!pkg || pkg.name !== 'obox') {
      console.error(
        `[create-user-extension] 提示: ${REPO_ROOT} 不是 obox 仓库，仍会生成到 ${extDir}；` +
          '用户扩展通常是独立仓库，建议用 --dir 指定目标父目录'
      )
    }
  } catch {
    console.error(
      `[create-user-extension] 提示: 未找到 ${join(REPO_ROOT, 'package.json')}，仍会生成到 ${extDir}；` +
        '用户扩展通常是独立目录，建议用 --dir 指定目标父目录'
    )
  }
}

const camelName = safeIdentifier(camel(id))
const version = '1.0.0'
/** App 卡片 id（page.js 里靠它把消息路由回本扩展，见 src/renderer/src/AppWindow.vue:54-99） */
const appId = `${id}.main`
const treeViewId = `${id}.tree`
const statusId = `${id}.status`
const helloCommand = `${id}.hello`
const packageName = `${id.toLowerCase()}-ext`

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9h8M8 13h5"/></svg>'

const manifest = {
  name: id,
  version,
  displayName,
  ...(author ? { author } : {}),
  description,
  main: './index.js',
  contributes: {
    views: [{ id: treeViewId, title: displayName, icon: ICON, group: 'top' }],
    commands: [{ command: helloCommand, title: '打个招呼', category: displayName, palette: true }],
    statusBarItems: [
      {
        id: statusId,
        name: displayName,
        text: displayName,
        alignment: 'right',
        priority: 10,
        command: helloCommand
      }
    ],
    i18n: {
      zh: { [`${id}.hello.text`]: `你好，{name}！`, [`${id}.tree.root`]: '示例节点' },
      en: { [`${id}.hello.text`]: `Hello, {name}!`, [`${id}.tree.root`]: 'Example node' }
    }
  }
}

// ---------------------------------------------------------------- index.js

const indexJs = `/**
 * ${id} 用户扩展入口（**纯 ESM JavaScript，零运行时依赖**）。
 *
 * 宿主用 import() 动态加载本文件，不做任何构建转换，所以：
 *   - 只能依赖注入的 api，不能 import npm 包，也不能 import 宿主 src/；
 *   - 命令 id 必须已在 manifest.json 的 contributes.commands 声明，
 *     否则 api.registerCommand 抛错（registry.ts:203 command not declared），扩展标红 activationError；
 *   - 返回值是"释放函数"：宿主停用/卸载扩展时调用，所有注册都要在这里 dispose。
 *
 * 本目录的静态页（page.html / page.js）经 app://extensions/${id}/ 加载，路径由 import.meta.url 推导。
 */
const ICON = ${jsLiteral(ICON)}

/** 具名导出的纯函数：不碰 api，最容易被 node --test 直接覆盖 */
export function greet(name) {
  return '你好，' + (name || '世界') + '！'
}

export default function ${camelName}(api) {
  // 经 import.meta.url 推导安装目录（app://extensions/<id>/），不硬编码安装目录名
  const base = new URL('.', import.meta.url).href
  const disposables = []

  // 1) 命令实现（id 见 manifest.contributes.commands）
  disposables.push(
    api.registerCommand(${jsLiteral(helloCommand)}, async (name) => {
      const text = api.i18n.t(${jsLiteral(`${id}.hello.text`)}, { name: name || 'Obox' })
      api.statusBar.setText(${jsLiteral(statusId)}, text)
      return text
    })
  )

  // 2) 状态栏：manifest 已声明静态项，这里只改文本（未声明时 setText 是 no-op）
  //    注意：statusBarItems[].titleKey 走**宿主语言包**（StatusBar.vue:18），用户扩展改不了它，
  //    所以这里直接用文本；扩展自己的词条只对 api.i18n.t 生效。
  api.statusBar.setText(${jsLiteral(statusId)}, ${jsLiteral(displayName)})

  // 3) 导航区树视图：contributes.views 声明的视图由宿主内置树组件渲染（view id 固定 obox.tree），
  //    数据源在这里按**视图 id** 注册。
  disposables.push(
    api.views.registerTreeProvider(${jsLiteral(treeViewId)}, {
      getChildren(element) {
        if (element) return []
        return [
          {
            id: ${jsLiteral(`${id}.root`)},
            label: api.i18n.t(${jsLiteral(`${id}.tree.root`)}),
            icon: ICON,
            command: ${jsLiteral(helloCommand)}
          }
        ]
      }
    })
  )

  // 4) App 卡片：点击弹独立子窗口，iframe 加载本扩展目录下的静态页
  disposables.push(
    api.app.register({
      id: ${jsLiteral(appId)},
      name: ${jsLiteral(displayName)},
      version: ${jsLiteral(version)},
      author: ${jsLiteral(author || 'Obox')},
      description: ${jsLiteral(description)},
      icon: ICON,
      url: new URL(${jsLiteral(vue ? './dist/index.html' : './page.html')}, base).href,
      multiOpen: false,
      width: 900,
      height: 640
    })
  )

  // 5) 子窗口 ↔ 扩展消息桥：静态页 postMessage 过来，这里返回结果（见 page.js）
  disposables.push(
    api.app.onMessage((channel, payload) => {
      if (channel === 'hello') {
        const name = payload && typeof payload === 'object' ? payload.name : undefined
        return { ok: true, text: greet(name) }
      }
      return { ok: false, error: '未知消息通道: ' + channel }
    })
  )

  return () => {
    for (const dispose of disposables) dispose.dispose()
  }
}
`

// ---------------------------------------------------------------- 静态页

/**
 * 子窗口主题接收桥（宿主 → iframe 单向推送，协议见 references/themes-settings.md 与 ADR-0022）。
 *
 * 为什么需要它：子窗口是独立文档（app:// 协议），与父文档**跨源** ⇒ CSS 自定义属性不跨文档继承、
 * 宿主也注入不了 <style>。宿主在 iframe load / 主题变化 / 收到 obox-theme-request 时会 postMessage
 * { source:'obox-app', action:'obox-theme', themeId, tokens }；本模块把 tokens 写到自己的 :root。
 *
 * FALLBACK_TOKENS 只用于"推送到达前 / 老宿主"的首帧，值 = 宿主 dark 默认值（main.css）。
 * CSS 里仍写 var(--token, fallback)：宿主可用时两个来源同值，宿主不可用时兜住可读性。
 * ⚠️ 消息形状与宿主协议一致，**勿改**。
 */
const themeJs = `/** 宿主子窗口主题接收桥（obox-theme）；协议见 skills/obox-ext-dev/references/themes-settings.md */
const FALLBACK_TOKENS = {
  '--bg': '#1e1e1e',
  '--bg-input': '#3c3c3c',
  '--border': '#3c3c3c',
  '--fg': '#cccccc',
  '--fg-dim': '#6e6e6e',
  '--fg-bright': '#ffffff',
  '--hover-bg': 'rgba(255, 255, 255, 0.1)',
  '--font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  '--font-size': '13px',
  '--font-size-lg': '16px'
}

/** 只认 '--xxx' 形状的键 + 非空字符串值；非法条目丢弃（与宿主侧双保险） */
function sanitize(tokens) {
  const out = {}
  if (!tokens || typeof tokens !== 'object') return out
  for (const [k, v] of Object.entries(tokens)) {
    if (!/^--[a-z0-9-]+$/.test(k)) continue
    if (typeof v !== 'string' || v === '') continue
    out[k] = v
  }
  return out
}

/** 把 token 写到目标元素的行内样式（默认 :root） */
export function applyThemeTokens(tokens, root = document.documentElement) {
  let n = 0
  for (const [k, v] of Object.entries(sanitize(tokens))) {
    root.style.setProperty(k, v)
    n++
  }
  return n
}

/**
 * 安装接收桥：同步写兜底（首帧就有配色）→ 监听推送 → 按 0/300/1000ms 请求重发（收到即停）。
 * 无 DOM 环境（node 单测）下安全空转，不抛错。
 * @returns {{ dispose(): void }}
 */
export function installAppThemeBridge() {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { dispose() {} }
  }
  applyThemeTokens(FALLBACK_TOKENS)
  document.documentElement.style.colorScheme = 'dark'

  let received = false
  const timers = []
  const onMessage = (event) => {
    const data = event.data
    if (!data || data.source !== 'obox-app' || data.action !== 'obox-theme') return
    if (event.source !== window.parent) return
    applyThemeTokens(data.tokens)
    received = true
    for (const t of timers) clearTimeout(t)
    timers.length = 0
    console.log('[ext] 主题已应用', data.themeId || '(无主题扩展)')
  }
  window.addEventListener('message', onMessage)
  for (const ms of [0, 300, 1000]) {
    timers.push(
      setTimeout(() => {
        if (received) return
        window.parent.postMessage({ source: 'obox-app', action: 'obox-theme-request' }, '*')
        if (ms === 1000) {
          console.warn('[ext] 未收到宿主主题推送（3 次请求无响应），使用内置兜底配色')
        }
      }, ms)
    )
  }
  return {
    dispose() {
      window.removeEventListener('message', onMessage)
      for (const t of timers) clearTimeout(t)
    }
  }
}
`

const pageHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="color-scheme" content="dark" />
    <title>${htmlEscape(displayName)}</title>
    <style>
      /* 子窗口是独立文档（app:// 协议），CSS 变量不跨文档继承；宿主经 obox-theme 推送 token（theme.js），
         在收到之前由 var(--token, fallback) 兜住首帧 / 老宿主 */
      body {
        margin: 0;
        padding: 16px;
        background: var(--bg, #1e1e1e);
        color: var(--fg, #cccccc);
        font-family: var(--font-family, system-ui, sans-serif);
        font-size: var(--font-size, 13px);
      }
      h1 {
        margin: 0 0 8px;
        font-size: var(--font-size-lg, 16px);
        color: var(--fg-bright, #ffffff);
      }
      button {
        padding: 6px 12px;
        border: 1px solid var(--border, #3c3c3c);
        border-radius: 4px;
        background: var(--bg-input, #3c3c3c);
        color: var(--fg, #cccccc);
        cursor: pointer;
      }
      button:hover {
        background: var(--hover-bg, rgba(255, 255, 255, 0.1));
      }
      #output {
        margin: 12px 0 0;
        color: var(--fg-dim, #6e6e6e);
      }
    </style>
  </head>
  <body>
    <h1>${htmlEscape(displayName)}</h1>
    <p>这是扩展自带的静态页。点按钮 → 经宿主消息桥调用 index.js 里的 api.app.onMessage。</p>
    <button id="ask" type="button">向扩展发消息</button>
    <p id="output"></p>
    <!-- 必须是**独立脚本文件**：宿主 srcdoc 模式下的 CSP 是 script-src 'self' app:，内联 <script> 会被拦掉 -->
    <script type="module" src="./page.js"></script>
  </body>
</html>
`

const pageJs = `/**
 * 静态页脚本（独立文件；不要改成 page.html 里的内联 <script>）。
 *
 * 与扩展入口的桥：window.parent.postMessage({ source: 'obox-app', action: 'obox-extension', ... })
 * 宿主回 { source: 'obox-app', action: 'obox-extension-reply', requestId, result }
 * 协议实现在 src/renderer/src/AppWindow.vue，扩展侧处理器在 api.app.onMessage。
 *
 * 主题：先装接受桥（宿主经 obox-theme 推送 token，跨源拿不到 CSS 变量），再挂 UI。
 */
import { installAppThemeBridge } from './theme.js'

installAppThemeBridge()

const APP_ID = ${jsLiteral(appId)}
const pending = new Map()
let seq = 0

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.source !== 'obox-app' || data.action !== 'obox-extension-reply') return
  const resolvePending = pending.get(data.requestId)
  if (resolvePending) {
    pending.delete(data.requestId)
    resolvePending(data.result)
  }
})

function ask(channel, payload) {
  const requestId = 'req-' + (++seq)
  return new Promise((resolvePending) => {
    pending.set(requestId, resolvePending)
    window.parent.postMessage(
      {
        source: 'obox-app',
        action: 'obox-extension',
        appId: APP_ID,
        channel,
        payload,
        requestId
      },
      '*'
    )
  })
}

const button = document.getElementById('ask')
const output = document.getElementById('output')
button.addEventListener('click', async () => {
  output.textContent = '…'
  const result = await ask('hello', { name: 'Obox' })
  output.textContent = result && result.ok ? result.text : '失败: ' + (result && result.error)
})
`

// ---------------------------------------------------------------- 单测

const testJs = `/**
 * 扩展单测（node:test + mock api，零依赖）。运行：npm test
 *
 * 原理：入口只与注入的 api 交互，用 mock 捕获命令实现/状态栏文本/卡片/消息处理器，验证行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ${camelName}, { greet } from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))

function createMockApi() {
  const state = {
    commands: new Map(),
    status: {},
    cards: [],
    providers: new Map(),
    messageHandlers: [],
    disposed: []
  }
  const dict = manifest.contributes.i18n.zh
  const api = {
    registerCommand(commandId, handler) {
      state.commands.set(commandId, handler)
      return {
        dispose: () => {
          state.disposed.push(commandId)
          state.commands.delete(commandId)
        }
      }
    },
    statusBar: {
      setText(id, text) {
        state.status[id] = text
      }
    },
    views: {
      registerTreeProvider(viewId, provider) {
        state.providers.set(viewId, provider)
        return { dispose: () => state.disposed.push(viewId) }
      }
    },
    app: {
      register(card) {
        state.cards.push(card)
        return { dispose: () => state.disposed.push(card.id) }
      },
      onMessage(handler) {
        state.messageHandlers.push(handler)
        return { dispose: () => state.disposed.push('onMessage') }
      }
    },
    i18n: {
      t(key, params) {
        let text = dict[key] === undefined ? key : dict[key]
        for (const [k, v] of Object.entries(params || {})) {
          text = text.replace(new RegExp('\\\\{' + k + '\\\\}', 'g'), String(v))
        }
        return text
      }
    }
  }
  return { api, state }
}

function activate() {
  const { api, state } = createMockApi()
  const cleanup = ${camelName}(api)
  return { state, cleanup }
}

test('激活：注册 manifest 声明的全部命令', () => {
  const { state } = activate()
  const declared = manifest.contributes.commands.map((c) => c.command).sort()
  assert.deepEqual([...state.commands.keys()].sort(), declared)
})

test('命令：返回本地化问候语，并同步状态栏文本', async () => {
  const { state } = activate()
  const handler = state.commands.get(${jsLiteral(helloCommand)})
  const text = await handler('Obox')
  assert.equal(text, greet('Obox'))
  assert.equal(state.status[${jsLiteral(statusId)}], text)
})

test('树视图：按视图 id 注册数据源，根节点带命令', () => {
  const { state } = activate()
  const provider = state.providers.get(${jsLiteral(treeViewId)})
  assert.ok(provider, '应按 contributes.views 的 id 注册数据源')
  const roots = provider.getChildren()
  assert.equal(roots.length, 1)
  assert.equal(roots[0].command, ${jsLiteral(helloCommand)})
  assert.deepEqual(provider.getChildren(roots[0]), [])
})

test('App 卡片：注册一张指向静态页的卡片', () => {
  const { state } = activate()
  assert.equal(state.cards.length, 1)
  assert.equal(state.cards[0].id, ${jsLiteral(appId)})
  assert.ok(state.cards[0].url.endsWith(${jsLiteral(vue ? '/dist/index.html' : '/page.html')}))
})

test('消息桥：hello 通道返回问候语，未知通道返回 ok:false', async () => {
  const { state } = activate()
  const handler = state.messageHandlers[0]
  const ok = await handler('hello', { name: 'Obox' })
  assert.equal(ok.ok, true)
  assert.equal(ok.text, greet('Obox'))
  const bad = await handler('nope', {})
  assert.equal(bad.ok, false)
})

test('cleanup：释放全部注册', () => {
  const { state, cleanup } = activate()
  cleanup()
  assert.equal(state.commands.size, 0)
  assert.ok(state.disposed.includes('onMessage'))
  assert.ok(state.disposed.includes(${jsLiteral(appId)}))
})
`

// ---------------------------------------------------------------- pack.mjs

const packJs = `#!/usr/bin/env node
/**
 * 打包 .oix：把扩展分发文件 zip 成 out/<name>-<version>.oix。
 *
 * .oix 就是普通 zip，**根目录**必须放 manifest.json + 入口文件（manifest.main）+ 静态资源：
 * 安装器按根 manifest.json 读 id/version/main 并检查入口在包内（src/main/oixCore.ts:198-222）。
 *
 * **data/ 不进包**：它是扩展运行时数据目录（覆盖安装时由宿主保留），含 data/ 的包会被安装器
 * 以 forbidden-entry 直接拒收（见 skills/obox-ext-dev/references/guides-user.md 第 6 节）；
 * 本脚本的 SKIP_DIRS 已显式排除 data/、out/、node_modules/、.git/，并在收集后兜底拒绝。
 *
 * 零依赖：只用 node:zlib 自己写 zip —— 用户扩展不引入任何 npm 依赖。
 * 用法：npm run pack
 */
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 打进包根的单个文件（不存在就跳过）；新增静态资源时加到这里 */
const FILES = [
  'manifest.json',
  'index.js',
  'page.html',
  'page.js',
  'theme.js',
  'icon.svg',
  'icon.png',
  'LICENSE'
]
/** 打进包的目录（递归）；dist/ 是 Vue 子应用构建产物 */
const DIRS = ['dist', 'assets']

/**
 * 永不进包的目录名（任意层级）：data/ 是扩展运行时数据目录 —— 宿主升级时保留它，
 * 且安装器对含 data/ 的包直接报 forbidden-entry 拒收（guides-user.md 第 6 节）。
 */
const SKIP_DIRS = new Set(['data', 'out', 'node_modules', '.git'])

/** 目录下所有文件（zip 内路径用 / 分隔） */
function walk(dir, prefix) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    const name = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) out.push(...walk(full, name))
    else out.push({ name, data: readFileSync(full) })
  }
  return out
}

function collect() {
  const entries = []
  for (const file of FILES) {
    if (existsSync(join(root, file))) {
      entries.push({ name: file, data: readFileSync(join(root, file)) })
    }
  }
  for (const dir of DIRS) {
    const full = join(root, dir)
    if (existsSync(full) && statSync(full).isDirectory()) entries.push(...walk(full, dir))
  }
  // 兜底：即使有人把 data 写进 FILES/DIRS，也在这里拒绝，避免产出装不上的 .oix
  const forbidden = entries.filter((entry) => entry.name === 'data' || entry.name.startsWith('data/'))
  if (forbidden.length > 0) {
    throw new Error(
      '包内不得包含 data/ 目录（宿主安装器会以 forbidden-entry 拒收）：' +
        forbidden.map((entry) => entry.name).join(', ')
    )
  }
  return entries
}

/** CRC-32（zip 需要） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 最小 zip 写入器：local header + 中央目录 + EOCD（文本走 deflate，压不小就 store） */
function zip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const deflated = deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // 文件名 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date = 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra
    parts.push(local, name, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += local.length + name.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment
  return Buffer.concat([...parts, centralBuf, eocd])
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const entries = collect()
const main = String(manifest.main || '').replace(/^\\.\\//, '')
if (!entries.some((entry) => entry.name === main)) {
  throw new Error('缺少入口文件 ' + main + '（manifest.main 指向它，必须在包根）')
}
if (!entries.some((entry) => entry.name === 'manifest.json')) {
  throw new Error('缺少 manifest.json')
}

const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, manifest.name + '-' + manifest.version + '.oix')
writeFileSync(outPath, zip(entries))
console.log('[pack] 已打包 ' + outPath + '（' + entries.map((e) => e.name).join(', ') + '）')
`

// ---------------------------------------------------------------- package.json / README

const pkg = {
  name: packageName,
  version,
  private: true,
  type: 'module',
  description: description || `${displayName} — obox 用户扩展`,
  ...(author ? { author } : {}),
  scripts: {
    test: 'node --test',
    pack: vue ? 'npm run build && node scripts/pack.mjs' : 'node scripts/pack.mjs',
    release: 'npm run test && npm run pack',
    ...(vue ? { dev: 'vite', build: 'vite build' } : {})
  },
  ...(vue
    ? {
        devDependencies: {
          '@vitejs/plugin-vue': '^6.0.2',
          vite: '^7.2.6',
          vue: '^3.5.25'
        }
      }
    : {})
}

const readme = `# ${displayName}（obox 扩展）

${description || '一个 obox 用户扩展骨架：纯 ESM 入口 + 导航树视图 + 命令 + 状态栏项 + App 卡片。'}

## 目录结构

| 路径 | 说明 |
| --- | --- |
| \`manifest.json\` | 扩展清单（\`main: "./index.js"\`）；贡献点在 \`contributes\` 里**声明式**声明 |
| \`index.js\` | 入口：纯 ESM JavaScript，\`default\` 导出插件函数，返回释放函数 |
| \`page.html\` / \`page.js\` / \`theme.js\` | App 卡片子窗口的静态页（脚本必须是独立文件，见下）；\`theme.js\` 是主题接收桥 |
| \`test/extension.test.js\` | \`node --test\` 单测（mock api，零依赖） |
| \`scripts/pack.mjs\` | 打包 \`.oix\`（zip，零依赖） |
| \`out/<id>-<version>.oix\` | 分发给别人安装的扩展包 |

## 开发

\`\`\`bash
npm test            # node --test，零依赖，不需要 npm install
npm run pack        # 生成 out/${id}-${version}.oix
${vue ? 'npm install && npm run build   # 构建 Vue 子应用（构建期依赖，不进 .oix 运行时）\n' : ''}\`\`\`

- 改 \`index.js\` / \`manifest.json\` 后在扩展管理器里**停用再启用**（或重启应用）即生效。
- 入口是**纯 ESM JavaScript**：不能 \`import\` npm 包，也不能 \`import\` 宿主源码，只能用注入的 \`api\`。
- 校验清单（在 obox 仓库里执行）：
  \`node skills/obox-ext-dev/scripts/validate-manifest.mjs manifest.json\`

## 打包与安装

- \`npm run pack\` → \`out/${id}-${version}.oix\`（zip 根目录 = manifest.json + 入口 + 静态资源）。
- **不要把 \`data/\` 打进包**：\`data/\` 是扩展的运行时数据目录（\`<userData>/extensions/<id>/data\`，**覆盖安装时由宿主保留**），含 \`data/\` 的 \`.oix\` 会被宿主以 \`forbidden-entry\` 直接拒收。\`scripts/pack.mjs\` 已显式排除 \`data/\`（连同 \`out/\`、\`node_modules/\`、\`.git/\`）。
- 安装：扩展管理器点「安装」选 \`.oix\`，或把 \`.oix\` 拖进 obox 窗口。
- 安装位置：\`<userData>/extensions/${id}${author ? `_${author.toLowerCase().replace(/[^a-z0-9._-]/g, '')}` : ''}/\`（目录名 = \`<name>_<author>\`）。
- 开发期也可以不走安装：宿主启动参数 \`--debug-extension ${id}@<本目录绝对路径>\`，
  经 \`app://debug/${id}/\` 直接加载本地目录（详见 \`skills/obox-ext-dev/references/guides-user.md\`）。

## 贡献点与 i18n（titleKey 说明）

- 已声明：\`views\`（导航区树视图，宿主内置树组件渲染，数据经 \`api.views.registerTreeProvider\` 提供）、
  \`commands\`、\`statusBarItems\`、\`i18n\`（扩展自己的语言包）。
- \`contributes.views[].title\` / \`statusBarItems[].name\` 直接用**文本**。
  **不要**为它们写 \`titleKey\`：\`titleKey\` 由宿主用**宿主语言包**解析
  （\`NavBar.vue:14\`、\`StatusBar.vue:18\` 用的是宿主 \`t()\`），
  而用户扩展无法往宿主语言包里加词条 —— 写了只会显示原始 key。
- \`contributes.i18n\` 只对 \`api.i18n.t('<扩展自己的 key>')\` 生效（独立命名空间，见 \`core/extensionI18n.ts\`）。
- 纯 JS 用户扩展**不能**贡献 \`navItems\`：\`navItems[].view\` 必须是入口**具名导出的 Vue 组件**，
  而纯 ESM 入口没有 Vue。需要导航区内容请用 \`contributes.views\`（树视图）或 App 卡片（静态页）。

## 静态页的两个坑

1. **不要写内联 \`<script>\`**：App 卡片的 \`html\`（srcdoc）模式继承宿主 CSP
   \`script-src 'self' app:\`，内联脚本会被直接拦掉（按钮点了没反应）。用独立 \`.js\` 文件。
2. 子窗口是独立文档（\`app://\` 协议），**CSS 自定义属性不跨文档继承**；宿主会通过
   \`obox-theme\` 消息**下发**主题 token（协议见 \`skills/obox-ext-dev/references/themes-settings.md\`），
   \`theme.js\` 的 \`installAppThemeBridge()\` 已装好接收桥；**在收到之前**用 \`var(--token, fallback)\`
   兜住首帧 / 老宿主（两者同值时以宿主推送为准）。
`

// ---------------------------------------------------------------- --vue 子应用骨架

const viteConfig = `import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * Vue 子应用（App 卡片静态页）构建配置。
 * 产物进 dist/（.oix 只收 dist/，源码 app/ 不进包）；base: './' 让 app:// 下的相对路径可用。
 * 这是**构建期**依赖；扩展运行时入口 index.js 仍然零依赖。
 */
export default defineConfig({
  root: resolve(root, 'app'),
  base: './',
  plugins: [vue()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true
  }
})
`

const appIndexHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="color-scheme" content="dark" />
    <title>${htmlEscape(displayName)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`

const appMainTs = `import { createApp } from 'vue'
import App from './App.vue'
import { installAppThemeBridge } from './theme.js'
import './style.css'

// 子窗口主题接收桥：**必须在挂载 UI 之前**同步安装（宿主可能先于 Vue 就绪推送 token）
installAppThemeBridge()

createApp(App).mount('#app')
`

const appStyleCss = `/* 子窗口是独立文档（app:// 协议），CSS 变量不跨文档继承；宿主经 obox-theme 推送 token（theme.js），
   在收到之前由 var(--token, fallback) 兜住首帧 / 老宿主 */
body {
  margin: 0;
  padding: 16px;
  background: var(--bg, #1e1e1e);
  color: var(--fg, #cccccc);
  font-family: var(--font-family, system-ui, sans-serif);
  font-size: var(--font-size, 13px);
}
`

const appVue = `<script setup lang="ts">
import { ref } from 'vue'

// App 卡片子窗口 ↔ 扩展入口的消息桥（协议见 src/renderer/src/AppWindow.vue:54-99）
const APP_ID = ${jsLiteral(appId)}
const pending = new Map<string, (result: unknown) => void>()
let seq = 0

window.addEventListener('message', (event) => {
  const data = event.data as {
    source?: string
    action?: string
    requestId?: string
    result?: unknown
  }
  if (!data || data.source !== 'obox-app' || data.action !== 'obox-extension-reply') return
  const resolvePending = data.requestId ? pending.get(data.requestId) : undefined
  if (resolvePending && data.requestId) {
    pending.delete(data.requestId)
    resolvePending(data.result)
  }
})

function ask(channel: string, payload: unknown): Promise<unknown> {
  const requestId = 'req-' + ++seq
  return new Promise((resolvePending) => {
    pending.set(requestId, resolvePending)
    window.parent.postMessage(
      { source: 'obox-app', action: 'obox-extension', appId: APP_ID, channel, payload, requestId },
      '*'
    )
  })
}

const output = ref('')
const busy = ref(false)

async function onAsk(): Promise<void> {
  busy.value = true
  output.value = '…'
  const result = (await ask('hello', { name: 'Obox' })) as { ok?: boolean; text?: string; error?: string }
  output.value = result && result.ok ? (result.text ?? '') : '失败: ' + (result && result.error)
  busy.value = false
}
</script>

<template>
  <h1>${htmlEscape(displayName)}</h1>
  <p>这是扩展的 Vue 子应用（构建产物在 dist/）。点按钮 → 经宿主消息桥调用 index.js。</p>
  <button type="button" :disabled="busy" @click="onAsk">向扩展发消息</button>
  <p class="output">{{ output }}</p>
</template>

<style scoped>
h1 {
  margin: 0 0 8px;
  font-size: var(--font-size-lg, 16px);
  color: var(--fg-bright, #ffffff);
}

button {
  padding: 6px 12px;
  border: 1px solid var(--border, #3c3c3c);
  border-radius: 4px;
  background: var(--bg-input, #3c3c3c);
  color: var(--fg, #cccccc);
  cursor: pointer;
}

button:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.1));
}

.output {
  color: var(--fg-dim, #6e6e6e);
}
</style>
`

// ---------------------------------------------------------------- 写盘

async function write(relativePath, content) {
  const target = join(extDir, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

await mkdir(extDir, { recursive: true })
await write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
await write('index.js', indexJs)
await write('test/extension.test.js', testJs)
await write('scripts/pack.mjs', packJs)
await write('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
await write('README.md', readme)
if (vue) {
  await write('app/index.html', appIndexHtml)
  await write('app/main.ts', appMainTs)
  await write('app/App.vue', appVue)
  await write('app/style.css', appStyleCss)
  await write('app/theme.js', themeJs)
  await write('vite.config.ts', viteConfig)
} else {
  await write('page.html', pageHtml)
  await write('page.js', pageJs)
  await write('theme.js', themeJs)
}

console.log(`[create-user-extension] 已生成用户扩展${vue ? '（含 Vue 子应用骨架）' : ''}:
  ${extDir}/manifest.json
  ${extDir}/index.js
  ${extDir}/${vue ? 'app/（Vue 子应用源码，构建产物进 dist/）' : 'page.html + page.js + theme.js'}
  ${extDir}/test/extension.test.js
  ${extDir}/scripts/pack.mjs
  ${extDir}/package.json
  ${extDir}/README.md

下一步（在 ${extDir} 里执行）：
  npm test                      # node --test，零依赖
${vue ? '  npm install && npm run build   # 先构建 Vue 子应用（构建期依赖）\n' : ''}  npm run pack                  # 生成 out/${id}-${version}.oix
  校验清单：node ${join(SCRIPT_DIR, 'validate-manifest.mjs')} ${join(extDir, 'manifest.json')}
  开发流程与文档：skills/obox-ext-dev/references/guides-user.md`)

function camel(s) {
  const parts = s
    .split(/[-._]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
  const joined = parts.join('')
  return joined[0].toLowerCase() + joined.slice(1)
}
