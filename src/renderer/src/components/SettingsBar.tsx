import { useStore, RESOLUTIONS } from '../store'
import { Settings, Monitor, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'

export function SettingsBar() {
  const settings = useStore((s) => s.settings)
  const setResolution = useStore((s) => s.setResolution)
  const setOutputDirectory = useStore((s) => s.setOutputDirectory)

  const handleChooseOutput = async () => {
    const dir = await window.api.openDirectory()
    if (dir) setOutputDirectory(dir)
  }

  return (
    <div className="flex items-center gap-4 px-6 py-2 border-b border-border bg-card/50 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Settings className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">Project</span>
      </div>

      {/* Resolution Picker */}
      <div className="flex items-center gap-2">
        <Monitor className="w-3.5 h-3.5 text-muted-foreground" />
        <Select
          value={settings.resolution.label}
          onValueChange={(value) => {
            const res = Object.values(RESOLUTIONS).find((r) => r.label === value)
            if (res) setResolution(res)
          }}
        >
          <SelectTrigger className="h-7 w-auto text-xs gap-1 px-2">
            <SelectValue placeholder="Resolution" />
          </SelectTrigger>
          <SelectContent>
            {Object.values(RESOLUTIONS).map((res) => (
              <SelectItem key={res.label} value={res.label}>
                {res.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Output Directory */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleChooseOutput} className="h-7 text-xs gap-1.5">
          <FolderOpen className="w-3.5 h-3.5" />
          {settings.outputDirectory
            ? settings.outputDirectory.split(/[/\\]/).pop()
            : 'Choose Output Folder'}
        </Button>
      </div>
    </div>
  )
}
