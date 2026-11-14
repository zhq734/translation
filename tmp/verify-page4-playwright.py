#!/usr/bin/env python3
"""使用 Chromium 加载已构建的文档工作台并复测真实 PDF 第 4 页排版。"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from playwright.sync_api import Page, sync_playwright


PROJECT_ROOT = Path('/Users/mac/E/github/translation')
REPRO_ROOT = Path('/tmp/translation-pdf-repro-current')
PDF_PATH = Path('/Users/mac/Downloads/从 AI 写代码到 AI 工作流 · 一次需求的两条命，和救回它的六个阶段-translated.pdf')
MODEL_PATH = REPRO_ROOT / 'model.json'
REPORT_PATH = REPRO_ROOT / 'ui-report-playwright.json'

model = json.loads(MODEL_PATH.read_text(encoding='utf-8'))
asset_mime_types = {asset['assetId']: asset['mimeType'] for asset in model.get('assets', [])}
settings = {
    'themePreset': 'sky',
    'themeMode': 'light',
    'uiLocale': 'zh-CN',
    'sourceLanguage': 'auto',
    'targetLanguage': 'zh-CN',
}
selection = {
    'status': 'selected',
    'path': str(PDF_PATH),
    'fileName': 'real.pdf',
    'size': PDF_PATH.stat().st_size,
    'format': 'pdf',
    'sha256': model['source']['sha256'],
    'capabilities': {
        'nativeLayout': True,
        'ocrPageImages': True,
        'ocrEmbeddedImages': True,
        'preserveStyles': True,
        'exportPdf': True,
    },
}


class ReproHttpHandler(BaseHTTPRequestHandler):
    """向浏览器提供真实 PDF、模型和图片资源。"""

    protocol_version = 'HTTP/1.1'

    def do_GET(self) -> None:  # noqa: N802
        """响应复测所需的本地资源请求。"""
        request_path = urlparse(self.path).path
        if request_path == '/pdf':
            self.respond(PDF_PATH.read_bytes(), 'application/pdf')
            return
        if request_path == '/model.json':
            self.respond(MODEL_PATH.read_bytes(), 'application/json')
            return
        if request_path.startswith('/assets/'):
            asset_id = unquote(request_path.removeprefix('/assets/'))
            asset_path = REPRO_ROOT / 'assets' / asset_id
            if asset_path.is_file():
                self.respond(asset_path.read_bytes(), asset_mime_types.get(asset_id, 'application/octet-stream'))
                return
        self.send_error(404)

    def log_message(self, format: str, *args: object) -> None:
        """关闭 HTTP 访问日志，避免大文件请求污染复测输出。"""
        return

    def respond(self, content: bytes, contentType: str) -> None:
        """返回带跨域头的字节内容。"""
        self.send_response(200)
        self.send_header('Content-Type', contentType)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content)


def start_server() -> tuple[ThreadingHTTPServer, str]:
    """启动本地资源服务并返回服务实例和基础地址。"""
    server = ThreadingHTTPServer(('127.0.0.1', 0), ReproHttpHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def build_init_script(base_url: str) -> str:
    """构造浏览器启动前注入的 Electron API 模拟。"""
    selection_json = json.dumps(selection, ensure_ascii=False)
    settings_json = json.dumps(settings, ensure_ascii=False)
    mime_json = json.dumps(asset_mime_types, ensure_ascii=False)
    return f"""
