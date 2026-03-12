import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Types mirroring the store / RenderPanel internals
// ---------------------------------------------------------------------------

interface Clip {
  id: string
  path: string
  name: string
  duration: number
  thumbnail?: string
}

interface RenderProgress {
  jobId: string
  percent: number
  status: 'queued' | 'normalizing' | 'rendering' | 'done' | 'error'
  error?: string
}

// ---------------------------------------------------------------------------
// Helpers extracted from RenderPanel.tsx — tested in isolation
// ---------------------------------------------------------------------------

/**
 * Replicates the triple-nested-loop combination generation
 * from RenderPanel.handleRender (lines 137-143).
 */
function generateCombinations(
  hooks: Clip[],
  meats: Clip[],
  ctas: Clip[]
): { hook: Clip; meat: Clip; cta: Clip }[] {
  const combos: { hook: Clip; meat: Clip; cta: Clip }[] = []
  for (const hook of hooks) {
    for (const meat of meats) {
      for (const cta of ctas) {
        combos.push({ hook, meat, cta })
      }
    }
  }
  return combos
}

/**
 * Replicates the render-count slicing from RenderPanel (line 146):
 *   const toRender = renderCount === 'all' ? combos : combos.slice(0, renderCount)
 */
function limitCombos<T>(combos: T[], renderCount: number | 'all'): T[] {
  return renderCount === 'all' ? combos : combos.slice(0, renderCount)
}

/**
 * Replicates the output filename generation from RenderPanel (line 152):
 *   `${hook.name.replace(/\.[^.]+$/, '')}_${meat.name.replace(/\.[^.]+$/, '')}_${cta.name.replace(/\.[^.]+$/, '')}_${idx + 1}.mp4`
 */
function generateOutputFilename(
  hookName: string,
  meatName: string,
  ctaName: string,
  idx: number
): string {
  const strip = (n: string) => n.replace(/\.[^.]+$/, '')
  return `${strip(hookName)}_${strip(meatName)}_${strip(ctaName)}_${idx + 1}.mp4`
}

/**
 * Replicates the time-offset calculation for multi-segment captions
 * from RenderPanel (lines 172-182).
 */
function computeSegmentOffsets(hookDuration: number, meatDuration: number) {
  const hookDurationMs = hookDuration * 1000
  const meatDurationMs = meatDuration * 1000
  return {
    hookOffsetMs: 0,
    meatOffsetMs: hookDurationMs,
    ctaOffsetMs: hookDurationMs + meatDurationMs
  }
}

/**
 * Replicates the overall-progress aggregation from RenderPanel (lines 224-230):
 *   completed = renderProgress.filter(r => r.status === 'done').length
 *   errors    = renderProgress.filter(r => r.status === 'error').length
 *   total     = renderProgress.length
 *   percent   = total > 0 ? Math.round(reduce(sum + r.percent) / total) : 0
 */
function aggregateProgress(renderProgress: RenderProgress[]) {
  const completed = renderProgress.filter((r) => r.status === 'done').length
  const errors = renderProgress.filter((r) => r.status === 'error').length
  const total = renderProgress.length
  const overallPercent =
    total > 0
      ? Math.round(renderProgress.reduce((sum, r) => sum + r.percent, 0) / total)
      : 0
  return { completed, errors, total, overallPercent }
}

// ---------------------------------------------------------------------------
// Helpers for building test fixtures
// ---------------------------------------------------------------------------

