# Windows 10 LTSC 取词超时排查记录

## 现象与证据边界

用户反馈：最新版在 Windows 10 LTSC 上连续使用后仍出现“取词超时”。本轮在 macOS 开发环境追踪了实际源码，并用真实 TypeScript 宿主、协调器和取词函数配合系统 API 桩复现时序缺陷。**没有取得用户机器日志，也没有执行 LTSC 真机验证，不能将下述代码缺陷等同于用户现场唯一根因。**

本项目是 Electron/TypeScript 应用，不包含 Maven 工程；验证使用 `npm test`、`npm run typecheck` 和构建检查。

## 已确认的代码缺陷

### 1. “只读预取”实际修改剪贴板

`captureSelectionByNativeOnly()` 在按钮出现时调用常驻 UIA helper。旧 helper 在目标控件无 `TextPattern` 时进入 `TryWmCopy()`，保存旧文本、清空剪贴板、发送复制消息，随后再次清空并恢复旧文本。

这违反了后台预取的只读约束：预取失效后仍可能复制或恢复旧内容，影响用户主动复制或宿主复制事务；旧实现只保存文本，图片与其它剪贴板格式也不受保护。helper 为单线程循环，某次 UIA 调用卡住后后续请求会继续排队。

修复：helper 仅执行 UIA 直读；不能读取时返回 `unknown`。所有 WM_COPY、剪贴板哨兵与恢复操作只由宿主串行复制事务负责。

### 2. 取消信号未接入，点击按钮仍等待阻塞预取

旧 `readSelectionViaWindowsHelper()` 对取消信号执行 `void signal`。协调器虽已取消后台预取，真实系统调用却继续等到请求超时，按钮任务还要等待串行队列中的旧任务结束。

修复：宿主接收取消信号；取消时立即拒绝本代请求、回收阻塞进程。不使用只结束 Promise、保留过期 UIA 在后台继续执行的方案。复制兜底也检查取消状态，不能在取消后继续注入 Ctrl+C。

### 3. 进程换代没有隔离迟到事件

真实 `kill()` 的 `exit` 异步到达。旧宿主在 `exit` 回调中无条件 `rejectAll()`，因此空闲回收或超时重启后，旧进程退出可能拒绝新进程的请求；旧 stdout 也会继续进入新请求匹配器。共享的退出抑制标记还可能残留至新进程。

旧 `stdoutBuffer` 未在换代时清空，旧进程残留半行可以把新 JSON 响应拼坏；每个数据块直接 `toString('utf8')` 会损坏跨数据块的中文字符。

修复：按当前子进程身份隔离 stdout、exit、error；回收时结束本代待定请求并清空缓冲；采用 `StringDecoder` 正确处理跨数据块 UTF-8。异步启动错误立即结束等待。

### 4. 300ms 直读预算形同虚设，超时后重复查询 UIA

旧代码声明 `NATIVE_DIRECT_READ_TIMEOUT_MS = 300`，但并未使用；宿主实际按 1500ms 等待。helper 超时被吞掉后返回 `null`，紧接着冷启动 PowerShell 查询同一 UIA API（最长再等 1500ms）。后台预取还可能执行第二轮读取。

修复：实际向宿主传递 300ms 预算；默认首次超时即回收阻塞 helper。已尝试 UIA 的超时/错误返回 `unknown`，不再立即启动同类 PowerShell 查询；预取也不对这类失败立即重试。helper 未安装或会话禁用时仍保留原有 PowerShell 兼容路径。

### 5. WM_COPY 中间层存在脚本错误及重复 UIA 依赖

旧脚本用 `Add-Type -Namespace User32 -Name User32` 定义类型，实际类型为 `[User32.User32]`，却用 `[User32]` 调用。C# 定义又嵌入 PowerShell 双引号字符串，反斜杠不能在 PowerShell 中转义双引号。非终止错误还可能被忽略，导致消息未发送却继续轮询。

旧脚本还查询 `AutomationElement.FocusedElement`；UIA 已经阻塞时，这个中间层重复依赖同一接口，进一步推迟 Ctrl+C。此前消息超时 500ms 并不限制 PowerShell 的冷启动、动态编译和 UIA 查询。

