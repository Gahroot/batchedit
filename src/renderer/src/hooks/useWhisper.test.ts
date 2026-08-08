import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isWhisperCancellationError, WhisperClient } from './whisper-client'
import { WASM_DEFAULT_WHISPER_MODEL } from '../lib/whisper-config'

type MessageHandler = (event: MessageEvent) => void

class MockWorker {
  private readonly listeners: Map<string, MessageHandler[]> = new Map()
  public readonly postMessage = vi.fn()
  public readonly terminate = vi.fn()

  addEventListener(event: string, handler: MessageHandler): void {
    const handlers = this.listeners.get(event) ?? []
    handlers.push(handler)
    this.listeners.set(event, handlers)
  }

  removeEventListener(event: string, handler: MessageHandler): void {
    const handlers = this.listeners.get(event) ?? []
    this.listeners.set(
      event,
      handlers.filter((currentHandler) => currentHandler !== handler)
    )
  }

  simulateMessage(data: unknown): void {
    const lastMessage = this.postMessage.mock.calls.at(-1)?.[0] as { requestId?: string } | undefined
    const responseData =
      data && typeof data === 'object' && !('requestId' in data) && lastMessage?.requestId
        ? { ...data, requestId: lastMessage.requestId }
        : data
    const handlers = this.listeners.get('message') ?? []
    for (const handler of handlers) {
      handler({ data: responseData } as MessageEvent)
    }
  }

  getListenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length
  }
}

function createWhisperClientHarness(): { client: WhisperClient; worker: MockWorker; createWorker: ReturnType<typeof vi.fn> } {
  const worker = new MockWorker()
  const createWorker = vi.fn(() => worker as unknown as Worker)
  const client = new WhisperClient(createWorker)

  return { client, worker, createWorker }
}

beforeEach(() => {
  let nextRequestNumber = 0
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => {
      nextRequestNumber += 1
      return `test-request-id-${nextRequestNumber}`
    })
  })
})

describe('WhisperClient — initial state', () => {
  it('starts with not loading, not ready, not transcribing, progress 0', () => {
    const { client } = createWhisperClientHarness()

    expect(client.getSnapshot()).toEqual({
      isModelLoading: false,
      isModelReady: false,
      isTranscribing: false,
      loadProgress: 0,
      loadingModel: null,
      loadedModel: null
    })
  })
})

describe('WhisperClient — shared worker lifecycle', () => {
  it('creates one worker for multiple load and transcribe requests', async () => {
    const { client, worker, createWorker } = createWhisperClientHarness()

    const loadPromise = client.loadModel()
    worker.simulateMessage({ type: 'status', status: 'ready' })
    await loadPromise

    const transcribePromise = client.transcribe(new Float32Array([0.1]))
    worker.simulateMessage({ type: 'result', chunks: [], speechIntervals: [] })
    await transcribePromise

    expect(createWorker).toHaveBeenCalledTimes(1)
    expect(worker.getListenerCount('message')).toBe(1)
  })

  it('reuses an in-flight load promise for the same model', async () => {
    const { client, worker } = createWhisperClientHarness()

    const firstLoad = client.loadModel('onnx-community/whisper-large-v3-turbo_timestamped')
    const secondLoad = client.loadModel('onnx-community/whisper-large-v3-turbo_timestamped')

    expect(firstLoad).toBe(secondLoad)
    expect(worker.postMessage).toHaveBeenCalledTimes(1)

    worker.simulateMessage({ type: 'status', status: 'ready' })
    await expect(secondLoad).resolves.toBeUndefined()
  })

  it('does not post a new load after the same model is ready', async () => {
    const { client, worker } = createWhisperClientHarness()

    const loadPromise = client.loadModel('Xenova/whisper-tiny.en')
    worker.simulateMessage({ type: 'status', status: 'ready' })
    await loadPromise

    worker.postMessage.mockClear()
    await client.loadModel('Xenova/whisper-tiny.en')

    expect(worker.postMessage).not.toHaveBeenCalled()
  })

  it('notifies all subscribers from the same shared state updates', () => {
    const { client } = createWhisperClientHarness()
    const firstListener = vi.fn()
    const secondListener = vi.fn()

    client.subscribe(firstListener)
    client.subscribe(secondListener)

    client.loadModel()

    expect(firstListener).toHaveBeenCalled()
    expect(secondListener).toHaveBeenCalled()
    expect(client.getSnapshot().isModelLoading).toBe(true)
  })
})