(() => {{
  const baseUrl = {json.dumps(base_url)};
  const selection = {selection_json};
  const settings = {settings_json};
  const assetMimeTypes = {mime_json};
  const state = window.__repro = {{ generation: 0, callbacks: {{}} }};

  async function readResource(path, mimeType) {{
    try {{
      const response = await fetch(baseUrl + path);
      if (!response.ok) return {{ ok: false, code: 'not-found' }};
      return {{ ok: true, mimeType, bytes: new Uint8Array(await response.arrayBuffer()) }};
    }} catch {{
      return {{ ok: false, code: 'read-failed' }};
    }}
  }}

  function subscribe(name) {{
    return (callback) => {{
      state.callbacks[name] = callback;
      return () => {{ delete state.callbacks[name]; }};
    }};
  }}

  const api = {{
    getSettings: async () => settings,
    windowIsMaximized: async () => false,
    windowMinimize: () => undefined,
    windowToggleMaximize: () => undefined,
    windowClose: () => undefined,
    onWindowMaximizedChanged: subscribe('windowMaximizedChanged'),
    getDocumentPlatformCapability: async () => ({{ supported: true }}),
    selectDocumentFiles: async () => [selection],
    approveDocumentFile: async () => selection,
    approveDocumentFiles: async () => [selection],
    runDocument: async (request) => {{
      state.generation = request.generation;
      state.runRequest = request;
      return {{ accepted: true, jobId: 'real-gui-job' }};
    }},
    cancelDocument: async () => ({{ accepted: true }}),
    releaseDocumentJob: async () => true,
    getDocumentSource: async () => readResource('/pdf', 'application/pdf'),
    getApprovedDocumentSource: async () => readResource('/pdf', 'application/pdf'),
    getDocumentAsset: async (_jobId, assetId) =>
      readResource('/assets/' + encodeURIComponent(assetId), assetMimeTypes[assetId] || 'application/octet-stream'),
    getApprovedDocumentAsset: async (request) =>
      readResource('/assets/' + encodeURIComponent(request.assetId), assetMimeTypes[request.assetId] || 'application/octet-stream'),
    listDocumentHistory: async () => [],
    openDocumentHistory: async () => null,
    deleteDocumentHistory: async () => false,
    clearDocumentCache: async () => undefined,
    retryFailedDocument: async () => ({{ accepted: false, code: 'not-ready' }}),
    retryFailedDocumentTarget: async () => ({{ accepted: false, code: 'not-ready' }}),
    retranslateDocumentTarget: async () => ({{ accepted: false, code: 'not-ready' }}),
    switchDocumentMode: async () => ({{ accepted: false, code: 'not-ready' }}),
    onDocumentProgress: subscribe('progress'),
    onDocumentCompleted: subscribe('completed'),
    onDocumentBlockTranslated: subscribe('blockTranslated'),
    onDocumentExportProgress: subscribe('exportProgress'),
    getDocumentDroppedFilePath: () => '',
  }};

  window.api = new Proxy(api, {{
    get(target, property) {{
      if (property in target) return target[property];
      if (typeof property === 'string' && property.startsWith('on')) return subscribe(property);
      return async () => undefined;
    }}
  }});
  window.getSelectionTranslatorLocale = () => 'zh-CN';
  window.getSelectionTranslatorWin7Compatibility = () => false;
}})();
"""


def task_state(status: str, phase: str, generation: int, progress: dict[str, int] | None = None) -> dict:
    """构造文档任务状态。"""
    return {
        'jobId': 'real-gui-job',
        'generation': generation,
        'phase': phase,
        'status': status,
        'progress': progress or {'completed': 0, 'total': 0},
        'cancellationRequested': False,
        'failedBlocks': 0,
        'warningCount': 0,
        'phaseCompleted': False,
    }


def snapshot(status: str, phase: str, generation: int, **extra: object) -> dict:
    """构造文档任务快照。"""
    return {
        'jobId': 'real-gui-job',
        'generation': generation,
        'task': task_state(status, phase, generation, {'completed': 0, 'total': 0}),
        'percent': extra.get('percent', 0),
        **extra,
    }


def wait_for(page: Page, expression: str, timeout: int = 20000) -> None:
    """等待页面表达式返回真值。"""
    page.wait_for_function(expression, timeout=timeout)


def metrics(page: Page) -> dict:
    """采集原文、译文及第 4 页覆盖组几何。"""
    return page.evaluate("""
