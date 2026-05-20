import { describe, it, expect } from 'vitest'
import { detectMarkers, WhisperChunk } from './marker-detection'

/** Helper: build a word chunk at given index position with timing based on index */
function chunk(text: string, idx: number): WhisperChunk {
  return { text, start: idx, end: idx + 0.5 }
}

describe('detectMarkers — retake deduplication', () => {
  it('two "Hook 1" markers → only the second one kept', () => {
    const chunks: WhisperChunk[] = [
      chunk('hook', 0),   // 0
      chunk('1', 1),      // 1 — first Hook 1 marker
      chunk('bad', 2),    // 2 — bad take content
      chunk('take', 3),   // 3 — bad take content
      chunk('hook', 4),   // 4
      chunk('1', 5),      // 5 — second Hook 1 marker (retake)
      chunk('good', 6),   // 6 — good content
      chunk('stuff', 7),  // 7 — good content
    ]

    const result = detectMarkers(chunks, 10)
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('Hook 1')
    // Content starts after the second marker phrase (chunk 6)
    expect(result[0].startTime).toBe(6)
    // End time = last content word end (7.5) + 0.1 buffer (gap to videoDuration=10 > 0.5) = 7.6
    expect(result[0].endTime).toBe(7.6)
  })

  it('three "Hook 1" markers → only the last one kept', () => {
    const chunks: WhisperChunk[] = [
      chunk('hook', 0),
      chunk('1', 1),
      chunk('bad1', 2),
      chunk('hook', 3),
      chunk('1', 4),
      chunk('bad2', 5),
      chunk('hook', 6),
      chunk('1', 7),
      chunk('final', 8),
    ]

    const result = detectMarkers(chunks, 12)
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('Hook 1')
    expect(result[0].startTime).toBe(8)
  })

  it('"Hook 1" then "Meat 1" → both kept (different labels)', () => {
    const chunks: WhisperChunk[] = [
      chunk('hook', 0),
      chunk('1', 1),
      chunk('content', 2),
      chunk('meat', 3),
      chunk('1', 4),
      chunk('more', 5),
    ]

    const result = detectMarkers(chunks, 10)
    expect(result).toHaveLength(2)
    expect(result[0].label).toBe('Hook 1')
    expect(result[1].label).toBe('Meat 1')
  })

  it('previous marker end time does not extend into bad-take content', () => {
    // Hook 1 [good content] Hook 2 [bad take] Hook 2 [good take]
    const chunks: WhisperChunk[] = [
      chunk('hook', 0),
      chunk('1', 1),
      chunk('good', 2),     // Hook 1 content
      chunk('words', 3),    // Hook 1 content — should be the last content word for Hook 1
      chunk('hook', 4),
      chunk('2', 5),        // first Hook 2 (bad)
      chunk('bad', 6),      // bad take content — should be poisoned
      chunk('stuff', 7),    // bad take content — should be poisoned
      chunk('hook', 8),
      chunk('2', 9),        // second Hook 2 (kept)
      chunk('real', 10),    // good content
    ]

    const result = detectMarkers(chunks, 15)
    expect(result).toHaveLength(2)
    expect(result[0].label).toBe('Hook 1')
    expect(result[1].label).toBe('Hook 2')

    // Hook 1's end time should stop at "words" (chunk 3), not extend into bad take
    // End = chunk 3 end (3.5) + 0.1 buffer (gap to next marker at 8 > 0.5) = 3.6
    expect(result[0].endTime).toBe(3.6)

    // Hook 2 (kept) starts at chunk 10
    expect(result[1].startTime).toBe(10)
  })

  it('mixed retakes: "Hook 1", "Hook 2", "Hook 1" retake → keeps Hook 2 and second Hook 1', () => {
    const chunks: WhisperChunk[] = [
      chunk('hook', 0),
      chunk('1', 1),       // first Hook 1 (will be removed)
      chunk('bad', 2),
      chunk('hook', 3),
      chunk('2', 4),       // Hook 2 (kept)
      chunk('content2', 5),
      chunk('hook', 6),
      chunk('1', 7),       // second Hook 1 (retake — kept)
      chunk('content1', 8),
    ]

    const result = detectMarkers(chunks, 12)
    expect(result).toHaveLength(2)
    // Sorted by position: Hook 2 comes first (chunk 3), then Hook 1 retake (chunk 6)
    expect(result[0].label).toBe('Hook 2')
    expect(result[1].label).toBe('Hook 1')
  })

  it('no duplicates → nothing removed', () => {
    const chunks: WhisperChunk[] = [
      chunk('hook', 0),
      chunk('1', 1),
      chunk('a', 2),
      chunk('hook', 3),
      chunk('2', 4),
      chunk('b', 5),
      chunk('meat', 6),
      chunk('1', 7),
      chunk('c', 8),
    ]

    const result = detectMarkers(chunks, 12)
    expect(result).toHaveLength(3)
    expect(result[0].label).toBe('Hook 1')
    expect(result[1].label).toBe('Hook 2')
    expect(result[2].label).toBe('Meat 1')
  })
})

