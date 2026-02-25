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
}

export function WhisperStatus({
  isLoading,
  isReady,
  loadProgress,
  isTranscribing,
  currentClip
}: WhisperStatusProps) {
  return (
    <AnimatePresence>
      {isLoading && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="flex items-center gap-3 mb-2"
        >
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Downloading Whisper model...</span>
          <Progress value={loadProgress} className="flex-1 h-2" />
          <span className="text-xs font-mono text-muted-foreground">{loadProgress}%</span>
        </motion.div>
      )}
      {isReady && !isTranscribing && !isLoading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <Badge variant="outline" className="text-green-500 border-green-500/30">
            Whisper Ready
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
