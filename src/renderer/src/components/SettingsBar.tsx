import { useStore, RESOLUTIONS } from '../store'
import { AGENT_MODELS, getAgentModel } from '../agent-models'
import { Settings, Monitor, FolderOpen, Key, ExternalLink, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  const geminiApiKey = useStore((s) => s.geminiApiKey)
  const setGeminiApiKey = useStore((s) => s.setGeminiApiKey)
  const xiaomiApiKey = useStore((s) => s.xiaomiApiKey)
  const setXiaomiApiKey = useStore((s) => s.setXiaomiApiKey)
  const agentModelId = useStore((s) => s.agentModelId)
  const setAgentModelId = useStore((s) => s.setAgentModelId)

  const selectedModel = getAgentModel(agentModelId)
  const usesXiaomi = selectedModel.keyKind === 'xiaomi'
  const keyValue = usesXiaomi ? xiaomiApiKey : geminiApiKey
  const setKeyValue = usesXiaomi ? setXiaomiApiKey : setGeminiApiKey
  const keyPlaceholder = usesXiaomi ? 'Xiaomi MiMo API Key' : 'Gemini API Key'
  const keyUrl = usesXiaomi ? 'https://platform.xiaomimimo.com/' : 'https://aistudio.google.com/apikey'

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

      {/* Agent model picker + matching API key */}
      <div className="flex items-center gap-2 ml-auto">
        <Bot className="w-3.5 h-3.5 text-muted-foreground" />
        <Select value={agentModelId} onValueChange={setAgentModelId}>
          <SelectTrigger className="h-7 w-auto text-xs gap-1 px-2">
            <SelectValue placeholder="Agent model" />
          </SelectTrigger>
          <SelectContent>
            {AGENT_MODELS.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Key className="w-3.5 h-3.5 text-muted-foreground" />
        <Input
          type="password"
          placeholder={keyPlaceholder}
          value={keyValue}
          onChange={(e) => setKeyValue(e.target.value)}
          className="h-7 w-48 text-xs px-2"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1 px-2 text-muted-foreground"
          onClick={() => window.open(keyUrl, '_blank')}
        >
          <ExternalLink className="w-3 h-3" />
          Get Key
        </Button>
      </div>
    </div>
  )
}
