import type {
  SourceFileSignature,
  SourceFileSignaturesResult,
  WordChunk
} from '../../../shared/types'

export interface RequiredCaptionClip {
  path: string
  name: string
}

export interface TranscriptCacheEntry {
  model: string
  signature: SourceFileSignature
  wordChunks: WordChunk[]
}

export type TranscriptCache = Map<string, TranscriptCacheEntry>

export type CaptionClipFailureKind = 'model' | 'source' | 'transcription'

export interface CaptionClipFailure {
  clip: RequiredCaptionClip
  kind: CaptionClipFailureKind
  message: string
}

export interface CaptionCacheInspection {
  transcripts: Map<string, WordChunk[]>
  pendingClips: RequiredCaptionClip[]
  unavailableClips: RequiredCaptionClip[]
  signatures: Map<string, SourceFileSignature>
}

export interface CaptionPreparationProgress {
  stage: 'loading-model' | 'transcribing'
  currentClip: string
  successfulClips: number
  totalClips: number
}

export interface CaptionPreparationResult {
  transcripts: Map<string, WordChunk[]>
  failures: CaptionClipFailure[]
  successCount: number
  totalCount: number
  transcribedCount: number
  modelLoaded: boolean
}

interface InspectTranscriptCacheOptions {
  clips: readonly RequiredCaptionClip[]
  model: string
  cache: TranscriptCache
  getSourceFileSignatures: (paths: string[]) => Promise<SourceFileSignaturesResult>
}

