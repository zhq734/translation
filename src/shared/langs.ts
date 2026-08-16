export interface Lang {
  code: string
  label: string
}

// DeepL 支持的语言子集（大写代码，DeepLX 兼容）
export const LANGUAGES: Lang[] = [
  { code: 'ZH', label: '中文' },
  { code: 'EN', label: '英语' },
  { code: 'JA', label: '日语' },
  { code: 'KO', label: '韩语' },
  { code: 'FR', label: '法语' },
  { code: 'DE', label: '德语' },
  { code: 'ES', label: '西班牙语' },
  { code: 'PT', label: '葡萄牙语' },
  { code: 'IT', label: '意大利语' },
  { code: 'NL', label: '荷兰语' },
  { code: 'PL', label: '波兰语' },
  { code: 'RU', label: '俄语' },
  { code: 'TR', label: '土耳其语' },
  { code: 'ID', label: '印尼语' },
  { code: 'UK', label: '乌克兰语' },
  { code: 'AR', label: '阿拉伯语' },
  { code: 'SV', label: '瑞典语' },
  { code: 'DA', label: '丹麦语' },
  { code: 'CS', label: '捷克语' },
  { code: 'EL', label: '希腊语' },
  { code: 'FI', label: '芬兰语' },
  { code: 'HU', label: '匈牙利语' },
  { code: 'RO', label: '罗马尼亚语' },
  { code: 'SK', label: '斯洛伐克语' },
  { code: 'BG', label: '保加利亚语' },
  { code: 'LT', label: '立陶宛语' },
  { code: 'LV', label: '拉脱维亚语' },
  { code: 'ET', label: '爱沙尼亚语' },
  { code: 'SL', label: '斯洛文尼亚语' }
]

export function langLabel(code: string): string {
  if (!code) return ''
  if (code.toLowerCase() === 'auto') return '自动检测'
  return LANGUAGES.find((l) => l.code === code.toUpperCase())?.label ?? code
}
