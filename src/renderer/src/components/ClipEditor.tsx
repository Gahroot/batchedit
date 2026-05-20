import { useState, useRef, useCallback, useEffect } from 'react'
import { Loader2, Play, Scissors } from 'lucide-react'
import { useWhisper } from '@/hooks/useWhisper'
import { normalize, matchBucketSingle, parseNumber } from '../../../shared/marker-detection'
import { useStore, BucketType, WordChunk } from '../store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

function isMarkerWord(text: string): boolean {
  const n = normalize(text)
  return matchBucketSingle(n) !== null || parseNumber(n) !== null
}

interface ClipEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  clipId: string
  bucket: BucketType
}

export function ClipEditor({ open, onOpenChange, clipId, bucket }: ClipEditorProps) {
  const clip = useStore((s) => {
    const arr = bucket === 'hook' ? s.hooks : bucket === 'meat' ? s.meats : s.ctas
    return arr.find((c) => c.id === clipId)
  })
  const setClipTranscript = useStore((s) => s.setClipTranscript)
  const updateClipTranscriptWord = useStore((s) => s.updateClipTranscriptWord)
  const updateClipPath = useStore((s) => s.updateClipPath)

  const videoRef = useRef<HTMLVideoElement>(null)
  const { loadModel, transcribe, isModelLoading, isModelReady, loadProgress } = useWhisper()

  const [isTranscribing, setIsTranscribing] = useState(false)
  const [trimStart, setTrimStart] = useState<number | null>(null)
  const [trimEnd, setTrimEnd] = useState<number | null>(null)
  const [editingWordIdx, setEditingWordIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null)
  const [isTrimming, setIsTrimming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const transcript = clip?.transcript

  // Transcribe on first open if no transcript
  useEffect(() => {
    if (open && clip && !clip.transcript && !isTranscribing) {
      runTranscription()
    }
  }, [open, clip?.id])

  const runTranscription = async () => {
    if (!clip) return
    setIsTranscribing(true)
    setError(null)
    let wavPath: string | null = null
    try {
      if (!isModelReady) {
        await loadModel()
      }
      wavPath = await window.api.extractAudio(clip.path)
      const audioBuffer = await window.api.readAudioBuffer(wavPath)
      wavPath = null
      const audioData = new Float32Array(audioBuffer)
      const { chunks } = await transcribe(audioData)
      const wordChunks: WordChunk[] = chunks.map((c) => ({
        text: c.text,
        start: c.start,
        end: c.end
      }))
      setClipTranscript(clipId, wordChunks)
    } catch (err) {
      if (wavPath) await window.api.releaseTempFile(wavPath)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsTranscribing(false)
    }
  }

  const seekVideo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time
    }
  }, [])

  const handleWordClick = useCallback(
    (idx: number, e: React.MouseEvent) => {
      if (!transcript) return

      if (e.shiftKey && selectionAnchor !== null) {
        // Range select: set trim start/end from selection
        const lo = Math.min(selectionAnchor, idx)
        const hi = Math.max(selectionAnchor, idx)
        setTrimStart(transcript[lo].start)
        setTrimEnd(transcript[hi].end)
      } else {
        // Single click: seek + set anchor
        seekVideo(transcript[idx].start)
        setSelectionAnchor(idx)
      }
    },
    [transcript, selectionAnchor, seekVideo]
  )

  const handleWordDoubleClick = useCallback(
    (idx: number) => {
      if (!transcript) return
      setEditingWordIdx(idx)
      setEditText(transcript[idx].text)
    },
    [transcript]
  )

  const commitWordEdit = useCallback(() => {
    if (editingWordIdx !== null && editText.trim()) {
      updateClipTranscriptWord(clipId, editingWordIdx, editText.trim())
    }
    setEditingWordIdx(null)
  }, [editingWordIdx, editText, clipId, updateClipTranscriptWord])

  const handleSetStart = useCallback(() => {
    if (!videoRef.current) return
    setTrimStart(videoRef.current.currentTime)
  }, [])

  const handleSetEnd = useCallback(() => {
    if (!videoRef.current) return
    setTrimEnd(videoRef.current.currentTime)
  }, [])

  const handleApplyTrim = useCallback(async () => {
    if (!clip || trimStart === null || trimEnd === null) return
    if (trimEnd <= trimStart) return

    setIsTrimming(true)
    setError(null)
    try {
      const newPath = await window.api.trimVideoReencode(clip.path, null, trimStart, trimEnd)
      const meta = await window.api.getMetadata(newPath)
      let thumbnail: string | undefined
      try {
        thumbnail = await window.api.getThumbnail(newPath)
      } catch {}
      updateClipPath(bucket, clipId, newPath, meta.duration, thumbnail)

      // Update transcript to match new trim
      if (transcript) {
        const trimmed: WordChunk[] = transcript
          .filter((w) => w.end > trimStart && w.start < trimEnd)
          .map((w) => ({
            text: w.text,
            start: Math.max(0, w.start - trimStart),
            end: Math.min(trimEnd - trimStart, w.end - trimStart)
          }))
        setClipTranscript(clipId, trimmed)
      }

      setTrimStart(null)
      setTrimEnd(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsTrimming(false)
    }
  }, [clip, trimStart, trimEnd, transcript, bucket, clipId, updateClipPath, setClipTranscript])

  if (!clip) return null

  const effectiveTrimStart = trimStart ?? 0
  const effectiveTrimEnd = trimEnd ?? clip.duration
  const trimBarLeft = clip.duration > 0 ? (effectiveTrimStart / clip.duration) * 100 : 0
  const trimBarWidth = clip.duration > 0
    ? ((effectiveTrimEnd - effectiveTrimStart) / clip.duration) * 100
    : 100

  // Compute which word indices fall in trim range
  const inTrimRange = (w: WordChunk) => {
    if (trimStart === null && trimEnd === null) return false
    return w.end > effectiveTrimStart && w.start < effectiveTrimEnd
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Scissors className="w-4 h-4" />
            Edit Clip: {clip.name}
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

        {/* Video Player */}
        <video
          ref={videoRef}
          src={`file://${clip.path}`}
          controls
          className="w-full max-h-48 rounded-md bg-black object-contain"
        />

        {/* Trim Range Bar */}
        <div className="relative h-3 bg-secondary rounded-sm overflow-hidden">
          <div
            className="absolute h-full bg-primary/40 rounded-sm"
            style={{ left: `${trimBarLeft}%`, width: `${trimBarWidth}%` }}
          />
          {trimStart !== null && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary"
              style={{ left: `${trimBarLeft}%` }}
            />
          )}
          {trimEnd !== null && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary"
              style={{ left: `${trimBarLeft + trimBarWidth}%` }}
            />
          )}
        </div>

        {/* Trim Controls */}
        <div className="flex items-center gap-2 text-xs">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleSetStart}>
            Set Start
          </Button>
          <span className="font-mono text-muted-foreground">
            {trimStart !== null ? formatTime(trimStart) : '--:--'}
          </span>
          <span className="text-muted-foreground">-</span>
          <span className="font-mono text-muted-foreground">
            {trimEnd !== null ? formatTime(trimEnd) : '--:--'}
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleSetEnd}>
            Set End
          </Button>
          <div className="flex-1" />
          {trimStart !== null && trimEnd !== null && (
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleApplyTrim}
              disabled={isTrimming || trimEnd <= trimStart}
            >
              {isTrimming ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Scissors className="w-3 h-3" />
              )}
              Apply Trim
            </Button>
          )}
          {(trimStart !== null || trimEnd !== null) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setTrimStart(null)
                setTrimEnd(null)
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {/* Transcript */}
        {isTranscribing || isModelLoading ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <div className="text-center text-sm">
              {isModelLoading ? (
                <>
                  <p>Loading Whisper model...</p>
                  <Progress value={loadProgress} className="w-48 mt-2" />
                </>
              ) : (
                <p>Transcribing...</p>
              )}
            </div>
          </div>
        ) : transcript && transcript.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium">
                Transcript ({transcript.length} words)
              </span>
              <span className="text-[10px] text-muted-foreground">
                Click to seek, Shift+click for range, double-click to edit
              </span>
            </div>
            <ScrollArea className="h-40 rounded-md border border-border p-2">
              <div className="flex flex-wrap gap-0.5">
                {transcript.map((word, idx) => {
                  const marker = isMarkerWord(word.text)
                  const inRange = inTrimRange(word)

                  if (editingWordIdx === idx) {
                    return (
                      <input
                        key={idx}
                        autoFocus
                        className="text-xs bg-primary/20 border border-primary rounded px-1 outline-none min-w-0"
                        style={{ width: `${Math.max(3, editText.length + 1)}ch` }}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onBlur={commitWordEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitWordEdit()
                          if (e.key === 'Escape') setEditingWordIdx(null)
                        }}
                      />
                    )
                  }

                  return (
                    <span
                      key={idx}
                      onClick={(e) => handleWordClick(idx, e)}
                      onDoubleClick={() => handleWordDoubleClick(idx)}
                      className={cn(
                        'text-xs cursor-pointer hover:underline rounded px-0.5 select-none',
                        marker && 'bg-yellow-500/20 text-yellow-400 font-semibold',
                        inRange && !marker && 'bg-primary/15',
                        !marker && !inRange && 'text-muted-foreground'
                      )}
                      title={`${formatTime(word.start)} - ${formatTime(word.end)}`}
                    >
                      {word.text}
                    </span>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        ) : !isTranscribing && !transcript ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            <Button variant="outline" size="sm" onClick={runTranscription}>
              Transcribe Clip
            </Button>
          </div>
        ) : null}

        {/* Preview play trimmed section */}
        {trimStart !== null && trimEnd !== null && (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => seekVideo(trimStart)}
            >
              <Play className="w-3 h-3" />
              Preview from {formatTime(trimStart)}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