修复：用 PowerShell 单引号包裹 C# 定义，调用完整限定类型，设置 `ErrorActionPreference = 'Stop'`。通过 `GetForegroundWindow`、`GetWindowThreadProcessId`、`GetGUIThreadInfo` 获取真实焦点 HWND，不再依赖 UIA；检查消息发送结果，失败后立即回退。保留 `SMTO_ABORTIFHUNG` 和独立的 2000ms 脚本上限。

## 回归验证

- `tests/nativeReaderHost.test.ts`：新增 9 个测试均经过红绿验证。覆盖旧 exit/error/stdout、新旧半行隔离、UTF-8 分片、取消、短预算、异步启动错误，以及惰性启动 await 空窗内的崩溃/释放。
- `tests/windowsSelectionLifetime.test.ts`：执行实际取词函数，验证信号/预算透传、UIA 超时不重复降级、缺失 helper 的兼容路径、纯只读 helper、WM_COPY 脚本与取消。额外使用真实协调器和宿主重复 30 轮阻塞预取与点击取词，验证过期结果丢弃和迟到退出隔离。
- `tests/windowsWmCopyScript.test.ts`、`tests/windows7Compatibility.test.ts`：更新脚本限定类型及纯只读 helper 契约，保留 C# 5 兼容约束。
- LTSC 的真实 PowerShell/C# 编译、UIA 提供程序、跨进程窗口焦点和键盘注入仍需下列真机验收；桩测试不能替代它们。

## LTSC 真机验收与现场采集

1. 记录应用 Release/buildId，以及 `winver` 中的 LTSC 年份、OS build；应用“最新版”不意味着系统 UIA、.NET 或目标应用版本相同。
2. 分别在记事本、浏览器普通网页、实际出现问题的应用验证划词按钮与快捷键。每个入口至少连续取词 50 次，再空闲超过 5 分钟重试；补充快速重新划词、预取中点击、取消/切换应用、睡眠唤醒和远程桌面重连。
3. 在出现超时的同一选区直接手动按 Ctrl+C：
   - 手动也失败：检查目标应用是否允许复制、选区是否还有效、剪贴板是否被其它进程占用。
   - 手动成功但本应用失败：优先检查前台交还、键盘注入、权限级别及 UIA 提供程序，而不是翻译接口。
4. 检查目标应用是否“以管理员身份运行”。Windows UIPI 可阻止普通权限进程注入高权限窗口。当前 uiohook 的 `keyTap()` 不把底层 `SendInput()` 失败返回给 JavaScript，`copy-shortcut-sent` **只能证明注入函数返回，不能证明目标窗口收到复制**。不要因此断言复制已成功，也不要默认要求应用永久以管理员身份运行。
5. 从设置页“日志”区域导出取词诊断 JSON，同时保留问题发生前后约 1 分钟运行日志。本轮新增的固定分类日志：
   - `windows-uia`：status、reason（helper-timeout/helper-error/helper-aborted）、耗时和降级标记。
   - `windows-wm-copy`：no-text/unavailable/aborted、耗时和降级标记。
   - 配合 `copy-start`、`copy-shortcut-sent`、`copy-event`、`copy-finish` 判断失败阶段。
6. 诊断文件位于 `userData/capture-diagnostics.json`；运行日志为应用日志目录中的 `main-YYYY-MM-DD.log`。便携版分别在 EXE 同级 `data/user-data` 和 `data/logs`。诊断 JSON 按两天滚动，运行日志保留周期较短，应在失败后及时导出。

新增阶段日志不写选中文字或剪贴板内容。**运行日志包含其它模块输出，不等同于脱敏诊断 JSON**；分享前应检查并移除个人文本、文件路径和其它敏感信息。

## 仍待现场证据确认的风险

- 前台窗口交还被 Windows 策略拒绝，或弹窗/目标应用切换导致复制键落到错误窗口。
- UIPI、桌面会话切换、目标应用吞键或真实修饰键状态导致 `SendInput` 未被目标消费。
- 目标 UIA 提供程序间歇阻塞、目标应用复制写入特别迟，以及第三方剪贴板管理器干扰。
- PowerShell 首次启动/动态编译慢；已提供进程超时和失败降级，但没有将此路径更换为新的 FFI 子系统。

本轮只修复有源码与回归证据的链路缺陷，不通过无限增大超时、杀系统服务或自动提权掩盖原因。修改需经 Windows 重新编译 helper、打包并发布后才能进入用户当前安装版本。
