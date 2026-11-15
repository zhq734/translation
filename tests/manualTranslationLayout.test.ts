import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync('src/renderer/src/style.css', 'utf8')
const html = readFileSync('src/renderer/index.html', 'utf8')

/** 提取独立选择器规则（包含媒体查询，排除测量态祖先选择器）；参数为选择器，返回规则体列表。@author zhenghq */
function rules(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return Array.from(css.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gmu')), (match) => match[1])
}

/** 验证原文先于译文且任意媒体查询不恢复双栏；无参数、无返回值。@author zhenghq */
test('手动翻译：原文上译文下，宽屏和矮屏均不得覆盖为双栏', () => {
  assert.match(html, /id="manual-view"[\s\S]*?class="manual-source-section"[\s\S]*?id="manual-source"[\s\S]*?class="manual-result-section"[\s\S]*?id="manual-result"/u)
  const columns = rules('.manual-view').flatMap((body) => Array.from(body.matchAll(/grid-template-columns:\s*([^;]+);/gu), (match) => match[1]))
  assert.ok(columns.length > 0, '必须声明单列布局')
  assert.ok(columns.every((value) => value === 'minmax(0, 1fr)'), `所有规则必须维持单列：${columns.join('；')}`)
  assert.doesNotMatch(css, /@media \(min-width: 600px\), \(max-height: 480px\)/u)
})

/** 验证有限高度保留可读文本与独立滚动，工作区承接不足空间；无参数、无返回值。@author zhenghq */
test('手动翻译：两区保留可读高度，矮窗可滚动至输入和操作', () => {
  const view = rules('.manual-view')[0]
  assert.match(view, /grid-template-rows:\s*repeat\(2, minmax\(min-content, 1fr\)\);/u)
  assert.match(view, /min-height:\s*0;/u)
  assert.match(view, /min-width:\s*0;/u)
  assert.match(view, /overflow-y:\s*auto;/u)
  assert.match(view, /overflow-x:\s*hidden;/u)
  assert.match(rules('#manual-source')[0], /min-height:\s*5em;/u)
  assert.match(rules('.manual-result')[0], /min-height:\s*3\.5em;/u)
  assert.match(rules('.manual-result')[0], /contain:\s*size;/u)
  assert.match(rules('#popup.auto-size-measuring .manual-result')[0], /contain:\s*none;/u)
  for (const selector of ['#manual-source', '.manual-result']) {
    assert.match(rules(selector)[0], /overflow-y:\s*auto;/u)
    assert.match(rules(selector)[0], /overscroll-behavior:\s*contain;/u)
  }
})

/** 验证翻译随输入区滚动、复制留在固定底栏，避免矮窗裁切操作；无参数、无返回值。@author zhenghq */
test('手动翻译：翻译操作随原文排列，复制操作不进入工作区滚动容器', () => {
  const manualSection = html.match(/<section id="manual-view"[\s\S]*?<\/section>/u)?.[0] ?? ''
  assert.match(manualSection, /id="manual-source"[\s\S]*?id="manual-submit"[\s\S]*?class="manual-result-section"/u)
  assert.doesNotMatch(manualSection, /id="manual-copy"/u)
  assert.match(html, /class="footer(?:\s[^"]*)?"[\s\S]*?id="manual-copy"/u)
  assert.match(rules('.footer')[0], /flex:\s*0 0 auto;/u)
  assert.match(rules('.header')[0], /flex:\s*0 0 auto;/u)
})
