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

/** 把 Electron `process.parentPort` 适配成 `HostPort`（`off` 缺失时退订为空操作） */
export function createHostPortFromParentPort(parentPort: ParentPortLike): HostPort {
  return {
    post(message: unknown): void {
      parentPort.postMessage(message)
    },
    subscribe(listener: (message: unknown) => void): () => void {
      const handler = (event: unknown): void => {
        listener(unwrapParentPortMessage(event))
      }
      parentPort.on('message', handler)
      return (): void => {
        parentPort.off?.('message', handler)
      }
    }
  }
}
