import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStore, type Clip } from '../store'
import { useAgentStoreBridge } from './useAgentStoreBridge'

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    path: '/clip.mp4',
    name: 'clip.mp4',
    duration: 3,
    ...overrides
  }
}

describe('useAgentStoreBridge', () => {
  afterEach(() => {
    useStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('replies to store snapshot requests', () => {
    let snapshotCallback: ((req: { id: string; payload: unknown }) => void) | null = null
    const replyStoreSnapshot = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentBridge: {
          onStoreSnapshotRequest: vi.fn((cb) => {
            snapshotCallback = cb
            return () => {}
          }),
          replyStoreSnapshot,
          onApplyAction: vi.fn(() => () => {})
        }
      }
    })

    renderHook(() => useAgentStoreBridge())
    snapshotCallback?.({ id: 'snapshot-1', payload: {} })

    expect(replyStoreSnapshot).toHaveBeenCalledWith(
      'snapshot-1',
      expect.objectContaining({ hooks: [], totalCombinations: 0 })
    )
  })

  it('applies add clip actions from the agent', () => {
    let actionCallback: ((action: { type: string; payload: unknown }) => void) | null = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentBridge: {
          onStoreSnapshotRequest: vi.fn(() => () => {}),
          replyStoreSnapshot: vi.fn(),
          onApplyAction: vi.fn((cb) => {
            actionCallback = cb
            return () => {}
          })
        }
      }
    })

    renderHook(() => useAgentStoreBridge())
    actionCallback?.({ type: 'addClipToBucket', payload: { bucket: 'hook', clip: makeClip() } })

    expect(useStore.getState().hooks).toEqual([makeClip()])
  })
})
