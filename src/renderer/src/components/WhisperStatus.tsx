import { motion, AnimatePresence } from 'framer-motion'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Loader2 } from 'lucide-react'

interface WhisperStatusProps {
  isLoading: boolean
  isReady: boolean
  loadProgress: number
  isTranscribing: boolean
  currentClip?: string
  /** Short model label, e.g. "Turbo (best, WebGPU)" */
  modelLabel?: string
  /** Approximate one-time download size, e.g. "~1.6 GB" */
  modelSize?: string
}

export function WhisperStatus({
  isLoading,
  isReady,
  loadProgress,
  isTranscribing,
  currentClip,
  modelLabel,
  modelSize
}: WhisperStatusProps) {
  return (
    <AnimatePresence>
      {isLoading && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mb-2"
        >
          <div className="flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">
              Downloading Whisper model{modelLabel ? ` — ${modelLabel}` : ''}
              {modelSize ? ` (${modelSize})` : ''}...
            </span>
            <Progress value={loadProgress} className="flex-1 h-2" />
            <span className="text-xs font-mono text-muted-foreground">{loadProgress}%</span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            First run downloads this model once, then it's cached for future renders.
          </p>
        </motion.div>
      )}
      {isReady && !isTranscribing && !isLoading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <Badge variant="outline" className="text-green-500 border-green-500/30">
            Whisper Ready{modelLabel ? ` — ${modelLabel}` : ''}
          </Badge>
        </motion.div>
      )}
      {isTranscribing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-2 mb-2"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">
            Transcribing{currentClip ? ` ${currentClip}` : ''}...
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
