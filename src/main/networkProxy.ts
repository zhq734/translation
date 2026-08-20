/**
 * 从 Electron 的代理解析结果中选择 Edge WebSocket 可使用的 HTTP(S) 代理。
 * @param proxyResult Electron Session 返回的 PAC 代理字符串。
 * @returns 代理 URL；直连时返回 null；代理类型不受支持时返回 undefined。
 * @author zhenghq
 */
export function edgeSpeechProxyUrl(proxyResult: string): string | null | undefined {
  const entries = proxyResult
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of entries) {
    if (/^DIRECT$/iu.test(entry)) return null
    const match = /^(PROXY|HTTPS?)\s+(.+)$/iu.exec(entry)
    if (!match) continue
    const scheme = match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'
    return `${scheme}://${match[2]}`
  }
  return entries.length === 0 ? null : undefined
}
