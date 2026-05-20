import { describe, expect, it } from 'vitest'
import { pickTemplateLayout } from './pick-template'
import type { ShotAnalysis } from '../../../shared/types'

function shot(overrides: Partial<ShotAnalysis>): ShotAnalysis {
  return {
    t: 1,
    shotType: 'talking-head',
    faceConfidence: 1,
    framingChange: false,
    ...overrides
  }
}

describe('pickTemplateLayout', () => {
  it('picks tiktok glow for selfie tiktok shots', () => {
    const result = pickTemplateLayout([shot({ shotType: 'selfie' })], 'tiktok')

    expect(result.captionPreset).toBe('tiktok-glow')
  })

  it('returns a valid percent based template', () => {
    const result = pickTemplateLayout([
      shot({ faceBox: { x: 0.35, y: 0.2, width: 0.3, height: 0.35 } })
    ], 'universal')

    expect(result.template.subtitles.x).toBeGreaterThanOrEqual(0)
    expect(result.template.subtitles.x).toBeLessThanOrEqual(100)
    expect(result.template.subtitles.y).toBeGreaterThanOrEqual(0)
    expect(result.template.subtitles.y).toBeLessThanOrEqual(100)
  })
})
