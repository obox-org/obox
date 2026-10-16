<script lang="ts">
/**
 * 模块级副作用（初始脚本求值期执行，早于首帧绘制与组件挂载）：overlay 窗体透明的**第 5/5 处**
 * 改动（design D-11）。main.css 的全局 `body { background: var(--bg) }` 对**每个窗口**都生效，
 * 会给 overlay 直接铺上不透明底色——漏这处，前四处透明改动全白做。因此查询串声明 overlay
 * 模式时给 <html> 挂 `obox-overlay` class，由 main.css 的 `html.obox-overlay` 规则把 html/body
 * 背景就地置 transparent。
 *
 * 为什么必须在挂载前：主进程在 `ready-to-show`（首帧绘制完成）后才显示 overlay 窗体
 * （main/appWindow.ts），等到 setup/mount 再改背景，窗体出现瞬间会闪一块不透明底色。
 * 为什么放 SFC 模块作用域：AppWindow.vue 被 main.ts **静态导入**，模块顶层代码在初始脚本
 * 求值期（首帧前）就会执行，效果等同于在入口写 inline style，而 main.ts 只需管窗口类型判定。
 * 只影响 overlay 窗口（class 按查询串加），主窗口与 App 卡片子窗口不受影响（R9 回归约束）。
 */
if (new URLSearchParams(window.location.search).get('obox-window') === 'overlay') {
  document.documentElement.classList.add('obox-overlay')
}
</script>

<script setup lang="ts">
/**
 * App 子窗口：复用 TitleBar（标题=插件名）+ 内容栏 iframe。
 * 渲染插件注册的 url（优先）或 html（srcdoc）。
 * 监听 iframe 内 postMessage 的窗口控制消息（最小化/最大化/关闭本窗口）。
 *
 * overlay 模式（卡 03；?obox-window=overlay，design pet-desktop-companion D-11）：
 * 同一份外壳按查询串进入 overlay 模式——不渲染 TitleBar/PromptHost、三处背景全透明、
 * iframe 直接加载主进程校验过的扩展页 URL（查询串契约五参数见 main/appWindow.ts overlayQuery）。
 * 所有 overlay 分支都由 `isOverlay` 单一开关隔离，App 卡片子窗口（rdp/webapp 类）行为逐字不变（R9）。
 *
 * 主题（ADR-0022 / 设计 §2.7）：
 * - `srcdoc` 型：token 拼进同一份文档（<style>），切主题经 frameKey 变化重渲染；
 * - `url` 型：跨源注入不了 CSS，改由宿主经 `obox-theme` 消息下发 token，
 *   切主题**不**重渲染（frameKey 与主题无关）⇒ 页面内表单内容不丢。
 * - overlay 型：不接主题桥（pushThemeTokens 因 registration 缺省自然跳过，不加新分支；
 *   宠物窗体"无主题、artwork 自带配色"，见 design D-6）。
 * 跨窗口主题变化经 `storage` 事件合并进本窗口 stateStore（core/state.ts），再 applyCurrent + 推送。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import TitleBar from './components/TitleBar.vue'
import PromptHost from './components/PromptHost.vue'
import { appStore } from './core/appStore'
import { themeStore } from './core/theme'
import { stateStore } from './core/state'
import { uiStore } from './core/uiStore'
import { appFrameKey, buildThemeMessage, collectThemeTokens } from './core/appTheme'

const { t } = useI18n()

const params = new URLSearchParams(window.location.search)
const appId = params.get('appId') ?? ''
const sequence = Number(params.get('sequence') ?? '1')

/**
 * overlay 模式判定（卡 03；main.ts 用同一参数决定挂本组件而不是主窗口 App）。
 * overlay 的查询串契约（五个参数，R13 裁定）：
 * `obox-window=overlay&extId=<扩展id>&overlayId=<overlay id>&appId=<overlay id>&url=<扩展页URL>`
 * —— `appId` = overlayId（页面把它原样当 appId 发消息，宿主先查卡片再查 overlay 路由表）；
 * `url` 由主进程校验后写入（main/appWindow.ts isOverlayUrlInsideExtension）。
 */
