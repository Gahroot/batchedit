import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bucket } from './Bucket'
import { useStore, type Clip } from '../store'
import type { TrimLeadingSilenceResult } from '../../../shared/types'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  openFiles: vi.fn(),
  getMetadata: vi.fn(),
  getThumbnail: vi.fn(),
  trimLeadingSilence: vi.fn(),
  releaseTempFile: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    warning: mocks.toastWarning,
    success: mocks.toastSuccess,
    info: vi.fn()
  }
}))

vi.mock('../hooks/useWhisper', () => ({
  useWhisper: () => ({ loadProgress: 0 })
}))

interface RecoveryToastOptions {
  action?: { label: unknown; onClick: () => void }
  cancel?: { label: unknown; onClick: () => void }
  onDismiss?: () => void
}

type RecoveryChoice = 'retry' | 'use-original' | 'cancel'

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      openFiles: mocks.openFiles,
      getMetadata: mocks.getMetadata,
      getThumbnail: mocks.getThumbnail,
      trimLeadingSilence: mocks.trimLeadingSilence,
      releaseTempFile: mocks.releaseTempFile
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

function chooseTrimFailure(choice: RecoveryChoice): void {
  mocks.toastError.mockImplementation((title: unknown, options?: RecoveryToastOptions) => {
    if (typeof title !== 'string' || !title.startsWith("Couldn't trim")) return
    queueMicrotask(() => {
      if (choice === 'retry') options?.action?.onClick()
      else if (choice === 'use-original') options?.cancel?.onClick()
      else options?.onDismiss?.()
    })
  })
}

function trimSuccess(outputPath: string, trimmedSeconds = 0.75): TrimLeadingSilenceResult {
  return { outcome: 'trim-success', outputPath, trimmedSeconds }
}

describe('Bucket clip imports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStore.getState().reset()
    installApi()
    mocks.getThumbnail.mockResolvedValue(undefined)
    mocks.releaseTempFile.mockResolvedValue(undefined)
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

  it('shows trimming progress and accurately summarizes a successful trim', async () => {
    useStore.setState({ autoTrimSilence: true })
    mocks.openFiles.mockResolvedValue(['/clips/meat-success.mp4'])
    let resolveTrim: ((result: TrimLeadingSilenceResult) => void) | undefined
    mocks.trimLeadingSilence.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTrim = resolve
        })
    )
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('Trimming silence…')).toBeTruthy()
    act(() => resolveTrim?.(trimSuccess('/tmp/meat-success-trimmed.mp4')))
    await waitFor(() => {
      expect(useStore.getState().meats).toEqual([
        expect.objectContaining({
          path: '/tmp/meat-success-trimmed.mp4',
          name: 'meat-success.mp4'
        })
      ])
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Import complete — 1 added', {
      description: 'Trimmed: 1'
    })
  })

  it('offers Retry for a failed trim and reports the eventual trimmed result', async () => {
    useStore.setState({ autoTrimSilence: true })
    mocks.openFiles.mockResolvedValue(['/clips/meat-retry.mp4'])
    mocks.trimLeadingSilence
      .mockResolvedValueOnce({ outcome: 'trim-failure', error: 'encoder failed' })
      .mockResolvedValueOnce(trimSuccess('/tmp/meat-retry-trimmed.mp4'))
    chooseTrimFailure('retry')
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(mocks.trimLeadingSilence).toHaveBeenCalledTimes(2))
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't trim meat-retry.mp4",
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Retry' }),
        cancel: expect.objectContaining({ label: 'Use Original' })
      })
    )
    await waitFor(() => {
      expect(useStore.getState().meats[0]?.path).toBe('/tmp/meat-retry-trimmed.mp4')
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Import complete — 1 added', {
      description: 'Trimmed: 1'
    })
  })

  it('uses the original only after that recovery choice and warns in the summary', async () => {
    useStore.setState({ autoTrimSilence: true })
    mocks.openFiles.mockResolvedValue(['/clips/meat-original.mp4'])
    mocks.trimLeadingSilence.mockResolvedValue({
      outcome: 'trim-failure',
      error: 'encoder failed'
    })
    chooseTrimFailure('use-original')
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(useStore.getState().meats[0]?.path).toBe('/clips/meat-original.mp4')
    })
    expect(mocks.trimLeadingSilence).toHaveBeenCalledTimes(1)
    expect(mocks.toastWarning).toHaveBeenCalledWith('Import complete — 1 added', {
      description: 'Untrimmed by choice: 1'
    })
  })

  it('does not trim or show trimming progress when silence trimming is disabled', async () => {
    mocks.openFiles.mockResolvedValue(['/clips/meat-untouched.mp4'])
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.queryByText('Trimming silence…')).toBeNull()
    await waitFor(() => {
      expect(useStore.getState().meats[0]?.path).toBe('/clips/meat-untouched.mp4')
    })
    expect(mocks.trimLeadingSilence).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Import complete — 1 added', {
      description: 'Added without trimming: 1'
    })
  })

  it('distinguishes trimmed, untrimmed-by-choice, and rejected clips in one summary', async () => {
    useStore.setState({ autoTrimSilence: true })
    mocks.openFiles.mockResolvedValue([
      '/clips/meat-trimmed.mp4',
      '/clips/meat-fallback.mp4',
      '/clips/meat-corrupt.mp4'
    ])
    mocks.trimLeadingSilence.mockImplementation(async (path: string) => {
      if (path.includes('fallback')) {
        return { outcome: 'trim-failure', error: 'encoder failed' } as const
      }
      return trimSuccess('/tmp/meat-trimmed-output.mp4')
    })
    chooseTrimFailure('use-original')
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(useStore.getState().meats).toHaveLength(2))
    expect(mocks.toastWarning).toHaveBeenCalledWith('Import complete — 2 added', {
      description: 'Trimmed: 1 · Untrimmed by choice: 1 · Rejected: 1'
    })
  })

  it('treats dismissal of the trim recovery toast as a cancellation', async () => {
    useStore.setState({ autoTrimSilence: true })
    mocks.openFiles.mockResolvedValue(['/clips/meat-cancelled.mp4'])
    mocks.trimLeadingSilence.mockResolvedValue({
      outcome: 'trim-failure',
      error: 'encoder failed'
    })
    chooseTrimFailure('cancel')
    render(<Bucket type="meat" label="Meats" color="text-orange-500" />)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(mocks.toastWarning).toHaveBeenCalledWith('No clips added', {
        description: 'Cancelled: 1'
      })
    })
    expect(useStore.getState().meats).toEqual([])
  })
})
