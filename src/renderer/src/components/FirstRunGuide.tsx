import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles, X } from 'lucide-react'
import { useStore } from '../store'
import { Button } from '@/components/ui/button'

const DISMISS_KEY = 'batchedit-firstrun-dismissed'

const STEPS: readonly { n: number; text: string }[] = [
  { n: 1, text: 'Add clips to Hooks, Meats & CTAs' },
  { n: 2, text: 'Choose an output folder' },
  { n: 3, text: 'Render every combination' }
] as const

/**
 * Lightweight first-run orientation shown only when all three buckets are
 * empty. Explains what Hook/Meat/CTA are and the order of operations, then
 * disappears automatically once any clip is added. Dismissible; the dismissal
 * is remembered so it never reappears for returning users.
 */
export function FirstRunGuide(): React.JSX.Element {
  const hooks = useStore((s) => s.hooks)
  const meats = useStore((s) => s.meats)
  const ctas = useStore((s) => s.ctas)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')

  const allEmpty = hooks.length === 0 && meats.length === 0 && ctas.length === 0
  const visible = allEmpty && !dismissed

  const handleDismiss = (): void => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="firstrun-guide"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden border-b border-border bg-primary/5"
        >
          <div className="relative flex items-start gap-3 px-6 py-4">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0 pr-8">
              <p className="text-sm font-semibold">Welcome to BatchEdit</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Drop clips into three buckets — a <span className="text-blue-400">Hook</span>{' '}
                grabs attention, a <span className="text-green-400">Meat</span> is the main
                message, and a <span className="text-orange-400">CTA</span> is the call to action.
                BatchEdit renders every Hook→Meat→CTA combination for you.
              </p>
              <ol className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
                {STEPS.map((step) => (
                  <li key={step.n} className="flex items-center gap-2 text-xs">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[11px] font-semibold text-primary">
                      {step.n}
                    </span>
                    <span>{step.text}</span>
                  </li>
                ))}
              </ol>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDismiss}
              title="Dismiss guide"
              aria-label="Dismiss guide"
              className="absolute right-3 top-3 h-7 w-7"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
