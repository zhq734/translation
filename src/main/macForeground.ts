/**
 * macOS 前台应用交还。
 *
 * 背景：应用内**最后一个 key window** 一旦隐藏，macOS 会把应用内下一个窗口（通常是设置页）
 * 提升为 key window；若应用当时仍是前台应用，被提升的窗口会直接落到其它应用之上，
 * 用户表现为「截图复制后设置页自动弹出」「弹窗消失后设置页弹到最前」。
 * 因此凡是不再需要占用前台的时机，都要先把前台交还给用户原本在用的应用。
 *
 * 读取走 `lsappinfo`：无需辅助功能/自动化授权，也不会像 `osascript` 那样拉起脚本解释器。
 * 与 `captureDiagnostics.queryFrontmostApp()` 的区别：后者走 System Events，只用于诊断打点。
 *
 * 本模块同时持有「待交还应用」这一跨模块状态：截图覆盖窗口与翻译弹窗都会消费它，
 * 因为两者属于同一次前台占用——覆盖窗口收起后弹窗接管 key window，最终由弹窗交还。
 *
 * @author zhenghq
 */

import { app, BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { FrontmostWindowSnapshot, WindowBounds } from '../shared/macosWindowSnapshot'
import {
  activateMacosApplication,
  activateMacosApplicationAndWaitForDeactivation,
  activateMacosWindowSnapshot,
  enumerateMacosWindows,
  isExactWindowActivationConfirmed,
  type MacosWindowActivationResult
} from './macosWindowActivation'
import {
  buildFrontmostWindowSnapshot,
  resolveWindowCaptureTarget,
  type ScreenPoint,
  type WindowLocateOutcome
} from '../shared/macosWindowSnapshot'
import { restoreSelectionButtonIfPending } from './selectionButton'

const execFileP = promisify(execFile)

/** 前台应用快照查询超时（毫秒）。lsappinfo 正常在 10ms 内返回。 */
const FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS = 500

/** 交还前台时轮询「本应用是否已失去最前状态」的间隔（毫秒）。 */
const FRONT_RETURN_POLL_INTERVAL_MS = 16

/** 交还前台的兜底超时（毫秒）：激活未生效时也必须继续后续动作，不能卡住窗口隐藏。 */
const FRONT_RETURN_TIMEOUT_MS = 200

/** 隐藏窗口后复核源应用是否仍在前台的有界延迟（毫秒）。 */
const POST_HIDE_FRONT_RECHECK_DELAY_MS = 48

/** 安全让出前台的兜底超时（毫秒）：app.hide() 生效较慢时最长等待时间，超时也必须收尾。 */
const FRONT_YIELD_TIMEOUT_MS = 400

/** 前台交还与安全让出流程的日志前缀，便于从主进程日志中筛选诊断记录。 */
const FRONT_DIAGNOSTIC_PREFIX = '[macForeground]'

/**
 * 输出前台交还 / 让出流程的诊断日志。
 *
 * 这些路径此前完全静默，真机复现「后台窗口被顶到最前」或「弹窗关不掉」时
 * 无法判断实际走了精确交还、交还超时退化还是无记录退化，必须补齐可观测性。
 * @param message 日志内容。
 * @returns 无返回值。
 * @author zhenghq
 */
function logFrontDiagnostic(message: string): void {
  console.log(`${FRONT_DIAGNOSTIC_PREFIX} ${message}`)
}

/** 前台应用快照。 */
export interface FrontmostAppSnapshot {
  /** 应用 bundle id，用于重新激活该应用。 */
  bundleId: string
  /** 应用进程号，用于确认它到交还时仍在运行。 */
  pid: number
  /** 窗口编号；应用级快照时缺失。 */
  windowNumber?: number
  /** 窗口边界；应用级快照时缺失。 */
  bounds?: WindowBounds
  /** 窗口标题哈希指纹；只用于本地匹配，不得写入诊断导出。 */
  titleFingerprint?: string
  /** 快照采集时间戳（毫秒）；应用级快照可缺失。 */
  capturedAt?: number
  /** 入口记录阶段的窗口定位结果；failed 表示不得退化为 open -b。 */
  windowLocate?: WindowLocateOutcome
}

/**
 * 判断快照是否携带可用于精确窗口激活的定位信息。
 * @param snapshot 前台应用或窗口快照。
 * @returns 存在窗口编号或边界时返回 true。
 * @author zhenghq
 */
function hasWindowLocator(snapshot: FrontmostAppSnapshot | null): boolean {
  return Boolean(snapshot && (snapshot.windowNumber !== undefined || snapshot.bounds))
}

/**
 * 将可选的窗口字段补齐为窗口激活模块要求的快照类型。
 * `capturedAt` 仅用于快照语义，不参与窗口匹配；旧调用缺失时以当前时间补齐。
 * @param snapshot 前台应用或窗口快照。
 * @returns 窗口激活模块可直接使用的快照。
 * @author zhenghq
 */
function toFrontmostWindowSnapshot(snapshot: FrontmostAppSnapshot): FrontmostWindowSnapshot {
  return {
    ...snapshot,
    capturedAt: snapshot.capturedAt ?? Date.now()
  }
}

/**
 * 本应用当前是否为 macOS 最前应用。
 *
 * 不能用 `BrowserWindow.getFocusedWindow()` 代替：`dialog.showMessageBox` 等原生对话框
 * 不属于 `BrowserWindow`，对话框存在时该方法返回 null，但本应用仍处于最前。
 * Electron 33 未提供 `app.isActive()`，因此通过应用激活事件自行跟踪。
 */
// 初值取 false：只有确实收到获得激活事件或存在持有焦点的自有窗口时才认为本应用在最前，
// 避免启动阶段误判为「仍在最前」而跳过前台交还或保留过期的待交还记录。
let macAppActive = false

if (process.platform === 'darwin') {
  app.on('did-become-active', () => {
    macAppActive = true
  })
  app.on('did-resign-active', () => {
    macAppActive = false
  })
}

/**
 * 返回仅由 macOS 应用激活事件跟踪的最前状态。
 *
 * 不使用 `BrowserWindow.getFocusedWindow()` 回退：应用失活后系统可能仍让
 * key window 保持焦点，导致该信号误报为 true。判断「自有窗口的矩形能否
 * 吞掉这次全局鼠标事件」时不能容忍这种误报，必须使用纯事件状态。
 * @returns 最近一次应用激活事件表明本应用处于最前时返回 true。
 * @author zhenghq
 */
export function isMacAppActiveByEvents(): boolean {
  return macAppActive
}

/**
 * 判断当前 macOS key window 是否由本应用的自有窗口持有。
 *
 * 取词前只检查翻译弹窗是不够的：设置页、网页阅读器等自有普通窗口同样可能
 * 持有 key window。此时注入的 Command+C 会打在自家窗口上，源应用收不到复制
 * 指令，剪贴板哨兵不变，最终表现为「取词超时」。因此必须在注入复制键前读取
 * 真实 key window 归属，只要属于本应用的任意可见窗口就需要先交还。
 * @returns 自有可见窗口当前持有 key window 时返回 true。
 * @author zhenghq
 */
export function isOwnWindowHoldingKeyWindow(): boolean {
  if (process.platform !== 'darwin') return false
  const focused = BrowserWindow.getFocusedWindow()
  const ownWindowFocused = Boolean(focused && !focused.isDestroyed() && focused.isVisible())
  if (ownWindowFocused) return true
  // 存在待交还记录本身不代表需要再次激活源应用：微信仍在前台时，记录只是
  // 结果弹窗关闭后的收尾目标。此时再调用 open -b 会把同进程的另一个窗口
  // 带到最前，随后 Cmd+C 落在错误窗口并超时。只有应用激活事件表明本应用
  // 仍占用前台、却没有可聚焦的自有窗口时，才需要走交还兜底。
  return isMacAppActiveByEvents()
}

/**
 * 在取词前把 macOS key window 交还给源应用。
 *
 * 优先使用记录的源应用快照精确激活；没有记录、目标已退出或激活未确认时，
 * 对当前持有 key window 的自有窗口执行 blur 作为兜底，至少保证随后注入的
 * Command+C 不会继续打在自家窗口上。本函数只交还 key window，不消费
 * pendingReturnApp：记录仍需留给窗口隐藏时的应用级前台交还流程。
 * @returns 源窗口已精确确认取得前台时返回 true；仅 blur 兜底、无需处理或无法确认时返回 false。
 * @author zhenghq
 */
export async function handBackKeyWindowToFrontmostApp(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const focusedBefore = BrowserWindow.getFocusedWindow()
  const ownWindowFocusedBefore = Boolean(
    focusedBefore && !focusedBefore.isDestroyed() && focusedBefore.isVisible()
  )
  const appActiveBefore = isMacAppActiveByEvents()
  const target = pendingReturnApp
  // 没有自有 key window、没有应用级前台占用、也没有源应用记录时无需交还。
  if (!ownWindowFocusedBefore && !appActiveBefore && !target) return false
  let activationOutcome: MacosWindowActivationResult['outcome'] | undefined
  if (target && isProcessAlive(target.pid)) {
    const activation = await activateFrontmostSnapshot(target)
    activationOutcome = activation.outcome
    const activationRequested = activation.activated
    // activated 只代表已发出动作；确认超时时仍必须继续 blur，不能把未确认
    // 的 raise 当成 key window 已经交还。
    const confirmed = activation.confirmed
    if (!activationRequested) {
      logFrontDiagnostic(`取词前无法激活源应用，退化为 blur：bundleId=${target.bundleId}`)
    } else {
      logFrontDiagnostic(
        `取词前开始交还 key window：bundleId=${target.bundleId} pid=${target.pid} ` +
        `windowLocate=${activationOutcome}`
      )
      // 精确窗口激活已确认目标窗口在前台时可直接返回；应用级 open -b 只有
      // 发出动作，没有可跨进程确认的结果，仍需继续走下方失活轮询。
      if (!ownWindowFocusedBefore && isExactWindowActivationConfirmed(activation)) {
        logFrontDiagnostic(`取词前精确交还 key window 成功：bundleId=${target.bundleId}`)
        return true
      }
      const handedBack = await new Promise<boolean>((resolve) => {
        let finished = false
        const finish = (confirmed: boolean): void => {
          if (finished) return
          finished = true
          resolve(confirmed)
        }
        const deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS
        const poll = (): void => {
          const focused = BrowserWindow.getFocusedWindow()
          const ownWindowFocused = Boolean(
            focused && !focused.isDestroyed() && focused.isVisible()
          )
          // 应用级失活是比 BrowserWindow 焦点更权威的信号；但只有本次开始前
          // 应用确实处于最前时才要求它失活，避免启动阶段事件状态未就绪造成误判。
          const appHandedBack = !appActiveBefore || !isMacAppActiveByEvents()
          if (!ownWindowFocused && appHandedBack) {
            finish(true)
            return
          }
          if (Date.now() >= deadline) {
            finish(false)
            return
          }
          setTimeout(poll, FRONT_RETURN_POLL_INTERVAL_MS)
        }
        poll()
      })
      // 应用级 open -b 后的失活轮询只能证明本应用已让出前台，不能证明源应用
      // 的目标窗口已成为 key window。此处不能返回 true，否则调用方会设置
      // windowActivationSettled，让复制链路跳过自己的窗口确认。
      if (handedBack) {
        logFrontDiagnostic(
          `取词前已让出前台但未精确确认源窗口：bundleId=${target.bundleId}`
        )
      }
      logFrontDiagnostic(`取词前精确交还 key window 超时，退化为 blur：bundleId=${target.bundleId}`)
    }
  } else if (target) {
    logFrontDiagnostic(`取词前无法激活源应用，退化为 blur：bundleId=${target.bundleId}`)
  } else {
    logFrontDiagnostic('取词前没有源应用记录，退化为 blur 自有 key window')
  }
  const focusedNow = BrowserWindow.getFocusedWindow()
  if (focusedNow && !focusedNow.isDestroyed() && focusedNow.isVisible()) {
    focusedNow.blur()
  }
  const focusedAfter = BrowserWindow.getFocusedWindow()
  // blur 只保证自有窗口不再持有 key window，不能证明源窗口已成为前台。
  // 调用方若据此设置 windowActivationSettled，会跳过复制前的窗口确认。
  void focusedAfter
  return false
}

/**
 * 从 `lsappinfo info <asn>` 的输出解析应用快照。
 *
 * 注意 `-only bundleID` 打印的键名是 `CFBundleIdentifier`，与完整输出的 `bundleID=` 不同，
 * 这里解析的是完整输出。
 * @param output `lsappinfo info` 的完整输出。
 * @param selfPid 本应用进程号，用于排除本应用自己。
 * @returns 解析出的快照；字段缺失或指向本应用时为 null。
 * @author zhenghq
 */
export function parseFrontmostAppSnapshot(output: string, selfPid: number): FrontmostAppSnapshot | null {
  const bundleId = /bundleID="([^"]+)"/u.exec(output)?.[1]
  const pid = Number(/pid = (\d+)/u.exec(output)?.[1])
  if (!bundleId || !Number.isInteger(pid) || pid <= 0) return null
  // 最前应用就是本应用时没有可交还的目标：强行激活自己反而会把设置页顶到最前。
  if (pid === selfPid) return null
  return { bundleId, pid }
}

