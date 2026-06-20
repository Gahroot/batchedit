import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { callRenderer } from '../renderer-rpc'
import { isWindowAlive } from '../window-guard'
import { readTranscriptCache } from '../transcript-cache'
import type { BatchEditAgentTool, ToolContextState } from './types'
import { stringifyToolResult } from './types'

const bucketSchema = z.enum(['hook', 'meat', 'cta'])
const clipSchema = z.object({
  path: z.string(),
  name: z.string(),
  duration: z.number(),
  thumbnail: z.string().optional(),
  transcript: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional()
})
const addClipToBucketSchema = z.object({ bucket: bucketSchema, clip: clipSchema })
const removeClipSchema = z.object({ bucket: bucketSchema, id: z.string() })
const reorderBucketSchema = z.object({ bucket: bucketSchema, ids: z.array(z.string()) })
const setHookTextSchema = z.object({ clipId: z.string(), text: z.string() })
const setCaptionStyleSchema = z.union([z.object({ preset: z.string() }), z.record(z.string(), z.unknown())])
const setTemplateLayoutSchema = z.object({
  titleText: z.object({ x: z.number(), y: z.number() }),
  subtitles: z.object({ x: z.number(), y: z.number() }),
  media: z.object({ x: z.number(), y: z.number() })
})
const setTargetPlatformSchema = z.object({ platform: z.enum(['tiktok', 'reels', 'shorts', 'universal']) })
const setOutputDirectorySchema = z.object({ directory: z.string().min(1) })
const emptySchema = z.object({})

function sendStoreAction(ctx: ToolContextState, type: string, payload: unknown): void {
  if (!isWindowAlive(ctx.win)) return
  console.info('agent_store_action', { runId: ctx.runId, type })
  ctx.win.webContents.send('agent:applyAction', { runId: ctx.runId, type, payload })
}

export function createStoreActionTools(ctx: ToolContextState): BatchEditAgentTool[] {
  return [
    {
      name: 'addClipToBucket',
      description: 'Add a clip to a renderer bucket.',
      parameters: addClipToBucketSchema,
      executionMode: 'sequential',
      async execute(args) {
        const id = uuidv4()
        let clip = { ...args.clip, id }
        const cached = await readTranscriptCache(args.clip.path)
        if (cached?.words) clip = { ...clip, transcript: cached.words }
        sendStoreAction(ctx, 'addClipToBucket', { ...args, clip })
        return stringifyToolResult({ id })
      }
    },
    {
      name: 'removeClip',
      description: 'Remove a clip from a renderer bucket.',
      parameters: removeClipSchema,
      executionMode: 'sequential',
      execute(args) {
        sendStoreAction(ctx, 'removeClip', args)
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'reorderBucket',
      description: 'Reorder a renderer bucket by clip ids.',
      parameters: reorderBucketSchema,
      executionMode: 'sequential',
      execute(args) {
        sendStoreAction(ctx, 'reorderBucket', args)
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'setHookText',
      description: 'Set hook overlay text for a clip.',
      parameters: setHookTextSchema,
      executionMode: 'sequential',
      execute(args) {
        sendStoreAction(ctx, 'setHookText', args)
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'setCaptionStyle',
      description: 'Set caption style by preset or full style object.',
      parameters: setCaptionStyleSchema,
      executionMode: 'sequential',
      execute(args) {
        sendStoreAction(ctx, 'setCaptionStyle', args)
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'setTemplateLayout',
      description: 'Set template layout positions in the renderer store.',
      parameters: setTemplateLayoutSchema,
      executionMode: 'sequential',
      execute(args) {
        sendStoreAction(ctx, 'setTemplateLayout', args)
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'setTargetPlatform',
      description: 'Set target platform for safe zones.',
      parameters: setTargetPlatformSchema,
      executionMode: 'sequential',
      execute(args) {
        sendStoreAction(ctx, 'setTargetPlatform', args)
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'setOutputDirectory',
      description: 'Set the render output directory.',
      parameters: setOutputDirectorySchema,
      executionMode: 'sequential',
      execute(args) {
        sendStoreAction(ctx, 'setOutputDirectory', { directory: args.directory })
        return stringifyToolResult({ ok: true })
      }
    },
    {
      name: 'getStoreSnapshot',
      description: 'Read the current renderer store snapshot.',
      parameters: emptySchema,
      async execute(_args, toolContext) {
        const snapshot = await callRenderer<unknown>(ctx.win, 'agent:getStoreSnapshot', {}, toolContext.signal)
        return stringifyToolResult(snapshot)
      }
    }
  ]
}
