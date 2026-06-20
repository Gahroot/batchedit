import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { AgentReviewModal } from './AgentReviewModal'

const respondToReview = vi.fn()

beforeEach(() => {
  respondToReview.mockReset()
  // @ts-expect-error - window.api is provided by the preload bridge at runtime
  window.api = { agent: { respondToReview } }
})

afterEach(() => {
  useStore.setState({ agentReviewPrompt: null })
  // @ts-expect-error - reset the bridge between tests
  window.api = undefined
})

describe('AgentReviewModal', () => {
  it('renders nothing when there is no pending review', () => {
    render(<AgentReviewModal />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('labels the render gate by consequence and summarizes attach', () => {
    useStore.setState({
      agentReviewPrompt: {
        reviewId: 'r1',
        reason: 'ready_to_render',
        attach: { template: 'centered-bold', platform: 'tiktok', clipPath: '/v/hook-1.mp4' }
      }
    })

    render(<AgentReviewModal />)

    expect(screen.getByText('Ready to render')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve & render' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel render' })).toBeTruthy()
    // Friendly summary, not raw JSON in the main view.
    expect(screen.getByText('centered-bold')).toBeTruthy()
    expect(screen.getByText('hook-1.mp4')).toBeTruthy()
  })

  it('labels a flagged-clip review with continue copy', () => {
    useStore.setState({
      agentReviewPrompt: {
        reviewId: 'r2',
        reason: '2 clips were flagged during boundary QA',
        attach: { clips: [{ label: 'Hook 1' }, { label: 'CTA 3' }] }
      }
    })

    render(<AgentReviewModal />)

    expect(screen.getByRole('button', { name: 'Approve & continue' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(screen.getByText('Hook 1, CTA 3')).toBeTruthy()
  })

  it('approves with the approved flag', () => {
    useStore.setState({ agentReviewPrompt: { reviewId: 'r3', reason: 'ready_to_render' } })
    render(<AgentReviewModal />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve & render' }))

    expect(respondToReview).toHaveBeenCalledWith('r3', { approved: true })
  })

  it('treats dismissal (Escape) as a rejection so the agent never hangs', () => {
    useStore.setState({ agentReviewPrompt: { reviewId: 'r4', reason: 'ready_to_render' } })
    render(<AgentReviewModal />)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(respondToReview).toHaveBeenCalledWith('r4', { approved: false })
  })
})
