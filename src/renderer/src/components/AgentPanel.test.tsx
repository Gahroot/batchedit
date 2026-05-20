import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import { AgentPanel } from './AgentPanel'

describe('AgentPanel', () => {
  afterEach(() => {
    useStore.setState({ agentEvents: [], agentRunning: false, agentReviewPrompt: null })
  })

  it('renders idle state', () => {
    render(<AgentPanel />)

    expect(screen.getByText('Agent')).toBeTruthy()
    expect(screen.getByText('No agent activity yet.')).toBeTruthy()
  })

  it('renders copyable error diagnostics', () => {
    useStore.setState({
      agentEvents: [
        {
          type: 'agent_failed',
          error: 'Missing Gemini API key',
          diagnostics: {
            name: 'ProviderError',
            message: 'Missing Gemini API key',
            provider: 'google',
            statusCode: 401
          }
        }
      ]
    })

    render(<AgentPanel />)

    expect(screen.getByText('Agent failed: Missing Gemini API key')).toBeTruthy()
    expect(screen.getByText(/ProviderError/)).toBeTruthy()
    expect(screen.getByText('Copy agent log')).toBeTruthy()
  })
})