/**
 * 采集当前最前应用的快照（bundle id 与进程号）。
 *
 * 必须在「本应用成为前台应用之前」调用（例如覆盖窗口显示前、弹窗激活前），
 * 否则读到的会是本应用自己。
 * @returns 最前应用快照；读取失败或最前应用是本应用时为 null。
 * @author zhenghq
 */
export async function readFrontmostAppSnapshot(): Promise<FrontmostAppSnapshot | null> {
  try {
    const { stdout: frontStdout } = await execFileP('lsappinfo', ['front'], {
      timeout: FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS
    })
    const asn = frontStdout.trim()
    if (!asn) return null
    const { stdout: infoStdout } = await execFileP('lsappinfo', ['info', asn], {
      timeout: FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS
    })
    return parseFrontmostAppSnapshot(infoStdout, process.pid)
  } catch {
    return null
  }
}

/**
 * 判断指定进程是否仍在运行。
 * @param pid 进程号。
 * @returns 进程仍存在时返回 true。
 * @author zhenghq
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但当前无权发信号，同样视为仍在运行。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 激活快照中的应用，把 macOS 前台交还给它。
 *
 * 用 `open -b` 而不是隐藏本应用：本应用所有窗口全程留在屏上，
 * 正在展示的提示胶囊不会闪一下（`app.hide()` 会隐藏全部窗口，真机采样验证过）。
 * 只有目标应用仍在运行才会执行：否则 `open -b` 会把它重新启动，用户会看到已关闭的应用被拉起。
 * @param snapshot 目标应用快照。
 * @returns 已发出激活请求时返回 true。
 * @author zhenghq
 */
