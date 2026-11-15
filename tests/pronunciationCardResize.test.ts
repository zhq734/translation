import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync('src/renderer/src/style.css', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

/** 提取独立选择器规则（含媒体查询内规则）；参数为选择器，返回规则体列表。@author zhenghq */
function rules(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return Array.from(css.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gmu')), (match) => match[1])
}

/** 验证音标卡浮层化后原文区保持自然高度不再收缩裁剪，原文文本保底一行高度；无参数、无返回值。@author zhenghq */
test('音标卡浮层化后原文区不再参与收缩裁剪', () => {
  const bodies = rules('.translation-section-source')
  const flexBody = bodies.find((body) => /flex:/u.test(body))
  assert.ok(flexBody, '必须为原文区声明 flex 布局')
  assert.match(flexBody, /flex:\s*0 0 auto;/u, '音标卡不再内联后原文区必须保持自然高度')
  assert.doesNotMatch(flexBody, /overflow-y:\s*auto;/u, '原文区不再需要整体滚动')

  const originalBody = rules('.original').find((body) => /min-height:/u.test(body))
  assert.ok(originalBody, '必须为原文文本声明最小高度')
  assert.doesNotMatch(originalBody, /min-height:\s*0;/u, '原文文本不允许最小高度为零')
  assert.match(originalBody, /min-height:\s*1\.55em;/u, '原文文本至少保留一行高度')
})

/** 验证音标卡渲染时定位浮层并触发窗口自适应尺寸上报；无参数、无返回值。@author zhenghq */
test('音标卡渲染时必须定位浮层并触发窗口自适应尺寸上报', () => {
  assert.match(rules('#popup')[0], /position:\s*relative;/u, '弹窗根节点必须作为浮层定位基准')
  assert.match(rules('.pronunciation-card')[0], /position:\s*absolute;/u, '音标卡必须浮层化')
  const fn = renderer.match(/function renderPronunciationCard\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.ok(fn.includes('positionPronunciationCard()'), 'renderPronunciationCard 必须定位浮层')
  assert.ok(fn.includes('requestAutoResize()'), 'renderPronunciationCard 必须调用 requestAutoResize')
})
