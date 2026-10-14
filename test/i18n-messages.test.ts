/**
 * i18n 编译门禁：**每条文案都必须能被 vue-i18n 编译**。
 *
 * 背景（1.0.12 真实事故）：代理地址提示里写了裸 `@`（`http://user:pass@host:8080`），而 vue-i18n 把
 * `@` 当作**链接消息语法**（`@:key`）⇒ 抛 `SyntaxError: Message compilation error: Invalid linked format`
 * ⇒ 整个「设置 → 网络」页渲染抛错、白屏，且设置视图被带崩。写法必须是 `{'@'}`。
 *
 * 这类错误在"读源码断言接线"的测试里完全看不出来，只有真正编译一遍才暴露，所以本门禁把**两个语言包
 * 的每条叶子键都 t() 一遍**。注意：`t()` 的编译是惰性的，所以"遍历所有键"才是关键，不能只测一两个键。
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '../src/renderer/src/i18n/locales/en'
import zh from '../src/renderer/src/i18n/locales/zh'

/** 收集所有叶子键（`a.b.c` 形式；数组与字符串都视为叶子） */
function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : []
  }
  const out: string[] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leafKeys(v, key))
    else out.push(key)
  }
  return out
}

const locales: Array<[string, Record<string, unknown>]> = [
  ['zh', zh as unknown as Record<string, unknown>],
  ['en', en as unknown as Record<string, unknown>]
]

for (const [name, messages] of locales) {
  test(`i18n(${name})：每条文案都能编译（裸 @ 会被当链接语法而抛错）`, () => {
    const keys = leafKeys(messages)
    assert.ok(keys.length > 100, `键数异常（${keys.length}）——递归收集可能坏了`)
    const i18n = createI18n({
      legacy: false,
      locale: name,
      messages: { [name]: messages },
      missingWarn: false,
      fallbackWarn: false
    })
    const failures: string[] = []
    for (const key of keys) {
      try {
        const rendered = i18n.global.t(key)
        assert.equal(typeof rendered, 'string', `${key} 渲染结果不是字符串`)
        // 转义必须生效：渲染结果里应是字面量 `@`，而不是残留的 {'@'} 字面量
        assert.ok(!rendered.includes("{'@'}"), `${key} 的 @ 转义没生效：${rendered}`)
      } catch (err) {
        failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    assert.deepEqual(failures, [], `有 ${failures.length} 条文案无法编译：\n${failures.join('\n')}`)
  })
}

test('代理地址提示：@ 以字面量渲染出来（转义正确，未被吞掉）', () => {
  const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh }, missingWarn: false })
  const text = i18n.global.t('settings.network.urlHint')
  assert.match(text, /user:pass@host:8080/, `应渲染出字面量 @：${text}`)
})
