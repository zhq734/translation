import type {
  WebDomSnapshotNode,
  WebImageCandidate,
  WebPageMeta,
  WebTextNodeAnchor,
  WebTranslationMode
} from '../shared/webPageTranslation'

/** 原位写回单元。 */
export interface WebTextWriteOperation {
  /** 文本单元标识。 */
  unitId: string
  /** 原始 nodeValue。 */
  sourceText: string
  /** 已聚合译文。 */
  translation?: string
  /** 文本节点锚点。 */
  anchor: WebTextNodeAnchor
}

/** 原位写回统计。 */
export interface WebTextApplyResult {
  /** 成功写入数量。 */
  applied: number
  /** 锚点失配数量。 */
  mismatched: number
  /** 因无译文等原因跳过数量。 */
  skipped: number
}

/** 对照译文注入操作。 */
export interface WebBilingualInjectionOperation {
  /** 目标块标识。 */
  blockId: string
  /** 目标块选择器。 */
  selector: string
  /** 拼接后的整段译文。 */
  translation: string
}

/** 对照注入统计。 */
export interface WebBilingualInjectionResult {
  /** 成功写入或更新的块数量。 */
  applied: number
  /** 锚点失配的块数量。 */
  mismatched: number
  /** 跳过的块数量。 */
  skipped: number
}

/** 图片译文覆盖层注入操作。 */
export interface WebImageOverlayOperation {
  /** 目标图片标识。 */
  imageId: string
  /** 图片宿主元素选择器。 */
  selector: string
  /** 开放 Shadow DOM 内的元素索引路径。 */
  shadowPath?: number[]
  /** OCR 识别原文。 */
  ocrText: string
  /** 图片文字译文。 */
  translation: string
  /** 展示位置：图片下方说明块或图片区域叠加。 */
  placement: 'below' | 'overlay'
  /** 是否同时展示原文。 */
  bilingual: boolean
  /** 译文语言代码，用于覆盖层 lang 属性。 */
  lang?: string
}

/** 图片译文覆盖层注入统计。 */
export interface WebImageOverlayResult {
  /** 成功写入或更新的覆盖层数量。 */
  applied: number
  /** 锚点失配数量。 */
  mismatched: number
  /** 跳过的数量。 */
  skipped: number
}

/** 网页主文档可提取状态。 */
export interface WebDocumentReadiness {
  /** 主文档加载状态。 */
  readyState: 'loading' | 'interactive' | 'complete'
  /** 是否已经创建可提取的根节点。 */
  hasRoot: boolean
  /** 当前远程页面地址。 */
  url: string
}

/** 页面侧增量收集器返回的快照批次。 */
export interface WebIncrementalTextBatch {
  /** 本批次受影响语义根节点的快照。 */
  snapshots: WebDomSnapshotNode[]
  /** 本批次新增的图片候选。 */
  imageCandidates?: WebImageCandidate[]
  /** 当前页面元数据。 */
  pageMeta: WebPageMeta
  /** 收集器是否仍处于初始加载窗口。 */
  active: boolean
  /** 页面是否发生过文本变化。 */
  pageUpdated: boolean
}

/**
 * 构造读取网页主文档状态的脚本。
 * @returns 可传给 webContents.executeJavaScript 的状态脚本字符串。
 * @author zhenghq
 */
export function buildWebDocumentReadyScript(): string {
  return `(() => ({
    readyState: document.readyState,
    hasRoot: Boolean(document.body || document.documentElement),
    url: location.href
  }))()`
}

