/** 浏览器键盘事件中用于生成 Electron Accelerator 的最小字段集合。 */
export interface KeyboardAcceleratorInput {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  repeat: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super', 'Win'])

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  '`': '`',
  '-': '-',
  '=': '=',
  '[': '[',
  ']': ']',
  '\\': '\\',
  ';': ';',
  "'": "'",
  ',': ',',
  '.': '.',
  '/': '/'
}

/**
 * 将浏览器键盘事件转换为 Electron 全局快捷键格式。
 * @param event 键盘事件中包含按键和修饰键状态的字段。
 * @param platform 浏览器平台标识，用于区分 macOS 的 Command 名称。
 * @returns 可交给 Electron globalShortcut 的 Accelerator；无效按键返回 null。
 * @author zhenghq
 */
export function formatKeyboardAccelerator(
  event: KeyboardAcceleratorInput,
  platform: string
): string | null {
  if (event.repeat || MODIFIER_KEYS.has(event.key)) return null

  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Control')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (event.metaKey) modifiers.push(platform === 'MacIntel' || platform === 'MacPPC' ? 'Command' : 'Super')

  let key = KEY_NAMES[event.key]
  if (!key && /^Key[A-Z]$/u.test(event.code)) key = event.code.slice(3)
  if (!key && /^Digit[0-9]$/u.test(event.code)) key = event.code.slice(5)
  if (!key && /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(event.key)) key = event.key
  if (!key && event.key.length === 1 && /^[a-zA-Z0-9]$/u.test(event.key)) key = event.key.toUpperCase()

  if (!key || modifiers.length === 0) return null
  return [...modifiers, key].join('+')
}
