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
