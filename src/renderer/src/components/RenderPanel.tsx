import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Loader2, Captions, Crop, Scissors, Square } from 'lucide-react'
import { useStore, RenderProgress } from '../store'
import { getWhisperModelInfo } from '../lib/whisper-config'
import { humanizeFfmpegError } from '../../../shared/ffmpeg-error-hints'
import { useWhisper } from '@/hooks/useWhisper'
import { isWhisperCancellationError, WhisperCancellationError } from '@/hooks/whisper-client'
import { WhisperStatus } from './WhisperStatus'
import { WhisperModelControl } from './WhisperModelControl'
import { ErrorLog } from './ErrorLog'
import { CaptionStylePicker } from './CaptionStylePicker'
import { v4 as uuidv4 } from 'uuid'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { NumberTicker } from '@/components/ui/number-ticker'
import { PermutationMatrix } from './PermutationMatrix'
import { ShimmerButton } from '@/components/ui/shimmer-button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { toast } from 'sonner'
import confetti from 'canvas-confetti'

export function RenderPanel() {
  const hooks = useStore((s) => s.hooks)
  const meats = useStore((s) => s.meats)
  const ctas = useStore((s) => s.ctas)
  const hookTexts = useStore((s) => s.hookTexts)
  const settings = useStore((s) => s.settings)
  const totalCombos = useStore((s) => s.getTotalCombinations())
  const renderProgress = useStore((s) => s.renderProgress)
  const setRenderProgress = useStore((s) => s.setRenderProgress)
  const isRendering = useStore((s) => s.isRendering)
  const setIsRendering = useStore((s) => s.setIsRendering)
  const setJobIdToComboId = useStore((s) => s.setJobIdToComboId)
  const captionProgress = useStore((s) => s.captionProgress)
  const setCaptionProgress = useStore((s) => s.setCaptionProgress)
  const addError = useStore((s) => s.addError)
  const clearErrors = useStore((s) => s.clearErrors)
  const captionStyle = useStore((s) => s.captionStyle)
  const templateLayout = useStore((s) => s.templateLayout)
  const mediaOverlays = useStore((s) => s.mediaOverlays)
  const autoTrimSilence = useStore((s) => s.autoTrimSilence)
  const setAutoTrimSilence = useStore((s) => s.setAutoTrimSilence)
  const whisperModel = useStore((s) => s.whisperModel)
  const whisperDevice = useStore((s) => s.whisperDevice)
  const captionOffsetMs = useStore((s) => s.captionOffsetMs)
  const setCaptionOffsetMs = useStore((s) => s.setCaptionOffsetMs)
  const targetPlatform = useStore((s) => s.targetPlatform)
  const setOutputDirectory = useStore((s) => s.setOutputDirectory)

  const {
    loadModel,
    transcribe,
    cancel: cancelWhisper,
    isModelLoading,
    isModelReady,
    isTranscribing,
    loadProgress,
    loadedModel
  } = useWhisper()

  const [renderCount, setRenderCount] = useState<number | 'all'>('all')
  const [autoCaptions, setAutoCaptions] = useState(false)
  const [autoResize, setAutoResize] = useState(false)
  const [showProgress, setShowProgress] = useState(false)
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const captionPreparationRunId = useRef(0)

  // Listen for render progress updates
  useEffect(() => {
    const unsubscribe = window.api.onRenderProgress((progress: RenderProgress[]) => {
      setRenderProgress(progress)
    })
    return unsubscribe
  }, [setRenderProgress])

  // First-run convenience: suggest a sensible output folder (e.g. OS Videos/Desktop)
  // when none is set yet. Always overridable by the user.
  useEffect(() => {
    if (useStore.getState().settings.outputDirectory) return
    let cancelled = false
    window.api.getDefaultOutputDirectory().then((dir) => {
      if (!cancelled && dir && !useStore.getState().settings.outputDirectory) {
        setOutputDirectory(dir)
      }
    })
    return () => {
      cancelled = true
    }
  }, [setOutputDirectory])

  const handleChooseOutput = async (): Promise<void> => {
    const dir = await window.api.openDirectory()
    if (dir) setOutputDirectory(dir)
  }

  const handleRender = async (): Promise<void> => {
    if (totalCombos === 0) {
      toast.error('Add at least one Hook, Meat, and CTA')
      return
    }
    if (autoCaptions && whisperDevice === 'detecting') {
      toast.error('Wait for the WebGPU check to finish')
      return
    }
    if (!settings.outputDirectory) {
      toast.error('Choose an output folder first', {
        action: {
          label: 'Choose Folder',
          onClick: handleChooseOutput
        }
      })
      return
    }

    const preparationRunId = captionPreparationRunId.current + 1
    captionPreparationRunId.current = preparationRunId
    const assertCurrentPreparation = (): void => {
      if (captionPreparationRunId.current !== preparationRunId) {
        throw new WhisperCancellationError()
      }
    }

    setIsRendering(true)
    setShowProgress(true)
    clearErrors()

    // Caption transcription cache (keyed by clip path)
    const transcriptionCache: Record<
      string,
      Array<{ text: string; start: number; end: number }>
    > = {}

    // Generate all combinations
    const combos: { id: string; hook: typeof hooks[0]; meat: typeof meats[0]; cta: typeof ctas[0] }[] = []
    for (const hook of hooks) {
      for (const meat of meats) {
        for (const cta of ctas) {
          combos.push({ id: `${hook.id}__${meat.id}__${cta.id}`, hook, meat, cta })
        }
      }
    }

    // Limit if not rendering all
    const toRender = renderCount === 'all' ? combos : combos.slice(0, renderCount)

    if (autoCaptions) {
      try {
        let modelLoaded = true
        const selectedModelWasReady = isModelReady && loadedModel === whisperModel

        try {
          setCaptionProgress({
            stage: 'loading-model',
            currentClip: '',
            completedClips: 0,
            totalClips: 0
          })
          await loadModel(whisperModel)
          assertCurrentPreparation()
          if (!selectedModelWasReady) toast.success('Whisper model ready')
        } catch (error) {
          if (isWhisperCancellationError(error)) throw error

          modelLoaded = false
          const message = error instanceof Error ? error.message : String(error)
          console.error('Whisper model loading failed:', error)
          addError({ source: 'caption', clipName: 'Whisper Model', message })
          setAutoCaptions(false)
          toast.error('Whisper model failed to load — Auto Captions turned off', {
            description: 'Rendering without captions. Re-enable Auto Captions to try again.'
          })
          setCaptionProgress(null)
        }

        if (modelLoaded) {
          const allClipPaths = new Set<string>()
          for (const combo of toRender) {
            allClipPaths.add(combo.hook.path)
            allClipPaths.add(combo.meat.path)
            allClipPaths.add(combo.cta.path)
          }

          const uniquePaths = Array.from(allClipPaths).sort()
          let completed = 0

          for (const clipPath of uniquePaths) {
            assertCurrentPreparation()
            const clipName = clipPath.split(/[/\\]/).pop() || 'Unknown'
            setCaptionProgress({
              stage: 'transcribing',
              currentClip: clipName,
              completedClips: completed,
              totalClips: uniquePaths.length
            })

            let wavPath: string | null = null
            try {
              wavPath = await window.api.extractAudio(clipPath)
              assertCurrentPreparation()
              const audioBuffer = await window.api.readAudioBuffer(wavPath)
              wavPath = null
              assertCurrentPreparation()
              const { chunks } = await transcribe(new Float32Array(audioBuffer), whisperModel)
              assertCurrentPreparation()
              transcriptionCache[clipPath] = chunks
            } catch (error) {
              if (isWhisperCancellationError(error)) throw error
              const message = error instanceof Error ? error.message : String(error)
              console.error(`Transcription failed for ${clipName}:`, error)
              addError({ source: 'caption', clipName, message })
            } finally {
              if (wavPath) await window.api.releaseTempFile(wavPath)
            }

            completed += 1
          }

          if (completed > 0) {
            toast.success(`Transcribed ${completed} clip${completed === 1 ? '' : 's'}`)
          }
        }
        assertCurrentPreparation()
      } catch (error) {
        if (isWhisperCancellationError(error)) {
          if (captionPreparationRunId.current === preparationRunId) {
            setCaptionProgress(null)
            setIsRendering(false)
            toast.info('Caption preparation stopped')
          }
          return
        }

        const message = error instanceof Error ? error.message : String(error)
        addError({ source: 'caption', clipName: 'Caption preparation', message })
        setAutoCaptions(false)
        setCaptionProgress(null)
        toast.error('Caption preparation failed — rendering without captions', {
          description: message
        })
      }
    }

    // Build render jobs
    const jobMap: Record<string, string> = {}
    const jobs = await Promise.all(
      toRender.map(async (combo, idx) => {
        const id = uuidv4()
        jobMap[id] = combo.id
        const hookText = hookTexts[combo.hook.id]
        const hookLabel = hookText && hookText.trim()
          ? hookText.trim().replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ')
          : combo.hook.name.replace(/\.[^.]+$/, '')
        const outputName = `${hookLabel}_${combo.meat.name.replace(/\.[^.]+$/, '')}_${combo.cta.name.replace(/\.[^.]+$/, '')}_${idx + 1}.mp4`

        const job: any = {
          id,
          hookPath: combo.hook.path,
          meatPath: combo.meat.path,
          ctaPath: combo.cta.path,
          outputPath: `${settings.outputDirectory}/${outputName}`,
          resolution: { width: settings.resolution.width, height: settings.resolution.height },
          autoResize,
          titlePosition: templateLayout.titleText,
          targetPlatform
        }

        // Add text overlay if defined
        if (hookText && hookText.trim()) {
          job.textOverlay = hookText.trim()
          job.hookDurationSec = combo.hook.duration
        }

        // Add media overlays if set
        if (mediaOverlays.meat || mediaOverlays.cta) {
          job.mediaOverlays = {
            meat: mediaOverlays.meat || undefined,
            cta: mediaOverlays.cta || undefined
          }
          job.mediaOverlayPosition = templateLayout.media
          job.meatDurationSec = combo.meat.duration
          // Ensure hookDurationSec is set for overlay timing
          if (!job.hookDurationSec) {
            job.hookDurationSec = combo.hook.duration
          }
        }

        // Add caption data for main process to generate ASS after normalization
        if (autoCaptions && Object.keys(transcriptionCache).length > 0) {
          const { id: _id, label: _label, ...styleProps } = captionStyle
          job.captionData = {
            clipWordChunks: {
              [combo.hook.path]: transcriptionCache[combo.hook.path] || [],
              [combo.meat.path]: transcriptionCache[combo.meat.path] || [],
              [combo.cta.path]: transcriptionCache[combo.cta.path] || [],
            },
            captionStyle: styleProps,
            captionPosition: templateLayout.subtitles,
            captionOffsetMs,
          }
        }

        return job
      })
    )

    if (autoCaptions && captionPreparationRunId.current !== preparationRunId) return

    const batchId = jobs[0]?.id ?? null
    setActiveBatchId(batchId)
    setCaptionProgress(null)
    setJobIdToComboId(jobMap)

    let returnedProgress: RenderProgress[] | null = null
    try {
      returnedProgress = await window.api.renderBatch(jobs)
      setRenderProgress(returnedProgress)
    } catch (err) {
      console.error('Render failed:', err)
      const raw = err instanceof Error ? err.message : String(err)
      const { hint, raw: detail } = humanizeFfmpegError(raw)
      for (const job of jobs) {
        addError({
          source: 'render',
          clipName: job.outputPath.split(/[/\\]/).pop() || job.id,
          message: hint,
          detail
        })
      }
    } finally {
      // Log any errored render jobs from the returned IPC result to avoid stale progress races.
      const finalProgress = returnedProgress ?? useStore.getState().renderProgress
      let errorCount = 0
      let canceledCount = 0
      for (const rp of finalProgress) {
        if (rp.status === 'canceled') {
          canceledCount++
          continue
        }
        if (rp.status === 'error') {
          errorCount++
          const job = jobs.find((j) => j.id === rp.jobId)
          const outputName = job
            ? job.outputPath.split(/[/\\]/).pop() || rp.jobId
            : rp.jobId
          addError({
            source: 'render',
            clipName: outputName,
            message: rp.error || 'Unknown render error',
            ...(rp.errorDetail ? { detail: rp.errorDetail } : {})
          })
        }
      }

      const doneCount = finalProgress.filter((r) => r.status === 'done').length
      const totalJobs = finalProgress.length
      if (totalJobs > 0 && canceledCount > 0) {
        toast.info(`Canceled ${canceledCount} render${canceledCount === 1 ? '' : 's'}`)
      } else if (totalJobs > 0 && errorCount === 0) {
        const firstDoneJob = finalProgress.find((r) => r.status === 'done')
        const firstFilePath = firstDoneJob
          ? jobs.find((j) => j.id === firstDoneJob.jobId)?.outputPath
          : undefined
        const revealTarget = firstFilePath ?? settings.outputDirectory
        toast.success(`${doneCount} video${doneCount === 1 ? '' : 's'} rendered`, {
          action: revealTarget
            ? {
                label: 'Open Folder',
                onClick: () => {
                  if (firstFilePath) {
                    window.api.showItemInFolder(firstFilePath)
                  } else if (settings.outputDirectory) {
                    window.api.openPath(settings.outputDirectory)
                  }
                }
              }
            : undefined
        })
        confetti({
          particleCount: 120,
          spread: 70,
          origin: { y: 0.7 },
          disableForReducedMotion: true
        })
      } else if (errorCount > 0) {
        toast.error(`${errorCount} of ${totalJobs} render${totalJobs === 1 ? '' : 's'} failed`)
      }

      setActiveBatchId(null)
      setIsRendering(false)
    }
  }

  const completed = renderProgress.filter((r) => r.status === 'done').length
  const errors = renderProgress.filter((r) => r.status === 'error').length
  const canceled = renderProgress.filter((r) => r.status === 'canceled').length
  const total = renderProgress.length
  const overallPercent =
    total > 0
      ? Math.round(renderProgress.reduce((sum, r) => sum + r.percent, 0) / total)
      : 0

  const canRender =
    totalCombos > 0 &&
    settings.outputDirectory &&
    !isRendering &&
    (!autoCaptions || whisperDevice !== 'detecting')

  // Exact reason the Render button is disabled (excluding the in-progress state),
  // surfaced via tooltip so first-run users know what to fix.
  const disabledReason =
    totalCombos === 0
      ? 'Add at least one Hook, Meat, and CTA'
      : !settings.outputDirectory
        ? 'Choose an output folder first'
        : autoCaptions && whisperDevice === 'detecting'
          ? 'Checking WebGPU before selecting the caption model'
          : null

  const handleCancelRender = async (): Promise<void> => {
    if (activeBatchId === null && captionProgress !== null) {
      captionPreparationRunId.current += 1
      cancelWhisper()
      setCaptionProgress(null)
      setIsRendering(false)
      toast.info('Stopping caption preparation…')
      return
    }

    const didCancel = await window.api.cancelRender(activeBatchId ?? undefined)
    if (didCancel) toast.info('Canceling render...')
  }

  // Build render count options
  const renderCountOptions = [1, 5, 10, 25, 50, 100].filter((n) => n <= totalCombos)

  return (
    <div className="border-t border-border bg-card px-6 py-3">
      {/* Progress Display */}
      <AnimatePresence>
        {showProgress && renderProgress.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden mb-3"
          >
            {/* Overall Progress Bar */}
            <div className="flex items-center gap-3 mb-2">
              <Progress value={overallPercent} className="flex-1 h-2" />
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="font-mono">
                  <NumberTicker value={completed} />/{total} done
                </Badge>
                {errors > 0 && (
                  <Badge variant="destructive" className="font-mono">
                    <NumberTicker value={errors} /> err
                  </Badge>
                )}
                {canceled > 0 && (
                  <Badge variant="outline" className="font-mono">
                    <NumberTicker value={canceled} /> canceled
                  </Badge>
                )}
              </div>
            </div>

            {/* Permutation Matrix */}
            <PermutationMatrix />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Log */}
      <ErrorLog />

      {/* Whisper Status */}
      {autoCaptions && (
        <WhisperStatus
          isLoading={isModelLoading}
          isReady={isModelReady && loadedModel === whisperModel}
          loadProgress={loadProgress}
          isTranscribing={isTranscribing}
          currentClip={captionProgress?.currentClip}
          modelLabel={getWhisperModelInfo(whisperModel)?.label}
          modelSize={getWhisperModelInfo(whisperModel)?.approxSize}
        />
      )}

      {/* Controls */}
      <div className="flex items-center justify-between">
        {/* Render Count */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Render:</span>
          <Select
            value={renderCount === 'all' ? 'all' : String(renderCount)}
            onValueChange={(value) =>
              setRenderCount(value === 'all' ? 'all' : parseInt(value))
            }
            disabled={isRendering}
          >
            <SelectTrigger className="h-7 w-auto text-xs gap-1 px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ({totalCombos})</SelectItem>
              {renderCountOptions.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          {/* Auto Captions Toggle */}
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Switch
              checked={autoCaptions}
              onCheckedChange={setAutoCaptions}
              disabled={isRendering}
              className="scale-75"
            />
            <Captions className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Auto Captions</span>
          </label>

          {/* Caption controls (visible when auto captions are enabled) */}
          {autoCaptions && (
            <>
              <CaptionStylePicker disabled={isRendering} />
              <WhisperModelControl compact disabled={isRendering} className="w-72" />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {captionOffsetMs > 0 ? '+' : ''}{captionOffsetMs}ms
                </span>
                <Slider
                  value={[captionOffsetMs]}
                  onValueChange={([v]) => setCaptionOffsetMs(v)}
                  min={-500}
                  max={500}
                  step={50}
                  disabled={isRendering}
                  className="w-20"
                />
              </div>
            </>
          )}

          {/* Trim Silence Toggle */}
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Switch
              checked={autoTrimSilence}
              onCheckedChange={setAutoTrimSilence}
              disabled={isRendering}
              className="scale-75"
            />
            <Scissors className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Trim Silence</span>
          </label>

          {/* Auto Resize Toggle */}
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Switch
              checked={autoResize}
              onCheckedChange={setAutoResize}
              disabled={isRendering}
              className="scale-75"
            />
            <Crop className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Auto Resize</span>
          </label>

          {/* Render Button */}
          {canRender ? (
            <ShimmerButton onClick={handleRender} className="gap-2">
              <Play className="w-4 h-4" />
              Render {renderCount === 'all' ? totalCombos : renderCount} Videos
            </ShimmerButton>
          ) : disabledReason ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button size="lg" disabled className="pointer-events-none">
                      <Play className="w-4 h-4" />
                      Render {renderCount === 'all' ? totalCombos : renderCount} Videos
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{disabledReason}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button size="lg" onClick={handleRender} disabled={!canRender}>
              {isRendering ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Rendering...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Render {renderCount === 'all' ? totalCombos : renderCount} Videos
                </>
              )}
            </Button>
          )}
          {isRendering && (
            <Button size="lg" variant="destructive" onClick={handleCancelRender}>
              <Square className="w-4 h-4 fill-current" />
              {captionProgress ? 'Stop captions' : 'Cancel render'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
