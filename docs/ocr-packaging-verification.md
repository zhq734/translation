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
