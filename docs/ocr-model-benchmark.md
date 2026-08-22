# PaddleOCR ONNX 模型验证记录

> 创建者：zhenghq  
> 日期：2026-08-22

## 模型来源与格式

| 项目 | 内容 |
|------|------|
| 模型名称 | PP-OCRv6_tiny（det + rec，留档资产，默认不启用） |
| 官方来源 | PaddlePaddle HuggingFace：`PP-OCRv6_tiny_det_onnx` / `PP-OCRv6_tiny_rec_onnx` |
| 本地缓存路径 | `~/.paddlex/official_models/PP-OCRv6_tiny_det` / `PP-OCRv6_tiny_rec` |
| 本地格式 | Paddle 3.x PIR（`inference.json` program + `inference.pdiparams` 权重，**无** `inference.pdmodel`） |
| 当前状态 | 官方预转 ONNX 已留档验证；因与当前 `@gutenye/ocr-node` 前后处理/解码链路不兼容，默认不作为主链路 |
| 许可 | Apache-2.0 |

官方 ONNX 资产入口：

- det：<https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx>
- rec：<https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx>

## 格式兼容性结论

已实测确认：

- 本地 `~/.paddlex/official_models/PP-OCRv6_tiny_det/inference.json` 的顶层结构包含 `program`（非旧版 `pdmodel` 文件），为 Paddle 3.x PIR 新格式。
- **PaddleOCR-json v1.4.1**（Paddle 2.x 推理内核）调用 `AnalysisConfig`，仅支持 `pdmodel + pdiparams` 传统格式，**无法加载** PIR 格式。
- PP-OCRv6_tiny 官方 ONNX 转换版可被 onnxruntime 加载，但在当前 `@gutenye/ocr-node@1.4.8` 链路中对正常网页截图会输出高置信度乱码，因此不作为默认主链路。
- 当前默认主链路采用 `@gutenye/ocr-models@1.4.2` 随包的 PP-OCRv4 ONNX det/rec 与 `ppocr_keys_v1.txt`，该组合与 `@gutenye/ocr-node` 的预处理和 CTC 解码行为匹配。

## 模型参数摘要

### det（文字检测）

| 项目 | 值 |
|------|----|
| 文件大小 | 1,780,590 bytes（随包 `assets/ocr/ppocrv6_tiny/det.onnx`） |
| 预处理 | `DetResizeForTest` → `NormalizeImage`（mean 0.485/0.456/0.406, std 0.229/0.224/0.225）|
| 后处理 | `DBPostProcess`：thresh=0.2, box_thresh=0.4, unclip_ratio=1.4 |
| 输入动态尺寸 | 最小 1×3×32×32，最大 1×3×4000×4000 |

### rec（文字识别）

| 项目 | 值 |
|------|----|
| 文件大小 | 4,462,639 bytes（随包 `assets/ocr/ppocrv6_tiny/rec.onnx`） |
| 预处理 | `RecResizeImg`（image_shape: 3×48×320） |
| 后处理 | CTC 解码（`CTCLabelDecode`），需配套字典 `dict_chinese.txt` |
| 输入动态尺寸 | 1×3×48×160 ~ 8×3×48×3200 |

## 字典配套

rec 识别需要应用层提供字符字典文件。本项目随包分发 `assets/ocr/ppocrv6_tiny/dict.txt`，内容采用 PP-OCR 系列通用中文字典（`ppocr_keys_v1.txt`），运行时通过 `@gutenye/ocr-node` 的 `models.dictionaryPath` 显式传入。

## CPU 推理性能 benchmark（参考）

> 以下数据来自 Lumi-translate 项目的 CPU 实测参考值，尚未在本项目三平台独立 benchmark。

| 平台 | 芯片 | 单次识别耗时（典型截图 ~400×200）|
|------|------|----------------------------------|
| macOS (Apple M2) | ARM64 CPU | ~200–400ms（onnxruntime CPU） |
| Windows 11 (x64) | Intel i7 | ~300–600ms（onnxruntime CPU） |
| Linux (x64) | Intel i7 | ~300–600ms（onnxruntime CPU） |

实际性能受截图尺寸、文字密度和系统负载影响。PP-OCRv6_tiny 留档资产不参与默认运行；如后续实现 v6 专用前后处理，再重新补充三平台 benchmark。

## 分发策略

- **随构建分发**：当前默认使用 `@gutenye/ocr-models` 中的 PP-OCRv4 det + rec ONNX 文件；PP-OCRv6_tiny det + rec ONNX 文件总计约 5.8 MB，仅作为留档资产保留。
- **按需下载**（备选）：首次使用时走现有网络/代理配置下载，下载完成前仅系统 OCR + Tesseract 可用。
- 版本号与许可信息在设置页 OCR 分组中展示（见任务 5.2）。

### 随包资产校验（任务 5.2）

> 创建者：zhenghq  
> 日期：2026-08-22

PP-OCRv6_tiny 留档资产目录为 `assets/ocr/ppocrv6_tiny`：

| 文件 | 大小 | SHA-256 | 来源 |
|------|------|---------|------|
| `det.onnx` | 1,780,590 bytes | `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8` | `PP-OCRv6_tiny_det_onnx/inference.onnx` |
| `rec.onnx` | 4,462,639 bytes | `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6` | `PP-OCRv6_tiny_rec_onnx/inference.onnx` |
| `dict.txt` | 26,249 bytes | `28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7` | PP-OCR 通用中文字典 |

`metadata.json` 记录 PaddlePaddle 上游仓库、det/rec 提交版本、Apache-2.0 许可、文件大小与 SHA-256。`src/main/ocrModelAssets.ts` 单独提供留档资产解析函数，默认 PaddleOCR runtime 不使用该 v6_tiny 路径。

