import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { bindPopupMenu } from '../src/renderer/src/popupMenu'
import { enUSBase } from '../src/shared/i18n/catalog.en-US.base'
import { zhCNBase } from '../src/shared/i18n/catalog.zh-CN.base'

const html = readFileSync('src/renderer/index.html', 'utf8')
const css = readFileSync('src/renderer/src/style.css', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

/**
 * 提取组件原始规则，避免测试被末尾重复覆盖样式误导。
 * @param selector 精确 CSS 选择器。
 * @returns 对应规则体。
 * @author zhenghq
 */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`) + 1
  assert.ok(start > 0, `缺少 ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

/** 验证阅读卡主次层级与主题契约；无参数、无返回值。@author zhenghq */
test('静阅读卡：译文 16px/1.75，原文次级，窗口一致裁切且不硬编码颜色', () => {
  for (const selector of ['.result', '.manual-result']) {
    assert.match(rule(selector), /font-size: 16px;/u)
    assert.match(rule(selector), /line-height: var\(--reading-line-height, 1\.75\);/u)
    assert.match(rule(selector), /color: var\(--text-reading\);/u)
    assert.match(rule(selector), /overflow-y: auto;/u)
  }
  assert.match(rule('.original'), /color: var\(--text-secondary\);/u)
  assert.match(rule('#popup'), /border-radius: var\(--radius-window\);/u)
  assert.match(rule('#popup'), /clip-path: inset\(0 round var\(--radius-window\)\);/u)
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/iu)
})

/** 验证所有原入口与国际化标签都可达；无参数、无返回值。@author zhenghq */
test('静阅导航：文字入口常驻，次级菜单初始隐藏且沿用既有动作 ID 和 i18n', () => {
  const originalIds = [
    'popup', 'status', 'translation-provider', 'manual-mode', 'open-history',
    'open-web-reader', 'open-document-translation', 'open-settings', 'close',
    'selection-view', 'source-section-head', 'read-original', 'original',
    'pronunciation-card', 'pronunciation-word', 'pronunciation-close', 'pronunciation-variants',
    'ocr-source', 'ocr-source-label', 'ocr-engine-badge', 'ocr-copy', 'ocr-source-text',
    'result', 'translation-pronunciation-card', 'manual-view', 'manual-clear', 'manual-source',
    'manual-hint', 'manual-count', 'manual-submit', 'manual-stale', 'manual-result',
    'history-view', 'history-clear-unfavorited', 'history-search', 'history-list', 'history-empty',
    'speak', 'speak-label', 'source-lang', 'target-lang', 'copy', 'manual-copy', 'pin', 'pin-label'
  ]
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/gu), (match) => match[1])
  assert.equal(new Set(ids).size, ids.length, '不得重复已有 ID')
  for (const id of originalIds) assert.ok(ids.includes(id), `不得移除原有 ID：${id}`)
  const menu = html.slice(html.indexOf('id="popup-menu"'), html.indexOf('</header>'))
  assert.match(html, /id="popup-menu-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="popup-menu"/u)
  assert.match(menu, /^id="popup-menu"[^>]*hidden/u)
  for (const id of ['open-web-reader', 'open-document-translation', 'open-settings']) {
    assert.match(menu, new RegExp(`id="${id}"[^>]*type="button"`, 'u'))
  }
  for (const [id, key] of [['manual-mode', 'popup.manualTranslation'], ['open-history', 'popup.openHistory']]) {
    const button = html.match(new RegExp(`<button id="${id}"[\\s\\S]*?</button>`, 'u'))?.[0] ?? ''
    assert.match(button, new RegExp(`<span[^>]*data-i18n="${key}"`, 'u'))
    assert.equal(menu.includes(`id="${id}"`), false)
  }
  assert.match(html, /class="translation-context"[\s\S]*?id="source-lang"[\s\S]*?id="translation-provider"/u)
  for (const id of ['copy', 'pin', 'speak', 'manual-copy']) {
    assert.equal(menu.includes(`id="${id}"`), false)
    assert.match(html, new RegExp(`id="${id}"`, 'u'))
  }
  assert.match(renderer, /bindPopupMenu\(/u)
})

