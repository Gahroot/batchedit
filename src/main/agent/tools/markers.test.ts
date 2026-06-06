import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptCacheEntry } from '../transcript-cache'

const readTranscriptCache = vi.fn<(path: string, model?: string) => Promise<TranscriptCacheEntry | null>>()

vi.mock('../transcript-cache', () => ({
  readTranscriptCache: (path: string, model?: string) => readTranscriptCache(path, model)
}))

import { createDetectMarkersTool } from './markers'

const toolContext = { signal: new AbortController().signal } as never

describe('createDetectMarkersTool', () => {
  beforeEach(() => {
    readTranscriptCache.mockReset()
  })

  it('reads cached words by clipPath instead of taking words as input', async () => {
    readTranscriptCache.mockResolvedValue({
      full: 'Hook 1 buy now',
      words: [
        { text: 'Hook', start: 0, end: 0.4 },
        { text: '1', start: 0.4, end: 0.8 },
        { text: 'buy', start: 0.8, end: 1.2 },
        { text: 'now', start: 1.2, end: 1.6 }
      ]
    })

    const tool = createDetectMarkersTool()
    const raw = await tool.execute({ clipPath: '/tmp/source.mov' }, toolContext)

    expect(readTranscriptCache).toHaveBeenCalledWith('/tmp/source.mov', undefined)
    const parsed = JSON.parse(raw as string)
    expect(Array.isArray(parsed.markers)).toBe(true)
  })

  it('throws when no transcript is cached for the clipPath', async () => {
    readTranscriptCache.mockResolvedValue(null)

    const tool = createDetectMarkersTool()
    await expect(tool.execute({ clipPath: '/tmp/missing.mov' }, toolContext)).rejects.toThrow(
      /call transcribeClip first/
    )
  })
})
