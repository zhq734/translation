/**
 * wl-paste 单次读取的最长执行时间（毫秒）。
 * 必须明显小于取词检查总超时（1500ms），为原生直读重试窗口留足余量。
 */
export const WL_PASTE_TIMEOUT_MS = 800

/** wl-paste 一次主选区读取的原始输入：ok 表示进程成功退出并返回输出。 */
export interface WlPasteReadInput {
  /** wl-paste 进程是否成功执行（退出码为 0 且未超时、未被取消）。 */
  ok: boolean
  /** wl-paste 标准输出内容，失败时为错误描述或空串。 */
  text: string
}

/** wl-paste 读取的规范化结果：text 表示可直接使用的选区文本，fallback 表示需回退。 */
export type WlPasteReadOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'fallback' }

/**
 * 判断给定环境变量是否表示当前处于 Wayland 会话。
 * XDG_SESSION_TYPE=wayland 或存在 WAYLAND_DISPLAY 任一条件成立即视为 Wayland，
 * 覆盖部分桌面环境只设置后者的情况。
 * @param env 进程环境变量集合，测试时可注入局部副本。
 * @returns 处于 Wayland 会话时返回 true。
 * @author zhenghq
 */
export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  const sessionType = (env.XDG_SESSION_TYPE ?? '').trim().toLowerCase()
  if (sessionType === 'wayland') return true
  return Boolean(env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim())
}

/**
 * 判断当前 Linux 取词是否应优先通过 wl-paste 读取 Wayland 主选区。
 * 仅 Linux 平台且处于 Wayland 会话时返回 true；X11 会话与其他平台保持原有读取路径。
 * @param platform Node.js 平台标识。
 * @param env 进程环境变量集合。
 * @returns 应优先调用 wl-paste 时返回 true。
 * @author zhenghq
 */
export function shouldUseWlPasteForLinux(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): boolean {
  return platform === 'linux' && isWaylandSession(env)
}

/**
 * 将 wl-paste 的原始执行结果规范化为取词决策。
 * 成功且输出包含非空白字符时视为有效选区文本；空输出、纯空白输出或执行失败
 * 统一返回 fallback，由调用方回退到 Electron selection 读取。
 * @param input wl-paste 进程执行结果。
 * @returns 规范化读取结果。
 * @author zhenghq
 */
export function resolveWlPasteReadOutcome(input: WlPasteReadInput): WlPasteReadOutcome {
  if (!input.ok) return { kind: 'fallback' }
  if (!input.text.trim()) return { kind: 'fallback' }
  return { kind: 'text', text: input.text }
}

/**
 * 判断 wl-paste 读取结果是否需要回退到 Electron selection 读取。
 * @param outcome wl-paste 规范化读取结果。
 * @returns 需要回退时返回 true。
 * @author zhenghq
 */
export function shouldFallbackAfterWlPaste(outcome: WlPasteReadOutcome): boolean {
  return outcome.kind === 'fallback'
}
