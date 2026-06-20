import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { useStore, Combo, RenderProgress } from '../store'
import { cn } from '../lib/utils'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger
} from '@/components/ui/hover-card'

type CellStatus = 'idle' | 'queued' | 'rendering' | 'done' | 'error'

interface CellInfo {
  combo: Combo
  status: CellStatus
  phase?: RenderProgress['status'] | undefined
  percent: number
  error?: string | undefined
}

// Any phase where FFmpeg is actively working on a job. Keep in sync with
// RenderProgressStatus in store.ts (mirrors render-pipeline.ts emitted statuses).
const ACTIVE_STATUSES = new Set(['rendering', 'normalizing', 'concatenating', 'overlaying'])

export function statusOf(rp: RenderProgress | undefined): CellStatus {
  if (!rp) return 'idle'
  if (rp.status === 'done') return 'done'
  if (rp.status === 'error') return 'error'
  if (ACTIVE_STATUSES.has(rp.status)) return 'rendering'
  return 'queued'
}

const statusClass: Record<CellStatus, string> = {
  idle: 'bg-secondary/40 border-border/50',
  queued: 'bg-muted-foreground/30 border-muted-foreground/40',
  rendering: 'bg-primary/70 border-primary animate-pulse',
  done: 'bg-emerald-500 border-emerald-400',
  error: 'bg-destructive border-destructive'
}

export function PermutationMatrix() {
  const combos = useStore((s) => s.getCombos())
  const renderProgress = useStore((s) => s.renderProgress)
  const jobIdToComboId = useStore((s) => s.jobIdToComboId)

  const cells = useMemo<CellInfo[]>(() => {
    const comboIdToProgress = new Map<string, RenderProgress>()
    for (const rp of renderProgress) {
      const comboId = jobIdToComboId[rp.jobId]
      if (comboId) comboIdToProgress.set(comboId, rp)
    }
    return combos.map((combo) => {
      const rp = comboIdToProgress.get(combo.id)
      return {
        combo,
        status: statusOf(rp),
        phase: rp?.status,
        percent: rp?.percent ?? 0,
        error: rp?.error
      }
    })
  }, [combos, renderProgress, jobIdToComboId])

  if (cells.length === 0) return null

  return (
    <div
      className="grid gap-1 max-h-40 overflow-y-auto p-0.5"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(18px, 1fr))' }}
    >
      {cells.map((cell) => (
        <HoverCard key={cell.combo.id} openDelay={120} closeDelay={50}>
          <HoverCardTrigger asChild>
            <motion.div
              layout="position"
              initial={false}
              animate={
                cell.status === 'done'
                  ? { scale: [0.9, 1.08, 1] }
                  : cell.status === 'error'
                    ? { scale: [0.9, 1.05, 1] }
                    : { scale: 1 }
              }
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className={cn(
                'aspect-square rounded-[3px] border cursor-default',
                statusClass[cell.status]
              )}
            />
          </HoverCardTrigger>
          <HoverCardContent side="top" className="w-auto max-w-xs p-3 text-xs">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-block w-2 h-2 rounded-full',
                    statusClass[cell.status].split(' ')[0]
                  )}
                />
                <span className="font-mono font-semibold uppercase tracking-wide">
                  {cell.status === 'rendering' && cell.phase ? cell.phase : cell.status === 'idle' ? 'queued' : cell.status}
                  {cell.status === 'rendering' && ` · ${Math.round(cell.percent)}%`}
                </span>
              </div>
              <div className="text-muted-foreground space-y-0.5">
                <div className="truncate"><span className="text-blue-400">H:</span> {cell.combo.hook.name}</div>
                <div className="truncate"><span className="text-green-400">M:</span> {cell.combo.meat.name}</div>
                <div className="truncate"><span className="text-orange-400">C:</span> {cell.combo.cta.name}</div>
              </div>
              {cell.error && (
                <div className="text-destructive text-[10px] mt-1 break-all">{cell.error}</div>
              )}
            </div>
          </HoverCardContent>
        </HoverCard>
      ))}
    </div>
  )
}
