import { useCallback, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus,
  X,
  Type,
  FileVideo,
  Sparkles,
  Loader2,
  Image,
  Pencil,
  AlertTriangle,
  Square,
  FolderOpen
} from 'lucide-react'
import { useStore, BucketType, Clip } from '../store'
import { useWhisper } from '../hooks/useWhisper'
import { isWhisperCancellationError, WhisperCancellationError } from '../hooks/whisper-client'
import { cn } from '../lib/utils'
import { v4 as uuidv4 } from 'uuid'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
  type UniqueIdentifier
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableClip } from './SortableClip'
import { ClipEditor } from './ClipEditor'
import { WhisperModelControl } from './WhisperModelControl'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { BlurText } from '@/components/ui/blur-text'
import { toast } from 'sonner'
import { humanizeFfmpegError } from '../../../shared/ffmpeg-error-hints'
import {
  fileNameFromPath,
  importedClipFromOutcome,
  summarizeClipImports,
  type ClipImportOutcome
} from '../clip-import-outcome'

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts', '.m4v']

interface ClipMetadata {
  duration: number
}

type TrimFailureChoice = 'retry' | 'use-original' | 'cancel'

function GenerateHookTextButton({ clips }: { clips: Clip[] }) {
  const geminiApiKey = useStore((s) => s.geminiApiKey)
  const hookTexts = useStore((s) => s.hookTexts)
  const setHookText = useStore((s) => s.setHookText)
  const setHookTextProgress = useStore((s) => s.setHookTextProgress)
  const addError = useStore((s) => s.addError)
  const isRendering = useStore((s) => s.isRendering)
  const hookTextProgress = useStore((s) => s.hookTextProgress)
  const whisperModel = useStore((s) => s.whisperModel)
  const whisperDevice = useStore((s) => s.whisperDevice)
  const { loadModel, transcribe, cancel } = useWhisper()
  const generationRunId = useRef(0)
  const [isGenerating, setIsGenerating] = useState(false)

  const handleGenerate = async (): Promise<void> => {
    if (whisperDevice === 'detecting') return

    if (!geminiApiKey) {
      const message = 'Add your Gemini API key in the top settings bar to generate hook text.'
      toast.error(message)
      addError({ source: 'hooktext', clipName: 'Setup', message })
      return
    }

    const emptyClips = clips.filter((clip) => !hookTexts[clip.id]?.trim())
    if (emptyClips.length === 0) return

    const runId = generationRunId.current + 1
    generationRunId.current = runId
    setIsGenerating(true)
    const total = emptyClips.length
    const assertCurrentRun = (): void => {
      if (generationRunId.current !== runId) throw new WhisperCancellationError()
    }

    try {
      setHookTextProgress({ stage: 'loading-model', currentClip: '', completedClips: 0, totalClips: total })
      await loadModel(whisperModel)
      assertCurrentRun()

      for (let i = 0; i < emptyClips.length; i++) {
        const clip = emptyClips[i]
        let wavPath: string | null = null

        try {
          setHookTextProgress({ stage: 'transcribing', currentClip: clip.name, completedClips: i, totalClips: total })
          wavPath = await window.api.extractAudio(clip.path)
          assertCurrentRun()
          const audioBuffer = await window.api.readAudioBuffer(wavPath)
          wavPath = null
          assertCurrentRun()
          const { chunks } = await transcribe(new Float32Array(audioBuffer), whisperModel)
          assertCurrentRun()
          const transcript = chunks.map((chunk) => chunk.text).join(' ').trim()

          if (!transcript) {
            addError({ source: 'hooktext', clipName: clip.name, message: 'Empty transcript — skipping' })
            toast.error(`${clip.name}: empty transcript — skipping`)
            continue
          }

          setHookTextProgress({ stage: 'generating', currentClip: clip.name, completedClips: i, totalClips: total })
          const hookText = await window.api.generateHookText(geminiApiKey, transcript)
          assertCurrentRun()
          setHookText(clip.id, hookText)
        } catch (error) {
          if (isWhisperCancellationError(error)) throw error
          const message = error instanceof Error ? error.message : String(error)
          addError({ source: 'hooktext', clipName: clip.name, message })
          toast.error(`Hook text failed for ${clip.name}`, { description: message })
        } finally {
          if (wavPath) await window.api.releaseTempFile(wavPath)
        }
      }
    } catch (error) {
      if (!isWhisperCancellationError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        addError({ source: 'hooktext', clipName: 'Whisper', message })
        toast.error('Hook text generation failed', { description: message })
      }
    } finally {
      if (generationRunId.current === runId) {
        setHookTextProgress(null)
        setIsGenerating(false)
      }
    }
  }

  const stopGeneration = (): void => {
    generationRunId.current += 1
    cancel()
    setHookTextProgress(null)
    setIsGenerating(false)
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isGenerating ? 'destructive' : 'secondary'}
            size="sm"
            onClick={isGenerating ? stopGeneration : () => void handleGenerate()}
            disabled={
              isRendering ||
              (!isGenerating && (clips.length === 0 || whisperDevice === 'detecting'))
            }
            className="h-7 text-xs gap-1"
          >
            {isGenerating ? (
              <Square className="w-3 h-3 fill-current" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            {isGenerating ? 'Stop' : 'Generate'}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Auto-generate hook text with AI (Whisper + Gemini)</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface BucketProps {
  type: BucketType
  label: string
  color: string
}

export function Bucket({ type, label, color }: BucketProps) {
  const clips = useStore((s) =>
    type === 'hook' ? s.hooks : type === 'meat' ? s.meats : s.ctas
  )
  const addClips = useStore((s) => s.addClips)
  const removeClip = useStore((s) => s.removeClip)
  const reorderClips = useStore((s) => s.reorderClips)
  const hookTexts = useStore((s) => s.hookTexts)
  const setHookText = useStore((s) => s.setHookText)
  const isRendering = useStore((s) => s.isRendering)
  const hookTextProgress = useStore((s) => s.hookTextProgress)
  const mediaOverlays = useStore((s) => s.mediaOverlays)
  const missingMediaOverlays = useStore((s) => s.missingMediaOverlays)
  const setMediaOverlay = useStore((s) => s.setMediaOverlay)
  const updateClipPath = useStore((s) => s.updateClipPath)
  const autoTrimSilence = useStore((s) => s.autoTrimSilence)
  const addError = useStore((s) => s.addError)
  const { loadProgress } = useWhisper()
  const [isDragOver, setIsDragOver] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [editingClipId, setEditingClipId] = useState<string | null>(null)
  const [relinkingClipId, setRelinkingClipId] = useState<string | null>(null)
  const [moveAnnouncement, setMoveAnnouncement] = useState('')
  const overlayPath = type === 'hook' ? null : mediaOverlays[type]
  const overlayMissing = type === 'hook' ? false : missingMediaOverlays[type]
  const overlayButtonLabel = overlayMissing ? 'Relink' : overlayPath ? 'Replace' : 'Image'

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const accessibility = useMemo<{
    announcements: Announcements
    screenReaderInstructions: ScreenReaderInstructions
  }>(() => {
    const getClipName = (id: UniqueIdentifier): string =>
      clips.find((clip) => clip.id === id)?.name ?? 'Unknown clip'
    const getPosition = (id: UniqueIdentifier): string => {
      const index = clips.findIndex((clip) => clip.id === id)
      return index >= 0 ? `position ${index + 1} of ${clips.length}` : 'an unknown position'
    }

    return {
      announcements: {
        onDragStart({ active }) {
          return `Picked up ${getClipName(active.id)} in the ${label} bucket at ${getPosition(active.id)}.`
        },
        onDragOver({ active, over }) {
          if (!over) {
            return `${getClipName(active.id)} is not over a position in the ${label} bucket.`
          }
          return `Moved ${getClipName(active.id)} to ${getPosition(over.id)} in the ${label} bucket.`
        },
        onDragEnd({ active, over }) {
          const position = over ? getPosition(over.id) : getPosition(active.id)
          return `Dropped ${getClipName(active.id)} at ${position} in the ${label} bucket.`
        },
        onDragCancel({ active }) {
          return `Cancelled moving ${getClipName(active.id)}. It remains at ${getPosition(active.id)} in the ${label} bucket.`
        }
      },
      screenReaderInstructions: {
        draggable: `To pick up a clip, press Space or Enter. While dragging, use the Up and Down Arrow keys to move it within the ${label} bucket. Press Space or Enter again to drop it, or Escape to cancel. Move Up and Move Down buttons are also available.`
      }
    }
  }, [clips, label])

  const getValidMetadata = useCallback(async (path: string): Promise<ClipMetadata> => {
    const metadata = await window.api.getMetadata(path)
    if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) {
      throw new Error('Metadata probe returned no positive video duration')
    }
    return metadata
  }, [])

  const createClip = useCallback(async (
    path: string,
    name: string,
    metadata: ClipMetadata
  ): Promise<Clip> => {
    const thumbnail = await window.api.getThumbnail(path).catch(() => undefined)
    return { id: uuidv4(), path, name, duration: metadata.duration, thumbnail }
  }, [])

  const requestTrimFailureChoice = useCallback((
    path: string,
    error: unknown
  ): Promise<TrimFailureChoice> => {
    const name = fileNameFromPath(path)
    const detail = error instanceof Error ? error.message : String(error)
    const { hint, raw } = humanizeFfmpegError(detail, 'Silence trimming failed')
    addError({
      source: 'ingest',
      clipName: name,
      message: 'Silence trimming failed. Retry trimming or use the original clip.',
      detail: raw
    })

    return new Promise((resolve) => {
      let settled = false
      const settle = (choice: TrimFailureChoice): void => {
        if (settled) return
        settled = true
        resolve(choice)
      }

      toast.error(`Couldn't trim ${name}`, {
        description: `${hint} Retry trimming, or use the original clip without trimming.`,
        duration: Number.POSITIVE_INFINITY,
        action: { label: 'Retry', onClick: () => settle('retry') },
        cancel: { label: 'Use Original', onClick: () => settle('use-original') },
        onDismiss: () => settle('cancel')
      })
    })
  }, [addError])

  const processClip = useCallback(async (path: string): Promise<ClipImportOutcome> => {
    const sourceName = fileNameFromPath(path)
    let sourceMetadata: ClipMetadata
    try {
      sourceMetadata = await getValidMetadata(path)
    } catch (error) {
      return { kind: 'metadata-failure', sourcePath: path, error }
    }

    if (!autoTrimSilence) {
      return {
        kind: 'added-original',
        clip: await createClip(path, sourceName, sourceMetadata)
      }
    }

    while (true) {
      let trimError: unknown
      try {
        const result = await window.api.trimLeadingSilence(path)
        if (result.outcome === 'trim-success') {
          const validResult =
            result.outputPath.length > 0 &&
            Number.isFinite(result.trimmedSeconds) &&
            result.trimmedSeconds >= 0 &&
            (result.trimmedSeconds === 0 || result.outputPath !== path)
          if (!validResult) {
            trimError = new Error('Silence trimming returned an invalid result')
          } else {
            try {
              const metadata = result.outputPath === path
                ? sourceMetadata
                : await getValidMetadata(result.outputPath)
              const clip = await createClip(result.outputPath, sourceName, metadata)
              return { kind: 'trim-success', clip, trimmedSeconds: result.trimmedSeconds }
            } catch (error) {
              if (result.outputPath !== path) {
                await window.api.releaseTempFile(result.outputPath).catch(() => undefined)
              }
              return { kind: 'metadata-failure', sourcePath: path, error }
            }
          }
        } else {
          trimError = new Error(result.error || 'Silence trimming failed')
        }
      } catch (error) {
        trimError = error
      }

      const choice = await requestTrimFailureChoice(path, trimError)
      if (choice === 'retry') continue
      if (choice === 'use-original') {
        return {
          kind: 'trim-fallback',
          clip: await createClip(path, sourceName, sourceMetadata)
        }
      }
      return { kind: 'cancelled', sourcePath: path }
    }
  }, [autoTrimSilence, createClip, getValidMetadata, requestTrimFailureChoice])

  const reportRejectedClip = useCallback((path: string, error: unknown): void => {
    const name = fileNameFromPath(path)
    const detail = error instanceof Error ? error.message : String(error)
    const { hint, raw } = humanizeFfmpegError(detail, 'Metadata probe failed')
    const message = `Import rejected. ${hint}`
    addError({ source: 'ingest', clipName: name, message, detail: raw })
    toast.error(`Couldn't add ${name}`, { description: hint })
  }, [addError])

  const showImportSummary = useCallback((outcomes: readonly ClipImportOutcome[]): void => {
    const summary = summarizeClipImports(outcomes)
    const options = { description: summary.description }
    switch (summary.tone) {
      case 'success':
        toast.success(summary.title, options)
        break
      case 'warning':
        toast.warning(summary.title, options)
        break
      case 'error':
        toast.error(summary.title, options)
        break
    }
  }, [])

  const importClipPaths = useCallback(async (filePaths: string[]): Promise<void> => {
    setIsProcessing(true)
    try {
      const outcomes = await Promise.all(filePaths.map(async (path): Promise<ClipImportOutcome> => {
        try {
          return await processClip(path)
        } catch (error) {
          return { kind: 'metadata-failure', sourcePath: path, error }
        }
      }))
      const importedClips = outcomes
        .map(importedClipFromOutcome)
        .filter((clip): clip is Clip => clip !== null)
      for (const outcome of outcomes) {
        if (outcome.kind === 'metadata-failure') {
          reportRejectedClip(outcome.sourcePath, outcome.error)
        }
      }
      if (importedClips.length > 0) addClips(type, importedClips)
      showImportSummary(outcomes)
    } finally {
      setIsProcessing(false)
    }
  }, [type, addClips, processClip, reportRejectedClip, showImportSummary])

  const handleAddClips = useCallback(async (): Promise<void> => {
    try {
      const filePaths = await window.api.openFiles()
      if (filePaths.length > 0) await importClipPaths(filePaths)
    } catch (error) {
      toast.error('Could not open the file picker', {
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }, [importClipPaths])

  const handleRelinkClip = useCallback(async (clip: Clip): Promise<void> => {
    if (isRendering) return
    try {
      const filePaths = await window.api.openFiles()
      const replacementPath = filePaths[0]
      if (!replacementPath) return

      setRelinkingClipId(clip.id)
      const [metadata, thumbnail] = await Promise.all([
        window.api.getMetadata(replacementPath),
        window.api.getThumbnail(replacementPath).catch(() => undefined)
      ])
      if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) {
        throw new Error('The replacement video has no readable duration')
      }

      updateClipPath(type, clip.id, replacementPath, metadata.duration, thumbnail)
      toast.success(`${clip.name} relinked`)
    } catch (error) {
      toast.error(`Couldn't relink ${clip.name}`, {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setRelinkingClipId(null)
    }
  }, [isRendering, type, updateClipPath])

  const handlePickOverlay = useCallback(async () => {
    if (type === 'hook') return
    const filePaths = await window.api.openImages()
    if (!filePaths || filePaths.length === 0) return
    setMediaOverlay(type as 'meat' | 'cta', filePaths[0])
  }, [type, setMediaOverlay])

  const handleDragEnd = (event: DragEndEvent): void => {
    if (isRendering) return
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = clips.findIndex((clip) => clip.id === active.id)
    const newIndex = clips.findIndex((clip) => clip.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    reorderClips(type, arrayMove(clips, oldIndex, newIndex))
  }

  const handleMoveClip = (clipId: string, offset: -1 | 1): void => {
    if (isRendering) return
    const oldIndex = clips.findIndex((clip) => clip.id === clipId)
    const newIndex = oldIndex + offset
    const clip = clips[oldIndex]
    if (!clip || newIndex < 0 || newIndex >= clips.length) return

    reorderClips(type, arrayMove(clips, oldIndex, newIndex))
    setMoveAnnouncement(
      `Moved ${clip.name} to position ${newIndex + 1} of ${clips.length} in the ${label} bucket.`
    )
  }

  return (
    <Card
      className={cn('flex-1 flex flex-col min-w-0 overflow-hidden', isDragOver && 'ring-2 ring-primary bg-primary/5')}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false) }}
      onDrop={async (e) => {
        e.preventDefault(); e.stopPropagation(); setIsDragOver(false)
        if (isRendering) return
        const files = Array.from(e.dataTransfer.files)
        const videoFiles = files.filter((file) =>
          VIDEO_EXTS.some((ext) => file.name.toLowerCase().endsWith(ext))
        )
        const unsupportedFiles = files.filter((file) => !videoFiles.includes(file))
        for (const file of unsupportedFiles) {
          const message = 'Unsupported format. Convert the file to MP4, MOV, AVI, MKV, WebM, MTS, or M4V and add it again.'
          addError({ source: 'ingest', clipName: file.name, message })
          toast.error(`Couldn't add ${file.name}`, { description: message })
        }
        const videoPaths = videoFiles.map((file) => window.api.getPathForFile(file))
        if (videoPaths.length > 0) await importClipPaths(videoPaths)
      }}
    >
      {/* Silence-trimming progress is only shown when the option is enabled. */}
      {isProcessing && autoTrimSilence && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-primary/5 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin text-primary" />
          <span>Trimming silence…</span>
        </div>
      )}

      {/* Bucket Header */}
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <FileVideo className={cn('w-4 h-4', color)} />
          <h2 className="font-medium text-sm">{label}</h2>
          <Badge variant="outline" className="font-mono text-xs">{clips.length}</Badge>
        </div>
        <div className="flex items-center gap-1.5">
          {type === 'hook' && <GenerateHookTextButton clips={clips} />}
          {type !== 'hook' && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handlePickOverlay}
                    disabled={isRendering}
                    className="h-7 text-xs gap-1"
                  >
                    <Image className="w-3 h-3" />
                    {overlayButtonLabel}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Overlay a proof image on this segment</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAddClips}
            disabled={isRendering}
            className="h-7 text-xs gap-1"
          >
            <Plus className="w-3 h-3" />
            Add
          </Button>
        </div>
      </CardHeader>

      {type === 'hook' && (
        <WhisperModelControl
          compact
          disabled={isRendering || hookTextProgress !== null}
          className="px-4 py-2 border-b border-border bg-secondary/20"
        />
      )}

      {/* Media overlay thumbnail */}
      {type !== 'hook' && overlayPath && (
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-1.5 border-b border-border bg-secondary/30',
            overlayMissing && 'bg-destructive/5'
          )}
        >
          {overlayMissing ? (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </div>
          ) : (
            <img
              src={`file://${overlayPath}`}
              alt="Segment overlay"
              className="w-8 h-8 rounded object-cover shrink-0"
            />
          )}
          <span className={cn('text-xs truncate flex-1', overlayMissing ? 'text-destructive' : 'text-muted-foreground')}>
            {overlayPath.split(/[/\\]/).pop()}
          </span>
          {overlayMissing && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={handlePickOverlay}
              disabled={isRendering}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Relink
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => setMediaOverlay(type, null)}
            disabled={isRendering}
            aria-label="Remove image overlay"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {/* Hook text generation progress */}
      {type === 'hook' && hookTextProgress && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-primary/5 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin text-primary" />
          <span>
            {hookTextProgress.stage === 'loading-model' && 'Loading Whisper model…'}
            {hookTextProgress.stage === 'transcribing' && `Transcribing ${hookTextProgress.currentClip}…`}
            {hookTextProgress.stage === 'generating' && `Generating text for ${hookTextProgress.currentClip}…`}
          </span>
          <span className="font-mono">
            {hookTextProgress.stage === 'loading-model'
              ? `${loadProgress}%`
              : `${hookTextProgress.completedClips}/${hookTextProgress.totalClips}`}
          </span>
        </div>
      )}

      {/* Clips List */}
      <CardContent className="flex-1 p-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-2 space-y-2">
            <output className="sr-only" aria-live="polite" aria-atomic="true">
              {moveAnnouncement}
            </output>
            {clips.length === 0 ? (
              <AnimatePresence mode="popLayout">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3 py-12"
                >
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 0.3 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                  >
                    <FileVideo className="w-10 h-10" />
                  </motion.div>
                  <BlurText
                    text={`Drop ${label.toLowerCase()} here or click Add`}
                    className="text-xs"
                  />
                </motion.div>
              </AnimatePresence>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
                modifiers={[restrictToVerticalAxis]}
                accessibility={accessibility}
              >
                <SortableContext items={clips.map((clip) => clip.id)} strategy={verticalListSortingStrategy}>
                  <AnimatePresence mode="popLayout">
                    {clips.map((clip, index) => (
                      <motion.div
                        key={clip.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                      >
                        <SortableClip
                          id={clip.id}
                          clipName={clip.name}
                          bucketLabel={label}
                          canMoveUp={index > 0}
                          canMoveDown={index < clips.length - 1}
                          onMoveUp={() => handleMoveClip(clip.id, -1)}
                          onMoveDown={() => handleMoveClip(clip.id, 1)}
                          disabled={isRendering}
                        >
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                          <div
                            className={cn(
                              'group flex flex-col gap-1.5 p-2.5 rounded-md bg-secondary/50 hover:bg-secondary transition-colors',
                              clip.missing && 'ring-1 ring-destructive/60 bg-destructive/5'
                            )}
                            onDoubleClick={() => {
                              if (!isRendering && !clip.missing) setEditingClipId(clip.id)
                            }}
                          >
                            <div className="flex items-center gap-2">
                              {clip.missing && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="shrink-0">
                                        <AlertTriangle className="w-4 h-4 text-destructive" />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      Source file missing — relink or remove before rendering
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              {clip.thumbnail ? (
                                <img
                                  src={clip.thumbnail}
                                  alt=""
                                  className="w-16 h-9 rounded object-cover shrink-0"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                />
                              ) : (
                                <FileVideo className={cn('w-8 h-8 shrink-0', color)} />
                              )}
                              <span className="text-xs font-medium truncate flex-1 mr-2">{clip.name}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  {clip.duration > 0 ? `${clip.duration.toFixed(1)}s` : '---'}
                                </span>
                                {clip.missing ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1 px-2 text-[10px] text-destructive"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      void handleRelinkClip(clip)
                                    }}
                                    disabled={isRendering || relinkingClipId === clip.id}
                                  >
                                    {relinkingClipId === clip.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <FolderOpen className="h-3 w-3" />
                                    )}
                                    Relink
                                  </Button>
                                ) : (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                                          onClick={() => setEditingClipId(clip.id)}
                                          disabled={isRendering}
                                        >
                                          <Pencil className="w-3.5 h-3.5" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>Edit clip</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                                        onClick={() => removeClip(type, clip.id)}
                                        disabled={isRendering}
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Remove clip</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                            </div>

                            {/* Text overlay input for hooks */}
                            {type === 'hook' && (
                              <div className="flex items-center gap-1.5">
                                <Type className="w-3 h-3 text-muted-foreground shrink-0" />
                                <Input
                                  type="text"
                                  placeholder="On-screen text (optional)"
                                  value={hookTexts[clip.id] || ''}
                                  onChange={(e) => setHookText(clip.id, e.target.value)}
                                  disabled={isRendering}
                                  className="h-7 flex-1 text-xs px-2 py-1"
                                />
                              </div>
                            )}
                          </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              {clip.missing && (
                                <ContextMenuItem
                                  onSelect={() => { void handleRelinkClip(clip) }}
                                  disabled={isRendering || relinkingClipId === clip.id}
                                >
                                  <FolderOpen className="w-3.5 h-3.5 mr-2" /> Relink missing clip
                                </ContextMenuItem>
                              )}
                              <ContextMenuItem
                                onSelect={() => setEditingClipId(clip.id)}
                                disabled={isRendering || clip.missing}
                              >
                                <Pencil className="w-3.5 h-3.5 mr-2" /> Edit clip
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() => { void window.api.showItemInFolder(clip.path) }}
                                disabled={clip.missing}
                              >
                                <FileVideo className="w-3.5 h-3.5 mr-2" /> Reveal in folder
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                onSelect={() => removeClip(type, clip.id)}
                                disabled={isRendering}
                                className="text-destructive focus:text-destructive"
                              >
                                <X className="w-3.5 h-3.5 mr-2" /> Remove
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        </SortableClip>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      {/* Clip Editor Dialog */}
      {editingClipId && (
        <ClipEditor
          open={!!editingClipId}
          onOpenChange={(open) => { if (!open) setEditingClipId(null) }}
          clipId={editingClipId}
          bucket={type}
        />
      )}
    </Card>
  )
}
