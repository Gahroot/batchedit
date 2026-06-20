import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from './store'
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
import { AgentPanel } from './components/AgentPanel'
import { FFmpegBanner } from './components/FFmpegBanner'
import { FirstRunGuide } from './components/FirstRunGuide'
import { AgentReviewModal } from './components/AgentReviewModal'
import { useAgentEvents } from './hooks/useAgentEvents'
import { useAgentRenderBridge } from './hooks/useAgentRenderBridge'
import { useAgentStoreBridge } from './hooks/useAgentStoreBridge'
import { useAgentTranscribeBridge } from './hooks/useAgentTranscribeBridge'

function App() {
  useAgentEvents()
  useAgentRenderBridge()
  useAgentStoreBridge()
  useAgentTranscribeBridge()
  const totalCombos = useStore((s) => s.getTotalCombinations())
  const saveProject = useStore((s) => s.saveProject)
  const loadProject = useStore((s) => s.loadProject)

  const handleSave = async (): Promise<void> => {
    const path = await saveProject()
    if (path) toast.success(`Saved to ${path}`)
  }

  const handleLoad = async (): Promise<void> => {
    const result = await loadProject()
    if (result.ok) {
      toast.success('Project loaded')
    } else if (result.reason === 'corrupt') {
      toast.error("Couldn't load project file — it may be corrupt")
    }
  }

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
        <AgentPanel />
      </div>

      <AgentReviewModal />

      {/* Global toast container */}
      <Toaster richColors position="bottom-right" />
    </div>
  )
}

export default App
