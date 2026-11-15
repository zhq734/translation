import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { LANGUAGES, langLabel } from '../src/shared/langs.ts'
import { tForTest } from './helpers/i18n.ts'

const html = readFileSync('src/renderer/web-reader.html', 'utf8')
const css = readFileSync('src/renderer/src/webReader.css', 'utf8')

/** 提取基础 CSS 声明；参数为选择器，返回声明字符串。@author zhenghq */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'u').exec(css)?.[1] ?? ''
}

test('语言与显示归为紧凑配置组，剩余空间只放在右侧操作组之前', () => {
  const settings = html.indexOf('class="web-translation-settings"')
  const mode = html.indexOf('class="web-mode-control"')
  const actions = html.indexOf('class="web-translation-actions"')
  assert.ok(settings > 0 && settings < mode && mode < actions, '语言和显示必须位于同一配置组')
  assert.match(rule('.web-translation-toolbar'), /display:\s*flex/u)
  assert.match(rule('.web-translation-toolbar'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.web-translation-settings'), /flex-wrap:\s*wrap/u)
  assert.doesNotMatch(rule('.web-translation-settings'), /flex:\s*1\b/u)
  assert.match(rule('.web-translation-actions'), /margin-left:\s*auto/u)
  assert.doesNotMatch(rule('.web-translation-toolbar'), /grid-template-columns:[^;]*1fr/u)
  assert.match(css, /\.web-language-control,\s*\.web-mode-control\s*\{[^}]*align-items:\s*center/u)
})

test('真实浏览器：宽屏单行紧邻、窄屏自然换行、主题和原生控件可用', {
  skip: process.env.WEB_READER_BROWSER !== '1'
}, async () => {
  const execute = promisify(execFile)
  /** 调用真实浏览器并等待新页扩展接入；参数为 CLI 参数，返回结构化响应。@author zhenghq */
  async function browser(...args: string[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const { stdout } = await execute('agent-browser-cli', args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
      const result = JSON.parse(stdout)
      if (result.ok === false && String(result.error).includes('未连接') && attempt < 20) { await delay(250); continue }
      assert.notEqual(result.ok, false, stdout)
      return result.result ?? result
    }
  }
  /** 只服务真实阅读器 HTML/CSS，不加载 Electron 业务脚本；参数为请求和响应，无返回值。@author zhenghq */
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><title>T3 网页工具栏回归</title><iframe id="preview" style="border:0;width:1280px;height:800px"></iframe>')
    } else if (path === '/web-reader.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ''))
    } else if (['/src/theme.css', '/src/base.css', '/src/webReader.css'].includes(path)) {
      response.setHeader('Content-Type', 'text/css')
      response.end(readFileSync(`src/renderer${path}`, 'utf8'))
    } else response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  let tab: string | undefined
  try {
    const { port } = server.address() as { port: number }
    const opened = await browser('open', '--window', '--focus', `http://127.0.0.1:${port}`)
    assert.ok(opened.opened_tab_id, JSON.stringify(opened))
    tab = String(opened.opened_tab_id)
    const translations = Object.fromEntries(['zh-CN', 'en-US'].map(locale => [locale, Object.fromEntries(
      [...html.matchAll(/data-i18n="([^"]+)"/gu)].map(match => [match[1], tForTest(locale as 'zh-CN' | 'en-US', match[1])])
    )]))
    const languages = Object.fromEntries(['zh-CN', 'en-US'].map(locale => [locale, LANGUAGES.map(language => ({
      value: language.code, label: langLabel(language.code, locale as 'zh-CN' | 'en-US')
    }))]))
    const response = await browser('exec', '--tab', tab, `
      const frame = document.getElementById('preview');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('预览加载超时')), 5000);
        frame.onload = () => { clearTimeout(timeout); resolve(); };
        frame.src = '/web-reader.html';
      });
      const doc = frame.contentDocument, win = frame.contentWindow;
      const translations = ${JSON.stringify(translations)}, languages = ${JSON.stringify(languages)};
      const samples = [], failures = [];
      /** 读取真实控件边界；参数为选择器，返回矩形。@author zhenghq */
      const rect = selector => doc.querySelector(selector).getBoundingClientRect();
      for (const locale of ['zh-CN', 'en-US']) {
        doc.documentElement.lang = locale;
        doc.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = translations[locale][node.dataset.i18n]; });
        for (const id of ['web-source-lang', 'web-target-lang']) {
          const select = doc.getElementById(id);
          select.replaceChildren(...languages[locale].map(language => new win.Option(language.label, language.value)));
          if (id === 'web-source-lang') select.add(new win.Option(locale === 'zh-CN' ? '自动检测' : 'Auto Detect', 'auto'));
          select.value = id === 'web-source-lang' ? 'auto' : 'ZH';
        }
        for (const mode of ['light', 'dark']) for (const [width, height] of [[1440,900],[1280,800],[1024,768],[768,600],[480,640],[360,540],[640,320]]) {
          doc.documentElement.dataset.theme = 'sky';
          doc.documentElement.dataset.themeMode = mode;
          frame.style.width = width + 'px'; frame.style.height = height + 'px';
          const toolbar = rect('.web-translation-toolbar'), pair = rect('.web-language-pair'), display = rect('.web-mode-control'), actions = rect('.web-translation-actions'), view = rect('#web-view-slot');
          const sample = { locale, mode, width, height, toolbarHeight: toolbar.height, displayGap: display.left - pair.right, actionsRight: actions.right, viewHeight: view.height, background: win.getComputedStyle(doc.querySelector('.web-translation-toolbar')).backgroundColor };
          /** 记录对应布局样本的失败原因；参数为原因，无返回值。@author zhenghq */
          const fail = reason => failures.push({...sample, reason});
          const section = doc.querySelector('.web-translation-toolbar');
          if (section.scrollWidth > section.clientWidth || doc.documentElement.scrollWidth > width) fail('横向溢出');
          if (view.height <= height * 0.35) fail('网页可用高度不足');
          if (width >= 1280) {
            if (toolbar.height > 60) fail('宽屏不应超过单行高度');
            if (sample.displayGap < 0 || sample.displayGap > 20) fail('语言与显示间距过大');
            if (Math.abs(display.top + display.height / 2 - actions.top - actions.height / 2) > 2) fail('显示与操作未对齐');
            if (width - actions.right > 16) fail('操作组未靠右');
            for (const id of ['web-source-lang', 'web-target-lang', 'web-mode']) if (rect('#' + id).width > 170) fail('下拉框过宽');
          }
          const ids = ['web-source-lang', 'web-target-lang', 'web-mode', 'web-translate', 'web-cancel', 'web-export-pdf'];
          for (const id of ids) {
            const node = doc.getElementById(id);
            node.disabled = false; node.focus(); node.scrollIntoView({block: 'nearest'});
            const bounds = node.getBoundingClientRect(), style = win.getComputedStyle(node);
            if (doc.activeElement !== node || !node.matches(':focus') || style.outlineStyle !== 'solid') fail('控件失去焦点提示：' + id);
            if (bounds.left < 0 || bounds.right > width || bounds.width < 40 || bounds.height < 28) fail('控件不可达：' + id);
          }
          section.scrollTop = 0;
          samples.push(sample);
        }
      }
      return { samples, failures };
    `)
    const evidence = response.js_return
    assert.ok(evidence?.samples, JSON.stringify(response))
    console.log('T3 真实浏览器布局证据：', JSON.stringify(evidence))
    assert.equal(evidence.samples.length, 28)
    assert.deepEqual(evidence.failures, [])
    assert.notEqual(evidence.samples[0].background, evidence.samples[7].background, '明暗主题必须不同')
  } finally {
    try { if (tab) await browser('close', '--tab', tab) }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
})
