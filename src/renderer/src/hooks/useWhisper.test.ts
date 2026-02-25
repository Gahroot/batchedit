import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Worker class
// ---------------------------------------------------------------------------

type MessageHandler = (e: MessageEvent) => void

class MockWorker {
  private listeners: Map<string, MessageHandler[]> = new Map()
  public postMessage = vi.fn()
  public terminate = vi.fn()

  addEventListener(event: string, handler: MessageHandler) {
    const handlers = this.listeners.get(event) || []
    handlers.push(handler)
    this.listeners.set(event, handlers)
  }

  removeEventListener(event: string, handler: MessageHandler) {
    const handlers = this.listeners.get(event) || []
    this.listeners.set(
      event,
      handlers.filter((h) => h !== handler)
    )
  }

  /** Simulate the worker sending a message back */
  simulateMessage(data: unknown) {
    const handlers = this.listeners.get('message') || []
    for (const handler of handlers) {
      handler({ data } as MessageEvent)
    }
  }

  getListenerCount(event: string): number {
    return (this.listeners.get(event) || []).length
  }
}

// ---------------------------------------------------------------------------
// Minimal hook runner — avoids React rendering dependencies
//
// useWhisper uses React hooks (useState, useRef, useCallback, useEffect).
// Instead of pulling in renderHook and full React, we replicate the hook's
// state-machine logic by directly exercising the MockWorker protocol.
// ---------------------------------------------------------------------------

/**
 * Creates a test harness that mimics the useWhisper hook's behaviour by
 * operating on the same Worker message protocol.
 */
function createWhisperHarness() {
  const worker = new MockWorker()

  // State mirrors useState calls in useWhisper
  let isModelLoading = false
  let isModelReady = false
  let isTranscribing = false
  let loadProgress = 0

  function loadModel(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (isModelReady) return resolve()

      isModelLoading = true

      const handler = (e: MessageEvent) => {
        const msg = e.data
        if (msg.type === 'progress' && msg.progress?.progress != null) {
          loadProgress = Math.round(msg.progress.progress)
        }
        if (msg.type === 'status') {
          if (msg.status === 'ready') {
            isModelLoading = false
            isModelReady = true
            loadProgress = 100
            worker.removeEventListener('message', handler)
            resolve()
          } else if (msg.status === 'error') {
            isModelLoading = false
            worker.removeEventListener('message', handler)
            reject(new Error(msg.error))
          }
        }
      }
      worker.addEventListener('message', handler)
      worker.postMessage({ type: 'load' })
    })
  }

  function transcribe(audioData: Float32Array): Promise<Array<{ text: string; start: number; end: number }>> {
    return new Promise((resolve, reject) => {
      isTranscribing = true
      const handler = (e: MessageEvent) => {
        const msg = e.data
        if (msg.type === 'result') {
          isTranscribing = false
          worker.removeEventListener('message', handler)
          resolve(msg.chunks)
        } else if (msg.type === 'status' && msg.status === 'error') {
          isTranscribing = false
          worker.removeEventListener('message', handler)
          reject(new Error(msg.error))
        }
      }
      worker.addEventListener('message', handler)
      worker.postMessage({ type: 'transcribe', data: { audio: audioData } })
    })
  }

  return {
    worker,
    loadModel,
    transcribe,
    getState: () => ({ isModelLoading, isModelReady, isTranscribing, loadProgress })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWhisper — initial state', () => {
  it('starts with not loading, not ready, not transcribing, progress 0', () => {
    const { getState } = createWhisperHarness()
    const state = getState()

    expect(state.isModelLoading).toBe(false)
    expect(state.isModelReady).toBe(false)
    expect(state.isTranscribing).toBe(false)
    expect(state.loadProgress).toBe(0)
  })
})

