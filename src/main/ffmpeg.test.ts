import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { detectSilenceBounds, parseSilenceEnd, parseSilenceStart, setupFFmpeg } from './ffmpeg'

describe('parseSilenceEnd', () => {
  it('extracts silence_end from a valid FFmpeg line', () => {
    expect(
      parseSilenceEnd('[silencedetect @ 0x...] silence_end: 0.512 | silence_duration: 0.512')
    ).toBe(0.512)
  })

  it('returns null for non-matching lines', () => {
    expect(parseSilenceEnd('[silencedetect @ 0x...] silence_start: 0')).toBeNull()
    expect(parseSilenceEnd('frame= 100 fps=30 q=28.0 size= 256kB')).toBeNull()
    expect(parseSilenceEnd('')).toBeNull()
  })

  it('handles integer values', () => {
    expect(parseSilenceEnd('silence_end: 3 | silence_duration: 3')).toBe(3)
  })

  it('handles zero values', () => {
    expect(parseSilenceEnd('silence_end: 0 | silence_duration: 0')).toBe(0)
  })

  it('handles large decimal values', () => {
    expect(parseSilenceEnd('silence_end: 12.345678 | silence_duration: 12.345678')).toBe(12.345678)
  })
})

describe('parseSilenceStart', () => {
  it('extracts silence_start from a valid FFmpeg line', () => {
    expect(
      parseSilenceStart('[silencedetect @ 0x...] silence_start: 0')
    ).toBe(0)
  })

  it('extracts non-zero silence_start', () => {
    expect(
      parseSilenceStart('[silencedetect @ 0x...] silence_start: 1.823')
    ).toBe(1.823)
  })

  it('returns null for silence_end lines', () => {
    expect(
      parseSilenceStart('silence_end: 0.512 | silence_duration: 0.512')
    ).toBeNull()
  })

  it('returns null for non-matching lines', () => {
    expect(parseSilenceStart('frame= 100 fps=30 q=28.0 size= 256kB')).toBeNull()
    expect(parseSilenceStart('')).toBeNull()
  })
})

describe('detectSilenceBounds', () => {
  it('rejects an FFmpeg command failure instead of reporting no silence', async () => {
    setupFFmpeg()
    const missingInput = join(tmpdir(), `batchedit-missing-${randomUUID()}.mp4`)

    await expect(detectSilenceBounds(missingInput)).rejects.toThrow()
  })
})
