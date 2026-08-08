import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { runBoundaryQA, manualRecutClip } from './qa-pipeline'
import { setupQaRendererRpc } from './qa-renderer-rpc'

// ---------------------------------------------------------------------------
// Zod schemas for IPC input validation
// ---------------------------------------------------------------------------

const qaClipInputSchema = z.object({
  label: z.string(),
  bucket: z.enum(['hook', 'meat', 'cta']),
  path: z.string(),
  sourceStart: z.number(),
  sourceEnd: z.number(),
  duration: z.number()
})

const runBoundaryQaSchema = z.object({
  sourcePath: z.string(),
  clips: z.array(qaClipInputSchema).min(1),
  windowMs: z.number().positive().optional(),
  operationId: z.string().min(1).optional()
})

const recutClipSchema = z.object({
  clipPath: z.string(),
  sourcePath: z.string(),
  sourceStart: z.number(),
  sourceEnd: z.number(),
  bucket: z.enum(['hook', 'meat', 'cta']),
  label: z.string(),
  startDeltaMs: z.number(),
  endDeltaMs: z.number(),
  model: z.string().optional(),
  operationId: z.string().min(1).optional()
})

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function setupQaIpc(win: BrowserWindow): void {
  setupQaRendererRpc()
  const activeQaOperations = new Map<string, AbortController>()

  const createQaOperation = (operationId?: string): AbortController => {
    if (operationId && activeQaOperations.has(operationId)) {
      throw new Error(`Boundary QA operation is already active: ${operationId}`)
    }
    const controller = new AbortController()
    if (operationId) activeQaOperations.set(operationId, controller)
    return controller
  }

  const finishQaOperation = (
    operationId: string | undefined,
    controller: AbortController
  ): void => {
    if (operationId && activeQaOperations.get(operationId) === controller) {
      activeQaOperations.delete(operationId)
    }
  }

  ipcMain.handle('qa:cancelBoundaryQA', async (_event, operationId: unknown) => {
    if (typeof operationId !== 'string' || operationId.trim().length === 0) return false
    const controller = activeQaOperations.get(operationId)
    if (!controller) return false
    controller.abort()
    return true
  })

  ipcMain.handle('qa:runBoundaryQA', async (_event, params: unknown) => {
    const parsed = runBoundaryQaSchema.parse(params)
    const controller = createQaOperation(parsed.operationId)
    try {
      return await runBoundaryQA(
        win,
        parsed.sourcePath,
        parsed.clips,
        parsed.windowMs === undefined ? {} : { windowMs: parsed.windowMs },
        controller.signal
      )
    } finally {
      finishQaOperation(parsed.operationId, controller)
    }
  })

  ipcMain.handle('qa:recutClip', async (_event, params: unknown) => {
    const parsed = recutClipSchema.parse(params)
    const controller = createQaOperation(parsed.operationId)
    const recutParams = {
      clipPath: parsed.clipPath,
      sourcePath: parsed.sourcePath,
      sourceStart: parsed.sourceStart,
      sourceEnd: parsed.sourceEnd,
      bucket: parsed.bucket,
      label: parsed.label,
      startDeltaMs: parsed.startDeltaMs,
      endDeltaMs: parsed.endDeltaMs,
      ...(parsed.model === undefined ? {} : { model: parsed.model })
    }
    try {
      return await manualRecutClip(win, recutParams, controller.signal)
    } finally {
      finishQaOperation(parsed.operationId, controller)
    }
  })
}
