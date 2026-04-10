import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Loader2, Captions, Crop, Scissors, Brain } from 'lucide-react'
import { useStore, RenderProgress } from '../store'
import { useWhisper } from '@/hooks/useWhisper'
import { WhisperStatus } from './WhisperStatus'
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
  const setWhisperModel = useStore((s) => s.setWhisperModel)
  const captionOffsetMs = useStore((s) => s.captionOffsetMs)
  const setCaptionOffsetMs = useStore((s) => s.setCaptionOffsetMs)
  const targetPlatform = useStore((s) => s.targetPlatform)

  const { loadModel, transcribe, isModelLoading, isModelReady, isTranscribing, loadProgress } =
    useWhisper()

  const [renderCount, setRenderCount] = useState<number | 'all'>('all')
  const [autoCaptions, setAutoCaptions] = useState(false)
  const [autoResize, setAutoResize] = useState(false)
  const [showProgress, setShowProgress] = useState(false)

  // Listen for render progress updates
  useEffect(() => {
    const unsubscribe = window.api.onRenderProgress((progress: RenderProgress[]) => {
      setRenderProgress(progress)
    })
    return unsubscribe
  }, [setRenderProgress])

  const handleRender = async () => {
    if (!settings.outputDirectory) {
      alert('Please choose an output folder first.')
      return
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
      // Load model first — if this fails, skip all captions
      let modelLoaded = isModelReady
      if (!modelLoaded) {
        try {
          setCaptionProgress({
            stage: 'loading-model',
            currentClip: '',
            completedClips: 0,
            totalClips: 0
          })
          await loadModel(whisperModel)
          modelLoaded = true
          toast.success('Whisper model ready')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('Whisper model loading failed:', err)
          addError({ source: 'caption', clipName: 'Whisper Model', message: msg })
          toast.error('Whisper model failed to load')
          setCaptionProgress(null)
        }
      }

      if (modelLoaded) {
        // Only transcribe clips used by the combos we're about to render
        const allClipPaths = new Set<string>()
        for (const combo of toRender) {
          allClipPaths.add(combo.hook.path)
          allClipPaths.add(combo.meat.path)
          allClipPaths.add(combo.cta.path)
        }

        const uniquePaths = Array.from(allClipPaths)
        let completed = 0

        // Transcribe each unique clip independently
        for (const clipPath of uniquePaths) {
          const clipName = clipPath.split(/[/\\]/).pop() || 'Unknown'
          setCaptionProgress({
            stage: 'transcribing',
            currentClip: clipName,
            completedClips: completed,
            totalClips: uniquePaths.length
          })

          try {
            const wavPath = await window.api.extractAudio(clipPath)
            const audioBuffer = await window.api.readAudioBuffer(wavPath)
            const audioData = new Float32Array(audioBuffer)
            const { chunks } = await transcribe(audioData, whisperModel)
            transcriptionCache[clipPath] = chunks
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`Transcription failed for ${clipName}:`, err)
            addError({ source: 'caption', clipName, message: msg })
          }

          completed++
        }

        if (completed > 0) {
          toast.success(`Transcribed ${completed} clip${completed === 1 ? '' : 's'}`)
        }
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

    setCaptionProgress(null)
    setJobIdToComboId(jobMap)

    try {
      await window.api.renderBatch(jobs)
    } catch (err) {
      console.error('Render failed:', err)
    } finally {
      // Log any errored render jobs
      const finalProgress = useStore.getState().renderProgress
      let errorCount = 0
      for (const rp of finalProgress) {
        if (rp.status === 'error') {
          errorCount++
          const job = jobs.find((j) => j.id === rp.jobId)
          const outputName = job
            ? job.outputPath.split(/[/\\]/).pop() || rp.jobId
            : rp.jobId
          addError({
            source: 'render',
            clipName: outputName,
            message: rp.error || 'Unknown render error'
          })
        }
      }

      const doneCount = finalProgress.filter((r) => r.status === 'done').length
      const totalJobs = finalProgress.length
      if (totalJobs > 0 && errorCount === 0) {
        toast.success(`${doneCount} video${doneCount === 1 ? '' : 's'} rendered`)
        confetti({
          particleCount: 120,
          spread: 70,
          origin: { y: 0.7 },
          disableForReducedMotion: true
        })
      } else if (errorCount > 0) {
        toast.error(`${errorCount} of ${totalJobs} render${totalJobs === 1 ? '' : 's'} failed`)
      }

      setIsRendering(false)
    }
  }

  const completed = renderProgress.filter((r) => r.status === 'done').length
  const errors = renderProgress.filter((r) => r.status === 'error').length
  const total = renderProgress.length
  const overallPercent =
    total > 0
      ? Math.round(renderProgress.reduce((sum, r) => sum + r.percent, 0) / total)
      : 0

  const canRender = totalCombos > 0 && settings.outputDirectory && !isRendering

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
          isReady={isModelReady}
          loadProgress={loadProgress}
          isTranscribing={isTranscribing}
          currentClip={captionProgress?.currentClip}
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

          {/* Caption Style Picker + Model Picker (visible when auto captions enabled) */}
          {autoCaptions && (
            <>
              <CaptionStylePicker disabled={isRendering} />
              <div className="flex items-center gap-1">
                <Brain className="w-3.5 h-3.5 text-muted-foreground" />
                <Select
                  value={whisperModel}
                  onValueChange={setWhisperModel}
                  disabled={isRendering}
                >
                  <SelectTrigger className="h-7 w-auto text-xs gap-1 px-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="onnx-community/whisper-tiny.en_timestamped">Tiny (fast)</SelectItem>
                    <SelectItem value="onnx-community/whisper-base.en_timestamped">Base (balanced)</SelectItem>
                    <SelectItem value="onnx-community/whisper-small.en_timestamped">Small (accurate)</SelectItem>
                    <SelectItem value="onnx-community/whisper-large-v3-turbo_timestamped">Turbo (best, WebGPU)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
        </div>
      </div>
    </div>
  )
}
