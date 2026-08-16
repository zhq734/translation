#!/bin/sh
set -eu

REPOSITORY="${SELECTION_TRANSLATOR_REPOSITORY:-zhq734/translation}"
REQUESTED_VERSION="${SELECTION_TRANSLATOR_VERSION:-${GROKBUILD_VERSION:-latest}}"
PRODUCT_NAME="划词翻译"
COMMAND_NAME="selection-translator"
TEMPORARY_DIRECTORY=""

# 输出安装进度。
# @param $* 需要显示的消息。
# @return 无返回值。
# @author zhenghq
log() {
  printf '[划词翻译] %s\n' "$*"
}

# 输出错误消息并终止安装。
# @param $* 需要显示的错误消息。
# @return 不返回，进程以非零状态退出。
# @author zhenghq
fail() {
  printf '[划词翻译] 错误：%s\n' "$*" >&2
  exit 1
}

# 校验安装依赖命令是否可用。
# @param $1 待检查的命令名称。
# @return 命令存在时正常返回，否则终止安装。
# @author zhenghq
require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少必要命令：$1"
}

# 清理安装过程中创建的临时目录。
# @return 无返回值。
# @author zhenghq
cleanup() {
  if [ -n "$TEMPORARY_DIRECTORY" ] && [ -d "$TEMPORARY_DIRECTORY" ]; then
    rm -rf "$TEMPORARY_DIRECTORY"
  fi
}

# 识别当前操作系统并转换为发行文件使用的平台名。
# @return 在标准输出打印 darwin 或 linux。
# @author zhenghq
resolve_operating_system() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' 'darwin' ;;
    Linux) printf '%s\n' 'linux' ;;
    *) fail "暂不支持当前系统：$(uname -s)。请在 Linux、macOS 或 Windows 上安装。" ;;
  esac
}

# 识别当前处理器架构并转换为 electron-builder 使用的架构名。
# @return 在标准输出打印 x64 或 arm64。
# @author zhenghq
resolve_architecture() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' 'x64' ;;
    arm64|aarch64) printf '%s\n' 'arm64' ;;
    *) fail "暂不支持当前处理器架构：$(uname -m)" ;;
  esac
}

# 解析要安装的 Release 标签，未指定时跟随 GitHub 最新正式版本。
# @return 在标准输出打印以 v 开头的 Release 标签。
# @author zhenghq
resolve_version() {
  version="$REQUESTED_VERSION"
  if [ "$version" = 'latest' ]; then
    latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPOSITORY}/releases/latest")"
    version="${latest_url##*/}"
  fi

  case "$version" in
    v*) ;;
    *) version="v${version}" ;;
  esac
  case "$version" in
    v|*[!0-9A-Za-z._-]*) fail "版本格式不合法：$version" ;;
  esac
  [ "$version" != 'vlatest' ] || fail '无法解析最新 Release 版本。'
  printf '%s\n' "$version"
}

# 根据平台、架构和版本生成需要下载的安装包名称。
# @param $1 平台名，支持 darwin 或 linux。
# @param $2 架构名，支持 x64 或 arm64。
# @param $3 不含 v 前缀的版本号。
# @return 在标准输出打印 Release 安装包文件名。
# @author zhenghq
resolve_asset_name() {
  case "$1" in
    darwin) printf 'SelectionTranslator-%s-mac-%s.zip\n' "$3" "$2" ;;
    linux) printf 'SelectionTranslator-%s-linux-%s.AppImage\n' "$3" "$2" ;;
    *) fail "无法为平台 $1 选择安装包。" ;;
  esac
}

# 计算指定文件的 SHA-256。
# @param $1 待校验文件路径。
# @return 在标准输出打印小写 SHA-256。
# @author zhenghq
calculate_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
    return
  fi
  fail '系统中未找到 sha256sum 或 shasum，无法验证安装包。'
}

# 使用 Release 中的 SHA256SUMS 校验下载文件。
# @param $1 校验和清单路径。
# @param $2 安装包路径。
# @param $3 安装包文件名。
# @return 校验通过时正常返回，否则终止安装。
# @author zhenghq
verify_checksum() {
  expected="$(awk -v name="$3" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print tolower($1); exit } }' "$1")"
  [ -n "$expected" ] || fail "SHA256SUMS 中找不到 $3。"
  actual="$(calculate_sha256 "$2")"
  [ "$actual" = "$expected" ] || fail "SHA-256 校验失败，期望 ${expected}，实际 ${actual}。"
  log 'SHA-256 校验通过。'
}

