# 文档翻译依赖与能力验证

> 创建者：zhenghq  
> 验证日期：2026-10-31
> 验证环境：macOS / Electron 33.4.11 / Node 20.18.3 / ABI 130

本文记录文档翻译工作台的实际依赖、原生模块 ABI、资源打包与 PDF 能力边界。依赖已安装并写入 `package-lock.json`，不再处于候选选型阶段。

## 1. 实际依赖

| 用途 | 依赖 | 锁定版本 | 许可证 | 运行时说明 |
| --- | --- | ---: | --- | --- |
| PDF 解析 | `pdfjs-dist` | 3.11.174 | Apache-2.0 | 读取文本层、页面尺寸、字体样式与图片绘制区域 |
| PDF 页面栅格化 | `@napi-rs/canvas` | 1.1.0 | MIT | 预编译 N-API 模块；扫描页与页内图片裁切依赖它 |
| PDF 导出 | `pdf-lib` | 1.17.1 | MIT | 创建页面、嵌入字体与图片、绘制文本和基础矢量元素 |
| PDF 字体嵌入 | `@pdf-lib/fontkit` | 1.1.1 | MIT | 支持 OTF/CJK 字体子集嵌入 |
| DOCX/EPUB 解包 | `jszip` | 3.10.2 | MIT 或 GPL-3.0 | 本项目按 MIT 方式使用；解析入口带解包大小与压缩比限制 |
| DOCX 语义转换 | `mammoth` | 1.13.0 | BSD-2-Clause | 提取段落、标题、列表、表格与图片关系 |
| OOXML/EPUB XML | `fast-xml-parser` | 5.11.2 | MIT | 读取关系、样式与 OPF 等 XML |
| PDF.js Path2D 兼容 | `path2d-polyfill` | 2.0.1 | MIT | 为 Node 环境补充 PDF.js 页面渲染所需的 `Path2D` |

`package.json` 通过 `build.files` 纳入上述依赖，并把 `@napi-rs/**` 与 `canvas` alias 解包到真实文件路径。`pdfjs-dist` 的可选依赖仍声明 `canvas`，因此项目保留同名 npm alias：

```json
{
  "dependencies": {
    "@napi-rs/canvas": "1.1.0",
    "canvas": "npm:@napi-rs/canvas@1.1.0"
  },
  "overrides": {
    "canvas": "npm:@napi-rs/canvas@1.1.0"
  }
}
```

生产代码直接引用 `@napi-rs/canvas`，不要引用 alias `canvas`。否则 esbuild 会进入 alias 包的平台选择逻辑，并尝试把 `.node` 原生文件打进 bundle。

## 2. 原生模块与 ABI

`@napi-rs/canvas` 使用 N-API，不再依赖 node-canvas 的 `NODE_MODULE_VERSION` 重建流程。以下 ABI 仅用于核对其它传统原生模块，不要求 Canvas binding 与 Electron ABI 数值一致：

| 运行时 | Node | ABI |
| --- | ---: | ---: |
| 系统 Node | 22.22.3 | 127 |
| Electron 33.4.11 | 20.18.3 | 130 |

`npm run document:smoke` 已在 Electron 33.4.11 中加载 Canvas 1.1.0 并完成实际绘制，不要求 `electron-rebuild -f -w canvas`，也不依赖 GTK/Cairo 头文件。

项目仍保留 `build.npmRebuild: true`，用于处理 `uiohook-napi`、`koffi`、`sharp` 等原生依赖。开发前可用以下命令核对 Electron 运行时：

```bash
node -p "process.versions.modules"
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p "process.versions.modules"
```

Windows 与 Linux 交叉打包前分别执行 `scripts/prepare-windows-ocr-runtime.mjs`、`scripts/prepare-linux-ocr-runtime.mjs`，通过 `npm pack` 预取目标架构平台包：

- Windows：`@napi-rs/canvas-win32-{x64,arm64}-msvc`
- Linux：`@napi-rs/canvas-linux-{x64,arm64}-gnu`

脚本会校验版本以及 `skia.*.node`（Windows 还要求 `icudtl.dat`）存在。三平台安装包仍应分别在对应架构的原生运行器验证 Canvas 加载和最小页面渲染，交叉打包不能证明目标架构原生模块可加载。

