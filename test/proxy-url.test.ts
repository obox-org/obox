/**
 * 代理 **单一 URL（A 方案）** 的解析 / 规则串派生 / 凭据提取 / 旧形态迁移矩阵。
 *
 * 覆盖：
 * - `parseProxyUrl`：http / https / socks4 / socks5、带凭据（含百分号编码）、缺端口（按协议补全）、
 *   非法输入（缺协议、协议不支持、带路径、端口越界、编码非法）与空串（= 直连，不是错误）
 * - `proxyRulesOf`：Chromium 规则串派生；**凭据绝不进规则串**（Chromium 语法没有 userinfo 位）
 * - `proxyCredentialsOf`：从 URL 的 `user:pass@` 取凭据（updater 的 `login` 事件用）
 * - 旧形态（`{enabled,host,port,username,password,...}`）**自动迁移**成 URL，且 `ignoreSSL` / `noProxy` 不丢
 * - `applyProxyToSession`：容忍旧形态入参、`noProxy` → `proxyBypassRules`、`ignoreSSL` → 放行证书
 */
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { Session } from 'electron'
import { normalizeProxyConfig, type ProxyConfigInput } from '../src/shared/proxyConfig'
import {
  applyProxyToSession,
  currentProxy,
  currentProxyCredentials,
  parseProxyUrl,
  proxyConfigError,
  proxyCredentialsOf,
  proxyRulesOf
} from '../src/main/proxy'

// proxy.ts 顶层 `import { session } from 'electron'`：单测只碰纯函数与传入的假 session
vi.mock('electron', () => ({ session: { fromPartition: () => ({}) } }))

interface SetProxyCall {
  proxyRules?: string
  proxyBypassRules?: string
  mode?: string
}

/** 假 session：记录 setProxy / setCertificateVerifyProc / closeAllConnections 的调用
 *  （每个用例一个，避开指纹去重的 WeakMap）。`setProxy` 返回 Promise，与 Electron 真实 API 一致
 *  ——生产代码会在 `setProxy` 之后 `.then(() => closeAllConnections())`。 */
function fakeSession(): {
  ses: Session
  setProxyCalls: SetProxyCall[]
  certProcs: unknown[]
  closeAllCalls: number[]
} {
  const setProxyCalls: SetProxyCall[] = []
  const certProcs: unknown[] = []
  const closeAllCalls: number[] = []
  const ses = {
    setProxy: async (opts: SetProxyCall) => {
      setProxyCalls.push(opts)
    },
    setCertificateVerifyProc: (proc: unknown) => {
      certProcs.push(proc)
    },
    closeAllConnections: () => {
      closeAllCalls.push(1)
    }
  } as unknown as Session
  return { ses, setProxyCalls, certProcs, closeAllCalls }
}

/**
 * 换代理后必须关闭既有连接：Chromium 会复用连接池里的旧连接，否则"刚开启代理"期间已池化的
 * 直连仍会被继续使用（实测：同一进程内把代理切到打不通的端口，更新源解析照样成功；重启进程后
 * 同一配置立刻 `net::ERR_PROXY_CONNECTION_FAILED`）。
 */
test('换代理（或切回直连）后会关闭既有连接', async () => {
  const viaProxy = fakeSession()
  applyProxyToSession(viaProxy.ses, { enabled: true, url: 'http://127.0.0.1:7890', noProxy: [] })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(viaProxy.setProxyCalls.length, 1)
  assert.equal(viaProxy.closeAllCalls.length, 1, 'setProxy 之后必须 closeAllConnections')

  const direct = fakeSession()
  applyProxyToSession(direct.ses, { enabled: false, url: '', noProxy: [] })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(direct.setProxyCalls, [{ mode: 'direct' }])
  assert.equal(direct.closeAllCalls.length, 1, '切回直连同样要关闭旧连接')
})