# 在配置不存在时写入应用默认配置，升级安装不会覆盖用户设置。
# @param $1 配置文件路径。
# @return 无返回值。
# @author zhenghq
write_default_config() {
  config_path="$1"
  [ ! -f "$config_path" ] || return
  mkdir -p "$(dirname "$config_path")"
  cat > "$config_path" <<'JSON'
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
JSON
  log "已生成默认配置：$config_path"
}

# 将 macOS ZIP 中的应用安装到当前用户的 Applications 目录。
# @param $1 已下载的 ZIP 路径。
# @return 无返回值。
# @author zhenghq
install_macos_application() {
  require_command unzip
  extract_directory="$TEMPORARY_DIRECTORY/macos"
  mkdir -p "$extract_directory"
  unzip -q "$1" -d "$extract_directory"
  application_path="$(find "$extract_directory" -type d -name '*.app' -print | head -n 1)"
  [ -n "$application_path" ] || fail '安装包中未找到 macOS .app。'

  install_directory="${SELECTION_TRANSLATOR_INSTALL_DIR:-$HOME/Applications}"
  destination="$install_directory/$(basename "$application_path")"
  mkdir -p "$install_directory"
  if [ -e "$destination" ]; then
    rm -rf "$destination"
  fi
  cp -R "$application_path" "$destination"
  write_default_config "$HOME/Library/Application Support/$PRODUCT_NAME/settings.json"
  log "安装完成：$destination"
  log '首次启动后请在“系统设置 → 隐私与安全性 → 辅助功能”中授权。'
}

# 将 Linux AppImage 安装到当前用户目录并创建桌面入口。
# @param $1 已下载的 AppImage 路径。
# @return 无返回值。
# @author zhenghq
install_linux_application() {
  binary_directory="${XDG_BIN_HOME:-$HOME/.local/bin}"
  binary_path="$binary_directory/$COMMAND_NAME"
  desktop_directory="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  desktop_path="$desktop_directory/selection-translator.desktop"

  mkdir -p "$binary_directory" "$desktop_directory"
  cp "$1" "$binary_path"
  chmod 755 "$binary_path"
  cat > "$desktop_path" <<EOF_DESKTOP
[Desktop Entry]
Type=Application
Name=$PRODUCT_NAME
Comment=全局划词翻译工具
Exec="$binary_path"
Terminal=false
Categories=Utility;
Icon=accessories-dictionary
EOF_DESKTOP
  chmod 644 "$desktop_path"
  write_default_config "${XDG_CONFIG_HOME:-$HOME/.config}/$PRODUCT_NAME/settings.json"
  log "安装完成：$binary_path"
  case ":$PATH:" in
    *":$binary_directory:"*) ;;
    *) log "请将 $binary_directory 添加到 PATH，或从应用菜单启动。" ;;
  esac
}

# 执行平台识别、Release 下载、校验和安装流程。
# @return 无返回值。
# @author zhenghq
main() {
  require_command curl
  require_command awk
  require_command uname

  operating_system="$(resolve_operating_system)"
  architecture="$(resolve_architecture)"
  version="$(resolve_version)"
  asset_version="${version#v}"
  asset_name="$(resolve_asset_name "$operating_system" "$architecture" "$asset_version")"
  release_base_url="https://github.com/${REPOSITORY}/releases/download/${version}"

  TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/selection-translator.XXXXXX")"
  asset_path="$TEMPORARY_DIRECTORY/$asset_name"
  checksums_path="$TEMPORARY_DIRECTORY/SHA256SUMS"

  log "正在下载 ${asset_name}（${version}）..."
  curl -fL --retry 3 --retry-delay 1 "$release_base_url/$asset_name" -o "$asset_path"
  curl -fL --retry 3 --retry-delay 1 "$release_base_url/SHA256SUMS" -o "$checksums_path"
  verify_checksum "$checksums_path" "$asset_path" "$asset_name"

  case "$operating_system" in
    darwin) install_macos_application "$asset_path" ;;
    linux) install_linux_application "$asset_path" ;;
  esac
}

trap cleanup EXIT HUP INT TERM
main "$@"
