import { useId, type JSX } from 'react'
import { Brain, Cpu, Zap } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useStore } from '../store'
import {
  getWhisperDeviceLabel,
  getWhisperModelInfo,
  WHISPER_DEVICE,
  WHISPER_MODELS
} from '../lib/whisper-config'
import { cn } from '../lib/utils'

interface WhisperModelControlProps {
  className?: string
  disabled?: boolean
  compact?: boolean
}

export function WhisperModelControl({
  className,
  disabled = false,
  compact = false
}: WhisperModelControlProps): JSX.Element {
  const selectId = useId()
  const whisperDevice = useStore((state) => state.whisperDevice)
  const whisperModel = useStore((state) => state.whisperModel)
  const setWhisperModel = useStore((state) => state.setWhisperModel)
  const modelInfo = getWhisperModelInfo(whisperModel)
  const isDetecting = whisperDevice === 'detecting'
  const DeviceIcon = isDetecting ? Brain : whisperDevice === WHISPER_DEVICE.WEBGPU ? Zap : Cpu

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className={cn('flex gap-2', compact ? 'items-center' : 'items-end')}>
        <div className="space-y-1 flex-1 min-w-0">
          {!compact && (
            <label htmlFor={selectId} className="text-xs flex items-center gap-1.5">
              <Brain className="w-3.5 h-3.5" />
              Speech model
            </label>
          )}
          {isDetecting ? (
            <div
              className={cn(
                'flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs text-muted-foreground',
                compact && 'h-7'
              )}
            >
              Detecting WebGPU…
            </div>
          ) : (
            <Select value={whisperModel} onValueChange={setWhisperModel} disabled={disabled}>
              <SelectTrigger
                id={selectId}
                aria-label="Speech model"
                className={cn('h-8 text-xs', compact && 'h-7')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WHISPER_MODELS.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    disabled={model.requiresWebGpu && whisperDevice !== WHISPER_DEVICE.WEBGPU}
                  >
                    {model.label} · {model.approxSize}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      <p className="text-[10px] leading-4 text-muted-foreground" aria-live="polite">
        <DeviceIcon className="inline w-3 h-3 mr-1 -mt-0.5" />
        {isDetecting ? (
          'Checking WebGPU before selecting a model. No download has started.'
        ) : (
          <>
            {modelInfo.shortLabel} · {modelInfo.approxSize} if not cached ·{' '}
            {getWhisperDeviceLabel(whisperDevice)}. Download starts only when you start
            transcription; completed models stay cached.
          </>
        )}
      </p>
    </div>
  )
}
