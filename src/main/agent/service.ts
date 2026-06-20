import { Agent, setStreamDiagnostic, type AgentEvent } from '@prestyj/agent'
import type { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { ProviderError, providerRegistry, type Provider } from '@prestyj/ai'
import { manualRecutClip, type ManualRecutParams } from './boundary-qa'
import { isWindowAlive } from './window-guard'
import { createGoogleProviderEntry, GEMINI_FLASH_MODEL, GOOGLE_PROVIDER } from './google-provider'
import { JobLedger } from './job-ledger'
import type { ClipQaResult } from '../../shared/types'
import { buildSystemPrompt } from './system-prompt'
import { buildTools } from './tools'
import type { ToolContextState } from './tools/types'

type AgentProvider = Provider | typeof GOOGLE_PROVIDER

type AgentServiceEvent =
  | AgentEvent
  | { type: 'agent_diagnostic'; phase: string; data?: Record<string, unknown> }
  | { type: 'agent_failed'; error: string; diagnostics: ErrorDiagnostics }

interface ErrorDiagnostics {
  name: string
  message: string
  stack?: string
  provider?: string
  statusCode?: number
  cause?: string
}

if (!providerRegistry.has(GOOGLE_PROVIDER)) providerRegistry.register(GOOGLE_PROVIDER, createGoogleProviderEntry())

/** Built-in @prestyj/ai provider name for Xiaomi MiMo (OpenAI-compatible Token Plan endpoint). */
const XIAOMI_PROVIDER = 'xiaomi'

/** Resolve the API key from the environment for a provider when none is passed explicitly. */
function envKeyForProvider(provider: AgentProvider): string | undefined {
  if (provider === XIAOMI_PROVIDER) {
    return process.env.XIAOMI_API_KEY ?? process.env.MIMO_API_KEY
  }
  return process.env.GEMINI_API_KEY
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function diagnosticsFromError(error: Error): ErrorDiagnostics {
  const diagnostics: ErrorDiagnostics = {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {})
  }

  if (error instanceof ProviderError) {
    diagnostics.provider = error.provider
    if (error.statusCode !== undefined) diagnostics.statusCode = error.statusCode
  }

  const cause = error.cause
  if (cause instanceof Error) {
    diagnostics.cause = `${cause.name}: ${cause.message}${cause.stack ? `\n${cause.stack}` : ''}`
  } else if (cause !== undefined) {
    diagnostics.cause = String(cause)
  }

  return diagnostics
}

function sanitizeDiagnosticData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !key.toLowerCase().includes('key'))
  )
}

export interface AgentStartOptions {
  sourcePath: string
  provider?: AgentProvider
  model?: string
  apiKey?: string
}

export interface AgentStartResult {
  runId: string
}

export class AgentService {
  private readonly win: BrowserWindow
  private readonly jobLedger = new JobLedger()
  private currentRun: {
    runId: string
    controller: AbortController
    ctx: ToolContextState
  } | null = null

  constructor(win: BrowserWindow) {
    this.win = win
  }

  get ledger(): JobLedger {
    return this.jobLedger
  }

  async start(options: AgentStartOptions): Promise<AgentStartResult> {
    if (this.currentRun) throw new Error('Agent is already running')
    const runId = uuidv4()
    const controller = new AbortController()
    const provider = options.provider ?? GOOGLE_PROVIDER
    const model = options.model ?? GEMINI_FLASH_MODEL
    const apiKey = options.apiKey ?? envKeyForProvider(provider)
    const ctx: ToolContextState = {
      win: this.win,
      sourceAllowlist: new Set<string>(),
      clipAllowlist: new Set<string>(),
      approvedRenderAtTurn: null,
      jobLedger: this.jobLedger,
      apiKey,
      provider,
      model,
      runId
    }
    this.currentRun = { runId, controller, ctx }
    const agent = new Agent({
      provider: provider as Provider,
      model,
      apiKey,
      system: buildSystemPrompt(),
      tools: buildTools(ctx),
      maxTurns: 80,
      maxToolResultChars: 24_000,
      signal: controller.signal
    })

    this.runAgent(runId, agent, options.sourcePath).catch((error) => {
      this.reportFailure(runId, error)
    })

    return { runId }
  }

  /**
   * Apply a human nudge from the QA panel against the active run's context.
   * The clip's source bounds come from the renderer (carried on the qa_clip
   * event), so this only needs to re-cut and re-verify under the run allowlist.
   */
  async qaRecut(params: ManualRecutParams): Promise<ClipQaResult> {
    if (!this.currentRun) throw new Error('No active agent run')
    return manualRecutClip(this.currentRun.ctx, params, this.currentRun.controller.signal)
  }

  cancel(runId: string): void {
    if (this.currentRun?.runId !== runId) return
    this.currentRun.controller.abort()
    this.currentRun = null
    if (isWindowAlive(this.win)) this.win.webContents.send('agent:event', { runId, type: 'agent_canceled' })
  }

  private async runAgent(runId: string, agent: Agent, sourcePath: string): Promise<void> {
    this.sendEvent(runId, { type: 'agent_started' })
    setStreamDiagnostic((phase, data) => {
      const safeData = sanitizeDiagnosticData(data)
      console.info('agent_diagnostic', { runId, phase, ...(safeData ? { data: safeData } : {}) })
      this.sendEvent(runId, { type: 'agent_diagnostic', phase, ...(safeData ? { data: safeData } : {}) })
    })

    try {
      const stream = agent.prompt(`Run the full BatchEdit pipeline for this raw source recording: ${sourcePath}`)
      const iterator = stream[Symbol.asyncIterator]()
      const result = stream.then(
        (value) => value,
        (error) => normalizeError(error)
      )

      while (true) {
        let next: IteratorResult<AgentEvent>
        try {
          next = await iterator.next()
        } catch (error) {
          throw normalizeError(error)
        }
        if (next.done) break
        this.sendEvent(runId, next.value)
      }

      const finalResult = await result
      if (finalResult instanceof Error) throw finalResult
    } finally {
      setStreamDiagnostic(null)
      if (this.currentRun?.runId === runId) this.currentRun = null
    }
  }

  private reportFailure(runId: string, error: unknown): void {
    const normalizedError = normalizeError(error)
    const diagnostics = diagnosticsFromError(normalizedError)
    console.error('agent_failed', { runId, ...diagnostics })
    this.sendEvent(runId, { type: 'agent_failed', error: normalizedError.message, diagnostics })
  }

  private sendEvent(runId: string, event: AgentServiceEvent): void {
    if (!isWindowAlive(this.win)) return
    const safeEvent = event.type === 'error'
      ? { ...event, error: event.error.message, diagnostics: diagnosticsFromError(event.error) }
      : event
    this.win.webContents.send('agent:event', { runId, ...safeEvent })
  }
}
