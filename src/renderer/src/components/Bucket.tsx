import { useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, X, Type, FileVideo, Sparkles, Loader2, Image, Pencil, AlertTriangle } from 'lucide-react'
import { useStore, BucketType, Clip } from '../store'
import { useWhisper } from '../hooks/useWhisper'
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
import { DndContext, closestCenter, DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableClip } from './SortableClip'
import { ClipEditor } from './ClipEditor'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { BlurText } from '@/components/ui/blur-text'
import { toast } from 'sonner'
import { getAgentModel } from '../agent-models'

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts', '.m4v']

function GenerateHookTextButton({ clips }: { clips: Clip[] }) {
  const geminiApiKey = useStore((s) => s.geminiApiKey)
  const agentModelId = useStore((s) => s.agentModelId)
  const hookTexts = useStore((s) => s.hookTexts)
  const setHookText = useStore((s) => s.setHookText)
  const setHookTextProgress = useStore((s) => s.setHookTextProgress)
  const addError = useStore((s) => s.addError)
  const isRendering = useStore((s) => s.isRendering)
  const hookTextProgress = useStore((s) => s.hookTextProgress)
  const { loadModel, transcribe } = useWhisper()
  const [isGenerating, setIsGenerating] = useState(false)

  const handleGenerate = async () => {
    if (!geminiApiKey) {
      const usesXiaomi = getAgentModel(agentModelId).keyKind === 'xiaomi'
      const message = usesXiaomi
        ? 'Hook text needs a Gemini API key (not Xiaomi). Switch the model to Gemini and add your Gemini API key in the top settings bar.'
        : 'Add your Gemini API key in the top settings bar to generate hook text.'
      toast.error(message)
      addError({ source: 'hooktext', clipName: 'Setup', message })
      return
    }

    const emptyClips = clips.filter((c) => !hookTexts[c.id]?.trim())
    if (emptyClips.length === 0) return

    setIsGenerating(true)
    const total = emptyClips.length

    try {
      // Load Whisper model
      setHookTextProgress({ stage: 'loading-model', currentClip: '', completedClips: 0, totalClips: total })
      await loadModel()

      for (let i = 0; i < emptyClips.length; i++) {
        const clip = emptyClips[i]

        let wavPath: string | null = null
        try {
          // Transcribe
          setHookTextProgress({ stage: 'transcribing', currentClip: clip.name, completedClips: i, totalClips: total })
          wavPath = await window.api.extractAudio(clip.path)
          const audioBuffer = await window.api.readAudioBuffer(wavPath)
          wavPath = null
          const float32 = new Float32Array(audioBuffer)
          const { chunks } = await transcribe(float32)
          const transcript = chunks.map((c) => c.text).join(' ').trim()

          if (!transcript) {
            addError({ source: 'hooktext', clipName: clip.name, message: 'Empty transcript — skipping' })
            toast.error(`${clip.name}: empty transcript — skipping`)
            continue
          }

          // Generate hook text via Gemini
          setHookTextProgress({ stage: 'generating', currentClip: clip.name, completedClips: i, totalClips: total })
          const hookText = await window.api.generateHookText(geminiApiKey, transcript)
          setHookText(clip.id, hookText)
        } catch (err) {
          if (wavPath) await window.api.releaseTempFile(wavPath)
          const message = err instanceof Error ? err.message : String(err)
          addError({ source: 'hooktext', clipName: clip.name, message })
          toast.error(`Hook text failed for ${clip.name}`, { description: message })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      addError({ source: 'hooktext', clipName: 'Whisper', message })
      toast.error('Hook text generation failed', { description: message })
    } finally {
      setHookTextProgress(null)
      setIsGenerating(false)
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleGenerate}
            disabled={isRendering || isGenerating || clips.length === 0}
            className="h-7 text-xs gap-1"
          >
            {isGenerating || hookTextProgress ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            Generate
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
  const setMediaOverlay = useStore((s) => s.setMediaOverlay)
  const autoTrimSilence = useStore((s) => s.autoTrimSilence)
  const addError = useStore((s) => s.addError)
  const { loadProgress } = useWhisper()
  const [isDragOver, setIsDragOver] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [editingClipId, setEditingClipId] = useState<string | null>(null)

  const processClip = useCallback(async (path: string): Promise<Clip> => {
    let finalPath = path
    if (autoTrimSilence) {
      try {
        const result = await window.api.trimLeadingSilence(path)
        finalPath = result.outputPath
      } catch {
        // Fall back to untrimmed
      }
    }
    const name = finalPath.split(/[/\\]/).pop() || path.split(/[/\\]/).pop() || 'Unknown'
    const [meta, thumbnail] = await Promise.all([
      window.api.getMetadata(finalPath).catch(() => ({ duration: 0 })),
      window.api.getThumbnail(finalPath).catch(() => undefined)
    ])
    if (!meta.duration || meta.duration <= 0) {
      const message = `Couldn't read ${name} — file may be unsupported or corrupt`
      addError({ source: 'ingest', clipName: name, message })
      toast.error(message)
    }
    return { id: uuidv4(), path: finalPath, name, duration: meta.duration, thumbnail }
  }, [autoTrimSilence, addError])

  const handleAddClips = useCallback(async () => {
    const filePaths = await window.api.openFiles()
    if (!filePaths || filePaths.length === 0) return

    setIsProcessing(true)
    try {
      const newClips = await Promise.all(filePaths.map(processClip))
      addClips(type, newClips)
    } catch (err) {
      toast.error('Failed to add clips', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setIsProcessing(false)
    }
  }, [type, addClips, processClip])

  const handlePickOverlay = useCallback(async () => {
    if (type === 'hook') return
    const filePaths = await window.api.openImages()
    if (!filePaths || filePaths.length === 0) return
    setMediaOverlay(type as 'meat' | 'cta', filePaths[0])
  }, [type, setMediaOverlay])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = clips.findIndex((c) => c.id === active.id)
    const newIndex = clips.findIndex((c) => c.id === over.id)
    const reordered = arrayMove(clips, oldIndex, newIndex)
    reorderClips(type, reordered)
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
        const videoFiles = files.filter((f) =>
          VIDEO_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext))
        )
        const skipped = files.length - videoFiles.length
        if (skipped > 0) {
          toast.warning(`${skipped} file${skipped === 1 ? '' : 's'} skipped (unsupported format)`)
        }
        const videoPaths = videoFiles.map((f) => window.api.getPathForFile(f))
        if (videoPaths.length === 0) return
        setIsProcessing(true)
        try {
          const newClips = await Promise.all(videoPaths.map(processClip))
          addClips(type, newClips)
        } catch (err) {
          toast.error('Failed to add clips', {
            description: err instanceof Error ? err.message : String(err)
          })
        } finally {
          setIsProcessing(false)
        }
      }}
    >
      {/* Processing spinner overlay */}
      {isProcessing && (
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
                    {mediaOverlays[type as 'meat' | 'cta'] ? 'Replace' : 'Image'}
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

      {/* Media overlay thumbnail */}
      {type !== 'hook' && mediaOverlays[type as 'meat' | 'cta'] && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-secondary/30">
          <img
            src={`file://${mediaOverlays[type as 'meat' | 'cta']}`}
            alt="overlay"
            className="w-8 h-8 rounded object-cover shrink-0"
          />
          <span className="text-xs text-muted-foreground truncate flex-1">
            {mediaOverlays[type as 'meat' | 'cta']!.split(/[/\\]/).pop()}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => setMediaOverlay(type as 'meat' | 'cta', null)}
            disabled={isRendering}
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
              <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis]}>
                <SortableContext items={clips.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  <AnimatePresence mode="popLayout">
                    {clips.map((clip) => (
                      <motion.div
                        key={clip.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                      >
                        <SortableClip id={clip.id} disabled={isRendering}>
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                          <div
                            className={cn(
                              'group flex flex-col gap-1.5 p-2.5 rounded-md bg-secondary/50 hover:bg-secondary transition-colors',
                              clip.missing && 'ring-1 ring-destructive/60 bg-destructive/5'
                            )}
                            onDoubleClick={() => { if (!isRendering) setEditingClipId(clip.id) }}
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
                              <ContextMenuItem onSelect={() => setEditingClipId(clip.id)} disabled={isRendering}>
                                <Pencil className="w-3.5 h-3.5 mr-2" /> Edit clip
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() => window.api.showItemInFolder(clip.path)}
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
