import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from './store'
import { handleProjectCloseRequest } from './project-close'
import { Bucket } from './components/Bucket'
import { RenderPanel } from './components/RenderPanel'
import { SettingsBar } from './components/SettingsBar'
import { Film, Save, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ClipSplitter } from './components/ClipSplitter'
import { TemplateEditor } from './components/TemplateEditor'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { NumberTicker } from '@/components/ui/number-ticker'
import { FFmpegBanner } from './components/FFmpegBanner'
import { FirstRunGuide } from './components/FirstRunGuide'
import { useQaTranscribeBridge } from './hooks/useQaTranscribeBridge'
import { detectWhisperDevice } from './lib/whisper-config'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function App() {
  useQaTranscribeBridge()
  const totalCombos = useStore((s) => s.getTotalCombinations())
  const saveProject = useStore((s) => s.saveProject)
  const loadProject = useStore((s) => s.loadProject)
  const activeProjectPath = useStore((s) => s.activeProjectPath)
  const isDirty = useStore((s) => s.isDirty)
  const initializeWhisperDevice = useStore((s) => s.initializeWhisperDevice)

  useEffect(() => {
    let active = true

    const initialize = async (): Promise<void> => {
      const device = await detectWhisperDevice()
      if (active) initializeWhisperDevice(device)
    }

    void initialize()
    return () => {
      active = false
    }
  }, [initializeWhisperDevice])

  useEffect(() => {
    return window.api.onProjectCloseRequested(() => {
      void handleProjectCloseRequest({
        getState: useStore.getState,
        chooseAction: window.api.chooseProjectCloseAction,
        completeClose: window.api.completeProjectClose,
        onSaved: (path, isClean) => {
          if (isClean) toast.success(`Saved to ${path}`)
          else toast.warning('Project saved, but newer changes are still unsaved')
        },
        onError: (error) => {
          toast.error("Couldn't save project", { description: errorMessage(error) })
        }
      })
    })
  }, [])

  const handleSave = async (): Promise<void> => {
    try {
      const path = await saveProject()
      if (path) toast.success(`Saved to ${path}`)
    } catch (error) {
      toast.error("Couldn't save project", { description: errorMessage(error) })
    }
  }

  const handleLoad = async (): Promise<void> => {
    try {
      const result = await loadProject()
      if (result.ok) {
        toast.success('Project loaded')
        if (result.missingCount > 0) {
          const count = result.missingCount
          toast.warning(
            `${count} project dependenc${count === 1 ? 'y is' : 'ies are'} missing`,
            {
              description: 'Use Relink beside each missing clip or image before rendering.',
              duration: 10000
            }
          )
        }
      } else if (result.reason === 'corrupt') {
        toast.error("Couldn't load project file — it may be corrupt")
      }
    } catch (error) {
      toast.error("Couldn't load project", { description: errorMessage(error) })
    }
  }

  const projectName = activeProjectPath?.split(/[/\\]/).pop() || 'Untitled'
  const projectStatus = isDirty ? 'Unsaved' : activeProjectPath ? 'Saved' : 'Not saved'

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-3">
          <Film className="w-6 h-6 text-primary" />
          <h1 className="text-lg font-semibold">BatchEdit</h1>
          <div className="flex items-center gap-1 ml-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSave}
              title="Save Project"
              aria-label="Save Project"
              className="gap-1.5"
            >
              <Save className="w-4 h-4" />
              <span className="text-xs">Save</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLoad}
              title="Load Project"
              aria-label="Load Project"
              className="gap-1.5"
            >
              <FolderOpen className="w-4 h-4" />
              <span className="text-xs">Load</span>
            </Button>
          </div>
          <output
            aria-live="polite"
            title={activeProjectPath || 'This project has not been saved yet'}
            className="flex max-w-56 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${isDirty ? 'bg-amber-400' : activeProjectPath ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
            />
            <span className={isDirty ? 'truncate text-amber-500' : 'truncate'}>
              {projectName} · {projectStatus}
            </span>
          </output>
        </div>
        <div className="flex items-center gap-4">
          <TemplateEditor />
          <ClipSplitter />
          <AnimatePresence>
            {totalCombos > 0 && (
              <motion.div
                key="combos-badge"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
              >
                <Badge variant="secondary" className="font-mono">
                  <NumberTicker value={totalCombos} /> combinations
                </Badge>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* Video engine readiness warning */}
      <FFmpegBanner />

      {/* Settings */}
      <SettingsBar />
      <Separator />

      {/* First-run orientation (hidden once any clip exists) */}
      <FirstRunGuide />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Main Content - Three Buckets */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <main className="flex-1 flex gap-4 p-4 overflow-hidden">
            <Bucket type="hook" label="Hooks" color="text-blue-400" />
            <Bucket type="meat" label="Meats" color="text-green-400" />
            <Bucket type="cta" label="CTAs" color="text-orange-400" />
          </main>

          {/* Render Panel */}
          <RenderPanel />
        </div>
      </div>


      {/* Global toast container */}
      <Toaster richColors position="bottom-right" />
    </div>
  )
}

export default App
