import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { ClipSplitter } from './ClipSplitter'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error)
  }
}

const mocks = vi.hoisted(() => ({
  loadModel: vi.fn(),
  transcribe: vi.fn(),
  cancelWhisper: vi.fn(),
  detectMarkers: vi.fn(),
  isModelLoading: false,
  openFiles: vi.fn(),
  openDirectory: vi.fn(),
  getMetadata: vi.fn(),
  extractAudio: vi.fn(),
  readAudioBuffer: vi.fn(),
  releaseTempFile: vi.fn(),
  splitVideo: vi.fn(),
  trimLeadingSilence: vi.fn(),
  onSplitProgress: vi.fn(),
  cancelMediaOperation: vi.fn(),
  runBoundaryQA: vi.fn(),
  cancelBoundaryQA: vi.fn(),
  recutClip: vi.fn(),
  getThumbnail: vi.fn(),
  showItemInFolder: vi.fn()
}))

vi.mock('../hooks/useWhisper', () => ({
  useWhisper: () => ({
    loadModel: mocks.loadModel,
    transcribe: mocks.transcribe,
    cancel: mocks.cancelWhisper,
    isModelLoading: mocks.isModelLoading,
    loadProgress: 42
  })
}))

vi.mock('./WhisperModelControl', () => ({
  WhisperModelControl: () => <div data-testid="whisper-model-control" />
}))

vi.mock('@/components/ui/stepper', () => ({
  Stepper: () => <div data-testid="splitter-stepper" />
}))

vi.mock('../../../shared/marker-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/marker-detection')>()
  return { ...actual, detectMarkers: mocks.detectMarkers }
})

const SOURCE_METADATA = {
  duration: 2,
  width: 1080,
  height: 1920,
  codec: 'h264',
  fps: 30,
  audioCodec: 'aac'
}

const SPLIT_CLIP = {
  label: 'Hook 1',
  bucket: 'hook' as const,
  outputPath: '/outputs/Hook_1.mp4'
}

const QA_CLIP = {
  label: 'Hook 1',
  bucket: 'hook' as const,
  path: SPLIT_CLIP.outputPath,
  originalPath: SPLIT_CLIP.outputPath,
  sourcePath: '/source.mp4',
  sourceStart: 0,
  sourceEnd: 2,
  duration: 2,
  status: 'clean' as const,
  recutCount: 0,
  confidence: 1,
  leadingLeak: null,
  trailingLeak: null
}

function installWindowApi(): void {
  window.api = {
    openFiles: mocks.openFiles,
    openDirectory: mocks.openDirectory,
    getPathForFile: vi.fn(() => '/source.mp4'),
    getMetadata: mocks.getMetadata,
    extractAudio: mocks.extractAudio,
    readAudioBuffer: mocks.readAudioBuffer,
    releaseTempFile: mocks.releaseTempFile,
    splitVideo: mocks.splitVideo,
    onSplitProgress: mocks.onSplitProgress,
    trimLeadingSilence: mocks.trimLeadingSilence,
    cancelMediaOperation: mocks.cancelMediaOperation,
    getThumbnail: mocks.getThumbnail,
    showItemInFolder: mocks.showItemInFolder,
    qa: {
      runBoundaryQA: mocks.runBoundaryQA,
      cancelBoundaryQA: mocks.cancelBoundaryQA,
      recutClip: mocks.recutClip
    }
  } as Window['api']
}

async function openAndTranscribe(): Promise<void> {
  render(<ClipSplitter />)
  fireEvent.click(screen.getByRole('button', { name: 'Split Clip' }))
  fireEvent.click(screen.getByText('Drop a video file here'))
  await screen.findByRole('button', { name: 'Push to BatchEdit' })
}

async function failQaAfterCompletedSplit(): Promise<void> {
  mocks.runBoundaryQA.mockRejectedValueOnce(new Error('QA bridge unavailable'))
  await openAndTranscribe()
  fireEvent.click(screen.getByRole('button', { name: 'Push to BatchEdit' }))
  await screen.findByRole('button', { name: 'Retry QA' })
}