export function activateFrontmostApp(snapshot: FrontmostAppSnapshot | null): boolean {
  if (!snapshot || !isProcessAlive(snapshot.pid)) return false
  execFile('open', ['-b', snapshot.bundleId], () => {})
  return true
}

/**
 * 激活源应用；有窗口定位信息时优先精确激活对应窗口。
 *
 * 只有不带窗口编号或边界的纯应用级快照才允许退化为 `open -b`。只要快照带有
 * 窗口定位信息，即使当前只枚举到一个窗口也必须精确确认或 raise 目标窗口，
 * 避免 Chrome for Testing 被额外拉起应用入口、微信被切到同进程其它窗口。
 * 入口已尝试窗口定位且结果为 failed 时，应用级激活同样会切错窗口，因此必须
 * 返回 failed，由调用方的失活轮询、安全让出或 blur 兜底。
 * 该辅助函数保持同步函数 `activateFrontmostApp` 的源码契约不变，同时让异步
 * 交还路径统一消费完整的窗口激活结果。
 * @param snapshot 源应用或源窗口快照。
 * @returns 是否发出激活、是否确认前台以及窗口定位结果。
 * @author zhenghq
 */
async function activateFrontmostSnapshot(
  snapshot: FrontmostAppSnapshot
): Promise<MacosWindowActivationResult> {
  if (!isProcessAlive(snapshot.pid)) {
    return { activated: false, confirmed: false, outcome: 'failed', windowMatched: false }
  }
  if (!hasWindowLocator(snapshot)) {
    if (snapshot.windowLocate === 'failed') {
      return { activated: false, confirmed: false, outcome: 'failed', windowMatched: false }
    }
    const activated = activateFrontmostApp(snapshot)
    return {
      activated,
      confirmed: activated,
      outcome: activated ? 'app-fallback' : 'failed',
      windowMatched: false
    }
  }
  return activateMacosWindowSnapshot(toFrontmostWindowSnapshot(snapshot))
}

