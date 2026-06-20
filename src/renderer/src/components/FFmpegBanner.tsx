import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'

interface ReadinessState {
  ready: boolean
  issues: string[]
}

/**
 * Persistent banner shown when the bundled FFmpeg/ffprobe binaries fail to
 * resolve (packaged builds, antivirus quarantine). Without this the user only
 * discovers the failure when a render fails with a generic per-job error.
 */
export function FFmpegBanner(): React.JSX.Element {
  const [readiness, setReadiness] = useState<ReadinessState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .getFFmpegReadiness()
      .then((result) => {
        if (!cancelled) setReadiness(result)
      })
      .catch(() => {
        if (!cancelled) {
          setReadiness({
            ready: false,
            issues: ['Could not determine video engine status.']
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const visible = readiness !== null && !readiness.ready

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="ffmpeg-banner"
          role="alert"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden border-b border-destructive/40 bg-destructive/10 text-destructive"
        >
          <div className="flex items-start gap-3 px-6 py-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="min-w-0 text-sm">
              <p className="font-semibold">Video engine unavailable</p>
              <p className="text-destructive/90">
                FFmpeg could not be loaded, so rendering and thumbnails won&apos;t work.
              </p>
              {readiness.issues.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-destructive/80">
                  {readiness.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
