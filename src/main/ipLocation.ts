/**
 * 公网 IP 与 IP 归属地查询工具。
 *
 * 统计日报与安装通知都需要「当前访问公网 IP」，安装通知还需要在正文中展示归属地，
 * 因此把这两段网络查询逻辑收敛到本模块，避免多处重复实现与行为漂移。
 *
 * @author zhenghq
 */

/** 默认公网 IP 服务，按顺序回退。 */
export const PUBLIC_IP_URLS = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://api.my-ip.io/v4/ip'
] as const

/**
 * 默认 IP 归属地服务，按顺序回退。
 * 优先选用返回中文字段的服务，最后回退到返回英文但结构清晰的 ipwho.is。
 */
const IP_LOCATION_URLS = [
  // 百度 IP 查询：单字段 location，例如「江苏省南京市 电信」
  (ip: string) =>
    `https://opendata.baidu.com/api.php?query=${encodeURIComponent(ip)}&co=&resource_id=6006&oe=utf8`,
  // ip-api 免费版仅提供 HTTP，中文字段拆分为国家/省/市/运营商
  (ip: string) =>
    `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,isp`,
  (ip: string) => `https://ipwho.is/${encodeURIComponent(ip)}`
] as const

/** IPv4 格式校验。 */
const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u

/** 简化的 IPv6 格式校验，仅用于拦截明显非 IP 的字符串。 */
const IPV6_PATTERN = /^(?=.*:)[0-9a-f:]+$/iu

/** 单个公网 IP 服务超时时间。 */
export const PUBLIC_IP_TIMEOUT_MS = 5_000

/** 单个归属地服务超时时间。 */
export const IP_LOCATION_TIMEOUT_MS = 5_000

/**
 * 判断字符串是否为可查询的 IP 地址（IPv4 或简化校验的 IPv6）。
 * @param value 待校验字符串。
 * @returns 合法 IP 返回 true。
 * @author zhenghq
 */
export function isValidIpAddress(value: string): boolean {
  return IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value)
}

/**
 * 获取并校验公网 IPv4 地址。
 * @param fetchImpl 可注入的网络请求函数。
 * @returns 有效 IP；无效响应返回 null。
 * @author zhenghq
 */
export async function resolvePublicIpAddress(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string | null> {
  for (const url of PUBLIC_IP_URLS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS) })
      if (!response.ok) continue
      const value = (await response.text()).trim()
      if (IPV4_PATTERN.test(value)) return value
    } catch {
      // 单个服务失败继续尝试下一个服务
    }
  }
  return null
}

/**
 * 从任意对象中取出第一个非空字符串字段。
 * @param candidates 候选字段值。
 * @returns 第一个非空字符串；均不可用时返回 null。
 * @author zhenghq
 */
function firstText(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

/**
 * 把不同归属地服务的响应统一格式化为「国家 省 市 运营商」。
 * 兼容百度（data[0].location）、ip-api（country/regionName/city/isp）
 * 与 ipwho.is（country/region/city/connection.isp）三种响应结构。
 * @param payload 服务返回的 JSON 对象。
 * @returns 去重拼接后的位置描述；无法识别时返回 null。
 * @author zhenghq
 */
export function formatIpLocation(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  // 百度：data 为数组，location 已经是「江苏省南京市 电信」这种合并描述
  if (Array.isArray(raw.data)) {
    for (const item of raw.data) {
      const location = firstText((item as Record<string, unknown>)?.location)
      if (location) return location
    }
    return null
  }
  // ip-api 查询失败时返回 status: fail
  if (raw.status === 'fail') return null
  // ipwho.is 在查询失败时返回 success: false
  if (raw.success === false) return null
  const connection = (raw.connection ?? {}) as Record<string, unknown>
  const country = firstText(raw.country, raw.country_name)
  const region = firstText(raw.region, raw.regionName)
  const city = firstText(raw.city)
  const isp = firstText(connection.isp, connection.org, raw.org, raw.isp)

  const parts: string[] = []
  for (const part of [country, region, city, isp]) {
    // 部分服务会返回「北京市 北京市」这类重复项，这里按相邻去重
    if (part && parts[parts.length - 1] !== part) parts.push(part)
  }
  return parts.length ? parts.join(' ') : null
}

/**
 * 查询 IP 归属地，按服务顺序回退并静默处理所有失败。
 * @param ip 待查询的 IP 地址。
 * @param fetchImpl 可注入的网络请求函数。
 * @returns 中文位置描述；查询失败或 IP 非法时返回 null。
 * @author zhenghq
 */
export async function resolveIpLocation(
  ip: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string | null> {
  if (!isValidIpAddress(ip)) return null
  for (const buildUrl of IP_LOCATION_URLS) {
    try {
      const response = await fetchImpl(buildUrl(ip), {
        signal: AbortSignal.timeout(IP_LOCATION_TIMEOUT_MS)
      })
      if (!response.ok) continue
      const location = formatIpLocation(await response.json())
      if (location) return location
    } catch {
      // 单个服务失败继续尝试下一个服务
    }
  }
  return null
}
