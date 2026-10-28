import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Windows 翻译弹窗应使用全透明原生背景并为圆角预留透明边距', () => {
  const popupSource = readFileSync('src/main/popup.ts', 'utf8')
  const styles = readFileSync('src/renderer/src/style.css', 'utf8')

  assert.match(popupSource, /transparent:\s*true[\s\S]*?backgroundColor:\s*'#00000000'/u)
  assert.match(styles, /body\s*\{[^}]*padding:\s*8px;[^}]*overflow:\s*hidden;/su)
  assert.match(styles, /#popup\s*\{[^}]*border-radius:\s*12px;[^}]*overflow:\s*hidden;/su)
  assert.match(styles, /#popup\s*\{[^}]*clip-path:\s*inset\(0 round 12px\);/su)
})

/**
 * 校验透明页面宿主和弹窗内容使用一致圆角裁切，避免 Windows 合成出灰色方角。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译弹窗的透明宿主区域也必须裁成圆角，避免 Windows 在圆角外露出方形灰色裁切', () => {
  const styles = readFileSync('src/renderer/src/style.css', 'utf8')

  assert.match(styles, /html\s*,\s*body\s*\{[^}]*border-radius:\s*12px;[^}]*clip-path:\s*inset\(0 round 12px\);/su)
  assert.match(styles, /body\s*\{[^}]*isolation:\s*isolate;/su)
})