/**
 * 恢复翻译弹窗关闭后应交还的源应用。
 *
 * 精确窗口激活只有在目标窗口已确认时才可直接结束；若 AX raise 已发出但未确认，
 * 或窗口定位失败，则继续按记录的应用进程执行不提升全部窗口的进程级激活。
 * Chrome 多窗口场景下，进程级激活不依赖 AX，可避免直接进入 app.hide()/app.show()
 * 后把后台设置页重新提升到最前。
 * @param target 弹窗出现前记录的源应用快照。
 * @returns 精确窗口已确认，或进程级激活并确认本应用失活时返回 true。
 * @author zhenghq
 */
async function restoreFrontmostForPopup(target: FrontmostAppSnapshot): Promise<boolean> {
  const activation = await activateFrontmostSnapshot(target)
  if (isExactWindowActivationConfirmed(activation)) return true

  logFrontDiagnostic(
    `弹窗源应用恢复未精确确认，尝试进程级激活：bundleId=${target.bundleId} ` +
    `pid=${target.pid} windowLocate=${activation.outcome}`
  )
  return activateMacosApplicationAndWaitForDeactivation(target.pid, {
    activateApplication: activateMacosApplication,
    isAppActive: isMacAppActiveByEvents,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  })
}

/**
 * 待交还的前台应用。
 *
 * 只在「本应用尚未占用前台」时写入，隐藏应用内 key window 时消费一次。
 * 跨覆盖窗口与翻译弹窗共享：截图流程先记下源应用，弹窗最后隐藏时再交还。
 */
let pendingReturnApp: FrontmostAppSnapshot | null = null

/**
 * 待交还应用记录的刷新请求序号。
 *
 * 允许刷新覆盖旧记录后，可能出现两次异步读取并发：先发起的读取若后返回，
 * 会用旧应用覆盖新记录，重新引入「交还给上一个应用」的问题。每次刷新分配
 * 单调递增序号，返回时只有仍是最新请求才允许写入；显式丢弃记录也会自增序号，
 * 使在途读取失效，避免被丢弃的旧记录复活。
 */
let frontmostRecordRequestId = 0

/**
 * 读取系统当前最前应用并写入待交还记录。
 *
 * 记录不得依赖任何焦点 / 激活判定：后台的设置页或阅读器仍可能报告持有焦点
 * （macOS 已知行为），据此跳过会让收尾失去可靠的 `open -b` 交还目标，
 * 只能落到实测不稳定的 `app.hide() → app.show()` 兜底。记录成本极低，
 * 漏记的代价却很高，因此无记录时一律读取系统最前应用。
 *
 * 读到的最前应用就是本应用自身时不记录：此时没有可交还的目标，
 * 强行激活自己反而会把设置页顶到最前（由 `parseFrontmostAppSnapshot` 负责排除）。
 * @returns 无返回值。
 * @author zhenghq
 */
function recordFrontmostAppFromSystem(): void {
  if (pendingReturnApp) return
  try {
    const asn = execFileSync('lsappinfo', ['front'], {
      encoding: 'utf8',
      timeout: FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS
    }).trim()
    if (!asn) return
    const info = execFileSync('lsappinfo', ['info', asn], {
      encoding: 'utf8',
      timeout: FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS
    })
    const snapshot = parseFrontmostAppSnapshot(info, process.pid)
    if (snapshot) {
      pendingReturnApp = snapshot
      logFrontDiagnostic(`记录源应用 bundleId=${snapshot.bundleId} pid=${snapshot.pid}`)
    }
  } catch {
    // 读取失败时保持既有记录不变，收尾会退化到安全让出路径。
  }
}

/**
 * 记录待交还的前台应用（仅 macOS）。
 * @param snapshot 本应用占用前台前的最前应用快照；为 null 时忽略。
 * @returns 无返回值。
 * @author zhenghq
 */
export function rememberFrontmostApp(snapshot: FrontmostAppSnapshot | null): void {
  if (process.platform !== 'darwin' || !snapshot) return
  // 显式写入视为最新权威记录：自增序号使仍在途的异步读取失效，
  // 避免较慢的旧快照随后覆盖这次写入。
  frontmostRecordRequestId += 1
  pendingReturnApp = snapshot
}

/**
 * 在「本应用尚未占用前台」时异步记录待交还应用，并等待记录完成（仅 macOS）。
 *
 * 打开网页阅读器等会立刻调用 `show()/focus()` 的窗口前必须等待本函数返回：
 * 快照读取走子进程，若不等它结束，`show()` 已经把本应用激活成最前应用，
 * 读到的就是本应用自己，关闭窗口时便没有可交还的目标。
 * 每次调用都会读取系统当前最前应用并覆盖旧记录，语义同同步入口：
 * 跨应用切换后必须把前台交还给用户当前正在使用的应用，而不是上一轮的源应用。
 * @returns 记录流程完成时结束的 Promise。
 * @author zhenghq
 */