/** 验证隐藏优先级、自动测量和固定上下布局；无参数、无返回值。@author zhenghq */
test('静阅布局：手动始终上下排列，隐藏态不被布局覆盖且测量可展开', () => {
  assert.match(html, /class="manual-source-section"[\s\S]*?id="manual-source"/u)
  assert.match(rule('.manual-view'), /display: grid;/u)
  assert.match(rule('.manual-view'), /grid-template-columns: minmax\(0, 1fr\);/u)
  assert.doesNotMatch(css, /@media \(min-width: 600px\), \(max-height: 480px\)/u)
  assert.match(rule('.manual-source-section'), /min-height: 0;/u)
  assert.match(rule('.manual-view'), /overflow-y: auto;/u)
  assert.match(rule('.manual-view'), /grid-template-rows: repeat\(2, minmax\(min-content, 1fr\)\);/u)
  assert.match(rule('#manual-source'), /min-height: 5em;/u)
  assert.match(css, /#popup \[hidden\]:not\(\.speak-stop-icon\)\s*\{\s*display: none !important;/u)
  assert.match(css, /#speak\[aria-pressed='true'\] \.speak-stop-icon\s*\{\s*display: block !important;/u)
  assert.match(css, /#popup\.auto-size-measuring \.manual-source-section/u)
  assert.match(rule('.selection-view'), /overflow: hidden;/u)
  assert.match(rule('.translation-section-source'), /flex: 0 1 auto;/u)
  assert.match(rule('.original'), /min-height: 0;/u)
  assert.match(css, /@media \(max-height: 400px\)/u)
  assert.match(rule('.history-list'), /overflow-y: auto;/u)
  assert.match(rule('.history-item'), /border-bottom: 1px solid var\(--border-subtle\);/u)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u)
  assert.match(renderer, /function handlePopupHidden\(\): void \{\s*popupMenu\.close\(\)/u)
})

/** 验证模式切换不隐藏导航图标，窄窗通过文字换行释放空间；无参数、无返回值。@author zhenghq */
test('静阅导航：手动、历史与划词模式始终使用同一组可见图标', () => {
  assert.doesNotMatch(css, /\.mode-action \.header-action-icon\s*\{[^}]*display: none/u)
  assert.match(rule('.header-action-icon'), /flex: 0 0 auto;/u)
  assert.match(rule('.header-actions'), /min-width: 0;/u)
  for (const id of ['manual-mode', 'open-history']) {
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?<svg class="header-action-icon`, 'u'))
  }
})

/** 验证矮窗口改由整个历史工作区滚动，列表不再被标题挤扁；无参数、无返回值。@author zhenghq */
test('静阅历史：矮窗口保留自然列表高度且只有一层滚动', () => {
  const compact = css.slice(css.indexOf('@media (max-height: 400px)'))
  assert.match(compact, /\.history-view\s*\{[^}]*overflow-y: auto;/u)
  assert.match(compact, /\.history-header,\s*\.history-list\s*\{[^}]*flex: 0 0 auto;/u)
  assert.match(compact, /\.history-list\s*\{[^}]*overflow: visible;/u)
})

/**
 * 在真实 Chrome 中验证历史区域高度及滚动后的操作可达性，不依赖模拟布局。
 * 设置 QUIET_STUDIO_BROWSER=1 启用，需要可用的 agent-browser-cli；默认单测不启动浏览器。
 * 无参数、无返回值。
 * @author zhenghq
 */
test('静阅历史浏览器：520×320、360×320 可阅读和操作，普通窗口保持列表滚动', {
  skip: process.env.QUIET_STUDIO_BROWSER !== '1'
}, async () => {
  const run = promisify(execFile)
  /** 执行浏览器命令；参数为 CLI 参数，返回解析后的结果。@author zhenghq */
  async function browser(...args: string[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const { stdout } = await run('agent-browser-cli', args, { maxBuffer: 1024 * 1024, timeout: 15000 })
      const result = JSON.parse(stdout)
      if (result.ok === false && String(result.error).includes('未连接') && attempt < 30) {
        await delay(100)
        continue
      }
      assert.notEqual(result.ok, false, stdout)
      return result.result ?? result
    }
  }
  /** 提供仅用于布局测试的真实页面和样式；参数为请求/响应，无返回值。@author zhenghq */
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><iframe id="preview" src="/popup" style="width:520px;height:320px;border:0"></iframe>')
    } else if (path === '/popup') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''))
    } else if (['/src/theme.css', '/src/base.css', '/src/style.css'].includes(path)) {
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
    const opened = await browser('open', `http://127.0.0.1:${address.port}`, '--group-title', 'T2-history-regression')
    tab = String(opened.opened_tab_id)
    const result = await browser('exec', '--tab', tab, `
      const frame = document.getElementById('preview');
      if (frame.contentDocument.readyState !== 'complete') {
        await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
      }
      const previewDocument = frame.contentDocument;
      previewDocument.getElementById('selection-view').hidden = true;
      previewDocument.getElementById('history-view').hidden = false;
      previewDocument.getElementById('status').textContent = 'Translation history';
      for (const id of ['source-lang', 'target-lang', 'translation-provider']) {
        previewDocument.getElementById(id).innerHTML = '<option>English</option>';
      }
      previewDocument.getElementById('history-list').innerHTML = Array.from({length: 5}, (_unused, index) =>
        '<article class="history-item" role="listitem">' +
        '<div class="history-item-heading"><span class="history-origin">Manual</span><span>English → 简体中文</span><time class="history-time">12:30</time></div>' +
        '<div class="history-source">A quiet place to read. ' + index + '</div>' +
        '<div class="history-translation">安静的双语阅读空间。</div>' +
        '<div class="history-actions"><button class="history-action history-favorite">Star</button><button class="history-action">Translate again</button><button class="history-action history-delete">Delete</button></div></article>'
      ).join('');
      const results = [];
      for (const [width, height] of [[520, 320], [360, 320], [640, 480]]) {
        frame.style.width = width + 'px'; frame.style.height = height + 'px';
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const view = previewDocument.getElementById('history-view'), list = previewDocument.getElementById('history-list');
        view.scrollTop = 0; list.scrollTop = 0;
        const scroll = height <= 400 ? view : list;
        const controls = [previewDocument.getElementById('history-clear-unfavorited'), previewDocument.getElementById('history-search'), ...list.querySelectorAll('button')];
        const readable = [...list.querySelectorAll('.history-source, .history-translation')].every(text => {
          text.scrollIntoView({block: 'nearest'});
          const box = text.getBoundingClientRect(), bounds = view.getBoundingClientRect();
          return box.height > 0 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1 &&
            box.left >= bounds.left && box.right <= bounds.right;
        });
        const reachable = controls.every(control => {
          control.focus(); control.scrollIntoView({block: 'nearest'});
          const box = control.getBoundingClientRect(), bounds = view.getBoundingClientRect();
          return previewDocument.activeElement === control && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1 &&
            previewDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === control;
        });
        results.push({width, height, viewport: frame.contentWindow.innerWidth, viewHeight: view.clientHeight,
          listHeight: list.clientHeight, listScrollHeight: list.scrollHeight,
          viewOverflow: frame.contentWindow.getComputedStyle(view).overflowY,
          listOverflow: frame.contentWindow.getComputedStyle(list).overflowY,
          scrolled: scroll.scrollTop > 0, readable, reachable});
      }
      return results;
    `)
    const measurements = result.js_return
    assert.ok(Array.isArray(measurements), JSON.stringify(result))
    console.log('历史窗口实测：', JSON.stringify(measurements))
    for (const item of measurements) {
      assert.equal(item.viewport, item.width)
      assert.ok(item.viewHeight >= 80, `历史工作区过矮：${JSON.stringify(item)}`)
      assert.ok(item.listHeight >= 100, `历史列表被挤扁：${JSON.stringify(item)}`)
      if (item.height <= 400) {
        assert.equal(item.viewOverflow, 'auto')
        assert.equal(item.listOverflow, 'visible')
        assert.equal(item.listHeight, item.listScrollHeight)
      } else {
        assert.equal(item.listOverflow, 'auto')
        assert.ok(item.listScrollHeight > item.listHeight)
      }
      assert.equal(item.scrolled, true)
      assert.equal(item.readable, true, '每条原文与译文必须能滚动至工作区内完整阅读')
      assert.equal(item.reachable, true, '搜索、清空和全部记录操作必须能滚动聚焦并接受鼠标命中')
    }
  } finally {
    try {
      if (tab) await browser('close', '--tab', tab)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

/**
 * 使用真实页面、词条与 Chrome 布局验证手动工作区和跨模式导航；不调用翻译业务或 Electron。
 * 设置 QUIET_STUDIO_BROWSER=1 启用；无参数、无返回值。
 * @author zhenghq
 */
test('静阅手动浏览器：六组尺寸始终上下、文本独立滚动且操作可达，中英文三模式导航与明暗主题一致', {
  skip: process.env.QUIET_STUDIO_BROWSER !== '1'
}, async () => {
  const run = promisify(execFile)
  /** 执行专用标签页的浏览器命令；参数为 CLI 参数，返回命令结果。@author zhenghq */
  async function browser(...args: string[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const { stdout } = await run('agent-browser-cli', args, { maxBuffer: 4 * 1024 * 1024, timeout: 30000 })
      const result = JSON.parse(stdout)
      if (result.ok === false && String(result.error).includes('未连接') && attempt < 10) {
        await delay(100)
        continue
      }
      assert.notEqual(result.ok, false, stdout)
      return result.result ?? result
    }
  }
  /** 提供隔离的布局夹具；参数为请求与响应，无返回值。@author zhenghq */
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><iframe id="preview" src="/popup" style="width:520px;height:320px;border:0"></iframe>')
    } else if (path === '/popup') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''))
    } else if (['/src/theme.css', '/src/base.css', '/src/style.css'].includes(path)) {
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
    const opened = await browser('open', `http://127.0.0.1:${address.port}`, '--group-title', 'T3-manual-navigation')
    tab = String(opened.opened_tab_id)
    const result = await browser('exec', '--tab', tab, `
      const frame = document.getElementById('preview');
      if (frame.contentDocument.readyState !== 'complete') {
        await new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
      }
      const doc = frame.contentDocument, win = frame.contentWindow;
      /** 查询夹具节点；参数为 ID，返回元素。@author zhenghq */
      const byId = id => doc.getElementById(id);
      const popup = byId('popup'), source = byId('manual-source'), target = byId('manual-result');
      const catalogs = ${JSON.stringify({ 'zh-CN': zhCNBase, 'en-US': enUSBase })};
      const sourceText = ('A quiet place to read and translate.\\n').repeat(100);
      const targetText = ('安静的双语阅读空间。A quiet translation.\\n').repeat(100);
      source.value = sourceText; target.textContent = targetText;
      byId('manual-count').textContent = sourceText.length + ' / 5000';
      byId('manual-submit').disabled = false;
      byId('manual-copy').disabled = false;
      byId('speak').disabled = false;
      /** 应用与渲染器一致的显示状态，不重建页面；参数为模式，无返回值。@author zhenghq */
      function mode(name) {
        for (const item of ['manual', 'selection', 'history']) byId(item + '-view').hidden = item !== name;
        byId('manual-mode').setAttribute('aria-pressed', String(name === 'manual'));
        byId('open-history').setAttribute('aria-pressed', String(name === 'history'));
        byId('manual-copy').hidden = name !== 'manual';
        byId('copy').hidden = name !== 'selection';
      }
      /** 判断矩形完整包含关系；参数为元素及容器，返回布尔值。@author zhenghq */
      function inside(element, container) {
        const a = element.getBoundingClientRect(), b = container.getBoundingClientRect();
        return a.width > 0 && a.height > 0 && a.left >= b.left - 1 && a.right <= b.right + 1 &&
          a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
      }
      /** 判断控件可命中且未被祖先裁切；参数为控件，返回布尔值。@author zhenghq */
      function reachable(element) {
        const box = element.getBoundingClientRect();
        const hit = doc.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (win.getComputedStyle(parent).overflowY !== 'visible' && !inside(element, parent)) return false;
        }
        return inside(element, popup) && element.contains(hit);
      }
      /** 将手动控件滚入工作区后验证命中；参数为控件，返回是否可操作。@author zhenghq */
      function reachableAfterScroll(element) {
        element.scrollIntoView({block: 'nearest', inline: 'nearest'});
        return reachable(element);
      }
      /** 检查节点内无横纵溢出；参数为元素，返回布尔值。@author zhenghq */
      function noOverflow(element) {
        return element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1;
      }
      const manual = [], navigation = [], measuring = [], themes = [];
      for (const theme of ['light', 'dark']) for (const [locale, catalog] of Object.entries(catalogs)) {
        doc.documentElement.dataset.themeMode = theme;
        doc.documentElement.lang = locale;
        themes.push({theme, locale, colorScheme: win.getComputedStyle(doc.documentElement).colorScheme,
          background: win.getComputedStyle(popup).backgroundColor});
        for (const element of doc.querySelectorAll('[data-i18n]')) {
          const value = catalog[element.dataset.i18n];
          if (value) element.textContent = value;
        }
        byId('status').textContent = catalog['popup.manualTranslation'];
        byId('source-lang').innerHTML = '<option>' + (locale === 'en-US' ? 'Auto detect' : '自动检测') + '</option>';
        byId('target-lang').innerHTML = '<option>' + (locale === 'en-US' ? 'Chinese (Simplified)' : '简体中文') + '</option>';
        byId('translation-provider').innerHTML = '<option>OpenAI Compatible</option>';
        for (const [width, height] of [[360,320], [520,320], [520,480], [520,640], [800,320], [800,600]]) {
          frame.style.width = width + 'px'; frame.style.height = height + 'px';
          mode('manual');
          for (const stale of [false, true]) {
            byId('manual-stale').hidden = !stale;
            byId('manual-copy').hidden = stale;
            const view = byId('manual-view');
            view.scrollTop = 0; source.scrollTop = 0; target.scrollTop = 0;
            const sourceBox = source.parentElement.getBoundingClientRect(), targetBox = target.parentElement.getBoundingClientRect();
            const style = win.getComputedStyle(source);
            const sourceLines = (source.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight);
            const targetLines = target.clientHeight / parseFloat(win.getComputedStyle(target).lineHeight);
            source.scrollTop = source.scrollHeight;
            const sourceIndependent = source.scrollTop > 0 && target.scrollTop === 0 && view.scrollTop === 0;
            const sourcePosition = source.scrollTop;
            target.scrollTop = target.scrollHeight;
            const targetIndependent = target.scrollTop > 0 && source.scrollTop === sourcePosition && view.scrollTop === 0;
            const outer = [doc.documentElement, doc.body, popup, ...doc.querySelectorAll('.manual-source-section, .manual-result-section, .manual-source-footer, .header-top, .translation-context, .footer')];
            const overflow = outer.filter(element => !noOverflow(element)).map(element => element.id || element.className || element.tagName);
            manual.push({width, height, locale, theme, stale, viewport: win.innerWidth,
              sourceLines, targetLines, overflow, sourceHeight: source.clientHeight, targetHeight: target.clientHeight,
              heights: Object.fromEntries(['.header', '.translation-context', '.manual-view', '.manual-source-header', '.manual-source-footer', '.manual-result-header', '.footer'].map(selector => [selector, doc.querySelector(selector).getBoundingClientRect().height])),
              sourceScroll: source.scrollTop > 0, targetScroll: target.scrollTop > 0,
              textInside: inside(source, source.parentElement) && inside(target, target.parentElement),
              controls: ['manual-source', 'manual-clear', 'manual-submit', 'manual-result', ...(stale ? [] : ['manual-copy'])].every(id => reachableAfterScroll(byId(id))),
              stacked: sourceBox.bottom <= targetBox.top && Math.abs(sourceBox.left - targetBox.left) < 1 && Math.abs(sourceBox.width - targetBox.width) < 1,
              sourceIndependent, targetIndependent,
              workspaceScroll: view.scrollHeight > view.clientHeight,
              noHorizontalOverflow: view.scrollWidth <= view.clientWidth + 1,
              internalScroll: win.getComputedStyle(source).overflowY === 'auto' && win.getComputedStyle(target).overflowY === 'auto'});
          }
        }
        for (const width of [360, 520, 800]) for (const name of ['selection', 'manual', 'history']) {
          frame.style.width = width + 'px'; frame.style.height = '320px';
          mode(name);
          const controls = ['manual-mode', 'open-history', 'popup-menu-toggle', 'close'].map(byId);
          const icons = [...doc.querySelectorAll('.header-actions .header-action-icon')].filter(icon => !icon.closest('#popup-menu'));
          const labels = [...doc.querySelectorAll('.mode-action > span')];
          const header = doc.querySelector('.header-top');
          const common = {width, locale, theme, mode: name,
            controls: controls.every(reachable),
            icons: icons.length === 3 && icons.every(icon => inside(icon, icon.parentElement) && win.getComputedStyle(icon).display !== 'none' && icon.getBoundingClientRect().width >= 17),
            labels: labels.every(label => inside(label, label.parentElement) && noOverflow(label)),
            noOverflow: noOverflow(header) && noOverflow(doc.querySelector('.header-actions'))};
          const panel = byId('popup-menu'); panel.hidden = false;
          common.menu = reachable(byId('close')) && [...panel.querySelectorAll('button')].every(reachable) && noOverflow(panel);
          panel.hidden = true;
          common.hidden = win.getComputedStyle(panel).display === 'none' &&
            ['selection', 'manual', 'history'].filter(item => item !== name).every(item => win.getComputedStyle(byId(item + '-view')).display === 'none');
          navigation.push(common);
        }
        mode('manual'); byId('manual-stale').hidden = true;
        for (const [width, height] of [[520, 640], [800, 320]]) {
          frame.style.width = width + 'px'; frame.style.height = height + 'px';
          const before = byId('manual-view').clientHeight;
          popup.classList.add('auto-size-measuring');
          const expanded = byId('manual-view').clientHeight;
          measuring.push({width, height, locale, theme, before, expanded,
            overflow: win.getComputedStyle(byId('manual-view')).overflowY,
            targetExpanded: target.clientHeight >= target.scrollHeight - 1});
          popup.classList.remove('auto-size-measuring');
        }
      }
      return {manual, navigation, measuring, themes, stateRetained: source.value === sourceText && target.textContent === targetText};
    `)
    const measurements = result.js_return
    assert.ok(measurements?.manual, JSON.stringify(result))
    console.log('手动与导航窗口实测：', JSON.stringify(measurements))
    assert.equal(measurements.themes.length, 4)
    for (const item of measurements.themes) {
      assert.equal(item.colorScheme, item.theme, `必须实际应用明暗主题：${JSON.stringify(item)}`)
    }
    assert.equal(new Set(measurements.themes.map((item: { background: string }) => item.background)).size, 2, '明暗主题必须渲染不同背景')
    assert.equal(measurements.manual.length, 48)
    for (const item of measurements.manual) {
      const detail = JSON.stringify(item)
      assert.equal(item.viewport, item.width, detail)
      assert.deepEqual(item.overflow, [], detail)
      assert.ok(item.sourceLines >= 1 && item.targetLines >= 1, `原文译文至少一行：${detail}`)
      for (const key of ['sourceScroll', 'targetScroll', 'sourceIndependent', 'targetIndependent', 'textInside', 'controls', 'internalScroll', 'stacked', 'noHorizontalOverflow']) assert.equal(item[key], true, `${key}：${detail}`)
      if (item.height === 320) assert.equal(item.workspaceScroll, true, `矮窗通过工作区滚动保留可读文本：${detail}`)
    }
    assert.equal(measurements.navigation.length, 36)
    for (const item of measurements.navigation) {
      for (const key of ['controls', 'icons', 'labels', 'noOverflow', 'menu', 'hidden']) assert.equal(item[key], true, `${key}：${JSON.stringify(item)}`)
    }
    assert.equal(measurements.measuring.length, 8)
    for (const item of measurements.measuring) {
      assert.ok(item.expanded > item.before, JSON.stringify(item))
      assert.equal(item.overflow, 'visible', JSON.stringify(item))
      assert.equal(item.targetExpanded, true, JSON.stringify(item))
    }
    assert.equal(measurements.stateRetained, true, '模式切换和测量不得清除已有文本')
  } finally {
    try {
      if (tab) await browser('close', '--tab', tab)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

/**
 * 提供最小 DOM 事件宿主，以真实注册的菜单监听器验证键盘和鼠标行为。
 * @author zhenghq
 */
class MenuNode extends EventTarget {
  hidden = false
  disabled = false
  attributes = new Map<string, string>()
  children: MenuNode[] = []
  activeElement: MenuNode | null = null
  ownerDocument: MenuNode = this
  defaultView = new EventTarget()

  /** 写入属性；参数为名称和值；无返回值。@author zhenghq */
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  /** 判断节点包含关系；参数为候选节点；返回包含结果。@author zhenghq */
  contains(node: MenuNode | null): boolean { return node === this || this.children.includes(node!) }
  /** 查询菜单按钮；参数由 DOM 调用方传入；返回子按钮列表。@author zhenghq */
  querySelectorAll(): MenuNode[] { return this.children }
  /** 设置当前焦点；无参数、无返回值。@author zhenghq */
  focus(): void { this.ownerDocument.activeElement = this }
}

/**
 * 构造菜单及文档，无需引入 DOM 依赖或 Electron。
 * @returns 节点、已绑定菜单及宿主。
 * @author zhenghq
 */
function fixture() {
  const document = new MenuNode()
  const toggle = new MenuNode()
  const panel = new MenuNode()
  const items = [new MenuNode(), new MenuNode(), new MenuNode()]
  for (const node of [toggle, panel, ...items]) node.ownerDocument = document
  panel.children = items
  panel.hidden = true
  const menu = bindPopupMenu(toggle as unknown as HTMLButtonElement, panel as unknown as HTMLElement)
  return { document, toggle, panel, items, menu }
}

/**
 * 向宿主派发可取消的键盘或指针事件。
 * @param node 监听器宿主。
 * @param type 事件名称。
 * @param values 键值、目标及关联目标。
 * @returns 已派发的事件。
 * @author zhenghq
 */
function fire(node: EventTarget, type: string, values: Record<string, unknown> = {}): Event {
  const event = new Event(type, { cancelable: true })
  for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value })
  node.dispatchEvent(event)
  return event
}

/** 验证鼠标打开、条目执行和外部点击；无参数、无返回值。@author zhenghq */
test('渐进菜单：点击切换、动作执行不被拦截，外点关闭', () => {
  const { toggle, panel, items, document } = fixture()
  fire(toggle, 'click')
  assert.equal(panel.hidden, false)
  assert.equal(toggle.attributes.get('aria-expanded'), 'true')
  assert.equal(document.activeElement, items[0])
  const click = fire(panel, 'click', { target: items[0] })
  assert.equal(click.defaultPrevented, false)
  assert.equal(panel.hidden, true)
  assert.equal(document.activeElement, toggle)
  fire(toggle, 'click')
  fire(document, 'pointerdown', { target: new MenuNode() })
  assert.equal(panel.hidden, true)
})

/** 验证方向键跳过禁用项、Esc 优先关闭和焦点归还；无参数、无返回值。@author zhenghq */
test('渐进菜单：方向键跳过禁用入口，Escape 不关闭整个弹窗', () => {
  const { toggle, panel, items, document } = fixture()
  items[1].disabled = true
  fire(toggle, 'keydown', { key: 'ArrowDown' })
  assert.equal(panel.hidden, false)
  assert.equal(document.activeElement, items[0])
  fire(document, 'keydown', { key: 'ArrowDown' })
  assert.equal(document.activeElement, items[2])
  fire(document, 'keydown', { key: 'ArrowDown' })
  assert.equal(document.activeElement, items[0])
  fire(document, 'keydown', { key: 'End' })
  assert.equal(document.activeElement, items[2])
  fire(document, 'keydown', { key: 'Home' })
  assert.equal(document.activeElement, items[0])
  let popupClosed = false
  /** 模拟既有文档级关闭监听；无参数、无返回值。@author zhenghq */
  document.addEventListener('keydown', () => { popupClosed = true })
  const escape = fire(document, 'keydown', { key: 'Escape' })
  assert.equal(popupClosed, false)
  assert.equal(escape.defaultPrevented, true)
  assert.equal(panel.hidden, true)
  assert.equal(document.activeElement, toggle)
  assert.equal(toggle.attributes.get('aria-expanded'), 'false')
})

/** 验证自然 Tab 顺序、失焦清理与解绑；无参数、无返回值。@author zhenghq */
test('渐进菜单：Tab 不困住焦点，窗口失焦及销毁后没有残留展开状态', () => {
  const { toggle, panel, document, items, menu } = fixture()
  fire(toggle, 'click')
  assert.equal(fire(document, 'keydown', { key: 'Tab' }).defaultPrevented, false)
  fire(document, 'focusin', { target: items[2] })
  assert.equal(panel.hidden, false)
  fire(document, 'focusin', { target: new MenuNode() })
  assert.equal(panel.hidden, true)
  fire(toggle, 'keydown', { key: 'ArrowUp' })
  assert.equal(document.activeElement, items[2])
  fire(document.defaultView, 'blur')
  assert.equal(panel.hidden, true)
  fire(toggle, 'click')
  menu.destroy()
  assert.equal(panel.hidden, true)
  fire(toggle, 'click')
  assert.equal(panel.hidden, true)
})
