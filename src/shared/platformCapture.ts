export type SelectionCaptureStrategy =
  | 'macos-command-copy'
  | 'windows-control-copy'
  | 'linux-primary-selection'
  | 'unsupported'

/** 各平台原生直读选中文字的能力标识。 */
export type NativeSelectionReadKind =
  | 'macos-accessibility'
  | 'windows-uia'
  | 'linux-primary-selection'
  | 'unsupported'

/** 一次原生直读选区操作的规范化结果。 */
export interface NativeSelectionReadResult {
  /** 直读状态：present 表示读到文本，empty 表示确认无选区，unknown 表示无法确认。 */
  status: 'present' | 'empty' | 'unknown'
  /** 直读到的选中文字，仅在 status 为 present 时非空。 */
  text: string
  /** 直读失败的具体原因，unknown 状态时可用于区分权限、超时或接口不可用。 */
  reason?: string
  /** 窗口定位结果；仅 macOS 窗口感知读取提供。 */
  windowLocate?: 'exact' | 'app-fallback' | 'failed'
  /** 目标应用普通窗口数量；无法枚举时缺失。 */
  windowCount?: number
  /** 是否按窗口编号或边界精确匹配到目标窗口。 */
  windowMatched?: boolean
}

/** 从 macOS AX helper stderr 中解析出的脱敏窗口诊断。 */
export type MacosAxReaderWindowDiagnostic = Pick<
  NativeSelectionReadResult,
  'windowLocate' | 'windowCount' | 'windowMatched'
>

/**
 * 解析 macOS AX helper 写入 stderr 的固定窗口诊断行。
 *
 * 仅接受 `WINDOW exact|fallback|failed count=<非负整数>` 这一种格式，
 * 其他行（包括可能误写入的标题或选区文本）一律忽略，确保诊断字段始终
 * 来自白名单而不是自由文本。
 * @param stderr helper 的标准错误输出，可为 Buffer、字符串或未知值。
 * @returns 解析出的窗口定位字段；没有合法诊断行时返回空对象。
 * @author zhenghq
 */
export function parseMacosAxReaderWindowDiagnostic(
  stderr: unknown
): MacosAxReaderWindowDiagnostic {
  const text = Buffer.isBuffer(stderr)
    ? stderr.toString('utf8')
    : typeof stderr === 'string'
      ? stderr
      : ''
  const match = text.match(/(?:^|\n)\s*WINDOW\s+(exact|fallback|failed)\s+count=(\d+)\s*(?:\n|$)/u)
  if (!match) return {}
  const count = Number.parseInt(match[2], 10)
  if (!Number.isSafeInteger(count) || count < 0) return {}
  if (match[1] === 'exact') {
    return { windowLocate: 'exact', windowCount: count, windowMatched: true }
  }
  if (match[1] === 'fallback') {
    return { windowLocate: 'app-fallback', windowCount: count, windowMatched: false }
  }
  return { windowLocate: 'failed', windowCount: count, windowMatched: false }
}

/** 当前平台可用的选区取词能力组合。 */
export interface SelectionCapturePlan {
  /** 原生直读能力标识。 */
  nativeRead: NativeSelectionReadKind
  /** 是否支持原生直读选区（不触碰剪贴板）。 */
  supportsNativeRead: boolean
  /** 是否支持模拟复制兜底（macOS/Windows 注入复制键）。 */
  copyFallback: boolean
}

/**
 * 根据操作系统选择全局取词实现，避免在非 macOS 平台调用 macOS 专属脚本。
 * @param platform Node.js 提供的操作系统平台标识。
 * @returns 当前平台对应的取词策略。
 * @author zhenghq
 */
export function resolveSelectionCaptureStrategy(
  platform: NodeJS.Platform
): SelectionCaptureStrategy {
  if (platform === 'darwin') return 'macos-command-copy'
  if (platform === 'win32') return 'windows-control-copy'
  if (platform === 'linux') return 'linux-primary-selection'
  return 'unsupported'
}

/**
 * 返回当前平台的原生直读与复制兜底能力组合，供取词管线决定取词顺序。
 * @param platform Node.js 提供的操作系统平台标识。
 * @returns 当前平台的取词能力计划。
 * @author zhenghq
 */
export function getSelectionCapturePlan(
  platform: NodeJS.Platform
): SelectionCapturePlan {
  if (platform === 'darwin') {
    return {
      nativeRead: 'macos-accessibility',
      supportsNativeRead: true,
      copyFallback: true
    }
  }
  if (platform === 'win32') {
    return {
      nativeRead: 'windows-uia',
      supportsNativeRead: true,
      copyFallback: true
    }
  }
  if (platform === 'linux') {
    return {
      nativeRead: 'linux-primary-selection',
      supportsNativeRead: true,
      copyFallback: false
    }
  }
  return {
    nativeRead: 'unsupported',
    supportsNativeRead: false,
    copyFallback: false
  }
}

/**
 * 判断"译"按钮显示期间是否应后台预取选中文字。
 * 所有平台均允许按钮阶段后台预取：macOS 使用常驻 AX helper，
 * Windows 使用常驻 UIA helper（nativeReaderHost），helper 不可用时由管线自行跳过预取。
 * @param platform Node.js 提供的操作系统平台标识。
 * @returns 当前平台是否允许按钮阶段后台预取。
 * @author zhenghq
 */
export function shouldPrefetchSelectionForButton(
  platform: NodeJS.Platform
): boolean {
  return true
}
