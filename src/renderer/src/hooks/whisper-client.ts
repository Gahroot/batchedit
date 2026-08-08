import { WASM_DEFAULT_WHISPER_MODEL } from '../lib/whisper-config'

export interface WhisperChunk {
  text: string
  start: number
  end: number
}

export interface SpeechInterval {
  start: number
  end: number
}

export interface TranscribeResult {
  chunks: WhisperChunk[]
  speechIntervals: SpeechInterval[]
}

export interface WhisperState {
  isModelLoading: boolean
  isModelReady: boolean
  isTranscribing: boolean
  loadProgress: number
  loadingModel: string | null
  loadedModel: string | null
}

type WhisperWorkerMessage = {
  type?: string
  requestId?: string
  status?: string
  error?: string
  progress?: {
    progress?: number
  }
  chunks?: WhisperChunk[]
  speechIntervals?: SpeechInterval[]
}

type ActiveLoadRequest = {
  requestId: string
  modelKey: string
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

type ActiveTranscribeRequest = {
  requestId: string
  promise: Promise<TranscribeResult>
  resolve: (result: TranscribeResult) => void
  reject: (error: Error) => void
}

type WhisperWorkerFactory = () => Worker

type WhisperStateListener = () => void

const initialWhisperState: WhisperState = {
  isModelLoading: false,
  isModelReady: false,
  isTranscribing: false,
  loadProgress: 0,
  loadingModel: null,
  loadedModel: null
}

export class WhisperCancellationError extends Error {
  constructor() {
    super('Whisper operation canceled')
    this.name = 'WhisperCancellationError'
  }
}

export function isWhisperCancellationError(error: unknown): boolean {
  return (
    error instanceof WhisperCancellationError ||
    (error instanceof Error && error.name === 'WhisperCancellationError')
  )
}

function createDefaultWhisperWorker(): Worker {
  return new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), { type: 'module' })
}

export class WhisperClient {
  private readonly createWorker: WhisperWorkerFactory
  private readonly listeners = new Set<WhisperStateListener>()
  private worker: Worker | null = null
  private state: WhisperState = initialWhisperState
  private loadedModelKey: string | null = null
  private nextFallbackRequestNumber = 0
  private activeLoadRequest: ActiveLoadRequest | null = null
  private activeTranscribeRequest: ActiveTranscribeRequest | null = null

  constructor(createWorker: WhisperWorkerFactory = createDefaultWhisperWorker) {
    this.createWorker = createWorker
  }

  subscribe = (listener: WhisperStateListener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): WhisperState => this.state

