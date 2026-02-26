import { useState } from 'react'
import { useStore, CAPTION_PRESETS, CaptionStyle } from '../store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { cn } from '../lib/utils'

const PRESET_PREVIEWS: Record<string, { lines: string[]; highlight: number; desc: string }> = {
  'hormozi-bold': {
    lines: ['GET THIS', 'RIGHT NOW'],
    highlight: 0,
    desc: 'Large 2-word lines, green highlight, scale pop'
  },
  'tiktok-glow': {
    lines: ['this is how', 'you do it'],
    highlight: 0,
    desc: 'Neon glow outline, cyan highlight, 3-word lines'
  },
  'reels-clean': {
    lines: ['Check out this amazing new way to grow'],
    highlight: -1,
    desc: 'Small text, dark background box, fade'
  },
  'classic-karaoke': {
    lines: ['the classic look and feel'],
    highlight: 0,
    desc: 'Medium lines, yellow sweep fill'
  },
  'bold-clean': {
    lines: ['clean and', 'punchy'],
    highlight: -1,
    desc: 'Large text, dark shadow, scale pop'
  },
  'soft-highlight': {
    lines: ['a softer modern look'],
    highlight: 0,
    desc: 'Lavender highlight, thin outline'
  },
  'streaming-sub': {
    lines: ['Professional subtitles for any content'],
    highlight: -1,
    desc: 'Small text, dark box, streaming style'
  },
  'minimal-fade': {
    lines: ['simple clean captions'],
    highlight: -1,
    desc: 'Minimal text, subtle shadow, fade'
  }
}

function PreviewCard({
  preset,
  isActive,
  onClick
}: {
  preset: CaptionStyle
  isActive: boolean
  onClick: () => void
}) {
  const preview = PRESET_PREVIEWS[preset.id]
  const fontScale = preset.fontSize / 0.07 // relative to largest (Hormozi)

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col rounded-lg border-2 overflow-hidden transition-colors cursor-pointer',
        isActive ? 'border-primary' : 'border-border hover:border-muted-foreground'
      )}
    >
      {/* Preview area */}
      <div className="bg-black/90 flex flex-col items-center justify-center p-4 h-24 gap-1 w-full">
        {preview.lines.map((line, i) => {
          const isGlow = preset.animation === 'glow'
          return (
            <span
              key={i}
              className="font-bold leading-tight text-center w-full"
              style={{
                fontSize: `${Math.round(14 * fontScale)}px`,
                color: i === preview.highlight ? preset.highlightColor : preset.primaryColor,
                textShadow: isGlow
                  ? `0 0 8px ${preset.outlineColor}, 0 0 16px ${preset.outlineColor}, 0 0 2px ${preset.outlineColor}`
                  : preset.borderStyle === 3
                    ? 'none'
                    : preset.outline === 0 && preset.shadow > 0
                      ? `1px 1px ${preset.shadow}px ${preset.outlineColor}`
                      : `0 0 ${preset.outline}px ${preset.outlineColor}`,
                backgroundColor:
                  preset.borderStyle === 3 ? 'rgba(25,25,25,0.78)' : 'transparent',
                padding: preset.borderStyle === 3 ? '2px 8px' : '0',
                borderRadius: preset.borderStyle === 3 ? '4px' : '0',
                textTransform: preset.id === 'hormozi-bold' ? 'uppercase' : 'none'
              }}
            >
              {line}
            </span>
          )
        })}
      </div>
      {/* Label */}
      <div className="px-3 py-2 bg-card">
        <div className="text-xs font-medium">{preset.label}</div>
        <div className="text-[10px] text-muted-foreground">{preview.desc}</div>
      </div>
    </button>
  )
}

export function CaptionStylePicker({ disabled }: { disabled?: boolean }) {
  const captionStyle = useStore((s) => s.captionStyle)
  const setCaptionStyle = useStore((s) => s.setCaptionStyle)
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1 px-2" disabled={disabled}>
          {captionStyle.label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Caption Style</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 max-h-[70vh] overflow-y-auto">
          {Object.values(CAPTION_PRESETS).map((preset) => (
            <PreviewCard
              key={preset.id}
              preset={preset}
              isActive={captionStyle.id === preset.id}
              onClick={() => {
                setCaptionStyle(preset)
                setOpen(false)
              }}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
