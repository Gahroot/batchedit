import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Scissors,
  Upload,
  Loader2,
  Trash2,
  Play,
  FolderOpen,
  ArrowRight,
  CheckCircle,
  Bug,
  MapPin,
  X,
  ShieldCheck,
  AlertTriangle,
  Wrench,
  Check,
  ChevronsRightLeft,
  ChevronsLeftRight,
  Square
} from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import { useWhisper, WhisperChunk } from '@/hooks/useWhisper'
import { isWhisperCancellationError, WhisperCancellationError } from '@/hooks/whisper-client'
import { detectMarkers, DetectedMarker } from '../../../shared/marker-detection'
import { useStore, BucketType, Clip, ClipQaResult, WordChunk } from '../store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { WhisperModelControl } from './WhisperModelControl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Stepper } from '@/components/ui/stepper'
import { Switch } from '@/components/ui/switch'

type Step = 'upload' | 'transcribing' | 'review' | 'splitting' | 'qa' | 'done'

const STEP_LABELS = ['Upload', 'Transcribe', 'Review', 'Split', 'QA', 'Done']
const STEP_INDEX: Record<Step, number> = {
  upload: 0,
  transcribing: 1,
  review: 2,
  splitting: 3,
  qa: 4,
  done: 5
}

const BUCKET_COLORS: Record<BucketType, string> = {
  hook: 'bg-blue-500',
  meat: 'bg-green-500',
  cta: 'bg-orange-500'
}

const BUCKET_COLORS_TEXT: Record<BucketType, string> = {
  hook: 'text-blue-400',
  meat: 'text-green-400',
  cta: 'text-orange-400'
}

const BUCKET_COLORS_BG_LIGHT: Record<BucketType, string> = {
  hook: 'bg-blue-500/20',
  meat: 'bg-green-500/20',
  cta: 'bg-orange-500/20'
}

const NUDGE_MS = 100

function qaStatusMeta(status: ClipQaResult['status']): {
  label: string
  className: string
  Icon: typeof ShieldCheck
} {
  if (status === 'clean') {
    return { label: 'Clean', className: 'text-emerald-600', Icon: ShieldCheck }
  }
  if (status === 'auto_fixed') {
    return { label: 'Auto-fixed', className: 'text-amber-600', Icon: Wrench }
  }
  return { label: 'Needs review', className: 'text-destructive', Icon: AlertTriangle }
}

