import { describe, it, expect } from 'vitest'
import {
  formatAssTimestamp,
  generateAssFile,
  generateWordHighlightAssFile,
  generateCombinedAssFile
} from './render-pipeline'

// ---------------------------------------------------------------------------
// formatAssTimestamp
// ---------------------------------------------------------------------------
describe('formatAssTimestamp', () => {
  it('formats 0ms as 0:00:00.00', () => {
    expect(formatAssTimestamp(0)).toBe('0:00:00.00')
  })

  it('formats 1000ms as 0:00:01.00', () => {
    expect(formatAssTimestamp(1000)).toBe('0:00:01.00')
  })

  it('formats 61000ms as 0:01:01.00', () => {
    expect(formatAssTimestamp(61000)).toBe('0:01:01.00')
  })

  it('formats 3661000ms as 1:01:01.00', () => {
    expect(formatAssTimestamp(3661000)).toBe('1:01:01.00')
  })

  it('formats 500ms as 0:00:00.50', () => {
    expect(formatAssTimestamp(500)).toBe('0:00:00.50')
  })

  it('formats 1234ms with correct centisecond floor (12cs)', () => {
    // 1234ms -> 1s + 234ms -> 234ms / 10 = 23.4 -> floor = 23cs
    expect(formatAssTimestamp(1234)).toBe('0:00:01.23')
  })

  it('formats 10ms as 0:00:00.01', () => {
    expect(formatAssTimestamp(10)).toBe('0:00:00.01')
  })

  it('formats 99ms as 0:00:00.09 (floor of 99/10 = 9)', () => {
    expect(formatAssTimestamp(99)).toBe('0:00:00.09')
  })

  it('pads minutes and seconds to 2 digits', () => {
    expect(formatAssTimestamp(5000)).toBe('0:00:05.00')
    expect(formatAssTimestamp(300000)).toBe('0:05:00.00')
  })

  it('does not pad hours', () => {
    // Hours are single-digit when < 10
    expect(formatAssTimestamp(3600000)).toBe('1:00:00.00')
  })

  it('handles large hour values', () => {
    // 10 hours = 36000000ms
    expect(formatAssTimestamp(36000000)).toBe('10:00:00.00')
  })
})

// ---------------------------------------------------------------------------
// generateAssFile
// ---------------------------------------------------------------------------
describe('generateAssFile', () => {
  const resolution = { width: 1920, height: 1080 }

  it('produces valid ASS with no Dialogue lines for empty captions', () => {
    const result = generateAssFile([], resolution)

    expect(result).toContain('[Script Info]')
    expect(result).toContain('[V4+ Styles]')
    expect(result).toContain('[Events]')
    expect(result).not.toContain('Dialogue:')
  })

  it('sets PlayResX and PlayResY from resolution', () => {
    const result = generateAssFile([], { width: 1080, height: 1920 })

    expect(result).toContain('PlayResX: 1080')
    expect(result).toContain('PlayResY: 1920')
  })

  it('generates correct dialogue for a single caption', () => {
    const captions = [{ text: 'Hello world', start: 0, end: 2000 }]
    const result = generateAssFile(captions, resolution)

    expect(result).toContain('Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Hello world')
  })

  it('generates all dialogue lines in order for multiple captions', () => {
    const captions = [
      { text: 'First', start: 0, end: 1000 },
      { text: 'Second', start: 1000, end: 2000 },
      { text: 'Third', start: 2000, end: 3000 }
    ]
    const result = generateAssFile(captions, resolution)
    const lines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('First')
    expect(lines[1]).toContain('Second')
    expect(lines[2]).toContain('Third')
  })

  it('replaces newlines in text with \\N', () => {
    const captions = [{ text: 'Line one\nLine two', start: 0, end: 1000 }]
    const result = generateAssFile(captions, resolution)

    expect(result).toContain('Line one\\NLine two')
    expect(result).not.toContain('Line one\nLine two')
  })

  it('uses font size of ~4% of resolution height', () => {
    // 1080 * 0.04 = 43.2 -> rounds to 43
    const result = generateAssFile([], { width: 1920, height: 1080 })
    expect(result).toContain(`Arial,${Math.round(1080 * 0.04)},`)

    // 1920 * 0.04 = 76.8 -> rounds to 77
    const result2 = generateAssFile([], { width: 1080, height: 1920 })
    expect(result2).toContain(`Arial,${Math.round(1920 * 0.04)},`)
  })

  it('uses MarginV of ~5% of resolution height', () => {
    // 1080 * 0.05 = 54
    const result = generateAssFile([], { width: 1920, height: 1080 })
    expect(result).toContain(`,${Math.round(1080 * 0.05)},1`)

    // 1920 * 0.05 = 96
    const result2 = generateAssFile([], { width: 1080, height: 1920 })
    expect(result2).toContain(`,${Math.round(1920 * 0.05)},1`)
  })

  it('includes both Default and Highlight styles', () => {
    const result = generateAssFile([], resolution)

    expect(result).toContain('Style: Default,')
    expect(result).toContain('Style: Highlight,')
  })
})

