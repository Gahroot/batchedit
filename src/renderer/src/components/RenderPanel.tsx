import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Loader2, CheckCircle, AlertCircle, Captions, Crop } from 'lucide-react'
import { useStore, RenderProgress, CAPTION_PRESETS } from '../store'
import { useWhisper } from '@/hooks/useWhisper'
import { WhisperStatus } from './WhisperStatus'
import { ErrorLog } from './ErrorLog'
import { cn } from '../lib/utils'
import { v4 as uuidv4 } from 'uuid'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'

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
  const captionProgress = useStore((s) => s.captionProgress)
  const setCaptionProgress = useStore((s) => s.setCaptionProgress)
  const addError = useStore((s) => s.addError)
  const clearErrors = useStore((s) => s.clearErrors)
  const captionStyle = useStore((s) => s.captionStyle)
  const setCaptionStyle = useStore((s) => s.setCaptionStyle)
  const setHighlightColor = useStore((s) => s.setHighlightColor)

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
          await loadModel()
          modelLoaded = true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('Whisper model loading failed:', err)
          addError({ source: 'caption', clipName: 'Whisper Model', message: msg })
          setCaptionProgress(null)
        }
      }

      if (modelLoaded) {
        // Get all unique clip paths
        const allClipPaths = new Set<string>()
        hooks.forEach((c) => allClipPaths.add(c.path))
        meats.forEach((c) => allClipPaths.add(c.path))
        ctas.forEach((c) => allClipPaths.add(c.path))

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
            const chunks = await transcribe(audioData)
            transcriptionCache[clipPath] = chunks
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`Transcription failed for ${clipName}:`, err)
            addError({ source: 'caption', clipName, message: msg })
          }

          completed++
        }

        setCaptionProgress({
          stage: 'generating-ass',
          currentClip: '',
          completedClips: completed,
          totalClips: uniquePaths.length
        })
      }
    }

    // Generate all combinations
    const combos: { hook: typeof hooks[0]; meat: typeof meats[0]; cta: typeof ctas[0] }[] = []
    for (const hook of hooks) {
      for (const meat of meats) {
        for (const cta of ctas) {
          combos.push({ hook, meat, cta })
        }
      }
    }

    // Limit if not rendering all
    const toRender = renderCount === 'all' ? combos : combos.slice(0, renderCount)

    // Build render jobs
    const jobs = await Promise.all(
      toRender.map(async (combo, idx) => {
        const id = uuidv4()
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
          autoResize
        }

        // Add text overlay if defined
        if (hookText && hookText.trim()) {
          job.textOverlay = hookText.trim()
          job.hookDurationSec = combo.hook.duration
        }

        // Add captions if available
        if (autoCaptions && Object.keys(transcriptionCache).length > 0) {
          try {
            const hookDurationMs = combo.hook.duration * 1000
            const meatDurationMs = combo.meat.duration * 1000

            const segments = [
              { wordChunks: transcriptionCache[combo.hook.path] || [], offsetMs: 0 },
              { wordChunks: transcriptionCache[combo.meat.path] || [], offsetMs: hookDurationMs },
              {
                wordChunks: transcriptionCache[combo.cta.path] || [],
                offsetMs: hookDurationMs + meatDurationMs
              }
            ]

            const assPath = await window.api.generateCombinedAss({
              segments,
              resolution: job.resolution,
              captionStyle: {
                fontName: captionStyle.fontName,
                highlightColor: captionStyle.highlightColor
              }
            })
            job.captionsAssPath = assPath
          } catch (err) {
            console.error('Failed to generate ASS for combo:', err)
          }
        }

        return job
      })
    )

    setCaptionProgress(null)

    try {
      await window.api.renderBatch(jobs)
    } catch (err) {
      console.error('Render failed:', err)
    } finally {
      // Log any errored render jobs
      const finalProgress = useStore.getState().renderProgress
      for (const rp of finalProgress) {
        if (rp.status === 'error') {
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
                <Badge variant="secondary">{completed}/{total} done</Badge>
                {errors > 0 && <Badge variant="destructive">{errors} err</Badge>}
              </div>
            </div>

            {/* Individual Job Progress */}
            <TooltipProvider>
            <div className="max-h-32 overflow-y-auto space-y-1">
              {renderProgress.map((rp) => {
                const row = (
                  <div key={rp.jobId} className="flex items-center gap-2 text-[10px]">
                    {rp.status === 'done' ? (
                      <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                    ) : rp.status === 'error' ? (
                      <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
                    ) : rp.status === 'rendering' ? (
                      <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />
                    ) : (
                      <div className="w-3 h-3 rounded-full border border-border shrink-0" />
                    )}
                    <div className="flex-1 h-1 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          rp.status === 'error' ? 'bg-destructive' : 'bg-primary'
                        )}
                        style={{ width: `${rp.percent}%` }}
                      />
                    </div>
                    <span className="font-mono text-muted-foreground w-10 text-right">
                      {rp.status === 'error' ? 'ERR' : `${Math.round(rp.percent)}%`}
                    </span>
                  </div>
                )

                if (rp.status === 'error' && rp.error) {
                  return (
                    <Tooltip key={rp.jobId}>
                      <TooltipTrigger asChild>{row}</TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        {rp.error}
                      </TooltipContent>
                    </Tooltip>
                  )
                }

                return row
              })}
            </div>
            </TooltipProvider>
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

          {/* Caption Style Controls (visible when auto captions enabled) */}
          {autoCaptions && (
            <>
              {/* Font Selector */}
              <Select
                value={captionStyle.id}
                onValueChange={(value) => {
                  const preset = CAPTION_PRESETS[value]
                  if (preset) setCaptionStyle({ ...preset, highlightColor: captionStyle.highlightColor })
                }}
                disabled={isRendering}
              >
                <SelectTrigger className="h-7 w-auto text-xs gap-1 px-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(CAPTION_PRESETS).map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Highlight Color Picker */}
              <label className="relative cursor-pointer" title="Highlight color">
                <div
                  className="w-6 h-6 rounded border border-border"
                  style={{ backgroundColor: captionStyle.highlightColor }}
                />
                <input
                  type="color"
                  value={captionStyle.highlightColor}
                  onChange={(e) => setHighlightColor(e.target.value)}
                  disabled={isRendering}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </label>
            </>
          )}

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
        </div>
      </div>
    </div>
  )
}
