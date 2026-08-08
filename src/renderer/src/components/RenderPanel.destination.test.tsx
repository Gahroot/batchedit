import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderPanel } from './RenderPanel'
import { useStore } from '../store'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastMocks }))
vi.mock('canvas-confetti', () => ({ default: vi.fn() }))
vi.mock('@/hooks/useWhisper', () => ({
  useWhisper: () => ({
    loadModel: vi.fn(),
    transcribe: vi.fn(),
    cancel: vi.fn(),
    isModelLoading: false,
    isModelReady: false,
    isTranscribing: false,
    loadProgress: 0,
    loadedModel: null
  })
}))
vi.mock('./WhisperStatus', () => ({ WhisperStatus: () => null }))
vi.mock('./WhisperModelControl', () => ({ WhisperModelControl: () => null }))
vi.mock('./CaptionStylePicker', () => ({ CaptionStylePicker: () => null }))
vi.mock('./PermutationMatrix', () => ({ PermutationMatrix: () => null }))
vi.mock('./ErrorLog', () => ({ ErrorLog: () => null }))
vi.mock('@/components/ui/number-ticker', () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>
}))

type RenderJob = Parameters<Window['api']['renderBatch']>[0][number]

interface ApiMocks {
  createRenderBatchDirectory: ReturnType<typeof vi.fn>
  renderBatch: ReturnType<typeof vi.fn>
  showItemInFolder: ReturnType<typeof vi.fn>
}

function installApi(batchDirectory: string): ApiMocks {
  const createRenderBatchDirectory = vi.fn(async () => batchDirectory)
  const renderBatch = vi.fn(async (jobs: RenderJob[]) =>
    jobs.map((job) => ({ jobId: job.id, percent: 100, status: 'done' as const }))
  )
  const showItemInFolder = vi.fn()

  Object.assign(window, {
    api: {
      onRenderProgress: () => () => undefined,
      getDefaultOutputDirectory: async () => '/output',
      pathsExist: async () => ({ missing: [] }),
      createRenderBatchDirectory,
      renderBatch,
      cancelRender: async () => false,
      showItemInFolder,
      openPath: vi.fn()
    }
  })

  return { createRenderBatchDirectory, renderBatch, showItemInFolder }
}

function seedRenderableBatch(): void {
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState((state) => ({
    hooks: [{ id: 'hook-1', name: 'Hook 1.mp4', path: '/clips/hook.mp4', duration: 2, bucket: 'hook' }],
    meats: [{ id: 'meat-1', name: 'Meat 1.mp4', path: '/clips/meat.mp4', duration: 3, bucket: 'meat' }],
    ctas: [{ id: 'cta-1', name: 'CTA 1.mp4', path: '/clips/cta.mp4', duration: 1, bucket: 'cta' }],
    settings: { ...state.settings, outputDirectory: '/output' }
  }))
}

describe('RenderPanel batch destination feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedRenderableBatch()
  })

  it('uses a fresh destination on repeated renders and reveals the latest actual file', async () => {
    const batchDirectory = '/output/BatchEdit 2026-08-08 10-11-12'
    const api = installApi(batchDirectory)
    render(<RenderPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Render 1 Videos' }))

    await waitFor(() => expect(api.renderBatch).toHaveBeenCalledTimes(1))
    const jobs = api.renderBatch.mock.calls[0]?.[0] as RenderJob[] | undefined
    if (!jobs?.[0]) throw new Error('Expected one render job')
    const outputPath = jobs[0].outputPath

    expect(api.createRenderBatchDirectory).toHaveBeenCalledWith('/output')
    expect(outputPath).toBe(`${batchDirectory}/Hook 1_Meat 1_CTA 1_1.mp4`)
    expect(await screen.findByText(batchDirectory)).toBeTruthy()
    expect(toastMocks.success).toHaveBeenCalledWith(
      '1 video rendered',
      expect.objectContaining({ description: `Saved to ${batchDirectory}` })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Reveal Output' }))
    expect(api.showItemInFolder).toHaveBeenCalledWith(outputPath)

    const secondBatchDirectory = '/output/BatchEdit 2026-08-08 10-11-13'
    api.createRenderBatchDirectory.mockResolvedValue(secondBatchDirectory)
    const renderButton = screen.getByRole('button', { name: 'Render 1 Videos' })
    await waitFor(() => expect(renderButton.hasAttribute('disabled')).toBe(false))
    fireEvent.click(renderButton)

    await waitFor(() => expect(api.renderBatch).toHaveBeenCalledTimes(2))
    const secondJobs = api.renderBatch.mock.calls[1]?.[0] as RenderJob[] | undefined
    if (!secondJobs?.[0]) throw new Error('Expected a second render job')
    const secondOutputPath = secondJobs[0].outputPath

    expect(secondOutputPath).toBe(`${secondBatchDirectory}/Hook 1_Meat 1_CTA 1_1.mp4`)
    expect(secondOutputPath).not.toBe(outputPath)
    expect(await screen.findByText(secondBatchDirectory)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Reveal Output' }))
    expect(api.showItemInFolder).toHaveBeenLastCalledWith(secondOutputPath)
  })
})