describe('parseProxyUrl：解析矩阵', () => {
  test('http：主机 + 端口', () => {
    assert.deepEqual(parseProxyUrl('http://127.0.0.1:7890'), {
      direct: false,
      scheme: 'http',
      host: '127.0.0.1',
      port: 7890
    })
  })

  test('https：主机 + 端口', () => {
    assert.deepEqual(parseProxyUrl('https://proxy.example:8443'), {
      direct: false,
      scheme: 'https',
      host: 'proxy.example',
      port: 8443
    })
  })

  test('socks5 / socks4', () => {
    assert.deepEqual(parseProxyUrl('socks5://127.0.0.1:1080'), {
      direct: false,
      scheme: 'socks5',
      host: '127.0.0.1',
      port: 1080
    })
    assert.deepEqual(parseProxyUrl('socks4://127.0.0.1:1081'), {
      direct: false,
      scheme: 'socks4',
      host: '127.0.0.1',
      port: 1081
    })
  })

  test('URL 里的账号密码（含百分号编码，需解码）', () => {
    assert.deepEqual(parseProxyUrl('http://user:pass@host:1080'), {
      direct: false,
      scheme: 'http',
      host: 'host',
      port: 1080,
      username: 'user',
      password: 'pass'
    })
    // %40 = @、%3A = :、%2F = /：编码后仍能解析回原文（否则 URL 结构会被密码里的分隔符破坏）
    const encoded = parseProxyUrl('http://user%40corp:p%3Ass%2Fword@host:3128')
    assert.ok(!('error' in encoded) && !encoded.direct)
    assert.equal(encoded.username, 'user@corp')
    assert.equal(encoded.password, 'p:ss/word')
  })

  test('缺端口时按协议补缺省端口（http 80 / https 443 / socks 1080）', () => {
    const http = parseProxyUrl('http://127.0.0.1')
    const https = parseProxyUrl('https://proxy.example')
    const socks5 = parseProxyUrl('socks5://127.0.0.1')
    assert.ok(!('error' in http) && !http.direct)
    assert.equal(http.port, 80)
    assert.ok(!('error' in https) && !https.direct)
    assert.equal(https.port, 443)
    assert.ok(!('error' in socks5) && !socks5.direct)
    assert.equal(socks5.port, 1080)
  })

  test('空串与纯空白 = 直连（不是错误）', () => {
    assert.deepEqual(parseProxyUrl(''), { direct: true })
    assert.deepEqual(parseProxyUrl('   '), { direct: true })
    assert.deepEqual(parseProxyUrl(undefined), { direct: true })
  })

  test('缺协议前缀被拒（给出可读原因）', () => {
    const r = parseProxyUrl('127.0.0.1:7890')
    assert.ok('error' in r)
    assert.match(r.error, /无法解析/)
    assert.match(r.error, /协议/)
  })

  test('不支持的协议被拒（原因里列出支持的协议）', () => {
    const r = parseProxyUrl('ftp://proxy.example:21')
    assert.ok('error' in r)
    assert.match(r.error, /不支持的代理协议/)
    assert.match(r.error, /socks5/)
  })

  test('带路径 / 查询 / 片段被拒', () => {
    for (const bad of [
      'http://host:8080/path',
      'http://host:8080/?a=1',
      'http://host:8080/#frag'
    ]) {
      const r = parseProxyUrl(bad)
      assert.ok('error' in r, `${bad} 应被拒`)
      assert.match(r.error, /路径/)
    }
  })

  test('端口越界 / 非数字被拒', () => {
    for (const bad of ['http://host:99999', 'http://host:abc']) {
      const r = parseProxyUrl(bad)
      assert.ok('error' in r, `${bad} 应被拒`)
    }
  })

  test('userinfo 百分号编码非法被拒', () => {
    const r = parseProxyUrl('http://user:p%zz@host:8080')
    assert.ok('error' in r)
    assert.match(r.error, /编码非法/)
  })
})

describe('proxyRulesOf：Chromium 规则串派生', () => {
  test('http 代理 → http=<host>:<port>;https=<host>:<port>', () => {
    assert.equal(
      proxyRulesOf({ enabled: true, url: 'http://127.0.0.1:7890' }),
      'http=127.0.0.1:7890;https=127.0.0.1:7890'
    )
  })

  test('https 代理 → 同一个 host:port（https 请求走 CONNECT）', () => {
    assert.equal(
      proxyRulesOf({ enabled: true, url: 'https://proxy.example:8443' }),
      'http=proxy.example:8443;https=proxy.example:8443'
    )
  })

  test('缺端口时规则串用协议缺省端口（http 80 / https 443）', () => {
    assert.equal(
      proxyRulesOf({ enabled: true, url: 'http://127.0.0.1' }),
      'http=127.0.0.1:80;https=127.0.0.1:80'
    )
    assert.equal(
      proxyRulesOf({ enabled: true, url: 'https://proxy.example' }),
      'http=proxy.example:443;https=proxy.example:443'
    )
  })

  test('socks4 → socks=；socks5 → socks5=', () => {
    assert.equal(
      proxyRulesOf({ enabled: true, url: 'socks4://127.0.0.1:1080' }),
      'socks=127.0.0.1:1080'
    )
    assert.equal(
      proxyRulesOf({ enabled: true, url: 'socks5://127.0.0.1:1080' }),
      'socks5=127.0.0.1:1080'
    )
  })

  test('未启用 / 空 URL / 非法 URL → 空串（调用方据此走直连）', () => {
    assert.equal(proxyRulesOf({ enabled: false, url: 'http://127.0.0.1:7890' }), '')
    assert.equal(proxyRulesOf({ enabled: true, url: '' }), '')
    assert.equal(proxyRulesOf({ enabled: true, url: 'nonsense' }), '')
    assert.equal(proxyRulesOf(undefined), '')
  })

  test('凭据绝不进规则串（Chromium 规则语法没有 userinfo 位）', () => {
    const rules = proxyRulesOf({ enabled: true, url: 'http://alice:s3cret@127.0.0.1:3128' })
    assert.equal(rules, 'http=127.0.0.1:3128;https=127.0.0.1:3128')
    assert.ok(!rules.includes('alice'), '规则串不得含用户名')
    assert.ok(!rules.includes('s3cret'), '规则串不得含密码')
    assert.ok(!rules.includes('@'), '规则串不得含 userinfo 分隔符')
  })

  test('proxyConfigError：只有"启用了但地址非法"才给原因', () => {
    assert.match(
      proxyConfigError({ enabled: true, url: 'socks://127.0.0.1:1080' }) ?? '',
      /不支持的代理协议/
    )
    assert.equal(proxyConfigError({ enabled: true, url: 'http://127.0.0.1:7890' }), undefined)
    assert.equal(proxyConfigError({ enabled: false, url: 'nonsense' }), undefined)
    assert.equal(proxyConfigError({ enabled: true, url: '' }), undefined)
  })
})

