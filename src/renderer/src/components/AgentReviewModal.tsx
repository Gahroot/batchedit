import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type ReviewPrompt, useStore } from '../store'

/** The agent sends `reason: "ready_to_render"` for the final render gate. */
const RENDER_GATE_REASON = 'ready_to_render'

interface SummaryItem {
  label: string
  value: string
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function previewTranscript(transcript: unknown[]): string {
  const words = transcript
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object' && 'word' in entry) return String((entry as { word: unknown }).word)
      if (entry && typeof entry === 'object' && 'text' in entry) return String((entry as { text: unknown }).text)
      return ''
    })
    .filter(Boolean)
  const joined = words.join(' ').trim()
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined
}

/** Turn the freeform `attach` payload into a readable, labeled summary. */
function summarizeAttach(attach: unknown): SummaryItem[] {
  if (!attach || typeof attach !== 'object') return []
  const record = attach as Record<string, unknown>
  const items: SummaryItem[] = []

  if (typeof record.clipPath === 'string' && record.clipPath) {
    items.push({ label: 'Clip', value: basename(record.clipPath) })
  }
  if (Array.isArray(record.clips)) {
    const labels = record.clips
      .map((c) => (c && typeof c === 'object' && 'label' in c ? String((c as { label: unknown }).label) : null))
      .filter((l): l is string => Boolean(l))
    items.push({
      label: labels.length === 1 ? 'Flagged clip' : 'Flagged clips',
      value: labels.length > 0 ? labels.join(', ') : `${record.clips.length} clip(s)`
    })
  }
  if (Array.isArray(record.frames) && record.frames.length > 0) {
    items.push({ label: 'Frames sampled', value: String(record.frames.length) })
  }
  if (Array.isArray(record.transcript) && record.transcript.length > 0) {
    const preview = previewTranscript(record.transcript)
    items.push({ label: 'Transcript', value: preview || `${record.transcript.length} words` })
  }
  if (typeof record.template === 'string' && record.template) {
    items.push({ label: 'Template', value: record.template })
  }
  if (typeof record.platform === 'string' && record.platform) {
    items.push({ label: 'Platform', value: record.platform })
  }
  return items
}

interface ReviewCopy {
  title: string
  description: string
  approveLabel: string
  rejectLabel: string
}

function reviewCopy(prompt: ReviewPrompt): ReviewCopy {
  const isRenderGate = prompt.reason.trim() === RENDER_GATE_REASON
  if (isRenderGate) {
    return {
      title: 'Ready to render',
      description:
        'The agent has prepared the full render queue and is waiting for your go-ahead. Approving starts rendering every permutation now.',
      approveLabel: 'Approve & render',
      rejectLabel: 'Cancel render'
    }
  }
  return {
    title: 'Agent review required',
    description: prompt.reason,
    approveLabel: 'Approve & continue',
    rejectLabel: 'Reject'
  }
}

export function AgentReviewModal(): React.JSX.Element {
  const prompt = useStore((state) => state.agentReviewPrompt)
  const respondToReview = useStore((state) => state.respondToReview)

  const copy = prompt ? reviewCopy(prompt) : null
  const summary = prompt ? summarizeAttach(prompt.attach) : []
  const hasAttach = prompt?.attach != null && (typeof prompt.attach !== 'object' || Object.keys(prompt.attach).length > 0)

  return (
    <Dialog
      open={prompt !== null}
      // Dismissing via X / overlay / Escape must still resolve the agent's
      // promise — treat any dismissal-without-a-choice as a rejection so the
      // run never hangs.
      onOpenChange={(open) => {
        if (!open) respondToReview({ approved: false })
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy?.title}</DialogTitle>
          {copy?.description ? <DialogDescription>{copy.description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-4">
          {summary.length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-md bg-muted p-3 text-sm">
              {summary.map((item) => (
                <div key={item.label} className="contents">
                  <dt className="font-medium text-muted-foreground">{item.label}</dt>
                  <dd className="break-words">{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {hasAttach ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw details</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-3">
                {JSON.stringify(prompt?.attach, null, 2)}
              </pre>
            </details>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => respondToReview({ approved: false })}>
              {copy?.rejectLabel ?? 'Reject'}
            </Button>
            <Button onClick={() => respondToReview({ approved: true })}>{copy?.approveLabel ?? 'Approve'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
