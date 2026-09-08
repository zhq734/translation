import assert from 'node:assert/strict'
import test from 'node:test'
import { nextDiagnosticsExpandedState } from '../src/shared/diagnosticsPanelState'

/**
 * 校验点击收起/展开按钮时状态正确翻转：展开->收起、收起->展开。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词诊断面板收起切换应翻转展开状态', () => {
  assert.equal(nextDiagnosticsExpandedState(true), false)
  assert.equal(nextDiagnosticsExpandedState(false), true)
})
