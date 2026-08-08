import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  runBoundaryQA: vi.fn(),
  manualRecutClip: vi.fn(),
  setupQaRendererRpc: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

vi.mock('./qa-renderer-rpc', () => ({
  setupQaRendererRpc: mocks.setupQaRendererRpc
}))

vi.mock('./qa-pipeline', () => ({
  runBoundaryQA: mocks.runBoundaryQA,
  manualRecutClip: mocks.manualRecutClip
}))

import { setupQaIpc } from './qa-ipc'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler
}

describe('boundary QA IPC cancellation', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.runBoundaryQA.mockReset()
    mocks.manualRecutClip.mockReset()
    mocks.setupQaRendererRpc.mockClear()
    setupQaIpc({} as never)
  })

  it('aborts the active QA pipeline by operation ID', async () => {
    let activeSignal: AbortSignal | undefined
    mocks.runBoundaryQA.mockImplementation(
      async (
        _window: unknown,
        _sourcePath: string,
        _clips: unknown[],
        _options: unknown,
        signal?: AbortSignal
      ) => {
        activeSignal = signal
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('qa canceled')), { once: true })
        })
      }
    )

    const qaPromise = getHandler('qa:runBoundaryQA')(
      {},
      {
        sourcePath: '/source.mp4',
        clips: [
          {
            label: 'Hook 1',
            bucket: 'hook',
            path: '/hook.mp4',
            sourceStart: 0,
            sourceEnd: 1,
            duration: 1
          }
        ],
        operationId: 'qa-operation'
      }
    )
    await vi.waitFor(() => expect(activeSignal).toBeDefined())

    await expect(getHandler('qa:cancelBoundaryQA')({}, 'qa-operation')).resolves.toBe(true)
    await expect(qaPromise).rejects.toThrow('qa canceled')
    expect(activeSignal?.aborted).toBe(true)
    await expect(getHandler('qa:cancelBoundaryQA')({}, 'qa-operation')).resolves.toBe(false)
  })
})
