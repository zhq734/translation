import type { Api, Settings, ThemeMode, ThemePreset } from '../../shared/types'

const THEME_CACHE_KEY = 'selection-translator.theme'
const THEME_PRESETS: readonly ThemePreset[] = ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']
const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']

type ThemeApi = Pick<Api, 'getSettings' | 'onSettingsChanged'>

/** 判断主题预设是否来自受支持的白名单。
 * @param value 待判断的未知值。
 * @returns 是否为合法主题预设。
 * @author zhenghq
 */
function isThemePreset(value: unknown): value is ThemePreset {
  return typeof value === 'string' && THEME_PRESETS.includes(value as ThemePreset)
}

/** 判断主题模式是否来自受支持的白名单。
 * @param value 待判断的未知值。
 * @returns 是否为合法主题模式。
 * @author zhenghq
 */
function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODES.includes(value as ThemeMode)
}

/** 解析主题设置在当前系统中的最终明暗模式。
 * @param mode 用户选择的主题模式。
 * @returns 应用于 CSS 的浅色或深色模式。
 * @author zhenghq
 */
export function resolveThemeMode(mode: ThemeMode): Exclude<ThemeMode, 'system'> {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 从本地缓存读取最近一次合法主题，缓存异常时安全返回空值。
 * @returns 合法的主题预设与模式，或 null。
 * @author zhenghq
 */
function readCachedTheme(): Pick<Settings, 'themePreset' | 'themeMode'> | null {
  try {
    const raw = window.localStorage.getItem(THEME_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!isThemePreset(parsed.themePreset) || !isThemeMode(parsed.themeMode)) return null
    return { themePreset: parsed.themePreset, themeMode: parsed.themeMode }
  } catch {
    return null
  }
}

/** 保存最近一次合法主题缓存，缓存不可用时不影响正式设置。
 * @param settings 当前主题设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function cacheTheme(settings: Pick<Settings, 'themePreset' | 'themeMode'>): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(settings))
  } catch {
    // 隐私模式或受限环境可能禁止 localStorage，正式设置仍可正常生效。
  }
}

/** 将主题设置应用到当前 Renderer 根节点。
 * @param settings 包含主题预设和模式的设置。
 * @returns 无返回值。
 * @author zhenghq
 */
export function applyTheme(settings: Pick<Settings, 'themePreset' | 'themeMode'>): void {
  const themePreset = isThemePreset(settings.themePreset) ? settings.themePreset : 'sky'
  const themeMode = isThemeMode(settings.themeMode) ? settings.themeMode : 'system'
  const root = document.documentElement
  root.setAttribute('data-theme', themePreset)
  root.setAttribute('data-theme-mode', resolveThemeMode(themeMode))
  cacheTheme({ themePreset, themeMode })
}

/** 启动 Renderer 主题运行时，负责缓存预应用、主进程同步和系统外观监听。
 * @param api 当前窗口可用的设置 API。
 * @returns 取消系统主题监听的方法。
 * @author zhenghq
 */
export function startThemeRuntime(api: ThemeApi): () => void {
  const cached = readCachedTheme()
  if (cached) applyTheme(cached)

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  let currentTheme: Pick<Settings, 'themePreset' | 'themeMode'> = cached ?? {
    themePreset: 'sky',
    themeMode: 'system'
  }
  const handleSystemThemeChange = (): void => {
    if (currentTheme.themeMode === 'system') applyTheme(currentTheme)
  }
  mediaQuery.addEventListener('change', handleSystemThemeChange)

  void api.getSettings().then((settings) => {
    currentTheme = { themePreset: settings.themePreset, themeMode: settings.themeMode }
    applyTheme(settings)
  }).catch(() => {
    // 主进程设置暂不可用时保留缓存或共享样式默认值。
  })
  const unsubscribe = api.onSettingsChanged((settings) => {
    currentTheme = { themePreset: settings.themePreset, themeMode: settings.themeMode }
    applyTheme(settings)
  })
  return () => {
    mediaQuery.removeEventListener('change', handleSystemThemeChange)
    unsubscribe()
  }
}
