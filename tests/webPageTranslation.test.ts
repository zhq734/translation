import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyWebTextBlock,
  createWebTextNodeAnchor,
  createWebTextAnchor,
  extractWebTextBlocks,
  isWebTextBlockCategory,
  isWebTextBlockType,
  parseWebTextNodeAnchor,
  parseWebTextAnchor,
  preserveWebTextWhitespace,
  type WebDomSnapshotNode
} from '../src/shared/webPageTranslation.ts'

/**
 * 创建可复用的元素快照节点。
 * @param tag 元素标签名。
 * @param children 子节点。
 * @param patch 需要覆盖的节点字段。
 * @returns 完整的元素快照节点。
 * @author zhenghq
 */
function element(
  tag: string,
  children: WebDomSnapshotNode[] = [],
  patch: Partial<WebDomSnapshotNode> = {}
): WebDomSnapshotNode {
  return { kind: 'element', tag, visible: true, children, ...patch }
}

/**
 * 创建可复用的文本快照节点。
 * @param text 文本内容。
 * @returns 文本快照节点。
 * @author zhenghq
 */
function text(text: string): WebDomSnapshotNode {
  return { kind: 'text', text, textNodeIndex: 0, visible: true, children: [] }
}

test('网页文本块类型和分类应只接受约定值', () => {
  assert.equal(isWebTextBlockType('heading'), true)
  assert.equal(isWebTextBlockType('paragraph'), true)
  assert.equal(isWebTextBlockType('unknown'), false)
  assert.equal(isWebTextBlockCategory('body'), true)
  assert.equal(isWebTextBlockCategory('isolated'), true)
  assert.equal(isWebTextBlockCategory('navigation'), false)
})

test('网页文本提取应过滤隐藏、脚本、样式、模板、SVG 和空白节点', () => {
  const snapshot = element('body', [
    element('h1', [text('  Web Translation  ')], {
      id: 'article-title',
      rect: { x: 20, y: 40, width: 400, height: 48 }
    }),
    element('p', [text('Hello '), element('strong', [text('world')]), text('!')]),
    element('p', [text('不可见内容')], { visible: false }),
    element('script', [text('window.secret = true')]),
    element('style', [text('.hidden { display:none }')]),
    element('template', [text('模板内容')]),
    element('svg', [text('图标内容')]),
    element('div', [text('   \n  ')])
  ])

  const result = extractWebTextBlocks(snapshot, {
    url: 'https://example.com/article',
    title: 'Example',
    langHint: 'en'
  })

  assert.equal(result.blocks.length, 2)
  assert.deepEqual(result.blocks.map((block) => block.text), ['Web Translation', 'Hello world!'])
  assert.deepEqual(result.units.map((unit) => unit.text), ['Web Translation', 'Hello', 'world', '!'])
  assert.equal(result.units[1].sourceText, 'Hello ')
  assert.equal(result.units[1].blockId, result.blocks[1].id)
  assert.equal(result.units[2].blockId, result.blocks[1].id)
  assert.equal(result.blocks[0].type, 'heading')
  assert.equal(result.blocks[1].type, 'paragraph')
  assert.equal(result.blocks[0].anchor.selector, '[id="article-title"]')
  assert.deepEqual(result.blocks[0].anchor.rect, { x: 20, y: 40, width: 400, height: 48 })
  assert.deepEqual(result.pageMeta, {
    url: 'https://example.com/article',
    title: 'Example',
    langHint: 'en'
  })
})

test('网页文本提取应保留相对时间 Shadow DOM 文本和输入框语义属性锚点', () => {
  const snapshot = element('body', [
    element('div', [
      element('relative-time', [
        text('Aug 22, 2026')
      ], { shadowHostSelector: '#commit-time', shadowRoot: true }),
      element('input', [], { id: 'search', semanticTexts: [{ text: 'Search files', attribute: 'placeholder' }] })
    ], { id: 'content' })
  ])

  const result = extractWebTextBlocks(snapshot, {
    url: 'https://github.com/example/repository',
    title: 'Repository'
  })

  assert.deepEqual(result.units.map((unit) => unit.text), ['Aug 22, 2026', 'Search files'])
  assert.equal(result.units[0].anchor.parentSelector, '#commit-time')
  assert.deepEqual(result.units[0].anchor.shadowPath, [])
  assert.equal(result.units[1].anchor.parentSelector, '[id="search"]')
  assert.equal(result.units[1].anchor.semanticAttribute, 'placeholder')
})