/**
 * 构造在远程页面隔离上下文执行的只读 DOM 快照脚本。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebTextExtractionScript(): string {
  return `(() => {
    const ignored = new Set(['SCRIPT','STYLE','TEMPLATE','SVG','NOSCRIPT','CANVAS','IFRAME']);
    const formControls = new Set(['INPUT','TEXTAREA','SELECT','OPTION']);
    const semanticAttributes = new Set(['placeholder','aria-label','title']);
    const selectorOf = (element) => {
      if (element.id) return '[id="' + CSS.escape(element.id) + '"]';
      const testId = element.getAttribute('data-testid');
      if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
      const segments = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parent = current.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1;
        const tag = current.tagName.toLowerCase();
        // html 与 body 是文档唯一根元素，使用标签本身定位，避免受 head 等兄弟节点影响。
        segments.unshift(tag === 'html' || tag === 'body' ? tag : tag + ':nth-child(' + index + ')');
        current = parent;
      }
      return segments.join(' > ');
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const visible = (element) => {
      if (!element || ignored.has(element.tagName) || element.isContentEditable || element.contentEditable === 'true') return false;
      // 应用注入的对照译文节点及其子树不参与提取，避免译文被当作新原文再次翻译。
      if (element.closest && element.closest('[data-st-translation],[data-st-image-translation]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
        (style.display === 'contents' || (rect.width > 0 && rect.height > 0));
    };
    const shadowLocationOf = (node) => {
      const root = node?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node : node?.getRootNode?.();
      if (!root || root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE || !root.host) return null;
      const path = [];
      let current = node === root ? null : node;
      while (current && current.parentNode !== root) {
        const parent = current.parentNode;
        if (!parent) return null;
        path.unshift(Array.from(parent.childNodes).indexOf(current));
        current = parent;
      }
      if (current) path.unshift(Array.from(root.childNodes).indexOf(current));
      return { hostSelector: selectorOf(root.host), path };
    };
    const semanticTextsOf = (element) => {
      const values = [];
      const names = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
        ? ['placeholder','aria-label','title']
        : ['aria-label','title'];
      for (const attribute of names) {
        if (!semanticAttributes.has(attribute)) continue;
        const text = element.getAttribute(attribute);
        if (text && text.trim()) values.push({ attribute, text });
      }
      return values;
    };
    const snapshot = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentNode;
        const owner = parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? parent.host : node.parentElement;
        if (!owner || !visible(owner)) return null;
        const location = shadowLocationOf(node.parentElement || parent);
        return { kind: 'text', text: node.nodeValue || '', textNodeIndex: Array.from(parent?.childNodes || []).indexOf(node), visible: true, children: [] };
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const element = node;
      if (!visible(element)) return { kind: 'element', tag: element.tagName.toLowerCase(), visible: false, children: [] };
      const location = shadowLocationOf(element);
      const ownSelector = location ? undefined : selectorOf(element);
      const semanticTexts = semanticTextsOf(element);
      const children = [];
      const childNodes = element.shadowRoot
        ? element.shadowRoot.childNodes
        : formControls.has(element.tagName) ? [] : element.childNodes;
      for (const child of childNodes) {
        const result = snapshot(child);
        if (result) children.push(result);
      }
      return {
        kind: 'element', tag: element.tagName.toLowerCase(), visible: true,
        role: element.getAttribute('role') || undefined, id: element.id || undefined,
        testId: element.getAttribute('data-testid') || undefined, selector: ownSelector,
        rect: rectOf(element), semanticTexts: semanticTexts.length ? semanticTexts : undefined,
        shadowRoot: Boolean(element.shadowRoot),
        shadowHostSelector: element.shadowRoot ? selectorOf(element) : location?.hostSelector,
        shadowPath: location?.path,
        children
      };
    };
    const imageMinSize = 64;
    const imageIgnoredTags = new Set(['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','IFRAME']);
    const decorativeSource = /(^|[\\/_.-])(sprite|icon|logo|avatar|favicon|badge|pixel|spacer|qrcode|qr-code)([\\/_.-]|$)/i;
    const imageHash = (value) => {
      let result = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
      }
      return (result >>> 0).toString(16).padStart(8, '0');
    };
    const imageVisible = (element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (Number(style.opacity) === 0) return false;
      return true;
    };
    const isDecorative = (element, source, rect) => {
      const role = (element.getAttribute('role') || '').toLowerCase();
      if (role === 'presentation' || role === 'none') return true;
      if (element.getAttribute('aria-hidden') === 'true') return true;
      const alt = element.getAttribute('alt');
      if (alt === '' && rect.width < imageMinSize * 2 && rect.height < imageMinSize * 2) return true;
      if (typeof source === 'string' && source && decorativeSource.test(source) &&
          rect.width < imageMinSize * 3 && rect.height < imageMinSize * 3) return true;
      return false;
    };
    const imageSelectorOf = (element) => {
      const location = shadowLocationOf(element);
      return location ? location.hostSelector : selectorOf(element);
    };
    const pushImageCandidate = (element, kind, source, naturalWidth, naturalHeight) => {
      if (!element || !imageVisible(element)) return;
      if (imageIgnoredTags.has(element.tagName)) return;
      if (element.isContentEditable || element.contentEditable === 'true') return;
      if (element.closest && element.closest('[data-st-image-translation]')) return;
      const rect = element.getBoundingClientRect();
      if (rect.width < imageMinSize || rect.height < imageMinSize) return;
      if (rect.width * rect.height > 20000000) return;
      if (isDecorative(element, source, rect)) return;
      const location = shadowLocationOf(element);
      const selector = location ? location.hostSelector : selectorOf(element);
      const pageRect = rectOf(element);
      const normalizedSource = typeof source === 'string' ? source : '';
      const inline = normalizedSource.startsWith('data:') || normalizedSource.startsWith('blob:');
      const sourceFingerprint = imageHash([
        normalizedSource,
        element.getAttribute('alt') || '',
        kind,
        naturalWidth || 0,
        naturalHeight || 0
      ].join('|'));
      const imageId = 'web-image-' + imageHash(JSON.stringify([
        selector, kind, location ? location.path : [], pageRect.x, pageRect.y, pageRect.width, pageRect.height, sourceFingerprint
      ]));
      if (seenImageIds.has(imageId)) return;
      seenImageIds.add(imageId);
      results.push({
        imageId,
        kind,
        selector,
        rect: pageRect,
        naturalWidth: naturalWidth || undefined,
        naturalHeight: naturalHeight || undefined,
        sourceFingerprint,
        src: normalizedSource || undefined,
        alt: element.getAttribute('alt') || undefined,
        inline: inline || undefined,
        shadowPath: location ? location.path : undefined
      });
    };
    const results = [];
    const seenImageIds = new Set();
    const visitImageNode = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node;
      if (element.closest && element.closest('[data-st-image-translation]')) return;
      if (element.tagName === 'IMG') {
        pushImageCandidate(element, 'img', element.currentSrc || element.getAttribute('src') || '', element.naturalWidth, element.naturalHeight);
      } else if (element.tagName === 'CANVAS') {
        pushImageCandidate(element, 'canvas', '', element.width, element.height);
      } else if (!imageIgnoredTags.has(element.tagName)) {
        const style = getComputedStyle(element);
        const background = style.backgroundImage || '';
        if (background && background !== 'none' && background.indexOf('url(') >= 0) {
          const match = /url\\(["']?([^"')]+)["']?\\)/i.exec(background);
          pushImageCandidate(element, 'background', match ? match[1] : '', 0, 0);
        }
      }
      if (element.shadowRoot) for (const child of element.shadowRoot.children) visitImageNode(child);
      for (const child of element.children) visitImageNode(child);
    };
    const collectImageCandidates = (root) => {
      if (!root) return [];
      visitImageNode(root);
      return results;
    };
    const imageCandidates = collectImageCandidates(document.body || document.documentElement);
    return { snapshot: snapshot(document.body || document.documentElement), imageCandidates, pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined } };
  })()`
}

/**
 * 构造页面侧增量文本收集器启动脚本，并立即返回当前 DOM 首批快照。
 * @param debounceMs MutationObserver 变更防抖毫秒数。
 * @returns 可传给 webContents.executeJavaScript 的启动脚本字符串。
 * @author zhenghq
 */