Windows 打包任务一次产出 x64 与 arm64 安装包，因此 Windows 产物会同时携带两套 Canvas 平台包（当前约 69 MB，含两个 Skia binding 与两份 ICU 数据）。打包配置只排除 Linux、macOS、Android、FreeBSD 包；不要排除任一 Windows 架构包，否则交叉打包阶段会再次缺失目标架构运行时。

## 3. 内置 CJK 字体

导出含中文的 PDF 时使用：

- 路径：`assets/fonts/NotoSansSC-Regular.ttf`
- 来源：Google Noto Sans SC（SIL Open Font License 1.1）
- 许可文本：`assets/fonts/OFL.txt`
- 体积：10,540,644 字节（约 10.1 MiB）
- SHA-256：`450625c8d46ab3df97b7904ded955ec2746d17ec76740cb1e91d1ba63a0f89af`

导出时完整嵌入静态 TrueType 字体，并关闭 `locl` 字体特性。前者避免 CFF/OTF 子集在部分 PDF 查看器中丢失中英文字形；后者避免 ASCII 字符被替换为其他字形后，ToUnicode 映射错位，导致复制、搜索得到乱码。

macOS、Windows 与 Linux 的 `extraResources` 均把 `assets/fonts` 复制到 Resources 根目录；开发环境从项目根目录读取，打包后从 `process.resourcesPath` 读取。字体读取成功后会缓存，避免每次导出重复 IO。

## 4. PDF 能力与保真边界

当前 PDF 链路支持：

- 保留页面尺寸与区块绝对坐标；
- 提取原生文本层、文本方向、字号、字体族、字重、颜色等基础样式；
- 保留页面中的图片区域，并对扫描页整页栅格化；
- 扫描页和 PDF 内嵌图片在 OCR 后，把译文覆盖回对应图片区域；
- 表格单元格、公式原文与基础矢量装饰的 PDF 导出；
- 导出后的中文正文和 OCR 译文仍可作为文本检索。

当前限制：

- 复杂公式默认保留原文或 LaTeX/MathML 表达，不承诺重建为可编辑公式；
- 复杂合并表格、多栏阅读顺序、精确字距、行距和换行位置只能近似还原；
- PDF 不直接携带可编辑的 DOCX 段落语义，流式文档导出为分页 PDF 时按统一模型重排；
- OCR 区域译文超出原区域时会裁剪可见内容，但完整文本仍写入 PDF 可检索层；
- 图片资源缺失时导出会绘制占位框并返回 `image-asset-unavailable`，不会让整个导出失败。

真实冒烟样本 `tests/fixtures/document/sample.pdf` 共 2 页：第 1 页含原生文本层，第 2 页为无文本层扫描页。`npm run document:smoke` 会验证解析、扫描页 PNG、OCR 译文覆盖、CJK 字体嵌入与导出 PDF 回读。

## 5. Windows 7 兼容构建

Win7 专用配置 `electron-builder-win7.yml` 使用 Electron 22.3.27，并明确排除以下文档依赖与字体：

- `pdfjs-dist`
- `@napi-rs/canvas`
- `pdf-lib`
- `@pdf-lib/fontkit`
- `jszip`
- `mammoth`
- `fast-xml-parser`
- `path2d-polyfill`
- `assets/fonts`

Win7 运行时通过平台能力探测禁用文档翻译入口，并提示当前系统不支持；既有划词翻译与 Tesseract OCR 不受影响。

## 6. 打包与验证状态

已通过本地验证：

- `npm run document:smoke`：Electron 33 + ABI 130 下完成真实 PDF 解析、扫描页 PNG、OCR 译文导出与 PDF 回读；
- 字体文件存在、许可文本存在且 SHA-256 与本文一致；
- 三平台 `extraResources` 包含字体，现代平台 `build.files` 包含文档依赖，`@napi-rs/canvas` 进入 `asarUnpack`；
- Win7 配置排除文档依赖与字体。

仍需在真实安装包环境验证：

- macOS、Windows 10/11 与 Linux x64/arm64 的安装包启动、文档窗口和 PDF 导出；
- 各目标架构下 `@napi-rs/canvas` 原生模块实际加载；
- 含复杂公式、多栏、合并表格和大量图片的真实业务文档；
- 代码签名、安装包体积增量与第三方许可证清单。

当前本机 Electron GUI 启动受 macOS LaunchServices 环境限制，尚未完成文档窗口的可视化实机验收；上述待验证项不得视为已通过。

## 7. 常用命令

```bash
npm run document:smoke
npm run typecheck
npm test
npm run build
```
