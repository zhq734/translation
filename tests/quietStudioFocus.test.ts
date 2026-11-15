import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const baseCss = readFileSync('src/renderer/src/base.css', 'utf8')
const popupCss = readFileSync('src/renderer/src/style.css', 'utf8')
const settingsCss = readFileSync('src/renderer/src/settings.css', 'utf8')

/** 验证独立字段只沿原边界绘制焦点，保留按钮和链接的键盘提示；无参数、无返回值。@author zhenghq */
test('静阅焦点：输入框、下拉框和文本域采用贴边单层高亮', () => {
  assert.match(baseCss, /select:focus,\s*textarea:focus\s*\{[^}]*outline:\s*2px solid var\(--focus-outline\) !important;[^}]*outline-offset:\s*-2px !important;[^}]*box-shadow:\s*none !important;/u)
  assert.match(baseCss, /input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\):not\(\[type='range'\]\):not\(\[type='color'\]\)[^\n]*:focus/u)
  assert.match(baseCss, /:where\(button, input, select, textarea, a\[href\], \[tabindex\]\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-outline\)/u)
  assert.doesNotMatch(settingsCss, /box-shadow:\s*0 0 0 3px var\(--focus-ring\)/u)
})

/** 验证复合搜索框只有容器绘制焦点，内部输入框不产生第二个轮廓；无参数、无返回值。@author zhenghq */
test('静阅焦点：历史搜索框将焦点边界交给外层容器', () => {
  assert.match(popupCss, /\.history-search-wrap:focus-within\s*\{[^}]*outline:\s*2px solid var\(--focus-outline\);[^}]*outline-offset:\s*-2px;/u)
  assert.match(popupCss, /#history-search:focus\s*\{[^}]*outline:\s*none !important;/u)
  assert.doesNotMatch(popupCss, /\.history-search-wrap:focus-within\s*\{[^}]*box-shadow:\s*0 0 0/u)
})

