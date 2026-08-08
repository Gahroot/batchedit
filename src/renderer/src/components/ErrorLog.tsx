import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
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
  const head = `[${time}] [${src}] ${entry.clipName}: ${entry.message}`
  // Append the raw technical detail (e.g. FFmpeg stderr) for bug reports.
  return entry.detail ? `${head}\n${entry.detail}` : head
}

export function ErrorLog() {
  const errorLog = useStore((s) => s.errorLog)
  const clearErrors = useStore((s) => s.clearErrors)
  const [expanded, setExpanded] = useState(false)
  const prevCount = useRef(errorLog.length)

  // Auto-expand when the log goes from empty to non-empty (e.g. a render or
  // transcription just failed) so failures are not hidden behind a small badge.
  // Stays manually collapsible afterward.
  useEffect(() => {
    if (prevCount.current === 0 && errorLog.length > 0) {
      setExpanded(true)
    }
    prevCount.current = errorLog.length
  }, [errorLog.length])

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
              <AnimatePresence initial={false}>
                {errorLog.map((entry) => (
                  <motion.div
                    key={entry.id}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    transition={{ duration: 0.2 }}
                    onClick={() => copyOne(entry)}
                    className="flex items-start gap-1.5 text-[10px] p-1 rounded hover:bg-destructive/10 cursor-pointer transition-colors select-text"
                    title="Click to copy"
                  >
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 shrink-0 font-mono border-destructive/40"
                    >
                      {entry.source === 'caption'
                        ? 'CAP'
                        : entry.source === 'hooktext'
                          ? 'AI'
                          : entry.source === 'ingest'
                            ? 'ING'
                            : 'REN'}
                    </Badge>
                    <span className="text-muted-foreground shrink-0 font-mono">
                      {formatTime(entry.timestamp)}
                    </span>
                    <span className="font-medium shrink-0">{entry.clipName}</span>
                    <span className="text-muted-foreground truncate">{entry.message}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
