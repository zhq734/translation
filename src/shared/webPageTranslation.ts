/** 网页文本块类型。 */
export type WebTextBlockType =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'button'
  | 'navigation'
  | 'footer'
  | 'other'

/** 网页文本块正文分类。 */
export type WebTextBlockCategory = 'body' | 'isolated'

/** 网页翻译范围。 */
export type WebTranslationScope = 'body' | 'all'

/** 网页原位展示模式。 */
export type WebTranslationMode = 'source' | 'target'

/** 页面元素矩形坐标。 */
export interface WebTextRect {
  /** 元素相对页面左侧的横坐标。 */
  x: number
  /** 元素相对页面顶部的纵坐标。 */
  y: number
  /** 元素宽度。 */
  width: number
  /** 元素高度。 */
  height: number
}

/** DOM 元素路径片段。 */
export interface WebElementPathSegment {
  /** 小写标签名。 */
  tag: string
  /** 元素在父元素全部元素子节点中的一基序号。 */
  index: number
}

/** 网页文本定位锚点。 */
export interface WebTextAnchor {
  /** 用于重新定位元素的 CSS 选择器。 */
  selector: string
  /** 提取时记录的页面坐标，选择器失效时用于回退。 */
  rect?: WebTextRect
  /** 原文短指纹，用于避免选择器误命中。 */
  textFingerprint: string
}

/** 可写回文本节点的精确定位锚点。 */
export interface WebTextNodeAnchor {
  /** 文本节点父元素选择器。 */
  parentSelector: string
  /** 文本节点在父元素 childNodes 中的索引。 */
  textNodeIndex: number
  /** 提取时原始 nodeValue 的短指纹。 */
  sourceFingerprint: string
  /** 从宿主元素进入开放 Shadow DOM 后到文本父元素的元素索引路径。 */
  shadowPath?: number[]
  /** 语义提示属性名称；存在时表示该单元写回元素属性而非 TextNode。 */
  semanticAttribute?: 'placeholder' | 'aria-label' | 'title'
}

/** 浏览器侧提取的元素语义提示文本。 */
export interface WebSemanticText {
  /** 语义属性名称。 */
  attribute: 'placeholder' | 'aria-label' | 'title'
  /** 属性原文。 */
  text: string
}

/** 浏览器侧返回的可序列化 DOM 快照节点。 */
export interface WebDomSnapshotNode {
  /** 节点类型。 */
  kind: 'element' | 'text'
  /** 元素标签名，文本节点可省略。 */
  tag?: string
  /** 文本节点内容。 */
  text?: string
  /** 文本节点在父元素 childNodes 中的索引。 */
  textNodeIndex?: number
  /** 节点在提取时是否可见。 */
  visible?: boolean
  /** 元素 ARIA role。 */
  role?: string
  /** 元素 id。 */
  id?: string
  /** 元素 data-testid。 */
  testId?: string
  /** 浏览器侧计算出的精确元素选择器。 */
  selector?: string
  /** 元素页面矩形。 */
  rect?: WebTextRect
  /** 元素上的可见语义提示属性。 */
  semanticTexts?: WebSemanticText[]
  /** 该节点是否为开放 Shadow DOM 宿主的快照根。 */
  shadowRoot?: boolean
  /** 从 ShadowRoot 根到当前节点的元素索引路径。 */
  shadowPath?: number[]
  /** Shadow DOM 宿主在普通文档中的选择器。 */
  shadowHostSelector?: string
  /** 子节点。 */
  children: WebDomSnapshotNode[]
}

/** 网页文本块。 */
export interface ExtractedWebTextBlock {
  /** 页面快照内稳定的块标识。 */
  id: string
  /** 规范化后的原文。 */
  text: string
  /** 文本块类型。 */
  type: WebTextBlockType
  /** 正文或孤立碎片分类。 */
  category: WebTextBlockCategory
  /** 页面定位锚点。 */
  anchor: WebTextAnchor
  /** 当前块及其祖先标签链。 */
  ancestorTags: string[]
  /** 当前块及其祖先 ARIA role。 */
  ancestorRoles: string[]
  /** 块内链接文字字符数。 */
  linkTextLength: number
  /** 有效文字占原始文字的比例。 */
  textDensity: number
  /** 页面语言提示。 */
  language?: string
}

