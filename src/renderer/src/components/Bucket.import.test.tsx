import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bucket } from './Bucket'
import { useStore, type Clip } from '../store'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  openFiles: vi.fn(),
  getMetadata: vi.fn(),
  getThumbnail: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('../hooks/useWhisper', () => ({
  useWhisper: () => ({ loadProgress: 0 })
}))

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      openFiles: mocks.openFiles,
      getMetadata: mocks.getMetadata,
      getThumbnail: mocks.getThumbnail
    } as unknown as Window['api']
  })
}

function metadataFor(path: string): {
  duration: number
  width: number
  height: number
  fps: number
  codec: string
  audioCodec: string
} {
  return {
    duration: path.includes('hook') ? 3 : 5,
    width: 1080,
    height: 1920,
    fps: 30,
    codec: 'h264',
    audioCodec: 'aac'
  }
}

describe('Bucket mixed-file imports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStore.getState().reset()
    installApi()
    mocks.getThumbnail.mockResolvedValue(undefined)
    mocks.getMetadata.mockImplementation(async (path: string) => {
      if (path.includes('corrupt')) throw new Error('moov atom not found')
      return metadataFor(path)
    })
  })

  it('adds valid files and lists the corrupt filename with a recovery action', async () => {
    mocks.openFiles.mockResolvedValue([
      '/clips/meat-valid-a.mp4',
      '/clips/meat-corrupt.mp4',
      '/clips/meat-valid-b.mp4'
    ])
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(useStore.getState().meats.map((clip) => clip.path)).toEqual([
        '/clips/meat-valid-a.mp4',
        '/clips/meat-valid-b.mp4'
      ])
    })
    expect(useStore.getState().errorLog).toEqual([
      expect.objectContaining({
        source: 'ingest',
        clipName: 'meat-corrupt.mp4',
        message: expect.stringContaining('Re-export or re-download')
      })
    ])
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't add meat-corrupt.mp4",
      expect.objectContaining({ description: expect.stringContaining('try again') })
    )
  })

  it('preserves an existing valid card when a later import contains a corrupt file', async () => {
    const existingClip: Clip = {
      id: 'existing',
      path: '/clips/existing.mp4',
      name: 'existing.mp4',
      duration: 6
    }
    useStore.setState({ meats: [existingClip] })
    mocks.openFiles.mockResolvedValue(['/clips/new-valid.mp4', '/clips/new-corrupt.mp4'])
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(useStore.getState().meats.map((clip) => clip.path)).toEqual([
        '/clips/existing.mp4',
        '/clips/new-valid.mp4'
      ])
    })
  })
})
