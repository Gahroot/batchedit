import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Bucket } from './Bucket'
import { useStore, type Clip } from '../store'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const openFiles = vi.fn<() => Promise<string[]>>()
const openImages = vi.fn<() => Promise<string[]>>()
const getMetadata = vi.fn<(path: string) => Promise<{ duration: number }>>()
const getThumbnail = vi.fn<(path: string) => Promise<string>>()

const missingClip: Clip = {
  id: 'clip-1',
  path: '/missing/original.mp4',
  name: 'Original clip',
  duration: 4,
  thumbnail: 'old-thumbnail',
  transcript: [{ text: 'keep timing', start: 0.25, end: 1.5 }],
  missing: true
}

beforeEach(() => {
  useStore.getState().reset()
  openFiles.mockReset().mockResolvedValue(['/replacement/video.mp4'])
  openImages.mockReset().mockResolvedValue(['/replacement/proof.png'])
  getMetadata.mockReset().mockResolvedValue({ duration: 7.25 })
  getThumbnail.mockReset().mockResolvedValue('new-thumbnail')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { openFiles, openImages, getMetadata, getThumbnail }
  })
})

afterEach(() => {
  cleanup()
})

describe('Bucket missing dependency relinking', () => {
  it('shows a clip relink action and replaces only probed file metadata', async () => {
    useStore.setState({
      hooks: [missingClip],
      hookTexts: { 'clip-1': 'Keep hook text' },
      mediaOverlays: { meat: '/media/meat.png', cta: '/media/cta.png' }
    })

    render(
      <Bucket type="hook" label="Hooks" color="text-primary" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Relink' }))

    await waitFor(() => {
      expect(getMetadata).toHaveBeenCalledWith('/replacement/video.mp4')
      expect(getThumbnail).toHaveBeenCalledWith('/replacement/video.mp4')
      expect(useStore.getState().hooks[0]).toEqual({
        ...missingClip,
        path: '/replacement/video.mp4',
        duration: 7.25,
        thumbnail: 'new-thumbnail',
        missing: false
      })
    })
    expect(useStore.getState().hookTexts).toEqual({ 'clip-1': 'Keep hook text' })
    expect(useStore.getState().mediaOverlays).toEqual({
      meat: '/media/meat.png',
      cta: '/media/cta.png'
    })
  })

  it('relinks a missing image in its original Meat overlay slot', async () => {
    useStore.setState({
      mediaOverlays: { meat: '/missing/proof.png', cta: '/media/cta.png' },
      missingMediaOverlays: { meat: true, cta: false }
    })

    render(
      <Bucket type="meat" label="Meat" color="text-primary" />
    )
    const relinkButton = screen.getAllByRole('button', { name: 'Relink' })[0]
    if (!relinkButton) throw new Error('Missing image relink button')
    fireEvent.click(relinkButton)

    await waitFor(() => {
      expect(openImages).toHaveBeenCalledOnce()
      expect(useStore.getState().mediaOverlays).toEqual({
        meat: '/replacement/proof.png',
        cta: '/media/cta.png'
      })
      expect(useStore.getState().missingMediaOverlays).toEqual({ meat: false, cta: false })
    })
  })
})
