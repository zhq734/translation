import type {
  WebDomSnapshotNode,
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
        segments.unshift(current.tagName.toLowerCase() + ':nth-child(' + index + ')');
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
    return { snapshot: snapshot(document.body || document.documentElement), pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined } };
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
        segments.unshift(current.tagName.toLowerCase() + ':nth-child(' + index + ')');
        current = parent;
      }
      return segments.join(' > ');
    };
    const visible = (element) => {
      if (!element || ignored.has(element.tagName) || element.isContentEditable || element.contentEditable === 'true') return false;
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
      roots: new Set(), pending: [], seen,
      flush() {
        if (!this.active || this.suppressed) return [];
        const roots = Array.from(this.roots); this.roots.clear();
        const snapshots = [];
        for (const root of roots) { const item = snapshot(root, true); if (item) snapshots.push(item); }
        if (snapshots.length) this.pending.push(...snapshots);
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
    return { snapshot: initial, pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined } };
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
    if (!state) return { snapshots: [], pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined }, active: false, pageUpdated: false };
    if (state.timer) { clearTimeout(state.timer); state.timer = null; state.flush(); }
    const snapshots = state.pending.splice(0);
    return { snapshots, pageMeta: { url: location.href, title: document.title || '', langHint: document.documentElement.lang || undefined }, active: Boolean(state.active), pageUpdated: Boolean(state.pageUpdated) };
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
 * @returns 可序列化的 DOM 快照和页面元数据。
 * @author zhenghq
 */
export async function executeWebTextExtraction(
  execute: () => Promise<{ snapshot: WebDomSnapshotNode; pageMeta: WebPageMeta }>,
  timeoutMs = 5000
): Promise<{ snapshot: WebDomSnapshotNode; pageMeta: WebPageMeta }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      execute(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('网页文本提取超时')), timeoutMs)
      })
    ])
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
