import { describe, expect, it, vi } from 'vitest'
import { captureTrimLeadingSilenceResult } from './trim-silence-result'

describe('captureTrimLeadingSilenceResult', () => {
  it('returns a distinct trim-success outcome', async () => {
    const trim = vi.fn().mockResolvedValue({
      outputPath: '/tmp/clip-trimmed.mp4',
      trimmedSeconds: 1.25
    })

    const result = await captureTrimLeadingSilenceResult(trim)

    expect(result).toEqual({
      outcome: 'trim-success',
      outputPath: '/tmp/clip-trimmed.mp4',
      trimmedSeconds: 1.25
    })
  })

  it('serializes trim failures instead of rejecting the IPC request', async () => {
    const trim = vi.fn().mockRejectedValue(new Error('encoder failed'))

    const result = await captureTrimLeadingSilenceResult(trim)

    expect(result).toEqual({ outcome: 'trim-failure', error: 'encoder failed' })
  })
})