export function buildWebIncrementalCollectorStartScript(debounceMs = 300): string {
  const safeDebounce = Math.max(0, Math.floor(debounceMs))
  return `(() => {
    const previous = window.__selectionTranslatorWebTranslation;
    if (previous?.observers) for (const observer of previous.observers) observer.disconnect();
    if (previous?.observer) previous.observer.disconnect();
    if (previous?.timer) clearTimeout(previous.timer);
    const ignored = new Set(['SCRIPT','STYLE','TEMPLATE','SVG','NOSCRIPT','CANVAS','IFRAME']);
    const formControls = new Set(['INPUT','TEXTAREA','SELECT','OPTION']);
    const blockTags = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BUTTON','DD','DIV','DL','DT','FIGCAPTION','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TD','TH','TR','UL']);
    const semanticAttributes = new Set(['placeholder','aria-label','title']);
    const hash = (value) => {
      let result = 2166136261;
      for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619); }
      return (result >>> 0).toString(16).padStart(8, '0');
    };
    const selectorOf = (element) => {
      if (element.id) return '[id="' + CSS.escape(element.id) + '"]';
      const testId = element.getAttribute('data-testid');
      if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
      const segments = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parent = current.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1;
        const tag = current.tagName.toLowerCase();
        // html 与 body 是文档唯一根元素，使用标签本身定位，避免受 head 等兄弟节点影响。
        segments.unshift(tag === 'html' || tag === 'body' ? tag : tag + ':nth-child(' + index + ')');
        current = parent;
      }
      return segments.join(' > ');
    };
    const visible = (element) => {
      if (!element || ignored.has(element.tagName) || element.isContentEditable || element.contentEditable === 'true') return false;
      // 应用注入的对照与图片译文节点及其子树不参与增量收集，避免译文被当作新原文再次翻译。
      if (element.closest && element.closest('[data-st-translation],[data-st-image-translation]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
        (style.display === 'contents' || (rect.width > 0 && rect.height > 0));
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const semanticTextsOf = (element, onlyNew) => {
      const names = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
        ? ['placeholder','aria-label','title']
        : ['aria-label','title'];
      const values = [];
      for (const attribute of names) {
        if (!semanticAttributes.has(attribute)) continue;
        const text = element.getAttribute(attribute);
        if (!text || !text.trim()) continue;
        const key = selectorOf(element) + '|' + attribute + '|' + hash(text);
        if (onlyNew && seen.has(key)) continue;
        seen.add(key);
        values.push({ attribute, text });
      }
      return values;
    };
    const shadowLocationOf = (node) => {
      const root = node?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node : node?.getRootNode?.();
      if (!root || root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE || !root.host) return null;
      const path = [];
      let current = node === root ? null : node;
      while (current && current.parentNode !== root) {
        const parent = current.parentNode;
        if (!parent) return null;
        path.unshift(Array.from(parent.childNodes).indexOf(current));
        current = parent;
      }
      if (current) path.unshift(Array.from(root.childNodes).indexOf(current));
      return { hostSelector: selectorOf(root.host), path };
    };
    const seen = new Set();
    const imageMinSize = 64;
    const imageIgnoredTags = new Set(['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','IFRAME']);
    const decorativeSource = /(^|[\\/_.-])(sprite|icon|logo|avatar|favicon|badge|pixel|spacer|qrcode|qr-code)([\\/_.-]|$)/i;
    const imageHash = (value) => {
      let result = 2166136261;
      for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619); }
      return (result >>> 0).toString(16).padStart(8, '0');
    };
    const imageVisible = (element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (Number(style.opacity) === 0) return false;
      return true;
    };
    const isDecorative = (element, source, rect) => {
      const role = (element.getAttribute('role') || '').toLowerCase();
      if (role === 'presentation' || role === 'none') return true;
      if (element.getAttribute('aria-hidden') === 'true') return true;
      const alt = element.getAttribute('alt');
      if (alt === '' && rect.width < imageMinSize * 2 && rect.height < imageMinSize * 2) return true;
      if (typeof source === 'string' && source && decorativeSource.test(source) &&
          rect.width < imageMinSize * 3 && rect.height < imageMinSize * 3) return true;
      return false;
    };
    const buildImageCandidate = (element, kind, source, naturalWidth, naturalHeight) => {
      if (!element || !imageVisible(element)) return null;
      if (imageIgnoredTags.has(element.tagName)) return null;
      if (element.isContentEditable || element.contentEditable === 'true') return null;
      if (element.closest && element.closest('[data-st-image-translation]')) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width < imageMinSize || rect.height < imageMinSize) return null;
      if (rect.width * rect.height > 20000000) return null;
      if (isDecorative(element, source, rect)) return null;
      const location = shadowLocationOf(element);
      const selector = location ? location.hostSelector : selectorOf(element);
      const pageRect = rectOf(element);
      const normalizedSource = typeof source === 'string' ? source : '';
      const inline = normalizedSource.startsWith('data:') || normalizedSource.startsWith('blob:');
      const sourceFingerprint = imageHash([normalizedSource, element.getAttribute('alt') || '', kind, naturalWidth || 0, naturalHeight || 0].join('|'));
      const imageId = 'web-image-' + imageHash(JSON.stringify([
        selector, kind, location ? location.path : [], pageRect.x, pageRect.y, pageRect.width, pageRect.height, sourceFingerprint
      ]));
      return {
        imageId, kind, selector, rect: pageRect,
        naturalWidth: naturalWidth || undefined, naturalHeight: naturalHeight || undefined,
        sourceFingerprint, src: normalizedSource || undefined,
        alt: element.getAttribute('alt') || undefined, inline: inline || undefined,
        shadowPath: location ? location.path : undefined
      };
    };
    const seenImageIds = new Set();
    const collectImages = (root) => {
      if (!root) return [];
      const output = [];
      const visit = (node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node;
        if (element.closest && element.closest('[data-st-image-translation]')) return;
        let candidate = null;
        if (element.tagName === 'IMG') {
          candidate = buildImageCandidate(element, 'img', element.currentSrc || element.getAttribute('src') || '', element.naturalWidth, element.naturalHeight);
        } else if (element.tagName === 'CANVAS') {
          candidate = buildImageCandidate(element, 'canvas', '', element.width, element.height);
        } else if (!imageIgnoredTags.has(element.tagName)) {
          const background = getComputedStyle(element).backgroundImage || '';
          if (background && background !== 'none' && background.indexOf('url(') >= 0) {
            const match = /url\\(["']?([^"')]+)["']?\\)/i.exec(background);
            candidate = buildImageCandidate(element, 'background', match ? match[1] : '', 0, 0);
          }
        }
        if (candidate && !seenImageIds.has(candidate.imageId)) {
          seenImageIds.add(candidate.imageId);
          output.push(candidate);
        }
        if (element.shadowRoot) for (const child of element.shadowRoot.children) visit(child);
        for (const child of element.children) visit(child);
      };
      visit(root);
      return output;
    };
    const snapshot = (node, onlyNew) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentNode;
        const owner = parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? parent.host : node.parentElement;
        if (!owner || !visible(owner)) return null;
        const text = node.nodeValue || '';
        const location = shadowLocationOf(node.parentElement || parent);
        const selector = location ? location.hostSelector : selectorOf(owner);
        const textNodeIndex = Array.from(parent?.childNodes || []).indexOf(node);
        const sourceFingerprint = hash(text);
        const key = selector + '|' + (location ? JSON.stringify(location.path) : '') + '|' + textNodeIndex + '|' + sourceFingerprint;
        if (onlyNew && seen.has(key)) return null;
        seen.add(key);
        return { kind: 'text', text, textNodeIndex, visible: true, shadowPath: location?.path, shadowHostSelector: location?.hostSelector, children: [] };
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const element = node;
      if (!visible(element)) return { kind: 'element', tag: element.tagName.toLowerCase(), visible: false, children: [] };
      const location = shadowLocationOf(element);
      const semanticTexts = semanticTextsOf(element, onlyNew);
      const children = [];
      const childNodes = element.shadowRoot ? element.shadowRoot.childNodes : formControls.has(element.tagName) ? [] : element.childNodes;
      for (const child of childNodes) { const item = snapshot(child, onlyNew); if (item) children.push(item); }
      if (onlyNew && children.length === 0 && semanticTexts.length === 0) return null;
      return { kind: 'element', tag: element.tagName.toLowerCase(), visible: true, role: element.getAttribute('role') || undefined, id: element.id || undefined, testId: element.getAttribute('data-testid') || undefined, selector: location ? undefined : selectorOf(element), rect: rectOf(element), semanticTexts: semanticTexts.length ? semanticTexts : undefined, shadowRoot: Boolean(element.shadowRoot), shadowPath: location?.path, shadowHostSelector: element.shadowRoot ? selectorOf(element) : location?.hostSelector, children };
    };
    const semanticRoot = (node) => {
      let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!element && node?.host) element = node.host;
      while (element?.parentElement && !blockTags.has(element.tagName)) element = element.parentElement;
      return element || document.body || document.documentElement;
    };
    const state = window.__selectionTranslatorWebTranslation = {
      active: true, pageUpdated: false, suppressed: false, observer: null, observers: [], timer: null,
      roots: new Set(), pending: [], pendingImageCandidates: [], seen,
      flush() {
        if (!this.active || this.suppressed) return [];
        const roots = Array.from(this.roots); this.roots.clear();
        const snapshots = [];
        const images = [];
        for (const root of roots) {
          const item = snapshot(root, true);
          if (item) snapshots.push(item);
          images.push(...collectImages(root));
        }
        if (snapshots.length) this.pending.push(...snapshots);
        if (images.length) this.pendingImageCandidates.push(...images);
        return snapshots;
      },
      stop() {
        this.active = false;
        for (const observer of this.observers || []) observer.disconnect();
        if (this.observer) this.observer.disconnect();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
    };
    const root = document.body || document.documentElement;
    const initialImages = collectImages(root);
    const initial = root ? snapshot(root, false) : null;
    const observer = new MutationObserver((records) => {
      if (!state.active || state.suppressed) return;
      state.pageUpdated = true;
      for (const record of records) {
        state.roots.add(semanticRoot(record.target));
        if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            state.roots.add(semanticRoot(node));
            observeShadowRoots(node);
          }
        }
      }
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => { state.timer = null; state.flush(); }, ${safeDebounce});
    });
    const observedRoots = new Set();
    const observeShadowRoots = (node) => {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (element.shadowRoot && !observedRoots.has(element.shadowRoot)) {
          observedRoots.add(element.shadowRoot);
          observer.observe(element.shadowRoot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder','aria-label','title'] });
        }
      }
      for (const child of node.childNodes || []) observeShadowRoots(child);
    };
    if (root) {
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder','aria-label','title'] });
      observeShadowRoots(root);
    }
    state.observer = observer;
    state.observers = [observer];
    return { snapshot: initial, imageCandidates: initialImages, pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined } };
  })()`
}

