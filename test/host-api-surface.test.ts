/**
 * 宿主 API 类型面门禁（`api.overlay` 命名空间 + `progress` 设置字段类型 + `apiVersion` 递增）。
 *
 * 为什么读源文件断言、而不是写编译期类型断言：`test/**` 不在任一 tsconfig 的 include 里
 * （`tsconfig.node.json` 只盖 main/preload/shared，`tsconfig.web.json` 只盖 api/renderer/shared），
 * `npm run typecheck` 不检查测试文件，vitest 的 esbuild 转译也不做类型检查——`@ts-expect-error` /
 * `expectTypeOf` 写在这里不会被任何门槛把关（假绿）。仓库既有做法是**读源码断言类型面与文档注释**
 * （先例：test/settings-view-wiring.test.ts 读 src/api/contributions.ts、test/app-window-wiring.test.ts
 * 读 AppWindow.vue），本文件沿用。
 *
 * 钉住的内容：
 * 1) `api.overlay`：四方法签名（含卡 14 的 `setPosition`）、与 `api.app` 同层、"按扩展 id
 *    限定作用域（越权拒绝）"写进 JSDoc；
 * 2) overlay 共享类型（`CreateOverlayRequest` / `OverlayAnchor` / `OverlayResult`）：必填面 /
 *    可选面 / 枚举白名单 / `{ok, error?, position?}` 返回风格（`position` 由 create 与
 *    setPosition 回传实际坐标，R31）；
 * 3) `progress`：`SettingFieldType` 联合的精确白名单、`max` 可缺省（缺省视为 100）、显示口径
 *    （钳制后向下取整 / 条宽未取整 / 不渲染 description）写进 JSDoc；
 * 4) 根 `package.json` 的 `apiVersion === 2`，且 `core/manifest.ts` 门槛读取的是同一字段（功能
 *    断言：声明 2 通过、声明 3 报"需要 obox API v3 或更高（当前 obox 为 v2）"）；
 * 5) 负向：非法输入被拒——运行时喂非法值给 `validateManifest` 与本文件的"契约镜像校验器"并断言
 *    拒绝；类型面则以枚举白名单与必填属性解析钉死（`anchor` 非枚举值、缺 `id`/`url`、`max` ≤ 0）。
 *    边界说明：overlay 参数的**真实运行时**拒绝（窗体创建路径上的 width ≤ 0、越权 id 等）由宿主
 *    窗体实现及其测试负责；类型面这一卡只能钉"契约文本 + 结构白名单"，镜像校验器是它们的运行时
 *    可执行表达（不改任何实现，纯喂非法值断言被拒）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../src/renderer/src/core/manifest'
// 只作类型引用（satisfies 夹具）：esbuild 转译时整行擦除，不产生运行时依赖
import type { CreateOverlayRequest, SettingField } from '../src/api'

/** 读仓库文件（相对本测试文件；UTF-8） */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

/** 去掉块注释 / HTML 注释 / 行注释（同 settings-view-wiring 的做法：文档里的示例不得喂污代码面断言） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 折叠空白：prettier 换行不该让"签名/语句存在"断言假红 */
function flatten(src: string): string {
  return src.replace(/\s+/g, ' ')
}

/**
 * 取 marker（字符串或正则）正上方的文档注释并归一化：去每行前导 `*`、去粗体 `**`、折行为单空格。
 * marker 不存在时返回空串（调用方的 toContain 会自然失败）。
 */
