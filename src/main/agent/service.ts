import { Agent, setStreamDiagnostic, type AgentEvent } from '@prestyj/agent'
import type { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { ProviderError, providerRegistry, type Provider } from '@prestyj/ai'
import { createGoogleProviderEntry, GEMINI_FLASH_MODEL, GOOGLE_PROVIDER } from './google-provider'
import { JobLedger } from './job-ledger'
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
  private currentRun: { runId: string; controller: AbortController } | null = null

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
    this.currentRun = { runId, controller }
    const ctx: ToolContextState = {
      win: this.win,
      sourceAllowlist: new Set<string>(),
      clipAllowlist: new Set<string>(),
      approvedRenderAtTurn: null,
      jobLedger: this.jobLedger,
      apiKey: options.apiKey ?? process.env.GEMINI_API_KEY,
      provider: options.provider ?? GOOGLE_PROVIDER,
      model: options.model ?? GEMINI_FLASH_MODEL,
      runId
    }
    const agent = new Agent({
      provider: (options.provider ?? GOOGLE_PROVIDER) as Provider,
      model: options.model ?? GEMINI_FLASH_MODEL,
      apiKey: options.apiKey ?? process.env.GEMINI_API_KEY,
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

  cancel(runId: string): void {
    if (this.currentRun?.runId !== runId) return
    this.currentRun.controller.abort()
    this.currentRun = null
    this.win.webContents.send('agent:event', { runId, type: 'agent_canceled' })
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
    const safeEvent = event.type === 'error'
      ? { ...event, error: event.error.message, diagnostics: diagnosticsFromError(event.error) }
      : event
    this.win.webContents.send('agent:event', { runId, ...safeEvent })
  }
}
