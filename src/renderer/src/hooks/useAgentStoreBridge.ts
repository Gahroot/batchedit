import { useEffect } from 'react'
import { CAPTION_PRESETS, type CaptionStyle, type Clip, type Platform, type TemplateLayout, useStore } from '../store'

type AgentAction = { runId?: string; type: string; payload: unknown }

type Bucket = 'hook' | 'meat' | 'cta'

interface AddClipPayload {
  bucket: Bucket
  clip: Clip
}

interface RemoveClipPayload {
  bucket: Bucket
  id: string
}

interface ReorderBucketPayload {
  bucket: Bucket
  ids: string[]
}

interface SetHookTextPayload {
  clipId: string
  text: string
}

interface SetTargetPlatformPayload {
  platform: Platform
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBucket(value: unknown): value is Bucket {
  return value === 'hook' || value === 'meat' || value === 'cta'
}

function bucketKey(bucket: Bucket): 'hooks' | 'meats' | 'ctas' {
  if (bucket === 'hook') return 'hooks'
  if (bucket === 'meat') return 'meats'
  return 'ctas'
}

function isClip(value: unknown): value is Clip {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.path === 'string'
    && typeof value.name === 'string'
    && typeof value.duration === 'number'
}

function readAddClipPayload(payload: unknown): AddClipPayload | null {
  if (!isRecord(payload) || !isBucket(payload.bucket) || !isClip(payload.clip)) return null
  return { bucket: payload.bucket, clip: payload.clip }
}

function readRemoveClipPayload(payload: unknown): RemoveClipPayload | null {
  if (!isRecord(payload) || !isBucket(payload.bucket) || typeof payload.id !== 'string') return null
  return { bucket: payload.bucket, id: payload.id }
}

function readReorderBucketPayload(payload: unknown): ReorderBucketPayload | null {
  if (!isRecord(payload) || !isBucket(payload.bucket) || !Array.isArray(payload.ids)) return null
  const ids = payload.ids.filter((id): id is string => typeof id === 'string')
  return { bucket: payload.bucket, ids }
}

function readSetHookTextPayload(payload: unknown): SetHookTextPayload | null {
  if (!isRecord(payload) || typeof payload.clipId !== 'string' || typeof payload.text !== 'string') return null
  return { clipId: payload.clipId, text: payload.text }
}

function readTemplateLayout(payload: unknown): TemplateLayout | null {
  if (!isRecord(payload)) return null
  const titleText = readPoint(payload.titleText)
  const subtitles = readPoint(payload.subtitles)
  const media = readPoint(payload.media)
  if (!titleText || !subtitles || !media) return null
  return { titleText, subtitles, media }
}

function readPoint(value: unknown): { x: number; y: number } | null {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number') return null
  return { x: value.x, y: value.y }
}

function readCaptionStyle(payload: unknown): CaptionStyle | null {
  if (isRecord(payload) && typeof payload.preset === 'string') return CAPTION_PRESETS[payload.preset] ?? null
  if (!isRecord(payload)) return null
  const style = payload as Partial<CaptionStyle>
  if (
    typeof style.id !== 'string'
    || typeof style.label !== 'string'
    || typeof style.fontName !== 'string'
    || typeof style.fontFile !== 'string'
    || typeof style.fontSize !== 'number'
    || typeof style.primaryColor !== 'string'
    || typeof style.highlightColor !== 'string'
    || typeof style.outlineColor !== 'string'
    || typeof style.backColor !== 'string'
    || typeof style.outline !== 'number'
    || typeof style.shadow !== 'number'
    || typeof style.borderStyle !== 'number'
    || typeof style.wordsPerLine !== 'number'
    || !['karaoke-fill', 'word-pop', 'fade-in', 'glow'].includes(String(style.animation))
  ) {
    return null
  }
  return style as CaptionStyle
}

function readTargetPlatform(payload: unknown): SetTargetPlatformPayload | null {
  if (!isRecord(payload)) return null
  const platform = payload.platform
  if (platform !== 'tiktok' && platform !== 'reels' && platform !== 'shorts' && platform !== 'universal') return null
  return { platform }
}

function applyAgentAction(action: AgentAction): void {
  const state = useStore.getState()

  switch (action.type) {
    case 'addClipToBucket': {
      const payload = readAddClipPayload(action.payload)
      if (payload) state.addClips(payload.bucket, [payload.clip])
      return
    }
    case 'removeClip': {
      const payload = readRemoveClipPayload(action.payload)
      if (payload) state.removeClip(payload.bucket, payload.id)
      return
    }
    case 'reorderBucket': {
      const payload = readReorderBucketPayload(action.payload)
      if (!payload) return
      const clips = useStore.getState()[bucketKey(payload.bucket)]
      const byId = new Map(clips.map((clip) => [clip.id, clip]))
      const ordered = payload.ids.map((id) => byId.get(id)).filter((clip): clip is Clip => clip !== undefined)
      if (ordered.length === clips.length) state.reorderClips(payload.bucket, ordered)
      return
    }
    case 'setHookText': {
      const payload = readSetHookTextPayload(action.payload)
      if (payload) state.setHookText(payload.clipId, payload.text)
      return
    }
    case 'setCaptionStyle': {
      const style = readCaptionStyle(action.payload)
      if (style) state.setCaptionStyle(style)
      return
    }
    case 'setTemplateLayout': {
      const layout = readTemplateLayout(action.payload)
      if (layout) state.setTemplateLayout(layout)
      return
    }
    case 'setTargetPlatform': {
      const payload = readTargetPlatform(action.payload)
      if (payload) state.setTargetPlatform(payload.platform)
      return
    }
  }
}

function createStoreSnapshot(): unknown {
  const state = useStore.getState()
  return {
    hooks: state.hooks,
    meats: state.meats,
    ctas: state.ctas,
    hookTexts: state.hookTexts,
    settings: state.settings,
    captionStyle: state.captionStyle,
    templateLayout: state.templateLayout,
    targetPlatform: state.targetPlatform,
    mediaOverlays: state.mediaOverlays,
    autoTrimSilence: state.autoTrimSilence,
    captionOffsetMs: state.captionOffsetMs,
    totalCombinations: state.getTotalCombinations()
  }
}

export function useAgentStoreBridge(): void {
  useEffect(() => {
    const unsubscribeSnapshot = window.api.agentBridge.onStoreSnapshotRequest((req) => {
      window.api.agentBridge.replyStoreSnapshot(req.id, createStoreSnapshot())
    })
    const unsubscribeAction = window.api.agentBridge.onApplyAction((action) => {
      applyAgentAction(action)
    })
    return () => {
      unsubscribeSnapshot()
      unsubscribeAction()
    }
  }, [])
}
