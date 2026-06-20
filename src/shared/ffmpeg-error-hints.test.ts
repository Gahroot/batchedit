import { describe, it, expect } from 'vitest'
import { humanizeFfmpegError } from './ffmpeg-error-hints'

describe('humanizeFfmpegError', () => {
  it('preserves the raw text verbatim', () => {
    const raw = 'some\nmulti-line\nffmpeg dump'
    expect(humanizeFfmpegError(raw).raw).toBe(raw)
  })

  it.each([
    ['no space left on device', 'disk is full'],
    ['ENOSPC: write failed', 'disk is full'],
    ['clip.mp4: No such file or directory', 'missing or was moved'],
    ['ENOENT, open /tmp/x.mp4', 'missing or was moved'],
    ['Permission denied', 'permissions'],
    ['Output file does not contain any stream', 'no usable video or audio'],
    ['Decoder (codec hevc) not found for input stream', "can't read"],
    ['Unknown codec foobar', "can't read"],
    ['moov atom not found', 'damaged or incomplete'],
    ['clip.mp4: Invalid data found when processing input', 'may be corrupt'],
  ])('maps %j to an actionable hint containing %j', (raw, expectedFragment) => {
    const { hint } = humanizeFfmpegError(raw)
    expect(hint.toLowerCase()).toContain(expectedFragment.toLowerCase())
  })

  it('matches signatures case-insensitively within a full stderr dump', () => {
    const raw =
      'ffmpeg version 6.0\n[in#0] Error opening input: No Space Left On Device\nConversion failed!'
    expect(humanizeFfmpegError(raw).hint.toLowerCase()).toContain('disk is full')
  })

  it('applies the prefix only when a signature matches', () => {
    const matched = humanizeFfmpegError('No space left on device', 'Normalization failed')
    expect(matched.hint).toMatch(/^Normalization failed: /)
  })

  it('falls back to a generic, actionable hint for unknown errors', () => {
    const { hint, raw } = humanizeFfmpegError('totally unrecognized gibberish error', 'Normalization failed')
    // Generic hint should NOT carry the prefix, and should point at Copy for details.
    expect(hint).not.toMatch(/^Normalization failed: /)
    expect(hint.toLowerCase()).toContain('copy')
    expect(raw).toBe('totally unrecognized gibberish error')
  })

  it('handles empty input without throwing', () => {
    expect(humanizeFfmpegError('').raw).toBe('')
    expect(humanizeFfmpegError('').hint.length).toBeGreaterThan(0)
  })
})
