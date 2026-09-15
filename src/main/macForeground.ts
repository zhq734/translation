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

const execFileP = promisify(execFile)

/** 前台应用快照查询超时（毫秒）。lsappinfo 正常在 10ms 内返回。 */
const FRONTMOST_APP_SNAPSHOT_TIMEOUT_MS = 500

/** 交还前台时轮询「本应用是否已失去最前状态」的间隔（毫秒）。 */
const FRONT_RETURN_POLL_INTERVAL_MS = 16

/** 交还前台的兜底超时（毫秒）：激活未生效时也必须继续后续动作，不能卡住窗口隐藏。 */
const FRONT_RETURN_TIMEOUT_MS = 200

/** 安全让出前台的兜底超时（毫秒）：app.hide() 生效较慢时最长等待时间，超时也必须收尾。 */
const FRONT_YIELD_TIMEOUT_MS = 400

/** 前台应用快照。 */
export interface FrontmostAppSnapshot {
  /** 应用 bundle id，用于重新激活该应用。 */
  bundleId: string
  /** 应用进程号，用于确认它到交还时仍在运行。 */
  pid: number
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
 * 返回本应用当前是否为 macOS 最前应用。
 * @returns 本应用仍持有最前状态时返回 true。
 * @author zhenghq
 */
export function isMacAppActive(): boolean {
  // 有自有窗口持有焦点时应用必然处于最前，优先采信这个同步信号；
  // 其余情况（例如 key window 是原生对话框）回退到事件跟踪的激活状态。
  if (BrowserWindow.getFocusedWindow() !== null) return true
  return macAppActive
}

/**
 * 返回仅由 macOS 应用激活事件跟踪的最前状态。
 *
 * 与 `isMacAppActive()` 的区别：后者会优先采信 `BrowserWindow.getFocusedWindow()`，
 * 而应用失活后系统可能仍让 key window 保持焦点，导致该信号误报为 true。
 * 判断「自有窗口的矩形能否吞掉这次全局鼠标事件」时不能容忍这种误报，
 * 必须使用不带窗口焦点回退的纯事件状态。
 * @returns 最近一次应用激活事件表明本应用处于最前时返回 true。
 * @author zhenghq
 */
export function isMacAppActiveByEvents(): boolean {
  return macAppActive
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
 * 待交还的前台应用。
 *
 * 只在「本应用尚未占用前台」时写入，隐藏应用内 key window 时消费一次。
 * 跨覆盖窗口与翻译弹窗共享：截图流程先记下源应用，弹窗最后隐藏时再交还。
 */
let pendingReturnApp: FrontmostAppSnapshot | null = null

/**
 * 是否处于「内部窗口收尾抑制期」。
 *
 * 覆盖「交还前台 → 隐藏弹窗 → hide 真正生效」整段窗口期。此期间到达的 activate
 * 属于内部窗口显隐引发的事件，必须按内部激活抑制，不能命中 Dock 入口把后台窗口顶到最前。
 */
let internalWindowTeardownActive = false

/**
 * 进入内部窗口收尾抑制期。
 * @returns 无返回值。
 * @author zhenghq
 */
export function beginInternalWindowTeardown(): void {
  internalWindowTeardownActive = true
}

/**
 * 退出内部窗口收尾抑制期。
 * @returns 无返回值。
 * @author zhenghq
 */
export function endInternalWindowTeardown(): void {
  internalWindowTeardownActive = false
}

/**
 * 返回当前是否处于内部窗口收尾抑制期。
 * @returns 处于抑制期时返回 true。
 * @author zhenghq
 */
export function isInternalWindowTeardownActive(): boolean {
  return internalWindowTeardownActive
}

/**
 * 在会激活本应用的窗口 `show()` 之前记录源应用。
 *
 * `rememberFrontmostAppIfInactive()` 是异步读子进程的，无法在同步的 `showPopup()` 内使用；
 * 而「上一轮结果弹窗已经把本应用激活」时，本轮取词再调用 `rememberFrontmostAppIfInactive()`
 * 会因为应用内已有焦点窗口而跳过，收尾便没有可交还目标，只能落到实测不稳定的
 * `app.hide() → app.show()` 兜底。因此在激活显示前同步补一次快照。
 * @returns 无返回值。
 * @author zhenghq
 */
export function rememberFrontmostAppBeforeActivation(): void {
  if (process.platform !== 'darwin') return
  if (pendingReturnApp) return
  if (isMacAppActive()) return
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
    if (snapshot) pendingReturnApp = snapshot
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
  pendingReturnApp = snapshot
}

/**
 * 在「本应用尚未占用前台」时异步记录待交还应用（仅 macOS）。
 *
 * 调用点必须在任何窗口激活之前、且此刻本应用确实不在最前：
 * 读取走子进程，晚于同一 tick 内的 win.show() 就只会读到本应用自己。
 * 已有待交还记录时不覆盖：一次前台占用期间只认第一次记下的源应用。
 * @returns 无返回值。
 * @author zhenghq
 */
export function rememberFrontmostAppIfInactive(): void {
  if (process.platform !== 'darwin') return
  if (pendingReturnApp) return
  // 应用内存在焦点窗口（例如上一轮结果弹窗）不代表本应用占用 macOS 前台：
  // 据此跳过会漏记源应用，使收尾失去可靠的 open -b 交还目标。
  if (isMacAppActive()) return
  void readFrontmostAppSnapshot().then(rememberFrontmostApp)
}

/**
 * 在「本应用尚未占用前台」时异步记录待交还应用，并等待记录完成（仅 macOS）。
 *
 * 打开网页阅读器等会立刻调用 `show()/focus()` 的窗口前必须等待本函数返回：
 * 快照读取走子进程，若不等它结束，`show()` 已经把本应用激活成最前应用，
 * 读到的就是本应用自己，关闭窗口时便没有可交还的目标。
 * 已有待交还记录时不覆盖：一次前台占用期间只认第一次记下的源应用。
 * @returns 记录流程完成时结束的 Promise。
 * @author zhenghq
 */
export async function rememberFrontmostAppIfInactiveAsync(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (pendingReturnApp) return
  // 同同步入口：必须以应用级激活状态判断，而不是应用内是否存在焦点窗口。
  if (isMacAppActive()) return
  rememberFrontmostApp(await readFrontmostAppSnapshot())
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
 * 兜底定时器保证激活未生效时也会继续收尾，不会让窗口一直留在屏上。
 * @param keyWindow 即将隐藏的窗口。
 * @param run 交还成功后的收尾动作（通常就是隐藏窗口）。
 * @param onHandBackFailed 交还未能完成（拿不到源应用、激活无效或超时）时的退化动作，缺省与 run 相同。
 * @returns 无返回值。
 * @author zhenghq
 */
export function handBackFrontmostThen(
  keyWindow: BrowserWindow | null,
  run: () => void,
  onHandBackFailed?: () => void
): void {
  const fallback = onHandBackFailed ?? run
  if (process.platform !== 'darwin') {
    run()
    return
  }
  const focused = BrowserWindow.getFocusedWindow()
  // 本应用已不在最前：隐藏窗口不会提升应用内其它窗口，记录也已失效。
  if (focused === null) {
    // 原生对话框（如 dialog.showMessageBox）不是 BrowserWindow：对话框存在时
    // getFocusedWindow() 同样返回 null，但应用仍处于最前，对话框自身持有 key window。
    // 此时隐藏弹窗不会提升其它窗口，必须保留记录，供对话框关闭后 handBackFrontmostApp 消费；
    // 若在这里丢弃记录，对话框关闭时网页翻译窗口就会被系统提升到最前。
    if (isMacAppActive()) {
      run()
      return
    }
    forgetFrontmostApp()
    run()
    return
  }
  // 隐藏的不是当前 key window：不会触发提升，记录留给随后真正隐藏 key window 的调用消费。
  if (!keyWindow || keyWindow.isDestroyed() || focused !== keyWindow) {
    run()
    return
  }
  const target = pendingReturnApp
  pendingReturnApp = null
  // 拿不到源应用（读取失败或截图前本应用已是最前）时没有可交还的目标，直接走退化动作。
  if (!target || !isProcessAlive(target.pid)) {
    fallback()
    return
  }
  let finished = false
  const finish = (handedBack: boolean): void => {
    if (finished) return
    finished = true
    if (handedBack) run()
    else fallback()
  }
  // 兜底：激活未生效、目标应用是无窗口的后台应用或轮询异常时也必须收尾，
  // 不能把窗口一直留在屏上拦截鼠标。
  setTimeout(() => finish(false), FRONT_RETURN_TIMEOUT_MS)
  if (!activateFrontmostApp(target)) {
    finish(false)
    return
  }
  const deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS
  const pollDeactivated = (): void => {
    // getFocusedWindow() 在本应用失去最前状态后返回 null，正是可以安全隐藏窗口的时刻。
    if (BrowserWindow.getFocusedWindow() === null) {
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
export function handBackFrontmostApp(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  // 原生对话框不是 BrowserWindow，关闭后 getFocusedWindow() 可能仍为 null，
  // 但应用仍处于最前；必须依据应用激活状态判断是否真的还需要交还前台。
  if (!isMacAppActive()) {
    forgetFrontmostApp()
    return Promise.resolve(false)
  }
  const target = pendingReturnApp
  pendingReturnApp = null
  // 没有可交还的目标（快照读取失败、源应用已退出，或本应用占用前台前就是自己）时
  // 不能直接收尾：本应用仍是最前应用，随后隐藏或关闭窗口会让系统把应用内下一个
  // 窗口（网页阅读器）提升为 key window 并顶到用户应用之上，因此改用安全退化序列让出前台。
  if (!target || !isProcessAlive(target.pid)) {
    return yieldFrontmostAppThen(() => {})
  }
  if (!activateFrontmostApp(target)) {
    return yieldFrontmostAppThen(() => {})
  }

  return new Promise<boolean>((resolve) => {
    let finished = false
    const finish = (handedBack: boolean): void => {
      if (finished) return
      finished = true
      // 目标应用在超时前没有真正接管前台：改用安全退化序列让出前台，
      // 避免随后隐藏失败提示时把应用内其它窗口（网页阅读器）顶到最前。
      if (!handedBack && isMacAppActive()) {
        void yieldFrontmostAppThen(() => {}).then(() => resolve(false))
        return
      }
      resolve(handedBack)
    }
    const deadline = Date.now() + FRONT_RETURN_TIMEOUT_MS
    const pollDeactivated = (): void => {
      if (!isMacAppActive()) {
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
export function yieldFrontmostAppThen(run: () => void): Promise<boolean> {
  if (process.platform !== 'darwin') {
    run()
    return Promise.resolve(false)
  }
  // 本应用不在最前时隐藏窗口不会提升其它窗口，直接收尾即可，避免整应用闪烁。
  if (!isMacAppActive()) {
    run()
    return Promise.resolve(false)
  }
  return new Promise<boolean>((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      // app.show() 走 unhideWithoutActivation：只恢复窗口可见性，不激活应用，
      // 也不会把窗口提到用户当前应用之上。
      app.show()
      // 整应用隐藏期间弹窗的 isVisible() 同样为 false，收尾函数会因可见性短路
      // 跳过真正的 win.hide()，必须先非激活恢复应用再收尾，否则随后的整体恢复
      // 会把弹窗重新显示出来，用户表现为「点关闭后弹窗关不掉」。
      run()
      resolve(true)
    }
    // app.hide() 会把应用内所有窗口（含正在展示的提示弹窗）一起隐藏，
    // 因此显隐次序固定为「先隐藏应用→等待失活→非激活恢复应用→收尾」。
    app.hide()
    const deadline = Date.now() + FRONT_YIELD_TIMEOUT_MS
    const poll = (): void => {
      if (!isMacAppActive()) {
        finish()
        return
      }
      if (Date.now() >= deadline) {
        finish()
        return
      }
      setTimeout(poll, FRONT_RETURN_POLL_INTERVAL_MS)
    }
    poll()
  })
}