describe('WhisperClient — loadModel', () => {
  it('sets isModelLoading=true while loading', async () => {
    const { client, worker } = createWhisperClientHarness()

    const promise = client.loadModel()

    expect(client.getSnapshot().isModelLoading).toBe(true)
    expect(client.getSnapshot().isModelReady).toBe(false)

    worker.simulateMessage({ type: 'status', status: 'ready' })
    await promise

    expect(client.getSnapshot().isModelLoading).toBe(false)
    expect(client.getSnapshot().isModelReady).toBe(true)
  })

  it('sends { type: "load" } to the worker', async () => {
    const { client, worker } = createWhisperClientHarness()

    const promise = client.loadModel()

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'load',
      requestId: 'whisper-test-request-id-1',
      data: { model: WASM_DEFAULT_WHISPER_MODEL }
    })

    worker.simulateMessage({ type: 'status', status: 'ready' })
    await promise
  })

  it('updates loadProgress on worker progress messages', async () => {
    const { client, worker } = createWhisperClientHarness()

    const promise = client.loadModel()

    worker.simulateMessage({ type: 'progress', progress: { progress: 25 } })
    expect(client.getSnapshot().loadProgress).toBe(25)

    worker.simulateMessage({ type: 'progress', progress: { progress: 50 } })
    expect(client.getSnapshot().loadProgress).toBe(50)

    worker.simulateMessage({ type: 'progress', progress: { progress: 75.4 } })
    expect(client.getSnapshot().loadProgress).toBe(75)

    worker.simulateMessage({ type: 'status', status: 'ready' })
    await promise

    expect(client.getSnapshot().loadProgress).toBe(100)
  })

  it('rejects on worker error message', async () => {
    const { client, worker } = createWhisperClientHarness()

    const promise = client.loadModel()
    worker.simulateMessage({ type: 'status', status: 'error', error: 'Out of memory' })

    await expect(promise).rejects.toThrow('Out of memory')
    expect(client.getSnapshot().isModelLoading).toBe(false)
  })

  it('ignores stale load responses from a superseded request', async () => {
    const { client, worker } = createWhisperClientHarness()

    const staleLoad = client.loadModel('first-model')
    const currentLoad = client.loadModel('second-model')

    await expect(staleLoad).rejects.toThrow('Model load superseded')
    worker.simulateMessage({ type: 'status', status: 'ready', requestId: 'whisper-test-request-id-1' })
    expect(client.getSnapshot().isModelReady).toBe(false)

    worker.simulateMessage({ type: 'status', status: 'ready', requestId: 'whisper-test-request-id-2' })
    await currentLoad
    expect(client.getSnapshot().isModelReady).toBe(true)
  })
})