/**
 * 构造排空页面侧增量文本快照缓冲区的脚本。
 * @returns 可传给 webContents.executeJavaScript 的排空脚本字符串。
 * @author zhenghq
 */
export function buildWebIncrementalCollectorDrainScript(): string {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation;
    if (!state) return { snapshots: [], imageCandidates: [], pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined }, active: false, pageUpdated: false };
    if (state.timer) { clearTimeout(state.timer); state.timer = null; state.flush(); }
    const snapshots = state.pending.splice(0);
    const imageCandidates = state.pendingImageCandidates ? state.pendingImageCandidates.splice(0) : [];
    return { snapshots, imageCandidates, pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined }, active: Boolean(state.active), pageUpdated: Boolean(state.pageUpdated) };
  })()`
}

/**
 * 构造停止页面侧增量收集器的脚本。
 * @returns 可传给 webContents.executeJavaScript 的停止脚本字符串。
 * @author zhenghq
 */
export function buildWebIncrementalCollectorStopScript(): string {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation;
    if (!state) return false;
    state.active = false;
    if (state.observer) state.observer.disconnect();
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    return true;
  })()`
}

/**
 * 构造受控文本节点原位写回脚本。
 * @param operations 待写回文本单元。
 * @param mode 原文或译文模式。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebTextApplyScript(
  operations: WebTextWriteOperation[],
  mode: WebTranslationMode
): string {
  const serialized = JSON.stringify(operations)
  const serializedMode = JSON.stringify(mode)
  return `(() => {
    const operations = ${serialized};
    const mode = ${serializedMode};
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    const hash = (value) => {
      let result = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
      }
      return (result >>> 0).toString(16).padStart(8, '0');
    };
    const preserve = (source, translation) => {
      const leading = source.match(/^\\s*/u)?.[0] || '';
      const trailing = source.match(/\\s*$/u)?.[0] || '';
      return leading + String(translation || '').trim() + trailing;
    };
    const stats = { applied: 0, mismatched: 0, skipped: 0 };
    const resolveShadowParent = (anchor) => {
      let parent = null;
      try { parent = document.querySelector(anchor.parentSelector); } catch {}
      if (!parent || !Array.isArray(anchor.shadowPath)) return parent;
      let current = parent.shadowRoot;
      for (const index of anchor.shadowPath) {
        if (!current?.childNodes?.[index]) return null;
        current = current.childNodes[index];
      }
      return current;
    };
    state.suppressed = true;
    for (const operation of operations) {
      if (mode === 'target' && typeof operation.translation !== 'string') { stats.skipped += 1; continue; }
      const target = preserve(operation.sourceText, operation.translation || '');
      const sourceFingerprint = operation.anchor.sourceFingerprint;
      const targetFingerprint = hash(target);
      const desired = mode === 'source' ? operation.sourceText : target;
      const parent = resolveShadowParent(operation.anchor);
      if (operation.anchor.semanticAttribute) {
        if (!parent || parent.nodeType !== Node.ELEMENT_NODE) { stats.mismatched += 1; continue; }
        const current = String(parent.getAttribute(operation.anchor.semanticAttribute) || '');
        const currentFingerprint = hash(current);
        if (currentFingerprint !== sourceFingerprint && currentFingerprint !== targetFingerprint) { stats.mismatched += 1; continue; }
        if (current !== desired) parent.setAttribute(operation.anchor.semanticAttribute, desired);
        stats.applied += 1;
        continue;
      }
      const node = parent?.childNodes?.[operation.anchor.textNodeIndex];
      if (!node || node.nodeType !== Node.TEXT_NODE) { stats.mismatched += 1; continue; }
      const current = String(node.nodeValue || '');
      const currentFingerprint = hash(current);
      if (currentFingerprint !== sourceFingerprint && currentFingerprint !== targetFingerprint) { stats.mismatched += 1; continue; }
      if (current !== desired) node.nodeValue = desired;
      stats.applied += 1;
    }
    setTimeout(() => { state.suppressed = false; }, 0);
    return stats;
  })()`
}

/**
 * 构造对照译文注入脚本，按 blockId 幂等 upsert 译文节点。
 * @param operations 待注入的对照操作。
 * @param targetLang 目标语言代码，用于译文节点 lang 属性。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebBilingualInjectScript(
  operations: WebBilingualInjectionOperation[],
  targetLang: string
): string {
  const serialized = JSON.stringify(operations)
  const serializedLang = JSON.stringify(targetLang)
  return `(() => {
    const operations = ${serialized};
    const targetLang = ${serializedLang};
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    const stats = { applied: 0, mismatched: 0, skipped: 0 };
    const resolveParent = (selector) => {
      try { return document.querySelector(selector); } catch { return null; }
    };
    state.suppressed = true;
    for (const operation of operations) {
      const block = resolveParent(operation.selector);
      if (!block || block.nodeType !== Node.ELEMENT_NODE) { stats.mismatched += 1; continue; }
      if (block.closest('[data-st-translation]')) { stats.skipped += 1; continue; }
      const display = getComputedStyle(block).display || '';
      let node = null;
      for (const candidate of block.querySelectorAll('[data-st-translation]')) {
        if (candidate.getAttribute('data-st-translation-for') === operation.blockId) { node = candidate; break; }
      }
      if (!node) {
        node = document.createElement('span');
        node.setAttribute('data-st-translation', '');
        node.setAttribute('data-st-translation-for', operation.blockId);
        node.setAttribute('data-st-parent-display', display.indexOf('flex') >= 0 ? 'flex' : display.indexOf('grid') >= 0 ? 'grid' : 'block');
        block.appendChild(node);
      } else {
        node.setAttribute('data-st-parent-display', display.indexOf('flex') >= 0 ? 'flex' : display.indexOf('grid') >= 0 ? 'grid' : 'block');
      }
      if (node.textContent !== operation.translation) node.textContent = operation.translation;
      node.setAttribute('lang', targetLang);
      node.setAttribute('dir', 'auto');
      block.setAttribute('data-st-dimmed', 'true');
      stats.applied += 1;
    }
    setTimeout(() => { state.suppressed = false; }, 0);
    return stats;
  })()`
}

/**
 * 构造对照译文清理脚本，移除全部注入节点与标记属性。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebBilingualClearScript(): string {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    state.suppressed = true;
    const nodes = document.querySelectorAll('[data-st-translation]');
    let removed = 0;
    for (const node of nodes) { if (node.parentNode) { node.parentNode.removeChild(node); removed += 1; } }
    for (const element of document.querySelectorAll('[data-st-dimmed]')) element.removeAttribute('data-st-dimmed');
    for (const element of document.querySelectorAll('[data-st-parent-display]')) element.removeAttribute('data-st-parent-display');
    setTimeout(() => { state.suppressed = false; }, 0);
    return { applied: removed, mismatched: 0, skipped: 0 };
  })()`
}