## 结论

- ✅ 模型档位（tiny）确认与本地 PIR 版一致。
- ✅ 格式不兼容问题（PIR vs ONNX）已在 design.md 中记录，v6_tiny 留档采用官方 ONNX 版规避 PIR 加载问题。
- ✅ 模型体积满足目标（< 6 MB）。
- ✅ PP-OCRv6_tiny ONNX det/rec 与字典已随构建分发为留档资产。
- ✅ 当前主链路回退到 `@gutenye/ocr-node` 已验证兼容的 PP-OCRv4 ONNX 模型，设置页展示 PP-OCRv4/MIT runtime 状态。
- ⏳ 三平台独立 CPU benchmark 留待集成测试阶段实测补充。

## 依赖锁定与许可记录（任务 5.3）

> 创建者：zhenghq  
> 日期：2026-08-22

当前 `package.json` / `package-lock.json` 已锁定 OCR 主链路与兜底链路依赖：

| 依赖 | 锁定版本 | 许可 | 本机安装体积 | 用途 |
|------|----------|------|--------------|------|
| `@gutenye/ocr-node` | 1.4.8 | MIT | ~60 KB | PaddleOCR/ONNX 主链路封装 |
| `@gutenye/ocr-models` | 1.4.2 | MIT | ~15 MB | `@gutenye/ocr-node` 默认随包模型资产 |
| `onnxruntime-node` | 1.27.0 | MIT | ~259 MB | ONNX Runtime CPU 推理运行时 |
| `sharp` | 0.33.5 | Apache-2.0 | ~828 KB（不含平台 libvips） | `@gutenye/ocr-node` 图像处理依赖 |
| `@techstark/opencv-js` | 4.9.0-release.3 | Apache-2.0 | ~12 MB | OCR 前后处理依赖 |
| `tesseract.js` | 7.0.0 | Apache-2.0 | ~1.6 MB | 本地兜底 OCR |
| `tesseract.js-core` | 7.0.0 | Apache-2.0 | 由依赖树锁定 | Tesseract WASM 核心 |

打包配置已将 `@gutenye/*`、`@techstark/*`、`@img/*`、`onnxruntime-*`、`sharp`、`tesseract.js*` 纳入 `build.files`，并将 `onnxruntime-node`、`sharp`、`@img/*` 放入 `asarUnpack`，避免 native 二进制被压入 asar 后无法加载。

### 依赖差异说明

`@gutenye/ocr-node@1.4.8` 当前随包的 `@gutenye/ocr-models@1.4.2` 包含：

- `ch_PP-OCRv4_det_infer.onnx`
- `ch_PP-OCRv4_rec_infer.onnx`
- `ch_ppocr_mobile_v2.0_cls_infer.onnx`
- `ppocr_keys_v1.txt`

探索阶段曾尝试将 **PP-OCRv6_tiny ONNX** 作为目标资产显式传入 `PaddleOcrEngine`，但对正常网页截图复现高置信度乱码。当前应用运行时恢复使用该默认 v4 模型作为兼容主链路，并将 v6_tiny 资产保留为后续专用适配的留档资产。

官方 v6_tiny ONNX 模型页显示 det `inference.onnx` 约 1.78 MB、rec `inference.onnx` 约 4.46 MB，许可为 Apache-2.0；本仓库已按该资产完成留档分发与校验记录，但默认不启用。

---

## PaddleOCR-json 备选适配结论（任务 3.6）

> 创建者：zhenghq  
> 日期：2026-08-22

### 结论：备选方案已评估，当前不启用

PaddleOCR-json 作为备选独立部署方案，仅在 onnxruntime 链路在目标平台不可用时考虑。

### 适配实现

`src/main/paddleOcrFallback.ts` 实现了完整的 PaddleOCR-json 进程适配：

- **进程启动**：通过 `child_process.spawn` 启动 PaddleOCR-json 进程，按 JSON 行协议喂图并取文本。
- **喂图方式**：将图片路径写入 stdin，读取 stdout JSON 行解析结果。
- **超时退出**：请求超时时发送 SIGTERM，强制退出时回退 SIGKILL。
- **可用性判断**：`isAvailable()` 检查 `paddleocr-json` 可执行文件是否在 PATH 或指定路径中。

### 不兼容性说明

| 问题 | 详情 |
|------|------|
| PIR 格式不兼容 | PaddleOCR-json v1.4.1 使用 Paddle 2.x 推理内核，仅支持 `pdmodel + pdiparams` 格式，无法加载 PP-OCRv6_tiny 的 PIR 新格式 |
| 独立安装依赖 | 用户需单独安装 PaddleOCR-json 可执行文件，零体积优势不存在 |
| 跨平台一致性 | Windows/Linux 二进制不同，分发与维护成本高于 onnxruntime-node |

### 启用条件

仅在以下情况考虑启用 PaddleOCR-json 备选：

1. onnxruntime-node 在某平台无法加载（算子不覆盖 v6 MetaFormer/RepLKFPN 结构）。
2. 用户已自行安装兼容版本的 PaddleOCR-json（支持 v6 ONNX 或传统格式）。
3. `createSystemOcrEngine()` 与 `PaddleOcrEngine` 均不可用时，调度层检测到 `paddleocr-json` 可执行文件存在。

### 当前状态

- ✅ 备选适配代码已实现（`src/main/paddleOcrFallback.ts`）
- ✅ 不兼容原因已记录（PIR 格式问题）
- ⏳ 默认**不启用**，引擎调度器（任务 3.8）中将其排在 onnxruntime 链路之后
