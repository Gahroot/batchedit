import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { isWindowAlive } from '../window-guard'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const logProgressSchema = z.object({
  phase: z.string(),
  message: z.string(),
  data: z.unknown().optional()
})

const requestHumanReviewSchema = z.object({
  reason: z.string(),
  attach: z.object({
    clipPath: z.string().optional(),
    frames: z.array(z.unknown()).optional(),
    transcript: z.array(z.unknown()).optional()
  }).optional()
})

interface PendingReview {
  resolve: (response: { approved: boolean; edits?: unknown }) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const pendingReviews = new Map<string, PendingReview>()
let reviewIpcRegistered = false

/**
 * Safety net: if the renderer never replies (window closed mid-review, IPC
 * dropped), auto-reject so the agent's promise resolves instead of hanging the
 * run forever. The modal itself maps dismissal to a rejection well before this.
 */
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000

export function resolveHumanReview(reviewId: string, response: { approved: boolean; edits?: unknown }): boolean {
  const review = pendingReviews.get(reviewId)
  if (!review) return false
  pendingReviews.delete(reviewId)
  clearTimeout(review.timeout)
  review.resolve(response)
  return true
}

export function setupReviewIpc(): void {
  if (reviewIpcRegistered) return
  reviewIpcRegistered = true
  ipcMain.handle('agent:reviewReply', async (_event, reviewId: string, response: { approved: boolean; edits?: unknown }) => {
    return resolveHumanReview(reviewId, response)
  })
}

export function createReviewTools(ctx: ToolContextState): BatchEditAgentTool[] {
  return [
    {
      name: 'logProgress',
      description: 'Log an agent progress message to the renderer timeline.',
      parameters: logProgressSchema,
      execute(args) {
        if (isWindowAlive(ctx.win)) ctx.win.webContents.send('agent:event', { runId: ctx.runId, type: 'logProgress', ...args })
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'requestHumanReview',
      description: 'Pause the agent for a human approval or edit response in the renderer.',
      parameters: requestHumanReviewSchema,
      executionMode: 'sequential',
      async execute(args) {
        const reviewId = uuidv4()
        const response = await new Promise<{ approved: boolean; edits?: unknown }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (pendingReviews.delete(reviewId)) resolve({ approved: false })
          }, REVIEW_TIMEOUT_MS)
          pendingReviews.set(reviewId, { resolve, reject, timeout })
          if (isWindowAlive(ctx.win)) {
            ctx.win.webContents.send('agent:event', {
              runId: ctx.runId,
              type: 'review_requested',
              reviewId,
              reason: args.reason,
              attach: args.attach ?? {}
            })
          }
        })
        if (args.reason === 'ready_to_render' && response.approved) {
          ctx.approvedRenderAtTurn = Date.now()
        }
        return stringifyToolResult(response)
      }
    }
  ]
}
