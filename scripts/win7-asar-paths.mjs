/**
 * 将 @electron/asar 在 Windows 返回的反斜杠路径统一为 asar 校验使用的 POSIX 绝对路径。
 * @param {string[]} entries asar 条目路径。
 * @returns {string[]} 以 / 开头且使用正斜杠的条目路径。
 * @author zhenghq
 */
export function normalizeAsarEntries(entries) {
  return entries.map((entry) => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\/+/u, '')
    return `/${normalized}`
  })
}