export async function rememberFrontmostAppIfInactiveAsync(): Promise<void> {
  if (process.platform !== 'darwin') return
  // 同同步入口：不得以应用级激活状态或应用内焦点作为跳过记录的理由。
  const requestId = ++frontmostRecordRequestId
  const snapshot = await readFrontmostAppSnapshot()
  if (!snapshot) return
  // 同同步入口：本次读取已被更新请求取代时不得覆盖最新记录。
  if (requestId !== frontmostRecordRequestId) return
  rememberFrontmostApp(snapshot)
  logFrontDiagnostic(`记录源应用 bundleId=${snapshot.bundleId} pid=${snapshot.pid}`)
}

/**
 * 按屏幕坐标记录待交还应用的源窗口快照。
 *
 * 在应用尚未占用前台时读取最前应用，再枚举其普通窗口并按坐标匹配。
 * 单窗口坐标未命中时可写入应用级快照；多窗口坐标未命中、窗口枚举失败或
 * 快照失效时必须保留 failed 语义，禁止后续用 open -b 猜测同进程窗口。
 * 枚举失败时窗口数量保持未知，不能伪装成成功枚举得到的 0。
 * @param point 划词锚点或快捷键触发时的鼠标坐标。
 * @returns 记录结果；非 macOS 或最前应用读取失败时返回 null。
 * @author zhenghq
 */
export async function rememberFrontmostWindowAtPoint(
  point: ScreenPoint
): Promise<{
  snapshot: FrontmostWindowSnapshot
  windowLocate: WindowLocateOutcome
  windowCount?: number
  windowMatched: boolean
} | null> {
  if (process.platform !== 'darwin') return null
  const requestId = ++frontmostRecordRequestId
  const appSnapshot = await readFrontmostAppSnapshot()
  if (!appSnapshot || requestId !== frontmostRecordRequestId) return null

  let windowList: Awaited<ReturnType<typeof enumerateMacosWindows>> | null
  try {
    windowList = await enumerateMacosWindows(appSnapshot.pid)
  } catch {
    windowList = null
  }
  if (requestId !== frontmostRecordRequestId) return null

  const target = resolveWindowCaptureTarget({
    windows: windowList?.windows ?? null,
    pid: appSnapshot.pid,
    point
  })
  const snapshot = buildFrontmostWindowSnapshot({
    bundleId: appSnapshot.bundleId,
    pid: appSnapshot.pid,
    window: target.window,
    capturedAt: Date.now(),
    windowLocate: target.outcome
  })
  pendingReturnApp = snapshot
  logFrontDiagnostic(
    `记录源窗口 bundleId=${snapshot.bundleId} pid=${snapshot.pid} ` +
    `windowLocate=${target.outcome} windowCount=${target.windowCount ?? 'unknown'} ` +
    `windowMatched=${target.windowMatched}`
  )
  return {
    snapshot,
    windowLocate: target.outcome,
    windowCount: target.windowCount,
    windowMatched: target.windowMatched
  }
}

/**
 * 丢弃待交还记录（仅 macOS）。
 *
 * 本应用已经因为用户点击其它应用而失去最前状态时，记录即失效；
 * 留着它会让下一次隐藏窗口错误地把用户当前正在用的应用换掉。
 * @returns 无返回值。
 * @author zhenghq
 */
export function forgetFrontmostApp(): void {
  // 自增序号使在途读取失效，避免刚丢弃的旧记录随后被异步结果重新写回。
  frontmostRecordRequestId += 1
  pendingReturnApp = null
}

/**
 * 在隐藏「本应用当前 key window」前把 macOS 前台交还出去，随后执行收尾动作。
 *
 * 顺序不能颠倒：先激活源应用、确认本应用确实失去最前状态，再隐藏窗口。
 * 若先隐藏，系统会立刻把应用内下一个窗口（通常是设置页）提升为 key window 并顶到最前，
 * 即使随后的激活请求 50ms 后能纠正回来，用户仍会看到设置页闪一下（真机采样验证过）。
 *
 * 只有「即将隐藏的窗口正是本应用当前 key window」才交还：
 * 隐藏非 key window 不会触发系统提升，此时交还反而会抢走用户正在使用的窗口。
 * 弹窗是例外：结果弹窗可能以非激活方式显示，它自身不是 key window，但本应用
 * 仍可能因点击“译”处于最前；此时即使焦点落在设置页等自有窗口，也必须把
 * 应用级前台交还源应用，否则下一次取词的 Command+C 会打回自家窗口。
 * 兜底定时器保证激活未生效时也会继续收尾，不会让窗口一直留在屏上。
 * @param keyWindow 即将隐藏的窗口。
 * @param run 交还成功后的收尾动作（通常就是隐藏窗口）。
 * @param onHandBackFailed 交还未能完成（拿不到源应用、激活无效或超时）时的退化动作，缺省与 run 相同。
 * @param keyWindowIsPopup 即将隐藏的是否为翻译弹窗；弹窗以 showInactive 显示时
 *   不会持有 key window，但本应用仍可能因点击“译”处于最前，必须走交还/让出路径，
 *   不能与原生对话框持有 key window 的场景混为一谈。
 * @returns 无返回值。
 * @author zhenghq
 */