  loadModel(model: string = WASM_DEFAULT_WHISPER_MODEL): Promise<void> {
    const modelKey = model
    if (this.state.isModelReady && this.loadedModelKey === modelKey) {
      return Promise.resolve()
    }

    if (this.activeLoadRequest?.modelKey === modelKey) {
      return this.activeLoadRequest.promise
    }

    this.activeLoadRequest?.reject(new Error('Model load superseded'))
    const worker = this.getWorker()
    const requestId = this.createRequestId()
    let resolveRequest: () => void = () => {}
    let rejectRequest: (error: Error) => void = () => {}
    const promise = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve
      rejectRequest = reject
    })

    this.activeLoadRequest = {
      requestId,
      modelKey,
      promise,
      resolve: resolveRequest,
      reject: rejectRequest
    }
    this.loadedModelKey = null
    this.setState({
      isModelLoading: true,
      isModelReady: false,
      loadProgress: 0,
      loadingModel: modelKey,
      loadedModel: null
    })
    worker.postMessage({ type: 'load', requestId, data: { model: modelKey } })

    return promise
  }

  transcribe(
    audioData: Float32Array,
    model: string = WASM_DEFAULT_WHISPER_MODEL
  ): Promise<TranscribeResult> {
    this.activeTranscribeRequest?.reject(new Error('Transcription superseded'))
    const worker = this.getWorker()
    const requestId = this.createRequestId()
    let resolveRequest: (result: TranscribeResult) => void = () => {}
    let rejectRequest: (error: Error) => void = () => {}
    const promise = new Promise<TranscribeResult>((resolve, reject) => {
      resolveRequest = resolve
      rejectRequest = reject
    })

    this.activeTranscribeRequest = {
      requestId,
      promise,
      resolve: resolveRequest,
      reject: rejectRequest
    }
    this.setState({ isTranscribing: true })
    worker.postMessage({ type: 'transcribe', requestId, data: { audio: audioData, model } })

    return promise
  }

  cancel(): boolean {
    if (!this.activeLoadRequest && !this.activeTranscribeRequest) return false

    const requestIds = [
      this.activeLoadRequest?.requestId,
      this.activeTranscribeRequest?.requestId
    ].filter((requestId): requestId is string => requestId !== undefined)
    this.worker?.postMessage({ type: 'cancel', requestIds })

    const cancellationError = new WhisperCancellationError()
    this.activeLoadRequest?.reject(cancellationError)
    this.activeTranscribeRequest?.reject(cancellationError)
    this.activeLoadRequest = null
    this.activeTranscribeRequest = null

    // Termination is the only immediate cancellation primitive exposed by
    // transformers.js. It leaves completed browser-cache entries untouched.
    this.worker?.removeEventListener('message', this.handleWorkerMessage)
    this.worker?.terminate()
    this.worker = null
    this.loadedModelKey = null
    this.setState(initialWhisperState)
    return true
  }

  dispose(): void {
    this.activeLoadRequest?.reject(new Error('Whisper worker disposed'))
    this.activeTranscribeRequest?.reject(new Error('Whisper worker disposed'))
    this.activeLoadRequest = null
    this.activeTranscribeRequest = null
    this.worker?.removeEventListener('message', this.handleWorkerMessage)
    this.worker?.terminate()
    this.worker = null
    this.loadedModelKey = null
    this.setState(initialWhisperState)
  }

  private createRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `whisper-${crypto.randomUUID()}`
    }

    this.nextFallbackRequestNumber += 1
    return `whisper-${this.nextFallbackRequestNumber}`
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = this.createWorker()
      this.worker.addEventListener('message', this.handleWorkerMessage)
    }
    return this.worker
  }

  private handleWorkerMessage = (event: MessageEvent<WhisperWorkerMessage>): void => {
    const message = event.data
    this.handleLoadMessage(message)
    this.handleTranscribeMessage(message)
  }

  private handleLoadMessage(message: WhisperWorkerMessage): void {
    const request = this.activeLoadRequest
    if (!request || message.requestId !== request.requestId) {
      return
    }

    if (message.type === 'progress' && message.progress?.progress != null) {
      this.setState({ loadProgress: Math.round(message.progress.progress) })
      return
    }

    if (message.type !== 'status') {
      return
    }

    if (message.status === 'ready') {
      this.activeLoadRequest = null
      this.loadedModelKey = request.modelKey
      this.setState({
        isModelLoading: false,
        isModelReady: true,
        loadProgress: 100,
        loadingModel: null,
        loadedModel: request.modelKey
      })
      request.resolve()
      return
    }

    if (message.status === 'error' || message.status === 'cancelled') {
      this.activeLoadRequest = null
      this.loadedModelKey = null
      this.setState({
        isModelLoading: false,
        isModelReady: false,
        loadProgress: 0,
        loadingModel: null,
        loadedModel: null
      })
      request.reject(
        message.status === 'cancelled'
          ? new WhisperCancellationError()
          : new Error(message.error || 'Model load failed')
      )
    }
  }

  private handleTranscribeMessage(message: WhisperWorkerMessage): void {
    const request = this.activeTranscribeRequest
    if (!request || message.requestId !== request.requestId) {
      return
    }

    if (message.type === 'result') {
      this.activeTranscribeRequest = null
      this.setState({ isTranscribing: false })
      request.resolve({
        chunks: message.chunks ?? [],
        speechIntervals: message.speechIntervals ?? []
      })
      return
    }

    if (
      message.type === 'status' &&
      (message.status === 'error' || message.status === 'cancelled')
    ) {
      this.activeTranscribeRequest = null
      this.setState({ isTranscribing: false })
      request.reject(
        message.status === 'cancelled'
          ? new WhisperCancellationError()
          : new Error(message.error || 'Transcription failed')
      )
    }
  }

  private setState(nextState: Partial<WhisperState>): void {
    this.state = { ...this.state, ...nextState }
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export const sharedWhisperClient = new WhisperClient()
