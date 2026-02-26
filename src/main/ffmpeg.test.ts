import { describe, it, expect } from 'vitest'
import { parseSilenceEnd } from './ffmpeg'

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
