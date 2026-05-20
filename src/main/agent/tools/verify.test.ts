import { describe, expect, it } from 'vitest'
import { proposeSplitsFromMarkers } from './markers'

describe('proposeSplitsFromMarkers', () => {
  it('maps markers to split boundaries', () => {
    const splits = proposeSplitsFromMarkers([
      { id: '1', label: 'Hook 1', bucket: 'hook', startTime: 1, endTime: 3, markerChunkIndices: [0, 1] }
    ], 10)

    expect(splits).toEqual([
      { bucket: 'hook', label: 'Hook 1', start: 1, end: 3, confidence: 0.9 }
    ])
  })
})