describe('凭据提取（更新链路的 login 事件用）', () => {
  test('从 URL 的 user:pass@ 取凭据', () => {
    assert.deepEqual(proxyCredentialsOf({ enabled: true, url: 'http://u:p@host:1080' }), {
      username: 'u',
      password: 'p'
    })
  })

  test('编码的凭据被解码后回填', () => {
    assert.deepEqual(proxyCredentialsOf({ enabled: true, url: 'http://u%40c:p%3Ass@host:3128' }), {
      username: 'u@c',
      password: 'p:ss'
    })
  })

  test('只有用户名没有密码 → 密码补空串', () => {
    assert.deepEqual(proxyCredentialsOf({ enabled: true, url: 'http://u@host:3128' }), {
      username: 'u',
      password: ''
    })
  })

  test('无凭据 / 未启用 / 非法 URL → undefined（调用方取消认证）', () => {
    assert.equal(proxyCredentialsOf({ enabled: true, url: 'http://host:3128' }), undefined)
    assert.equal(proxyCredentialsOf({ enabled: false, url: 'http://u:p@host:3128' }), undefined)
    assert.equal(proxyCredentialsOf({ enabled: true, url: 'nonsense' }), undefined)
    assert.equal(proxyCredentialsOf(undefined), undefined)
  })

  test('旧形态（username/password）迁移后同样能取到凭据', () => {
    const legacy = {
      enabled: true,
      host: 'proxy.corp',
      port: 3128,
      username: 'alice',
      password: 'p@ss:word'
    }
    assert.equal(normalizeProxyConfig(legacy).url, 'http://alice:p%40ss%3Aword@proxy.corp:3128')
    assert.deepEqual(proxyCredentialsOf(legacy), { username: 'alice', password: 'p@ss:word' })
  })
})

