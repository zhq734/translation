import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

/**
 * 读取指定浮层的源码；参数为入口名称和文件类型，返回源码文本。
 * @param name 浮层入口名称。
 * @param kind HTML、CSS 或业务脚本。
 * @returns 源码文本。
 * @author zhenghq
 */
function readOverlay(name: string, kind: 'html' | 'css' | 'ts'): string {
  return readFileSync(`src/renderer/${kind === 'html' ? '' : 'src/'}${name}.${kind}`, 'utf8')
}

/**
 * 提取含指定选择器的第一个规则，避免跨规则正则误命中。
 * @param css 样式源码。
 * @param selector 完整选择器。
 * @returns 规则声明文本。
 * @author zhenghq
 */
function rule(css: string, selector: string): string {
  const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)
  for (const match of rules) {
    if (match[1].split(',').some((item) => item.trim() === selector)) return match[2]
  }
  assert.fail(`缺少样式规则 ${selector}`)
}

/**
 * 验证入口仍保留业务绑定、国际化初始化与显式隐藏语义；无参数、无返回值。
 * @author zhenghq
 */
test('Quiet Studio 浮层保留全部业务绑定和初始化顺序', () => {
  for (const name of ['selection', 'subtitle', 'pin', 'toast']) {
    const html = readOverlay(name, 'html')
    const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1])
    assert.equal(new Set(ids).size, ids.length, `${name} 存在重复 ID`)
    for (const match of readOverlay(name, 'ts').matchAll(/getElementById\('([^']+)'\)/gu)) {
      assert.ok(ids.includes(match[1]), `${name} 缺少功能 ID ${match[1]}`)
    }
    assert.ok(html.indexOf('localeBootstrap.js') < html.indexOf('./src/theme.css'))
    assert.ok(html.indexOf('themeBootstrap.js') < html.indexOf('./src/theme.css'))
    assert.ok(html.indexOf('./src/base.css') < html.indexOf(`./src/${name}.css`))
    assert.doesNotMatch(readOverlay(name, 'css'), /#[\da-f]{3,8}\b|rgba?\(|hsla?\(|backdrop-filter/iu)
  }
  for (const [name, ids] of [
    ['selection', ['ocr-overlay', 'ocr-snapshot', 'ocr-selection-box', 'ocr-toolbar', 'ocr-panel', 'ocr-tooltip', 'ocr-text-input']],
    ['subtitle', ['subtitle-history', 'subtitle-error']]
  ] as const) {
    for (const id of ids) assert.match(readOverlay(name, 'html'), new RegExp(`id="${id}"[^>]*\\bhidden\\b`, 'u'))
  }
})

/**
 * 验证工具分组与选中反馈，不改变固定定位、工具尺寸和画布命中；无参数、无返回值。
 * @author zhenghq
 */
test('Quiet Studio 截图工具使用中性分组和清晰选中态并保留测量契约', () => {
  const css = readOverlay('selection', 'css')
  const toolbar = rule(css, '.ocr-toolbar')
  assert.match(toolbar, /position:\s*fixed/u)
  assert.match(toolbar, /width:\s*max-content/u)
  assert.match(toolbar, /flex-wrap:\s*wrap/u)
  assert.match(toolbar, /gap:\s*8px/u)
  assert.match(toolbar, /padding:\s*6px/u)
  assert.match(toolbar, /border-radius:\s*var\(--radius-window\)/u)
  assert.match(toolbar, /background:\s*var\(--panel-bg\)/u)
  const button = rule(css, '.ocr-toolbar button')
  assert.match(button, /width:\s*36px/u)
  assert.match(button, /height:\s*36px/u)
  assert.match(button, /border:\s*1px solid transparent/u)
  assert.match(rule(css, '.ocr-toolbar-group + .ocr-toolbar-group'), /border-left:\s*1px solid var\(--border-subtle\)/u)
  assert.match(rule(css, ".ocr-toolbar button[aria-pressed='true']"), /background:\s*var\(--accent-soft\)/u)
  assert.match(rule(css, '#ocr-recognize'), /background:\s*var\(--button-bg\)/u)
  assert.match(rule(css, '.ocr-snapshot'), /position:\s*fixed;\s*inset:\s*0;\s*width:\s*100%;\s*height:\s*100%;\s*pointer-events:\s*none/u)
  assert.match(rule(css, '.ocr-selection-box'), /border:\s*2px solid var\(--button-bg\)/u)
  assert.match(rule(css, '.ocr-resize-handle'), /width:\s*10px;\s*height:\s*10px/u)
  assert.match(rule(css, '.ocr-annotation-resize-handle'), /width:\s*9px;\s*height:\s*9px/u)
  assert.match(rule(css, '#translate'), /width:\s*32px;\s*height:\s*32px/u)
})

