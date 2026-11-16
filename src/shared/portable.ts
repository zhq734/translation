/** 当前进程的便携状态；不包含凭证或其他私密设置。 */
export interface PortableRuntimeInfo {
  /** 是否启用 Windows 文件夹便携模式。 */
  enabled: boolean
  /** 启用时为程序同级 data 绝对路径，否则为 null。 */
  dataDirectory: string | null
}