/**
 * 返回对照模式使用的页面内样式表。
 * @returns 可传给 webContents.insertCSS 的样式字符串。
 * @author zhenghq
 */
export function buildWebBilingualStyleSheet(): string {
  return [
    '[data-st-translation] { display: block; color: inherit; font: inherit; line-height: inherit; }',
    "[data-st-translation][data-st-parent-display='flex'] { flex: 1 0 100%; }",
    "[data-st-translation][data-st-parent-display='grid'] { grid-column: 1 / -1; }",
    "[data-st-dimmed='true'] > *:not([data-st-translation]), [data-st-dimmed='true'] { opacity: 0.6; }"
  ].join('\n')
}

/**
 * 构造图片译文覆盖层注入脚本，按 imageId 幂等 upsert。
 * @param operations 待注入的图片覆盖层操作。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebImageOverlayInjectScript(operations: WebImageOverlayOperation[]): string {
  const serialized = JSON.stringify(operations)
  return `(() => {
    const operations = ${serialized};
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    const stats = { applied: 0, mismatched: 0, skipped: 0 };
    const resolveTarget = (operation) => {
      let element = null;
      try { element = document.querySelector(operation.selector); } catch {}
      if (!element || !Array.isArray(operation.shadowPath) || operation.shadowPath.length === 0) return element;
      let current = element.shadowRoot;
      for (const index of operation.shadowPath) {
        if (!current?.childNodes?.[index]) return null;
        current = current.childNodes[index];
      }
      return current?.nodeType === Node.ELEMENT_NODE ? current : null;
    };
    state.suppressed = true;
    for (const operation of operations) {
      const target = resolveTarget(operation);
      if (!target || target.nodeType !== Node.ELEMENT_NODE) { stats.mismatched += 1; continue; }
      if (target.closest && target.closest('[data-st-image-translation]')) { stats.skipped += 1; continue; }
      let node = null;
      for (const candidate of document.querySelectorAll('[data-st-image-translation]')) {
        if (candidate.getAttribute('data-st-image-translation-for') === operation.imageId) { node = candidate; break; }
      }
      if (!node) {
        node = document.createElement('div');
        node.setAttribute('data-st-image-translation', '');
        node.setAttribute('data-st-image-translation-for', operation.imageId);
        if (operation.placement === 'overlay' && target.parentNode) {
          target.parentNode.insertBefore(node, target.nextSibling);
        } else if (target.parentNode) {
          target.parentNode.insertBefore(node, target.nextSibling);
        }
      }
      node.setAttribute('data-st-image-placement', operation.placement === 'overlay' ? 'overlay' : 'below');
      const source = document.createElement('div');
      source.setAttribute('data-st-image-source', '');
      source.textContent = operation.ocrText;
      const translation = document.createElement('div');
      translation.setAttribute('data-st-image-target', '');
      translation.setAttribute('lang', operation.lang || '');
      translation.textContent = operation.translation;
      node.textContent = '';
      if (operation.bilingual) node.appendChild(source);
      node.appendChild(translation);
      stats.applied += 1;
    }
    setTimeout(() => { state.suppressed = false; }, 0);
    return stats;
  })()`
}

/**
 * 构造图片译文覆盖层清理脚本，移除全部注入覆盖层。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebImageOverlayClearScript(): string {
  return `(() => {
    const state = window.__selectionTranslatorWebTranslation || (window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false });
    state.suppressed = true;
    const nodes = document.querySelectorAll('[data-st-image-translation]');
    let removed = 0;
    for (const node of nodes) { if (node.parentNode) { node.parentNode.removeChild(node); removed += 1; } }
    setTimeout(() => { state.suppressed = false; }, 0);
    return { applied: removed, mismatched: 0, skipped: 0 };
  })()`
}

/**
 * 返回图片译文覆盖层使用的页面内样式表。
 * @returns 可传给 webContents.insertCSS 的样式字符串。
 * @author zhenghq
 */
