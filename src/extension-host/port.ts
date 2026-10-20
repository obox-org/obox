/**
 * 宿主进程的**端口抽象**：把「怎么收发」与「收发什么」隔开。
 *
 * 生产环境只有一条真实链路：Electron `utilityProcess` 的 `process.parentPort`
 * （`on('message')` + `postMessage`，见 ADR-0026 决策 2）。但宿主侧运行时（`runtime.ts`）、
 * RPC（`rpc.ts`）与能力工厂（`apiFactory.ts`）都不该直接摸 `process.parentPort`：
 * - 单测要能注入假端口，否则每个用例都得真起一个 utilityProcess（`test/extension-host-runtime.test.ts` 就是这么做的）；
 * - A2 之后可能还要把 renderer 侧的 `MessagePort` 接进来，端口来源会变，而「一条消息 = 一个信封」的语义不变。
 *
 * 因此这里只定义**最小接口**：`post`（发一条消息）+ `subscribe`（收消息，返回退订函数）。
 * 本文件刻意不 import electron / shared 协议，保持它能在任何上下文（含单测）里被引用。
 *
 * ## 两条端口（ADR-0026 的 `host-main` / `host-renderer`）
 *
 * `parentPort` 只承载 `host-main`；`host-renderer` 的那条 `MessagePort` **不是构造参数**——main 在
 * `onReady()` 里把它随 `init` 信封的 transfer 列表交过来（`MessageEvent.ports[0]`），所以它只能从
 * 消息事件上取。{@link createHostPortsFromParentPort} 是**唯一取处**：它在 `subscribe` 的适配层
 * 顺手取一次，之后由 `runtime.ts` 透传给能力工厂（EH-B3b-1）。
 *
 * **历史缺陷（EH-B3b-1 修的就是它）**：上一个版本的 `createHostPortFromParentPort` 只取
 * `event.data`、把 `event.ports` 整个丢掉，于是宿主**从来没有**拿到渲染侧端口——`host-renderer`
 * 两个方向都是死的（渲染侧 `bridge.request()` 只能超时）。为什么一直没被发现：A2/A4 各自只测
 * 自己那一侧（启动器断言"端口被 transfer 出去"，渲染侧用假端口），**没有一条测试跨过这条缝**。
 * 现在 `test/extension-host-ui-plane.test.ts` 有一组**接缝测试**专门盯它：喂真实 `MessageEvent`
 * 形状（`{ data: init, ports: [port] }`）→ 断言端口被取出并真的能 `postMessage`。
 */

/** 宿主进程与外界的消息端口（一条 message 就是一个信封，见 `extensionHostProtocol.ts` 文件头） */
export interface HostPort {
  /** 向对端发一条消息（信封对象；不自己分帧） */
  post(message: unknown): void
  /** 订阅对端消息；返回退订函数（重复退订必须无副作用） */
  subscribe(listener: (message: unknown) => void): () => void
}

/**
 * Electron `process.parentPort` 的**结构子集**。
 *
 * 刻意不写 `import type { ParentPort } from 'electron'`：宿主入口不得依赖 Electron 的
 * main-only 类型面（那会把 `app` / `BrowserWindow` 一类符号带进宿主进程的类型上下文）。
 * 只声明本文件真正用到的三个成员，Electron 的 `ParentPort` 天然满足（结构类型）。
 */
export interface ParentPortLike {
  /** 发消息给父进程（main） */
  postMessage(message: unknown): void
  /** 订阅父进程消息（Electron 传的是 `MessageEvent`，`data` 才是信封） */
  on(event: 'message', listener: (event: unknown) => void): unknown
  /** 退订（Electron 提供；缺失时退订退化为空操作） */
  off?(event: 'message', listener: (event: unknown) => void): unknown
}

/**
 * 取出 `MessageEvent.data`；对「直接吐信封」的端口实现保持宽容。
 *
 * 为什么要兼容两种形状：Electron 的 `parentPort` 给的是 `MessageEvent`（信封在 `data` 里），
 * 而单测/未来 MessagePort 封装可能直接给信封。判据只认「非 null 对象且自身带 `data`」，
 * 不用 `instanceof MessageEvent`（宿主里没有 DOM 的 MessageEvent 构造器）。
 */
export function unwrapParentPortMessage(event: unknown): unknown {
  if (typeof event === 'object' && event !== null && 'data' in event) {
    return (event as { data: unknown }).data
  }
  return event
}

