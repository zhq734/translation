import { BrowserWindow, screen } from 'electron'
import type { OcrPanelPinRequest } from '../shared/types'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'

/** 独立 OCR 结果窗口依赖。@author zhenghq */
interface OcrResultWindowDependencies {
  preloadPath: string
  loadPage: (win: BrowserWindow) => void
}

/** 独立结果的置顶意图、截图遮罩和交接回调。@author zhenghq */
interface OcrResultSession {
  payload: OcrPanelPinRequest
  pinned: boolean
  topOffset: number
  overlay: BrowserWindow | null
  nativeReady: boolean
  contentReady: boolean
  finishReady: () => void
  cancelReady: () => void
  detachOverlay: () => void
}

/** 校验窗口数据并限制尺寸，返回可安全使用的数据；参数为未知 IPC 负载。@author zhenghq */
function normalizePayload(value: unknown): OcrPanelPinRequest {
  const raw = value as Partial<OcrPanelPinRequest> | null
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 1_000_000 ||
      typeof raw.translation !== 'string' || raw.translation.length > 1_000_000 ||
      typeof raw.status !== 'string' || raw.status.length > 2000 || !raw.bounds ||
      ![raw.bounds.x, raw.bounds.y, raw.bounds.width, raw.bounds.height].every(Number.isFinite) ||
      raw.bounds.width <= 0 || raw.bounds.height <= 0) throw new Error('invalid-request')
  const area = screen.getDisplayMatching(raw.bounds).workArea
  const width = Math.min(area.width, Math.max(320, Math.round(raw.bounds.width)))
  const height = Math.min(area.height, Math.max(160, Math.round(raw.bounds.height)))
  return {
    text: raw.text, translation: raw.translation, status: raw.status,
    bounds: {
      x: Math.round(Math.max(area.x, Math.min(raw.bounds.x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(raw.bounds.y, area.y + area.height - height))),
      width, height
    }
  }
}

