import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createSubtitleWindow } from '../src/main/subtitleWindow.ts'

/** 可观察的模拟 BrowserWindow。 */
class FakeWindow extends EventEmitter {
  /** 页面是否仍在加载。 */
  loading = true
  /** 当前是否可见。 */
  visible = false
  /** 窗口是否已销毁。 */
  destroyed = false
  /** 收到的 Renderer 消息。 */
  messages: Array<{ channel: string; payload: unknown }> = []
  /** 鼠标穿透状态。 */
  ignoreMouse = false
  /** 加载页面调用次数。 */
  loads = 0
  /** 窗口事件监听器。 */
  webContents = Object.assign(new EventEmitter(), {
    isLoading: () => this.loading,
    send: (channel: string, payload: unknown) => this.messages.push({ channel, payload }),
    setWindowOpenHandler: () => undefined
  })
  /** 当前窗口边界。 */
  bounds = { x: 0, y: 0, width: 800, height: 180 }
  /** 当前窗口屏幕坐标。 */
  position = { x: 0, y: 0 }

  /** 模拟窗口已就绪并触发事件。 */
  ready(): void {
    this.loading = false
    this.emit('ready-to-show')
    this.webContents.emit('did-finish-load')
  }

  /** 模拟窗口显示。 */
  showInactive(): void {
    this.visible = true
  }

  /** 模拟窗口隐藏。 */
  hide(): void {
    this.visible = false
  }

  /** 判断窗口是否可见。 */
  isVisible(): boolean {
    return this.visible
  }

  /** 判断窗口是否销毁。 */
  isDestroyed(): boolean {
    return this.destroyed
  }

  /** 模拟销毁。 */
  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }

  /** 记录鼠标穿透。 */
  setIgnoreMouseEvents(value: boolean): void {
    this.ignoreMouse = value
  }

  /** 忽略窗口层级设置。 */
  setAlwaysOnTop(): void {}

  /** 忽略跨工作区设置。 */
  setVisibleOnAllWorkspaces(): void {}

  /** 返回当前窗口边界。 */
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds }
  }

  /** 记录窗口移动后的屏幕坐标。 */
  setPosition(x: number, y: number): void {
    this.position = { x, y }
  }

  /** 判断屏幕坐标是否位于窗口内。 */
  containsPoint(x: number, y: number): boolean {
    return x >= this.position.x && x < this.position.x + this.bounds.width &&
      y >= this.position.y && y < this.position.y + this.bounds.height
  }
}

/**
 * 校验字幕窗在页面加载完成后补发最新视图和外观。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕窗页面加载前应缓存视图和外观并在完成后补发', () => {
  const created: FakeWindow[] = []
  const viewModel = {
    state: 'running' as const,
    displayMode: 'bilingual' as const,
    sourceText: 'Hello',
    translatedText: '你好',
    status: 'translated' as const,
    empty: false,
    error: ''
  }
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => viewModel,
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  controller.setAppearance({
    displayMode: 'target',
    fontSize: 28,
    textColor: '#abcdef',
    clickThrough: false
  })
  controller.render(viewModel)
  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  assert.equal(win.messages.length, 0)
  win.ready()
  assert.deepEqual(win.messages.map((message) => message.channel), [
    'subtitle:appearance',
    'subtitle:view-model'
  ])
  assert.equal(win.visible, true)
})

/**
 * 校验字幕窗不会把完全相同的视图模型重复发送到渲染进程。
 * @returns 无返回值。
 * @author zhenghq
 */
test('相同字幕视图模型不应重复发送到渲染进程', () => {
  const created: FakeWindow[] = []
  const viewModel = {
    state: 'running' as const,
    displayMode: 'bilingual' as const,
    sourceText: 'Hello',
    translatedText: '你好',
    status: 'translated' as const,
    audioActivity: 'speech-detected' as const,
    empty: false,
    error: ''
  }
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => viewModel,
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  win.ready()
  const initialCount = win.messages.filter((message) => message.channel === 'subtitle:view-model').length

  controller.render({ ...viewModel })
  controller.render({ ...viewModel })
  assert.equal(
    win.messages.filter((message) => message.channel === 'subtitle:view-model').length,
    initialCount,
    '相同视图模型不应产生额外 IPC'
  )

  controller.render({ ...viewModel, translatedText: '你好！' })
  assert.equal(
    win.messages.filter((message) => message.channel === 'subtitle:view-model').length,
    initialCount + 1
  )
  controller.dispose()
})