describe('ClipSplitter recovery and cancellation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    for (const mock of [
      mocks.loadModel,
      mocks.transcribe,
      mocks.cancelWhisper,
      mocks.detectMarkers,
      mocks.openFiles,
      mocks.openDirectory,
      mocks.getMetadata,
      mocks.extractAudio,
      mocks.readAudioBuffer,
      mocks.releaseTempFile,
      mocks.splitVideo,
      mocks.trimLeadingSilence,
      mocks.onSplitProgress,
      mocks.cancelMediaOperation,
      mocks.runBoundaryQA,
      mocks.cancelBoundaryQA,
      mocks.recutClip,
      mocks.getThumbnail,
      mocks.showItemInFolder
    ]) {
      mock.mockReset()
    }
    mocks.isModelLoading = false
    mocks.openFiles.mockResolvedValue(['/source.mp4'])
    mocks.openDirectory.mockResolvedValue('/outputs')
    mocks.getMetadata.mockResolvedValue(SOURCE_METADATA)
    mocks.extractAudio.mockResolvedValue('/tmp/source.wav')
    mocks.readAudioBuffer.mockResolvedValue(new Float32Array([0]).buffer)
    mocks.releaseTempFile.mockResolvedValue(true)
    mocks.loadModel.mockResolvedValue(undefined)
    mocks.transcribe.mockResolvedValue({ chunks: [], speechIntervals: [] })
    mocks.detectMarkers.mockReturnValue([
      {
        id: 'hook-1',
        label: 'Hook 1',
        bucket: 'hook',
        startTime: 0,
        endTime: 2,
        markerChunkIndices: []
      }
    ])
    mocks.splitVideo.mockResolvedValue({ outcome: 'completed', clips: [SPLIT_CLIP] })
    mocks.trimLeadingSilence.mockResolvedValue({ outcome: 'trim-failure', error: 'no silence' })
    mocks.onSplitProgress.mockReturnValue(vi.fn())
    mocks.cancelMediaOperation.mockResolvedValue(true)
    mocks.cancelBoundaryQA.mockResolvedValue(true)
    mocks.getThumbnail.mockResolvedValue('thumbnail-data')
    mocks.showItemInFolder.mockResolvedValue(undefined)
    useStore.getState().reset()
    useStore.setState({ whisperDevice: 'wasm', whisperModel: 'test-whisper-model' })
    installWindowApi()
  })

  it('preserves split outputs and exposes every recovery action after QA failure', async () => {
    await failQaAfterCompletedSplit()

    expect(screen.getByRole('button', { name: 'Retry QA' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue Without QA' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reveal Files' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Push to BatchEdit' })).toBeTruthy()
    expect(screen.getByText('Completed files: 1')).toBeTruthy()
    expect(mocks.splitVideo).toHaveBeenCalledTimes(1)
  })

  it('retries QA without splitting or trimming a second time', async () => {
    await failQaAfterCompletedSplit()
    mocks.runBoundaryQA.mockResolvedValueOnce({
      clips: [QA_CLIP],
      cleanCount: 1,
      autoFixedCount: 0,
      flaggedCount: 0
    })

    fireEvent.click(screen.getByRole('button', { name: 'Retry QA' }))
    await screen.findByText('Boundary QA Results')

    expect(mocks.splitVideo).toHaveBeenCalledTimes(1)
    expect(mocks.trimLeadingSilence).toHaveBeenCalledTimes(1)
    expect(mocks.runBoundaryQA).toHaveBeenCalledTimes(2)
  })

  it('requires confirmation before continuing without QA', async () => {
    await failQaAfterCompletedSplit()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)

    fireEvent.click(screen.getByRole('button', { name: 'Continue Without QA' }))
    expect(screen.getByRole('button', { name: 'Retry QA' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue Without QA' }))
    await screen.findByText(/Boundary QA was skipped/)

    expect(confirm).toHaveBeenCalledTimes(2)
    expect(mocks.splitVideo).toHaveBeenCalledTimes(1)
  })

  it('reveals completed files and pushes them to BatchEdit after QA failure', async () => {
    await failQaAfterCompletedSplit()

    fireEvent.click(screen.getByRole('button', { name: 'Reveal Files' }))
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(SPLIT_CLIP.outputPath)

    fireEvent.click(screen.getByRole('button', { name: 'Push to BatchEdit' }))
    await screen.findByText(/Boundary QA was skipped/)

    expect(useStore.getState().hooks).toEqual([
      expect.objectContaining({ path: SPLIT_CLIP.outputPath, name: 'Hook 1.mp4' })
    ])
  })

  it('cancels model loading and leaves a transcription recovery state', async () => {
    const modelLoad = deferred<void>()
    mocks.isModelLoading = true
    mocks.loadModel.mockReturnValueOnce(modelLoad.promise)
    render(<ClipSplitter />)

    fireEvent.click(screen.getByRole('button', { name: 'Split Clip' }))
    fireEvent.click(screen.getByText('Drop a video file here'))
    await screen.findByText('Loading Whisper model...')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(mocks.cancelWhisper).toHaveBeenCalled()
    expect(mocks.cancelMediaOperation).toHaveBeenCalledWith(expect.any(String))
    expect(await screen.findByText(/Transcription canceled/)).toBeTruthy()
    await act(async () => modelLoad.resolve(undefined))
  })

  it('cancels active transcription and keeps the source untouched', async () => {
    const transcription = deferred<{ chunks: []; speechIntervals: [] }>()
    mocks.transcribe.mockReturnValueOnce(transcription.promise)
    render(<ClipSplitter />)

    fireEvent.click(screen.getByRole('button', { name: 'Split Clip' }))
    fireEvent.click(screen.getByText('Drop a video file here'))
    await waitFor(() => expect(mocks.transcribe).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(mocks.cancelWhisper).toHaveBeenCalled()
    expect(await screen.findByText(/Your source video was not changed/)).toBeTruthy()
    await act(async () => transcription.resolve({ chunks: [], speechIntervals: [] }))
  })

  it('cancels FFmpeg splitting and preserves its completed output', async () => {
    const split = deferred<{ outcome: 'canceled'; clips: [typeof SPLIT_CLIP] }>()
    mocks.splitVideo.mockReturnValueOnce(split.promise)
    await openAndTranscribe()

    fireEvent.click(screen.getByRole('button', { name: 'Push to BatchEdit' }))
    await waitFor(() => expect(mocks.splitVideo).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => split.resolve({ outcome: 'canceled', clips: [SPLIT_CLIP] }))

    expect(mocks.cancelMediaOperation).toHaveBeenCalledWith(expect.any(String))
    expect(await screen.findByRole('button', { name: 'Resume Split' })).toBeTruthy()
    expect(screen.getByText('1 of 1 files completed safely')).toBeTruthy()
  })

  it('cancels FFmpeg trimming while retaining the raw split output', async () => {
    const trim = deferred<{ outcome: 'trim-failure'; error: string }>()
    mocks.trimLeadingSilence.mockReturnValueOnce(trim.promise)
    await openAndTranscribe()

    fireEvent.click(screen.getByRole('button', { name: 'Push to BatchEdit' }))
    await waitFor(() => expect(mocks.trimLeadingSilence).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => trim.resolve({ outcome: 'trim-failure', error: 'canceled' }))

    expect(mocks.cancelMediaOperation).toHaveBeenCalledWith(expect.stringContaining(':trim:0'))
    expect(await screen.findByText(/Trimming canceled/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Split' })).toBeTruthy()
  })

  it('cancels boundary QA without losing completed split results', async () => {
    const qa = deferred<never>()
    mocks.runBoundaryQA.mockReturnValueOnce(qa.promise)
    await openAndTranscribe()

    fireEvent.click(screen.getByRole('button', { name: 'Push to BatchEdit' }))
    await waitFor(() => expect(mocks.runBoundaryQA).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => qa.reject(new Error('qa canceled')))

    expect(mocks.cancelBoundaryQA).toHaveBeenCalledWith(expect.any(String))
    expect(await screen.findByRole('button', { name: 'Retry QA' })).toBeTruthy()
    expect(screen.getByText('Completed files: 1')).toBeTruthy()
    expect(mocks.splitVideo).toHaveBeenCalledTimes(1)
  })
})