/**
 * 验证 OCR 阅读区和通知共享精简提示，保留面板滚动与定位尺寸；无参数、无返回值。
 * @author zhenghq
 */
test('Quiet Studio OCR 结果清晰可读且提示保持轻量胶囊', () => {
  const css = readOverlay('selection', 'css')
  const panel = rule(css, '.ocr-panel')
  assert.match(panel, /width:\s*clamp\(180px, 24vw, 320px\)/u)
  assert.match(panel, /border-radius:\s*var\(--radius-window\)/u)
  assert.match(panel, /background:\s*var\(--panel-bg\)/u)
  const text = rule(css, '.ocr-panel-text')
  for (const pattern of [/min-height:\s*0/u, /overflow:\s*auto/u, /user-select:\s*text/u,
    /font-size:\s*var\(--font-size-body\)/u, /line-height:\s*var\(--reading-line-height\)/u,
    /color:\s*var\(--text-reading\)/u, /background:\s*var\(--surface-subtle\)/u]) assert.match(text, pattern)
  assert.match(readOverlay('selection', 'html'), /id="ocr-panel-text"[^>]*aria-describedby="ocr-panel-status"/u)
  for (const [name, selector] of [['selection', '.ocr-tip'], ['toast', '.screenshot-toast']]) {
    const capsule = rule(readOverlay(name, 'css'), selector)
    assert.match(capsule, /background:\s*var\(--hint-pill-bg\)/u)
    assert.match(capsule, /color:\s*var\(--hint-pill-text\)/u)
    assert.match(capsule, /line-height:\s*1\.5/u)
    assert.doesNotMatch(capsule, /box-shadow/u)
  }
})

/**
 * 验证字幕译文优先、工具悬停与焦点可见及不依赖模糊的背景；无参数、无返回值。
 * @author zhenghq
 */
test('Quiet Studio 字幕译文优先且键盘可见，穿透模式仍有可读背景', () => {
  const css = readOverlay('subtitle', 'css')
  assert.match(rule(css, '.subtitle-card'), /background:\s*var\(--subtitle-surface\)/u)
  assert.match(rule(css, '.subtitle-card'), /max-height:\s*100%/u)
  assert.match(rule(css, '.subtitle-line'), /flex-shrink:\s*0/u)
  assert.match(rule(css, '.subtitle-target'), /font-size:\s*var\(--subtitle-font-size, 20px\)/u)
  assert.match(rule(css, '.subtitle-source'), /font-size:\s*calc\(var\(--subtitle-font-size, 20px\) \* 0\.85\)/u)
  assert.match(rule(css, '.subtitle-source'), /color:\s*var\(--subtitle-secondary\)/u)
  assert.match(rule(css, '.subtitle-target'), /var\(--subtitle-text-color,/u)
  assert.match(rule(css, '.subtitle-history-target'), /text-shadow:[^;]*var\(--subtitle-outline\)/u)
  assert.match(rule(css, '.subtitle-toolbar'), /inset-block-start:\s*calc\(0px - var\(--control-height-compact\) - var\(--space-2\)\)/u)
  assert.match(rule(css, '.subtitle-root'), /padding-block-start:\s*calc\(var\(--control-height-compact\) \+ var\(--space-4\)\)/u)
  assert.doesNotMatch(rule(css, '.subtitle-history'), /opacity:/u)
  assert.match(css, /\.subtitle-history\s*\{[^}]*overflow:\s*hidden/u)
  assert.match(css, /\.subtitle-live\s*\{[^}]*min-height:\s*calc\(var\(--subtitle-font-size, 20px\) \* 1\.5\)/u)
  assert.match(rule(css, '.subtitle-toolbar'), /opacity:\s*0;\s*pointer-events:\s*none/u)
  for (const selector of ['.subtitle-card:hover .subtitle-toolbar', '.subtitle-card:focus-within .subtitle-toolbar', '.subtitle-toolbar:focus-within']) {
    const visible = rule(css, selector)
    assert.match(visible, /opacity:\s*1/u)
    assert.match(visible, /pointer-events:\s*auto/u)
  }
  assert.match(rule(css, ".subtitle-root[data-click-through='true'] .subtitle-card"), /background:\s*var\(--subtitle-overlay-bg\)/u)
  assert.doesNotMatch(css, /data-click-through='true'\] \.subtitle-line/u)
  assert.match(rule(css, ":root[data-win7-compatibility='true'] .subtitle-card"), /background:\s*var\(--subtitle-surface\)/u)
  assert.match(css, /prefers-reduced-motion:\s*reduce/u)
  assert.match(css, /\.subtitle-target-lang:focus-visible/u)
  assert.match(readOverlay('subtitle', 'html'), /id="subtitle-toolbar"[^>]*role="group"/u)
})