describe('WhisperClient — transcribe', () => {
  it('sends audio data to the worker', async () => {
    const { client, worker } = createWhisperClientHarness()
    const audio = new Float32Array([0.1, 0.2, 0.3])

    const promise = client.transcribe(audio)

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'transcribe',
      requestId: 'whisper-test-request-id-1',
      data: { audio, model: WASM_DEFAULT_WHISPER_MODEL }
    })

    worker.simulateMessage({ type: 'result', chunks: [], speechIntervals: [] })
    await promise
  })

  it('returns chunks and speech intervals on result message', async () => {
    const { client, worker } = createWhisperClientHarness()
    const promise = client.transcribe(new Float32Array([0.1]))
    const expectedChunks = [
      { text: 'Hello world', start: 0, end: 1.5 },
      { text: 'How are you', start: 1.5, end: 3 }
    ]
    const expectedSpeechIntervals = [{ start: 0, end: 3 }]

    worker.simulateMessage({ type: 'result', chunks: expectedChunks, speechIntervals: expectedSpeechIntervals })

    await expect(promise).resolves.toEqual({ chunks: expectedChunks, speechIntervals: expectedSpeechIntervals })
  })

  it('sets isTranscribing=true while transcribing', async () => {
    const { client, worker } = createWhisperClientHarness()

    expect(client.getSnapshot().isTranscribing).toBe(false)

    const promise = client.transcribe(new Float32Array([0.1]))
    expect(client.getSnapshot().isTranscribing).toBe(true)

    worker.simulateMessage({ type: 'result', chunks: [] })
    await promise

    expect(client.getSnapshot().isTranscribing).toBe(false)
  })

  it('rejects on worker error during transcription', async () => {
    const { client, worker } = createWhisperClientHarness()

    const promise = client.transcribe(new Float32Array([0.1]))
    worker.simulateMessage({ type: 'status', status: 'error', error: 'Transcription failed: invalid audio' })

    await expect(promise).rejects.toThrow('Transcription failed: invalid audio')
    expect(client.getSnapshot().isTranscribing).toBe(false)
  })

  it('handles empty chunks result', async () => {
    const { client, worker } = createWhisperClientHarness()

    const promise = client.transcribe(new Float32Array([0.1]))
    worker.simulateMessage({ type: 'result', chunks: [] })

    await expect(promise).resolves.toEqual({ chunks: [], speechIntervals: [] })
  })

  it('ignores unrelated message types during transcription', async () => {
    const { client, worker } = createWhisperClientHarness()

    const promise = client.transcribe(new Float32Array([0.1]))
    worker.simulateMessage({ type: 'progress', progress: { progress: 50 } })

    const chunks = [{ text: 'test', start: 0, end: 1 }]
    worker.simulateMessage({ type: 'result', chunks })

    await expect(promise).resolves.toEqual({ chunks, speechIntervals: [] })
  })

  it('ignores stale transcription responses from a superseded request', async () => {
    const { client, worker } = createWhisperClientHarness()

    const staleTranscription = client.transcribe(new Float32Array([0.1]))
    const currentTranscription = client.transcribe(new Float32Array([0.2]))

    await expect(staleTranscription).rejects.toThrow('Transcription superseded')
    worker.simulateMessage({
      type: 'result',
      requestId: 'whisper-test-request-id-1',
      chunks: [{ text: 'stale', start: 0, end: 1 }]
    })
    expect(client.getSnapshot().isTranscribing).toBe(true)

    const currentChunks = [{ text: 'current', start: 0, end: 1 }]
    worker.simulateMessage({ type: 'result', requestId: 'whisper-test-request-id-2', chunks: currentChunks })

    await expect(currentTranscription).resolves.toEqual({ chunks: currentChunks, speechIntervals: [] })
  })
})

describe('WhisperClient — cancellation and retry', () => {
  it('cancels an in-flight model load and resets loading state', async () => {
    const { client, worker } = createWhisperClientHarness()
    const loadPromise = client.loadModel()

    expect(client.cancel()).toBe(true)

    let cancellation: unknown
    try {
      await loadPromise
    } catch (error) {
      cancellation = error
    }
    expect(isWhisperCancellationError(cancellation)).toBe(true)
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'cancel',
      requestIds: ['whisper-test-request-id-1']
    })
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(client.getSnapshot()).toEqual({
      isModelLoading: false,
      isModelReady: false,
      isTranscribing: false,
      loadProgress: 0,
      loadingModel: null,
      loadedModel: null
    })
  })

  it('cancels transcription through the same shared control', async () => {
    const { client, worker } = createWhisperClientHarness()
    const transcriptionPromise = client.transcribe(new Float32Array([0.1]))

    expect(client.cancel()).toBe(true)

    await expect(transcriptionPromise).rejects.toMatchObject({
      name: 'WhisperCancellationError'
    })
    expect(client.getSnapshot().isTranscribing).toBe(false)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('creates a fresh worker and succeeds when retried after cancellation', async () => {
    const firstWorker = new MockWorker()
    const retryWorker = new MockWorker()
    const workers = [firstWorker, retryWorker]
    let workerIndex = 0
    const createWorker = vi.fn(() => {
      const worker = workers[workerIndex]
      workerIndex += 1
      if (!worker) throw new Error('Unexpected worker creation')
      return worker as unknown as Worker
    })
    const client = new WhisperClient(createWorker)

    const canceledLoad = client.loadModel()
    client.cancel()
    await expect(canceledLoad).rejects.toMatchObject({ name: 'WhisperCancellationError' })

    const retryLoad = client.loadModel()
    retryWorker.simulateMessage({ type: 'status', status: 'ready' })

    await expect(retryLoad).resolves.toBeUndefined()
    expect(createWorker).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot()).toMatchObject({
      isModelLoading: false,
      isModelReady: true,
      loadedModel: WASM_DEFAULT_WHISPER_MODEL
    })
  })
})
