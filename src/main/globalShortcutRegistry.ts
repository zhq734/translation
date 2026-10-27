import type { Settings } from '../shared/types'
import { isCopyShortcut } from '../shared/copyShortcutBehavior'

/** 可注册的全局快捷键字段标识。 */
export type GlobalShortcutId = 'hotkey' | 'ocrHotkey' | 'manualTranslationHotkey' | 'webReaderHotkey'

/** 单个全局快捷键的注册状态。 */
export type GlobalShortcutRegistrationStatus = 'registered' | 'occupied' | 'invalid' | 'skipped' | 'failed'

/** 单个全局快捷键的注册结果。 */
export interface GlobalShortcutRegistrationState {
  /** 快捷键字段标识。 */
  id: GlobalShortcutId
  /** 本次尝试注册的快捷键。 */
  accelerator: string
  /** 注册结果状态。 */
  status: GlobalShortcutRegistrationStatus
  /** 面向设置页的失败原因；成功和空值通常为空。 */
  message?: string
}

/** 快捷键冲突描述。 */
export type GlobalShortcutConflict =
  | { kind: 'copy' }
  | { kind: 'duplicate'; owner: GlobalShortcutId }

/** 注册器依赖，便于单元测试替换 Electron globalShortcut。 */
export interface GlobalShortcutRegistryDeps {
  /** 注销全部旧快捷键。 */
  unregisterAll(): void
  /** 注册一个 Electron Accelerator，返回是否成功。 */
  register(accelerator: string): boolean
}

const SHORTCUT_IDS: GlobalShortcutId[] = [
  'hotkey',
  'ocrHotkey',
  'manualTranslationHotkey',
  'webReaderHotkey'
]

/**
 * 规范化快捷键用于重复值比较。
 * @param accelerator Electron Accelerator。
 * @returns 忽略大小写、空格和修饰键顺序的比较键。
 * @author zhenghq
 */
function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator
    .trim()
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length <= 1) return parts.join('+')
  return [parts[0], ...parts.slice(1).sort()].join('+')
}

/**
 * 检查一个快捷键字段是否与系统复制或其它全局快捷键冲突。
 * @param id 待检查的快捷键字段。
 * @param accelerator 用户输入或保存的快捷键。
 * @param settings 当前完整快捷键配置。
 * @returns 冲突描述；没有冲突时返回 null。
 * @author zhenghq
 */
export function findShortcutConflict(
  id: GlobalShortcutId,
  accelerator: string,
  settings: Pick<Settings, GlobalShortcutId>
): GlobalShortcutConflict | null {
  const normalized = accelerator.trim()
  if (!normalized) return null
  if (isCopyShortcut(normalized)) return { kind: 'copy' }

  const candidate = normalizeAccelerator(normalized)
  for (const owner of SHORTCUT_IDS) {
    if (owner === id) continue
    const other = String(settings[owner] ?? '').trim()
    if (other && normalizeAccelerator(other) === candidate) {
      return { kind: 'duplicate', owner }
    }
  }
  return null
}

/**
 * 依次注销并注册全部非空全局快捷键，汇总每个字段的状态。
 * @param settings 当前完整设置快照。
 * @param deps 注册和注销依赖。
 * @returns 按固定字段顺序返回的注册状态。
 * @author zhenghq
 */
export function collectShortcutRegistrationStates(
  settings: Pick<Settings, GlobalShortcutId>,
  deps: GlobalShortcutRegistryDeps
): GlobalShortcutRegistrationState[] {
  deps.unregisterAll()
  return SHORTCUT_IDS.map((id) => {
    const accelerator = String(settings[id] ?? '').trim()
    if (!accelerator) {
      return { id, accelerator: '', status: 'skipped' }
    }
    if (isCopyShortcut(accelerator)) {
      return { id, accelerator, status: 'invalid', message: 'system-copy' }
    }
    try {
      if (deps.register(accelerator)) {
        return { id, accelerator, status: 'registered' }
      }
      return { id, accelerator, status: 'occupied' }
    } catch (error) {
      return {
        id,
        accelerator,
        status: 'invalid',
        message: error instanceof Error ? error.message : 'invalid'
      }
    }
  })
}

