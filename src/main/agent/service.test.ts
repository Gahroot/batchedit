import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './system-prompt'

describe('buildSystemPrompt', () => {
  it('contains render approval rule', () => {
    expect(buildSystemPrompt()).toContain('Never call startRenderJob')
  })
})
