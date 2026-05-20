import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentEvents } from './useAgentEvents'
import { useStore } from '../store'

describe('useAgentEvents', () => {
  afterEach(() => {
    useStore.setState({ agentEvents: [], agentRunning: false, agentReviewPrompt: null })
    vi.restoreAllMocks()
  })

  it('subscribes and appends agent events', () => {
    let callback: ((event: Record<string, unknown>) => void) | null = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agent: {
          onEvent: vi.fn((cb) => {
            callback = cb
            return () => {}
          })
        }
      }
    })

    renderHook(() => useAgentEvents())
    callback?.({ type: 'agent_started', runId: 'run-1' })

    expect(useStore.getState().agentRunning).toBe(true)
    expect(useStore.getState().agentEvents).toHaveLength(1)
  })
})
