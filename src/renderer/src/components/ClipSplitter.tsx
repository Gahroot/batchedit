import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Scissors,
  Upload,
  Loader2,
  Plus,
  Trash2,
  Play,
  FolderOpen,
  ArrowRight,
  CheckCircle,
  Bug
} from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import { useWhisper, WhisperChunk } from '@/hooks/useWhisper'
import { detectMarkers, DetectedMarker } from '@/lib/marker-detection'
import { useStore, BucketType } from '../store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
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

type Step = 'upload' | 'transcribing' | 'review' | 'splitting' | 'done'

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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
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

  const videoRef = useRef<HTMLVideoElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const { loadModel, transcribe, isModelLoading, isModelReady, loadProgress } = useWhisper()
  const addClips = useStore((s) => s.addClips)

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
    }
  }, [open])

  const handleFile = useCallback(async (filePath: string) => {
    try {
      setVideoPath(filePath)
      const meta = await window.api.getMetadata(filePath)
      setVideoDuration(meta.duration)
      setStep('transcribing')
      await runTranscription(filePath, meta.duration)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const runTranscription = async (path: string, duration: number) => {
    try {
      if (!isModelReady) {
        await loadModel()
      }
      const wavPath = await window.api.extractAudio(path)
      const audioBuffer = await window.api.readAudioBuffer(wavPath)
      const audioData = new Float32Array(audioBuffer)
      const chunks = await transcribe(audioData)
      setWordChunks(chunks)

      const detected = detectMarkers(chunks, duration)
      setMarkers(detected)
      setStep('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep('upload')
    }
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file) {
        const filePath = window.api.getPathForFile(file)
        handleFile(filePath)
      }
    },
    [handleFile]
  )

  const handleBrowse = useCallback(async () => {
    const paths = await window.api.openFiles()
    if (paths.length > 0) {
      handleFile(paths[0])
    }
  }, [handleFile])

  const seekVideo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time
    }
  }, [])

  const updateMarker = useCallback((id: string, updates: Partial<DetectedMarker>) => {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)))
  }, [])

  const removeMarker = useCallback((id: string) => {
    setMarkers((prev) => {
      const filtered = prev.filter((m) => m.id !== id)
      // Recalculate end times
      for (let i = 0; i < filtered.length; i++) {
        if (i + 1 < filtered.length) {
          filtered[i].endTime = filtered[i + 1].startTime
        } else {
          filtered[i].endTime = videoDuration
        }
      }
      return filtered
    })
  }, [videoDuration])

  const addMarker = useCallback(() => {
    const currentTime = videoRef.current?.currentTime || 0
    const newMarker: DetectedMarker = {
      id: `marker-${uuidv4()}`,
      label: `Clip ${markers.length + 1}`,
      bucket: 'hook',
      startTime: currentTime,
      endTime: videoDuration,
      markerChunkIndices: []
    }

    setMarkers((prev) => {
      const updated = [...prev, newMarker].sort((a, b) => a.startTime - b.startTime)
      // Recalculate end times
      for (let i = 0; i < updated.length; i++) {
        if (i + 1 < updated.length) {
          updated[i].endTime = updated[i + 1].startTime
        } else {
          updated[i].endTime = videoDuration
        }
      }
      return updated
    })
  }, [markers.length, videoDuration])

  const handleSaveToDisk = useCallback(async () => {
    if (!videoPath || markers.length === 0) return
    const dir = await window.api.openDirectory()
    if (!dir) return

    setStep('splitting')
    setSplitProgress(0)

    try {
      const segments = markers.map((m) => ({
        label: m.label,
        bucket: m.bucket,
        startTime: m.startTime,
        endTime: m.endTime
      }))
      const results = await window.api.splitVideo(videoPath, segments, dir)
      setSplitResults(results)
      setStep('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep('review')
    }
  }, [videoPath, markers])

  const handlePushToBuckets = useCallback(async () => {
    if (!videoPath || markers.length === 0) return

    setStep('splitting')
    setSplitProgress(0)

    try {
      const segments = markers.map((m) => ({
        label: m.label,
        bucket: m.bucket,
        startTime: m.startTime,
        endTime: m.endTime
      }))
      const results = await window.api.splitVideo(videoPath, segments, null)
      setSplitResults(results)

      // Add clips to buckets
      const bucketClips: Record<BucketType, Array<{ id: string; path: string; name: string; duration: number; thumbnail?: string }>> = {
        hook: [],
        meat: [],
        cta: []
      }

      for (const result of results) {
        const meta = await window.api.getMetadata(result.outputPath)
        let thumbnail: string | undefined
        try {
          thumbnail = await window.api.getThumbnail(result.outputPath)
        } catch {}
        bucketClips[result.bucket as BucketType].push({
          id: uuidv4(),
          path: result.outputPath,
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

      setStep('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep('review')
    }
  }, [videoPath, markers, addClips])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
          <div
            ref={dropRef}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="flex flex-col items-center justify-center gap-4 border-2 border-dashed border-border rounded-lg p-12 cursor-pointer hover:border-primary/50 transition-colors"
            onClick={handleBrowse}
          >
            <Upload className="w-12 h-12 text-muted-foreground" />
            <div className="text-center">
              <p className="text-sm font-medium">Drop a video file here</p>
              <p className="text-xs text-muted-foreground mt-1">
                or click to browse. Record all hooks/meats/CTAs in one take with spoken markers like
                &quot;hook one&quot;, &quot;meat two&quot;.
              </p>
            </div>
          </div>
        )}

        {/* Transcribing Step */}
        {step === 'transcribing' && (
          <div className="flex flex-col items-center justify-center gap-4 py-12">
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
              className="w-full max-h-48 rounded-md bg-black object-contain"
            />

            {/* Segment Timeline */}
            {markers.length > 0 && (
              <div className="flex h-6 rounded-md overflow-hidden gap-px">
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

            {/* Markers List */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                Segments ({markers.length})
              </span>
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={addMarker}>
                <Plus className="w-3 h-3" />
                Add
              </Button>
            </div>

            {markers.length === 0 && (
              <div className="text-center py-6 text-sm text-muted-foreground">
                No markers detected. Add segments manually using the &quot;Add&quot; button above.
              </div>
            )}

            <ScrollArea className="max-h-40 min-h-0">
              <div className="space-y-1.5 pr-3">
                {markers.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 text-xs">
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

                    {/* Time display */}
                    <span className="font-mono text-muted-foreground whitespace-nowrap">
                      {formatTime(m.startTime)}–{formatTime(m.endTime)}
                    </span>

                    {/* Adjust start -0.1s */}
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

                    {/* Adjust start +0.1s */}
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
            </ScrollArea>

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
                onClick={handleSaveToDisk}
                disabled={markers.length === 0}
                className="gap-1.5"
              >
                <FolderOpen className="w-4 h-4" />
                Save to Disk
              </Button>
              <Button
                onClick={handlePushToBuckets}
                disabled={markers.length === 0}
                className="gap-1.5"
              >
                <ArrowRight className="w-4 h-4" />
                Push to Buckets
              </Button>
            </div>
          </div>
        )}

        {/* Splitting Step */}
        {step === 'splitting' && (
          <div className="flex flex-col items-center justify-center gap-4 py-12">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <div className="text-center">
              <p className="text-sm font-medium">Splitting video...</p>
              <Progress value={splitProgress} className="w-64 mt-3" />
            </div>
          </div>
        )}

        {/* Done Step */}
        {step === 'done' && (
          <div className="flex flex-col items-center justify-center gap-4 py-12">
            <CheckCircle className="w-12 h-12 text-green-500" />
            <div className="text-center">
              <p className="text-sm font-medium">
                Split into {splitResults.length} clips
              </p>
              <div className="mt-3 space-y-1">
                {splitResults.map((r, i) => (
                  <div key={i} className="text-xs text-muted-foreground">
                    <span className={BUCKET_COLORS_TEXT[r.bucket as BucketType]}>{r.label}</span>
                    {' → '}
                    {r.bucket}
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