export function handBackFrontmostThen(
  keyWindow: BrowserWindow | null,
  run: () => void,
  onHandBackFailed?: () => void,
  keyWindowIsPopup = false
): void {
  const fallback = onHandBackFailed ?? run
  if (process.platform !== 'darwin') {
    run()
    return
  }
  const focused = BrowserWindow.getFocusedWindow()
  // 本应用已不在最前：隐藏窗口不会提升应用内其它窗口，记录也已失效。
  if (focused === null) {
    // 弹窗以非激活方式显示且设置页被临时设为不可聚焦时，getFocusedWindow() 同样
    // 返回 null，但本应用仍可能是最前应用。若按原生对话框分支直接 run()，失败提示
    // 隐藏后本应用仍在最前，恢复设置页可聚焦性时它会被系统提升到最前（必现）。
    // 该场景必须继续走下方交还/安全让出逻辑，不能落进原生对话框分支。
    if (keyWindowIsPopup && isMacAppActiveByEvents()) {
      logFrontDiagnostic('弹窗隐藏前检测到本应用仍最前，继续交还前台')
    } else {
      // 原生对话框（如 dialog.showMessageBox）不是 BrowserWindow：对话框存在时
      // getFocusedWindow() 同样返回 null，但应用仍处于最前，对话框自身持有 key window。
      // 此时隐藏弹窗不会提升其它窗口，必须保留记录，供对话框关闭后 handBackFrontmostApp 消费；
      // 若在这里丢弃记录，对话框关闭时网页翻译窗口就会被系统提升到最前。
      if (isMacAppActiveByEvents()) {
        run()
        logFrontDiagnostic('跳过交还：原生对话框持有 key window，保留记录')
        return
      }
      // 该分支每次隐藏窗口都会走到，但 pendingReturnApp 多数时候本就是 null
      // （例如非激活显示的弹窗从未记录源应用）。只有确实丢弃了记录才输出日志，
      // 否则「丢弃过期记录」会变成误导性的空操作噪声，掩盖真实诊断信息。
      const discarded = pendingReturnApp
      forgetFrontmostApp()
      run()
      if (discarded) {
        logFrontDiagnostic(
          `跳过交还：应用已不在最前，丢弃过期记录 bundleId=${discarded.bundleId}`
        )
      }
      return
    }
  }
  // 隐藏的不是当前 key window：不会触发提升，记录留给随后真正隐藏 key window 的调用消费。
  // 弹窗是例外：它可能以非激活方式显示，focused 既可能为 null，也可能落在
  // 设置页等自有可聚焦窗口。真机日志（2026-10-13）显示后一种情况会被旧跳过
  // 分支拦下，本应用继续占据最前，下一次注入的 Command+C 打回自家窗口而超时。
  // 因此弹窗场景只要应用激活事件表明本应用仍最前，就必须继续走交还 / 安全让出；
  // 非弹窗场景仍保留 key window 归属判定，避免隐藏后台窗口时抢走用户焦点。
  const popupNeedsHandBack = keyWindowIsPopup && isMacAppActiveByEvents()
  if (!popupNeedsHandBack &&
      (!keyWindow || keyWindow.isDestroyed() || focused !== keyWindow)) {
    logFrontDiagnostic('跳过交还：即将隐藏的窗口不是当前 key window')
    run()
    return
  }
  const target = pendingReturnApp
  pendingReturnApp = null
  // 拿不到源应用（读取失败或截图前本应用已是最前）时没有可交还的目标，直接走退化动作。
  if (!target || !isProcessAlive(target.pid)) {
    logFrontDiagnostic(
      `交还退化为安全让出：${target ? `目标应用已退出 pid=${target.pid}` : '没有可交还的源应用记录'}`
    )
    void yieldFrontmostApp(fallback)
    return
  }
  let finished = false
  const startedAt = Date.now()
  const finish = (handedBack: boolean, successKind = 'exact-window-handback'): void => {
    if (finished) return
    finished = true
    if (handedBack) {
      logFrontDiagnostic(
        `${successKind}：bundleId=${target.bundleId} 耗时 ${Date.now() - startedAt}ms`
      )
      run()
      // 隐藏窗口本身会触发 macOS 重新选择 key window。即使隐藏前已确认源应用
      // 在前台，系统也可能把同应用的设置页重新提升为 key window，并让本应用
      // 再次成为最前应用。这里保留本次 target 做一次短延迟复核，避免把恢复
      // 动作无限轮询或依赖已被消费的 pendingReturnApp。
      // 只对翻译弹窗做该复核：OCR 覆盖层与阅读器的关闭可能发生在用户主动
      // 切换应用之后，延迟恢复会错误抢回新焦点。
      if (keyWindowIsPopup) {
        setTimeout(() => {
          if (!isMacAppActiveByEvents()) return
          logFrontDiagnostic(`隐藏后复核到本应用重新置前，再次精确恢复：bundleId=${target.bundleId}`)
          void restoreFrontmostForPopup(target).then((restored) => {
            if (!restored) {
              logFrontDiagnostic(`隐藏后再次恢复失败：bundleId=${target.bundleId}`)
            }
          }).catch(() => {
            logFrontDiagnostic(`隐藏后再次恢复异常：bundleId=${target.bundleId}`)
          })
        }, POST_HIDE_FRONT_RECHECK_DELAY_MS)
      }
      return
    }
    logFrontDiagnostic(
      `交还退化为安全让出：激活源应用 bundleId=${target.bundleId} 未在 ${FRONT_RETURN_TIMEOUT_MS}ms 内确认失活`
    )
    void yieldFrontmostApp(fallback)
  }
  // 兜底：激活未生效、目标应用是无窗口的后台应用或轮询异常时也必须收尾，
  // 不能把窗口一直留在屏上拦截鼠标。
  let fallbackTimer: NodeJS.Timeout | undefined
  let deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS
  const pollDeactivated = (): void => {
    // 应用级失活是最权威的「可以安全隐藏」信号：应用失活后系统可能仍让 key window
    // 保持焦点，仅按 getFocusedWindow() 轮询会误判为「仍需等待」，200ms 后
    // 退化为不稳定的安全让出兜底，正是本缺陷的残留通道。
    if (!isMacAppActiveByEvents()) {
      finish(true)
      return
    }
    // getFocusedWindow() 为 null 只能说明没有 BrowserWindow 持有焦点，不能证明本应用
    // 已经失活：设置页失焦、弹窗非激活显示或原生面板持有 key window 时都会出现该状态。
    // 若据此提前隐藏弹窗，系统可能把同应用的设置页提升为 key window。必须继续等待
    // 应用级 did-resign-active 信号，超时后由安全让出兜底。
    if (Date.now() >= deadline) {
      finish(false)
      return
    }
    setTimeout(pollDeactivated, FRONT_RETURN_POLL_INTERVAL_MS)
  }
  // 精确窗口激活可能包含最多 200ms 枚举与 200ms 确认，不能在发出请求后
  // 立刻开始 200ms 兜底计时，否则确认轮询会被提前截断。先等待完整激活结果，
  // 再以统一的应用失活条件确认交还。只有纯应用级快照允许 open -b；
  // 带窗口定位信息的快照必须精确激活，窗口定位失败时不能再猜测同进程窗口。
  if (keyWindowIsPopup) {
    // 弹窗路径必须复用带进程级激活兜底的恢复入口，不能只看 AX 是否发出请求。
    void restoreFrontmostForPopup(target).then((restored) => {
      if (restored) {
        finish(true, 'popup-front-restored')
        return
      }
      finish(false)
    }).catch(() => finish(false))
    return
  }
  void activateFrontmostSnapshot(target).then((activation) => {
    if (!activation.activated) {
      finish(false)
      return
    }
    // 激活结果返回后才开始前台失活确认与硬超时，避免精确窗口激活的
    // 枚举/确认耗时挤占交还等待窗口。
    fallbackTimer = setTimeout(() => finish(false), FRONT_RETURN_TIMEOUT_MS)
    deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS
    logFrontDiagnostic(
      `开始交还：bundleId=${target.bundleId} pid=${target.pid} ` +
      `windowLocate=${activation.outcome}`
    )
    pollDeactivated()
  }).catch(() => finish(false))
}