let clipCounter = 0
function makeClip(overrides: Partial<Clip> = {}): Clip {
  clipCounter++
  return {
    id: `clip-${clipCounter}`,
    path: `/videos/clip${clipCounter}.mp4`,
    name: `clip${clipCounter}.mp4`,
    duration: 5,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RenderPanel — combination generation', () => {
  beforeEach(() => {
    clipCounter = 0
  })

  it('generates 2x3x2 = 12 combinations', () => {
    const hooks = [makeClip(), makeClip()]
    const meats = [makeClip(), makeClip(), makeClip()]
    const ctas = [makeClip(), makeClip()]

    const combos = generateCombinations(hooks, meats, ctas)

    expect(combos).toHaveLength(12)
    // Verify each combo has the expected structure
    for (const c of combos) {
      expect(c).toHaveProperty('hook')
      expect(c).toHaveProperty('meat')
      expect(c).toHaveProperty('cta')
    }
  })

  it('returns 0 combinations when any bucket is empty', () => {
    const hooks = [makeClip()]
    const meats: Clip[] = []
    const ctas = [makeClip()]

    expect(generateCombinations(hooks, meats, ctas)).toHaveLength(0)
    expect(generateCombinations([], [makeClip()], [makeClip()])).toHaveLength(0)
    expect(generateCombinations([makeClip()], [makeClip()], [])).toHaveLength(0)
  })

  it('returns 1 combination for 1x1x1', () => {
    const hooks = [makeClip({ name: 'h.mp4' })]
    const meats = [makeClip({ name: 'm.mp4' })]
    const ctas = [makeClip({ name: 'c.mp4' })]

    const combos = generateCombinations(hooks, meats, ctas)

    expect(combos).toHaveLength(1)
    expect(combos[0].hook.name).toBe('h.mp4')
    expect(combos[0].meat.name).toBe('m.mp4')
    expect(combos[0].cta.name).toBe('c.mp4')
  })

  it('preserves correct hook/meat/cta associations in order', () => {
    const h1 = makeClip({ name: 'h1.mp4' })
    const h2 = makeClip({ name: 'h2.mp4' })
    const m1 = makeClip({ name: 'm1.mp4' })
    const c1 = makeClip({ name: 'c1.mp4' })
    const c2 = makeClip({ name: 'c2.mp4' })

    const combos = generateCombinations([h1, h2], [m1], [c1, c2])

    // 2 hooks x 1 meat x 2 ctas = 4 combos
    expect(combos).toHaveLength(4)

    // Order: h1-m1-c1, h1-m1-c2, h2-m1-c1, h2-m1-c2
    expect(combos[0]).toEqual({ hook: h1, meat: m1, cta: c1 })
    expect(combos[1]).toEqual({ hook: h1, meat: m1, cta: c2 })
    expect(combos[2]).toEqual({ hook: h2, meat: m1, cta: c1 })
    expect(combos[3]).toEqual({ hook: h2, meat: m1, cta: c2 })
  })
})

describe('RenderPanel — output filename generation', () => {
  it('generates correct filename pattern', () => {
    const result = generateOutputFilename('hook.mp4', 'meat.mp4', 'cta.mp4', 0)
    expect(result).toBe('hook_meat_cta_1.mp4')
  })

  it('strips file extensions from clip names', () => {
    expect(generateOutputFilename('video.mp4', 'clip.mov', 'end.avi', 2)).toBe(
      'video_clip_end_3.mp4'
    )
  })

  it('handles names without extensions', () => {
    expect(generateOutputFilename('hook', 'meat', 'cta', 0)).toBe('hook_meat_cta_1.mp4')
  })

  it('handles names with multiple dots', () => {
    expect(generateOutputFilename('my.hook.v2.mp4', 'the.meat.mp4', 'final.cta.mov', 4)).toBe(
      'my.hook.v2_the.meat_final.cta_5.mp4'
    )
  })

  it('uses 1-based index (idx + 1)', () => {
    expect(generateOutputFilename('h.mp4', 'm.mp4', 'c.mp4', 0)).toContain('_1.mp4')
    expect(generateOutputFilename('h.mp4', 'm.mp4', 'c.mp4', 9)).toContain('_10.mp4')
    expect(generateOutputFilename('h.mp4', 'm.mp4', 'c.mp4', 99)).toContain('_100.mp4')
  })

  it('handles names with spaces', () => {
    expect(generateOutputFilename('my hook.mp4', 'the meat.mp4', 'a cta.mp4', 0)).toBe(
      'my hook_the meat_a cta_1.mp4'
    )
  })
})

describe('RenderPanel — render count limiting', () => {
  const items = Array.from({ length: 20 }, (_, i) => i)

  it('"all" returns all combos', () => {
    expect(limitCombos(items, 'all')).toHaveLength(20)
    expect(limitCombos(items, 'all')).toEqual(items)
  })

  it('numeric limit slices to that count', () => {
    const result = limitCombos(items, 5)
    expect(result).toHaveLength(5)
    expect(result).toEqual([0, 1, 2, 3, 4])
  })

  it('limit of 1 returns first combo only', () => {
    expect(limitCombos(items, 1)).toEqual([0])
  })

  it('limit greater than total returns all (no error)', () => {
    const result = limitCombos(items, 100)
    expect(result).toHaveLength(20)
    expect(result).toEqual(items)
  })

  it('limit of 0 returns empty array', () => {
    expect(limitCombos(items, 0)).toHaveLength(0)
  })

  it('empty combos with "all" returns empty array', () => {
    expect(limitCombos([], 'all')).toHaveLength(0)
  })
})

