import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Leak } from '../../shared/types'
import type { ToolContextState } from './tools/types'

const verifyClipBoundaryState = vi.fn()
const recutSourceClip = vi.fn()

vi.mock('./tools/verify', () => ({ verifyClipBoundaryState: (...args: unknown[]) => verifyClipBoundaryState(...args) }))
vi.mock('./tools/splits', () => ({ recutSourceClip: (...args: unknown[]) => recutSourceClip(...args) }))

const { runBoundaryQA } = await import('./boundary-qa')

interface VerifyState {
  clean: boolean
  leadingLeak: Leak | null
  trailingLeak: Leak | null
  confidence: number
}

function clean(): VerifyState {
  return { clean: true, leadingLeak: null, trailingLeak: null, confidence: 0.95 }
}

function leadingLeak(trimMs: number): VerifyState {
  return {
    clean: false,
    leadingLeak: { marker: 'Hook 2', matchedTokens: ['hook', 'two'], confidence: 0.8, suggestedTrimMs: trimMs },
    trailingLeak: null,
    confidence: 0.4
  }
}

interface TestCtx extends ToolContextState {
  win: ToolContextState['win'] & { webContents: { send: ReturnType<typeof vi.fn> } }
}

function makeCtx(): TestCtx {
  const ctx = {
    win: { webContents: { send: vi.fn() } },
    runId: 'run-1',
    model: 'm',
    clipAllowlist: new Set<string>(),
    sourceAllowlist: new Set<string>(),
    approvedRenderAtTurn: null,
    jobLedger: undefined
  }
  return ctx as unknown as TestCtx
}

function makeClip(): { label: string; bucket: 'hook'; path: string; duration: number; sourceStart: number; sourceEnd: number } {
  return { label: 'Hook 1', bucket: 'hook', path: '/clips/01.mp4', duration: 3, sourceStart: 1, sourceEnd: 4 }
}

beforeEach(() => {
  verifyClipBoundaryState.mockReset()
  recutSourceClip.mockReset()
  recutSourceClip.mockImplementation(async () => ({ outputPath: '/clips/01-recut.mp4', duration: 2.8 }))
})

describe('runBoundaryQA', () => {
  it('marks an already-clean clip clean without recutting', async () => {
    verifyClipBoundaryState.mockResolvedValueOnce(clean())
    const report = await runBoundaryQA(makeCtx(), '/src.mp4', [makeClip()])

    expect(report.cleanCount).toBe(1)
    expect(report.clips[0].status).toBe('clean')
    expect(report.clips[0].recutCount).toBe(0)
    expect(recutSourceClip).not.toHaveBeenCalled()
  })

  it('auto-fixes a leaky clip via recut then re-verify', async () => {
    verifyClipBoundaryState
      .mockResolvedValueOnce(leadingLeak(200))
      .mockResolvedValueOnce(clean())
    const report = await runBoundaryQA(makeCtx(), '/src.mp4', [makeClip()])

    expect(recutSourceClip).toHaveBeenCalledTimes(1)
    // leading trim of 200ms pulls the source start from 1.0s to 1.2s
    expect(recutSourceClip.mock.calls[0][2]).toBeCloseTo(1200)
    expect(report.autoFixedCount).toBe(1)
    expect(report.clips[0].status).toBe('auto_fixed')
    expect(report.clips[0].recutCount).toBe(1)
  })

  it('flags a clip that stays dirty after the recut budget', async () => {
    verifyClipBoundaryState.mockResolvedValue(leadingLeak(100))
    const report = await runBoundaryQA(makeCtx(), '/src.mp4', [makeClip()], { maxRecuts: 2 })

    expect(recutSourceClip).toHaveBeenCalledTimes(2)
    expect(report.flaggedCount).toBe(1)
    expect(report.clips[0].status).toBe('flagged')
  })

  it('emits qa lifecycle events to the renderer', async () => {
    verifyClipBoundaryState.mockResolvedValueOnce(clean())
    const ctx = makeCtx()
    await runBoundaryQA(ctx, '/src.mp4', [makeClip()])

    const types = ctx.win.webContents.send.mock.calls.map((call) => (call[1] as { type: string }).type)
    expect(types).toEqual(['qa_started', 'qa_clip', 'qa_complete'])
  })
})