/**
 * 校验页面就绪前取消显示时，ready-to-show 不应重新弹出窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕窗就绪前取消显示应保持隐藏', () => {
  const created: FakeWindow[] = []
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  controller.setVisible(true)
  controller.setVisible(false)
  created[0]?.ready()
  assert.equal(created[0]?.visible, false)
})

/**
 * 校验字幕窗恢复上次位置，并在拖动或缩放后保存最新边界。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕窗应恢复上次位置并在移动后保存边界', () => {
  const created: FakeWindow[] = []
  const savedBounds: Array<{ x: number; y: number; width: number; height: number }> = []
  let windowOptions: Record<string, unknown> = {}
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: (options) => {
      windowOptions = options as Record<string, unknown>
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    loadBounds: () => ({ x: 320, y: 240, width: 900, height: 190 }),
    saveBounds: (bounds) => savedBounds.push(bounds)
  })

  controller.setVisible(true)
  assert.equal(windowOptions['x'], 320)
  assert.equal(windowOptions['y'], 240)
  assert.equal(windowOptions['width'], 900)
  assert.equal(windowOptions['height'], 190)

  const win = created[0]
  assert.ok(win)
  win.bounds = { x: 420, y: 300, width: 920, height: 200 }
  win.emit('move')
  controller.dispose()
  assert.deepEqual(savedBounds.at(-1), { x: 420, y: 300, width: 920, height: 200 })
})

/**
 * 校验点击穿透时仅当指针进入工具栏才临时接收鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕窗工具栏应能在点击穿透模式下临时接管鼠标事件', () => {
  const created: FakeWindow[] = []
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  assert.equal(win.ignoreMouse, true)
  controller.setMouseInteraction(true)
  assert.equal(win.ignoreMouse, false)
  controller.setMouseInteraction(false)
  assert.equal(win.ignoreMouse, true)
  controller.setAppearance({
    displayMode: 'bilingual',
    fontSize: 20,
    textColor: '#ffffff',
    clickThrough: false
  })
  assert.equal(win.ignoreMouse, true, '无法读取指针且卡片命中区未知时应保持透明外围可点击')
})

/**
 * 校验 Renderer 未发送释放消息时，指针离开工具栏后主进程会自动恢复点击穿透。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕窗指针离开工具栏后应自动恢复点击穿透', async () => {
  const created: FakeWindow[] = []
  let cursor = { x: 740, y: 20 }
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorPoint: () => cursor,
    pointerPollIntervalMs: 10,
    interactionReleaseDelayMs: 30
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  controller.setDragHitArea({ x: 700, y: 5, width: 100, height: 30 })
  controller.setMouseInteraction(true)
  assert.equal(win.ignoreMouse, false)

  cursor = { x: 100, y: 100 }
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(win.ignoreMouse, true, '指针离开工具栏后不应继续拦截全局点击')
  controller.dispose()
})

/**
 * 校验隐藏字幕窗时会清理临时鼠标接管状态，避免再次显示后继续拦截点击。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕窗隐藏时应恢复点击穿透', () => {
  const created: FakeWindow[] = []
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  controller.setMouseInteraction(true)
  assert.equal(win.ignoreMouse, false)

  controller.setVisible(false)
  assert.equal(win.ignoreMouse, true)
  controller.setVisible(true)
  assert.equal(win.ignoreMouse, true)
  controller.dispose()
})

/**
 * 校验拖拽手柄上报指针相对窗口的偏移时，窗口按偏移保持指针位置不变。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕窗拖动应按指针相对偏移移动窗口', () => {
  const created: FakeWindow[] = []
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  controller.moveWindow({
    screenX: 500,
    screenY: 300,
    pointerOffsetX: 20,
    pointerOffsetY: 10
  })
  assert.deepEqual(win.position, { x: 480, y: 290 })
})

/**
 * 校验点击穿透时主进程按 Renderer 上报的拖拽按钮矩形切换鼠标事件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('点击穿透时应按拖拽按钮真实矩形临时接收鼠标事件', () => {
  const created: FakeWindow[] = []
  let cursor = { x: 0, y: 0 }
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorPoint: () => cursor
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  win.bounds = { x: 100, y: 200, width: 800, height: 180 }
  assert.equal(win.ignoreMouse, true)

  controller.setDragHitArea({ x: 500, y: 60, width: 32, height: 32 })
  cursor = { x: 616, y: 276 }
  controller.pollPointerInteraction()
  assert.equal(win.messages.at(-1)?.channel, 'subtitle:pointer-point')
  assert.deepEqual(win.messages.at(-1)?.payload, { ...cursor, insideDragArea: true })
  assert.equal(win.ignoreMouse, false)

  controller.setAppearance({
    displayMode: 'bilingual',
    fontSize: 20,
    textColor: '#ffffff',
    clickThrough: true
  })
  controller.pollPointerInteraction()
  assert.equal(win.ignoreMouse, false, '设置同步后指针仍在拖拽区时应重新放行鼠标')

  cursor = { x: 100 + 800 - 24, y: 200 + 20 }
  controller.pollPointerInteraction()
  assert.deepEqual(win.messages.at(-1)?.payload, {
    ...cursor,
    insideDragArea: false
  })
  assert.equal(win.ignoreMouse, true, '右上角固定区域不应误判为拖拽按钮')
  controller.dispose()
})

/**
 * 校验关闭点击穿透后只有字幕卡片矩形拦截鼠标，窗口透明外围仍可穿透。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非点击穿透模式下透明外围不应拦截鼠标事件', () => {
  const created: FakeWindow[] = []
  let cursor = { x: 0, y: 0 }
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorPoint: () => cursor
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  win.bounds = { x: 100, y: 200, width: 800, height: 180 }
  controller.setAppearance({
    displayMode: 'bilingual',
    fontSize: 20,
    textColor: '#ffffff',
    clickThrough: false
  })
  assert.equal(win.ignoreMouse, true, '字幕卡片命中区尚未上报时应保持外围穿透')
  controller.setCardHitArea({ x: 40, y: 30, width: 720, height: 120 })

  cursor = { x: 120, y: 220 }
  controller.pollPointerInteraction()
  assert.equal(win.ignoreMouse, true, '字幕卡片以外的透明外围应放行鼠标')

  cursor = { x: 137, y: 250 }
  controller.pollPointerInteraction()
  assert.equal(win.ignoreMouse, true, '字幕卡片边界外 1 像素也不应拦截鼠标')

  cursor = { x: 141, y: 250 }
  controller.pollPointerInteraction()
  assert.equal(win.ignoreMouse, false, '字幕卡片内部应继续接收鼠标事件')
  controller.dispose()
})

/**
 * 校验点击穿透时主进程轮询到指针变化后向 Renderer 转发全局坐标。
 * @returns 无返回值。
 * @author zhenghq
 */
test('点击穿透时主进程应转发指针坐标供拖拽命中区判断', () => {
  const created: FakeWindow[] = []
  let cursor = { x: 0, y: 0 }
  const controller = createSubtitleWindow({
    preloadPath: '/preload.js',
    loadPage: () => undefined,
    getViewModel: () => ({
      state: 'idle',
      displayMode: 'bilingual',
      sourceText: '',
      translatedText: '',
      status: 'empty',
      audioActivity: 'idle',
      empty: true,
      error: ''
    }),
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    getDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorPoint: () => cursor
  })

  controller.setVisible(true)
  const win = created[0]
  assert.ok(win)
  assert.equal(win.ignoreMouse, true)

  cursor = { x: win.position.x + 10, y: win.position.y + 10 }
  controller.pollPointerInteraction()
  assert.equal(win.messages.at(-1)?.channel, 'subtitle:pointer-point')
  assert.deepEqual(win.messages.at(-1)?.payload, { ...cursor, insideDragArea: false })
  assert.equal(win.ignoreMouse, true)
  controller.dispose()
})
