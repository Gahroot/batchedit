import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FFmpegBanner } from './FFmpegBanner'

function mockReadiness(result: { ready: boolean; issues: string[] }): ReturnType<typeof vi.fn> {
  const getFFmpegReadiness = vi.fn().mockResolvedValue(result)
  // @ts-expect-error - window.api is provided by the preload bridge at runtime
  window.api = { getFFmpegReadiness }
  return getFFmpegReadiness
}

describe('FFmpegBanner', () => {
  afterEach(() => {
    // @ts-expect-error - reset injected bridge
    window.api = undefined
    vi.restoreAllMocks()
  })

  it('shows a persistent warning with issues when ffmpeg is unavailable', async () => {
    mockReadiness({ ready: false, issues: ['ffmpeg binary not found at /unpacked/ffmpeg'] })

    render(<FFmpegBanner />)

    expect(await screen.findByText('Video engine unavailable')).toBeTruthy()
    expect(screen.getByText('ffmpeg binary not found at /unpacked/ffmpeg')).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('renders nothing when ffmpeg is ready', async () => {
    const getFFmpegReadiness = mockReadiness({ ready: true, issues: [] })

    render(<FFmpegBanner />)

    await waitFor(() => {
      expect(getFFmpegReadiness).toHaveBeenCalled()
    })
    expect(screen.queryByText('Video engine unavailable')).toBeNull()
  })
})
