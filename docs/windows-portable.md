# Windows 便携 ZIP：构建与冒烟验收

适用：Windows 10/11，x64 与 arm64。用户说明见 [中文 README](../README.zh-CN.md) / [English README](../README.md)。本文件是待执行的验收清单，**不是 Windows 实测通过报告**；macOS 上的配置、ZIP 夹具和 checksum 自动化验证不能替代 Windows 实机验证。

## 1. 构建与发布契约

在 Windows 构建机上执行（与现有现代 Windows 构建相同的 Node.js、原生编译工具要求）：

```powershell
npm ci
npm test -- tests/windowsPortablePackaging.test.ts tests/windowsPackaging.test.ts
npm run typecheck
npm run dist:win:portable
npm run release:checksums -- --directory dist-portable
```

默认一次生成两个架构：

```text
dist-portable/
  SelectionTranslator-<version>-Portable-x64.zip
  SelectionTranslator-<version>-Portable-arm64.zip
```

`dist:win:portable` 先运行既有 `npm run build`，再运行 `prepare-windows-ocr-runtime.mjs`（包括 UIA helper、双架构 Sharp/Canvas），最后用独立 `electron-builder-portable.yml` 构建 ZIP 并校验两份归档。配置只复用 package.json 的现代 Windows 运行资源，不修改原配置或 NSIS/Win7 命令；标识源为 `scripts/portable/portable.json`。应用资源仍从 `resources` 读取，不能从 `data` 中寻找模型或原生库。

构建后的验证会读取真实 ZIP 目录索引与标识内容，拒绝缺少 EXE、`app.asar`、图标、build-info、UIA helper、字体、OCR 模型、当前架构 Sharp/Canvas/ONNX/uiohook/Koffi 等必要资源的包。它不加载 Windows DLL，也不能证明原生功能已经运行成功。

便携配置使用 ZIP target、独立 `dist-portable`、`publish: null` 和 `--publish never`，不允许包内出现 `app-update.yml`、`latest*.yml`、`.blockmap` 或预置用户 `data`。默认 NSIS/Win7/macOS/Linux 配置不得出现便携标识。

CI 使用独立 Windows 矩阵项（干净工作区），上传 `packages-windows-portable` 中两个明确架构的 ZIP glob；安装版仍上传自身 EXE 和更新清单。Release 的 `packages-*` 汇总下载包含便携项，现有 `generate-checksums.mjs` 会对 ZIP 生成 SHA-256。便携项不上传 `latest.yml`，不能覆盖安装版更新清单；本地 `dist-portable/SHA256SUMS` 不作为独立清单上传，正式 Release 只使用汇总清单。

## 2. 首次使用与目录检查

从本仓库可信 Release 下载匹配机器架构的 ZIP 和 `SHA256SUMS`。示例（替换版本号与目录）：

```powershell
$zip = '.\SelectionTranslator-0.1.0-Portable-x64.zip'
Get-FileHash $zip -Algorithm SHA256
# 人工与同一 Release 的 SHA256SUMS 中完整同名项比较；不一致时停止。
Expand-Archive -LiteralPath $zip -DestinationPath '.\便携测试 A'
Get-Content -LiteralPath '.\便携测试 A\portable.json'
# 应为 {"version":1}，且与“划词翻译.exe”同级。
Start-Process -FilePath '.\便携测试 A\划词翻译.exe'
```

不要在 ZIP 内运行、只复制 EXE 或移除 portable.json；不要用管理员身份掩盖目录不可写问题。解压目录需要可写，建议普通用户的本地文件夹，而不是 Program Files。未签名包可能被 SmartScreen 提示，先确认来源和摘要，不要全局禁用安全防护。

首次启动后应出现以下结构（缓存或崩溃目录的内容按功能实际使用产生）：

```text
便携测试 A/
  划词翻译.exe
  portable.json
  resources/                  # 随版本发布的资源，不是用户数据
  data/
    user-data/                # 配置、历史、凭证及业务数据
    session/                  # Electron 会话数据
    logs/
    temp/
    crash-dumps/
```

## 3. 搬迁、备份、升级与回退

1. 从托盘退出，确认任务管理器中旧目录的主进程及子进程均已结束。不要热复制数据库、缓存或正在写入的凭证。
2. 搬迁：复制**整个解压目录**到另一可写目录（测试中文、空格路径），从新目录启动；设置和历史应保持。安装版 AppData 不自动迁入，也不能将 NSIS 安装目录通过添加标识“转换”为受支持便携包。
3. 跨机器/跨 Windows 用户：数据可复制，但 `safeStorage` 加密的 API Key/Secret 可能无法解密；应显示重新配置提示，重新填写后才能使用。不得把密钥改成明文，不得因此清空其它设置/历史。
4. 升级：先备份完整旧目录；核对新版 ZIP 的 SHA-256，解压到**全新目录**，首次运行前把旧 `data` 复制到新版。不要将 ZIP 直接覆盖正在运行或仍有旧文件残留的目录。
5. 回退：退出新版，使用旧程序和**升级前的 data 副本**。不要拿新版已经写过的 data 测试旧版兼容性；不要删除唯一备份。
6. 外部原始文档、导出、用户选择的下载目录、外部模型等不自动迁移；旧绝对路径失效时需恢复文件或重新选择。

便携版禁用自启动，不写入或删除安装版登录项；即使复制来的设置含 `autoLaunch: true` 也不例外。设置页只检查更高 SemVer 且当前架构 Portable ZIP 存在的更新，引导到可信发布页；不使用 NSIS 自动安装，不承诺同版本重构检测。

## 4. Windows 实机冒烟矩阵（每个平台分别记录）

