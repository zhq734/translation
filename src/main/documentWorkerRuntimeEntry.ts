import { runDocumentWorkerRuntime } from './documentWorkerRuntime.ts'
import { startDocumentWorkerProductionEntry } from './documentWorkerProductionEntry.ts'

/** utility process 父端口；由 Electron 在子进程启动时注入。 */
const parentPort = process.parentPort

// utility process 构建入口只在父端口存在时启动；普通导入不会触发重任务。
if (parentPort) {
  startDocumentWorkerProductionEntry(parentPort, {
    createRuntime: (dependencies) => runDocumentWorkerRuntime(dependencies)
  })
}