export function buildWebImageOverlayStyleSheet(): string {
  return [
    '[data-st-image-translation] { display: block; box-sizing: border-box; margin: 6px 0; padding: 8px 10px; border-radius: 6px; font-size: 13px; line-height: 1.5; background: rgba(127,127,127,0.14); color: inherit; font-family: inherit; }',
    "[data-st-image-placement='overlay'] { position: absolute; left: 0; right: 0; bottom: 0; margin: 0; border-radius: 0 0 6px 6px; background: rgba(0,0,0,0.62); color: #fff; max-height: 70%; overflow: auto; }",
    '[data-st-image-target] { display: block; }',
    '[data-st-image-source] { display: block; opacity: 0.7; font-size: 12px; margin-bottom: 4px; }'
  ].join('\n')
}

/**
 * 构造只检测页面文本变化的 MutationObserver 脚本。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebPageChangeObserverScript(): string {
  return `(() => {
    const previous = window.__selectionTranslatorWebTranslation;
    if (previous?.observer) previous.observer.disconnect();
    const state = window.__selectionTranslatorWebTranslation = { pageUpdated: false, suppressed: false, observer: null };
    const observer = new MutationObserver((records) => {
      if (state.suppressed) return;
      if (records.some((record) => record.type === 'characterData' || record.type === 'childList' || record.type === 'attributes')) state.pageUpdated = true;
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'aria-label', 'title'] });
    state.observer = observer;
    return true;
  })()`
}

/**
 * 构造读取页面变化状态的脚本。
 * @returns 可传给 webContents.executeJavaScript 的脚本字符串。
 * @author zhenghq
 */