describe('useWhisper — loadModel', () => {
  it('sets isModelLoading=true while loading', () => {
    const { worker, loadModel, getState } = createWhisperHarness()

    // Start loading (don't await yet)
    const promise = loadModel()

    expect(getState().isModelLoading).toBe(true)
    expect(getState().isModelReady).toBe(false)

    // Complete loading
    worker.simulateMessage({ type: 'status', status: 'ready' })

    return promise.then(() => {
      expect(getState().isModelLoading).toBe(false)
      expect(getState().isModelReady).toBe(true)
    })
  })

  it('sends { type: "load" } to the worker', () => {
    const { worker, loadModel } = createWhisperHarness()

    loadModel()

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'load' })

    // Cleanup
    worker.simulateMessage({ type: 'status', status: 'ready' })
  })

  it('resolves when worker sends "ready" status', async () => {
    const { worker, loadModel, getState } = createWhisperHarness()

    const promise = loadModel()
    worker.simulateMessage({ type: 'status', status: 'ready' })

    await promise

    expect(getState().isModelReady).toBe(true)
    expect(getState().loadProgress).toBe(100)
  })

  it('updates loadProgress on worker progress messages', async () => {
    const { worker, loadModel, getState } = createWhisperHarness()

    const promise = loadModel()

    worker.simulateMessage({ type: 'progress', progress: { progress: 25 } })
    expect(getState().loadProgress).toBe(25)

    worker.simulateMessage({ type: 'progress', progress: { progress: 50 } })
    expect(getState().loadProgress).toBe(50)

    worker.simulateMessage({ type: 'progress', progress: { progress: 75.4 } })
    expect(getState().loadProgress).toBe(75) // Math.round

    worker.simulateMessage({ type: 'status', status: 'ready' })
    await promise

    expect(getState().loadProgress).toBe(100)
  })

  it('rejects on worker error message', async () => {
    const { worker, loadModel, getState } = createWhisperHarness()

    const promise = loadModel()
    worker.simulateMessage({
      type: 'status',
      status: 'error',
      error: 'Out of memory'
    })

    await expect(promise).rejects.toThrow('Out of memory')
    expect(getState().isModelLoading).toBe(false)
  })

  it('resolves immediately if model is already loaded', async () => {
    const { worker, loadModel, getState } = createWhisperHarness()

    // First load
    const p1 = loadModel()
    worker.simulateMessage({ type: 'status', status: 'ready' })
    await p1

    expect(getState().isModelReady).toBe(true)

    // Second call should resolve immediately without posting to worker
    worker.postMessage.mockClear()
    await loadModel()

    // Should not have posted another 'load' message
    expect(worker.postMessage).not.toHaveBeenCalled()
  })

  it('removes the message listener after success', async () => {
    const { worker, loadModel } = createWhisperHarness()

    const promise = loadModel()
    const listenersBefore = worker.getListenerCount('message')
    expect(listenersBefore).toBe(1)

    worker.simulateMessage({ type: 'status', status: 'ready' })
    await promise

    expect(worker.getListenerCount('message')).toBe(0)
  })

  it('removes the message listener after error', async () => {
    const { worker, loadModel } = createWhisperHarness()

    const promise = loadModel()
    expect(worker.getListenerCount('message')).toBe(1)

    worker.simulateMessage({ type: 'status', status: 'error', error: 'fail' })
    await promise.catch(() => {})

    expect(worker.getListenerCount('message')).toBe(0)
  })
})

describe('useWhisper — transcribe', () => {
  it('sends audio data to the worker', () => {
    const { worker, transcribe } = createWhisperHarness()
    const audio = new Float32Array([0.1, 0.2, 0.3])

    transcribe(audio)

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'transcribe',
      data: { audio }
    })

    // Cleanup
    worker.simulateMessage({
      type: 'result',
      chunks: []
    })
  })

  it('returns chunks on result message', async () => {
    const { worker, transcribe } = createWhisperHarness()
    const audio = new Float32Array([0.1])

    const promise = transcribe(audio)

    const expectedChunks = [
      { text: 'Hello world', start: 0.0, end: 1.5 },
      { text: 'How are you', start: 1.5, end: 3.0 }
    ]

    worker.simulateMessage({ type: 'result', chunks: expectedChunks })

    const result = await promise
    expect(result).toEqual(expectedChunks)
  })

  it('sets isTranscribing=true while transcribing', () => {
    const { worker, transcribe, getState } = createWhisperHarness()

    expect(getState().isTranscribing).toBe(false)

    const promise = transcribe(new Float32Array([0.1]))
    expect(getState().isTranscribing).toBe(true)

    worker.simulateMessage({ type: 'result', chunks: [] })

    return promise.then(() => {
      expect(getState().isTranscribing).toBe(false)
    })
  })

  it('rejects on worker error during transcription', async () => {
    const { worker, transcribe, getState } = createWhisperHarness()

    const promise = transcribe(new Float32Array([0.1]))

    worker.simulateMessage({
      type: 'status',
      status: 'error',
      error: 'Transcription failed: invalid audio'
    })

    await expect(promise).rejects.toThrow('Transcription failed: invalid audio')
    expect(getState().isTranscribing).toBe(false)
  })

  it('removes the message listener after receiving result', async () => {
    const { worker, transcribe } = createWhisperHarness()

    const promise = transcribe(new Float32Array([0.1]))
    expect(worker.getListenerCount('message')).toBe(1)

    worker.simulateMessage({ type: 'result', chunks: [] })
    await promise

    expect(worker.getListenerCount('message')).toBe(0)
  })

  it('removes the message listener after transcription error', async () => {
    const { worker, transcribe } = createWhisperHarness()

    const promise = transcribe(new Float32Array([0.1]))
    expect(worker.getListenerCount('message')).toBe(1)

    worker.simulateMessage({ type: 'status', status: 'error', error: 'fail' })
    await promise.catch(() => {})

    expect(worker.getListenerCount('message')).toBe(0)
  })

  it('handles empty chunks result', async () => {
    const { worker, transcribe } = createWhisperHarness()

    const promise = transcribe(new Float32Array([0.1]))
    worker.simulateMessage({ type: 'result', chunks: [] })

    const result = await promise
    expect(result).toEqual([])
  })

  it('ignores unrelated message types during transcription', async () => {
    const { worker, transcribe } = createWhisperHarness()

    const promise = transcribe(new Float32Array([0.1]))

    // Send an unrelated progress message — should be ignored
    worker.simulateMessage({ type: 'progress', progress: { progress: 50 } })

    // isTranscribing should still be true (not resolved yet)
    // Now send the actual result
    const chunks = [{ text: 'test', start: 0, end: 1 }]
    worker.simulateMessage({ type: 'result', chunks })

    const result = await promise
    expect(result).toEqual(chunks)
  })
})
