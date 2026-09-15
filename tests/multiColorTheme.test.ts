import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

test('主题运行时应支持五套主题、三种模式和本地缓存', () => {
  const source = readFileSync('src/renderer/src/theme.ts', 'utf8')
  assert.match(source, /sakura/u)
  assert.match(source, /emerald/u)
  assert.match(source, /sky/u)
  assert.match(source, /navy/u)
  assert.match(source, /platinum-black/u)
  assert.match(source, /system/u)
  assert.match(source, /matchMedia/u)
  assert.match(source, /localStorage/u)
  assert.match(source, /data-theme/u)
  assert.match(source, /data-theme-mode/u)
})

test('所有 Renderer 入口都应初始化并监听主题设置', () => {
  for (const file of ['popup.ts', 'settings.ts', 'selection.ts', 'toast.ts', 'webReader.ts']) {
    const source = readFileSync(`src/renderer/src/${file}`, 'utf8')
    assert.match(source, /startThemeRuntime\(window\.api\)/u, `${file} 未初始化主题运行时`)
  }
})

test('主题样式应提供五套主题的浅深模式和强调渐变', () => {
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  for (const theme of ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']) {
    assert.match(css, new RegExp(`data-theme=['"]${theme}['"]`, 'u'))
  }
  assert.match(css, /data-theme-mode=['"]light['"]/u)
  assert.match(css, /data-theme-mode=['"]dark['"]/u)
  assert.match(css, /--accent-gradient:\s*linear-gradient/u)
})

test('气泡提示应跟随浅深与多彩主题使用语义颜色', () => {
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  assert.match(css, /--toast-bg:\s*var\(--popup-bg\)/u)
  assert.match(css, /--toast-text:\s*var\(--text-primary\)/u)
  assert.match(css, /--toast-border:\s*var\(--popup-border\)/u)
})

test('覆盖层提示胶囊应为反色胶囊并在五套主题与浅深模式下都有定义', () => {
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  const toastCss = readFileSync('src/renderer/src/toast.css', 'utf8')
  const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')
  // 未应用主题属性前也要有兜底配色，否则提示会渲染成透明
  assert.match(css, /--hint-pill-bg:\s*rgba\(/u)
  assert.match(css, /--hint-pill-text:\s*#/u)
  // 显式明暗模式必须压过系统外观：浅色主题深底白字，深色主题浅底深字
  assert.match(css, /:root\[data-theme-mode='light'\]\s*\{[^}]*--hint-pill-text:\s*#ffffff/u)
  assert.match(css, /:root\[data-theme-mode='dark'\]\s*\{[^}]*--hint-pill-text:\s*#17171a/u)
  // 五套主题各自微调胶囊底色，保证多主题下都不是同一种黑
  for (const theme of ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']) {
    assert.match(css, new RegExp(`data-theme=['"]${theme}['"][^}]*--hint-pill-bg:`, 'u'), `${theme} 缺少提示胶囊底色`)
  }
  // 状态图标必须走各自的 Token，不得退回共享状态色
  assert.match(toastCss, /\[data-state='warning'\][^}]*--hint-pill-icon-warning/u)
  assert.match(toastCss, /\[data-state='error'\][^}]*--hint-pill-icon-error/u)
  // 截图动作提示与 OCR 框选提示必须共用同一组 Token，不能各留一套配色
  assert.match(toastCss, /background:\s*var\(--hint-pill-bg\)/u)
  assert.match(selectionCss, /\.ocr-tip\s*\{[^}]*background:\s*var\(--hint-pill-bg\)/su)
  assert.match(selectionCss, /\.ocr-tip\s*\{[^}]*color:\s*var\(--hint-pill-text\)/su)
})

test('设置页应提供主题模式和五个可访问主题卡片', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  for (const [id, label] of [
    ['sakura', '樱花粉'],
    ['emerald', '祖母绿'],
    ['sky', '天空蓝'],
    ['navy', '藏青色'],
    ['platinum-black', '铂金黑']
  ]) {
    assert.match(html, new RegExp(`data-theme-preset=["']${id}["']`, 'u'))
    assert.match(html, new RegExp(label, 'u'))
  }
  assert.match(html, /id="theme-mode"/u)
  assert.match(html, /aria-pressed="false"/u)
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /\.theme-preset-grid\s*\{[\s\S]*display:\s*grid/u)
  assert.match(css, /repeat\(auto-fit/u)
})

test('设置窗口必须等首帧就绪后再显示，避免启动时先闪默认主题', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = source.match(
    /async function createSettingsWindow\(\): Promise<BrowserWindow> \{([\s\S]*?)\n\}/u
  )
  assert.ok(settingsWindowBlock)
  const createPath = settingsWindowBlock[1].slice(
    settingsWindowBlock[1].indexOf('const createdWindow = new BrowserWindow')
  )
  assert.match(
    createPath,
    /await readyToShow[\s\S]*?settingsWin\.show\(\)[\s\S]*?settingsWin\.focus\(\)/u,
    '设置窗口必须在首帧就绪后再显示，避免先渲染默认主题'
  )
  const helper = source.match(
    /function whenWindowReadyToShow\(win: BrowserWindow\): Promise<void> \{([\s\S]*?)\n\}/u
  )
  assert.ok(helper, '缺少等待首帧就绪的辅助函数')
  assert.match(helper[1], /ready-to-show/u, '必须监听 ready-to-show')
  assert.match(helper[1], /did-fail-load/u, '加载失败时不得让设置窗口卡住不显示')
  assert.match(
    createPath,
    /whenWindowReadyToShow\(createdWindow\)[\s\S]*?loadRendererHtml/u,
    '首帧监听必须早于页面加载，避免漏掉 ready-to-show'
  )
})

test('所有 Renderer 入口必须在样式表前同步预应用缓存主题', () => {
  const bootstrap = readFileSync('src/renderer/public/themeBootstrap.js', 'utf8')
  // 预应用脚本必须是经典脚本，且不能使用模块语法，否则无法在首次样式计算前执行。
  assert.doesNotMatch(bootstrap, /\bimport\b|\bexport\b/u, '预应用脚本不能使用 ES 模块语法')
  assert.match(bootstrap, /localStorage/u)
  assert.match(bootstrap, /data-theme/u)
  assert.match(bootstrap, /data-theme-mode/u)
  assert.match(bootstrap, /selection-translator\.theme/u, '缓存键必须与 theme.ts 一致')

  const themeSource = readFileSync('src/renderer/src/theme.ts', 'utf8')
  const cacheKey = themeSource.match(/THEME_CACHE_KEY = '([^']+)'/u)
  assert.ok(cacheKey)
  assert.ok(bootstrap.includes(cacheKey[1]!), '预应用脚本缓存键与 theme.ts 漂移')
  // 预应用白名单必须覆盖 theme.ts 支持的全部主题与模式，否则会退回默认主题。
  for (const value of ['sakura', 'emerald', 'sky', 'navy', 'platinum-black', 'system', 'light', 'dark']) {
    assert.ok(bootstrap.includes(`'${value}'`), `预应用脚本缺少白名单值 ${value}`)
  }

  for (const file of ['index.html', 'selection.html', 'settings.html', 'toast.html', 'web-reader.html']) {
    const html = readFileSync(`src/renderer/${file}`, 'utf8')
    const scriptIndex = html.indexOf('themeBootstrap.js')
    const styleIndex = html.indexOf('theme.css')
    assert.ok(scriptIndex > 0, `${file} 未引入主题预应用脚本`)
    assert.ok(styleIndex > 0, `${file} 未引入主题样式表`)
    assert.ok(scriptIndex < styleIndex, `${file} 的主题预应用脚本必须早于样式表，才能避免默认主题闪烁`)
    // 必须保持经典脚本（无 type="module"），defer/async 都会让预应用晚于首帧。
    assert.match(html, /<script src="\.\/themeBootstrap\.js"><\/script>/u, `${file} 必须同步执行预应用脚本`)
  }
})

test('主题预应用脚本应在首帧前按缓存写入根节点属性', () => {
  const bootstrap = readFileSync('src/renderer/public/themeBootstrap.js', 'utf8')

  /**
   * 以受控的 window/localStorage 环境执行预应用脚本。
   * @param cached 缓存中保存的主题值，null 表示未写入缓存。
   * @param prefersDark 系统是否处于深色外观。
   * @returns 脚本执行后根节点上的主题属性。
   * @author zhenghq
   */
  function run(cached: string | null, prefersDark: boolean): Record<string, string> {
    const attributes: Record<string, string> = {}
    const store = new Map<string, string>()
    if (cached !== null) store.set('selection-translator.theme', cached)
    const sandbox = {
      window: {
        localStorage: { getItem: (key: string) => store.get(key) ?? null },
        matchMedia: () => ({ matches: prefersDark })
      },
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => {
            attributes[name] = value
          }
        }
      }
    }
    vm.createContext(sandbox)
    vm.runInContext(bootstrap, sandbox)
    return attributes
  }

  // 缓存了藏青主题 + 跟随系统 + 系统深色：首帧必须直接是 navy/dark，而不是默认 sky。
  const dark = run('{"themePreset":"navy","themeMode":"system"}', true)
  assert.equal(dark['data-theme'], 'navy')
  assert.equal(dark['data-theme-mode'], 'dark')

  // 显式浅色必须压过系统深色。
  const light = run('{"themePreset":"sakura","themeMode":"light"}', true)
  assert.equal(light['data-theme'], 'sakura')
  assert.equal(light['data-theme-mode'], 'light')

  // 缓存损坏或非法值不得写入属性，保留共享样式默认值。
  assert.deepEqual(run('{"themePreset":"unknown","themeMode":"system"}', false), {})
  assert.deepEqual(run('not-json', false), {})
})