export function buildWebPageChangeStatusScript(): string {
  return `(() => Boolean(window.__selectionTranslatorWebTranslation?.pageUpdated))()`
}

/**
 * 带超时执行只读提取操作，避免远程页面脚本长期占用翻译流程。
 * @param execute 执行注入脚本的函数。
 * @param timeoutMs 超时时间。
 * @returns 可序列化的 DOM 快照、图片候选和页面元数据。
 * @author zhenghq
 */
export async function executeWebTextExtraction(
  execute: () => Promise<{
    snapshot: WebDomSnapshotNode
    imageCandidates?: WebImageCandidate[]
    pageMeta: WebPageMeta
  }>,
  timeoutMs = 5000
): Promise<{
  snapshot: WebDomSnapshotNode
  imageCandidates: WebImageCandidate[]
  pageMeta: WebPageMeta
}> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      execute(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('网页文本提取超时')), timeoutMs)
      })
    ])
    return {
      snapshot: result.snapshot,
      imageCandidates: Array.isArray(result.imageCandidates) ? result.imageCandidates : [],
      pageMeta: result.pageMeta
    }
  } catch (error) {
    if (error instanceof Error && error.message === '网页文本提取超时') throw error
    throw new Error('网页文本提取失败，请检查页面是否已加载完成')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 等待主文档根节点可用，不要求 DOMContentLoaded 或其他资源加载结束。
 * @param execute 读取远程页面主文档状态的函数。
 * @param timeoutMs 最大等待时间。
 * @param intervalMs 两次检查之间的间隔。
 * @returns 已创建 body 或 documentElement 的页面信息。
 * @author zhenghq
 */
export async function waitForWebDocumentReady(
  execute: () => Promise<WebDocumentReadiness>,
  timeoutMs = 10000,
  intervalMs = 50
): Promise<WebDocumentReadiness> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let last: WebDocumentReadiness | undefined
  while (Date.now() <= deadline) {
    try {
      const readiness = await execute()
      last = readiness
      if (readiness.hasRoot) {
        return readiness
      }
    } catch {
      // 页面导航切换期间 executeJavaScript 可能暂时失败，继续等待下一次状态检查。
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(Math.max(0, intervalMs), remaining)))
  }
  throw new Error(last?.hasRoot ? '网页主文档尚未准备好，请稍候再试' : '网页根节点尚未创建，请稍候再试')
}
