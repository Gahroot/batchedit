import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StepperProps {
  steps: string[]
  current: number
  className?: string
}

export function Stepper({ steps, current, className }: StepperProps) {
  return (
    <div className={cn('flex items-center w-full', className)}>
      {steps.map((label, i) => {
        const state: 'done' | 'active' | 'pending' =
          i < current ? 'done' : i === current ? 'active' : 'pending'
        return (
          <div key={label} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <motion.div
                initial={false}
                animate={{
                  scale: state === 'active' ? 1.1 : 1,
                  backgroundColor:
                    state === 'done'
                      ? 'rgb(16 185 129)'
                      : state === 'active'
                        ? 'hsl(var(--primary))'
                        : 'hsl(var(--muted))'
                }}
                transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold"
              >
                {state === 'done' ? (
                  <Check className="w-3.5 h-3.5 text-white" />
                ) : (
                  <span
                    className={cn(
                      state === 'active' ? 'text-primary-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {i + 1}
                  </span>
                )}
              </motion.div>
              <span
                className={cn(
                  'text-[10px] font-medium whitespace-nowrap',
                  state === 'pending' ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className="flex-1 h-[2px] mx-2 bg-muted relative overflow-hidden rounded-full -mt-4">
                <motion.div
                  initial={false}
                  animate={{ width: i < current ? '100%' : '0%' }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                  className="absolute inset-y-0 left-0 bg-emerald-500"
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
