/**
 * 声明 PDF.js Worker 的 Vite URL 导入，使 Renderer 能以静态资源方式加载 Worker。
 * @author zhenghq
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.js?url' {
  const url: string
  export default url
}
