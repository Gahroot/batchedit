import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStore, type Clip } from '../store'
import { useAgentRenderBridge } from './useAgentRenderBridge'

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-render-job')
}))

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    path: '/clip.mp4',
    name: 'clip.mp4',
    duration: 3,
    ...overrides
  }
}

describe('useAgentRenderBridge', () => {
  afterEach(() => {
    useStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('reports an error progress event when rendering cannot start', async () => {
    let startRenderCallback: ((request: { jobId: string }) => void | Promise<void>) | null = null
    const sendRenderProgress = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentBridge: {
          onStartRender: vi.fn((cb) => {
            startRenderCallback = cb
            return () => {}
          }),
          sendRenderProgress
        },
        renderBatch: vi.fn()
      }
    })

    useStore.getState().addClips('hook', [makeClip({ id: 'hook', path: '/hook.mp4' })])
    useStore.getState().addClips('meat', [makeClip({ id: 'meat', path: '/meat.mp4' })])
    useStore.getState().addClips('cta', [makeClip({ id: 'cta', path: '/cta.mp4' })])

    renderHook(() => useAgentRenderBridge())
    await startRenderCallback?.({ jobId: 'agent-render-1' })

    expect(sendRenderProgress).toHaveBeenCalledWith([
      expect.objectContaining({ jobId: 'agent-render-1', status: 'error' })
    ])
    expect(useStore.getState().errorLog[0]?.message).toContain('Choose an output folder')
  })
})
