/**
 * 宿主内置的 HTTP 指令面（随机端口 + 令牌鉴权）。
 *
 * 设计要点见 `../shared/httpCommand.ts` 的模块注释：只绑回环、端口交给系统分配、
 * 令牌写进 `<userData>/http-endpoint.json`、指令名 `<extId>:<name>`。
 *
 * 为什么服务器放在**主进程**而不是扩展宿主：
 * - 生命周期跟着应用走（扩展宿主可能崩溃重启，端口不能跟着换）；
 * - 调用方是外部程序，主进程是唯一的"稳定入口"；
 * - 指令最终由扩展处理：主进程把请求转发给**主窗口渲染进程**，渲染侧按 `extId` 找 handler
 *   （宿主模式再经 `ui.httpCommand` 转到扩展宿主），与 `extension:message` 同一条思路。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HTTP_COMMAND_TIMEOUT_MS,
  HTTP_ENDPOINT_FILE,
  HTTP_MAX_BODY_BYTES,
  type HttpCommandResult,
  type HttpEndpointInfo,
  parseHttpCommandName
} from '../shared/httpCommand'

export interface HttpCommandServerOptions {
  /** userData 目录（端点文件写在这里） */
  userDataDir: string
  /** 应用版本（写进端点文件，便于外部脚本判断协议） */
  version: string
  /** 已注册的指令名（`GET /commands` 返回它） */
  listCommands: () => string[]
  /** 把一条指令交给扩展处理；实现方负责超时与错误归一 */
  dispatch: (command: string, payload: unknown) => Promise<HttpCommandResult>
  /** 令牌（测试可注入固定值；生产用随机） */
  token?: string
  /** 监听端口（默认 0 = 系统分配） */
  port?: number
  /** 日志出口（默认 console） */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface HttpCommandServerHandle {
  readonly info: HttpEndpointInfo
  close(): Promise<void>
}

/** 统一 JSON 响应（含 no-store，避免代理/浏览器缓存控制面） */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  })
  res.end(text)
}

/** 读取请求体（带上限；超限直接销毁连接，不把宿主内存吃满） */
function readBody(req: IncomingMessage, limit: number): Promise<string | { error: string }> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve({ error: `请求体超过 ${limit} 字节上限` })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => resolve({ error: `读取请求体失败：${String(error)}` }))
  })
}

/**
 * 启动 HTTP 指令面。返回实际端口与令牌；`close()` 幂等。
 *
 * 失败姿态：监听失败（极罕见，回环地址 + 端口 0）直接 reject，由调用方决定是否降级为"无 HTTP 面"。
 */
export async function startHttpCommandServer(
  options: HttpCommandServerOptions
): Promise<HttpCommandServerHandle> {
  const log = options.log ?? ((): void => undefined)
  const token = options.token ?? randomBytes(16).toString('hex')

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/\/+$/, '') || '/'

      // 只允许本机回环连接（listen 已绑 127.0.0.1；这里再挡一层误配置）
      const remote = req.socket.remoteAddress ?? ''
      if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
        sendJson(res, 403, { ok: false, error: '只允许本机访问' })
        return
      }

      if (path === '/health') {
        sendJson(res, 200, { ok: true, app: 'obox', version: options.version })
        return
      }

      if (req.headers['x-obox-token'] !== token) {
        sendJson(res, 401, { ok: false, error: '缺少或错误的 x-obox-token' })
        return
      }

      if (path === '/commands' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, commands: options.listCommands() })
        return
      }

      if (path === '/command' && req.method === 'POST') {
        const raw = await readBody(req, HTTP_MAX_BODY_BYTES)
        if (typeof raw !== 'string') {
          sendJson(res, 413, { ok: false, error: raw.error })
          return
        }
        let body: unknown
        try {
          body = raw.trim() === '' ? {} : JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const record = (typeof body === 'object' && body !== null ? body : {}) as {
          command?: unknown
          payload?: unknown
        }
        const parsed = parseHttpCommandName(
          typeof record.command === 'string' ? record.command : ''
        )
        if ('error' in parsed) {
          sendJson(res, 400, { ok: false, error: parsed.error })
          return
        }
        try {
          const result = await options.dispatch(
            typeof record.command === 'string' ? record.command : '',
            record.payload ?? null
          )
          sendJson(res, result.ok ? 200 : 500, result)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: `指令执行异常：${String(error)}` })
        }
        return
      }

      sendJson(res, 404, {
        ok: false,
        error: `未知路径 ${path}（可用：GET /health、GET /commands、POST /command）`
      })
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const info: HttpEndpointInfo = {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    version: options.version,
    updatedAt: new Date().toISOString()
  }

  // 端点文件：外部程序的唯一发现入口。写失败不致命（服务已经能用，只是不好发现）
  try {
    await writeFile(
      join(options.userDataDir, HTTP_ENDPOINT_FILE),
      JSON.stringify(info, null, 2),
      'utf8'
    )
  } catch (error) {
    log('warn', `写端点文件失败（HTTP 面仍可用）：${String(error)}`)
  }
  log('info', `HTTP 指令面已启动：${info.url}（令牌见 ${HTTP_ENDPOINT_FILE}）`)

  let closed = false
  return {
    info,
    close: async (): Promise<void> => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** 指令默认超时（与扩展 handler 的预算一致；导出给测试断言） */
export { HTTP_COMMAND_TIMEOUT_MS }