interface PrepareCaptionTranscriptsOptions extends InspectTranscriptCacheOptions {
  loadModel: (model: string) => Promise<void>
  transcribeClip: (clip: RequiredCaptionClip) => Promise<WordChunk[]>
  isCancellationError: (error: unknown) => boolean
  onProgress?: (progress: CaptionPreparationProgress) => void
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function getUniqueCaptionClips(
  clips: readonly RequiredCaptionClip[]
): RequiredCaptionClip[] {
  const uniqueByPath = new Map<string, RequiredCaptionClip>()
  for (const clip of clips) {
    if (!uniqueByPath.has(clip.path)) uniqueByPath.set(clip.path, clip)
  }

  return Array.from(uniqueByPath.values()).sort(
    (left, right) => compareStrings(left.name, right.name) || compareStrings(left.path, right.path)
  )
}

function isValidSignature(signature: SourceFileSignature): boolean {
  return (
    typeof signature.path === 'string' &&
    Number.isFinite(signature.size) &&
    signature.size >= 0 &&
    Number.isFinite(signature.mtimeMs) &&
    signature.mtimeMs >= 0
  )
}

function indexSignatures(result: SourceFileSignaturesResult): Map<string, SourceFileSignature> {
  const signatures = new Map<string, SourceFileSignature>()
  for (const signature of result.signatures) {
    if (isValidSignature(signature)) signatures.set(signature.path, signature)
  }
  return signatures
}

function signaturesMatch(left: SourceFileSignature, right: SourceFileSignature): boolean {
  return left.path === right.path && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function inspectTranscriptCache({
  clips,
  model,
  cache,
  getSourceFileSignatures
}: InspectTranscriptCacheOptions): Promise<CaptionCacheInspection> {
  const uniqueClips = getUniqueCaptionClips(clips)
  const result = await getSourceFileSignatures(uniqueClips.map((clip) => clip.path))
  const signatures = indexSignatures(result)
  const explicitlyUnavailable = new Set(result.unavailable)
  const transcripts = new Map<string, WordChunk[]>()
  const pendingClips: RequiredCaptionClip[] = []
  const unavailableClips: RequiredCaptionClip[] = []

  for (const clip of uniqueClips) {
    const signature = signatures.get(clip.path)
    if (signature === undefined || explicitlyUnavailable.has(clip.path)) {
      cache.delete(clip.path)
      pendingClips.push(clip)
      unavailableClips.push(clip)
      continue
    }

    const cached = cache.get(clip.path)
    if (
      cached !== undefined &&
      cached.model === model &&
      signaturesMatch(cached.signature, signature)
    ) {
      transcripts.set(clip.path, cached.wordChunks)
      continue
    }

    cache.delete(clip.path)
    pendingClips.push(clip)
  }

  return { transcripts, pendingClips, unavailableClips, signatures }
}

function createSourceVerificationFailures(
  clips: readonly RequiredCaptionClip[],
  message: string
): CaptionClipFailure[] {
  return getUniqueCaptionClips(clips).map((clip) => ({ clip, kind: 'source', message }))
}

export async function prepareCaptionTranscripts({
  clips,
  model,
  cache,
  getSourceFileSignatures,
  loadModel,
  transcribeClip,
  isCancellationError,
  onProgress
}: PrepareCaptionTranscriptsOptions): Promise<CaptionPreparationResult> {
  const uniqueClips = getUniqueCaptionClips(clips)
  let inspection: CaptionCacheInspection

  try {
    inspection = await inspectTranscriptCache({
      clips: uniqueClips,
      model,
      cache,
      getSourceFileSignatures
    })
  } catch (error) {
    return {
      transcripts: new Map(),
      failures: createSourceVerificationFailures(
        uniqueClips,
        `Could not verify the source file: ${errorMessage(error)}`
      ),
      successCount: 0,
      totalCount: uniqueClips.length,
      transcribedCount: 0,
      modelLoaded: false
    }
  }

  const failuresByPath = new Map<string, CaptionClipFailure>()
  for (const clip of inspection.unavailableClips) {
    failuresByPath.set(clip.path, {
      clip,
      kind: 'source',
      message: 'The source file is unavailable.'
    })
  }

  const transcribableClips = inspection.pendingClips.filter(
    (clip) => !failuresByPath.has(clip.path)
  )
  let modelLoaded = false
  let transcribedCount = 0

  if (transcribableClips.length > 0) {
    onProgress?.({
      stage: 'loading-model',
      currentClip: '',
      successfulClips: inspection.transcripts.size,
      totalClips: uniqueClips.length
    })

    try {
      await loadModel(model)
      modelLoaded = true
    } catch (error) {
      if (isCancellationError(error)) throw error
      const message = `Whisper model failed to load: ${errorMessage(error)}`
      for (const clip of transcribableClips) {
        failuresByPath.set(clip.path, { clip, kind: 'model', message })
      }
    }
  }

  if (modelLoaded) {
    for (const clip of transcribableClips) {
      onProgress?.({
        stage: 'transcribing',
        currentClip: clip.name,
        successfulClips: inspection.transcripts.size + transcribedCount,
        totalClips: uniqueClips.length
      })

      try {
        const wordChunks = await transcribeClip(clip)
        const currentResult = await getSourceFileSignatures([clip.path])
        const currentSignature = indexSignatures(currentResult).get(clip.path)
        const startingSignature = inspection.signatures.get(clip.path)
        if (
          currentSignature === undefined ||
          startingSignature === undefined ||
          !signaturesMatch(startingSignature, currentSignature)
        ) {
          cache.delete(clip.path)
          failuresByPath.set(clip.path, {
            clip,
            kind: 'source',
            message: 'The source file changed during transcription. Retry this clip.'
          })
          continue
        }

        cache.set(clip.path, {
          model,
          signature: currentSignature,
          wordChunks: wordChunks.map((chunk) => ({ ...chunk }))
        })
        transcribedCount += 1
      } catch (error) {
        if (isCancellationError(error)) throw error
        cache.delete(clip.path)
        failuresByPath.set(clip.path, {
          clip,
          kind: 'transcription',
          message: errorMessage(error)
        })
      }
    }
  }

  let finalInspection: CaptionCacheInspection
  try {
    finalInspection = await inspectTranscriptCache({
      clips: uniqueClips,
      model,
      cache,
      getSourceFileSignatures
    })
  } catch (error) {
    return {
      transcripts: new Map(),
      failures: createSourceVerificationFailures(
        uniqueClips,
        `Could not verify the source file after transcription: ${errorMessage(error)}`
      ),
      successCount: 0,
      totalCount: uniqueClips.length,
      transcribedCount,
      modelLoaded
    }
  }

  const unavailablePaths = new Set(finalInspection.unavailableClips.map((clip) => clip.path))
  for (const clip of finalInspection.pendingClips) {
    if (failuresByPath.has(clip.path)) continue
    failuresByPath.set(clip.path, {
      clip,
      kind: 'source',
      message: unavailablePaths.has(clip.path)
        ? 'The source file is unavailable.'
        : 'A source-current transcript is not available. Retry this clip.'
    })
  }

  const failures = uniqueClips.flatMap((clip) => {
    const failure = failuresByPath.get(clip.path)
    return failure === undefined || finalInspection.transcripts.has(clip.path) ? [] : [failure]
  })

  return {
    transcripts: finalInspection.transcripts,
    failures,
    successCount: finalInspection.transcripts.size,
    totalCount: uniqueClips.length,
    transcribedCount,
    modelLoaded
  }
}

export function formatCaptionFailureSummary(result: CaptionPreparationResult): string {
  const failureNames = result.failures.map((failure) => failure.clip.name).join(', ')
  const clipNoun = result.totalCount === 1 ? 'clip' : 'clips'
  return `${result.successCount} of ${result.totalCount} required ${clipNoun} transcribed successfully. ${result.failures.length} failed: ${failureNames}.`
}

export function formatAffectedOutputsSummary(affectedCount: number, totalCount: number): string {
  const outputNoun = totalCount === 1 ? 'output' : 'outputs'
  if (affectedCount === totalCount) {
    return `All ${totalCount} ${outputNoun} will render without captions.`
  }

  const captionedCount = totalCount - affectedCount
  return `${affectedCount} of ${totalCount} ${outputNoun} will render without captions; ${captionedCount} will keep captions.`
}
