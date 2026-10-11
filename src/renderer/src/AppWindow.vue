<script setup lang="ts">
/**
 * App 子窗口：复用 TitleBar（标题=插件名）+ 内容栏 iframe。
 * 渲染插件注册的 url（优先）或 html（srcdoc）。
 * 监听 iframe 内 postMessage 的窗口控制消息（最小化/最大化/关闭本窗口）。
 * 主题（ADR-0022 / 设计 §2.7）：
 * - `srcdoc` 型：token 拼进同一份文档（<style>），切主题经 frameKey 变化重渲染；
 * - `url` 型：跨源注入不了 CSS，改由宿主经 `obox-theme` 消息下发 token，
 *   切主题**不**重渲染（frameKey 与主题无关）⇒ 页面内表单内容不丢。
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
 * 子窗口启动时 `host.start()` 收尾已 `applyCurrent()`（core/host.ts:930），
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

const iframeSrc = computed(() => registration.value?.url ?? undefined)
const iframeSrcdoc = computed(() => {
  if (registration.value?.url) return undefined
  const html =
    registration.value?.html ?? `<p style="color:#888;padding:16px">${t('appExt.emptyContent')}</p>`
  return themeStyleHtml.value + html
})

/** iframe 的 :key —— url 型与主题无关（不重渲染），srcdoc 型随主题变化（重渲染） */
const frameKey = computed(() => appFrameKey(registration.value, themeId.value))

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
      // 扩展消息：转发到扩展入口（主窗口宿主），结果回传 iframe
      void window.api
        .extensionMessage(data.appId, data.channel, data.payload)
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
  <div class="app-window">
    <TitleBar :title="title" :icon="windowIcon" />
    <div class="app-window-content">
      <iframe
        v-if="registration"
        ref="frameRef"
        :key="frameKey"
        class="app-frame"
        :src="iframeSrc"
        :srcdoc="iframeSrcdoc"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        @load="pushThemeTokens"
      />
      <div v-else class="app-window-empty">
        <p>{{ t('appExt.notFound', { appId }) }}</p>
      </div>
    </div>
    <PromptHost />
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
.app-window-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-dim, #6e6e6e);
  font-size: 13px;
}
</style>