function docAbove(src: string, marker: string | RegExp): string {
  const at = typeof marker === 'string' ? src.indexOf(marker) : src.search(marker)
  if (at < 0) return ''
  const start = src.lastIndexOf('/**', at)
  return src
    .slice(start < 0 ? 0 : start, at)
    .split('\n')
    .map((l) => l.replace(/^\s*\/?\*+\/?\s?/, ''))
    .join(' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
}

/** 解析联合类型的全部单引号成员（按源码顺序）；找不到声明时返回空数组 */
function parseUnion(src: string, name: string): string[] {
  const at = src.indexOf(`export type ${name} =`)
  if (at < 0) return []
  const end = src.indexOf('\n\n', at)
  const body = src.slice(at, end < 0 ? src.length : end)
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** 解析 interface 的属性声明：名字 → { 是否可选, 类型文本 }（只认单行 `name?: type`，本文件涉及的接口均是） */
function parseInterface(
  src: string,
  name: string
): Map<string, { optional: boolean; type: string }> {
  const props = new Map<string, { optional: boolean; type: string }>()
  const at = src.indexOf(`export interface ${name} {`)
  if (at < 0) return props
  const end = src.indexOf('\n}', at)
  const body = stripComments(src.slice(at, end < 0 ? src.length : end))
  for (const line of body.split('\n')) {
    const m = /^\s*(\w+)(\?)?:\s*(.+?)\s*$/.exec(line)
    if (m) props.set(m[1], { optional: m[2] === '?', type: m[3] })
  }
  return props
}

const sharedSrc = read('../src/shared/types.ts')
const apiSrc = read('../src/api/types.ts')
const contribSrc = read('../src/api/contributions.ts')

const overlaySpec = parseInterface(sharedSrc, 'CreateOverlayRequest')
const overlayAnchors = parseUnion(sharedSrc, 'OverlayAnchor')
const settingFieldSpec = parseInterface(contribSrc, 'SettingField')
const settingFieldTypes = parseUnion(contribSrc, 'SettingFieldType')

/**
 * `CreateOverlayRequest` 的「契约镜像」校验器：结构（必填/可选/枚举白名单）取自源码解析结果，
 * 数值边界取自 JSDoc 契约文本（`width`/`height` 必须 > 0、`margin` ≥ 0）。返回违规列表（空 = 通过）。
 * 只服务本文件的负向用例——真实运行时校验在宿主窗体实现里，不在类型面卡内。
 */
function checkOverlayRequest(req: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const key of Object.keys(req)) {
    if (!overlaySpec.has(key)) problems.push(`未知属性: ${key}`)
  }
  for (const [key, decl] of overlaySpec) {
    const value = req[key]
    if (value === undefined) {
      if (!decl.optional) problems.push(`缺少必填属性: ${key}`)
      continue
    }
    switch (decl.type) {
      case 'string':
        if (typeof value !== 'string' || !value.trim()) problems.push(`${key} 必须是非空字符串`)
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${key} 必须是数字`)
        else if ((key === 'width' || key === 'height') && value <= 0)
          problems.push(`${key} 必须 > 0`)
        else if (key === 'margin' && value < 0) problems.push(`${key} 必须 ≥ 0`)
        break
      case 'boolean':
        if (typeof value !== 'boolean') problems.push(`${key} 必须是布尔`)
        break
      case 'OverlayAnchor':
        if (typeof value !== 'string' || !overlayAnchors.includes(value)) {
          problems.push(`${key} 必须是 OverlayAnchor 的合法枚举值`)
        }
        break
      default:
        problems.push(`${key} 的类型镜像校验器不认识: ${decl.type}`)
    }
  }
  return problems
}

/**
 * 设置字段的「契约镜像」校验器：`type` 必须在 `SettingFieldType` 联合内；`max` 出现时必须是
 * 数字且 > 0（契约见 `SettingField.max` 的 JSDoc：缺省视为 100，≤ 0 / 非数字属非法输入）。
 */
function checkSettingField(field: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const key of Object.keys(field)) {
    if (!settingFieldSpec.has(key)) problems.push(`未知属性: ${key}`)
  }
  for (const [key, decl] of settingFieldSpec) {
    const value = field[key]
    if (value === undefined) {
      if (!decl.optional) problems.push(`缺少必填属性: ${key}`)
      continue
    }
    if ((key === 'key' || key === 'label') && (typeof value !== 'string' || !value.trim())) {
      problems.push(`${key} 必须是非空字符串`)
    }
    if (key === 'type' && (typeof value !== 'string' || !settingFieldTypes.includes(value))) {
      problems.push('type 不在 SettingFieldType 联合内')
    }
    if (key === 'max') {
      if (typeof value !== 'number' || !Number.isFinite(value)) problems.push('max 必须是数字')
      else if (value <= 0) problems.push('max 必须 > 0')
    }
  }
  return problems
}

describe('overlay 共享类型（src/shared/types.ts）', () => {
  it('OverlayAnchor 枚举白名单精确一致：含 bottom-right，四个贴角、无越界值', () => {
    expect(overlayAnchors).toEqual(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
    // 负向：非枚举方位在类型白名单里不存在（类型层面拒绝）
    expect(overlayAnchors).not.toContain('bottom-center')
    expect(overlayAnchors).not.toContain('center')
  })

  it('CreateOverlayRequest 必填面/可选面：id/url/width/height/anchor 必填；margin 与三个窗体开关可选', () => {
    const required = [...overlaySpec].filter(([, d]) => !d.optional).map(([k]) => k)
    const optional = [...overlaySpec].filter(([, d]) => d.optional).map(([k]) => k)
    expect(required).toEqual(['id', 'url', 'width', 'height', 'anchor'])
    expect(optional).toEqual(['margin', 'transparent', 'alwaysOnTop', 'skipTaskbar'])
    expect(overlaySpec.get('anchor')?.type).toBe('OverlayAnchor')
    expect(overlaySpec.get('width')?.type).toBe('number')
    expect(overlaySpec.get('height')?.type).toBe('number')
  })

  it('数值与平台契约写进 JSDoc：width/height 必须 > 0、margin 缺省 24、transparent 创建后不可切换', () => {
    const start = sharedSrc.indexOf('export interface CreateOverlayRequest {')
    const end = sharedSrc.indexOf('export interface OverlayResult')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = sharedSrc.slice(start, end)
    expect(block).toContain('必须 > 0')
    expect(block).toContain('缺省 24')
    expect(block).toContain('必须 ≥ 0')
    expect(block).toContain('创建后不可运行时切换')
  })

  it('OverlayResult 是 { ok, error?, position? } 结果对象（失败不抛错，与 notification/shell 返回风格同构）', () => {
    const props = parseInterface(sharedSrc, 'OverlayResult')
    expect(props.size).toBe(3)
    expect(props.get('ok')).toEqual({ optional: false, type: 'boolean' })
    expect(props.get('error')).toEqual({ optional: true, type: 'string' })
    // 卡 14：position 是**可选**字段——create 与 setPosition 成功时回传实际坐标（R31）
    expect(props.get('position')).toEqual({ optional: true, type: '{ x: number; y: number }' })
  })

  it('OverlayResult.position 的存在理由写进 JSDoc：create 与 setPosition 回传实际坐标、扩展拿不到 workArea、供入口建立/校正位置基准', () => {
    const doc = docAbove(sharedSrc, 'position?: { x: number; y: number }')
    expect(doc).not.toBe('')
    // R31：create 回传 anchor/margin 解析后的真实位置，setPosition 回传钳制后的真实位置
    expect(doc).toContain('`create` 与 `setPosition`')
    expect(doc).toContain('anchor/margin 解析后')
    expect(doc).toContain('钳制后')
    // destroy/setMouseThrough 不带该字段（契约写明，防实现漂移）
    expect(doc).toContain('destroy/setMouseThrough 不带')
    // 为什么必须回传：扩展拿不到 workArea，入口要靠它建立/校正自己的位置基准
    expect(doc).toContain('拿不到 workArea')
    expect(doc).toContain('基准')
  })
})

describe('api.overlay 命名空间（src/api/types.ts）', () => {
  const code = flatten(stripComments(apiSrc))

  it('四方法存在且签名与契约一致（入参/返回同构；setPosition 为卡 14 增补）', () => {
    expect(code).toContain('create(options: CreateOverlayRequest): Promise<OverlayResult>')
    expect(code).toContain('destroy(id: string): Promise<OverlayResult>')
    expect(code).toContain('setMouseThrough(id: string, through: boolean): Promise<OverlayResult>')
    expect(code).toContain('setPosition(id: string, x: number, y: number): Promise<OverlayResult>')
  })

  it('overlay 与 app 同为 ExtensionActivationApi 的顶层命名空间（同缩进 = 同层，不挂在 app 下）', () => {
    // 接口属性级缩进为 2 空格；嵌套在 app 内会是 4 空格。overlay 为**必填**：卡 03 已把
    // `overlay?` 翻成 `overlay`（宿主 buildApi 运行时接线落地，裁定 R12）；老宿主缺该命名空间
    // 由 manifest `apiVersion` 门槛拒绝加载声明 v2 的扩展（裁定 R2），因此过门槛的扩展可当
    // 必定存在来用。
    expect(apiSrc).toMatch(/^ {2}app: \{$/m)
    expect(apiSrc).toMatch(/^ {2}overlay: \{$/m)
    const ifaceAt = apiSrc.indexOf('export interface ExtensionActivationApi {')
    expect(ifaceAt).toBeGreaterThan(-1)
    expect(apiSrc.indexOf('overlay: {', ifaceAt)).toBeGreaterThan(apiSrc.indexOf('app: {', ifaceAt))
  })

  it('作用域约束写进文档注释：只能操作自己创建的、宿主按扩展 id 校验、越权一律拒绝、停用自动回收；覆盖**四个方法**', () => {
    const doc = docAbove(apiSrc, /^ {2}overlay: \{$/m)
    expect(doc).not.toBe('')
    // 卡 14：作用域 JSDoc 覆盖四方法（setPosition 加入后计数必须跟上，防"三方法"陈述过时）
    expect(doc).toContain('四个方法')
    expect(doc).not.toContain('三个方法')
    expect(doc).toContain('调用方扩展自己创建的')
    expect(doc).toContain('宿主按扩展 id')
    expect(doc).toContain('越权')
    expect(doc).toContain('拒绝')
    expect(doc).toContain('自动回收')
  })

  it('create 文档写明：失败不抛错（ok: false）、参数契约、创建后默认鼠标穿透、回传绝对坐标基准（R31）', () => {
    const doc = docAbove(apiSrc, 'create(options: CreateOverlayRequest)')
    expect(doc).not.toBe('')
    expect(doc).toContain('不抛错')
    expect(doc).toContain('ok: false')
    expect(doc).toContain('必须 > 0')
    expect(doc).toContain('默认鼠标穿透')
    // R31：成功回传 position = 窗体在屏幕上的绝对坐标（扩展拿不到 workArea，拖动以此为基准）
    expect(doc).toContain('绝对坐标')
    expect(doc).toContain('基准')
    expect(doc).toContain('失败路径不带')
  })

  it('destroy 文档写明：真正销毁窗体（不是隐藏）、幂等、越权拒绝', () => {
    const doc = docAbove(apiSrc, 'destroy(id: string)')
    expect(doc).not.toBe('')
    expect(doc).toContain('真正销毁')
    expect(doc).toContain('不是隐藏')
    expect(doc).toContain('幂等')
    expect(doc).toContain('越权')
  })

  it('setMouseThrough 文档写明宿主实现语义：setIgnoreMouseEvents(true, { forward: true }) / false，整窗切换', () => {
    const doc = docAbove(apiSrc, 'setMouseThrough(id: string')
    expect(doc).not.toBe('')
    expect(doc).toContain('setIgnoreMouseEvents(true, { forward: true })')
    expect(doc).toContain('setIgnoreMouseEvents(false)')
    expect(doc).toContain('仍会转发')
    expect(doc).toContain('整窗')
  })

  it('setPosition 文档写明：扩展主钳/宿主兜底、钳位公式、非法坐标不钳不猜、position 回传钳后坐标、只改位置', () => {
    const doc = docAbove(apiSrc, 'setPosition(id: string')
    expect(doc).not.toBe('')
    // 钳位双保险（design D-13）：扩展侧主钳，宿主侧兜底钳到主显示器工作区
    expect(doc).toContain('主钳')
    expect(doc).toContain('兜底')
    expect(doc).toContain('x ∈ [wa.x, wa.x+wa.width-w]')
    expect(doc).toContain('y ∈ [wa.y, wa.y+wa.height-h]')
    // 非法坐标直接拒绝（不钳不猜）
    expect(doc).toContain('NaN/Infinity/非数字')
    expect(doc).toContain('不钳不猜')
    // position 回传 = 钳制后实际坐标（扩展拿不到 workArea，靠它校正记录）
    expect(doc).toContain('钳制后的实际坐标')
    expect(doc).toContain('校正')
    // 移动只改位置：不触碰其它窗体属性；不存在/越权口径与其余方法同构
    expect(doc).toContain('只改位置')
    expect(doc).toContain('transparent/alwaysOnTop/鼠标穿透态')
    expect(doc).toContain('越权')
  })

  it('overlay 共享类型从 src/api 再导出（扩展作者单点导入，与对话框类型同先例）', () => {
    const flat = flatten(apiSrc)
    expect(flat).toMatch(
      /import type \{[^}]*CreateOverlayRequest[^}]*OverlayAnchor[^}]*OverlayResult[^}]*\} from '\.\.\/shared\/types'/
    )
    expect(flat).toMatch(
      /export type \{[^}]*CreateOverlayRequest[^}]*OverlayAnchor[^}]*OverlayResult[^}]*\}/
    )
  })
})

describe('progress 设置字段类型（src/api/contributions.ts）', () => {
  it('SettingFieldType 联合白名单精确一致：progress 是合法字段类型', () => {
    expect(settingFieldTypes).toEqual([
      'text',
      'number',
      'boolean',
      'select',
      'directory',
      'status',
      'progress'
    ])
  })

  it('负向：联合外类型（gauge / progressbar）不在白名单（类型层面拒绝）', () => {
    expect(settingFieldTypes).not.toContain('gauge')
    expect(settingFieldTypes).not.toContain('progressbar')
  })

  it('progress 语义写进类型文档：扩展写、宿主只读渲染（与 status 同源），显示口径齐备', () => {
    const doc = docAbove(contribSrc, 'export type SettingFieldType')
    expect(doc).not.toBe('')
    expect(doc).toContain('progress')
    expect(doc).toContain('只读')
    expect(doc).toContain('api.settings.set')
    expect(doc).toContain('进度条')
    expect(doc).toContain('{cur}/{max}')
    expect(doc).toContain('向下取整')
    expect(doc).toContain('未取整')
    expect(doc).toContain('不渲染')
    expect(doc).toContain('description')
    expect(doc).toContain('100')
  })

  it('max 是可选属性（max?: number），文档钉死缺省 100 / 0..max / 取整口径 / 不渲染 description', () => {
    expect(contribSrc).toMatch(/max\?: number/)
    const doc = docAbove(contribSrc, 'max?: number')
    expect(doc).not.toBe('')
    expect(doc).toContain('缺省时按 100')
    expect(doc).toContain('0..max')
    expect(doc).toContain('{cur}/{max}')
    expect(doc).toContain('向下取整')
    expect(doc).toContain('未取整')
    expect(doc).toContain('不渲染')
    expect(doc).toContain('description')
    expect(doc).toContain('必须 > 0')
  })

  it('max 可缺省：不带 max 的 progress 字段合法（缺省视为 100）', () => {
    // satisfies：类型面若把 max 变成必填，IDE / 未来把 test 纳入 typecheck 时这里会红
    const withoutMax = {
      key: 'pet.hunger',
      label: '饥饿度',
      type: 'progress'
    } satisfies SettingField
    expect('max' in withoutMax).toBe(false)
    expect(checkSettingField({ ...withoutMax })).toEqual([])
    const withMax = { ...withoutMax, max: 100 } satisfies SettingField
    expect(checkSettingField({ ...withMax })).toEqual([])
  })

  it('负向：max ≤ 0 / 非数字、type 非联合值 → 契约镜像拒绝', () => {
    const base = { key: 'pet.mood', label: '心情', type: 'progress', max: 100 }
    expect(checkSettingField({ ...base, max: 0 }).some((p) => p.includes('max'))).toBe(true)
    expect(checkSettingField({ ...base, max: -5 }).some((p) => p.includes('max'))).toBe(true)
    expect(checkSettingField({ ...base, max: '100' }).some((p) => p.includes('max'))).toBe(true)
    expect(checkSettingField({ ...base, type: 'gauge' }).some((p) => p.includes('type'))).toBe(true)
  })
})

describe('负向 · overlay 非法请求被契约镜像拒绝（不改任何实现）', () => {
  // 设计 D-1 的真实参数集：宠物扩展右下角 220×460 透明置顶窗体
  const petOverlay = {
    id: 'pet.overlay',
    url: 'app://extensions/pet/overlay.html',
    width: 220,
    height: 460,
    anchor: 'bottom-right',
    margin: 24,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true
  } satisfies CreateOverlayRequest

  it('合法请求（设计 D-1 的真实形状）→ 通过', () => {
    expect(checkOverlayRequest({ ...petOverlay })).toEqual([])
  })

  it('缺 id / 缺 url（必填属性）→ 拒绝', () => {
    const noId: Record<string, unknown> = { ...petOverlay }
    delete noId.id
    expect(checkOverlayRequest(noId).some((p) => p.includes('id'))).toBe(true)
    const noUrl: Record<string, unknown> = { ...petOverlay }
    delete noUrl.url
    expect(checkOverlayRequest(noUrl).some((p) => p.includes('url'))).toBe(true)
  })

  it('anchor 非枚举值（bottom-center）→ 拒绝', () => {
    const problems = checkOverlayRequest({ ...petOverlay, anchor: 'bottom-center' })
    expect(problems.some((p) => p.includes('anchor'))).toBe(true)
  })

  it('width ≤ 0 / height ≤ 0 / margin < 0 → 拒绝', () => {
    expect(checkOverlayRequest({ ...petOverlay, width: 0 }).some((p) => p.includes('width'))).toBe(
      true
    )
    expect(
      checkOverlayRequest({ ...petOverlay, width: -220 }).some((p) => p.includes('width'))
    ).toBe(true)
    expect(
      checkOverlayRequest({ ...petOverlay, height: -460 }).some((p) => p.includes('height'))
    ).toBe(true)
    expect(
      checkOverlayRequest({ ...petOverlay, margin: -24 }).some((p) => p.includes('margin'))
    ).toBe(true)
  })

  it('未知属性（opacity）→ 拒绝（对象字面量只能指定已知属性，镜像同口径）', () => {
    expect(
      checkOverlayRequest({ ...petOverlay, opacity: 0.5 }).some((p) => p.includes('opacity'))
    ).toBe(true)
  })
})

describe('apiVersion 递增 · 单源与门槛', () => {
  // 直接按文本解析根 package.json（顺带钉住它是合法 JSON）
  const pkg = JSON.parse(read('../package.json')) as { apiVersion: number }

  function errors(raw: unknown): string[] {
    return validateManifest(raw)
      .filter((m) => m.severity === 'error')
      .map((m) => m.message)
  }

  const valid = { name: 'pet', version: '1.0.0', main: './index.js' }

  it('根 package.json 的 apiVersion === 2（整数；新增 overlay + progress 扩展面 API）', () => {
    expect(pkg.apiVersion).toBe(2)
    expect(Number.isInteger(pkg.apiVersion)).toBe(true)
  })

  it('core/manifest.ts 门槛读取的是根 package.json 的同名字段（单源，防改错字段）', () => {
    const src = read('../src/renderer/src/core/manifest.ts')
    expect(src).toContain(`import oboxPackage from '../../../../package.json'`)
    expect(src).toContain('oboxPackage.apiVersion')
    // 功能性再钉一遍：门槛报错文案里的"当前 obox 为 vN"就是 package.json 的 apiVersion
    expect(errors({ ...valid, apiVersion: pkg.apiVersion + 1 })).toEqual([
      `需要 obox API v${pkg.apiVersion + 1} 或更高（当前 obox 为 v${pkg.apiVersion}）`
    ])
  })

  it('声明 apiVersion 2 的 manifest（如 pet 将声明的）→ 通过；声明 1 的既有扩展（rdp/webapp/obox-updater）→ 仍通过', () => {
    expect(errors({ ...valid, apiVersion: 2 })).toEqual([])
    expect(errors({ ...valid, apiVersion: 1 })).toEqual([])
    expect(errors({ ...valid, apiVersion: 0 })).toEqual([])
    expect(errors(valid)).toEqual([]) // 缺失视为 0（兼容所有）
  })

  it('负向：apiVersion 高于宿主 / 字符串 / 负数 / 非整数 → 门槛拒绝', () => {
    // 字面断言钉死"当前宿主为 v2"（未来递增 apiVersion 时须同步更新本用例）
    expect(errors({ ...valid, apiVersion: 3 })).toEqual([
      '需要 obox API v3 或更高（当前 obox 为 v2）'
    ])
    expect(errors({ ...valid, apiVersion: '2' })).toEqual(['apiVersion 必须是大于等于 0 的整数'])
    expect(errors({ ...valid, apiVersion: -1 })).toEqual(['apiVersion 必须是大于等于 0 的整数'])
    expect(errors({ ...valid, apiVersion: 1.5 })).toEqual(['apiVersion 必须是大于等于 0 的整数'])
  })
})