const isOverlay = params.get('obox-window') === 'overlay'
/** overlay 所属扩展 id（查询串带入；卡片子窗口没有该参数，恒为空串） */
const extId = params.get('extId') ?? ''

/**
 * overlay 页面 URL 的**外壳侧二次校验**（R13 裁定：防御纵深，不能只信主进程——查询串理论上
 * 可被手工构造）。判据与主进程 `isOverlayUrlInsideExtension`（src/main/appWindow.ts）**完全一致**，
 * 两处互相引用、不得单边放宽：app:// 协议 + 三个合法 host（extensions/builtin/debug，
 * main/protocol.ts 的映射）+ 路径首段 = 本窗口的 extId + 有子路径 + 不含 '..'。
 */
function isOverlayUrlAllowed(raw: string, ownerExtId: string): boolean {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'app:') return false
    if (!['extensions', 'builtin', 'debug'].includes(parsed.hostname)) return false
    const rest = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    if (!rest || rest.includes('..')) return false
    const slash = rest.indexOf('/')
    // slash > 0：首段（扩展 id）非空；slash < rest.length - 1：首段后必须还有子路径（目录本身拒绝）
    return slash > 0 && slash < rest.length - 1 && rest.slice(0, slash) === ownerExtId
  } catch {
    return false
  }
}

/**
 * overlay iframe 加载的扩展页地址：仅当二次校验通过才非空。校验失败 ⇒ 不加载 iframe、
 * 渲染空白（透明窗体直接透出桌面，不画空态提示——空态文字也是像素），并 console.warn 一条
 * `[overlay] 拒绝非法 url: …`（经 console-message 转发进主进程终端，前缀 [child-renderer:warning]）。
 */
const overlayUrl = (() => {
  if (!isOverlay) return ''
  const raw = params.get('url') ?? ''
  if (raw && isOverlayUrlAllowed(raw, extId)) return raw
  console.warn(
    `[overlay] 拒绝非法 url: ${raw || '(空)'}（须为 app://extensions|builtin|debug/${extId}/ 目录内页面）`
  )
  return ''
})()

const registration = computed(() => appStore.findById(appId))

const title = computed(() => {
  const name = registration.value?.name ?? ''
  return sequence > 1 ? `${name} ${sequence}` : name
})

/** 子窗口标题栏图标：卡片注册的 icon（SVG 字符串，单色随主题） */
const windowIcon = computed(() => registration.value?.icon)

/** iframe 元素引用：主题下发与「请求来源校验」都要用它的 contentWindow */
const frameRef = ref<HTMLIFrameElement | null>(null)

/** 读宿主 `:root` 上的**生效** token 值（main.css 默认值 + 当前主题覆盖） */
function readThemeTokens(): Record<string, string> {
  const root = document.documentElement
  return collectThemeTokens((name) => getComputedStyle(root).getPropertyValue(name))
}

/**
 * 主题快照（模块级状态，每个渲染窗口各一份）。
 * 子窗口启动时 `host.start()` 收尾已 `applyCurrent()`（core/host.ts:952），
 * 因此在 setup 阶段同步取一次就有值（设计 §2.7.3 第 2 步）。
 */
const themeId = ref(themeStore.currentId)
const themeTokens = ref<Record<string, string>>(readThemeTokens())

/** srcdoc 注入的 CSS：来自本地快照，而不是主题声明 */
const themeStyleHtml = computed(() => {
  const rules = Object.entries(themeTokens.value)
    .map(([k, v]) => `${k}: ${v};`)
    .join('')
  return rules ? `<style>:root{${rules}}</style>` : ''
})

const iframeSrc = computed(() =>
  isOverlay ? overlayUrl || undefined : (registration.value?.url ?? undefined)
)
const iframeSrcdoc = computed(() => {
  // overlay 只有 url 型（主进程/外壳两道校验保证指向扩展目录内页面），不走 srcdoc 注入
  if (isOverlay) return undefined
  if (registration.value?.url) return undefined
  const html =
    registration.value?.html ?? `<p style="color:#888;padding:16px">${t('appExt.emptyContent')}</p>`
  return themeStyleHtml.value + html
})