| 操作系统与原生架构 | ZIP | 状态 | 执行人/日期/证据 |
| --- | --- | --- | --- |
| Windows 10 x64 | Portable-x64.zip | 未执行 | 待填写 |
| Windows 11 x64 | Portable-x64.zip | 未执行 | 待填写 |
| Windows 10 arm64 | Portable-arm64.zip | 未执行 | 待填写 |
| Windows 11 arm64 | Portable-arm64.zip | 未执行 | 待填写 |

每项应记录 Release 版本、buildId、ZIP SHA-256、OS build、机器架构、实际 EXE 架构、路径、预期/实际结果、脱敏日志和截图位置。无法取得某一环境就标记“未执行/受阻”，不能用 x64 仿真代替 arm64 原生验收或声明整体通过。

- [ ] **包完整性**：验证摘要和同级标识；首次运行前无 `data`；包内 UIA、模型、字体及原生库齐全，无自动更新清单。安装版及 Win7 解包目录不含 portable.json。
- [ ] **启动与隔离**：先为安装版设置独特主题/快捷键，再启动便携版，确认未导入安装版配置；便携版保存设置、历史后重启保留，安装版数据不变。
- [ ] **核心功能**：在记事本/浏览器划词翻译，触发全局快捷键，截图 OCR（含 PaddleOCR 原生链路）、剪贴板图片 OCR，打开并翻译文档、使用内置字体导出；核查当前架构资源加载无 DLL/模块缺失。
- [ ] **数据路径**：检查 user-data/session/logs/temp/crash-dumps 均位于便携 data；用 Process Monitor 按该 EXE 及子进程过滤写入事件，验证应用可控缓存、日志和临时文件没有新写入安装版目录。不能将 Windows 自身的系统事件视为应用数据回退。
- [ ] **同机搬迁**：完全退出，复制至中文/空格新目录，重启确认主题、快捷键、历史、会话状态保持，旧目录不再有应用写入；旧外部文档路径不可用时正常提示。
- [ ] **跨用户/跨机器**：只用可撤销的测试密钥；复制 data 到另一用户或机器，确认解密失败提示重新填写、不出现明文、不清空历史，重填后恢复。
- [ ] **不可写/损坏**：在可丢弃测试副本上用 NTFS 安全权限去掉当前普通用户对目录的写入权限（不要仅设置文件夹“只读”属性），运行应提示并退出且不回退 AppData；随后还原权限。分别将标识改为非法 JSON、`{"version":2}`，应失败退出；恢复原标识后正常运行。
- [ ] **自启动**：先记录安装版的登录项与 Startup/Run 状态，再用含 `autoLaunch: true` 的便携数据运行；设置开关禁用、不会创建便携登录项，也不删除安装版登录项。
- [ ] **共存与快捷键冲突**：安装版与便携版同时运行时数据仍隔离；重复快捷键按现有机制提示冲突，退出一份后可正常使用，不覆盖另一份设置。
- [ ] **更新**：使用可信已发布的更高版本进行检查，只在存在当前架构 Portable ZIP 时提示；打开固定可信发布页，不下载/启动 NSIS、不自动替换。仅有 Setup 或另一架构时不得误报可安装；缺少对应 Release 时记录自动化覆盖、实机该项未执行，不修改生产 Release 来造结果。
- [ ] **升级与回退**：照第 3 节备份、解压、复制 data、启动新版；核验设置/历史；再用旧程序和升级前 data 副本回退，确认原数据可读。
- [ ] **安装版回归**：NSIS 安装/升级/卸载与 Win7 独立安装流程不受影响；现代安装版继续使用自己的 latest.yml，Win7 仍仅手动升级。

## 5. 数据与痕迹边界

便携意味着应用管理的数据相对程序目录存放，不意味着安全沙箱或“绝对无痕”。Windows 最近文件列表、DNS/网络缓存、系统临时机制、Defender/SmartScreen、系统崩溃报告、服务端请求记录等不受应用控制。外部文档、导出和用户选择的路径不能由程序随意移动或删除；验收记录也不得收集真实 API Key、Secret 或未脱敏用户文档。

## 6. 自动化证据说明

`tests/windowsPortablePackaging.test.ts` 覆盖真实 electron-builder 配置加载及 schema 校验、安装版配置不变、构建命令顺序和失败中断、真实 ZIP 夹具正反例、CI 上传 glob 与 Release 汇总契约，并实际运行现有 checksum 脚本对 ZIP 字节重算摘要。测试夹具中原生资源是占位字节，不是运行测试；应把自动化测试结果与上方未执行的实机矩阵分开报告。

### 本轮自动化验收记录（2026-11-16，macOS）

| 检查 | 实际结果 |
| --- | --- |
| `npm test` | 共 4006 项：4001 通过、0 失败、5 跳过（既有 opt-in 浏览器测试） |
| `npm run typecheck` | 通过；另对五个新增便携测试文件执行严格 TypeScript 检查，通过 |
| `npm run build` | 通过；这是本机构建，不是 Windows ZIP 打包 |
| 三个子任务独立 agent 验收 | 全部通过；设置加载竞态经修复后由原验收 agent 再次确认 |
| 构建后启动顺序 | 便携路径初始化先于日志、单实例锁与设置加载；便携更新 chunk 无 `electron-updater` 依赖 |
| `git diff --check` / OpenSpec 严格校验 | 通过 |

新增回归覆盖便携状态未知、IPC 失败、OCR 延迟和设置广播交错：只有明确确认安装模式后才开放自启动开关及保存操作。各实现与该竞态修复均记录了先失败后通过的测试证据。

**仍未执行：** `npm run dist:win:portable` 的 Windows 双架构真实打包，以及第 4 节全部实机冒烟项。本轮未产出可分发的 Windows ZIP，CI 配置通过自动化检查不代表 CI 已实际运行成功。