/**
 * 在原生对话框关闭后把 macOS 前台交还给对话框出现前的应用。
 *
 * `dialog.showMessageBox` 会激活本应用；对话框关闭时，应用内下一个窗口（通常是网页阅读器）
 * 会被系统提升为 key window 并顶到最前。此入口不依赖具体 BrowserWindow，调用方可在
 * 对话框 Promise 结束后等待前台交还完成，再继续显示自己的提示。
 * @returns 已确认本应用失去最前状态时返回 true；无需交还或交还超时时返回 false。
 * @author zhenghq
 */
export async function handBackFrontmostApp(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  // 原生对话框不是 BrowserWindow，关闭后 getFocusedWindow() 可能仍为 null，
  // 但应用仍处于最前；必须依据应用激活状态判断是否真的还需要交还前台。
  if (!isMacAppActiveByEvents()) {
    forgetFrontmostApp()
    logFrontDiagnostic('原生对话框收尾跳过交还：应用激活事件表明本应用不在最前')
    return Promise.resolve(false)
  }
  const target = pendingReturnApp
  pendingReturnApp = null
  // 没有可交还的目标（快照读取失败、源应用已退出，或本应用占用前台前就是自己）时
  // 不能直接收尾：本应用仍是最前应用，随后隐藏或关闭窗口会让系统把应用内下一个
  // 窗口（网页阅读器）提升为 key window 并顶到用户应用之上，因此改用安全退化序列让出前台。
  if (!target || !isProcessAlive(target.pid)) {
    logFrontDiagnostic(
      `原生对话框收尾退化为安全让出：${target ? `目标应用已退出 pid=${target.pid}` : '没有可交还的源应用记录'}`
    )
    return yieldFrontmostApp(() => {})
  }
  const activation = await activateFrontmostSnapshot(target)
  if (!activation.activated) {
    logFrontDiagnostic(`原生对话框收尾退化为安全让出：无法激活 bundleId=${target.bundleId}`)
    return yieldFrontmostApp(() => {})
  }
  const handBackStartedAt = Date.now()
  logFrontDiagnostic(
    `原生对话框收尾开始交还：bundleId=${target.bundleId} pid=${target.pid} ` +
    `windowLocate=${activation.outcome}`
  )

  const handBack = new Promise<boolean>((resolve) => {
    let finished = false
    const finish = (handedBack: boolean): void => {
      if (finished) return
      finished = true
      // 目标应用在超时前没有真正接管前台：改用安全退化序列让出前台，
      // 避免随后隐藏失败提示时把应用内其它窗口（网页阅读器）顶到最前。
      if (!handedBack && isMacAppActiveByEvents()) {
        logFrontDiagnostic('原生对话框收尾交还超时，改用安全让出')
        void yieldFrontmostApp(() => {}).then(() => resolve(false))
        return
      }
      logFrontDiagnostic(
        handedBack
          ? `原生对话框收尾精确交还成功：bundleId=${target.bundleId} 耗时 ${Date.now() - handBackStartedAt}ms`
          : '原生对话框收尾未确认失活且本应用已不在最前，按交还完成处理'
      )
      resolve(handedBack)
    }
    const deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS
    const pollDeactivated = (): void => {
      if (!isMacAppActiveByEvents()) {
        finish(true)
        return
      }
      if (Date.now() >= deadline) {
        finish(false)
        return
      }
      setTimeout(pollDeactivated, FRONT_RETURN_POLL_INTERVAL_MS)
    }
    pollDeactivated()
  })
  return handBack
}