/** 创建不依赖截图会话的结果窗口管理器；参数为加载依赖，返回生命周期管理方法。@author zhenghq */
export function createOcrResultWindowManager(dependencies: OcrResultWindowDependencies) {
  const sessions = new Map<BrowserWindow, OcrResultSession>()

  /** 应用置顶意图并让结果高于截图遮罩；仅层级变化时写入原生状态。@param win 结果窗口。@param session 窗口状态。@returns 无返回值。@author zhenghq */
  function applyPinned(win: BrowserWindow, session: OcrResultSession): void {
    if (win.isDestroyed()) return
    const overlayVisible = session.overlay && !session.overlay.isDestroyed() && session.overlay.isVisible()
    const alwaysOnTop = session.pinned || Boolean(overlayVisible)
    const topOffset = overlayVisible ? 1 : 0
    if (win.isAlwaysOnTop() !== alwaysOnTop || session.topOffset !== topOffset) {
      win.setAlwaysOnTop(alwaysOnTop, 'screen-saver', topOffset)
      session.topOffset = topOffset
    }
    if (win.isVisible()) win.moveTop()
  }

  return {
    /** 创建独立置顶窗口并等待内容首帧，交接完成后才允许隐藏旧面板。@param value OCR 数据。@param overlay 来源截图窗口。@returns 显示完成状态。@author zhenghq */
    create(value: unknown, overlay: BrowserWindow | null = null): Promise<void> {
      if (sessions.size >= 20) throw new Error('ocr-window-limit')
      const payload = normalizePayload(value)
      const win = new BrowserWindow({
        ...payload.bounds, show: false, frame: false, resizable: true, movable: true,
        transparent: true, backgroundColor: '#00000000', hasShadow: false,
        minWidth: 320, minHeight: 160, alwaysOnTop: true, skipTaskbar: true,
        minimizable: false, maximizable: false, fullscreenable: false,
        webPreferences: { preload: dependencies.preloadPath, contextIsolation: true, nodeIntegration: false }
      })
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      let settled = false
      const timer = setTimeout(() => {
        session.cancelReady()
        if (!win.isDestroyed()) win.close()
      }, 10_000)
      const session: OcrResultSession = {
        payload, pinned: true, topOffset: -1, overlay, nativeReady: false, contentReady: false,
        /** 双方均就绪后显示结果并完成交接。@returns 无返回值。@author zhenghq */
        finishReady(): void {
          if (settled || !session.nativeReady || !session.contentReady || win.isDestroyed()) return
          settled = true
          clearTimeout(timer)
          win.showInactive()
          win.moveTop()
          resolveReady()
        },
        /** 创建失败时保留旧面板并终止交接等待。@returns 无返回值。@author zhenghq */
        cancelReady(): void {
          if (settled) return
          settled = true
          clearTimeout(timer)
          rejectReady(new Error('ocr-window-not-ready'))
        },
        /** 释放截图窗口的生命周期订阅。@returns 无返回值。@author zhenghq */
        detachOverlay(): void {
          overlay?.removeListener('hide', releaseOverlay)
          overlay?.removeListener('closed', releaseOverlay)
          overlay?.removeListener('focus', raiseAboveOverlay)
          session.overlay = null
        }
      }
      /** 截图退出后兑现取消置顶，不关闭或隐藏结果。@returns 无返回值。@author zhenghq */
      function releaseOverlay(): void {
        session.detachOverlay()
        applyPinned(win, session)
      }
      /** 点击截图空白处后恢复同层级前后次序；不聚焦、不显示隐藏结果。@returns 无返回值。@author zhenghq */
      function raiseAboveOverlay(): void {
        if (!win.isDestroyed() && win.isVisible()) applyPinned(win, session)
      }
      sessions.set(win, session)
      overlay?.on('hide', releaseOverlay)
      overlay?.on('closed', releaseOverlay)
      overlay?.on('focus', raiseAboveOverlay)
      win.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
      // macOS 高于遮罩一层；其它平台通过截图 focus 事件维持同层级前后次序。@author zhenghq
      applyPinned(win, session)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.on('closed', () => {
        session.cancelReady()
        session.detachOverlay()
        sessions.delete(win)
      })
      win.once('ready-to-show', () => { session.nativeReady = true; session.finishReady() })
      try {
        dependencies.loadPage(win)
      } catch {
        session.cancelReady()
        win.close()
      }
      return ready
    },
    /** 判断窗口是否归本管理器所有；参数为窗口，返回是否有效。@author zhenghq */
    ownsWindow(win: BrowserWindow): boolean { return sessions.has(win) && !win.isDestroyed() },
    /** 返回窗口初始化数据；参数为窗口，未登记时返回空值。@author zhenghq */
    getPayload(win: BrowserWindow): OcrPanelPinRequest | null { return sessions.get(win)?.payload ?? null },
    /** 标记原文、语言及主题已绘制；参数为结果窗口，无返回值。@author zhenghq */
    rendererReady(win: BrowserWindow): void {
      const session = sessions.get(win)
      if (!session) return
      session.contentReady = true
      session.finishReady()
    },
    /** 设置结果窗口置顶；参数为窗口和状态，无返回值。@author zhenghq */
    setPinned(win: BrowserWindow, pinned: boolean): void {
      const session = sessions.get(win)
      if (!session || win.isDestroyed()) return
      session.pinned = pinned
      applyPinned(win, session)
    },
    /** 校验手柄尺寸并基于当前边界缩放，保留移动后位置。@param win 结果窗口。@param value 目标逻辑尺寸。@returns 无返回值。@author zhenghq */
    resize(win: BrowserWindow, value: unknown): void {
      if (!sessions.has(win) || win.isDestroyed()) return
      const size = value as { width?: unknown; height?: unknown } | null
      if (!size || typeof size.width !== 'number' || typeof size.height !== 'number' ||
          !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return
      const bounds = win.getBounds()
      const area = screen.getDisplayMatching(bounds).workArea
      const maxWidth = Math.min(area.width, Math.max(320, area.x + area.width - bounds.x))
      const maxHeight = Math.min(area.height, Math.max(160, area.y + area.height - bounds.y))
      const width = Math.min(maxWidth, Math.max(320, Math.round(size.width)))
      const height = Math.min(maxHeight, Math.max(160, Math.round(size.height)))
      if (bounds.width !== width || bounds.height !== height) win.setBounds({ ...bounds, width, height })
    },
    /** 关闭一个结果窗口；参数为窗口，无返回值。@author zhenghq */
    close(win: BrowserWindow): void { if (sessions.has(win) && !win.isDestroyed()) win.close() },
    /** 释放全部结果窗口；无返回值。@author zhenghq */
    dispose(): void {
      for (const win of sessions.keys()) if (!win.isDestroyed()) win.close()
      sessions.clear()
    }
  }
}
