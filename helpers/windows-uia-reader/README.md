# Windows UIA Reader Helper

常驻进程，通过 stdin/stdout 行分隔 JSON 与宿主通信，使用 UI Automation 读取选区文本。

## 编译

需要 .NET Framework 4.7.2+（Windows 系统自带 `csc.exe`）。源码保持 C# 5 语法，
以兼容 Windows 7 SP1 上常见的旧版 `csc.exe`。构建机必须为 64 位 Windows。

```cmd
:: 查找 csc.exe（路径随 .NET Framework 版本而异）
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:anycpu /codepage:65001 /out:windows-uia-reader.exe /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:UIAutomationClient.dll /reference:UIAutomationTypes.dll Program.cs
```

构建脚本会依次查找 `Framework64`、`Framework`、`Reference Assemblies`、
`GAC_MSIL`、`GAC_32` 与 `GAC_64` 中的编译器或程序集，兼容 32 位和 64 位
Windows 构建机。

仓库脚本会自动完成查找、编译与 SHA-256 生成：

```cmd
node scripts\build-windows-uia-reader.mjs
```

Windows 安装包构建前必须成功执行该脚本；非 Windows 构建机会明确跳过。

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

构建脚本会在同目录生成 `SHA256.txt`。也可手动复核：

```cmd
certutil -hashfile windows-uia-reader.exe SHA256
```

## 依赖

- .NET Framework 4.7.2+
- UIAutomationClient.dll
- UIAutomationTypes.dll
