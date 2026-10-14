/**
 * 「代理设置 → IPC」门禁：设置里的 `network.proxy` 是 reactive Proxy，直接塞进
 * `ipcRenderer.invoke` 会被结构化克隆拒掉（`Error: An object could not be cloned.`）。
 *
 * 实测症状（复核 obox-updater 时发现）：设置 → 更新 → 点「检查更新」后按钮**永久停在「检查中…」**，
 * 主进程日志只有一行 `Uncaught (in promise) Error: An object could not be cloned.`；
 * 同一个 IPC 用**字面量纯对象**调用则正常返回 `{ok:true}`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { reactive } from 'vue'
import { emptyProxyConfig, plainProxyConfig } from '../src/renderer/src/core/plainProxy'

test('plainProxyConfig：响应式 Proxy 输入可被结构化克隆（本 bug 的回归判据）', () => {
  const store = reactive({
    enabled: true,
    host: '127.0.0.1',
    port: 8080,
    username: 'u',
    password: 'p',
    ignoreSSL: true,
    noProxy: ['localhost', '127.0.0.1']
  })
  const plain = plainProxyConfig(store)
  // 直接克隆响应式对象会抛；克隆归一化结果必须成功
  assert.throws(() => structuredClone(store), /could not be cloned/)
  assert.doesNotThrow(() => structuredClone(plain))
  assert.deepEqual(structuredClone(plain), {
    enabled: true,
    host: '127.0.0.1',
    port: 8080,
    username: 'u',
    password: 'p',
    ignoreSSL: true,
    noProxy: ['localhost', '127.0.0.1']
  })
})

test('plainProxyConfig：字段收敛为原始类型，noProxy 是新数组（不与设置共享引用）', () => {
  const src = reactive({ enabled: 1, host: 5, port: 'x', noProxy: [1, 2] })
  const plain = plainProxyConfig(src)
  assert.equal(plain.enabled, false, '非 true 一律 false')
  assert.equal(plain.host, '', '非字符串一律空串')
  assert.equal(plain.port, undefined, '非有限数字不写入 port')
  assert.deepEqual(plain.noProxy, ['1', '2'], '元素转字符串')
  assert.notEqual(plain.noProxy, src.noProxy, 'noProxy 必须是新数组')

  const empty = plainProxyConfig(undefined)
  assert.deepEqual(empty, { enabled: false, host: '', noProxy: [] })
  assert.notEqual(emptyProxyConfig(), emptyProxyConfig(), '默认值每次返回新对象')
})

test('源码门禁：把代理设置送入 IPC / 跨扩展边界的地方必须过 plainProxyConfig', () => {
  const host = readFileSync(new URL('../src/renderer/src/core/host.ts', import.meta.url), 'utf8')
  const settings = readFileSync(
    new URL('../src/renderer/src/extensions/settings/SettingsView.vue', import.meta.url),
    'utf8'
  )
  // 1) 不得再把 getSetting('network.proxy') 的**返回值直接**当 IPC 参数（历史写法）
  assert.ok(
    !/window\.api\.netFetch\([\s\S]*?,\s*stateStore\.getSetting<ProxyConfig>\('network\.proxy'\)\s*\)/.test(
      host
    ),
    'net.fetch 不得把响应式代理直接透传给 IPC'
  )
  // 2) 三个写入点都必须过归一化函数
  const uses = host.match(/plainProxyConfig\(/g) ?? []
  assert.ok(uses.length >= 3, `host.ts 里至少应有 3 处 plainProxyConfig，实际 ${uses.length}`)
  assert.ok(
    /proxy:\s*plainProxyConfig\(proxyConfig\)/.test(settings),
    'SettingsView 的 checkUpdate 必须用 plainProxyConfig(proxyConfig) 而不能再写 { ...proxyConfig }'
  )
  assert.ok(
    !/proxy:\s*\{\s*\.\.\.proxyConfig\s*\}/.test(settings),
    'SettingsView 不得再浅拷贝响应式对象进 IPC（内层 noProxy 仍是 Proxy）'
  )
})
