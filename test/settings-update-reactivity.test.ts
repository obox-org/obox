/**
 * 「更新页响应式」门禁：**读取非响应式 stateStore 的 computed 必须显式依赖 `settingsRevision`**。
 *
 * 背景（打包版 obox 1.0.10 实测）：在设置 → 更新里选中「Obox 更新」后，「检查更新」按钮**始终不出现**，
 * 只有重启应用才行；DOM 上 `v-if="activeUpdater"` 的位置一直是空占位注释。
 * 根因：`core/state.ts:85` 的 `const state = load()` **不是 reactive**，`stateStore.getSetting()` 的读取
 * 不被追踪 ⇒ `computed(() => updaterStore.activeId)` 缓存首次结果（`undefined`）永不失效；
 * 设置页又在 `KeepAlive` 内，切走再回来也不重算。
 * 本用例既做**行为验证**（同一个"非响应式 store + computed"模型），也做**源码门禁**（防止再漏）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, ref } from 'vue'
import { test } from 'vitest'

const SETTINGS_VIEW = new URL(
  '../src/renderer/src/extensions/settings/SettingsView.vue',
  import.meta.url
)
const STATE_TS = new URL('../src/renderer/src/core/state.ts', import.meta.url)

test('行为验证：不依赖 settingsRevision 的 computed 不会随非响应式 store 更新（正是本 bug）', () => {
  // 模拟 stateStore：普通对象，写入不触发任何响应式
  const plainStore = { value: undefined }
  const settingsRevision = ref(0)

  const stale = computed(() => plainStore.value)
  const fixed = computed(() => {
    void settingsRevision.value
    return plainStore.value
  })

  assert.equal(stale.value, undefined, '初始应为 undefined')
  assert.equal(fixed.value, undefined)
  plainStore.value = 'obox-updater_obox-org'
  assert.equal(
    stale.value,
    undefined,
    '❌ 未接 settingsRevision 的 computed 保持陈旧（本 bug 的形态）'
  )
  settingsRevision.value++
  assert.equal(fixed.value, 'obox-updater_obox-org', '✓ 接上 settingsRevision 后能立刻反映新值')
})

test('源码门禁：SettingsView 读 stateStore 的更新相关 computed 必须依赖 settingsRevision', () => {
  const src = readFileSync(SETTINGS_VIEW, 'utf8')
  const block = /const activeUpdater = computed\(\(\) => \{([\s\S]*?)\}\)/.exec(src)
  assert.ok(block, '未找到 activeUpdater 的 computed 定义（结构变了就更新本门禁）')
  assert.match(
    block[1],
    /void settingsRevision\.value/,
    'activeUpdater 必须 `void settingsRevision.value`：否则选中提供者后「检查更新」按钮不出现'
  )
  assert.match(block[1], /updaterStore\.activeId/, 'activeUpdater 仍应取 updaterStore.activeId')
  // 反面：不得再退回成一行直读（那正是出问题的写法）
  assert.ok(
    !/const activeUpdater = computed\(\(\) => updaterStore\.activeId\)/.test(src),
    '不得退回 `computed(() => updaterStore.activeId)`（不追响应式，按钮不会出现）'
  )
})

test('源码依据：stateStore 的 state 确实不是 reactive（本门禁成立的前提）', () => {
  const src = readFileSync(STATE_TS, 'utf8')
  assert.match(
    src,
    /const state: PersistedState = load\(\)/,
    'state.ts 的 state 是普通对象；若它哪天改成 reactive，本文件与 SettingsView 的注释都要同步'
  )
})
