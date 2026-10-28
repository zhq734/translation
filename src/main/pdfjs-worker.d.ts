/**
 * PDF.js legacy worker 构建没有发布独立类型声明；解析器只把模块对象注册为
 * 主线程 worker 处理器，因此这里声明为未知模块值，避免使用 any。
 * @author zhenghq
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.js' {
  /** PDF.js worker 模块导出；运行时由解析器转换为未知类型。 */
  const workerModule: unknown
  export default workerModule
}