describe('RenderPanel — time offset calculation for multi-segment captions', () => {
  it('hook offset is always 0', () => {
    const { hookOffsetMs } = computeSegmentOffsets(3.5, 10)
    expect(hookOffsetMs).toBe(0)
  })

  it('meat offset equals hook.duration * 1000', () => {
    const { meatOffsetMs } = computeSegmentOffsets(3.5, 10)
    expect(meatOffsetMs).toBe(3500)
  })

  it('cta offset equals (hook.duration + meat.duration) * 1000', () => {
    const { ctaOffsetMs } = computeSegmentOffsets(3.5, 10)
    expect(ctaOffsetMs).toBe(13500)
  })

  it('handles zero durations', () => {
    const offsets = computeSegmentOffsets(0, 0)
    expect(offsets.hookOffsetMs).toBe(0)
    expect(offsets.meatOffsetMs).toBe(0)
    expect(offsets.ctaOffsetMs).toBe(0)
  })

  it('handles fractional durations correctly', () => {
    const offsets = computeSegmentOffsets(1.234, 5.678)
    expect(offsets.hookOffsetMs).toBe(0)
    expect(offsets.meatOffsetMs).toBeCloseTo(1234, 0)
    expect(offsets.ctaOffsetMs).toBeCloseTo(6912, 0)
  })

  it('handles large durations', () => {
    const offsets = computeSegmentOffsets(120, 300)
    expect(offsets.hookOffsetMs).toBe(0)
    expect(offsets.meatOffsetMs).toBe(120000)
    expect(offsets.ctaOffsetMs).toBe(420000)
  })
})

describe('RenderPanel — progress aggregation', () => {
  it('all completed yields 100% and correct counts', () => {
    const progress: RenderProgress[] = [
      { jobId: '1', percent: 100, status: 'done' },
      { jobId: '2', percent: 100, status: 'done' },
      { jobId: '3', percent: 100, status: 'done' }
    ]
    const result = aggregateProgress(progress)

    expect(result.completed).toBe(3)
    expect(result.errors).toBe(0)
    expect(result.total).toBe(3)
    expect(result.overallPercent).toBe(100)
  })

  it('mixed progress computes correct average', () => {
    const progress: RenderProgress[] = [
      { jobId: '1', percent: 100, status: 'done' },
      { jobId: '2', percent: 50, status: 'rendering' },
      { jobId: '3', percent: 0, status: 'queued' }
    ]
    const result = aggregateProgress(progress)

    expect(result.completed).toBe(1)
    expect(result.errors).toBe(0)
    expect(result.total).toBe(3)
    expect(result.overallPercent).toBe(50) // Math.round((100+50+0)/3) = 50
  })

  it('all errors yields correct error count', () => {
    const progress: RenderProgress[] = [
      { jobId: '1', percent: 0, status: 'error', error: 'fail1' },
      { jobId: '2', percent: 0, status: 'error', error: 'fail2' },
      { jobId: '3', percent: 0, status: 'error', error: 'fail3' }
    ]
    const result = aggregateProgress(progress)

    expect(result.completed).toBe(0)
    expect(result.errors).toBe(3)
    expect(result.total).toBe(3)
    expect(result.overallPercent).toBe(0)
  })

  it('empty results returns zeroes gracefully', () => {
    const result = aggregateProgress([])

    expect(result.completed).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.total).toBe(0)
    expect(result.overallPercent).toBe(0)
  })

  it('mix of done, error, rendering, and queued', () => {
    const progress: RenderProgress[] = [
      { jobId: '1', percent: 100, status: 'done' },
      { jobId: '2', percent: 0, status: 'error', error: 'ffmpeg crash' },
      { jobId: '3', percent: 75, status: 'rendering' },
      { jobId: '4', percent: 0, status: 'queued' }
    ]
    const result = aggregateProgress(progress)

    expect(result.completed).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.total).toBe(4)
    expect(result.overallPercent).toBe(44) // Math.round((100+0+75+0)/4) = 44
  })

  it('rounds percent correctly', () => {
    const progress: RenderProgress[] = [
      { jobId: '1', percent: 33, status: 'rendering' },
      { jobId: '2', percent: 33, status: 'rendering' },
      { jobId: '3', percent: 34, status: 'rendering' }
    ]
    const result = aggregateProgress(progress)
    // (33+33+34)/3 = 33.333... rounds to 33
    expect(result.overallPercent).toBe(33)
  })

  it('single job at 50% yields 50%', () => {
    const progress: RenderProgress[] = [
      { jobId: '1', percent: 50, status: 'rendering' }
    ]
    const result = aggregateProgress(progress)

    expect(result.completed).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.total).toBe(1)
    expect(result.overallPercent).toBe(50)
  })
})
