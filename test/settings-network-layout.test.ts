/**
 * 「设置-网络」版式门禁（用户两次实报后定下的形态）：
 *  1. 代理地址/排除列表输入框**按内容区比例缩放**（`width: 100%`），不能再是固定窄条
 *     —— 先是 `min-width: 220px`（太短），后是固定 440px（宽窗口下显得空）；
 *  2. **字段说明紧贴它描述的控件、与下一个选项拉开**：说明必须放在同一个 `.config-row` 内
 *     （结构上从属该字段），由 `.config-row .config-desc { margin-top: 6px }` + 行自己的
 *     `margin-bottom: 16px` 形成"上 6 / 下 16"的间距。
 *
 * 实测（dev + CDP，三种视口）：输入框/内容区 ≈ 0.91–0.96；输入框→说明 = 6px；说明→下一选项 = 16px。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

const src = readFileSync(
  new URL('../src/renderer/src/extensions/settings/SettingsView.vue', import.meta.url),
  'utf8'
)

test('网络分区输入框按内容区比例缩放（width: 100%，不是固定 px）', () => {
  const rule = /\.network-block \.config-row \.text-input \{([\s\S]*?)\}/.exec(src)
  assert.ok(rule, '未找到 .network-block .config-row .text-input 规则')
  assert.match(rule[1], /width:\s*100%/, '必须按内容区比例缩放（width: 100%），否则又成了固定窄条')
  assert.ok(
    !/min-width:\s*\d{3,}px/.test(rule[1]),
    '不得再用固定 min-width（历史上的 220px / 440px 都因此被用户否掉）'
  )
})

test('字段说明在它所描述的那一行内（结构上从属该字段）', () => {
  const network = /<div v-else-if="active === 'network'"[\s\S]*?<\/div>\s*<!-- 通知/.exec(src)
  assert.ok(network, '未找到网络分区模板')
  const block = network[0]
  const urlRow = /<div class="config-row">\s*<label>\{\{ t\('settings\.network\.url'\) \}\}<\/label>([\s\S]*?)<\/div>/.exec(
    block
  )
  assert.ok(urlRow, '未找到「代理地址」那一行')
  assert.match(
    urlRow[1],
    /<p class="config-desc">\{\{ t\('settings\.network\.urlHint'\) \}\}<\/p>/,
    'urlHint 必须放在代理地址这一行**内部**（贴近它描述的控件）'
  )
  assert.ok(
    !/<\/div>\s*<p class="config-desc">\{\{ t\('settings\.network\.urlHint'\) \}\}<\/p>/.test(block),
    'urlHint 不得再作为同级兄弟节点（那样会贴着下一个选项）'
  )
})

test('说明与控件/下一项的间距有明确规则（上 6px / 行下边距 16px）', () => {
  const hint = /\.config-row \.config-desc \{([\s\S]*?)\}/.exec(src)
  assert.ok(hint, '未找到 .config-row .config-desc 规则')
  assert.match(hint[1], /margin-top:\s*6px/, '说明距控件应为 6px')
  const row = /\.config-row \{([\s\S]*?)\}/.exec(src)
  assert.ok(row, '未找到 .config-row 规则')
  assert.match(row[1], /margin-bottom:\s*16px/, '行下边距（= 说明与下一个选项的距离）应为 16px')
})
