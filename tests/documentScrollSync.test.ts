import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldSyncDocumentScroll } from '../src/renderer/src/documentScrollSync.ts'

test('程序性滚动不能触发双栏反向联动', () => {
  assert.equal(shouldSyncDocumentScroll('translation', {
    userScrollSide: 'translation',
    programmatic: true,
    translationLayoutUpdating: false
  }), false)
  assert.equal(shouldSyncDocumentScroll('source', {
    userScrollSide: 'source',
    programmatic: true,
    translationLayoutUpdating: false
  }), false)
})

test('流式重排期间译文增长不能反向拖动原文栏', () => {
  assert.equal(shouldSyncDocumentScroll('translation', {
    userScrollSide: 'translation',
    programmatic: false,
    translationLayoutUpdating: true
  }), false)
})

test('没有用户滚动意图的译文 scroll 事件不能反向拖动原文栏', () => {
  assert.equal(shouldSyncDocumentScroll('translation', {
    userScrollSide: null,
    programmatic: false,
    translationLayoutUpdating: false
  }), false)
})

test('用户主动滚动任一侧时仍保留双向联动能力', () => {
  assert.equal(shouldSyncDocumentScroll('source', {
    userScrollSide: 'source',
    programmatic: false,
    translationLayoutUpdating: false
  }), true)
  assert.equal(shouldSyncDocumentScroll('translation', {
    userScrollSide: 'translation',
    programmatic: false,
    translationLayoutUpdating: false
  }), true)
})