/** 在独立聚焦窗口中分批检查真实页面，禁止以后台 activeElement 代替焦点；无参数、无返回值。@author zhenghq */
test('静阅焦点浏览器：实际页面字段无双层描边，主题、布局和键盘提示保留', {
  skip: process.env.QUIET_STUDIO_BROWSER !== '1'
}, async () => {
  const execute = promisify(execFile)
  /** 执行指定浏览器指令并返回结构化结果；参数为指令列表。@author zhenghq */
  async function browser(...args: string[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const { stdout } = await execute('agent-browser-cli', args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
      const result = JSON.parse(stdout)
      // 新窗口的扩展桥接允许最多五秒注册；不重试焦点或样式失败。@author zhenghq
      if (result.ok === false && String(result.error).includes('未连接') && attempt < 20) {
        await delay(250)
        continue
      }
      assert.notEqual(result.ok, false, stdout)
      return result.result ?? result
    }
  }
  const pages = ['index', 'settings', 'document', 'web-reader', 'selection', 'subtitle']
  const presets = ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']
  const styles = ['theme', 'base', 'style', 'settings', 'document', 'webReader', 'selection', 'subtitle']
  /** 仅提供无业务脚本的真实页面及白名单样式，避免读写配置和调用 IPC；参数为请求与响应，无返回值。@author zhenghq */
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (path === '/') response.end('<!doctype html><title>T1 输入焦点回归</title><iframe id="preview" style="width:800px;height:600px;border:0"></iframe>')
    else if (pages.some((page) => path === `/${page}.html`)) {
      response.end(readFileSync(`src/renderer${path}`, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ''))
    } else if (styles.some((style) => path === `/src/${style}.css`)) {
      response.setHeader('Content-Type', 'text/css')
      response.end(readFileSync(`src/renderer${path}`, 'utf8'))
    } else response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let tab: string | undefined
  /** 执行短测量脚本，缺少结构化返回时立即报告原始错误；参数为脚本，返回测量对象。@author zhenghq */
  async function evaluate(script: string): Promise<any> {
    assert.ok(tab)
    const result = await browser('exec', '--tab', tab, script)
    assert.ok(result.js_return && typeof result.js_return === 'object', `浏览器脚本未返回测量结果：${JSON.stringify(result)}`)
    assert.equal(result.js_return.error, undefined, JSON.stringify(result.js_return))
    return result.js_return
  }
  let fieldsChecked = 0, keyboardChecked = 0, batchesChecked = 0
  try {
    const { port } = server.address() as { port: number }
    // 独立真实前台窗口，不启用焦点模拟；只关闭本测试创建的标签。@author zhenghq
    const opened = await browser('open', '--window', '--focus', `http://127.0.0.1:${port}`)
    assert.ok(opened.opened_tab_id, JSON.stringify(opened))
    tab = String(opened.opened_tab_id)
    for (const page of pages) {
      const inventory = await evaluate(`
        const frame = document.getElementById('preview');
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('页面加载超时')), 5000);
          frame.onload = () => { clearTimeout(timeout); resolve(); };
          frame.src = '/${page}.html';
        });
        const preview = frame.contentDocument, win = frame.contentWindow;
        const fields = [...preview.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"]), textarea, select')];
        /** 仅在无业务的测试副本中展示字段及祖先，不覆盖焦点样式；参数为元素，无返回值。@author zhenghq */
        function reveal(element) {
          element.disabled = false;
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            ancestor.hidden = false;
            if (ancestor.tagName === 'DETAILS') ancestor.open = true;
            if (win.getComputedStyle(ancestor).display === 'none') ancestor.style.display = 'block';
          }
        }
        fields.forEach(reveal);
        // 页面当前没有链接，使用隔离夹具验证共享链接规则；不点击或导航。@author zhenghq
        const link = preview.createElement('a');
        link.id = 'focus-test-link';
        link.href = '#focus-test-link';
        link.textContent = '键盘焦点测试链接';
        preview.body.append(link);
        const controls = ['button', 'a[href]', 'input[type="checkbox"]', 'input[type="radio"]']
          .map(selector => preview.querySelector(selector)).filter(Boolean);
        controls.forEach(reveal);
        // 真实 Tab 建立键盘输入模态，后续 focus() 继承该模态；不伪造键盘事件。@author zhenghq
        preview.addEventListener('keydown', event => {
          if (event.key === 'Tab' && event.isTrusted) preview.documentElement.dataset.trustedTab = 'true';
        }, {once: true});
        win.focus();
        reveal(fields[0]);
        fields[0].focus();
        return {
          ids: fields.map(field => field.id), controls: controls.length,
          focused: document.hasFocus() && preview.hasFocus() && fields[0].matches(':focus'),
          stylesLoaded: [...preview.styleSheets].length >= 3
        };
      `)
      assert.equal(inventory.focused, true, `${page} 未获得真实窗口/字段焦点；请串行运行浏览器回归，不能忽略此失败`)
      assert.equal(inventory.stylesLoaded, true, `${page} 样式未加载`)
      assert.ok(inventory.ids.length > 0, `${page} 未发现字段`)
      assert.ok(inventory.controls > 0, `${page} 未发现键盘控件`)
      for (const type of ['keyDown', 'keyUp']) {
        await browser('exec', JSON.stringify({ cmd: 'cdp', tabId: Number(tab), method: 'Input.dispatchKeyEvent', params: {
          type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9
        } }))
      }
      // 每次仅检查一个页面、一个主题；同步样式/布局读取会刷新层叠，不等待逐字段动画帧。@author zhenghq
      for (const preset of presets) {
        const measurements = await evaluate(`
          const frame = document.getElementById('preview'), preview = frame.contentDocument, win = frame.contentWindow;
          const fields = [...preview.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"]), textarea, select')];
          const controls = ['button', 'a[href]', 'input[type="checkbox"]', 'input[type="radio"]']
            .map(selector => preview.querySelector(selector)).filter(Boolean);
          const failures = [], evidence = [], keyboardEvidence = [];
          let fieldsChecked = 0, keyboardChecked = 0;
          const probe = preview.createElement('span');
          probe.style.color = 'var(--focus-outline)';
          preview.body.append(probe);
          try {
            for (const mode of ['light', 'dark']) for (const width of [360, 800]) {
              preview.documentElement.dataset.theme = '${preset}';
              preview.documentElement.dataset.themeMode = mode;
              frame.style.width = width + 'px';
              const expectedColor = win.getComputedStyle(probe).color;
              for (const field of fields) {
                // 同名 details 是互斥菜单，必须在每次测量前打开当前字段所属菜单。@author zhenghq
                for (let ancestor = field.parentElement; ancestor; ancestor = ancestor.parentElement) {
                  if (ancestor.tagName === 'DETAILS') ancestor.open = true;
                }
                field.blur();
                const before = field.getBoundingClientRect();
                field.focus();
                const after = field.getBoundingClientRect(), style = win.getComputedStyle(field);
                const sample = {
                  mode, width, id: field.id, documentFocused: document.hasFocus() && preview.hasFocus(),
                  active: preview.activeElement === field, focused: field.matches(':focus'),
                  outline: style.outline, offset: style.outlineOffset, shadow: style.boxShadow, expectedColor
                };
                /** 收集失败及样式证据，供宿主断言；参数为原因，无返回值。@author zhenghq */
                const fail = reason => failures.push({...sample, reason});
                if (!sample.documentFocused || !sample.active || !sample.focused) fail('缺少真实 :focus，activeElement 不足以证明通过');
                if (!after.width || !after.height || style.visibility !== 'visible') fail('字段不可见');
                if (style.boxShadow !== 'none') fail('额外焦点阴影');
                if (field.id === 'history-search') {
                  const parent = field.closest('.history-search-wrap'), wrap = win.getComputedStyle(parent);
                  sample.parent = {focused: parent.matches(':focus-within'), outline: wrap.outline, offset: wrap.outlineOffset, shadow: wrap.boxShadow};
                  if (style.outlineStyle !== 'none' || !sample.parent.focused || wrap.outlineStyle !== 'solid' || wrap.outlineWidth !== '2px' || wrap.outlineOffset !== '-2px' || wrap.boxShadow !== 'none' || wrap.outlineColor !== expectedColor) fail('复合字段应仅由父容器绘制贴边单圈');
                } else if (style.outlineWidth !== '2px' || style.outlineOffset !== '-2px' || style.outlineStyle !== 'solid' || style.outlineColor !== expectedColor) fail('焦点未使用主题色贴合原边界');
                if (before.width !== after.width || before.height !== after.height) fail('焦点造成布局偏移');
                if (width === 360 && (field === fields[0] || field.id === 'manual-source' || field.id === 'history-search' || field.closest('details'))) evidence.push(sample);
                fieldsChecked++;
              }
              for (const control of controls) {
                control.focus();
                const style = win.getComputedStyle(control);
                const sample = {
                  mode, width, id: control.id, tag: control.tagName, type: control.type,
                  documentFocused: document.hasFocus() && preview.hasFocus(), active: preview.activeElement === control,
                  focused: control.matches(':focus'), focusVisible: control.matches(':focus-visible'),
                  trustedTab: preview.documentElement.dataset.trustedTab === 'true', outline: style.outline
                };
                if (!sample.documentFocused || !sample.active || !sample.focused || !sample.focusVisible || !sample.trustedTab || style.outlineWidth !== '2px' || style.outlineStyle !== 'solid' || style.outlineColor !== expectedColor) failures.push({...sample, reason: '键盘焦点提示丢失'});
                if (mode === 'light' && width === 360) keyboardEvidence.push(sample);
                keyboardChecked++;
              }
            }
          } finally {
            probe.remove();
          }
          return {fieldsChecked, keyboardChecked, failures, evidence, keyboardEvidence};
        `)
        assert.ok(Array.isArray(measurements.failures), `${page}/${preset} 缺少失败记录`)
        console.log('输入焦点批次：', JSON.stringify({page, preset, ...measurements, failures: measurements.failures.slice(0, 10), failureCount: measurements.failures.length}))
        assert.equal(measurements.fieldsChecked, inventory.ids.length * 4, `${page}/${preset} 字段覆盖不完整`)
        assert.equal(measurements.keyboardChecked, inventory.controls * 4, `${page}/${preset} 键盘控件覆盖不完整`)
        assert.equal(measurements.failures.length, 0, JSON.stringify(measurements.failures.slice(0, 10)))
        fieldsChecked += measurements.fieldsChecked
        keyboardChecked += measurements.keyboardChecked
        batchesChecked++
      }
      console.log('输入焦点页面覆盖：', JSON.stringify({page, ids: inventory.ids, controls: inventory.controls}))
    }
    assert.equal(batchesChecked, pages.length * presets.length)
    assert.ok(fieldsChecked > 1000)
    assert.ok(keyboardChecked >= pages.length * presets.length * 4)
    console.log('输入焦点检查完成：', JSON.stringify({batchesChecked, fieldsChecked, keyboardChecked}))
  } finally {
    try {
      if (tab) await browser('close', '--tab', tab)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})