describe('detectMarkers — adaptive end time buffer', () => {
  it('caps end time at next marker start when buffer would overshoot', () => {
    // Gap between content end and next marker is only 0.1s — buffer (0.2) would overshoot
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.5 },
      { text: '1', start: 1, end: 1.5 },
      { text: 'content', start: 2, end: 2.9 },   // content ends at 2.9
      { text: 'hook', start: 3, end: 3.5 },       // next marker starts at 3.0 (gap = 0.1)
      { text: '2', start: 4, end: 4.5 },
      { text: 'more', start: 5, end: 5.5 },
    ]

    const result = detectMarkers(chunks, 10)
    expect(result).toHaveLength(2)
    // Hook 1 endTime should be capped at nextMarkerStart (3.0), not 2.9 + 0.2 = 3.1
    expect(result[0].endTime).toBe(3.0)
  })

  it('uses 0.1s buffer when silence gap > 0.5s', () => {
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.5 },
      { text: '1', start: 1, end: 1.5 },
      { text: 'content', start: 2, end: 2.5 },   // content ends at 2.5
      { text: 'hook', start: 5, end: 5.5 },       // next marker at 5.0 (gap = 2.5 > 0.5)
      { text: '2', start: 6, end: 6.5 },
      { text: 'stuff', start: 7, end: 7.5 },
    ]

    const result = detectMarkers(chunks, 10)
    expect(result).toHaveLength(2)
    // Large gap → 0.1s buffer: 2.5 + 0.1 = 2.6
    expect(result[0].endTime).toBe(2.6)
  })

  it('uses 0.2s buffer when silence gap <= 0.5s', () => {
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.5 },
      { text: '1', start: 1, end: 1.5 },
      { text: 'content', start: 2, end: 2.5 },   // content ends at 2.5
      { text: 'hook', start: 2.8, end: 3.3 },     // next marker at 2.8 (gap = 0.3 <= 0.5)
      { text: '2', start: 3.5, end: 4.0 },
      { text: 'stuff', start: 4.5, end: 5.0 },
    ]

    const result = detectMarkers(chunks, 10)
    expect(result).toHaveLength(2)
    // Small gap → 0.2s buffer, but 2.5 + 0.2 = 2.7 < nextMarkerStart 2.8 → 2.7
    expect(result[0].endTime).toBe(2.7)
  })

  it('last clip gets tight end time, not videoDuration', () => {
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.5 },
      { text: '1', start: 1, end: 1.5 },
      { text: 'content', start: 2, end: 5.0 },   // content ends at 5.0
    ]

    const result = detectMarkers(chunks, 30)
    expect(result).toHaveLength(1)
    // Last clip: nextMarkerStart = videoDuration (30), gap = 25 > 0.5 → 0.1s buffer
    // endTime = 5.0 + 0.1 = 5.1
    expect(result[0].endTime).toBe(5.1)
  })

  it('gap exactly 0.5s uses 0.2s buffer (not > 0.5 threshold)', () => {
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.5 },
      { text: '1', start: 1, end: 1.5 },
      { text: 'content', start: 2, end: 2.5 },   // content ends at 2.5
      { text: 'hook', start: 3.0, end: 3.5 },     // next marker at 3.0 (gap = 0.5, exactly at threshold)
      { text: '2', start: 4, end: 4.5 },
      { text: 'stuff', start: 5, end: 5.5 },
    ]

    const result = detectMarkers(chunks, 10)
    expect(result).toHaveLength(2)
    // Gap = 0.5, NOT > 0.5 → 0.2s buffer: 2.5 + 0.2 = 2.7
    expect(result[0].endTime).toBe(2.7)
  })
})