() => {
  const sourcePages = Array.from(document.querySelectorAll('#document-source-content .document-pdf-page'));
  const translation = document.getElementById('document-translation-content');
  const page = translation?.querySelector('.document-page[data-page-id="page-7ede961270d1"]');
  if (!page) return { sourceRenderedCount: sourcePages.filter(item => item.dataset.pdfRendered === 'true').length, page4: null };
  const pageRect = page.getBoundingClientRect();
  const overlayIds = ['overlay-8dc75f8dff39', 'overlay-c9c01bebb48f', 'overlay-4d165fb4d6bc'];
  const overlays = overlayIds.map(id => {
    const overlay = page.querySelector('[data-overlay-group-id="' + id + '"]');
    if (!overlay) return { id, missing: true };
    const rect = overlay.getBoundingClientRect();
    return {
      id,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom },
      relativeToPage: { top: rect.top - pageRect.top, left: rect.left - pageRect.left },
      flowGapVar: overlay.style.getPropertyValue('--document-image-flow-gap-before'),
      computedMarginTop: getComputedStyle(overlay).marginTop,
      sourceY: overlay.dataset.sourceY,
      members: Array.from(overlay.querySelectorAll(':scope > .document-image-block')).map(member => {
        const item = member.getBoundingClientRect();
        const image = member.querySelector('.document-page-image');
        const imageRect = image?.getBoundingClientRect();
        return {
          blockId: member.dataset.blockId,
          imageId: image?.dataset.assetId || image?.getAttribute('data-asset-id') || null,
          rect: { top: item.top, left: item.left, width: item.width, height: item.height, bottom: item.bottom, right: item.right },
          relativeToPage: { top: item.top - pageRect.top, left: item.left - pageRect.left },
          imageRect: imageRect ? { top: imageRect.top, left: imageRect.left, width: imageRect.width, height: imageRect.height, bottom: imageRect.bottom, right: imageRect.right } : null,
          memberLeftVar: member.style.getPropertyValue('--document-image-overlay-member-left'),
          memberTopVar: member.style.getPropertyValue('--document-image-overlay-member-top'),
          imageWidthVar: member.style.getPropertyValue('--document-image-width'),
          imageHeightVar: member.style.getPropertyValue('--document-image-height'),
          inlineLeft: member.style.left,
          inlineTop: member.style.top,
          computedPosition: getComputedStyle(member).position,
          computedLeft: getComputedStyle(member).left,
          computedTop: getComputedStyle(member).top,
          computedWidth: getComputedStyle(member).width,
          computedHeight: getComputedStyle(member).height,
          imageObjectFit: image ? getComputedStyle(image).objectFit : null,
        };
      }),
      texts: Array.from(overlay.querySelectorAll(':scope > .document-text-block')).map(text => ({
        blockId: text.dataset.blockId,
        text: text.textContent,
        rect: (() => { const item = text.getBoundingClientRect(); return { top: item.top, left: item.left, width: item.width, height: item.height, bottom: item.bottom }; })(),
        relativeToPage: (() => { const item = text.getBoundingClientRect(); return { top: item.top - pageRect.top, left: item.left - pageRect.left }; })(),
        textLeftVar: text.style.getPropertyValue('--document-image-overlay-text-left'),
        textTopVar: text.style.getPropertyValue('--document-image-overlay-text-top'),
        textWidthVar: text.style.getPropertyValue('--document-image-overlay-text-width'),
        textHeightVar: text.style.getPropertyValue('--document-image-overlay-text-height'),
        maskColorVar: text.style.getPropertyValue('--document-image-overlay-text-mask-color'),
        beforeBackground: getComputedStyle(text, '::before').backgroundColor,
        beforeHeight: getComputedStyle(text, '::before').height,
        beforeTop: getComputedStyle(text, '::before').top,
        beforeZIndex: getComputedStyle(text, '::before').zIndex,
        computedFontSize: getComputedStyle(text).fontSize,
        computedLineHeightSource: getComputedStyle(text).lineHeight,
        computedBoxHeight: getComputedStyle(text).height,
        computedLineHeight: getComputedStyle(text).lineHeight,
        computedWhiteSpace: getComputedStyle(text).whiteSpace,
        scrollHeight: text.scrollHeight,
        clientHeight: text.clientHeight,
        runs: Array.from(text.querySelectorAll('.document-text-run')).map(run => {
          const item = run.getBoundingClientRect();
          const style = getComputedStyle(run);
          return {
            text: run.textContent,
            rect: { top: item.top, left: item.left, width: item.width, height: item.height, bottom: item.bottom, right: item.right },
            relativeToPage: { top: item.top - pageRect.top, left: item.left - pageRect.left },
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontFamily: style.fontFamily,
            display: style.display,
          };
        }),
      })),
    };
  });
  return {
    sourceRenderedCount: sourcePages.filter(item => item.dataset.pdfRendered === 'true').length,
    translationPageCount: translation.querySelectorAll('.document-page').length,
    pageRect: { top: pageRect.top, left: pageRect.left, width: pageRect.width, height: pageRect.height },
    overlays,
    firstChildren: Array.from(page.children).slice(0, 18).map(child => {
      const rect = child.getBoundingClientRect();
      return {
        className: child.className,
        blockId: child.dataset.blockId,
        relativeTop: rect.top - pageRect.top,
        relativeBottom: rect.bottom - pageRect.top,
        flowGapVar: child.style.getPropertyValue('--document-image-flow-gap-before'),
      };
    }),
  };
}
""")


def main() -> None:
    """运行完整复测并输出精简结果。"""
    server, base_url = start_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--allow-file-access-from-files'])
            context = browser.new_context(viewport={'width': 1400, 'height': 900}, device_scale_factor=1)
            page = context.new_page()
            diagnostics: list[dict] = []
            page.on('console', lambda message: diagnostics.append({'type': message.type, 'text': message.text}))
            page.on('pageerror', lambda error: diagnostics.append({'type': 'pageerror', 'text': str(error)}))
            page.add_init_script(build_init_script(base_url))
            document_html = PROJECT_ROOT / 'out/renderer/document.html'
            page.goto(document_html.as_uri(), wait_until='load')
            wait_for(page, "document.documentElement.hasAttribute('data-i18n-pending') === false", 10000)
            wait_for(page, """(() => {
  const zone = document.getElementById('document-drop-zone');
  return window.api && zone?.getAttribute('aria-disabled') === 'false';
})()""", 15000)

            page.click('#document-drop-zone')
            if os.environ.get('SKIP_SOURCE_CANVAS_WAIT') == '1':
                # 对齐实验只依赖译文模型；原文首屏渲染已在独立复测中验证，避免大 PDF 偶发加载拖住实验。
                wait_for(page, "Boolean(window.__repro?.callbacks?.progress)", 30000)
            else:
                wait_for(page, """(() => {
  const page = document.querySelector('#document-source-content .document-pdf-page[data-pdf-rendered="true"]');
  const canvas = page?.querySelector('canvas');
  return Boolean(page && canvas && canvas.width > 0 && canvas.height > 0);
})()""", 120000)
            pending_metrics = metrics(page)
            page.screenshot(path=str(REPRO_ROOT / 'playwright-source-pending.png'))

            generation = page.evaluate('window.__repro.generation')
            page.evaluate('(value) => window.__repro.callbacks.progress(value)', snapshot('parsing', 'parse', generation, percent=10))
            page.wait_for_timeout(500)
            parsing_metrics = metrics(page)
            page.evaluate('(value) => window.__repro.callbacks.completed(value)', snapshot('failed', 'parse', generation, percent=10, errorCode='ocr-failed'))
            page.wait_for_timeout(800)
            failed_metrics = metrics(page)
            page.screenshot(path=str(REPRO_ROOT / 'playwright-source-failed.png'))

            rerun_disabled = page.is_disabled('#document-rerun-button')
            if not rerun_disabled:
                page.click('#document-rerun-button')
            page.wait_for_timeout(300)
            generation = page.evaluate('window.__repro.generation')
            translating = snapshot('translating', 'translate', generation, percent=70, source=model, translation=model)
            page.evaluate('(value) => window.__repro.callbacks.progress(value)', translating)
            page.wait_for_function("""() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7ede961270d1"]');
  return Boolean(page && page.querySelector('[data-overlay-group-id="overlay-4d165fb4d6bc"]'));
}""", timeout=30000)
            page.wait_for_timeout(2000)
            translated_metrics = metrics(page)
            page.screenshot(path=str(REPRO_ROOT / 'playwright-translated-page-1.png'))

            page.evaluate("""() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7ede961270d1"]');
  page?.scrollIntoView({ block: 'start' });
}""")
            page.wait_for_timeout(800)
            page4_metrics = metrics(page)
            page.screenshot(path=str(REPRO_ROOT / 'playwright-translated-page-4.png'))
            alignment_experiment = os.environ.get('OVERLAY_ALIGN_EXPERIMENT', '')
            if alignment_experiment:
                page.evaluate("""(variant) => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7ede961270d1"]');
  for (const text of page?.querySelectorAll('[data-image-overlay-text="true"]') ?? []) {
    const runs = Array.from(text.querySelectorAll('.document-text-run'));
    if (variant === 'run-top') {
      for (const run of runs) run.style.verticalAlign = 'top';
    } else if (variant === 'run-inline-block-top') {
      for (const run of runs) {
        run.style.display = 'inline-block';
        run.style.verticalAlign = 'top';
      }
    } else if (variant === 'parent-font') {
      const size = Number.parseFloat(text.style.getPropertyValue('--document-image-overlay-text-height'));
      const scale = Number.parseFloat(getComputedStyle(page).getPropertyValue('--document-page-scale')) || 1;
      text.style.fontSize = `${size * scale}px`;
    } else if (variant === 'run-relative-up') {
      for (const run of runs) {
        run.style.position = 'relative';
        run.style.top = '-1px';
      }
    } else if (variant.startsWith('inline-block-top-mask-box-')) {
      for (const run of runs) {
        run.style.display = 'inline-block';
        run.style.verticalAlign = 'top';
      }
      const padding = Number.parseFloat(variant.slice('inline-block-top-mask-box-'.length));
      if (Number.isFinite(padding) && padding > 0) {
        const style = document.createElement('style');
        style.textContent = `
          .document-image-overlay > .document-text-block[data-image-overlay-text="true"]::before {
            top: -${padding}px !important;
            left: -${padding}px !important;
            width: calc(100% + ${padding * 2}px) !important;
            height: calc(
              var(--document-image-overlay-text-height, auto) *
              var(--document-page-scale, 1) +
              ${padding * 2}px
            ) !important;
          }
        `;
        document.head.append(style);
      }
    } else if (variant.startsWith('inline-block-top-mask-')) {
      for (const run of runs) {
        run.style.display = 'inline-block';
        run.style.verticalAlign = 'top';
      }
      const padding = Number.parseFloat(variant.slice('inline-block-top-mask-'.length));
      if (Number.isFinite(padding) && padding > 0) {
        const style = document.createElement('style');
        style.textContent = `
          .document-image-overlay > .document-text-block[data-image-overlay-text="true"]::before {
            top: -${padding}px !important;
            height: calc(
              var(--document-image-overlay-text-height, auto) *
              var(--document-page-scale, 1) +
              ${padding * 2}px
            ) !important;
          }
        `;
        document.head.append(style);
      }
    }
  }
}""", alignment_experiment)
                page.wait_for_timeout(300)
                page.screenshot(path=str(REPRO_ROOT / f'playwright-translated-page-4-{alignment_experiment}.png'))
                alignment_metrics = metrics(page)
            else:
                alignment_metrics = None
            page.evaluate("""() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7ede961270d1"]');
  for (const image of page?.querySelectorAll('.document-image-block') ?? []) {
    image.style.visibility = 'hidden';
  }
}""")
            page.screenshot(path=str(REPRO_ROOT / 'playwright-translated-page-4-mask-only.png'))
            page.evaluate("""() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7ede961270d1"]');
  for (const image of page?.querySelectorAll('.document-image-block') ?? []) {
    image.style.visibility = '';
  }
}""")
            page.evaluate("""() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7ede961270d1"]');
  for (const text of page?.querySelectorAll('[data-image-overlay-text="true"]') ?? []) {
    text.style.visibility = 'hidden';
  }
}""")
            page.screenshot(path=str(REPRO_ROOT / 'playwright-translated-page-4-image-text-only.png'))

            report = {
                'engine': 'chromium-playwright',
                'diagnostics': diagnostics,
                'pendingMetrics': pending_metrics,
                'parsingMetrics': parsing_metrics,
                'failedMetrics': failed_metrics,
                'rerunDisabled': rerun_disabled,
                'translatedMetrics': translated_metrics,
                'page4Metrics': page4_metrics,
                'alignmentExperiment': alignment_experiment or None,
                'alignmentMetrics': alignment_metrics,
            }
            REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({
                'report': str(REPORT_PATH),
                'pendingSourceRenderedCount': pending_metrics['sourceRenderedCount'],
                'parsingSourceRenderedCount': parsing_metrics['sourceRenderedCount'],
                'failedSourceRenderedCount': failed_metrics['sourceRenderedCount'],
                'page4Overlays': page4_metrics['overlays'],
                'pageErrors': [item for item in diagnostics if item['type'] in ('error', 'pageerror')],
            }, ensure_ascii=False, indent=2))
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
