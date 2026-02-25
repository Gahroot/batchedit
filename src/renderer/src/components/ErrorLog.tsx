import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Trash2 } from 'lucide-react'
import { useStore, ErrorLogEntry } from '../store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

function formatEntry(entry: ErrorLogEntry): string {
  const time = formatTime(entry.timestamp)
  const src = entry.source === 'caption' ? 'CAP' : entry.source === 'hooktext' ? 'AI' : 'REN'
  return `[${time}] [${src}] ${entry.clipName}: ${entry.message}`
}

export function ErrorLog() {
  const errorLog = useStore((s) => s.errorLog)
  const clearErrors = useStore((s) => s.clearErrors)
  const [expanded, setExpanded] = useState(false)

  if (errorLog.length === 0) return null

  const copyAll = async () => {
    const text = errorLog.map(formatEntry).join('\n')
    await navigator.clipboard.writeText(text)
  }

  const copyOne = async (entry: ErrorLogEntry) => {
    await navigator.clipboard.writeText(formatEntry(entry))
  }

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-destructive" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-destructive" />
        )}
        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
          {errorLog.length} error{errorLog.length !== 1 ? 's' : ''}
        </Badge>
      </button>

      {expanded && (
        <div className="mt-1.5 border border-destructive/30 rounded-md bg-destructive/5 p-2">
          <div className="flex items-center justify-end gap-1 mb-1.5">
            <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={copyAll}>
              <Copy className="w-3 h-3 mr-1" />
              Copy All
            </Button>
            <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={clearErrors}>
              <Trash2 className="w-3 h-3 mr-1" />
              Clear
            </Button>
          </div>
          <ScrollArea className="max-h-40">
            <div className="space-y-1">
              {errorLog.map((entry) => (
                <div
                  key={entry.id}
                  onClick={() => copyOne(entry)}
                  className="flex items-start gap-1.5 text-[10px] p-1 rounded hover:bg-destructive/10 cursor-pointer transition-colors select-text"
                  title="Click to copy"
                >
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 shrink-0 font-mono border-destructive/40"
                  >
                    {entry.source === 'caption' ? 'CAP' : entry.source === 'hooktext' ? 'AI' : 'REN'}
                  </Badge>
                  <span className="text-muted-foreground shrink-0 font-mono">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span className="font-medium shrink-0">{entry.clipName}</span>
                  <span className="text-muted-foreground truncate">{entry.message}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