/**
 * 在没有可交还源应用时安全让出 macOS 最前状态。
 *
 * 直接隐藏应用内 key window 会让系统把应用内下一个窗口（网页阅读器或设置页）
 * 提升为 key window，只要本应用仍是最前应用，该窗口就会盖到用户原本在用的应用之上。
 * 这里改用「隐藏应用→等待系统把前台还给其它应用→非激活恢复应用→执行收尾」，
 * 窗口只会在屏上短暂消失，收尾后的窗口层级仍保持在用户应用之后。
 * 恢复必须早于收尾：app.hide() 隐藏整个应用期间，弹窗的 isVisible() 也返回 false，
 * 收尾函数会命中可见性短路分支而跳过真正的 win.hide()；随后的 app.show() 再把弹窗
 * 恢复可见，表现为点关闭关不掉。
 * 先等待真正失活再收尾是必须的：真机 CGWindowList 采样验证过，
 * 未等待失活就收尾时阅读器仍会被顶到最前（表现为闪一下并抢占前台）。
 * @param run 失活后要执行的收尾动作（隐藏窗口或降级为非激活显示）。
 * @returns 实际执行了安全让出流程时返回 true；无需让出时返回 false。
 * @author zhenghq
 */
function yieldFrontmostApp(run: () => void): Promise<boolean> {
  if (process.platform !== 'darwin') {
    run()
    return Promise.resolve(false)
  }
  // 本应用不在最前时隐藏窗口不会提升其它窗口，直接收尾即可，避免整应用闪烁。
  // 用应用激活事件状态而非窗口焦点：窗口焦点会因失活后残留的 key window 而误报，
  // 使收尾被判定为「仍需让出」，白白走一遍整应用隐藏。
  if (!isMacAppActiveByEvents()) {
    logFrontDiagnostic('无需让出前台：应用激活事件表明本应用不在最前')
    run()
    return Promise.resolve(false)
  }
  return new Promise<boolean>((resolve) => {
    let finished = false
    const startedAt = Date.now()
    // app.hide() 会隐藏整个应用，app.show() 又会恢复应用内全部窗口。
    // 必须先记录每个窗口原本是否可见，避免安全让出把已关闭的弹窗或后台窗口
    // 重新显示出来；恢复过程也不得逐窗口调用 showInactive()/focus()/moveTop()，
    // 否则 macOS 会把设置页重新排到用户当前应用之上。
    const visibilitySnapshots = BrowserWindow.getAllWindows().map((window) => ({
      window,
      wasVisible: !window.isDestroyed() && window.isVisible()
    }))
    const finish = (): void => {
      if (finished) return
      finished = true
      // app.show() 走 unhideWithoutActivation：只整体恢复窗口可见性，不激活应用，
      // 也不会把窗口提到用户当前应用之上。原本可见的窗口必须依赖这一步恢复，
      // 不能再逐窗口非激活显示；showInactive() 在 macOS 上等价于置前。
      app.show()
      for (const snapshot of visibilitySnapshots) {
        if (snapshot.window.isDestroyed()) continue
        if (!snapshot.wasVisible) {
          // 原本隐藏的窗口必须无条件再次隐藏，不能只在其当前仍可见时才处理。
          // app.show() 的可见性变化可能异步生效，条件式 hide 会漏掉随后重新显示的窗口。
          snapshot.window.hide()
          continue
        }
      }
      // 整应用隐藏期间弹窗的 isVisible() 同样为 false，收尾函数会因可见性短路
      // 跳过真正的 win.hide()，必须先非激活恢复应用再收尾，否则随后的整体恢复
      // 会把弹窗重新显示出来，用户表现为「点关闭后弹窗关不掉」。
      run()
      // app.hide() 会连“译”按钮一起隐藏；若划词发生在这段窗口期，showInactive
      // 会被整体隐藏吞掉。恢复应用可见性后按待处理锚点重放一次按钮显示。
      restoreSelectionButtonIfPending()
      resolve(true)
    }
    logFrontDiagnostic('开始安全让出前台：app.hide() → 等待失活 → app.show() → 收尾')
    // app.hide() 会把应用内所有窗口（含正在展示的提示弹窗）一起隐藏，
    // 因此显隐次序固定为「先隐藏应用→等待失活→非激活恢复应用→收尾」。
    app.hide()
    const deadline = Date.now() + FRONT_YIELD_TIMEOUT_MS
    const poll = (): void => {
      // 必须用事件状态：app.hide() 后残留的窗口焦点会让窗口焦点判断持续误报 true，
      // 轮询会一路走到 400ms 超时，收尾时序退化为不确定。
      if (!isMacAppActiveByEvents()) {
        logFrontDiagnostic(`确认本应用失活，耗时 ${Date.now() - startedAt}ms`)
        finish()
        return
      }
      if (Date.now() >= deadline) {
        logFrontDiagnostic(`等待失活超时（${FRONT_YIELD_TIMEOUT_MS}ms），仍继续收尾`)
        finish()
        return
      }
      setTimeout(poll, FRONT_RETURN_POLL_INTERVAL_MS)
    }
    poll()
  })
}
