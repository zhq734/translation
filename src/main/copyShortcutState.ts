import { CopyShortcutGuard } from '../shared/copyShortcutBehavior'

/**
 * 主进程内部取词与全局键盘监听共享的复制快捷键保护器。
 * @author zhenghq
 */
export const copyShortcutGuard = new CopyShortcutGuard()