describe('detectMarkers — no-content fallback', () => {
  it('no content words between markers → endTime extends to next marker boundary', () => {
    // Hook 1 (bad take) → [poisoned] → Hook 2 → [poisoned] → Hook 1 (retake) → good content
    // After dedup: first Hook 1 removed, poison covers indices 0–5.
    // Hook 2 has no non-poisoned content words before Hook 1 retake.
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.3 },       // 0 - first Hook 1 (removed)
      { text: '1', start: 0.5, end: 0.8 },         // 1
      { text: 'bad', start: 1.0, end: 1.5 },       // 2 - poisoned
      { text: 'hook', start: 3.0, end: 3.3 },      // 3 - Hook 2
      { text: '2', start: 3.5, end: 3.8 },         // 4
      { text: 'stuff', start: 5.0, end: 5.5 },     // 5 - poisoned
      { text: 'hook', start: 8.0, end: 8.3 },      // 6 - retake Hook 1 (kept)
      { text: '1', start: 8.5, end: 8.8 },         // 7
      { text: 'good', start: 10.0, end: 10.5 },    // 8 - content
    ]

    const result = detectMarkers(chunks, 15)
    expect(result).toHaveLength(2)
    expect(result[0].label).toBe('Hook 2')
    expect(result[1].label).toBe('Hook 1')
    // Hook 2: no non-poisoned content → extends to next marker start (8.0)
    expect(result[0].endTime).toBe(8.0)
    // Hook 1 retake: content "good" at 10.0–10.5, gap to 15 > 0.5 → 0.1 buffer
    expect(result[1].endTime).toBe(10.6)
  })
})

describe('detectMarkers — minimum clip duration filter', () => {
  it('markers producing clips < 0.5s are filtered out, survivors recomputed', () => {
    // Hook 4 and Hook 5 are hallucinated rapid-fire markers with no content between them
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.3 },      // 0
      { text: '1', start: 0.3, end: 0.5 },        // 1
      { text: 'hello', start: 0.6, end: 1.0 },    // 2 — content for Hook 1
      { text: 'hook', start: 1.1, end: 1.3 },     // 3
      { text: '4', start: 1.3, end: 1.5 },        // 4 — hallucinated marker
      { text: 'hook', start: 1.5, end: 1.7 },     // 5
      { text: '5', start: 1.7, end: 1.9 },        // 6 — hallucinated marker
      { text: 'hook', start: 2.0, end: 2.3 },     // 7
      { text: '2', start: 2.3, end: 2.5 },        // 8
      { text: 'world', start: 3.0, end: 3.5 },    // 9 — content for Hook 2
    ]

    const result = detectMarkers(chunks, 10)
    // Hook 4 and Hook 5 produce 0-duration clips → filtered out
    expect(result).toHaveLength(2)
    expect(result[0].label).toBe('Hook 1')
    expect(result[1].label).toBe('Hook 2')
    // Hook 1: content "hello" at 1.0, next marker (Hook 2) at 2.0, gap=1.0>0.5 → 0.1 buffer
    expect(result[0].endTime).toBe(1.1)
    // Hook 2: content "world" at 3.5, videoDuration=10, gap=6.5>0.5 → 0.1 buffer
    expect(result[1].endTime).toBe(3.6)
  })

  it('all markers with real content (>= 0.5s) pass the filter', () => {
    const chunks: WhisperChunk[] = [
      { text: 'hook', start: 0, end: 0.3 },
      { text: '1', start: 0.5, end: 0.8 },
      { text: 'words', start: 1.0, end: 2.0 },
      { text: 'hook', start: 4.0, end: 4.3 },
      { text: '2', start: 4.5, end: 4.8 },
      { text: 'more', start: 5.0, end: 6.0 },
      { text: 'meat', start: 8.0, end: 8.3 },
      { text: '1', start: 8.5, end: 8.8 },
      { text: 'content', start: 9.0, end: 10.0 },
    ]

    const result = detectMarkers(chunks, 15)
    // All three markers have real content → all pass
    expect(result).toHaveLength(3)
    expect(result[0].label).toBe('Hook 1')
    expect(result[1].label).toBe('Hook 2')
    expect(result[2].label).toBe('Meat 1')
  })
})
