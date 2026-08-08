import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WASM_DEFAULT_WHISPER_MODEL, WHISPER_DEVICE } from '../lib/whisper-config'
import { useStore } from '../store'
import { ClipEditor } from './ClipEditor'

const whisperMocks = vi.hoisted(() => ({
  loadModel: vi.fn(() => new Promise<void>(() => {})),
  transcribe: vi.fn(),
  cancel: vi.fn(() => true)
}))

vi.mock('@/hooks/useWhisper', () => ({
  useWhisper: () => ({
    loadModel: whisperMocks.loadModel,
    transcribe: whisperMocks.transcribe,
    cancel: whisperMocks.cancel,
    isModelLoading: false,
    isModelReady: false,
    isTranscribing: false,
    isBusy: false,
    loadProgress: 0,
    loadingModel: null,
    loadedModel: null
  })
}))

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    hooks: [
      {
        id: 'hook-1',
        path: '/clips/hook.mp4',
        name: 'hook.mp4',
        duration: 10
      }
    ],
    whisperDevice: WHISPER_DEVICE.WASM,
    whisperModel: WASM_DEFAULT_WHISPER_MODEL
  })
  Object.assign(window, {
    api: {
      extractAudio: vi.fn(),
      readAudioBuffer: vi.fn(),
      releaseTempFile: vi.fn()
    }
  })
})

describe('ClipEditor transcription startup', () => {
  it('does not load or transcribe until the user explicitly starts it', async () => {
    render(<ClipEditor open onOpenChange={vi.fn()} clipId="hook-1" bucket="hook" />)

    await Promise.resolve()
    expect(whisperMocks.loadModel).not.toHaveBeenCalled()
    expect(whisperMocks.transcribe).not.toHaveBeenCalled()
    expect(window.api.extractAudio).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Start transcription' }))

    await waitFor(() => {
      expect(whisperMocks.loadModel).toHaveBeenCalledWith(WASM_DEFAULT_WHISPER_MODEL)
    })
  })

  it('stops the shared Whisper operation and allows an explicit retry', async () => {
    render(<ClipEditor open onOpenChange={vi.fn()} clipId="hook-1" bucket="hook" />)

    fireEvent.click(screen.getByRole('button', { name: 'Start transcription' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop transcription' }))

    expect(whisperMocks.cancel).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Start transcription' }))

    await waitFor(() => {
      expect(whisperMocks.loadModel).toHaveBeenCalledTimes(2)
    })
  })
})
