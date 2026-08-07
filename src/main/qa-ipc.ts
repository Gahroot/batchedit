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
  windowMs: z.number().positive().optional()
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
  model: z.string().optional()
})

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function setupQaIpc(win: BrowserWindow): void {
  setupQaRendererRpc()

  ipcMain.handle('qa:runBoundaryQA', async (_event, params: unknown) => {
    const parsed = runBoundaryQaSchema.parse(params)
    return runBoundaryQA(win, parsed.sourcePath, parsed.clips, {
      windowMs: parsed.windowMs
    })
  })

  ipcMain.handle('qa:recutClip', async (_event, params: unknown) => {
    const parsed = recutClipSchema.parse(params)
    return manualRecutClip(win, parsed)
  })
}
