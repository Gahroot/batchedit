import { AlertCircle, Bot, CheckCircle2, Clock, Copy, FolderOpen, Loader2, Play, Square } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { getAgentModel } from '../agent-models'
import { QaPanel } from './QaPanel'
import { useStore } from '../store'

const DETAIL_PREVIEW_LIMIT = 1200

type AgentEventRecord = Record<string, unknown>

function isRecord(value: unknown): value is AgentEventRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringifyDetail(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…` : value
}

function eventErrorMessage(event: AgentEventRecord): string {
  const error = event.error
  if (typeof error === 'string' && error.length > 0) return error
  if (isRecord(error) && typeof error.message === 'string') return error.message
  const diagnostics = event.diagnostics
  if (isRecord(diagnostics) && typeof diagnostics.message === 'string') return diagnostics.message
  return 'Unknown agent error'
}

function eventLabel(event: AgentEventRecord): string {
  if (event.type === 'text_delta') return String(event.text ?? '')
  if (event.type === 'thinking_delta') return 'Thinking…'
  if (event.type === 'agent_started') return 'Agent started'
  if (event.type === 'agent_done') return 'Agent finished'
  if (event.type === 'agent_canceled') return 'Agent canceled'
  if (event.type === 'agent_failed') return `Agent failed: ${eventErrorMessage(event)}`
  if (event.type === 'error') return `Error: ${eventErrorMessage(event)}`
  if (event.type === 'retry') {
    return `Retrying ${String(event.reason ?? 'request')} (${String(event.attempt ?? '?')}/${String(event.maxAttempts ?? '?')})`
  }
  if (event.type === 'tool_call_start') return `Calling ${String(event.name ?? 'tool')}`
  if (event.type === 'tool_call_update') return `Tool update: ${String(event.toolCallId ?? 'tool')}`
  if (event.type === 'tool_call_end') {
    const status = event.isError ? 'failed' : 'finished'
    return `Tool ${status} in ${String(event.durationMs ?? '?')}ms`
  }
  if (event.type === 'toolcall_delta') return `Reading tool arguments (${String(event.chars ?? 0)} chars)`
  if (event.type === 'turn_end') return `Turn ${String(event.turn ?? '?')}: ${String(event.stopReason ?? 'done')}`
  if (event.type === 'server_tool_call') return `Server tool: ${String(event.name ?? 'tool')}`
  if (event.type === 'server_tool_result') return `Server tool result: ${String(event.resultType ?? 'result')}`
  if (event.type === 'agent_diagnostic') return `Diagnostic: ${String(event.phase ?? 'event')}`
  if (event.type === 'logProgress') return `${String(event.phase ?? 'progress')}: ${String(event.message ?? '')}`
  if (event.type === 'review_requested') return `Review requested: ${String(event.reason ?? '')}`
  return String(event.type ?? 'event')
}

function eventDetails(event: AgentEventRecord): string {
  const detail = (() => {
    if (event.type === 'error' || event.type === 'agent_failed') return stringifyDetail(event.diagnostics ?? event)
    if (event.type === 'agent_diagnostic') return stringifyDetail(event.data)
    if (event.type === 'tool_call_start') return stringifyDetail(event.args)
    if (event.type === 'tool_call_update') return stringifyDetail(event.update)
    if (event.type === 'tool_call_end') return stringifyDetail(event.details ?? event.result)
    if (event.type === 'review_requested') return stringifyDetail(event.attach)
    if (event.type === 'logProgress') return stringifyDetail(event.data)
    if (event.type === 'turn_end') return stringifyDetail(event.usage)
    return ''
  })()

  return truncate(detail, DETAIL_PREVIEW_LIMIT)
}

function eventTone(event: AgentEventRecord): string {
  if (event.type === 'error' || event.type === 'agent_failed' || event.isError) {
    return 'border-destructive/40 bg-destructive/10 text-destructive'
  }
  if (event.type === 'agent_done') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
  if (event.type === 'agent_diagnostic') return 'border-muted bg-muted/40 text-muted-foreground'
  return 'border-border bg-background'
}

function EventIcon({ event }: { event: AgentEventRecord }) {
  if (event.type === 'error' || event.type === 'agent_failed' || event.isError) {
    return <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
  }
  if (event.type === 'agent_done') return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
  if (event.type === 'agent_diagnostic') return <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
  return null
}

function formatEventForClipboard(event: AgentEventRecord, index: number): string {
  const details = eventDetails(event)
  const header = `${String(index + 1).padStart(3, '0')} ${eventLabel(event)}`
  return details ? `${header}\n${details}` : header
}

/**
 * Human-readable wrap-up rendered in place of the bare "Agent finished" line.
 * Reads the renderer store snapshot the agent just populated (buckets, chosen
 * caption template, render results, output folder) so the user can see what was
 * created and jump straight to the files.
 */
function AgentDoneSummary(): React.JSX.Element {
  const hooks = useStore((state) => state.hooks)
  const meats = useStore((state) => state.meats)
  const ctas = useStore((state) => state.ctas)
  const captionStyle = useStore((state) => state.captionStyle)
  const targetPlatform = useStore((state) => state.targetPlatform)
  const renderProgress = useStore((state) => state.renderProgress)
  const outputDirectory = useStore((state) => state.settings.outputDirectory)

  const clipCount = hooks.length + meats.length + ctas.length
  const doneRenders = renderProgress.filter((rp) => rp.status === 'done').length
  const totalRenders = renderProgress.length

  const openOutputFolder = async (): Promise<void> => {
    if (!outputDirectory) return
    const error = await window.api.openPath(outputDirectory)
    if (error) toast.error(`Could not open output folder: ${error}`)
  }

  return (
    <div className="mt-1 space-y-1.5">
      <dl className="space-y-0.5">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Clips created</dt>
          <dd className="text-right font-medium">
            {clipCount} ({hooks.length} hook · {meats.length} meat · {ctas.length} CTA)
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Template</dt>
          <dd className="text-right font-medium">
            {captionStyle.label} · {targetPlatform}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Renders</dt>
          <dd className="text-right font-medium">
            {totalRenders > 0 ? `${doneRenders}/${totalRenders} complete` : 'none queued'}
          </dd>
        </div>
        {outputDirectory ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Output</dt>
            <dd className="min-w-0 truncate text-right font-medium" title={outputDirectory}>
              {outputDirectory}
            </dd>
          </div>
        ) : null}
      </dl>
      {outputDirectory ? (
        <Button
          size="sm"
          variant="outline"
          onClick={openOutputFolder}
          className="h-7 w-full text-xs"
        >
          <FolderOpen className="mr-2 h-3.5 w-3.5" />
          Open output folder
        </Button>
      ) : null}
    </div>
  )
}

export function AgentPanel() {
  const [runId, setRunId] = useState<string | null>(null)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const agentRunning = useStore((state) => state.agentRunning)
  const events = useStore((state) => state.agentEvents)
  const appendAgentEvent = useStore((state) => state.appendAgentEvent)
  const geminiApiKey = useStore((state) => state.geminiApiKey)
  const xiaomiApiKey = useStore((state) => state.xiaomiApiKey)
  const agentModelId = useStore((state) => state.agentModelId)

  const selectedModel = getAgentModel(agentModelId)
  const resolvedApiKey = selectedModel.keyKind === 'xiaomi' ? xiaomiApiKey : geminiApiKey
  const keyLabel = selectedModel.keyKind === 'xiaomi' ? 'Xiaomi' : 'Gemini'
  const hasApiKey = resolvedApiKey.trim().length > 0

  const chooseAndRun = async (): Promise<void> => {
    if (!hasApiKey) {
      const message = `Add your ${keyLabel} API key in the top bar to run the agent.`
      toast.error(message)
      appendAgentEvent({ type: 'error', error: message })
      return
    }
    try {
      const paths = await window.api.openFiles()
      const path = paths[0]
      if (!path) return
      setSourcePath(path)
      const selected = getAgentModel(agentModelId)
      const apiKey = selected.keyKind === 'xiaomi' ? xiaomiApiKey : geminiApiKey
      const result = await window.api.agent.start({
        sourcePath: path,
        provider: selected.provider,
        model: selected.model,
        apiKey: apiKey || undefined
      })
      setRunId(result.runId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendAgentEvent({
        type: 'error',
        error: message,
        diagnostics: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message }
      })
    }
  }

  const cancel = async (): Promise<void> => {
    if (!runId) return
    await window.api.agent.cancel(runId)
    setRunId(null)
  }

  const copyLogs = async (): Promise<void> => {
    const text = events.map(formatEventForClipboard).join('\n\n')
    await navigator.clipboard.writeText(text)
  }

  const copyEvent = async (event: AgentEventRecord, index: number): Promise<void> => {
    await navigator.clipboard.writeText(formatEventForClipboard(event, index))
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-card">
      <div className="border-b p-4">
        <div className="mb-1.5 flex items-center gap-2 font-semibold">
          <Bot className="h-4 w-4" />
          Agent
        </div>
        <p className="mb-3 text-xs leading-snug text-muted-foreground">
          Run Agent autonomously turns one raw recording into a render queue — it ingests, transcribes,
          detects “Hook/Meat/CTA” markers, splits and analyzes clips, picks a template, then queues the batch.
          Needs a source video, an API key, and an output folder.
        </p>
        <div className="flex gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex-1">
                  <Button
                    size="sm"
                    onClick={chooseAndRun}
                    disabled={agentRunning || !hasApiKey}
                    className="w-full"
                  >
                    {agentRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                    Run Agent
                  </Button>
                </span>
              </TooltipTrigger>
              {!hasApiKey ? (
                <TooltipContent>Add your {keyLabel} API key in the top bar to run the agent</TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>
          <Button size="sm" variant="outline" onClick={cancel} disabled={!agentRunning || !runId}>
            <Square className="h-4 w-4" />
          </Button>
        </div>
        {sourcePath ? <p className="mt-2 truncate text-xs text-muted-foreground">{sourcePath}</p> : null}
        {events.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={copyLogs} className="mt-2 h-7 w-full text-xs">
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy agent log
          </Button>
        ) : null}
      </div>
      <QaPanel />
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-2">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent activity yet.</p>
          ) : (
            events.map((event, index) => {
              const details = eventDetails(event)
              return (
                <div
                  key={`${String(event.type)}-${index}`}
                  className={`rounded-md border p-2 text-xs ${eventTone(event)}`}
                >
                  <div className="flex items-start gap-2">
                    <EventIcon event={event} />
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-medium">{eventLabel(event)}</div>
                      {event.type === 'agent_done' ? <AgentDoneSummary /> : null}
                      {details ? (
                        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-2 font-mono text-[10px] text-foreground">
                          {details}
                        </pre>
                      ) : null}
                    </div>
                    {details ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copyEvent(event, index)}
                        className="h-6 w-6 shrink-0 p-0"
                        title="Copy event details"
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>
      <div className="border-t p-3 text-xs text-muted-foreground">
        {agentRunning ? 'Agent running' : 'Agent idle'} · {events.length} events
      </div>
    </aside>
  )
}