/**
 * iframe 的 :key —— url 型与主题无关（不重渲染），srcdoc 型随主题变化（重渲染）。
 * overlay 型：overlayUrl 是不变的常量 ⇒ key 恒定、永不重渲染（页面动画/状态不被主题切换打断）。
 */
const frameKey = computed(() =>
  isOverlay ? overlayUrl : appFrameKey(registration.value, themeId.value)
)

/**
 * 把当前主题 token 下发给 iframe（仅 `url` 型卡片；srcdoc 型走文档内注入 + 重渲染，不叠加）。
 * 触发时机：iframe load 完成 / 主题变化（refreshTheme）/ 收到 `obox-theme-request`。
 */
function pushThemeTokens(): void {
  if (!registration.value?.url) return
  const win = frameRef.value?.contentWindow
  if (!win) {
    console.warn('[AppWindow] 主题下发跳过：iframe 未就绪', appId)
    return
  }
  const tokens = themeTokens.value
  win.postMessage(buildThemeMessage(themeId.value, tokens), '*')
  console.log('[AppWindow] 下发主题', themeId.value, Object.keys(tokens).length + ' 个 token')
}

/** 主题变化：应用新主题到本窗口 `:root` → 刷新快照 → 下发（子窗口**绝不**调 setTheme，避免写回 localStorage） */
function refreshTheme(): void {
  themeStore.applyCurrent()
  themeId.value = themeStore.currentId
  themeTokens.value = readThemeTokens()
  pushThemeTokens()
}

function onMessage(e: MessageEvent): void {
  const data = e.data
  if (!data || typeof data !== 'object' || data.source !== 'obox-app') return
  switch (data.action) {
    case 'minimize':
      void window.api.windowAction('minimize')
      break
    case 'maximize':
      void window.api.windowAction('toggle-maximize')
      break
    case 'close':
      void window.api.windowAction('close')
      break
    case 'obox-theme-request': {
      // 子页面请求重发主题（不带 requestId：这是通知，不是请求-响应）
      if (e.source !== frameRef.value?.contentWindow) {
        console.warn('[AppWindow] 忽略来源不明的主题请求')
        return
      }
      console.log('[AppWindow] 收到子窗口主题请求，下发', themeId.value)
      pushThemeTokens()
      break
    }
    case 'obox-extension':
      // 扩展消息：转发到扩展入口（主窗口宿主），结果回传 iframe。
      // overlay 窗口强制用**自己查询串的 appId**（= overlayId）路由：宿主先查卡片、查不到再按
      // overlayId 查所属扩展（core/host.ts resolveMessageExtId），页面无法借道指定别人的卡片 id
      // 发消息（作用域收紧）；App 卡片子窗口仍用页面发来的 data.appId（既有行为逐字不变）。
      void window.api
        .extensionMessage(isOverlay ? appId : data.appId, data.channel, data.payload)
        .then((result) => {
          if (e.source) {
            ;(e.source as Window).postMessage(
              {
                source: 'obox-app',
                action: 'obox-extension-reply',
                requestId: data.requestId,
                result
              },
              '*'
            )
          }
        })
        .catch((err) => {
          if (e.source) {
            ;(e.source as Window).postMessage(
              {
                source: 'obox-app',
                action: 'obox-extension-reply',
                requestId: data.requestId,
                result: { ok: false, error: err instanceof Error ? err.message : String(err) }
              },
              '*'
            )
          }
        })
      break
  }
}

let offTheme: (() => void) | undefined
let offUiShow: (() => void) | undefined

