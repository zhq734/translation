$ErrorActionPreference = 'Stop'
$Repository = if ($env:SELECTION_TRANSLATOR_REPOSITORY) { $env:SELECTION_TRANSLATOR_REPOSITORY } else { 'zhq734/translation' }
$RequestedVersion = if ($env:SELECTION_TRANSLATOR_VERSION) { $env:SELECTION_TRANSLATOR_VERSION } elseif ($env:GROKBUILD_VERSION) { $env:GROKBUILD_VERSION } else { 'latest' }
$ProductName = '划词翻译'
$TemporaryDirectory = $null

# Windows PowerShell 5.1 在部分旧系统上仍默认使用 TLS 1.0，GitHub 下载需要显式启用 TLS 1.2。
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor `
    [Net.SecurityProtocolType]::Tls12

<#
.SYNOPSIS
输出安装进度。
.PARAMETER Message
需要显示的消息。
.OUTPUTS
无返回值。
.NOTES
@author zhenghq
#>
function Write-InstallLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[划词翻译] $Message"
}

<#
.SYNOPSIS
识别当前 Windows 处理器架构。
.OUTPUTS
返回 x64 或 arm64。
.NOTES
@author zhenghq
#>
function Resolve-Architecture {
    $Architecture = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }
    switch ($Architecture.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'X86_64' { return 'x64' }
        'ARM64' { return 'arm64' }
        'AARCH64' { return 'arm64' }
        default { throw "暂不支持当前处理器架构：$Architecture" }
    }
}

<#
.SYNOPSIS
解析要安装的 Release 标签，未指定时跟随 GitHub 最新正式版本。
.OUTPUTS
返回以 v 开头的 Release 标签。
.NOTES
@author zhenghq
#>
function Resolve-Version {
    $Version = $RequestedVersion
    if ($Version -eq 'latest') {
        $Headers = @{
            Accept = 'application/vnd.github+json'
            'User-Agent' = 'selection-translator-installer'
        }
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $Headers
        $Version = [string]$Release.tag_name
    }
    if ($Version -notmatch '^[vV]') {
        $Version = "V$Version"
    }
    if ($Version -notmatch '^[vV][0-9A-Za-z][0-9A-Za-z._-]*$') {
        throw "版本格式不合法：$Version"
    }
    return $Version
}

<#
.SYNOPSIS
从 SHA256SUMS 中读取指定安装包的期望校验和。
.PARAMETER ChecksumPath
SHA256SUMS 文件路径。
.PARAMETER AssetName
需要查找的安装包文件名。
.OUTPUTS
返回小写 SHA-256 字符串。
.NOTES
@author zhenghq
#>
function Get-ExpectedChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$ChecksumPath,
        [Parameter(Mandatory = $true)][string]$AssetName
    )

    foreach ($Line in Get-Content -LiteralPath $ChecksumPath) {
        if ($Line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $AssetName) {
            return $Matches[1].ToLowerInvariant()
        }
    }
    throw "SHA256SUMS 中找不到 $AssetName。"
}

<#
.SYNOPSIS
在配置不存在时写入应用默认配置，升级安装不会覆盖用户设置。
.PARAMETER ConfigPath
默认配置文件路径。
.OUTPUTS
无返回值。
.NOTES
@author zhenghq
#>
function Write-DefaultConfig {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    if (Test-Path -LiteralPath $ConfigPath) {
        return
    }
    $ConfigDirectory = Split-Path -Parent $ConfigPath
    New-Item -ItemType Directory -Path $ConfigDirectory -Force | Out-Null
    $Json = @'
{
  "schemaVersion": 5,
  "targetLang": "auto",
  "sourceLang": "auto",
  "hotkey": "Alt+T",
  "autoHideMs": 0,
  "deepLxUrl": "",
  "triggerMode": "button",
  "proxyMode": "system",
  "proxyRules": "",
  "proxyBypassRules": "<local>;localhost;127.0.0.1",
  "dingTalkEnabled": false,
  "dingTalkCorpId": "",
  "dingTalkClientId": "",
  "dingTalkSecretConfigured": false
}
'@
    $Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigPath, $Json, $Utf8WithoutBom)
    Write-InstallLog "已生成默认配置：$ConfigPath"
}

<#
.SYNOPSIS
执行 Windows Release 下载、SHA-256 校验和静默安装流程。
.OUTPUTS
无返回值。
.NOTES
@author zhenghq
#>
function Install-SelectionTranslator {
    if ($env:OS -ne 'Windows_NT') {
        throw 'install.ps1 仅支持 Windows，请在 Linux 或 macOS 上使用 install.sh。'
    }

    $Architecture = Resolve-Architecture
    $Version = Resolve-Version
    $AssetVersion = $Version.Substring(1)
    $AssetName = "SelectionTranslator-$AssetVersion-Setup-$Architecture.exe"
    $ReleaseBaseUrl = "https://github.com/$Repository/releases/download/$Version"

    $script:TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "selection-translator-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $script:TemporaryDirectory -Force | Out-Null
    $AssetPath = Join-Path $script:TemporaryDirectory $AssetName
    $ChecksumPath = Join-Path $script:TemporaryDirectory 'SHA256SUMS'

    Write-InstallLog "正在下载 ${AssetName}（${Version}）..."
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBaseUrl/$AssetName" -OutFile $AssetPath
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBaseUrl/SHA256SUMS" -OutFile $ChecksumPath

    $ExpectedChecksum = Get-ExpectedChecksum -ChecksumPath $ChecksumPath -AssetName $AssetName
    $ActualChecksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $AssetPath).Hash.ToLowerInvariant()
    if ($ActualChecksum -ne $ExpectedChecksum) {
        throw "SHA-256 校验失败，期望 ${ExpectedChecksum}，实际 ${ActualChecksum}。"
    }
    Write-InstallLog 'SHA-256 校验通过。'

    $ApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    Write-DefaultConfig (Join-Path $ApplicationData "$ProductName\settings.json")

    $Installer = Start-Process -FilePath $AssetPath -ArgumentList '/S' -Wait -PassThru
    if ($Installer.ExitCode -ne 0) {
        throw "安装程序执行失败，退出码：$($Installer.ExitCode)"
    }
    Write-InstallLog '安装完成，可从开始菜单或桌面快捷方式启动“划词翻译”。'
}

try {
    Install-SelectionTranslator
}
finally {
    if ($TemporaryDirectory -and (Test-Path -LiteralPath $TemporaryDirectory)) {
        Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
    }
}
