import { describe, it, expect } from 'vitest'
import { statusOf } from './PermutationMatrix'
import type { RenderProgress, RenderProgressStatus } from '../store'

function rp(status: RenderProgressStatus): RenderProgress {
  return { jobId: 'j', percent: 50, status }
}

describe('statusOf', () => {
  it('maps active working phases to "rendering" so cells animate', () => {
    const active: RenderProgressStatus[] = [
      'rendering',
      'normalizing',
      'concatenating',
      'overlaying'
    ]
    for (const status of active) {
      expect(statusOf(rp(status))).toBe('rendering')
    }
  })

  it('maps terminal and queued states correctly', () => {
    expect(statusOf(undefined)).toBe('idle')
    expect(statusOf(rp('queued'))).toBe('queued')
    expect(statusOf(rp('canceled'))).toBe('queued')
    expect(statusOf(rp('done'))).toBe('done')
    expect(statusOf(rp('error'))).toBe('error')
  })
})
