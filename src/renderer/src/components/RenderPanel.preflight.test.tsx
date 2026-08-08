import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderPanel } from './RenderPanel'
import { useStore, type Clip } from '../store'

const mocks = vi.hoisted(() => ({
  pathsExist: vi.fn(),
  renderBatch: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

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

function clip(id: string): Clip {
  return {
    id,
    path: `/clips/${id}.mp4`,
    name: `${id}.mp4`,
    duration: 4
  }
}

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onRenderProgress: () => () => {},
      pathsExist: mocks.pathsExist,
      renderBatch: mocks.renderBatch
    } as unknown as Window['api']
  })
}

describe('RenderPanel source preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStore.getState().reset()
    installApi()
    useStore.setState((state) => ({
      hooks: [clip('hook')],
      meats: [clip('meat')],
      ctas: [clip('cta')],
      settings: { ...state.settings, outputDirectory: '/output' }
    }))
  })

  it('does not start rendering when a source disappears after import', async () => {
    mocks.pathsExist.mockResolvedValue({ missing: ['/clips/meat.mp4'] })
    render(<RenderPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Render 1 Videos' }))

    await waitFor(() => {
      expect(mocks.pathsExist).toHaveBeenCalled()
      expect(useStore.getState().meats[0]?.missing).toBe(true)
    })
    expect(useStore.getState().hooks[0]?.missing).not.toBe(true)
    expect(useStore.getState().ctas[0]?.missing).not.toBe(true)
    expect(mocks.renderBatch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Render 1 Videos' }).hasAttribute('disabled')).toBe(
      true
    )
    expect(useStore.getState().errorLog).toEqual([
      expect.objectContaining({
        source: 'render',
        clipName: 'meat.mp4',
        message: expect.stringContaining('Relink or remove')
      })
    ])
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Render blocked by invalid source clips',
      expect.objectContaining({ description: expect.stringContaining('meat.mp4') })
    )
  })
})