/** 验证穿透字幕统一底板、历史层次及矮窗口优先级；无参数、无返回值。@author zhenghq */
test('Quiet Studio 穿透字幕：紧凑统一底板，不绘制逐行黑条或卡片外框', () => {
  const css = readOverlay('subtitle', 'css')
  const card = rule(css, ".subtitle-root[data-click-through='true'] .subtitle-card")
  assert.match(card, /width:\s*fit-content/u)
  assert.match(card, /border-color:\s*transparent/u)
  assert.match(css, /\.subtitle-history\s*\{[^}]*border-block-end:[^;]*var\(--subtitle-divider\)/u)
  assert.match(rule(css, '.subtitle-history .subtitle-line'), /text-overflow:\s*ellipsis/u)
  assert.match(css, /@media \(max-height: 180px\)[\s\S]*data-click-through='true'\] \.subtitle-history\s*\{[^}]*display:\s*none/u)
  assert.match(rule(css, ".subtitle-root[data-click-through='true'] .subtitle-live"), /scrollbar-width:\s*none/u)
})

/**
 * 验证贴图无新增装饰，通知自适应且 Win7/隐藏/减少动态降级有效；无参数、无返回值。
 * @author zhenghq
 */
test('Quiet Studio 贴图保持纯图片，Toast 与旧平台降级兼容', () => {
  const pin = readOverlay('pin', 'html')
  assert.doesNotMatch(pin, /<(?:button|nav|header|footer)\b/u)
  const pinCss = readOverlay('pin', 'css')
  assert.match(rule(pinCss, '.pin-root'), /background:\s*transparent/u)
  assert.match(rule(pinCss, '.pin-image'), /object-fit:\s*contain/u)
  assert.match(rule(pinCss, ".pin-root[data-bordered='true']"), /var\(--border-default\)/u)
  const toast = readOverlay('toast', 'html')
  assert.match(toast, /name="viewport"/u)
  assert.match(toast, /id="toast"[^>]*aria-atomic="true"/u)
  assert.match(rule(readOverlay('toast', 'css'), '#toast-message'), /min-width:\s*0/u)
  for (const name of ['selection', 'pin', 'toast']) assert.match(readOverlay(name, 'css'), /data-win7-compatibility='true'/u)
  assert.match(rule(readOverlay('selection', 'css'), ":root[data-win7-compatibility='true'][data-ocr-mode='true'] body"), /background:\s*transparent/u)
  assert.match(rule(readOverlay('toast', 'css'), ":root[data-win7-compatibility='true'] .screenshot-toast"), /background:\s*var\(--panel-bg\)/u)
  assert.match(rule(readOverlay('pin', 'css'), ":root[data-win7-compatibility='true'] .pin-root[data-bordered='true']"), /box-shadow:\s*none/u)
})

