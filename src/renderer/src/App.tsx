import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from './store'
import { Bucket } from './components/Bucket'
import { RenderPanel } from './components/RenderPanel'
import { SettingsBar } from './components/SettingsBar'
import { Film } from 'lucide-react'
import { ClipSplitter } from './components/ClipSplitter'
import { TemplateEditor } from './components/TemplateEditor'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

function App() {
  const totalCombos = useStore((s) => s.getTotalCombinations())

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-3">
          <Film className="w-6 h-6 text-primary" />
          <h1 className="text-lg font-semibold">BatchEdit</h1>
        </div>
        <div className="flex items-center gap-4">
          <TemplateEditor />
          <ClipSplitter />
          {totalCombos > 0 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <Badge variant="secondary" className="font-mono">{totalCombos} combinations</Badge>
            </motion.div>
          )}
        </div>
      </header>

      {/* Settings */}
      <SettingsBar />
      <Separator />

      {/* Main Content - Three Buckets */}
      <main className="flex-1 flex gap-4 p-4 overflow-hidden">
        <Bucket type="hook" label="Hooks" color="text-blue-400" />
        <Bucket type="meat" label="Meats" color="text-green-400" />
        <Bucket type="cta" label="CTAs" color="text-orange-400" />
      </main>

      {/* Render Panel */}
      <RenderPanel />
    </div>
  )
}

export default App
