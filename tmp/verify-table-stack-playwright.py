#!/usr/bin/env python3
"""渲染真实历史快照第 7 页，验证表格单元格内的图片叠放关系。"""

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
MODEL_PATH = REPRO_ROOT / 'model.json'
PDF_PATH = Path('/Users/mac/Downloads/从 AI 写代码到 AI 工作流 · 一次需求的两条命，和救回它的六个阶段-translated.pdf')
REPORT_PATH = REPRO_ROOT / 'table-stack-report.json'
SCREENSHOT_PATH = REPRO_ROOT / 'table-stack-page-7.png'
CELL_SCREENSHOT_PATH = REPRO_ROOT / 'table-stack-cell.png'

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
    """为浏览器提供模型图片资源；截图验证不依赖重新读取 44M PDF。"""

    protocol_version = 'HTTP/1.1'

    def do_GET(self) -> None:  # noqa: N802
        """响应图片资源请求。"""
        request_path = urlparse(self.path).path
        if request_path.startswith('/assets/'):
            asset_id = unquote(request_path.removeprefix('/assets/'))
            asset_path = REPRO_ROOT / 'assets' / asset_id
            if asset_path.is_file():
                self.respond(asset_path.read_bytes(), asset_mime_types.get(asset_id, 'application/octet-stream'))
                return
        self.send_error(404)

    def log_message(self, format: str, *args: object) -> None:
        """关闭访问日志。"""
        return

    def respond(self, content: bytes, contentType: str) -> None:
        """返回允许跨域的资源内容。"""
        self.send_response(200)
        self.send_header('Content-Type', contentType)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content)