function qaLeakSummary(clip: ClipQaResult): string | null {
  const parts: string[] = []
  if (clip.leadingLeak) parts.push(`start: heard "${clip.leadingLeak.marker}"`)
  if (clip.trailingLeak) parts.push(`end: heard "${clip.trailingLeak.marker}"`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function QaRowInline({
  clip,
  approved,
  onNudge,
  onApprove
}: {
  clip: ClipQaResult
  approved: boolean
  onNudge: (clip: ClipQaResult, startDeltaMs: number, endDeltaMs: number) => Promise<void>
  onApprove: (clip: ClipQaResult) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { label, className, Icon } = qaStatusMeta(clip.status)
  const leak = qaLeakSummary(clip)
  const flagged = clip.status === 'flagged' && !approved

  const handleNudge = async (startDeltaMs: number, endDeltaMs: number): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onNudge(clip, startDeltaMs, endDeltaMs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border bg-background p-2 text-xs">
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} />
        <span className="min-w-0 flex-1 truncate font-medium">{clip.label}</span>
        <Badge variant={flagged ? 'destructive' : 'secondary'} className="shrink-0 text-[10px]">
          {approved ? 'Approved' : label}
        </Badge>
      </div>
      {leak ? <p className="mt-1 break-words text-[11px] text-muted-foreground">{leak}</p> : null}
      {clip.recutCount > 0 ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          recut ×{clip.recutCount} · {Math.round(clip.confidence * 100)}% confidence
        </p>
      ) : null}
      {error ? <p className="mt-1 text-[10px] text-destructive">{error}</p> : null}
      {flagged ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            disabled={busy}
            onClick={() => handleNudge(NUDGE_MS, 0)}
            title="Trim 100ms off the start"
          >
            <ChevronsRightLeft className="mr-1 h-3 w-3" />
            Start +100
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            disabled={busy}
            onClick={() => handleNudge(0, -NUDGE_MS)}
            title="Trim 100ms off the end"
          >
            <ChevronsLeftRight className="mr-1 h-3 w-3" />
            End −100
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            disabled={busy}
            onClick={() => onApprove(clip)}
            title="Accept this clip as-is"
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
            Approve
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

function parseTimeInput(value: string): number | null {
  // Accept MM:SS.s or just seconds
  const mmss = value.match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (mmss) return parseInt(mmss[1]) * 60 + parseFloat(mmss[2])
  const secs = parseFloat(value)
  return isNaN(secs) ? null : secs
}

function EditableTime({
  value,
  onChange,
  min,
  max
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  if (!editing) {
    return (
      <button
        className="font-mono text-muted-foreground hover:text-foreground hover:underline cursor-text"
        onClick={() => {
          setText(formatTime(value))
          setEditing(true)
        }}
      >
        {formatTime(value)}
      </button>
    )
  }

  return (
    <input
      autoFocus
      className="font-mono w-16 text-xs bg-transparent border-b border-primary outline-none text-center"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const parsed = parseTimeInput(text)
        if (parsed !== null) {
          onChange(Math.max(min, Math.min(max, parsed)))
        }
        setEditing(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

export function ClipSplitter() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('upload')
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const [videoDuration, setVideoDuration] = useState(0)
  const [wordChunks, setWordChunks] = useState<WhisperChunk[]>([])
  const [markers, setMarkers] = useState<DetectedMarker[]>([])
  const [splitResults, setSplitResults] = useState<Array<{ label: string; bucket: string; outputPath: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [splitProgress, setSplitProgress] = useState(0)
  const [showRawChunks, setShowRawChunks] = useState(false)
  const [markInTime, setMarkInTime] = useState<number | null>(null)
  const [qaResults, setQaResults] = useState<ClipQaResult[]>([])
  const [approvedClips, setApprovedClips] = useState<Set<string>>(new Set())
  const [qaBusy, setQaBusy] = useState(false)
  const [splitAction, setSplitAction] = useState<'save' | 'push' | null>(null)
  // On the save path, also add the resulting clips to their buckets (default on so it "just works").
  const [alsoAddToBuckets, setAlsoAddToBuckets] = useState(true)
  // Reflects whether clips were actually added to buckets, shown on the done screen.
  const [addedToBuckets, setAddedToBuckets] = useState(false)
  // When true, the pending push/save included clips still flagged for review.
  const [includedFlagged, setIncludedFlagged] = useState(false)
  // When true, the skip-confirmation panel is shown before clips are dropped.
  const [confirmingPush, setConfirmingPush] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const transcriptionRunId = useRef(0)

  const { loadModel, transcribe, cancel, isModelLoading, loadProgress } = useWhisper()
  const addClips = useStore((s) => s.addClips)
  const whisperModel = useStore((s) => s.whisperModel)
  const whisperDevice = useStore((s) => s.whisperDevice)

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setStep('upload')
      setVideoPath(null)
      setVideoDuration(0)
      setWordChunks([])
      setMarkers([])
      setSplitResults([])
      setError(null)
      setSplitProgress(0)
      setShowRawChunks(false)
      setMarkInTime(null)
      setQaResults([])
      setApprovedClips(new Set())
      setQaBusy(false)
      setSplitAction(null)
      setAlsoAddToBuckets(true)
      setAddedToBuckets(false)
      setIncludedFlagged(false)
      setConfirmingPush(false)
    }
  }, [open])

  const runTranscription = useCallback(
    async (path: string, duration: number, runId: number): Promise<{
      chunks: WhisperChunk[]
      detectedMarkers: DetectedMarker[]
    }> => {
      let wavPath: string | null = null
      const assertCurrentRun = (): void => {
        if (transcriptionRunId.current !== runId) throw new WhisperCancellationError()
      }

      try {
        await loadModel(whisperModel)
        assertCurrentRun()
        wavPath = await window.api.extractAudio(path)
        assertCurrentRun()
        const audioBuffer = await window.api.readAudioBuffer(wavPath)
        wavPath = null
        assertCurrentRun()
        const audioData = new Float32Array(audioBuffer)
        const { chunks, speechIntervals } = await transcribe(audioData, whisperModel)
        assertCurrentRun()
        return {
          chunks,
          detectedMarkers: detectMarkers(chunks, duration, speechIntervals)
        }
      } finally {
        if (wavPath) await window.api.releaseTempFile(wavPath)
      }
    },
    [loadModel, transcribe, whisperModel]
  )

  const handleFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (whisperDevice === 'detecting') return

      const runId = transcriptionRunId.current + 1
      transcriptionRunId.current = runId
      setError(null)
      try {
        setVideoPath(filePath)
        const meta = await window.api.getMetadata(filePath)
        if (transcriptionRunId.current !== runId) throw new WhisperCancellationError()
        setVideoDuration(meta.duration)
        setStep('transcribing')
        const result = await runTranscription(filePath, meta.duration, runId)
        if (transcriptionRunId.current !== runId) throw new WhisperCancellationError()
        setWordChunks(result.chunks)
        setMarkers(result.detectedMarkers)
        setStep('review')
      } catch (error) {
        if (!isWhisperCancellationError(error) && transcriptionRunId.current === runId) {
          setError(error instanceof Error ? error.message : String(error))
        }
        if (transcriptionRunId.current === runId) setStep('upload')
      }
    },
    [runTranscription, whisperDevice]
  )

  const stopTranscription = useCallback((): void => {
    transcriptionRunId.current += 1
    cancel()
    setError(null)
    setStep('upload')
    setVideoPath(null)
    setVideoDuration(0)
  }, [cancel])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (!nextOpen && videoPath !== null) stopTranscription()
      setOpen(nextOpen)
    },
    [stopTranscription, videoPath]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (whisperDevice === 'detecting') return
      const file = e.dataTransfer.files[0]
      if (file) {
        const filePath = window.api.getPathForFile(file)
        handleFile(filePath)
      }
    },
    [handleFile, whisperDevice]
  )

  const handleBrowse = useCallback(async (): Promise<void> => {
    if (whisperDevice === 'detecting') return
    const paths = await window.api.openFiles()
    if (paths.length > 0) {
      handleFile(paths[0])
    }
  }, [handleFile, whisperDevice])

  const seekVideo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time
    }
  }, [])

  const updateMarker = useCallback((id: string, updates: Partial<DetectedMarker>) => {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)))
  }, [])

  const removeMarker = useCallback((id: string) => {
    setMarkers((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const handleMarkIn = useCallback(() => {
    const currentTime = videoRef.current?.currentTime || 0
    setMarkInTime(currentTime)
  }, [])

  const handleMarkOut = useCallback(() => {
    const outTime = videoRef.current?.currentTime || 0
    if (markInTime === null) return

    const startTime = Math.min(markInTime, outTime)
    const endTime = Math.max(markInTime, outTime)

    const newMarker: DetectedMarker = {
      id: `marker-${uuidv4()}`,
      label: `Clip ${markers.length + 1}`,
      bucket: 'hook',
      startTime,
      endTime,
      markerChunkIndices: []
    }

    setMarkers((prev) =>
      [...prev, newMarker].sort((a, b) => a.startTime - b.startTime)
    )
    setMarkInTime(null)
  }, [markInTime, markers.length])

  const cancelMarkIn = useCallback(() => {
    setMarkInTime(null)
  }, [])

  /** Subset wordChunks for a marker's time range, excluding marker-word indices */
  const getTranscriptForMarker = useCallback(
    (m: DetectedMarker): WordChunk[] => {
      const markerIndices = new Set(m.markerChunkIndices)
      return wordChunks
        .filter((w, i) => !markerIndices.has(i) && w.end > m.startTime && w.start < m.endTime)
        .map((w) => ({
          text: w.text,
          start: Math.max(0, w.start - m.startTime),
          end: Math.min(m.endTime - m.startTime, w.end - m.startTime)
        }))
    },
    [wordChunks]
  )

  const handleSplit = useCallback(async (action: 'save' | 'push') => {
    if (!videoPath || markers.length === 0) return

    let outputDir: string | null = null
    if (action === 'save') {
      outputDir = await window.api.openDirectory()
      if (!outputDir) return
    }

    setSplitAction(action)
    setStep('splitting')
    setSplitProgress(0)
    setError(null)

    const unsubscribeProgress = window.api.onSplitProgress(({ completed, total }) => {
      setSplitProgress(total > 0 ? Math.round((completed / total) * 100) : 0)
    })
    try {
      const segments = markers.map((m) => ({
        label: m.label,
        bucket: m.bucket,
        startTime: m.startTime,
        endTime: m.endTime
      }))
      const rawResults = await window.api.splitVideo(videoPath, segments, outputDir)

      // Trim leading silence from each split clip
      const results = await Promise.all(
        rawResults.map(async (r) => {
          try {
            const trimResult = await window.api.trimLeadingSilence(
              r.outputPath,
              outputDir ?? undefined
            )
            return { ...r, outputPath: trimResult.outputPath }
          } catch {
            return r
          }
        })
      )
      setSplitResults(results)

      // Transition to QA step
      setStep('qa')
      setQaBusy(true)

      const clipInputs = await Promise.all(
        results.map(async (r, i) => {
          const meta = await window.api.getMetadata(r.outputPath)
          return {
            label: r.label,
            bucket: r.bucket as BucketType,
            path: r.outputPath,
            sourceStart: markers[i].startTime,
            sourceEnd: markers[i].endTime,
            duration: meta.duration
          }
        })
      )

      const report = await window.api.qa.runBoundaryQA({
        sourcePath: videoPath,
        clips: clipInputs
      })
      setQaResults(report.clips)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep('review')
    } finally {
      unsubscribeProgress()
      setQaBusy(false)
    }
  }, [videoPath, markers])

  const handleNudge = useCallback(async (clip: ClipQaResult, startDeltaMs: number, endDeltaMs: number) => {
    const updated = await window.api.qa.recutClip({
      clipPath: clip.path,
      sourcePath: clip.sourcePath,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      bucket: clip.bucket,
      label: clip.label,
      startDeltaMs,
      endDeltaMs
    })
    setQaResults((prev) => prev.map((r) => (r.originalPath === clip.originalPath ? updated : r)))
    // Clear approval since the clip has changed
    setApprovedClips((prev) => {
      const next = new Set(prev)
      next.delete(clip.originalPath)
      return next
    })
  }, [])

  const handleApprove = useCallback((clip: ClipQaResult) => {
    setApprovedClips((prev) => {
      const next = new Set(prev)
      next.add(clip.originalPath)
      return next
    })
  }, [])

  // Counts clips that are flagged for review and not yet approved — these are the
  // ones that would be silently dropped from a push/save unless the user opts in.
  const skippedCount = qaResults.filter(
    (r) => r.status === 'flagged' && !approvedClips.has(r.originalPath)
  ).length
  const pushableCount = qaResults.filter(
    (r) => r.status === 'clean' || r.status === 'auto_fixed' || approvedClips.has(r.originalPath)
  ).length

  // Adds QA clips into their Hook/Meat/CTA buckets. When includeFlagged is true,
  // clips still flagged for review are added too (instead of being dropped).
  // Returns how many were added.
  const addApprovedClipsToBuckets = useCallback(async (includeFlagged: boolean): Promise<number> => {
    const approved = qaResults.filter(
      (r) =>
        includeFlagged ||
        r.status === 'clean' ||
        r.status === 'auto_fixed' ||
        approvedClips.has(r.originalPath)
    )
    if (approved.length === 0) return 0

    const bucketClips: Record<BucketType, Clip[]> = {
      hook: [],
      meat: [],
      cta: []
    }

    for (const result of approved) {
      const meta = await window.api.getMetadata(result.path)
      let thumbnail: string | undefined
      try {
        thumbnail = await window.api.getThumbnail(result.path)
      } catch {}

      bucketClips[result.bucket].push({
        id: uuidv4(),
        path: result.path,
        name: `${result.label}.mp4`,
        duration: meta.duration,
        thumbnail
      })
    }

    for (const [bucket, clips] of Object.entries(bucketClips)) {
      if (clips.length > 0) {
        addClips(bucket as BucketType, clips)
      }
    }

    return approved.length
  }, [qaResults, approvedClips, addClips])

  // Performs the actual bucket push and advances to the done screen.
  const runPush = useCallback(async (includeFlagged: boolean) => {
    const added = await addApprovedClipsToBuckets(includeFlagged)
    setAddedToBuckets(added > 0)
    setIncludedFlagged(includeFlagged)
    setConfirmingPush(false)
    setStep('done')
  }, [addApprovedClipsToBuckets])

  const handleFinalPush = useCallback(async () => {
    // Don't silently drop flagged clips — ask the user first.
    if (skippedCount > 0) {
      setConfirmingPush(true)
      return
    }
    await runPush(false)
  }, [skippedCount, runPush])

  const handleFinalSave = useCallback(async () => {
    if (alsoAddToBuckets) {
      if (skippedCount > 0) {
        setConfirmingPush(true)
        return
      }
      await runPush(false)
      return
    }
    setAddedToBuckets(false)
    setIncludedFlagged(false)
    setStep('done')
  }, [alsoAddToBuckets, skippedCount, runPush])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Scissors className="w-4 h-4" />
          Split Clip
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="w-5 h-5" />
            Clip Splitter
          </DialogTitle>
        </DialogHeader>

        <div className="px-2 pt-1 pb-3">
          <Stepper steps={STEP_LABELS} current={STEP_INDEX[step]} />
        </div>

        {error && (
          <div className="bg-destructive/10 text-destructive text-sm px-3 py-2 rounded-md">
            {error}
            <button className="ml-2 underline" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* Upload Step */}
        {step === 'upload' && (
          <div className="space-y-4">
            <WhisperModelControl className="rounded-md border border-border p-3" />
            <div
              ref={dropRef}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              className={cn(
                'flex flex-col items-center justify-center gap-4 border-2 border-dashed border-border rounded-lg p-12 transition-colors',
                whisperDevice === 'detecting'
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:border-primary/50'
              )}
              onClick={() => void handleBrowse()}
            >
              <Upload className="w-12 h-12 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium">Drop a video file here</p>
                <p className="text-xs text-muted-foreground mt-1">
                  or click to browse. Record all hooks/meats/CTAs in one take with spoken markers
                  like &quot;hook one&quot;, &quot;meat two&quot;.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Transcribing Step */}
        {step === 'transcribing' && (
          <div className="flex flex-col items-center justify-center gap-4 py-8">
            <WhisperModelControl
              disabled
              className="w-full max-w-md rounded-md border border-border p-3"
            />
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <div className="text-center">
              {isModelLoading ? (
                <>
                  <p className="text-sm font-medium">Loading Whisper model...</p>
                  <Progress value={loadProgress} className="w-64 mt-3" />
                  <p className="text-xs text-muted-foreground mt-1">{loadProgress}%</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">Transcribing audio...</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Detecting spoken markers in your video
                  </p>
                </>
              )}
            </div>
            <Button variant="destructive" size="sm" onClick={stopTranscription}>
              <Square className="w-3 h-3 fill-current" />
              Stop transcription
            </Button>
          </div>
        )}

        {/* Review Step */}
        {step === 'review' && videoPath && (
          <div className="flex flex-col gap-3 min-h-0 flex-1 overflow-hidden">
            {/* Video Player */}
            <video
              ref={videoRef}
              src={`file://${videoPath}`}
              controls
              className="w-full max-h-48 rounded-md bg-black object-contain flex-shrink-0"
            />

            {/* Segment Timeline */}
            {markers.length > 0 && (
              <div className="flex h-6 rounded-md overflow-hidden gap-px flex-shrink-0">
                {markers.map((m) => {
                  const width = videoDuration > 0
                    ? ((m.endTime - m.startTime) / videoDuration) * 100
                    : 0
                  return (
                    <button
                      key={m.id}
                      className={cn(
                        'h-full flex items-center justify-center text-[9px] font-medium text-white truncate px-1 hover:opacity-80 transition-opacity',
                        BUCKET_COLORS[m.bucket]
                      )}
                      style={{ width: `${width}%` }}
                      onClick={() => seekVideo(m.startTime)}
                      title={`${m.label}: ${formatTime(m.startTime)} - ${formatTime(m.endTime)}`}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Scrollable content: segments + transcript + actions */}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
            {/* Markers List Header */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                Segments ({markers.length})
              </span>
              <div className="flex items-center gap-1.5">
                {markInTime !== null && (
                  <Badge variant="secondary" className="text-[10px] font-mono gap-1">
                    IN: {formatTime(markInTime)}
                  </Badge>
                )}
                {markInTime === null ? (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={handleMarkIn}>
                    <MapPin className="w-3 h-3" />
                    Mark IN
                  </Button>
                ) : (
                  <>
                    <Button variant="default" size="sm" className="h-7 gap-1 text-xs" onClick={handleMarkOut}>
                      <MapPin className="w-3 h-3" />
                      Mark OUT
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={cancelMarkIn}>
                      <X className="w-3 h-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>

            {markers.length === 0 && (
              <div className="text-center py-6 text-sm text-muted-foreground">
                No markers detected. Use Mark IN / Mark OUT to add segments manually.
              </div>
            )}

              <div className="space-y-1.5">
                {markers.map((m) => (
                  <div key={m.id} className="flex items-center gap-1.5 text-xs">
                    {/* Bucket select */}
                    <Select
                      value={m.bucket}
                      onValueChange={(v) => updateMarker(m.id, { bucket: v as BucketType })}
                    >
                      <SelectTrigger className="h-7 w-24 text-xs px-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="hook">Hook</SelectItem>
                        <SelectItem value="meat">Meat</SelectItem>
                        <SelectItem value="cta">CTA</SelectItem>
                      </SelectContent>
                    </Select>

                    {/* Label */}
                    <Input
                      value={m.label}
                      onChange={(e) => updateMarker(m.id, { label: e.target.value })}
                      className="h-7 text-xs flex-1 min-w-0"
                    />

                    {/* Start time controls: S << time >> */}
                    <span className="text-[10px] text-muted-foreground">S</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-xs"
                      title="Start -0.1s"
                      onClick={() =>
                        updateMarker(m.id, { startTime: Math.max(0, m.startTime - 0.1) })
                      }
                    >
                      &laquo;
                    </Button>
                    <EditableTime
                      value={m.startTime}
                      onChange={(v) => updateMarker(m.id, { startTime: v })}
                      min={0}
                      max={m.endTime - 0.1}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-xs"
                      title="Start +0.1s"
                      onClick={() =>
                        updateMarker(m.id, {
                          startTime: Math.min(m.endTime - 0.1, m.startTime + 0.1)
                        })
                      }
                    >
                      &raquo;
                    </Button>

                    {/* End time controls: E << time >> */}
                    <span className="text-[10px] text-muted-foreground">E</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-xs"
                      title="End -0.1s"
                      onClick={() =>
                        updateMarker(m.id, {
                          endTime: Math.max(m.startTime + 0.1, m.endTime - 0.1)
                        })
                      }
                    >
                      &laquo;
                    </Button>
                    <EditableTime
                      value={m.endTime}
                      onChange={(v) => updateMarker(m.id, { endTime: v })}
                      min={m.startTime + 0.1}
                      max={videoDuration}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-xs"
                      title="End +0.1s"
                      onClick={() =>
                        updateMarker(m.id, {
                          endTime: Math.min(videoDuration, m.endTime + 0.1)
                        })
                      }
                    >
                      &raquo;
                    </Button>

                    {/* Play segment */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => seekVideo(m.startTime)}
                    >
                      <Play className="w-3 h-3" />
                    </Button>

                    {/* Delete */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                      onClick={() => removeMarker(m.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>

            {/* Transcript */}
            {wordChunks.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium">Transcript</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn('h-6 gap-1 text-[10px]', showRawChunks && 'text-primary')}
                    onClick={() => setShowRawChunks((v) => !v)}
                  >
                    <Bug className="w-3 h-3" />
                    Raw Chunks
                  </Button>
                </div>

                {showRawChunks ? (
                  <ScrollArea className="h-32 rounded-md border border-border p-2">
                    <table className="w-full text-[10px] font-mono">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border">
                          <th className="text-left pr-2 pb-1">#</th>
                          <th className="text-left pr-2 pb-1">Text</th>
                          <th className="text-left pr-2 pb-1">Start</th>
                          <th className="text-left pb-1">End</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wordChunks.map((chunk, idx) => {
                          const markerMatch = markers.find((m) =>
                            m.markerChunkIndices.includes(idx)
                          )
                          return (
                            <tr
                              key={idx}
                              onClick={() => seekVideo(chunk.start)}
                              className={cn(
                                'cursor-pointer hover:bg-muted/50',
                                markerMatch && cn(BUCKET_COLORS_BG_LIGHT[markerMatch.bucket], BUCKET_COLORS_TEXT[markerMatch.bucket])
                              )}
                            >
                              <td className="pr-2 text-muted-foreground">{idx}</td>
                              <td className="pr-2 font-semibold">{JSON.stringify(chunk.text)}</td>
                              <td className="pr-2">{chunk.start.toFixed(2)}s</td>
                              <td>{chunk.end.toFixed(2)}s</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </ScrollArea>
                ) : (
                  <ScrollArea className="h-20 rounded-md border border-border p-2">
                    <div className="flex flex-wrap gap-0.5">
                      {wordChunks.map((chunk, idx) => {
                        const markerMatch = markers.find((m) =>
                          m.markerChunkIndices.includes(idx)
                        )
                        return (
                          <span
                            key={idx}
                            onClick={() => seekVideo(chunk.start)}
                            className={cn(
                              'text-xs cursor-pointer hover:underline rounded px-0.5',
                              markerMatch
                                ? cn('font-bold', BUCKET_COLORS_BG_LIGHT[markerMatch.bucket], BUCKET_COLORS_TEXT[markerMatch.bucket])
                                : 'text-muted-foreground'
                            )}
                          >
                            {chunk.text}
                          </span>
                        )
                      })}
                    </div>
                  </ScrollArea>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => handleSplit('save')}
                disabled={markers.length === 0}
                className="gap-1.5"
              >
                <FolderOpen className="w-4 h-4" />
                Save to Disk
              </Button>
              <Button
                onClick={() => handleSplit('push')}
                disabled={markers.length === 0}
                className="gap-1.5"
              >
                <ArrowRight className="w-4 h-4" />
                Push to Buckets
              </Button>
            </div>
            </div>
          </div>
        )}

        {/* Splitting Step */}
        {step === 'splitting' && (
          <div className="flex flex-col items-center justify-center gap-4 py-12">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <div className="text-center">
              <p className="text-sm font-medium">
                Splitting {markers.length} segment{markers.length === 1 ? '' : 's'}…
              </p>
              <Progress value={splitProgress} className="w-64 mt-3" />
              <p className="text-xs text-muted-foreground mt-1">{splitProgress}%</p>
            </div>
          </div>
        )}

        {/* QA Step */}
        {step === 'qa' && (
          <div className="flex flex-col gap-3 min-h-0 flex-1 overflow-hidden">
            {qaBusy ? (
              <div className="flex flex-col items-center justify-center gap-4 py-12">
                <Loader2 className="w-10 h-10 animate-spin text-primary" />
                <div className="text-center">
                  <p className="text-sm font-medium">Running boundary QA...</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Verifying clip edges for marker contamination
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Boundary QA Results
                  <span className="ml-auto font-normal text-muted-foreground">
                    {qaResults.filter((r) => r.status === 'flagged').length > 0
                      ? `${qaResults.filter((r) => r.status === 'flagged').length} need review`
                      : `${qaResults.filter((r) => r.status === 'auto_fixed').length} auto-fixed`}
                  </span>
                </div>

                <ScrollArea className="flex-1 min-h-0">
                  <div className="space-y-1.5 pr-2">
                    {qaResults.map((clip) => (
                      <QaRowInline
                        key={`${clip.bucket}:${clip.originalPath}`}
                        clip={clip}
                        approved={approvedClips.has(clip.originalPath)}
                        onNudge={handleNudge}
                        onApprove={handleApprove}
                      />
                    ))}
                  </div>
                </ScrollArea>

                {/* Surface dropped clips at decision time, not just on the done screen. */}
                {skippedCount > 0 && (splitAction === 'push' || alsoAddToBuckets) && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {skippedCount} clip{skippedCount === 1 ? '' : 's'} still flagged for review
                      {' '}will be skipped unless you approve {skippedCount === 1 ? 'it' : 'them'} above or
                      choose to include {skippedCount === 1 ? 'it' : 'them'}.
                    </span>
                  </div>
                )}

                {confirmingPush ? (
                  <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                    <div className="flex items-start gap-2 text-xs text-amber-600">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="font-medium">
                        {skippedCount} of {qaResults.length} clip{qaResults.length === 1 ? '' : 's'} are still
                        flagged for review. Push only the {pushableCount} ready clip
                        {pushableCount === 1 ? '' : 's'}, or include the flagged ones too?
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingPush(false)}>
                        Cancel
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => runPush(true)}
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Include flagged ({qaResults.length})
                      </Button>
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={pushableCount === 0}
                        onClick={() => runPush(false)}
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                        Skip flagged, push {pushableCount}
                      </Button>
                    </div>
                  </div>
                ) : (
                <div className="flex items-center justify-end gap-3 pt-1">
                  {splitAction === 'save' && (
                    <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                      <Switch
                        checked={alsoAddToBuckets}
                        onCheckedChange={setAlsoAddToBuckets}
                      />
                      Also add to buckets
                    </label>
                  )}
                  {splitAction === 'push' && (
                    <Button
                      onClick={handleFinalPush}
                      disabled={pushableCount === 0 && skippedCount === 0}
                      className="gap-1.5"
                    >
                      <ArrowRight className="w-4 h-4" />
                      Push to Buckets
                    </Button>
                  )}
                  {splitAction === 'save' && (
                    <Button onClick={handleFinalSave} className="gap-1.5">
                      <CheckCircle className="w-4 h-4" />
                      Done
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    Close
                  </Button>
                </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Done Step */}
        {step === 'done' && (
          <div className="flex flex-col items-center justify-center gap-4 py-12">
            <CheckCircle className="w-12 h-12 text-green-500" />
            <div className="text-center">
              <p className="text-sm font-medium">
                {splitAction === 'save'
                  ? `Saved ${splitResults.length} clips to disk`
                  : `Pushed ${includedFlagged ? qaResults.length : pushableCount} clips to buckets`}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {addedToBuckets
                  ? splitAction === 'save'
                    ? 'Also added to your Hook/Meat/CTA buckets — ready to use without re-importing.'
                    : 'Added to your Hook/Meat/CTA buckets — ready to use without re-importing.'
                  : splitAction === 'save'
                    ? 'Files written to disk only — not added to buckets. Import them to use in the app.'
                    : 'No clips were added to buckets.'}
              </p>
              <div className="mt-3 space-y-1">
                {qaResults.map((r, i) => (
                  <div key={i} className="text-xs text-muted-foreground">
                    <span className={BUCKET_COLORS_TEXT[r.bucket]}>{r.label}</span>
                    {' \u2192 '}
                    {r.bucket}
                    {r.status === 'flagged' && !approvedClips.has(r.originalPath)
                      ? includedFlagged && addedToBuckets
                        ? ' (flagged — review)'
                        : ' (skipped)'
                      : ''}
                  </div>
                ))}
              </div>
            </div>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
