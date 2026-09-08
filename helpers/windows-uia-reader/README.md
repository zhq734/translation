# Windows UIA Reader Helper

常驻进程，通过 stdin/stdout 行分隔 JSON 与宿主通信，使用 UI Automation 读取选区文本。

## 编译

需要 .NET Framework 4.7.2+（Windows 系统自带 `csc.exe`）。

```cmd
:: 查找 csc.exe（路径随 .NET Framework 版本而异）
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /out:windows-uia-reader.exe /reference:UIAutomationClient.dll /reference:UIAutomationTypes.dll Program.cs
```

如果 `csc.exe` 不在 PATH 中，可从以下目录查找：
- `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（64 位）
- `C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe`（32 位）

## 通信协议

```
请求: {"id":1,"method":"readSelection"}
响应: {"id":1,"status":"present","text":"选中的文本"}
```

状态值：
- `present` — 读到选区文本
- `empty` — 确认无选区
- `unknown` — 无法确认，宿主应降级到全局 Ctrl+C

## 读取链

1. 焦点控件的 TextPattern.GetSelection
2. WM_COPY 向焦点控件发送复制消息

第三级（全局 Ctrl+C）由宿主层负责，本 helper 不处理。

## SHA-256 校验

提交预编译 `windows-uia-reader.exe` 后，在同目录运行：

```cmd
certutil -hashfile windows-uia-reader.exe SHA256
```

将输出的哈希值记录在 `SHA256.txt` 中。

## 依赖

- .NET Framework 4.7.2+
- UIAutomationClient.dll
- UIAutomationTypes.dll