/* -------------------------------------------------------------------------------------------- */
/* host-renderer 端口（MessageEvent.ports[0]）                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * 宿主手里的 `host-renderer` 端口（`MessageChannelMain` 的 port1）的结构子集。
 *
 * 刻意不写 `import type { MessagePort } from 'electron'`：宿主入口不依赖 Electron 类型面
 * （与 {@link ParentPortLike} 同一理由）。只用它真正需要的四个成员：
 * - `postMessage`：把 `event` 信封发给渲染侧；
 * - `onmessage`：收渲染侧消息（**赋值即隐式 `start()`**，HTML MessagePort 语义；在那之前消息排队，
 *   所以在拿到端口后立刻挂上不会丢消息）；
 * - `start` / `close`：可选（部分实现/假件不一定有）。
 */
export interface HostRendererPortLike {
  /** 向渲染进程发一条消息（信封；不分帧） */
  postMessage(message: unknown): void
  /** 收渲染进程消息；`undefined`/`null` = 不接（继续排队） */
  onmessage: ((event: unknown) => void) | null
  /** 显式启动派发（挂了 `onmessage` 时不必再调） */
  start?(): void
  /** 关闭端口（宿主退出时；对端会收到 close 事件） */
  close?(): void
}

/**
 * 两条端口的合并视图。
 *
 * `renderer` 用 getter：port1 **随 `init` 才到达**，构造那一刻还没有；调用方（`runtime.ts` 的
 * `rendererPort: () => ports.renderer`）惰性读，读到的就是"当前到没到"。
 */
export interface HostPorts {
  /** 宿主 ↔ main（`process.parentPort`） */
  main: HostPort
  /** 宿主 ↔ 渲染进程（`init` 到达前为 `null`） */
  readonly renderer: HostRendererPortLike | null
}

/** 未知值是否像一条 MessagePort（有 `postMessage` 函数即可；structured clone 来的端口没有原型保证） */
export function isHostRendererPortLike(value: unknown): value is HostRendererPortLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { postMessage?: unknown }).postMessage === 'function'
  )
}

/**
 * 从端口消息事件里取 `host-renderer` 的 port1（**纯函数**；接缝测试直接喂真实 `MessageEvent` 形状）。
 *
 * 判据只有两条：`event.ports` 是数组、其中某个元素长得像 MessagePort。形状不对返回 `null`
 * 而不是抛错——「这条消息没带端口」是常态（`host-main` 上的其它信封都不带）。
 */
export function firstRendererPortOf(event: unknown): HostRendererPortLike | null {
  if (typeof event !== 'object' || event === null) return null
  const ports = (event as { ports?: unknown }).ports
  if (!Array.isArray(ports)) return null
  for (const candidate of ports) {
    if (isHostRendererPortLike(candidate)) return candidate
  }
  return null
}

/**
 * 把 `process.parentPort` 适配成 {@link HostPorts}：主端口 + **在收消息时顺手捕获**的渲染侧端口。
 *
 * 捕获时机：main 用 `postToHost(initEnvelope, [port1])` 发出 `init`，Electron 把它还原成
 * `{ data: init, ports: [port1] }` 派发给 `parentPort` 的监听者。这里在同一个监听器里先取端口、
 * 再把 `data` 交给上层——**先取**是有意的：`init` 的处理（`runtime.handleInit`）会同步建加载器并
 * 启动激活，端口必须在那一刻之前就已经可取。
 *
 * 幂等：只取第一次（之后的消息不带端口）；后续消息不影响已捕获的端口。
 */
export function createHostPortsFromParentPort(parentPort: ParentPortLike): HostPorts {
  let renderer: HostRendererPortLike | null = null
  return {
    main: {
      post(message: unknown): void {
        parentPort.postMessage(message)
      },
      subscribe(listener: (message: unknown) => void): () => void {
        const handler = (event: unknown): void => {
          if (renderer === null) {
            const port = firstRendererPortOf(event)
            if (port) renderer = port
          }
          listener(unwrapParentPortMessage(event))
        }
        parentPort.on('message', handler)
        return (): void => {
          parentPort.off?.('message', handler)
        }
      }
    },
    get renderer(): HostRendererPortLike | null {
      return renderer
    }
  }
}

/**
 * 只要主端口时的薄包装（EH-A3 起的既有签名，单测与"没有渲染侧端口"的场景继续用它）。
 *
 * 注意：**它也会捕获渲染侧端口**（走的是同一个 {@link createHostPortsFromParentPort}），只是
 * 拿不到那个句柄——需要 `host-renderer` 的地方请直接用 `createHostPortsFromParentPort`。
 */
export function createHostPortFromParentPort(parentPort: ParentPortLike): HostPort {
  return createHostPortsFromParentPort(parentPort).main
}