/** 网页中可独立原位写回的文本单元。 */
export interface ExtractedWebTextUnit {
  /** 文本单元标识。 */
  id: string
  /** 所属语义块标识。 */
  blockId: string
  /** 原始 nodeValue，包含首尾空白。 */
  sourceText: string
  /** 规范化后的待翻译文本。 */
  text: string
  /** 精确文本节点锚点。 */
  anchor: WebTextNodeAnchor
  /** 所属块分类。 */
  category: WebTextBlockCategory
  /** 页面语言提示。 */
  language?: string
}

/** 网页元数据。 */
export interface WebPageMeta {
  /** 当前页面 URL。 */
  url: string
  /** 当前页面标题。 */
  title: string
  /** 页面声明的语言提示。 */
  langHint?: string
}

/** 网页提取结果。 */
export interface WebTextExtractionResult {
  /** 提取出的有序文本块。 */
  blocks: ExtractedWebTextBlock[]
  /** 可写回文本单元。 */
  units: ExtractedWebTextUnit[]
  /** 页面元数据。 */
  pageMeta: WebPageMeta
}

/** 创建锚点时需要的元素信息。 */
export interface WebTextAnchorInput {
  /** 元素标签。 */
  tag: string
  /** 元素 id。 */
  id?: string
  /** 元素 data-testid。 */
  testId?: string
  /** 元素路径。 */
  elementPath: WebElementPathSegment[]
  /** 元素坐标。 */
  rect?: WebTextRect
  /** 元素文字。 */
  text?: string
}

/** 创建文本节点锚点所需的输入。 */
export interface WebTextNodeAnchorInput {
  /** 文本节点父元素选择器。 */
  parentSelector: string
  /** 文本节点在父元素 childNodes 中的索引。 */
  textNodeIndex: number
  /** 原始 nodeValue。 */
  sourceText: string
  /** 开放 Shadow DOM 内的元素索引路径。 */
  shadowPath?: number[]
  /** 语义提示属性名称。 */
  semanticAttribute?: 'placeholder' | 'aria-label' | 'title'
}

/** 文本分类所需的最小特征。 */
export interface WebTextClassificationInput {
  /** 文本内容。 */
  text: string
  /** 文本块类型。 */
  type: WebTextBlockType
  /** 祖先标签链。 */
  ancestorTags: string[]
  /** 祖先 ARIA role。 */
  ancestorRoles: string[]
  /** 链接文字字符数。 */
  linkTextLength: number
  /** 文本密度。 */
  textDensity: number
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'button', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'
])
const IGNORED_TAGS = new Set(['script', 'style', 'template', 'svg', 'noscript', 'canvas'])

/**
 * 判断未知值是否为合法网页文本块类型。
 * @param value 待校验值。
 * @returns 是否为合法类型。
 * @author zhenghq
 */
export function isWebTextBlockType(value: unknown): value is WebTextBlockType {
  return value === 'heading' || value === 'paragraph' || value === 'list-item' ||
    value === 'button' || value === 'navigation' || value === 'footer' || value === 'other'
}

/**
 * 判断未知值是否为合法网页文本分类。
 * @param value 待校验值。
 * @returns 是否为合法分类。
 * @author zhenghq
 */
export function isWebTextBlockCategory(value: unknown): value is WebTextBlockCategory {
  return value === 'body' || value === 'isolated'
}

/**
 * 判断未知值是否为合法网页翻译范围。
 * @param value 待校验值。
 * @returns 是否为合法范围。
 * @author zhenghq
 */
export function isWebTranslationScope(value: unknown): value is WebTranslationScope {
  return value === 'body' || value === 'all'
}