test('文本节点锚点应保存父元素、childNodes 索引和原文指纹', () => {
  const anchor = createWebTextNodeAnchor({
    parentSelector: '#article > p:nth-child(2)',
    textNodeIndex: 3,
    sourceText: '  Hello world  '
  })
  assert.equal(anchor.parentSelector, '#article > p:nth-child(2)')
  assert.equal(anchor.textNodeIndex, 3)
  assert.equal(anchor.sourceFingerprint.length, 8)
  assert.deepEqual(parseWebTextNodeAnchor(JSON.stringify(anchor)), anchor)
  assert.equal(parseWebTextNodeAnchor('{"parentSelector":"#p","textNodeIndex":-1,"sourceFingerprint":"x"}'), null)
})

test('原位译文应精确保留原文本节点前后空白', () => {
  assert.equal(preserveWebTextWhitespace('\n  Hello world \t', '你好，世界'), '\n  你好，世界 \t')
  assert.equal(preserveWebTextWhitespace('Hello', '  你好  '), '你好')
})

test('块级容器应合并行内文本但不重复合并嵌套段落', () => {
  const snapshot = element('body', [
    element('main', [
      element('div', [text('独立介绍文字')]),
      element('p', [text('第一段'), element('a', [text('链接')])]),
      element('p', [text('Second paragraph')])
    ])
  ])

  const result = extractWebTextBlocks(snapshot, {
    url: 'https://example.com',
    title: '混合页面'
  })

  assert.deepEqual(result.blocks.map((block) => block.text), [
    '独立介绍文字',
    '第一段链接',
    'Second paragraph'
  ])
  assert.equal(result.blocks[1].linkTextLength, 2)
})

test('锚点应优先使用 id、其次 data-testid、最后使用 nth-child 标签链', () => {
  assert.equal(createWebTextAnchor({
    tag: 'p',
    id: 'intro',
    testId: 'intro-test',
    elementPath: [{ tag: 'body', index: 1 }, { tag: 'p', index: 2 }]
  }).selector, '[id="intro"]')

  assert.equal(createWebTextAnchor({
    tag: 'button',
    testId: 'submit',
    elementPath: [{ tag: 'body', index: 1 }, { tag: 'button', index: 3 }]
  }).selector, '[data-testid="submit"]')

  const anchor = createWebTextAnchor({
    tag: 'li',
    elementPath: [
      { tag: 'html', index: 1 },
      { tag: 'body', index: 2 },
      { tag: 'ul', index: 1 },
      { tag: 'li', index: 3 }
    ],
    rect: { x: 10, y: 200, width: 300, height: 24 },
    text: '第三项'
  })

  assert.equal(anchor.selector, 'html:nth-child(1) > body:nth-child(2) > ul:nth-child(1) > li:nth-child(3)')
  assert.equal(anchor.textFingerprint.length > 0, true)
  assert.deepEqual(parseWebTextAnchor(JSON.stringify(anchor)), anchor)
  assert.equal(parseWebTextAnchor('{"selector":1}'), null)
})

test('孤立文本检测应综合标签、角色、长度、链接密度和文本密度', () => {
  const body = classifyWebTextBlock({
    text: '这是一段用于说明网页正文分类规则的中文内容，并且具有足够的文本长度。',
    type: 'paragraph',
    ancestorTags: ['body', 'main', 'article'],
    ancestorRoles: [],
    linkTextLength: 0,
    textDensity: 0.9
  })
  const navigation = classifyWebTextBlock({
    text: 'Home Products Pricing',
    type: 'navigation',
    ancestorTags: ['body', 'header', 'nav'],
    ancestorRoles: ['navigation'],
    linkTextLength: 21,
    textDensity: 0.35
  })
  const mixedBody = classifyWebTextBlock({
    text: 'Electron 支持 cross-platform desktop applications with JavaScript.',
    type: 'paragraph',
    ancestorTags: ['body', 'main'],
    ancestorRoles: ['main'],
    linkTextLength: 0,
    textDensity: 0.82
  })

  assert.equal(body, 'body')
  assert.equal(navigation, 'isolated')
  assert.equal(mixedBody, 'body')
})