def start_server() -> tuple[ThreadingHTTPServer, str]:
    """启动本地资源服务。"""
    server = ThreadingHTTPServer(('127.0.0.1', 0), ReproHttpHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def build_init_script(base_url: str) -> str:
    """注入最小 Electron API，用于把完整历史快照送进译文工作台。"""
    return f"""
(() => {{
  const baseUrl = {json.dumps(base_url)};
  const state = window.__repro = {{ generation: 0, callbacks: {{}} }};
  async function readAsset(assetId) {{
    const response = await fetch(baseUrl + '/assets/' + encodeURIComponent(assetId));
    if (!response.ok) return {{ ok: false, code: 'not-found' }};
    return {{ ok: true, mimeType: response.headers.get('content-type'), bytes: new Uint8Array(await response.arrayBuffer()) }};
  }}
  function subscribe(name) {{
    return (callback) => {{
      state.callbacks[name] = callback;
      return () => {{ delete state.callbacks[name]; }};
    }};
  }}
  const api = {{
    getSettings: async () => ({json.dumps(settings, ensure_ascii=False)}),
    windowIsMaximized: async () => false,
    windowMinimize: () => undefined,
    windowToggleMaximize: () => undefined,
    windowClose: () => undefined,
    onWindowMaximizedChanged: subscribe('windowMaximizedChanged'),
    getDocumentPlatformCapability: async () => ({{ supported: true }}),
    selectDocumentFiles: async () => [{json.dumps(selection, ensure_ascii=False)}],
    approveDocumentFile: async () => ({json.dumps(selection, ensure_ascii=False)}),
    approveDocumentFiles: async () => [{json.dumps(selection, ensure_ascii=False)}],
    runDocument: async (request) => {{
      state.generation = request.generation;
      state.runRequest = request;
      return {{ accepted: true, jobId: 'real-gui-job' }};
    }},
    cancelDocument: async () => ({{ accepted: true }}),
    releaseDocumentJob: async () => true,
    getDocumentSource: async () => ({{ ok: false, code: 'not-found' }}),
    getApprovedDocumentSource: async () => ({{ ok: false, code: 'not-found' }}),
    getDocumentAsset: async (_jobId, assetId) => readAsset(assetId),
    getApprovedDocumentAsset: async (request) => readAsset(request.assetId),
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


def task_state(status: str, phase: str, generation: int) -> dict:
    """构造任务状态。"""
    return {
        'jobId': 'real-gui-job',
        'generation': generation,
        'phase': phase,
        'status': status,
        'progress': {'completed': 0, 'total': 0},
        'cancellationRequested': False,
        'failedBlocks': 0,
        'warningCount': 0,
        'phaseCompleted': False,
    }


def snapshot(status: str, phase: str, generation: int, **extra: object) -> dict:
    """构造任务快照。"""
    return {
        'jobId': 'real-gui-job',
        'generation': generation,
        'task': task_state(status, phase, generation),
        'percent': extra.get('percent', 0),
        **extra,
    }


def wait_for(page: Page, expression: str, timeout: int = 30000) -> None:
    """等待页面表达式返回真值。"""
    page.wait_for_function(expression, timeout=timeout)


def table_stack_metrics(page: Page) -> dict:
    """采集目标单元格、叠放成员、文字位置和行高。"""
    return page.evaluate("""
() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7bde9159df0d"]');
  const table = page?.querySelector('.document-table-block[data-block-id="block-81f5aa308908"]');
  const row = table?.querySelector('tr[data-row-id="block-81f5aa308908-row-4"]');
  const cell = row?.children[1];
  if (!page || !table || !row || !cell) return { missing: true, page: Boolean(page), table: Boolean(table), row: Boolean(row), cell: Boolean(cell) };
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const stack = cell.querySelector('.document-table-cell-image-stack');
  const members = Array.from(stack?.querySelectorAll(':scope > .document-image-block[data-image-stack-member="true"]') ?? []);
  const text = cell.querySelector('[data-block-id="cell-71f492efc22e00a6-block-2"]');
  const cellRect = rectOf(cell);
  const stackRect = stack ? rectOf(stack) : null;
  const textRect = text ? rectOf(text) : null;
  return {
    pageRect: rectOf(page),
    tableRect: rectOf(table),
    rowRect: rectOf(row),
    cellRect,
    stackCount: cell.querySelectorAll('.document-table-cell-image-stack').length,
    imageCount: cell.querySelectorAll('.document-image-block[data-table-cell-image="true"]').length,
    stackRect,
    stackAspectRatio: stack ? getComputedStyle(stack).aspectRatio : null,
    stackRatioVar: stack?.style.getPropertyValue('--document-table-cell-image-ratio') || null,
    members: members.map((member) => ({
      blockId: member.dataset.blockId,
      rect: rectOf(member),
      position: getComputedStyle(member).position,
      left: getComputedStyle(member).left,
      top: getComputedStyle(member).top,
      width: getComputedStyle(member).width,
      height: getComputedStyle(member).height,
      leftVar: member.style.getPropertyValue('--document-table-cell-image-member-left'),
      topVar: member.style.getPropertyValue('--document-table-cell-image-member-top'),
      widthVar: member.style.getPropertyValue('--document-table-cell-image-member-width'),
      heightVar: member.style.getPropertyValue('--document-table-cell-image-member-height'),
    })),
    text: text ? {
      rect: textRect,
      topWithinCell: textRect.top - cellRect.top,
      stackBottomWithinCell: stackRect ? stackRect.bottom - cellRect.top : null,
      overlapWithStack: stackRect ? Math.max(0, Math.min(textRect.bottom, stackRect.bottom) - Math.max(textRect.top, stackRect.top)) : null,
      text: text.textContent,
      fontSize: getComputedStyle(text).fontSize,
      lineHeight: getComputedStyle(text).lineHeight,
    } : null,
    cellChildren: Array.from(cell.children).map((child) => ({
      className: child.className,
      blockId: child.dataset.blockId || null,
      rect: rectOf(child),
      marginTop: getComputedStyle(child).marginTop,
    })),
  };
}
""")


def main() -> None:
    """执行真实模型渲染并写出截图与紧凑度量。"""
    server, base_url = start_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                executable_path=os.environ.get('CHROME_EXECUTABLE') or None,
                args=['--allow-file-access-from-files'],
            )
            context = browser.new_context(viewport={'width': 1400, 'height': 900}, device_scale_factor=2)
            page = context.new_page()
            diagnostics: list[dict] = []
            page.on('console', lambda message: diagnostics.append({'type': message.type, 'text': message.text}))
            page.on('pageerror', lambda error: diagnostics.append({'type': 'pageerror', 'text': str(error)}))
            page.add_init_script(build_init_script(base_url))
            page.goto((PROJECT_ROOT / 'out/renderer/document.html').as_uri(), wait_until='load')
            wait_for(page, "document.documentElement.hasAttribute('data-i18n-pending') === false", 10000)
            try:
                wait_for(page, "window.api && document.getElementById('document-drop-zone')?.getAttribute('aria-disabled') === 'false'", 15000)
            except Exception:
                print(json.dumps({
                    'debug': page.evaluate("""() => ({
  api: typeof window.api,
  capability: document.getElementById('document-drop-zone')?.getAttribute('aria-disabled'),
  i18nPending: document.documentElement.getAttribute('data-i18n-pending'),
  readyState: document.readyState,
  bodyText: document.body.innerText.slice(0, 1200),
})"""),
                    'diagnostics': diagnostics,
                }, ensure_ascii=False, indent=2))
                raise
            page.click('#document-drop-zone')
            wait_for(page, "Boolean(window.__repro?.callbacks?.progress)", 30000)

            generation = page.evaluate('window.__repro.generation')
            page.evaluate('(value) => window.__repro.callbacks.completed(value)', snapshot('failed', 'parse', generation, percent=10, errorCode='ocr-failed'))
            page.wait_for_timeout(500)
            if page.is_disabled('#document-rerun-button'):
                raise RuntimeError('重试按钮未启用，无法进入译文快照')
            page.click('#document-rerun-button')
            page.wait_for_timeout(200)
            generation = page.evaluate('window.__repro.generation')
            page.evaluate(
                '(value) => window.__repro.callbacks.progress(value)',
                snapshot('translating', 'translate', generation, percent=70, source=model, translation=model),
            )
            wait_for(page, """() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7bde9159df0d"]');
  const table = page?.querySelector('.document-table-block[data-block-id="block-81f5aa308908"]');
  const row = table?.querySelector('tr[data-row-id="block-81f5aa308908-row-4"]');
  return Boolean(row?.children[1]?.querySelector('.document-table-cell-image-stack'));
}""")
            page.wait_for_timeout(1200)

            page.evaluate("""() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7bde9159df0d"]');
  const table = page.querySelector('.document-table-block[data-block-id="block-81f5aa308908"]');
  table.scrollIntoView({ block: 'center' });
}""")
            page.wait_for_timeout(500)
            metrics = table_stack_metrics(page)
            page.screenshot(path=str(SCREENSHOT_PATH), full_page=False)
            page.evaluate("""() => {
  const page = document.querySelector('#document-translation-content .document-page[data-page-id="page-7bde9159df0d"]');
  const table = page.querySelector('.document-table-block[data-block-id="block-81f5aa308908"]');
  const row = table.querySelector('tr[data-row-id="block-81f5aa308908-row-4"]');
  row.children[1].scrollIntoView({ block: 'center', inline: 'center' });
}""")
            page.wait_for_timeout(300)
            cell_metrics = table_stack_metrics(page)
            cell = page.locator('#document-translation-content .document-page[data-page-id="page-7bde9159df0d"] .document-table-block[data-block-id="block-81f5aa308908"] tr[data-row-id="block-81f5aa308908-row-4"] > :nth-child(2)')
            cell.screenshot(path=str(CELL_SCREENSHOT_PATH))

            report = {
                'engine': 'chromium-playwright',
                'diagnostics': diagnostics,
                'page': metrics,
                'cell': cell_metrics,
                'screenshots': [str(SCREENSHOT_PATH), str(CELL_SCREENSHOT_PATH)],
            }
            REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({
                'report': str(REPORT_PATH),
                'cell': cell_metrics,
                'errors': [item for item in diagnostics if item['type'] in ('error', 'pageerror')],
            }, ensure_ascii=False, indent=2))
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