/**
 * 判断未知值是否为合法网页显示模式。
 * @param value 待校验值。
 * @returns 是否为合法显示模式。
 * @author zhenghq
 */
export function isWebTranslationMode(value: unknown): value is WebTranslationMode {
  return value === 'source' || value === 'target'
}

/**
 * 规范化网页文本中的连续空白。
 * @param value 原始文本。
 * @returns 去除首尾空白并折叠连续空白后的文本。
 * @author zhenghq
 */
function normalizeWebText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * 生成短小且确定的文本哈希。
 * @param value 待计算字符串。
 * @returns 八位十六进制哈希。
 * @author zhenghq
 */
function shortHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 转义 CSS 属性选择器中的字符串。
 * @param value 属性原值。
 * @returns 可安全放入双引号属性选择器的值。
 * @author zhenghq
 */
function escapeCssAttribute(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

/**
 * 根据 id、data-testid 或标签路径创建网页文本锚点。
 * @param input 元素定位信息。
 * @returns 可序列化的网页文本锚点。
 * @author zhenghq
 */
export function createWebTextAnchor(input: WebTextAnchorInput): WebTextAnchor {
  const selector = input.id
    ? `[id="${escapeCssAttribute(input.id)}"]`
    : input.testId
      ? `[data-testid="${escapeCssAttribute(input.testId)}"]`
      : input.elementPath
        .map((segment) => `${segment.tag.toLowerCase()}:nth-child(${Math.max(1, segment.index)})`)
        .join(' > ')
  return {
    selector,
    ...(input.rect ? { rect: { ...input.rect } } : {}),
    textFingerprint: shortHash(normalizeWebText(input.text ?? ''))
  }
}

/**
 * 从字符串解析并校验网页文本锚点。
 * @param serialized 序列化锚点字符串。
 * @returns 合法锚点；格式非法时返回 null。
 * @author zhenghq
 */
export function parseWebTextAnchor(serialized: string): WebTextAnchor | null {
  try {
    const value = JSON.parse(serialized) as Partial<WebTextAnchor>
    if (typeof value.selector !== 'string' || typeof value.textFingerprint !== 'string') return null
    if (value.rect !== undefined) {
      const rect = value.rect as Partial<WebTextRect>
      if (![rect.x, rect.y, rect.width, rect.height].every((part) => Number.isFinite(part))) return null
    }
    return {
      selector: value.selector,
      textFingerprint: value.textFingerprint,
      ...(value.rect ? { rect: { ...value.rect } } : {})
    }
  } catch {
    return null
  }
}

/** 创建可写回文本节点锚点。
 * @param input 文本节点定位信息。
 * @returns 文本节点锚点。
 * @author zhenghq
 */
export function createWebTextNodeAnchor(input: WebTextNodeAnchorInput): WebTextNodeAnchor {
  return {
    parentSelector: input.parentSelector,
    textNodeIndex: Math.max(0, Math.floor(input.textNodeIndex)),
    sourceFingerprint: shortHash(input.sourceText),
    ...(input.shadowPath !== undefined ? { shadowPath: [...input.shadowPath] } : {}),
    ...(input.semanticAttribute ? { semanticAttribute: input.semanticAttribute } : {})
  }
}

/** 解析并校验文本节点锚点。
 * @param serialized 序列化锚点。
 * @returns 合法锚点或 null。
 * @author zhenghq
 */
export function parseWebTextNodeAnchor(serialized: string): WebTextNodeAnchor | null {
  try {
    const value = JSON.parse(serialized) as Partial<WebTextNodeAnchor>
    if (typeof value.parentSelector !== 'string' || typeof value.sourceFingerprint !== 'string') return null
    const textNodeIndex = value.textNodeIndex
    if (!Number.isInteger(textNodeIndex) || textNodeIndex === undefined || textNodeIndex < 0) return null
    return {
      parentSelector: value.parentSelector,
      textNodeIndex,
      sourceFingerprint: value.sourceFingerprint,
      ...(Array.isArray(value.shadowPath) && value.shadowPath.every((part) => Number.isInteger(part) && part >= 0)
        ? { shadowPath: [...value.shadowPath] }
        : {}),
      ...(value.semanticAttribute === 'placeholder' || value.semanticAttribute === 'aria-label' || value.semanticAttribute === 'title'
        ? { semanticAttribute: value.semanticAttribute }
        : {})
    }
  } catch {
    return null
  }
}

/** 将译文写回时保留原始文本节点的首尾空白。
 * @param sourceText 原始 nodeValue。
 * @param translation 规范化译文。
 * @returns 保留空白后的 nodeValue。
 * @author zhenghq
 */
export function preserveWebTextWhitespace(sourceText: string, translation: string): string {
  const leading = sourceText.match(/^\s*/u)?.[0] ?? ''
  const trailing = sourceText.match(/\s*$/u)?.[0] ?? ''
  return `${leading}${translation.trim()}${trailing}`
}

/**
 * 将元素标签映射为应用文本块类型。
 * @param tag 小写元素标签。
 * @param roles 当前元素与祖先角色。
 * @returns 文本块类型。
 * @author zhenghq
 */
function blockTypeForTag(tag: string, roles: string[]): WebTextBlockType {
  if (/^h[1-6]$/u.test(tag)) return 'heading'
  if (tag === 'p' || tag === 'blockquote' || tag === 'pre') return 'paragraph'
  if (tag === 'li' || tag === 'dt' || tag === 'dd') return 'list-item'
  if (tag === 'button') return 'button'
  if (tag === 'nav' || roles.includes('navigation') || roles.includes('menu')) return 'navigation'
  if (tag === 'footer' || roles.includes('contentinfo')) return 'footer'
  return 'other'
}

/**
 * 收集一个块级节点自身的行内文本，并跳过嵌套块级节点。
 * @param node 当前块级节点。
 * @returns 原始文本与其中链接文字长度。
 * @author zhenghq
 */
function collectInlineText(node: WebDomSnapshotNode): { rawText: string; linkTextLength: number } {
  let rawText = ''
  let linkTextLength = 0

  /**
   * 递归收集行内后代文本。
   * @param current 当前节点。
   * @param insideLink 当前节点是否位于链接内。
   * @param root 是否为块根节点。
   * @returns 无返回值。
   * @author zhenghq
   */
  function visit(current: WebDomSnapshotNode, insideLink: boolean, root: boolean): void {
    if (current.visible === false) return
    if (current.kind === 'text') {
      const value = current.text ?? ''
      rawText += value
      if (insideLink) linkTextLength += normalizeWebText(value).length
      return
    }
    const tag = (current.tag ?? '').toLowerCase()
    if (IGNORED_TAGS.has(tag) || (!root && BLOCK_TAGS.has(tag))) return
    const linked = insideLink || tag === 'a'
    for (const child of current.children) visit(child, linked, false)
  }

  visit(node, false, true)
  return { rawText, linkTextLength }
}

/**
 * 根据页面结构和文本特征判断文本块属于正文还是孤立碎片。
 * @param input 文本块分类特征。
 * @returns 正文或孤立碎片分类。
 * @author zhenghq
 */
export function classifyWebTextBlock(input: WebTextClassificationInput): WebTextBlockCategory {
  const tags = input.ancestorTags.map((tag) => tag.toLowerCase())
  const roles = input.ancestorRoles.map((role) => role.toLowerCase())
  const length = normalizeWebText(input.text).length
  const linkDensity = input.linkTextLength / Math.max(1, length)
  let score = 0

  if (tags.some((tag) => tag === 'main' || tag === 'article' || tag === 'p')) score += 3
  if (roles.includes('main') || roles.includes('article')) score += 3
  if (input.type === 'heading' || input.type === 'paragraph') score += 2
  if (length >= 20) score += 2
  if (length >= 80) score += 1
  if (input.textDensity >= 0.65) score += 1

  if (tags.some((tag) => tag === 'nav' || tag === 'aside' || tag === 'footer' || tag === 'header')) score -= 3
  if (roles.some((role) => role === 'navigation' || role === 'menu' || role === 'banner' || role === 'contentinfo')) score -= 4
  if (input.type === 'button' || input.type === 'navigation' || input.type === 'footer') score -= 3
  if (length < 12) score -= 2
  if (linkDensity >= 0.5) score -= 3
  if (input.textDensity < 0.4) score -= 2

  return score >= 2 ? 'body' : 'isolated'
}

/**
 * 从浏览器侧 DOM 快照提取有序网页文本块。
 * @param snapshot DOM 快照根节点。
 * @param pageMeta 页面 URL、标题与语言提示。
 * @returns 带锚点和分类的文本提取结果。
 * @author zhenghq
 */
export function extractWebTextBlocks(
  snapshot: WebDomSnapshotNode,
  pageMeta: WebPageMeta
): WebTextExtractionResult {
  const blocks: ExtractedWebTextBlock[] = []
  const units: ExtractedWebTextUnit[] = []

  /**
   * 深度遍历快照并生成非重复块。
   * @param node 当前快照节点。
   * @param path 当前元素路径。
   * @param ancestorTags 祖先标签链。
   * @param ancestorRoles 祖先角色链。
   * @returns 无返回值。
   * @author zhenghq
   */
  function visit(
    node: WebDomSnapshotNode,
    path: WebElementPathSegment[],
    ancestorTags: string[],
    ancestorRoles: string[]
  ): void {
    if (node.visible === false || node.kind !== 'element') return
    const tag = (node.tag ?? 'div').toLowerCase()
    if (IGNORED_TAGS.has(tag)) return
    const roles = node.role ? [...ancestorRoles, node.role.toLowerCase()] : ancestorRoles
    const tags = [...ancestorTags, tag]

    for (const semantic of node.semanticTexts ?? []) {
      const sourceText = semantic.text
      const text = normalizeWebText(sourceText)
      if (!text) continue
      const parentSelector = node.shadowPath !== undefined
        ? node.shadowHostSelector
        : node.selector ?? (node.id ? `[id="${escapeCssAttribute(node.id)}"]` : undefined)
      if (!parentSelector) continue
      const type = tag === 'button' ? 'button' : 'other'
      const blockId = `web-${shortHash(`${parentSelector}|${semantic.attribute}|${text}|${blocks.length}`)}`
      blocks.push({
        id: blockId,
        text,
        type,
        category: 'isolated',
        anchor: {
          selector: parentSelector,
          ...(node.rect ? { rect: { ...node.rect } } : {}),
          textFingerprint: shortHash(text)
        },
        ancestorTags: tags,
        ancestorRoles: roles,
        linkTextLength: 0,
        textDensity: text.length / Math.max(1, sourceText.length),
        ...(pageMeta.langHint ? { language: pageMeta.langHint } : {})
      })
      units.push({
        id: `${blockId}:unit-${units.length}`,
        blockId,
        sourceText,
        text,
        anchor: createWebTextNodeAnchor({
          parentSelector,
          textNodeIndex: 0,
          sourceText,
          ...(node.shadowPath !== undefined ? { shadowPath: node.shadowPath } : {}),
          semanticAttribute: semantic.attribute
        }),
        category: 'isolated',
        ...(pageMeta.langHint ? { language: pageMeta.langHint } : {})
      })
    }

    if (BLOCK_TAGS.has(tag)) {
      const collected = collectInlineText(node)
      const normalized = normalizeWebText(collected.rawText)
      if (normalized) {
        const type = blockTypeForTag(tag, roles)
        const textDensity = normalizeWebText(collected.rawText).length / Math.max(1, collected.rawText.length)
        const anchor = createWebTextAnchor({
          tag,
          id: node.id,
          testId: node.testId,
          elementPath: path,
          rect: node.rect,
          text: normalized
        })
        const category = classifyWebTextBlock({
          text: normalized,
          type,
          ancestorTags: tags,
          ancestorRoles: roles,
          linkTextLength: collected.linkTextLength,
          textDensity
        })
        const blockId = `web-${shortHash(`${anchor.selector}|${normalized}|${blocks.length}`)}`
        blocks.push({
          id: blockId,
          text: normalized,
          type,
          category,
          anchor,
          ancestorTags: tags,
          ancestorRoles: roles,
          linkTextLength: collected.linkTextLength,
          textDensity,
          ...(pageMeta.langHint ? { language: pageMeta.langHint } : {})
        })

        /**
         * 收集当前块内可写回的文本节点，遇到嵌套块时停止。
         * @param current 当前快照节点。
         * @param parentSelector 当前文本节点父元素选择器。
         * @param shadowPath 开放 Shadow DOM 内文本父元素的索引路径。
         * @param root 当前节点是否为语义块根节点。
         * @returns 无返回值。
         * @author zhenghq
         */
        const collectUnits = (
          current: WebDomSnapshotNode,
          currentPath: WebElementPathSegment[],
          parentSelector: string,
          shadowPath: number[] | undefined,
          root: boolean
        ): void => {
          if (current.visible === false) return
          if (current.kind === 'text') {
            const sourceText = current.text ?? ''
            const text = normalizeWebText(sourceText)
            if (!text) return
            const nodeAnchor = createWebTextNodeAnchor({
              parentSelector,
              textNodeIndex: current.textNodeIndex ?? 0,
              sourceText,
              ...(shadowPath !== undefined ? { shadowPath } : {})
            })
            units.push({
              id: `${blockId}:unit-${units.length}`,
              blockId,
              sourceText,
              text,
              anchor: nodeAnchor,
              category,
              ...(pageMeta.langHint ? { language: pageMeta.langHint } : {})
            })
            return
          }
          const childTag = (current.tag ?? '').toLowerCase()
          if (!root && (IGNORED_TAGS.has(childTag) || BLOCK_TAGS.has(childTag))) return
          const contentParentSelector = current.shadowRoot
            ? current.shadowHostSelector ?? current.selector ?? parentSelector
            : current.shadowPath !== undefined
              ? current.shadowHostSelector ?? parentSelector
              : current.selector ?? parentSelector
          const contentShadowPath = current.shadowRoot
            ? []
            : current.shadowPath !== undefined
              ? current.shadowPath
              : shadowPath
          let elementIndex = 0
          for (const child of current.children) {
            if (child.kind === 'element') {
              elementIndex += 1
              const childPath = [...currentPath, { tag: (child.tag ?? 'div').toLowerCase(), index: elementIndex }]
              const childSelector = child.shadowPath !== undefined
                ? child.shadowHostSelector ?? contentParentSelector
                : child.selector ?? childPath
                  .map((segment) => `${segment.tag.toLowerCase()}:nth-child(${Math.max(1, segment.index)})`)
                  .join(' > ')
              collectUnits(
                child,
                childPath,
                childSelector,
                child.shadowPath !== undefined ? child.shadowPath : contentShadowPath,
                false
              )
            } else {
              collectUnits(child, currentPath, contentParentSelector, contentShadowPath, false)
            }
          }
        }
        collectUnits(
          node,
          path,
          node.shadowPath !== undefined ? node.shadowHostSelector ?? anchor.selector : node.selector ?? anchor.selector,
          node.shadowPath,
          true
        )
      }
    }

    let elementIndex = 0
    for (const child of node.children) {
      if (child.kind !== 'element') continue
      elementIndex += 1
      const childTag = (child.tag ?? 'div').toLowerCase()
      visit(child, [...path, { tag: childTag, index: elementIndex }], tags, roles)
    }
  }

  const rootTag = (snapshot.tag ?? 'body').toLowerCase()
  visit(snapshot, [{ tag: rootTag, index: 1 }], [], [])
  return { blocks, units, pageMeta: { ...pageMeta } }
}