// ---------------------------------------------------------------------------
// generateWordHighlightAssFile
// ---------------------------------------------------------------------------
describe('generateWordHighlightAssFile', () => {
  const resolution = { width: 1080, height: 1920 }

  it('groups words into lines of 4', () => {
    const words = [
      { text: 'one', start: 0, end: 0.5 },
      { text: 'two', start: 0.5, end: 1 },
      { text: 'three', start: 1, end: 1.5 },
      { text: 'four', start: 1.5, end: 2 },
      { text: 'five', start: 2, end: 2.5 },
      { text: 'six', start: 2.5, end: 3 },
      { text: 'seven', start: 3, end: 3.5 },
      { text: 'eight', start: 3.5, end: 4 }
    ]
    const result = generateWordHighlightAssFile(words, resolution)
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    expect(dialogueLines).toHaveLength(2)
  })

  it('puts fewer than 4 words on a single line', () => {
    const words = [
      { text: 'hello', start: 0, end: 0.5 },
      { text: 'world', start: 0.5, end: 1 }
    ]
    const result = generateWordHighlightAssFile(words, resolution)
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    expect(dialogueLines).toHaveLength(1)
    expect(dialogueLines[0]).toContain('hello')
    expect(dialogueLines[0]).toContain('world')
  })

  it('handles exact multiple of 4 words', () => {
    const words = [
      { text: 'a', start: 0, end: 0.25 },
      { text: 'b', start: 0.25, end: 0.5 },
      { text: 'c', start: 0.5, end: 0.75 },
      { text: 'd', start: 0.75, end: 1 }
    ]
    const result = generateWordHighlightAssFile(words, resolution)
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    expect(dialogueLines).toHaveLength(1)
  })

  it('produces karaoke \\kf tags with correct centisecond durations', () => {
    // Each word is 0.5 seconds = 50 centiseconds
    const words = [
      { text: 'hello', start: 0, end: 0.5 },
      { text: 'world', start: 0.5, end: 1.0 }
    ]
    const result = generateWordHighlightAssFile(words, resolution)

    expect(result).toContain('{\\kf50}hello')
    expect(result).toContain('{\\kf50}world')
  })

  it('calculates line start/end from first/last word times (converted to ms)', () => {
    const words = [
      { text: 'hello', start: 1.0, end: 1.5 },
      { text: 'world', start: 1.5, end: 2.0 }
    ]
    const result = generateWordHighlightAssFile(words, resolution)

    // start = 1.0 * 1000 = 1000ms -> 0:00:01.00
    // end   = 2.0 * 1000 = 2000ms -> 0:00:02.00
    expect(result).toContain('0:00:01.00,0:00:02.00')
  })

  it('uses font size of 5% of resolution height', () => {
    // 1920 * 0.05 = 96
    const result = generateWordHighlightAssFile([], resolution)
    expect(result).toContain(`Arial,${Math.round(1920 * 0.05)},`)
  })

  it('uses MarginV of 5% of resolution height', () => {
    const result = generateWordHighlightAssFile([], resolution)
    expect(result).toContain(`,${Math.round(1920 * 0.05)},1`)
  })

  it('produces valid ASS with no Dialogue for empty chunks', () => {
    const result = generateWordHighlightAssFile([], resolution)

    expect(result).toContain('[Script Info]')
    expect(result).toContain('[Events]')
    expect(result).not.toContain('Dialogue:')
  })

  it('uses Karaoke style for dialogue lines', () => {
    const words = [{ text: 'test', start: 0, end: 1 }]
    const result = generateWordHighlightAssFile(words, resolution)

    expect(result).toContain('Style: Karaoke,')
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogueLines[0]).toContain(',Karaoke,')
  })

  it('joins words within a line with spaces', () => {
    const words = [
      { text: 'one', start: 0, end: 0.5 },
      { text: 'two', start: 0.5, end: 1 }
    ]
    const result = generateWordHighlightAssFile(words, resolution)

    // Words joined with space: {\\kf50}one {\\kf50}two
    expect(result).toContain('}one {\\kf')
  })
})