describe('旧形态自动迁移（1.0.11 及更早的持久化值）', () => {
  test('legacy → http://[user:pass@]host[:port]', () => {
    assert.deepEqual(
      normalizeProxyConfig({
        enabled: true,
        host: '127.0.0.1',
        port: 7890,
        username: 'u',
        password: 'p',
        ignoreSSL: true,
        noProxy: ['localhost', '127.0.0.1']
      }),
      {
        enabled: true,
        url: 'http://u:p@127.0.0.1:7890',
        ignoreSSL: true,
        noProxy: ['localhost', '127.0.0.1']
      }
    )
  })

  test('无端口 / 无凭据的旧值：只拼协议与主机', () => {
    assert.deepEqual(normalizeProxyConfig({ enabled: true, host: 'proxy.corp' }), {
      enabled: true,
      url: 'http://proxy.corp',
      noProxy: []
    })
  })

  test('密码里的特殊字符被百分号编码（迁移不产生非法 URL）', () => {
    const url = normalizeProxyConfig({
      enabled: true,
      host: 'h',
      password: 'a@b/c',
      username: 'x'
    }).url
    assert.equal(url, 'http://x:a%40b%2Fc@h')
    const parsed = parseProxyUrl(url)
    assert.ok(!('error' in parsed) && !parsed.direct)
    assert.equal(parsed.password, 'a@b/c')
  })

  test('只有密码没有用户名时不迁移凭据（login 事件必须有用户名）', () => {
    assert.equal(normalizeProxyConfig({ enabled: true, host: 'h', password: 'p' }).url, 'http://h')
  })

  test('IPv6 字面量自动加方括号；越界端口被丢弃', () => {
    assert.equal(
      normalizeProxyConfig({ enabled: true, host: '::1', port: 8080 }).url,
      'http://[::1]:8080'
    )
    assert.equal(normalizeProxyConfig({ enabled: true, host: 'h', port: 99999 }).url, 'http://h')
  })

  test('新形态幂等（不会把 URL 当成 host 再迁移一次）', () => {
    const next = normalizeProxyConfig({
      enabled: true,
      url: 'socks5://127.0.0.1:1080',
      noProxy: ['a.com'],
      ignoreSSL: true
    })
    assert.deepEqual(next, {
      enabled: true,
      url: 'socks5://127.0.0.1:1080',
      ignoreSSL: true,
      noProxy: ['a.com']
    })
    assert.deepEqual(normalizeProxyConfig(next), next)
  })

  test('新旧字段同时存在时以 url 为准', () => {
    assert.equal(
      normalizeProxyConfig({
        enabled: true,
        url: 'http://new:8080',
        host: 'old',
        port: 1
      }).url,
      'http://new:8080'
    )
  })

  test('字段收敛：非 true 的 enabled 一律 false，noProxy 元素转字符串', () => {
    const junk = { enabled: 1, host: 5, port: 'x', noProxy: [1, 2] } as unknown as ProxyConfigInput
    assert.deepEqual(normalizeProxyConfig(junk), { enabled: false, url: '', noProxy: ['1', '2'] })
  })
})

describe('applyProxyToSession：容忍旧形态 + 通传 ignoreSSL / noProxy', () => {
  test('旧形态入参被内部迁移后应用（规则串是新形态派生的）', () => {
    const { ses, setProxyCalls } = fakeSession()
    applyProxyToSession(ses, { enabled: true, host: '127.0.0.1', port: 7890 })
    assert.deepEqual(setProxyCalls, [
      { proxyRules: 'http=127.0.0.1:7890;https=127.0.0.1:7890', proxyBypassRules: '' }
    ])
    assert.deepEqual(currentProxy(), { enabled: true, url: 'http://127.0.0.1:7890', noProxy: [] })
  })

  test('noProxy → proxyBypassRules；ignoreSSL → setCertificateVerifyProc 放行全部证书', () => {
    const { ses, setProxyCalls, certProcs } = fakeSession()
    applyProxyToSession(ses, {
      enabled: true,
      url: 'socks5://127.0.0.1:1080',
      noProxy: ['localhost', ' 127.0.0.1 ', ''],
      ignoreSSL: true
    })
    assert.deepEqual(setProxyCalls, [
      { proxyRules: 'socks5=127.0.0.1:1080', proxyBypassRules: 'localhost,127.0.0.1' }
    ])
    assert.equal(certProcs.length, 1)
    // 0 = 通过（不校验证书）
    const proc = certProcs[0] as (req: unknown, cb: (code: number) => void) => void
    let code = -1
    proc({}, (c) => (code = c))
    assert.equal(code, 0)
  })

  test('未启用 → mode:direct；关掉 ignoreSSL → 恢复默认证书校验（null）', () => {
    const { ses, setProxyCalls, certProcs } = fakeSession()
    applyProxyToSession(ses, { enabled: false, url: 'http://127.0.0.1:7890' })
    assert.deepEqual(setProxyCalls, [{ mode: 'direct' }])
    assert.deepEqual(certProcs, [null])
  })

  test('非法 URL → 直连并在诊断函数里给出可读原因（不静默假装代理生效）', () => {
    const { ses, setProxyCalls } = fakeSession()
    applyProxyToSession(ses, { enabled: true, url: '127.0.0.1:7890' })
    assert.deepEqual(setProxyCalls, [{ mode: 'direct' }])
    assert.match(proxyConfigError({ enabled: true, url: '127.0.0.1:7890' }) ?? '', /无法解析/)
  })

  test('currentProxyCredentials：供 updater 的 login 事件取 URL 里的凭据', () => {
    const { ses } = fakeSession()
    applyProxyToSession(ses, { enabled: true, url: 'http://u:p@127.0.0.1:3128' })
    assert.deepEqual(currentProxyCredentials(), { username: 'u', password: 'p' })
    applyProxyToSession(ses, { enabled: true, url: 'http://127.0.0.1:3128' })
    assert.equal(currentProxyCredentials(), undefined)
  })
})
