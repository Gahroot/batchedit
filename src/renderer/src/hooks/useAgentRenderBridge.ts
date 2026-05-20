import { useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useStore, type RenderProgress } from '../store'

interface AgentRenderJob {
  id: string
  hookPath: string
  meatPath: string
  ctaPath: string
  outputPath: string
  textOverlay?: string
  hookDurationSec?: number
  autoResize?: boolean
  resolution: { width: number; height: number }
  titlePosition?: { x: number; y: number }
  mediaOverlays?: { meat?: string; cta?: string }
  mediaOverlayPosition?: { x: number; y: number }
  meatDurationSec?: number
  targetPlatform?: string
  captionData?: {
    clipWordChunks: Record<string, Array<{ text: string; start: number; end: number }>>
    captionStyle?: {
      fontName: string
      fontFile: string
      fontSize: number
      primaryColor: string
      highlightColor: string
      outlineColor: string
      backColor: string
      outline: number
      shadow: number
      borderStyle: number
      wordsPerLine: number
      animation: 'karaoke-fill' | 'word-pop' | 'fade-in' | 'glow'
    }
    captionPosition?: { x: number; y: number }
    captionOffsetMs?: number
  }
}

function safeOutputName(value: string): string {
  return value.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim()
}

function stripExtension(value: string): string {
  return value.replace(/\.[^.]+$/, '')
}

function buildAgentRenderJobs(batchId: string): AgentRenderJob[] {
  const state = useStore.getState()
  const combos = state.getCombos()
  const outputDirectory = state.settings.outputDirectory
  if (!outputDirectory) throw new Error('Choose an output folder before starting agent render.')
  if (combos.length === 0) throw new Error('No Hook × Meat × CTA combinations are available to render.')

  const { id: _id, label: _label, ...captionStyle } = state.captionStyle
  const jobMap: Record<string, string> = {}

  const jobs = combos.map((combo, index): AgentRenderJob => {
    const id = index === 0 ? batchId : uuidv4()
    jobMap[id] = combo.id
    const hookText = state.hookTexts[combo.hook.id]
    const hookLabel = hookText?.trim()
      ? safeOutputName(hookText)
      : safeOutputName(stripExtension(combo.hook.name))
    const outputName = `${hookLabel}_${safeOutputName(stripExtension(combo.meat.name))}_${safeOutputName(stripExtension(combo.cta.name))}_${index + 1}.mp4`
    const clipWordChunks: Record<string, Array<{ text: string; start: number; end: number }>> = {
      [combo.hook.path]: combo.hook.transcript ?? [],
      [combo.meat.path]: combo.meat.transcript ?? [],
      [combo.cta.path]: combo.cta.transcript ?? []
    }

    return {
      id,
      hookPath: combo.hook.path,
      meatPath: combo.meat.path,
      ctaPath: combo.cta.path,
      outputPath: `${outputDirectory}/${outputName}`,
      resolution: { width: state.settings.resolution.width, height: state.settings.resolution.height },
      titlePosition: state.templateLayout.titleText,
      targetPlatform: state.targetPlatform,
      ...(hookText?.trim() ? { textOverlay: hookText.trim(), hookDurationSec: combo.hook.duration } : {}),
      ...(state.mediaOverlays.meat || state.mediaOverlays.cta
        ? {
            mediaOverlays: {
              ...(state.mediaOverlays.meat ? { meat: state.mediaOverlays.meat } : {}),
              ...(state.mediaOverlays.cta ? { cta: state.mediaOverlays.cta } : {})
            },
            mediaOverlayPosition: state.templateLayout.media,
            meatDurationSec: combo.meat.duration,
            hookDurationSec: combo.hook.duration
          }
        : {}),
      ...(Object.values(clipWordChunks).some((words) => words.length > 0)
        ? {
            captionData: {
              clipWordChunks,
              captionStyle,
              captionPosition: state.templateLayout.subtitles,
              captionOffsetMs: state.captionOffsetMs
            }
          }
        : {})
    }
  })

  useStore.getState().setJobIdToComboId(jobMap)
  return jobs
}

export function useAgentRenderBridge(): void {
  useEffect(() => {
    return window.api.agentBridge.onStartRender(async ({ jobId }) => {
      const state = useStore.getState()
      try {
        state.setIsRendering(true)
        state.clearErrors()
        const jobs = buildAgentRenderJobs(jobId)
        const progress = await window.api.renderBatch(jobs)
        state.setRenderProgress(progress)
        window.api.agentBridge.sendRenderProgress(progress)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.addError({ source: 'render', clipName: 'Agent render', message })
        const progress: RenderProgress[] = [{ jobId, percent: 0, status: 'error', error: message }]
        state.setRenderProgress(progress)
        window.api.agentBridge.sendRenderProgress(progress)
      } finally {
        useStore.getState().setIsRendering(false)
      }
    })
  }, [])
}
