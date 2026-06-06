import {
  AlertTriangle,
  Check,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Loader2,
  ShieldCheck,
  Wrench
} from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStore, type ClipQaResult } from '../store'

const NUDGE_MS = 100

function statusMeta(status: ClipQaResult['status']): {
  label: string
  className: string
  Icon: typeof ShieldCheck
} {
  if (status === 'clean') {
    return { label: 'Clean', className: 'text-emerald-600', Icon: ShieldCheck }
  }
  if (status === 'auto_fixed') {
    return { label: 'Auto-fixed', className: 'text-amber-600', Icon: Wrench }
  }
  return { label: 'Needs review', className: 'text-destructive', Icon: AlertTriangle }
}

function leakSummary(clip: ClipQaResult): string | null {
  const parts: string[] = []
  if (clip.leadingLeak) parts.push(`start: heard "${clip.leadingLeak.marker}"`)
  if (clip.trailingLeak) parts.push(`end: heard "${clip.trailingLeak.marker}"`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function QaRow({ clip }: { clip: ClipQaResult }): React.JSX.Element {
  const applyQaRecut = useStore((s) => s.applyQaRecut)
  const resolveQaClip = useStore((s) => s.resolveQaClip)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { label, className, Icon } = statusMeta(clip.status)
  const leak = leakSummary(clip)
  const flagged = clip.status === 'flagged'

  const nudge = async (startDeltaMs: number, endDeltaMs: number): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await applyQaRecut(clip, startDeltaMs, endDeltaMs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border bg-background p-2 text-xs">
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} />
        <span className="min-w-0 flex-1 truncate font-medium">{clip.label}</span>
        <Badge variant={flagged ? 'destructive' : 'secondary'} className="shrink-0 text-[10px]">
          {label}
        </Badge>
      </div>
      {leak ? <p className="mt-1 break-words text-[11px] text-muted-foreground">{leak}</p> : null}
      {clip.recutCount > 0 ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          recut ×{clip.recutCount} · {Math.round(clip.confidence * 100)}% confidence
        </p>
      ) : null}
      {error ? <p className="mt-1 text-[10px] text-destructive">{error}</p> : null}
      {flagged ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            disabled={busy}
            onClick={() => nudge(NUDGE_MS, 0)}
            title="Trim 100ms off the start"
          >
            <ChevronsRightLeft className="mr-1 h-3 w-3" />
            Start +100
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            disabled={busy}
            onClick={() => nudge(0, -NUDGE_MS)}
            title="Trim 100ms off the end"
          >
            <ChevronsLeftRight className="mr-1 h-3 w-3" />
            End −100
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            disabled={busy}
            onClick={() => resolveQaClip(clip)}
            title="Accept this clip as-is"
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
            Approve
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function QaPanel(): React.JSX.Element | null {
  const qaClips = useStore((s) => s.qaClips)
  if (qaClips.length === 0) return null

  const flaggedCount = qaClips.filter((c) => c.status === 'flagged').length
  const autoFixedCount = qaClips.filter((c) => c.status === 'auto_fixed').length

  return (
    <div className="border-b">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3 text-xs font-semibold">
        <ShieldCheck className="h-3.5 w-3.5" />
        Boundary QA
        <span className="ml-auto font-normal text-muted-foreground">
          {flaggedCount > 0 ? `${flaggedCount} need review` : `${autoFixedCount} auto-fixed`}
        </span>
      </div>
      <div className="max-h-64 space-y-1.5 overflow-auto px-4 pb-3">
        {qaClips.map((clip) => (
          <QaRow key={`${clip.bucket}:${clip.label}`} clip={clip} />
        ))}
      </div>
    </div>
  )
}