// ---------------------------------------------------------------------------
// generateCombinedAssFile
// ---------------------------------------------------------------------------
describe('generateCombinedAssFile', () => {
  const resolution = { width: 1080, height: 1920 }

  it('produces valid ASS for empty segments array', () => {
    const result = generateCombinedAssFile([], resolution)

    expect(result).toContain('[Script Info]')
    expect(result).toContain('[Events]')
    expect(result).not.toContain('Dialogue:')
  })

  it('handles a single segment with offset 0', () => {
    const segments = [
      {
        wordChunks: [
          { text: 'hello', start: 0, end: 0.5 },
          { text: 'world', start: 0.5, end: 1.0 }
        ],
        offsetMs: 0
      }
    ]
    const result = generateCombinedAssFile(segments, resolution)
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    expect(dialogueLines).toHaveLength(1)
    // With offset 0, times stay at 0.0s and 1.0s -> 0ms and 1000ms
    expect(dialogueLines[0]).toContain('0:00:00.00,0:00:01.00')
  })

  it('applies cumulative offsets to multiple segments', () => {
    // generateCombinedAssFile flattens all chunks then groups by 4 words.
    // 2 total words = 1 dialogue line spanning from first word start to last word end.
    const segments = [
      {
        wordChunks: [{ text: 'first', start: 0, end: 1.0 }],
        offsetMs: 0
      },
      {
        wordChunks: [{ text: 'second', start: 0, end: 1.0 }],
        offsetMs: 5000 // 5 second offset
      }
    ]
    const result = generateCombinedAssFile(segments, resolution)
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    // Both words fit in a single 4-word group
    expect(dialogueLines).toHaveLength(1)
    // Line spans from first word (0s) to second word (5+1=6s)
    expect(dialogueLines[0]).toContain('0:00:00.00,0:00:06.00')
    // Both words present with karaoke tags
    expect(dialogueLines[0]).toContain('first')
    expect(dialogueLines[0]).toContain('second')
  })

  it('correctly offsets word timestamps for karaoke durations', () => {
    const segments = [
      {
        wordChunks: [
          { text: 'word1', start: 0, end: 0.5 },
          { text: 'word2', start: 0.5, end: 1.0 }
        ],
        offsetMs: 10000 // 10 second offset
      }
    ]
    const result = generateCombinedAssFile(segments, resolution)

    // Offset is 10s -> start at 10.0s, end at 11.0s
    // -> 10000ms = 0:00:10.00, 11000ms = 0:00:11.00
    expect(result).toContain('0:00:10.00,0:00:11.00')
    // Karaoke durations should still be 50cs each (0.5s)
    expect(result).toContain('{\\kf50}word1')
    expect(result).toContain('{\\kf50}word2')
  })

  it('combines chunks from multiple segments into 4-word groupings', () => {
    const segments = [
      {
        wordChunks: [
          { text: 'a', start: 0, end: 0.5 },
          { text: 'b', start: 0.5, end: 1.0 },
          { text: 'c', start: 1.0, end: 1.5 }
        ],
        offsetMs: 0
      },
      {
        wordChunks: [
          { text: 'd', start: 0, end: 0.5 },
          { text: 'e', start: 0.5, end: 1.0 }
        ],
        offsetMs: 2000
      }
    ]
    const result = generateCombinedAssFile(segments, resolution)
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    // 5 words total -> 1 line of 4 + 1 line of 1
    expect(dialogueLines).toHaveLength(2)
    // First line contains a, b, c, d
    expect(dialogueLines[0]).toContain('}a')
    expect(dialogueLines[0]).toContain('}b')
    expect(dialogueLines[0]).toContain('}c')
    expect(dialogueLines[0]).toContain('}d')
    // Second line contains e
    expect(dialogueLines[1]).toContain('}e')
  })

  it('handles segment with empty wordChunks', () => {
    const segments = [
      { wordChunks: [], offsetMs: 0 },
      {
        wordChunks: [{ text: 'hello', start: 0, end: 1.0 }],
        offsetMs: 5000
      }
    ]
    const result = generateCombinedAssFile(segments, resolution)
    const dialogueLines = result.split('\n').filter((l) => l.startsWith('Dialogue:'))

    expect(dialogueLines).toHaveLength(1)
    expect(dialogueLines[0]).toContain('hello')
  })
})
