import type { AgentTool } from '@prestyj/agent'
import { createAnalyzeShotTool } from './analyze-shot'
import { createExtractFramesTool } from './frames'
import { createDetectMarkersTool, createProposeSplitsTool } from './markers'
import { createIngestSourceTool } from './ingest'
import { createPickTemplateTool } from './pick-template'
import { createRenderTools } from './render'
import { createReviewTools } from './review'
import { createSplitClipTool, createRecutClipTool } from './splits'
import { createStoreActionTools } from './store-actions'
import { createTranscribeClipTool } from './transcribe'
import { createVerifyClipBoundariesTool, createVerifySrtAlignmentTool } from './verify'
import type { ToolContextState } from './types'

export function buildTools(ctx: ToolContextState): AgentTool[] {
  return [
    createIngestSourceTool(ctx),
    createExtractFramesTool(),
    createTranscribeClipTool(ctx),
    createDetectMarkersTool(),
    createProposeSplitsTool(),
    createSplitClipTool(ctx),
    createRecutClipTool(ctx),
    createVerifyClipBoundariesTool(ctx),
    createVerifySrtAlignmentTool(ctx),
    createAnalyzeShotTool(ctx),
    createPickTemplateTool(),
    ...createStoreActionTools(ctx),
    ...createRenderTools(ctx),
    ...createReviewTools(ctx)
  ]
}
