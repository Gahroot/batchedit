import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Loader2, Captions, Crop, Scissors, Square, FolderOpen } from 'lucide-react'
import { useStore, type Combo, type RenderProgress, type WordChunk } from '../store'
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
import {
  findKnownClipPreflightIssues,
  runRenderClipPreflight
} from '../lib/render-preflight'
import {
  formatAffectedOutputsSummary,
  formatCaptionFailureSummary,
  getUniqueCaptionClips,
  inspectTranscriptCache,
  prepareCaptionTranscripts,
  type CaptionClipFailure,
  type CaptionPreparationResult,
  type TranscriptCache
} from '../lib/caption-preparation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

type RenderJob = Parameters<Window['api']['renderBatch']>[0][number]

interface BatchDestination {
  directory: string
  revealPath: string | null
}

interface PlannedRender {
  combo: Combo
  outputName: string
}

interface CaptionDecision {
  result: CaptionPreparationResult
  failedPaths: string[]
  affectedComboIds: string[]
  affectedOutputNames: string[]
  totalOutputCount: number
}

type CaptionRenderIntent =
  | { kind: 'prepare' }
  | {
      kind: 'continue-without-captions'
      approvedFailedPaths: string[]
      approvedAffectedComboIds: string[]
    }

function buildBatchOutputPath(batchDirectory: string, outputName: string): string {
  return `${batchDirectory.replace(/[/\\]+$/, '')}/${outputName}`
}

function buildOutputName(combo: Combo, index: number, hookTexts: Record<string, string>): string {
  const hookText = hookTexts[combo.hook.id]
  const hookLabel =
    hookText && hookText.trim()
      ? hookText.trim().replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ')
      : combo.hook.name.replace(/\.[^.]+$/, '')
  return `${hookLabel}_${combo.meat.name.replace(/\.[^.]+$/, '')}_${combo.cta.name.replace(/\.[^.]+$/, '')}_${index + 1}.mp4`
}

function comboUsesAnyPath(combo: Combo, paths: ReadonlySet<string>): boolean {
  return paths.has(combo.hook.path) || paths.has(combo.meat.path) || paths.has(combo.cta.path)
}

function createCaptionDecision(
  result: CaptionPreparationResult,
  plannedRenders: readonly PlannedRender[]
): CaptionDecision {
  const failedPaths = result.failures.map((failure) => failure.clip.path).sort()
  const failedPathSet = new Set(failedPaths)
  const affectedRenders = plannedRenders.filter(({ combo }) =>
    comboUsesAnyPath(combo, failedPathSet)
  )

  return {
    result,
    failedPaths,
    affectedComboIds: affectedRenders.map(({ combo }) => combo.id).sort(),
    affectedOutputNames: affectedRenders.map(({ outputName }) => outputName),
    totalOutputCount: plannedRenders.length
  }
}

function stringArraysMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

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
  const markClipPathsMissing = useStore((s) => s.markClipPathsMissing)

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
  const [batchDestination, setBatchDestination] = useState<BatchDestination | null>(null)
  const [captionDecision, setCaptionDecision] = useState<CaptionDecision | null>(null)
  const captionPreparationRunId = useRef(0)
  const transcriptCache = useRef<TranscriptCache>(new Map())

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

  const handleRender = async (
    captionIntent: CaptionRenderIntent = { kind: 'prepare' }
  ): Promise<void> => {
    if (totalCombos === 0) {
      toast.error('Add at least one Hook, Meat, and CTA')
      return
    }

    const clipPreflight = await runRenderClipPreflight(
      [...hooks, ...meats, ...ctas],
      window.api.pathsExist
    )
    if (!clipPreflight.ok) {
      if ('issues' in clipPreflight) {
        const missingPaths = clipPreflight.issues
          .filter((issue) => issue.kind === 'missing')
          .map((issue) => issue.clip.path)
        if (missingPaths.length > 0) markClipPathsMissing(missingPaths)
        for (const issue of clipPreflight.issues) {
          addError({ source: 'render', clipName: issue.clip.name, message: issue.message })
        }
        const clipNames = clipPreflight.issues.map((issue) => issue.clip.name).join(', ')
        toast.error('Render blocked by invalid source clips', {
          description: `${clipNames}. Relink, re-add, or remove each flagged clip and try again.`
        })
      } else {
        addError({
          source: 'render',
          clipName: 'Preflight',
          message: clipPreflight.checkError,
          detail: clipPreflight.detail
        })
        toast.error('Render preflight failed', { description: clipPreflight.checkError })
      }
      return
    }

    if (autoCaptions && whisperDevice === 'detecting') {
      toast.error('Wait for the WebGPU check to finish')
      return
    }
    const outputDirectory = settings.outputDirectory
    if (!outputDirectory) {
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

    setCaptionDecision(null)
    setIsRendering(true)
    setShowProgress(true)
    if (captionIntent.kind === 'prepare') clearErrors()

    // Generate all combinations
    const combos: Combo[] = []
    for (const hook of hooks) {
      for (const meat of meats) {
        for (const cta of ctas) {
          combos.push({ id: `${hook.id}__${meat.id}__${cta.id}`, hook, meat, cta })
        }
      }
    }

    // Limit if not rendering all
    const toRender = renderCount === 'all' ? combos : combos.slice(0, renderCount)
    const plannedRenders: PlannedRender[] = toRender.map((combo, index) => ({
      combo,
      outputName: buildOutputName(combo, index, hookTexts)
    }))
    const requiredCaptionClips = getUniqueCaptionClips(
      toRender.flatMap((combo) => [combo.hook, combo.meat, combo.cta])
    )

    const blockForCaptionFailures = (
      result: CaptionPreparationResult,
      title = 'Auto Captions blocked render'
    ): void => {
      const decision = createCaptionDecision(result, plannedRenders)
      for (const failure of result.failures) {
        addError({
          source: 'caption',
          clipName: failure.clip.name,
          message: failure.message
        })
      }
      console.error('[Auto Captions]', {
        operation: 'prepare-render-captions',
        model: whisperModel,
        outcome: 'blocked',
        successfulClips: result.successCount,
        totalClips: result.totalCount,
        failedClips: result.failures.map((failure) => failure.clip.name)
      })
      setCaptionDecision(decision)
      setCaptionProgress(null)
      setShowProgress(false)
      setIsRendering(false)
      toast.error(title, { description: formatCaptionFailureSummary(result) })
    }

    let captionTranscripts = new Map<string, WordChunk[]>()
    let captionlessComboIds = new Set<string>()

    if (autoCaptions) {
      const getCurrentSourceSignatures = async (paths: string[]) => {
        const signatures = await window.api.getSourceFileSignatures(paths)
        assertCurrentPreparation()
        return signatures
      }

      try {
        if (captionIntent.kind === 'prepare') {
          const selectedModelWasReady = isModelReady && loadedModel === whisperModel
          setCaptionProgress({
            stage: 'loading-model',
            currentClip: '',
            completedClips: 0,
            totalClips: requiredCaptionClips.length
          })

          const preparationStartedAt = Date.now()
          const result = await prepareCaptionTranscripts({
            clips: requiredCaptionClips,
            model: whisperModel,
            cache: transcriptCache.current,
            getSourceFileSignatures: getCurrentSourceSignatures,
            loadModel: async (model) => {
              await loadModel(model)
              assertCurrentPreparation()
            },
            transcribeClip: async (clip) => {
              const clipStartedAt = Date.now()
              let wavPath: string | null = null
              try {
                wavPath = await window.api.extractAudio(clip.path)
                assertCurrentPreparation()
                const audioBuffer = await window.api.readAudioBuffer(wavPath)
                wavPath = null
                assertCurrentPreparation()
                const { chunks } = await transcribe(new Float32Array(audioBuffer), whisperModel)
                assertCurrentPreparation()
                console.info('[Auto Captions]', {
                  operation: 'transcribe-clip',
                  clipPath: clip.path,
                  outcome: 'success',
                  elapsedMs: Date.now() - clipStartedAt
                })
                return chunks
              } catch (error) {
                console.error('[Auto Captions]', {
                  operation: 'transcribe-clip',
                  clipPath: clip.path,
                  outcome: 'error',
                  elapsedMs: Date.now() - clipStartedAt,
                  error: error instanceof Error ? error.message : String(error)
                })
                throw error
              } finally {
                if (wavPath !== null) {
                  try {
                    await window.api.releaseTempFile(wavPath)
                  } catch (error) {
                    console.error('[Auto Captions]', {
                      operation: 'release-temp-audio',
                      clipPath: clip.path,
                      outcome: 'error',
                      error: error instanceof Error ? error.message : String(error)
                    })
                  }
                }
              }
            },
            isCancellationError: isWhisperCancellationError,
            onProgress: (progress) => {
              setCaptionProgress({
                stage: progress.stage,
                currentClip: progress.currentClip,
                completedClips: progress.successfulClips,
                totalClips: progress.totalClips
              })
            }
          })
          assertCurrentPreparation()

          if (result.modelLoaded && !selectedModelWasReady) toast.success('Whisper model ready')
          if (result.failures.length > 0) {
            blockForCaptionFailures(result)
            return
          }

          captionTranscripts = result.transcripts
          if (result.transcribedCount > 0) {
            toast.success(
              `Transcribed ${result.transcribedCount} clip${result.transcribedCount === 1 ? '' : 's'}`,
              {
                description: `${result.successCount} of ${result.totalCount} required transcripts ready.`
              }
            )
          }
          console.info('[Auto Captions]', {
            operation: 'prepare-render-captions',
            model: whisperModel,
            outcome: 'success',
            successfulClips: result.successCount,
            totalClips: result.totalCount,
            elapsedMs: Date.now() - preparationStartedAt
          })
        } else {
          setCaptionProgress({
            stage: 'transcribing',
            currentClip: 'Verifying cached transcripts',
            completedClips: 0,
            totalClips: requiredCaptionClips.length
          })
          const inspection = await inspectTranscriptCache({
            clips: requiredCaptionClips,
            model: whisperModel,
            cache: transcriptCache.current,
            getSourceFileSignatures: getCurrentSourceSignatures
          })
          assertCurrentPreparation()
          captionTranscripts = inspection.transcripts

          const unavailablePaths = new Set(
            inspection.unavailableClips.map((clip) => clip.path)
          )
          const failures: CaptionClipFailure[] = inspection.pendingClips.map((clip) => ({
            clip,
            kind: 'source',
            message: unavailablePaths.has(clip.path)
              ? 'The source file is unavailable.'
              : 'A source-current transcript is not available.'
          }))
          const currentResult: CaptionPreparationResult = {
            transcripts: inspection.transcripts,
            failures,
            successCount: inspection.transcripts.size,
            totalCount: requiredCaptionClips.length,
            transcribedCount: 0,
            modelLoaded: false
          }

          if (failures.length > 0) {
            const currentDecision = createCaptionDecision(currentResult, plannedRenders)
            const approvalStillMatches =
              stringArraysMatch(
                currentDecision.failedPaths,
                captionIntent.approvedFailedPaths
              ) &&
              stringArraysMatch(
                currentDecision.affectedComboIds,
                captionIntent.approvedAffectedComboIds
              )
            if (!approvalStillMatches) {
              blockForCaptionFailures(
                currentResult,
                'Caption sources changed — review affected outputs again'
              )
              return
            }
            captionlessComboIds = new Set(currentDecision.affectedComboIds)
            toast.info('Continuing with captions omitted from affected outputs', {
              description: formatAffectedOutputsSummary(
                currentDecision.affectedOutputNames.length,
                currentDecision.totalOutputCount
              )
            })
          }
        }
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
        const failures: CaptionClipFailure[] = requiredCaptionClips.map((clip) => ({
          clip,
          kind: 'source',
          message: `Caption preparation failed: ${message}`
        }))
        blockForCaptionFailures({
          transcripts: new Map(),
          failures,
          successCount: 0,
          totalCount: requiredCaptionClips.length,
          transcribedCount: 0,
          modelLoaded: false
        })
        return
      }
    }

    if (autoCaptions) {
      const missingRequiredClips = requiredCaptionClips.filter(
        (clip) => !captionTranscripts.has(clip.path)
      )
      const missingPathSet = new Set(missingRequiredClips.map((clip) => clip.path))
      const unapprovedMissingPaths = new Set(
        plannedRenders
          .filter(({ combo }) => comboUsesAnyPath(combo, missingPathSet))
          .filter(({ combo }) => !captionlessComboIds.has(combo.id))
          .flatMap(({ combo }) => [combo.hook.path, combo.meat.path, combo.cta.path])
      )
      const unapprovedFailures: CaptionClipFailure[] = missingRequiredClips
        .filter((clip) => unapprovedMissingPaths.has(clip.path))
        .map((clip) => ({
          clip,
          kind: 'source',
          message: 'A required transcript is missing.'
        }))
      if (unapprovedFailures.length > 0) {
        blockForCaptionFailures({
          transcripts: captionTranscripts,
          failures: unapprovedFailures,
          successCount: captionTranscripts.size,
          totalCount: requiredCaptionClips.length,
          transcribedCount: 0,
          modelLoaded: false
        })
        return
      }
    }

    let batchOutputDirectory: string
    try {
      batchOutputDirectory = await window.api.createRenderBatchDirectory(outputDirectory)
      setBatchDestination({ directory: batchOutputDirectory, revealPath: null })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed to create render batch directory:', error)
      addError({ source: 'render', clipName: 'Batch destination', message })
      setCaptionProgress(null)
      setIsRendering(false)
      toast.error("Couldn't create a new batch folder", { description: message })
      return
    }

    // Build every result path inside the directory reserved for this render run.
    const jobMap: Record<string, string> = {}
    const jobs: RenderJob[] = plannedRenders.map(({ combo, outputName }) => {
      const id = uuidv4()
      jobMap[id] = combo.id
      const hookText = hookTexts[combo.hook.id]

      const job: RenderJob = {
        id,
        hookPath: combo.hook.path,
        meatPath: combo.meat.path,
        ctaPath: combo.cta.path,
        outputPath: buildBatchOutputPath(batchOutputDirectory, outputName),
        resolution: { width: settings.resolution.width, height: settings.resolution.height },
        autoResize,
        titlePosition: templateLayout.titleText,
        targetPlatform
      }

      if (hookText && hookText.trim()) {
        job.textOverlay = hookText.trim()
        job.hookDurationSec = combo.hook.duration
      }

      if (mediaOverlays.meat || mediaOverlays.cta) {
        job.mediaOverlays = {
          ...(mediaOverlays.meat ? { meat: mediaOverlays.meat } : {}),
          ...(mediaOverlays.cta ? { cta: mediaOverlays.cta } : {})
        }
        job.mediaOverlayPosition = templateLayout.media
        job.meatDurationSec = combo.meat.duration
        if (!job.hookDurationSec) job.hookDurationSec = combo.hook.duration
      }

      if (autoCaptions && !captionlessComboIds.has(combo.id)) {
        const hookChunks = captionTranscripts.get(combo.hook.path)
        const meatChunks = captionTranscripts.get(combo.meat.path)
        const ctaChunks = captionTranscripts.get(combo.cta.path)
        if (hookChunks !== undefined && meatChunks !== undefined && ctaChunks !== undefined) {
          const { id: _id, label: _label, ...styleProps } = captionStyle
          job.captionData = {
            clipWordChunks: {
              [combo.hook.path]: hookChunks,
              [combo.meat.path]: meatChunks,
              [combo.cta.path]: ctaChunks
            },
            captionStyle: styleProps,
            captionPosition: templateLayout.subtitles,
            captionOffsetMs
          }
        }
      }

      return job
    })

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
      const firstDoneJob = finalProgress.find((r) => r.status === 'done')
      const firstFilePath = firstDoneJob
        ? jobs.find((j) => j.id === firstDoneJob.jobId)?.outputPath ?? null
        : null
      setBatchDestination({ directory: batchOutputDirectory, revealPath: firstFilePath })

      if (totalJobs > 0 && canceledCount > 0) {
        toast.info(`Canceled ${canceledCount} render${canceledCount === 1 ? '' : 's'}`)
      } else if (totalJobs > 0 && errorCount === 0) {
        toast.success(`${doneCount} video${doneCount === 1 ? '' : 's'} rendered`, {
          description: `Saved to ${batchOutputDirectory}`,
          action: firstFilePath
            ? {
                label: 'Reveal Output',
                onClick: () => window.api.showItemInFolder(firstFilePath)
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

  const knownClipIssues = findKnownClipPreflightIssues([...hooks, ...meats, ...ctas])
  const canRender =
    totalCombos > 0 &&
    Boolean(settings.outputDirectory) &&
    knownClipIssues.length === 0 &&
    !isRendering &&
    (!autoCaptions || whisperDevice !== 'detecting')

  // Exact reason the Render button is disabled (excluding the in-progress state),
  // surfaced via tooltip so first-run users know what to fix.
  const disabledReason =
    totalCombos === 0
      ? 'Add at least one Hook, Meat, and CTA'
      : knownClipIssues.length > 0
        ? `Relink, re-add, or remove ${knownClipIssues.length} missing or invalid clip${knownClipIssues.length === 1 ? '' : 's'} before rendering`
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

  const handleRetryFailedCaptions = (): void => {
    setCaptionDecision(null)
    void handleRender({ kind: 'prepare' })
  }

  const handleContinueWithoutCaptions = (): void => {
    if (captionDecision === null) return
    const approvedFailedPaths = [...captionDecision.failedPaths]
    const approvedAffectedComboIds = [...captionDecision.affectedComboIds]
    setCaptionDecision(null)
    void handleRender({
      kind: 'continue-without-captions',
      approvedFailedPaths,
      approvedAffectedComboIds
    })
  }

  // Build render count options
  const renderCountOptions = [1, 5, 10, 25, 50, 100].filter((n) => n <= totalCombos)

  return (
    <div className="border-t border-border bg-card px-6 py-3">
      <Dialog
        open={captionDecision !== null}
        onOpenChange={(open) => {
          if (!open) setCaptionDecision(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Auto Captions need attention</DialogTitle>
            <DialogDescription>
              {captionDecision ? formatCaptionFailureSummary(captionDecision.result) : ''}
            </DialogDescription>
          </DialogHeader>

          {captionDecision && (
            <div className="space-y-4 text-sm">
              <section aria-labelledby="clips-without-transcripts">
                <h3 id="clips-without-transcripts" className="mb-1 font-medium">
                  Clips without transcripts
                </h3>
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2">
                  {captionDecision.result.failures.map((failure) => (
                    <li key={failure.clip.path} className="grid gap-0.5">
                      <span className="font-medium">{failure.clip.name}</span>
                      <span className="text-xs text-muted-foreground">{failure.message}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-labelledby="outputs-without-captions">
                <h3 id="outputs-without-captions" className="mb-1 font-medium">
                  Affected outputs
                </h3>
                <p className="mb-2 text-muted-foreground">
                  {formatAffectedOutputsSummary(
                    captionDecision.affectedOutputNames.length,
                    captionDecision.totalOutputCount
                  )}{' '}
                  Outputs with complete transcripts will keep captions. No individual video will
                  receive partial captions.
                </p>
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
                  {captionDecision.affectedOutputNames.map((outputName) => (
                    <li key={outputName}>{outputName}</li>
                  ))}
                </ul>
              </section>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setCaptionDecision(null)}>
              Cancel
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={handleRetryFailedCaptions}>
                Retry Failed Clips
              </Button>
              <Button type="button" variant="destructive" onClick={handleContinueWithoutCaptions}>
                Continue Without Captions
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {batchDestination && (
        <output className="mb-3 flex items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium text-muted-foreground">Batch destination</div>
            <button
              type="button"
              title={batchDestination.directory}
              className="block max-w-full truncate text-left text-xs text-foreground hover:underline"
              onClick={() => window.api.openPath(batchDestination.directory)}
            >
              {batchDestination.directory}
            </button>
          </div>
          {batchDestination.revealPath && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              onClick={() => {
                const revealPath = batchDestination.revealPath
                if (revealPath) window.api.showItemInFolder(revealPath)
              }}
            >
              Reveal Output
            </Button>
          )}
        </output>
      )}

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
            <ShimmerButton onClick={() => void handleRender()} className="gap-2">
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
            <Button size="lg" onClick={() => void handleRender()} disabled={!canRender}>
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
