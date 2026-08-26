# OCR 三平台打包验证记录

> 创建者：zhenghq  
> 日期：2026-08-22

## 随包资产

当前 PaddleOCR 主链路使用 `@gutenye/ocr-node` 兼容的 PP-OCRv4 ONNX 模型；PP-OCRv6_tiny ONNX 资产保留为留档验证资产，默认不启用。

- 主链路资产目录：`node_modules/@gutenye/ocr-models/assets`
- 检测模型：`ch_PP-OCRv4_det_infer.onnx`，MIT
- 识别模型：`ch_PP-OCRv4_rec_infer.onnx`，MIT
- 字典：`ppocr_keys_v1.txt`
- 留档资产目录：`assets/ocr/ppocrv6_tiny`，记录 PP-OCRv6_tiny 来源、SHA-256 与 Apache-2.0 许可

Electron 打包时，模型目录通过 `build.files` 纳入应用，并通过 `build.asarUnpack` 解包到真实文件路径。运行时会把 `app.asar/node_modules/@gutenye/ocr-models/assets` 映射为 `app.asar.unpacked/node_modules/@gutenye/ocr-models/assets`，供 onnxruntime-node 读取模型文件。

## GitHub Actions macOS 架构约束

PaddleOCR 依赖链中包含 `sharp` 的 native binding。`npm ci` 只会为当前运行器安装对应架构的 `@img/sharp-*` 可选依赖；electron-builder 的 `--x64 --arm64` 交叉打包不会重新安装另一种架构的可选 native binding。因此不能在单个 macOS 运行器上同时构建两个架构，否则其中一个安装包会携带错误架构的 PaddleOCR runtime。

GitHub Actions 现在拆分为两个 macOS 原生任务：

- `macos-15-intel` 只执行 `dist:mac:x64:*`，产出 x64 安装包；
- `macos-14` 只执行 `dist:mac:arm64:*`，产出 arm64 安装包。

两个任务分别上传 `latest-mac-x64.yml` 与 `latest-mac-arm64.yml`，发布前由 `scripts/merge-mac-update-info.mjs` 合并为 electron-updater 使用的 `latest-mac.yml`。这样既保留双架构自动更新清单，也保证每个安装包内的 native binding 与应用架构一致。

## 平台验证清单

| 平台 | 模型路径 | 运行时 | 权限说明 |
|------|----------|--------|----------|
| macOS | `Contents/Resources/app.asar.unpacked/node_modules/@gutenye/ocr-models/assets` | `onnxruntime-node` / `sharp` 同步解包；system OCR 通过 Vision helper 可用性决定 | 截图 OCR 需要 Screen Recording（屏幕录制）权限；划词仍需要 Accessibility（辅助功能）权限 |
| Windows | `resources/app.asar.unpacked/node_modules/@gutenye/ocr-models/assets` | `onnxruntime-node` / `sharp` 同步解包 | Windows.Media.Ocr 需要系统语言包支持；截图采集不需要额外 TCC 权限 |
| Linux | `resources/app.asar.unpacked/node_modules/@gutenye/ocr-models/assets` | `onnxruntime-node` / `sharp` 同步解包 | 无系统 OCR 首层，默认使用 Paddle ONNX；Wayland/X11 截图能力取决于 Electron desktopCapturer 支持 |

## 验证命令

本次变更的本地门禁：

- `npm run typecheck`
- `npm test`
- `npm run build`

发布前仍需在原生 macOS、Windows 与 Linux 构建机执行对应打包脚本：

- `npm run dist:mac`
- `npm run dist:win`
- `npm run dist:linux`

GitHub Actions 已在三平台原生运行器上执行 `npm test`、`npm run typecheck` 和平台打包脚本；本地测试覆盖打包配置、资产路径、解包规则和权限说明。