/**
 * 用真实 HTML/CSS 独立组合窗口、明暗、穿透、兼容模式、字幕轨道和长短内容，验证布局而非匹配源码。
 * 设置 QUIET_STUDIO_BROWSER=1 启用；复用项目已有 agent-browser-cli，不启动 Electron 业务。
 * 无参数，无返回值。
 * @author zhenghq
 */
test('Quiet Studio 字幕实际布局：统一底板、独立主题与穿透、紧凑窗口和长文滚动', {
  skip: process.env.QUIET_STUDIO_BROWSER !== '1'
}, async () => {
  const run = promisify(execFile)
  /** 执行浏览器命令；参数为命令及参数列表，返回已解析的结果。@author zhenghq */
  async function browser(...args: string[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const { stdout } = await run('agent-browser-cli', args, { maxBuffer: 4 * 1024 * 1024, timeout: 20000 })
      const result = JSON.parse(stdout)
      if (result.ok === false && String(result.error).includes('未连接') && attempt < 30) {
        await delay(100)
        continue
      }
      assert.notEqual(result.ok, false, stdout)
      return result.result ?? result
    }
  }
  /** 提供测试 iframe、实际字幕 DOM 与共享样式；参数为请求和响应，无返回值。@author zhenghq */
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><iframe id="preview" src="/subtitle" style="width:360px;height:120px;border:0"></iframe>')
    } else if (path === '/subtitle') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(readOverlay('subtitle', 'html').replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''))
    } else if (['/src/theme.css', '/src/base.css', '/src/subtitle.css'].includes(path)) {
      response.setHeader('Content-Type', 'text/css')
      response.end(readFileSync(`src/renderer${path}`, 'utf8'))
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let tab: string | undefined
  try {
    const address = server.address() as { port: number }
    const opened = await browser('open', `http://127.0.0.1:${address.port}`, '--group-title', 'T2-subtitle-regression')
    assert.ok(opened.opened_tab_id, JSON.stringify(opened))
    tab = String(opened.opened_tab_id)
    const result = await browser('exec', '--tab', tab, `
      const frame = document.getElementById('preview');
      if (frame.contentDocument.readyState !== 'complete') {
        await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
      }
      const previewDocument = frame.contentDocument, win = frame.contentWindow;
      const root = previewDocument.getElementById('subtitle-root');
      root.dataset.empty = 'false';
      root.style.setProperty('--subtitle-font-size', '20px');
      const history = previewDocument.getElementById('subtitle-history');
      const source = previewDocument.getElementById('subtitle-source'), target = previewDocument.getElementById('subtitle-target');
      const historySource = previewDocument.getElementById('subtitle-history-source');
      const historyTarget = previewDocument.getElementById('subtitle-history-target');
      const card = previewDocument.querySelector('.subtitle-card');
      const live = previewDocument.querySelector('.subtitle-live'), toolbar = previewDocument.getElementById('subtitle-toolbar');
      /** 将主题色值解析为实际颜色；参数为颜色，返回浏览器计算值。@author zhenghq */
      function resolvedColor(value) {
        const probe = previewDocument.createElement('span');
        probe.style.color = value;
        root.append(probe);
        const color = win.getComputedStyle(probe).color;
        probe.remove();
        return color;
      }
      /** 计算裁切区域中的可见矩形；参数为元素和裁切矩形，返回相交边界。@author zhenghq */
      function clippedBox(element, clip) {
        const box = element.getBoundingClientRect();
        return {top: Math.max(box.top, clip.top, 0), bottom: Math.min(box.bottom, clip.bottom, win.innerHeight)};
      }
      /** 检查指定字符是否完整处于字幕裁切区域内；参数为元素和字符偏移，返回可见性。@author zhenghq */
      function glyphVisible(element, offset) {
        const range = previewDocument.createRange();
        range.setStart(element.firstChild, offset);
        range.setEnd(element.firstChild, offset + 1);
        const glyph = range.getBoundingClientRect();
        return glyph.width > 0 && glyph.height > 0 && [root, card, live, element].every(ancestor => {
          const box = ancestor.getBoundingClientRect();
          return glyph.left >= Math.max(box.left, 0) - 1 && glyph.right <= Math.min(box.right, win.innerWidth) + 1
            && glyph.top >= Math.max(box.top, 0) - 1 && glyph.bottom <= Math.min(box.bottom, win.innerHeight) + 1;
        });
      }
      const results = [];
      for (const [width, height] of [[360,120], [800,130], [360,240], [800,300]]) {
        for (const mode of ['light', 'dark']) for (const clickThrough of [false, true])
        for (const win7 of [false, true]) for (const content of ['compact', 'short', 'long', 'unbroken'])
        for (const historyContent of ['none', 'short', 'long']) for (const displayMode of ['bilingual', 'target']) {
          frame.style.width = width + 'px'; frame.style.height = height + 'px';
          previewDocument.documentElement.dataset.themeMode = mode;
          previewDocument.documentElement.dataset.win7Compatibility = String(win7);
          root.dataset.clickThrough = String(clickThrough);
          root.dataset.displayMode = displayMode;
          const customColor = ['compact', 'short'].includes(content) ? '#ffd166' : '#7ee7ff';
          root.style.setProperty('--subtitle-text-color', customColor);
          source.textContent = content === 'compact' ? 'Hi.' : content === 'short' ? 'Current short sentence.' : content === 'long'
            ? 'Current sentence with many words. '.repeat(40) : 'UnbrokenSource'.repeat(100);
          target.textContent = content === 'compact' ? '你好。' : content === 'short' ? '当前实时译文。' : content === 'long'
            ? '当前实时译文，最后一行仍应完整可读。'.repeat(40) : 'UnbrokenTranslation'.repeat(100);
          history.hidden = historyContent === 'none';
          historySource.textContent = historyContent === 'none' ? '' : 'Previous sentence. '.repeat(historyContent === 'long' ? 40 : 1);
          historyTarget.textContent = historyContent === 'none' ? '' : '上一句译文。'.repeat(historyContent === 'long' ? 40 : 1);
          // 对齐视图模型：仅译文模式会清空原文，不在测试中额外注入隐藏样式。@author zhenghq
          if (displayMode === 'target') { source.textContent = ''; historySource.textContent = ''; }
          // 对齐业务 updateText 的自动滚底；同时验证顶部可达，不能用裁切替代内部滚动。@author zhenghq
          live.scrollTop = 0;
          const topTargetBox = target.getBoundingClientRect();
          const firstGlyphVisible = glyphVisible(displayMode === 'target' ? target : source, 0);
          live.scrollTop = live.scrollHeight;
          const liveBox = live.getBoundingClientRect(), targetBox = target.getBoundingClientRect();
          const cardBox = card.getBoundingClientRect(), rootBox = root.getBoundingClientRect();
          const historyBox = history.getBoundingClientRect();
          const targetVisible = clippedBox(target, liveBox);
          const historyVisible = clippedBox(historyTarget, historyBox);
          const historyClipped = ['hidden', 'auto', 'scroll', 'clip'].includes(win.getComputedStyle(history).overflowY);
          const visibleTargetHeight = Math.max(0, targetVisible.bottom - targetVisible.top);
          const overlap = Math.max(0, Math.min(historyVisible.bottom, liveBox.bottom) - Math.max(historyVisible.top, liveBox.top));
          const cardStyle = win.getComputedStyle(card), rootStyle = win.getComputedStyle(root);
          const expectedBackground = resolvedColor(rootStyle.getPropertyValue(clickThrough && !win7 ? '--subtitle-overlay-bg' : '--subtitle-surface'));
          const expectedColor = resolvedColor(customColor);
          const lines = [source, target, historySource, historyTarget];
          const transparentLayers = [previewDocument.documentElement, previewDocument.body, root, history, live, ...lines].map(element => {
            const style = win.getComputedStyle(element);
            return {id: element.id || element.className || element.tagName,
              background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow};
          });
          const horizontalOverflow = [previewDocument.documentElement, previewDocument.body, root, card, live]
            .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.id || element.className || element.tagName);
          const clippedLiveLines = [source, target].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.id);
          const lineStyles = lines.map(element => win.getComputedStyle(element));
          // 仅验证布局，不抢占其他浏览器回归任务的焦点；可见状态走原有业务标记。@author zhenghq
          root.dataset.toolbarVisible = 'true';
          const toolbarBox = toolbar.getBoundingClientRect();
          const naturalLiveHeight = source.getBoundingClientRect().height + targetBox.height
            + (displayMode === 'bilingual' ? parseFloat(win.getComputedStyle(live).rowGap) : 0);
          const cardInsets = parseFloat(cardStyle.paddingTop) + parseFloat(cardStyle.paddingBottom)
            + parseFloat(cardStyle.borderTopWidth) + parseFloat(cardStyle.borderBottomWidth);
          results.push({width, height, mode, clickThrough, win7, content, historyContent, displayMode, viewport: [win.innerWidth, win.innerHeight],
            liveHeight: liveBox.height, targetHeight: targetBox.height, visibleTargetHeight,
            firstGlyphVisible, lastGlyphVisible: glyphVisible(target, target.textContent.length - 1),
            lineHeight: parseFloat(win.getComputedStyle(target).lineHeight),
            historyHeight: historyBox.height, historyClipped, overlap, horizontalOverflow, clippedLiveLines,
            historyTargetHeight: historyTarget.getBoundingClientRect().height,
            visibleHistoryTargetHeight: Math.max(0, historyVisible.bottom - historyVisible.top),
            cardWidth: cardBox.width, rootWidth: rootBox.width, cardHeight: cardBox.height, naturalLiveHeight, cardInsets,
            cardInside: cardBox.left >= 0 && cardBox.right <= width && cardBox.top >= 0 && cardBox.bottom <= height,
            scrollable: live.scrollHeight > live.clientHeight && live.scrollTop > 0,
            scrolledDistance: topTargetBox.top - targetBox.top,
            targetBottomVisible: targetBox.bottom <= liveBox.bottom + 1 && targetBox.bottom <= height,
            overflowY: win.getComputedStyle(live).overflowY,
            background: cardStyle.backgroundColor, expectedBackground,
            borderColors: [cardStyle.borderTopColor, cardStyle.borderRightColor, cardStyle.borderBottomColor, cardStyle.borderLeftColor],
            radius: cardStyle.borderTopLeftRadius, shadow: cardStyle.boxShadow, transparentLayers,
            targetColors: [lineStyles[1].color, lineStyles[3].color], expectedColor,
            targetVisible: [root, card, live, target].every(element => {
              const style = win.getComputedStyle(element);
              return style.display !== 'none' && style.visibility === 'visible' && style.opacity === '1';
            }),
            targetOutlines: [lineStyles[1].textShadow, lineStyles[3].textShadow],
            historyEllipsis: [lineStyles[2], lineStyles[3]].every(style => style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis' && style.overflowX === 'hidden'),
            scrollbarHidden: win.getComputedStyle(live).scrollbarWidth === 'none' || win.getComputedStyle(live, '::-webkit-scrollbar').display === 'none',
            toolbarInside: toolbarBox.top >= 0 && toolbarBox.bottom <= height && toolbarBox.left >= 0 && toolbarBox.right <= width});
          root.dataset.toolbarVisible = 'false';
        }
      }
      return results;
    `)
    const measurements = result.js_return
    assert.ok(Array.isArray(measurements), JSON.stringify(result))
    assert.equal(measurements.length, 768, '必须覆盖完整独立组合，不能把明暗与穿透绑定')
    const combinations = measurements.map((item) => [item.width, item.height, item.mode, item.clickThrough,
      item.win7, item.content, item.historyContent, item.displayMode].join('/'))
    assert.equal(new Set(combinations).size, 768, '不能用重复场景凑足矩阵数量')
    const failures: string[] = []
    for (const item of measurements) {
      try {
        assert.deepEqual(item.viewport, [item.width, item.height], 'iframe 必须使用指定窗口尺寸')
        assert.ok(item.cardInside, '统一底板必须留在窗口内')
        assert.deepEqual(item.horizontalOverflow, [], '字幕不能横向溢出')
        assert.deepEqual(item.clippedLiveLines, [], '实时字幕必须换行，不能用隐藏横向内容伪装无溢出')
        assert.ok(item.liveHeight >= item.lineHeight, '实时区域不足一行')
        assert.ok(item.visibleTargetHeight >= Math.min(item.targetHeight, item.lineHeight) - 1, '实时译文至少完整显示末行')
        assert.ok(item.targetBottomVisible, '实时译文末行必须滚动到可见区域')
        assert.ok(item.firstGlyphVisible, '字幕开头文字必须可滚动到完整可见')
        assert.ok(item.lastGlyphVisible, '实时译文末尾字符必须真实可见，不能只检查容器矩形')
        assert.ok(item.targetVisible, '实时译文及其容器不能透明或隐藏')
        assert.equal(item.historyClipped, true, '历史必须限制自身溢出')
        assert.equal(item.overlap, 0, '历史覆盖实时译文')
        assert.equal(item.historyEllipsis, true, '历史行必须省略而非换行挤压实时字幕')
        assert.equal(item.toolbarInside, true, '显示工具栏时必须留在窗口内')
        assert.equal(item.background, item.expectedBackground, '底板必须使用对应背景 token')
        assert.equal(item.shadow, 'none', '不能绘制空外框阴影')
        assert.deepEqual(item.targetColors, [item.expectedColor, item.expectedColor], '实时及历史译文必须保留用户字色')
        assert.ok(item.targetOutlines.every((outline: string) => outline !== 'none'), '保留细描边保护用户字色对比')
        for (const layer of item.transparentLayers) {
          assert.equal(layer.background, 'rgba(0, 0, 0, 0)', `${layer.id} 不能绘制逐行背景或外围底色`)
          assert.equal(layer.image, 'none', `${layer.id} 不能叠加背景图`)
          assert.equal(layer.shadow, 'none', `${layer.id} 不能叠加底板阴影`)
        }
        if (item.historyContent === 'none' || (item.clickThrough && item.height <= 180)) {
          assert.equal(item.historyHeight, 0, '无历史或穿透矮窗不能留下历史占位')
        } else if (item.height === 300 && ['compact', 'short'].includes(item.content)) {
          if (item.displayMode === 'bilingual') assert.ok(item.historyHeight >= 40, '双语常规高度仍应显示两行历史')
          assert.ok(item.historyTargetHeight > 0 && item.visibleHistoryTargetHeight >= item.historyTargetHeight - 1,
            '常规高度必须完整显示历史译文，不能以容器占位代替可见文字')
        }
        if (item.win7) {
          assert.equal(item.radius, '0px', 'Win7 保留无圆角回退')
          assert.match(item.background, /^rgb\(/u, 'Win7 保留不依赖透明合成的实色底板')
        }
        if (['long', 'unbroken'].includes(item.content)) {
          assert.equal(item.overflowY, 'auto', '长字幕必须保留内部滚动')
          assert.ok(item.scrollable && item.scrolledDistance > 0, '长字幕必须真正可以从顶部滚动到底部')
        }
        if (item.clickThrough) {
          assert.deepEqual(item.borderColors, Array(4).fill('rgba(0, 0, 0, 0)'), '穿透底板不能绘制外框')
          assert.equal(item.scrollbarHidden, true, '穿透时不显示不可操作的滚动条')
          if (!item.win7) {
            assert.match(item.background, /^rgba\(/u, '穿透底板必须半透明')
            const alpha = Number(item.background.match(/,\s*([\d.]+)\)$/u)?.[1])
            assert.ok(alpha > 0 && alpha < 1, '穿透底板透明度必须在 0 与 1 之间')
          }
          if (item.content === 'compact' && item.historyContent === 'none') {
            assert.ok(item.cardWidth < item.rootWidth / 2, '短句底板必须紧凑，不能撑满窗口')
            assert.ok(item.cardHeight <= item.naturalLiveHeight + item.cardInsets + 1, '短句底板高度必须贴合内容，不能留下空底板')
          }
        }
      } catch (error) {
        failures.push(`${(error as Error).message}：${JSON.stringify(item)}`)
      }
    }
    console.log(`字幕真实浏览器矩阵：${measurements.length} 组，失败 ${failures.length} 组；仅验证渲染，不验证系统穿透或 Win7 内核。`)
    assert.deepEqual(failures, [], '字幕浏览器布局回归失败')
  } finally {
    try {
      if (tab) await browser('close', '--tab', tab)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})
