/**
 * EH-A2 的**假宿主入口**（fixture）：只验证「启动器能否拉起一个真实宿主并走完握手」，**不依赖 EH-A3**。
 *
 * 行为（与 `src/shared/extensionHostProtocol.ts` 的信封形状一致）：
 * 1. 起来立刻发 `ready`（带 `hostId` 与 `pid`）；
 * 2. 收到 `init` 后回 `initialized`（`init` 会随 transfer 列表带来 host-renderer 的 port1，
 *    这里只把它 `start()` 起来——fixture 不消费端口，但要证明"端口确实到了宿主手里"）；
 * 3. 收到 `terminate` 后退出（退出码 0）；
 * 4. 收到 `req`（如 `host.ping`）回 `res`，让判活不会被误判成无响应。
 *
 * 协议版本故意写成字面量 `1`（= EH-A1 的 `PROTOCOL_VERSION`）：`.mjs` 不能 import TS 模块，
 * 而这里要能被 `utilityProcess.fork()` 直接拉起（单测会 `node --check` 它）。升协议版本时同步改
 * 这一行即可。生产用的真宿主入口是 EH-A3 的 `src/extension-host/index.ts`，与本文件无关。
 */
const parentPort = process.parentPort

if (!parentPort) {
  // 不在 utilityProcess 里（例如被 node 直接执行）：直接退出，避免挂住调用方
  process.exit(0)
}

/** 握手/判活要用到的那几个字段，其余一律忽略（fixture 不需要完整协议实现） */
const protocolVersion = 1

parentPort.postMessage({ v: protocolVersion, t: 'ready', hostId: 'fixture-host', pid: process.pid })

parentPort.on('message', (event) => {
  // `event.ports` 是随信封转移过来的端口（init 带 host-renderer 的 port1）
  for (const port of event.ports ?? []) {
    // MessagePort 在 start() 之前消息是排队的，必须显式启动
    port.start()
  }

  const envelope = event.data
  if (!envelope || typeof envelope !== 'object') return

  switch (envelope.t) {
    case 'init':
      parentPort.postMessage({ v: protocolVersion, t: 'initialized' })
      return
    case 'req':
      // 任何 req 都回 null：足够让 host.ping 判活通过
      parentPort.postMessage({ v: protocolVersion, t: 'res', id: envelope.id, result: null })
      return
    case 'terminate':
      process.exit(0)
      return
    default:
      return
  }
})
