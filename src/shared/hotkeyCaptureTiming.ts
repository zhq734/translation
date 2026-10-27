// Alt 类快捷键需要更长等待：Windows 会将按住的 Alt 识别为菜单助记符模式（SYSKEY），
// 注入的 Ctrl+C 会被前台应用吞掉导致取词超时，因此给用户松开修饰键留足余量。
const WINDOWS_HOTKEY_RELEASE_DELAY_MS = 300

/**
 * 解析全局快捷键触发后开始取词前的等待时间。
 * Windows 的全局快捷键回调在按键按下阶段触发，需要等待 Alt、Ctrl、Shift 或 Win 键释放，
 * 避免后续模拟 Ctrl+C 时被组合成 Ctrl+Alt+C 等错误快捷键。
 * @param platform 当前 Node.js 平台标识。
 * @returns Windows 返回修饰键释放等待时间，其他平台返回 0。
 * @author zhenghq
 */
export function resolveHotkeyCaptureDelay(platform: NodeJS.Platform): number {
  return platform === 'win32' ? WINDOWS_HOTKEY_RELEASE_DELAY_MS : 0
}

/** 触发翻译快捷键时可能被按住、需要在注入复制键前释放的修饰键。 */
export type HotkeyModifier = 'control' | 'alt' | 'shift' | 'meta'

/** 首次注入复制快捷键无响应后重投的等待时间（毫秒）。 */
export const COPY_INJECTION_RETRY_DELAY_MS = 160

/** 一次复制兜底允许的最大重投次数。 */
export const COPY_INJECTION_MAX_RETRIES = 1

/**
 * 从 Electron Accelerator 解析出触发时被物理按住的修饰键。
 * Windows 全局快捷键在按键按下阶段回调，注入 Ctrl+C 时这些修饰键仍处于按下状态，
 * 会被前台应用识别成 Ctrl+Alt+C 等错误组合，因此需要先显式释放它们。
 * @param accelerator Electron 快捷键描述，如 Alt+T、CommandOrControl+D。
 * @param platform 当前 Node.js 平台标识，用于区分 CommandOrControl 的实际含义。
 * @returns 去重后的修饰键列表，按 control、alt、shift、meta 顺序排列。
 * @author zhenghq
 */
export function resolveHotkeyModifiers(
  accelerator: string,
  platform: NodeJS.Platform
): HotkeyModifier[] {
  const found = new Set<HotkeyModifier>()
  for (const rawPart of accelerator.split('+')) {
    const part = rawPart.trim().toLowerCase()
    if (!part) continue
    if (part === 'control' || part === 'ctrl') found.add('control')
    else if (part === 'alt' || part === 'option' || part === 'altgr') found.add('alt')
    else if (part === 'shift') found.add('shift')
    else if (part === 'command' || part === 'cmd' || part === 'super' || part === 'meta') {
      found.add('meta')
    } else if (part === 'commandorcontrol' || part === 'cmdorctrl') {
      found.add(platform === 'darwin' ? 'meta' : 'control')
    }
  }

  const order: HotkeyModifier[] = ['control', 'alt', 'shift', 'meta']
  return order.filter((modifier) => found.has(modifier))
}

/**
 * 判断当前平台在注入复制快捷键前是否需要强制释放快捷键修饰键。
 * Windows 使用 SendInput 注入裸 Ctrl+C，会与仍按住的修饰键叠加；
 * macOS 的 CGEvent 注入自带修饰键标志，Linux 读取主选区，都不需要释放。
 * @param platform 当前 Node.js 平台标识。
 * @returns Windows 返回 true，其他平台返回 false。
 * @author zhenghq
 */
export function shouldReleaseHotkeyModifiersBeforeCopy(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

/**
 * 判断复制兜底轮询期间是否应重投一次复制快捷键。
 * 首次注入可能因修饰键仍被按住或前台应用尚未就绪而丢失，等待到重投间隔后再补发一次。
 * @param elapsedMs 本次复制兜底已经等待的时间（毫秒）。
 * @param attempts 已经注入复制快捷键的次数。
 * @param maxRetries 允许的最大重投次数，默认 COPY_INJECTION_MAX_RETRIES。
 * @returns 需要重投时返回 true。
 * @author zhenghq
 */
export function shouldRetryCopyInjection(
  elapsedMs: number,
  attempts: number,
  maxRetries = COPY_INJECTION_MAX_RETRIES
): boolean {
  if (attempts <= 0) return false
  if (attempts > maxRetries) return false
  return elapsedMs >= COPY_INJECTION_RETRY_DELAY_MS * attempts
}

/** 复制兜底首次轮询超时后允许的独立重试轮次上限。 */
export const COPY_FALLBACK_MAX_RETRIES = 1

/**
 * 复制兜底独立重试轮次的超时（毫秒）。
 *
 * 必须显著小于原轮询窗口（800ms），避免真正无选区时用户等待翻倍；
 * 真机 A/B 后可在 400–600ms 区间内微调，但不得突破硬上限。
 */
export const COPY_FALLBACK_RETRY_TIMEOUT_MS = 500

/** 复制兜底重试计划的输入状态。 */
export interface CopyRetryPlanInput {
  /** 已注入复制快捷键的总次数。 */
  attempts: number
  /** 已完成的独立重试轮次数。 */
  retries: number
  /** 本次取词从开始到首次轮询结束的耗时（毫秒）。 */
  elapsedMs: number
  /** 首次轮询窗口时长（毫秒）。 */
  timeoutMs: number
  /** 取词是否已被中止。 */
  aborted: boolean
  /** 取词期间是否观测到用户主动复制。 */
  externalCopyObserved: boolean
}

/** 复制兜底重试计划。 */
export interface CopyRetryPlan {
  /** 是否应进入一次独立重试轮次。 */
  retry: boolean
  /** 重试轮次使用的独立超时（毫秒）；不重试时为 0。 */
  retryTimeoutMs: number
}

/**
 * 解析复制兜底首次轮询超时后的重试计划。
 *
 * 仅在首次轮询确实超时、未中止、未观测到用户主动复制且重试次数未耗尽时，
 * 允许追加一次带独立超时的重试轮次，避免无限重试与覆盖用户剪贴板。
 * @param input 当前取词状态。
 * @returns 重试计划；不满足重试条件时 retry 为 false。
 * @author zhenghq
 */
export function resolveCopyRetryPlan(input: CopyRetryPlanInput): CopyRetryPlan {
  if (input.aborted) return { retry: false, retryTimeoutMs: 0 }
  if (input.externalCopyObserved) return { retry: false, retryTimeoutMs: 0 }
  // 一次复制键都没成功注入时不重试：没有可重试的轮次，重试只会白等。
  if (input.attempts <= 0) return { retry: false, retryTimeoutMs: 0 }
  if (input.retries >= COPY_FALLBACK_MAX_RETRIES) return { retry: false, retryTimeoutMs: 0 }
  if (input.elapsedMs < input.timeoutMs) return { retry: false, retryTimeoutMs: 0 }
  return { retry: true, retryTimeoutMs: COPY_FALLBACK_RETRY_TIMEOUT_MS }
}
