import { describe, expect, it, vi } from 'vitest'
import type { SourceFileSignaturesResult, WordChunk } from '../../../shared/types'
import {
  formatAffectedOutputsSummary,
  formatCaptionFailureSummary,
  prepareCaptionTranscripts,
  type RequiredCaptionClip,
  type TranscriptCache
} from './caption-preparation'

const clips: RequiredCaptionClip[] = [
  { path: '/clips/hook.mp4', name: 'hook.mp4' },
  { path: '/clips/meat.mp4', name: 'meat.mp4' },
  { path: '/clips/cta.mp4', name: 'cta.mp4' }
]

const chunks: WordChunk[] = [{ text: 'hello', start: 0, end: 0.5 }]

function signaturesFor(requestedPaths: string[], mtimeMs = 100): SourceFileSignaturesResult {
  return {
    signatures: requestedPaths.map((path) => ({ path, size: 1_000, mtimeMs })),
    unavailable: []
  }
}

function createSignatureReader() {
  return vi.fn(async (paths: string[]) => signaturesFor(paths))
}

function isCancellationError(): boolean {
  return false
}

describe('prepareCaptionTranscripts', () => {
  it('reports every required filename and caches nothing when model loading fails', async () => {
    const cache: TranscriptCache = new Map()
    const loadModel = vi.fn(async () => {
      throw new Error('model download unavailable')
    })
    const transcribeClip = vi.fn(async () => chunks)

    const result = await prepareCaptionTranscripts({
      clips,
      model: 'Xenova/whisper-tiny.en',
      cache,
      getSourceFileSignatures: createSignatureReader(),
      loadModel,
      transcribeClip,
      isCancellationError
    })

    expect(result.successCount).toBe(0)
    expect(result.failures.map((failure) => failure.clip.name)).toEqual([
      'cta.mp4',
      'hook.mp4',
      'meat.mp4'
    ])
    expect(result.failures.every((failure) => failure.kind === 'model')).toBe(true)
    expect(formatCaptionFailureSummary(result)).toBe(
      '0 of 3 required clips transcribed successfully. 3 failed: cta.mp4, hook.mp4, meat.mp4.'
    )
    expect(transcribeClip).not.toHaveBeenCalled()
    expect(cache.size).toBe(0)
  })

  it('counts only successful clips and identifies one partial transcription failure', async () => {
    const cache: TranscriptCache = new Map()
    const successfulProgressCounts: number[] = []
    const transcribeClip = vi.fn(async (clip: RequiredCaptionClip) => {
      if (clip.path === '/clips/meat.mp4') throw new Error('decoder crashed')
      return chunks
    })

    const result = await prepareCaptionTranscripts({
      clips,
      model: 'Xenova/whisper-tiny.en',
      cache,
      getSourceFileSignatures: createSignatureReader(),
      loadModel: vi.fn(async () => undefined),
      transcribeClip,
      isCancellationError,
      onProgress: (progress) => successfulProgressCounts.push(progress.successfulClips)
    })

    expect(result.successCount).toBe(2)
    expect(result.transcribedCount).toBe(2)
    expect(result.failures).toMatchObject([
      { clip: { name: 'meat.mp4' }, kind: 'transcription', message: 'decoder crashed' }
    ])
    expect(successfulProgressCounts).not.toContain(3)
    expect(cache.has('/clips/hook.mp4')).toBe(true)
    expect(cache.has('/clips/cta.mp4')).toBe(true)
    expect(cache.has('/clips/meat.mp4')).toBe(false)
  })

  it('retries only failed clips and renders all transcripts ready after retry success', async () => {
    const cache: TranscriptCache = new Map()
    const attempts = new Map<string, number>()
    const transcribeClip = vi.fn(async (clip: RequiredCaptionClip) => {
      const attempt = (attempts.get(clip.path) ?? 0) + 1
      attempts.set(clip.path, attempt)
      if (clip.path === '/clips/meat.mp4' && attempt === 1) {
        throw new Error('temporary decoder failure')
      }
      return chunks
    })
    const options = {
      clips,
      model: 'Xenova/whisper-tiny.en',
      cache,
      getSourceFileSignatures: createSignatureReader(),
      loadModel: vi.fn(async () => undefined),
      transcribeClip,
      isCancellationError
    }

    const firstResult = await prepareCaptionTranscripts(options)
    const retryResult = await prepareCaptionTranscripts(options)

    expect(firstResult.successCount).toBe(2)
    expect(retryResult.successCount).toBe(3)
    expect(retryResult.failures).toEqual([])
    expect(retryResult.transcribedCount).toBe(1)
    expect(transcribeClip).toHaveBeenCalledTimes(4)
    expect(attempts).toEqual(
      new Map([
        ['/clips/cta.mp4', 1],
        ['/clips/hook.mp4', 1],
        ['/clips/meat.mp4', 2]
      ])
    )
    expect(cache.size).toBe(3)
  })

  it('does not cache a successful transcript when its source changes during transcription', async () => {
    const clip = { path: '/clips/hook.mp4', name: 'hook.mp4' }
    const cache: TranscriptCache = new Map()
    let signatureRead = 0
    const getSourceFileSignatures = vi.fn(async (paths: string[]) => {
      signatureRead += 1
      return signaturesFor(paths, signatureRead === 1 ? 100 : 200)
    })

    const result = await prepareCaptionTranscripts({
      clips: [clip],
      model: 'Xenova/whisper-tiny.en',
      cache,
      getSourceFileSignatures,
      loadModel: vi.fn(async () => undefined),
      transcribeClip: vi.fn(async () => chunks),
      isCancellationError
    })

    expect(result.successCount).toBe(0)
    expect(result.failures).toMatchObject([
      {
        clip,
        kind: 'source',
        message: 'The source file changed during transcription. Retry this clip.'
      }
    ])
    expect(cache.size).toBe(0)
  })
})

describe('caption gate messages', () => {
  it('reports exact affected output counts', () => {
    expect(formatAffectedOutputsSummary(1, 3)).toBe(
      '1 of 3 outputs will render without captions; 2 will keep captions.'
    )
    expect(formatAffectedOutputsSummary(3, 3)).toBe('All 3 outputs will render without captions.')
  })
})
