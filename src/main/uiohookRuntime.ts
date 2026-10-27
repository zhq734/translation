/**
 * uiohook-napi 安全加载层。
 *
 * 该模块包含原生二进制，某些旧系统或缺少运行库的环境可能加载失败。
 * 这里使用动态 require 隔离异常，保证应用主体仍可启动，同时让依赖调用明确失败。
 *
 * @author zhenghq
 */
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

/** uiohook 可注册的输入事件。 */
export type UiohookRuntimeEvent = 'mousedown' | 'mouseup' | 'keydown'

/** 应用使用的最小全局钩子接口。 */
export interface UiohookRuntime {
  on(event: UiohookRuntimeEvent, listener: (...args: any[]) => void): unknown
  off(event: UiohookRuntimeEvent, listener: (...args: any[]) => void): unknown
  start(): void
  stop(): void
  keyTap(key: number, modifiers?: number[]): void
  keyToggle(key: number, toggle: 'down' | 'up'): void
}

/** uiohook 键码表；保持与原生包公开值一致，加载失败时仍可用于类型与展示。 */
export const UiohookKey = {
  A: 30,
  C: 46,
  V: 47,
  Ctrl: 29,
  CtrlRight: 3613,
  Alt: 56,
  AltRight: 3640,
  Shift: 42,
  ShiftRight: 54,
  Meta: 3675,
  MetaRight: 3676
} as const

/** 原生钩子不可用时的错误文本。 */
export const UIOHOOK_UNAVAILABLE_MESSAGE = 'uiohook-napi is unavailable in this runtime'

/**
 * 创建原生钩子加载失败时的安全替身。
 * @returns 生命周期调用不抛错、输入注入明确失败的钩子对象。
 * @author zhenghq
 */
function createFallbackUiohook(): UiohookRuntime {
  const emitter = new EventEmitter()
  return {
    on(event, listener) {
      emitter.on(event, listener)
      return this
    },
    off(event, listener) {
      emitter.off(event, listener)
      return this
    },
    start() {
      throw new Error(UIOHOOK_UNAVAILABLE_MESSAGE)
    },
    stop() {
      // 未启动的替身无需释放资源。
    },
    keyTap() {
      throw new Error(UIOHOOK_UNAVAILABLE_MESSAGE)
    },
    keyToggle() {
      throw new Error(UIOHOOK_UNAVAILABLE_MESSAGE)
    }
  }
}

/**
 * 尝试加载原生 uiohook 模块。
 * @returns 原生钩子；加载失败时返回安全替身。
 * @author zhenghq
 */
function loadUiohook(): UiohookRuntime {
  try {
    const require = createRequire(import.meta.url)
    const loaded = require('uiohook-napi') as { uIOhook?: UiohookRuntime }
    return loaded.uIOhook ?? createFallbackUiohook()
  } catch (error) {
    console.warn(
      '[uiohook] 原生全局钩子加载失败，划词监听与复制注入将不可用:',
      error instanceof Error ? error.message : error
    )
    return createFallbackUiohook()
  }
}

/** 当前进程共享的全局钩子实例。 */
export const uIOhook = loadUiohook()
