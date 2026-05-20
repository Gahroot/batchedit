import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { callRenderer } from '../renderer-rpc'
import { cancelActiveRenderBatch } from '../../render-pipeline'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const emptySchema = z.object({})
const startRenderJobSchema = z.object({ dryRun: z.boolean().optional() })
const getRenderStatusSchema = z.object({ jobId: z.string() })
const getRenderLogSchema = z.object({ jobId: z.string(), since: z.number().optional() })
const cancelRenderSchema = z.object({ jobId: z.string().optional() })

export function createRenderTools(ctx: ToolContextState): BatchEditAgentTool[] {
  return [
    {
      name: 'validateRenderPlan',
      description: 'Validate current render queue size, duration, disk estimate, and warnings from renderer store state.',
      parameters: emptySchema,
      async execute(_args, toolContext) {
        const snapshot = await callRenderer<{
          hooks?: Array<{ duration?: number }>
          meats?: Array<{ duration?: number }>
          ctas?: Array<{ duration?: number }>
        }>(ctx.win, 'agent:getStoreSnapshot', {}, toolContext.signal)
        const hooks = snapshot.hooks ?? []
        const meats = snapshot.meats ?? []
        const ctas = snapshot.ctas ?? []
        const count = hooks.length * meats.length * ctas.length
        const averageDuration = [...hooks, ...meats, ...ctas].reduce((sum, clip) => sum + (clip.duration ?? 0), 0) / Math.max(1, hooks.length + meats.length + ctas.length)
        const totalDurationSec = count * averageDuration * 3
        const estDiskGb = totalDurationSec * 0.015
        const warnings = []
        if (count === 0) warnings.push('No complete Hook × Meat × CTA combinations are available.')
        if (count > 250) warnings.push('Large render queue may take significant time and disk space.')
        if (estDiskGb > 100) warnings.push('Estimated disk usage exceeds 100GB.')
        return stringifyToolResult({ count, totalDurationSec, estDiskGb, warnings })
      }
    },
    {
      name: 'startRenderJob',
      description: 'Start renderer batch rendering after an explicit human approval gate.',
      parameters: startRenderJobSchema,
      executionMode: 'sequential',
      async execute(args, toolContext) {
        if (!ctx.approvedRenderAtTurn) throw new Error('Render approval is required immediately before startRenderJob')
        const jobId = uuidv4()
        if (!args.dryRun) {
          ctx.win.webContents.send('agent:startRender', { jobId })
        }
        ctx.jobLedger.register(jobId)
        return stringifyToolResult({ jobId })
      }
    },
    {
      name: 'getRenderStatus',
      description: 'Get render job status from the in-memory job ledger.',
      parameters: getRenderStatusSchema,
      execute(args) {
        const entry = ctx.jobLedger.get(args.jobId)
        const progress = entry?.progress
        return stringifyToolResult({
          phase: progress?.status ?? 'queued',
          percent: progress?.percent ?? 0,
          currentClip: progress?.jobId ?? null,
          errors: progress?.error ? [progress.error] : [],
          done: progress?.status === 'done' || progress?.status === 'error' || progress?.status === 'canceled'
        })
      }
    },
    {
      name: 'getRenderLog',
      description: 'Get render progress log events after an optional cursor.',
      parameters: getRenderLogSchema,
      execute(args) {
        return stringifyToolResult({ events: ctx.jobLedger.getLog(args.jobId, args.since ?? 0) })
      }
    },
    {
      name: 'cancelRender',
      description: 'Cancel the active render batch or a specific render job.',
      parameters: cancelRenderSchema,
      executionMode: 'sequential',
      execute(args) {
        return stringifyToolResult({ ok: cancelActiveRenderBatch(args.jobId) })
      }
    }
  ]
}
