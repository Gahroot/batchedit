import { ipcMain, type BrowserWindow } from 'electron'
import type { ManualRecutParams } from './boundary-qa'
import { AgentService, type AgentStartOptions } from './service'
import { setupRendererRpc } from './renderer-rpc'
import { setupReviewIpc } from './tools/review'

let service: AgentService | null = null

export function setupAgent(win: BrowserWindow): AgentService {
  setupRendererRpc()
  setupReviewIpc()
  service = new AgentService(win)

  ipcMain.handle('agent:start', async (_event, options: AgentStartOptions) => {
    if (!service) throw new Error('Agent service is not ready')
    return service.start(options)
  })

  ipcMain.handle('agent:cancel', async (_event, runId: string) => {
    service?.cancel(runId)
  })

  ipcMain.handle('agent:qaRecut', async (_event, params: ManualRecutParams) => {
    if (!service) throw new Error('Agent service is not ready')
    return service.qaRecut(params)
  })

  ipcMain.on('agent:renderProgress', (_event, progress: Array<{ jobId: string; percent: number; status: string; error?: string }>) => {
    for (const item of progress) {
      service?.ledger.update(item.jobId, item as never)
    }
  })

  return service
}
