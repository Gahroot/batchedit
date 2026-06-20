import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import { AgentPanel } from './AgentPanel'

describe('AgentPanel', () => {
  afterEach(() => {
    useStore.setState({
      agentEvents: [],
      agentRunning: false,
      agentReviewPrompt: null,
      hooks: [],
      meats: [],
      ctas: [],
      renderProgress: []
    })
  })

  it('renders idle state', () => {
    render(<AgentPanel />)

    expect(screen.getByText('Agent')).toBeTruthy()
    expect(screen.getByText('No agent activity yet.')).toBeTruthy()
  })

  it('explains what Run Agent does', () => {
    render(<AgentPanel />)

    expect(screen.getByText(/autonomously turns one raw recording into a render queue/)).toBeTruthy()
    expect(screen.getByText(/source video, an API key, and an output folder/)).toBeTruthy()
  })

  it('summarizes results when the agent finishes', () => {
    const clip = (id: string) => ({ id, path: `/v/${id}.mp4`, name: id, duration: 2 })
    useStore.setState({
      agentEvents: [{ type: 'agent_done' }],
      hooks: [clip('h1')],
      meats: [clip('m1'), clip('m2')],
      ctas: [clip('c1')],
      renderProgress: [
        { jobId: 'a', percent: 100, status: 'done' },
        { jobId: 'b', percent: 100, status: 'done' }
      ],
      settings: { ...useStore.getState().settings, outputDirectory: '/out/ads' }
    })

    render(<AgentPanel />)

    expect(screen.getByText('Agent finished')).toBeTruthy()
    expect(screen.getByText(/1 hook · 2 meat · 1 CTA/)).toBeTruthy()
    expect(screen.getByText('2/2 complete')).toBeTruthy()
    expect(screen.getByText('/out/ads')).toBeTruthy()
    expect(screen.getByText('Open output folder')).toBeTruthy()
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