onMounted(() => {
  window.addEventListener('message', onMessage)
  // 主题变化（本窗口或经 storage 合并进来的跨窗口快照）→ 重新应用 + 下发 token
  offTheme = stateStore.onSettingsChanged((key) => {
    if (key === undefined || key === 'theme') refreshTheme()
  })
  // 扩展 ui 模态框（焦点在本窗口时由主进程转发）：驱动本地 uiStore 渲染，结果回传
  offUiShow = window.events.on('ui:show', (e) => {
    let p: Promise<unknown | undefined>
    if (e.kind === 'form') {
      p = uiStore.showForm(e.payload as Parameters<typeof uiStore.showForm>[0])
    } else if (e.kind === 'quickPick') {
      const payload = e.payload as {
        items: { label: string; description?: string }[]
        opts?: { title?: string; placeHolder?: string }
      }
      p = uiStore.showQuickPick(payload.items, payload.opts)
    } else if (e.kind === 'inputBox') {
      p = uiStore.showInputBox(
        e.payload as { title?: string; value?: string; placeHolder?: string; password?: boolean }
      )
    } else {
      p = Promise.resolve(undefined)
    }
    void p
      .then((value) => {
        window.api.uiResult(e.requestId, { canceled: value === undefined, value })
      })
      .catch((err) => {
        console.error('[AppWindow] ui result error', e.kind, err)
        window.api.uiResult(e.requestId, { canceled: true })
      })
  })
})

onUnmounted(() => {
  window.removeEventListener('message', onMessage)
  offTheme?.()
  offUiShow?.()
})
</script>

<template>
  <div class="app-window" :class="{ 'app-window--overlay': isOverlay }">
    <!-- 透明改动 2/5（D-11）：overlay 不渲染标题栏——任何不透明像素都会破坏「完全透出桌面」 -->
    <TitleBar v-if="!isOverlay" :title="title" :icon="windowIcon" />
    <div class="app-window-content">
      <iframe
        v-if="isOverlay ? overlayUrl : registration"
        ref="frameRef"
        :key="frameKey"
        class="app-frame"
        :src="iframeSrc"
        :srcdoc="iframeSrcdoc"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        @load="pushThemeTokens"
      />
      <!-- overlay 的 url 缺失/非法（外壳二次校验拒绝）⇒ 渲染空白：透明窗体直接透出桌面，
           空态提示文字也是像素、不能画；卡片子窗口的空态提示保持既有行为 -->
      <div v-else-if="!isOverlay" class="app-window-empty">
        <p>{{ t('appExt.notFound', { appId }) }}</p>
      </div>
    </div>
    <!-- 透明改动 2/5（D-11）：overlay 同样不渲染 PromptHost（模态遮罩也是不透明像素）。
         取舍说明（R11 裁定附带项）：overlay 窗口因此**不参与** ui 模态框转发——主进程 ui.ts
         的 isChild 判定按 'obox-window=app' 命中，overlay 不命中 ⇒ api.ui 模态框回主窗口
         本地渲染（{ local: true }）。这是**预期行为**而不是 bug：overlay 页面本身没有 api
         对象也开不了模态框（sandbox 无 allow-modals），只有扩展入口可能调 api.ui，那时焦点
         通常也不在 overlay 上。 -->
    <PromptHost v-if="!isOverlay" />
  </div>
</template>

<style scoped>
.app-window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg, #1e1e1e);
}
.app-window-content {
  flex: 1;
  min-height: 0;
  background: var(--bg, #1e1e1e);
}
.app-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #ffffff;
}
/* 透明改动 3/5 与 4/5（D-11）：overlay 根 class 下外壳三层背景全透明——
   .app-window / .app-window-content 的 var(--bg) 与 .app-frame 的白底。
   .app-frame 是最容易漏的一处：iframe 默认白底会把宠物糊成白色矩形。
   第 5 处（全局 body 背景）在 assets/main.css 的 html.obox-overlay 规则 +
   本文件顶部 <script> 的模块级副作用。基础规则原样保留 ⇒ 卡片子窗口回归不受影响（R9）。 */
.app-window--overlay,
.app-window--overlay .app-window-content,
.app-window--overlay .app-frame {
  background: transparent;
}
.app-window-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-dim, #6e6e6e);
  font-size: 13px;
}
</style>
