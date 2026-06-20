import { useRef, useCallback, useState, useMemo } from 'react'
import { LayoutTemplate, Type, Image, RotateCcw } from 'lucide-react'
import { useStore, TemplateLayout, Platform, CaptionStyle, DEFAULT_TEMPLATE_LAYOUT } from '../store'
import { DndContext, useDraggable, DragEndEvent, DragMoveEvent } from '@dnd-kit/core'
import { restrictToParentElement } from '@dnd-kit/modifiers'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'

/** Canvas constants matching safe-zones.ts */
const CANVAS_W = 1080
const CANVAS_H = 1920

/** Platform dead zone definitions (mirrors safe-zones.ts — kept inline to avoid IPC round-trip) */
const PLATFORM_DEAD_ZONES: Record<Platform, { top: number; bottom: number; left: number; right: number; name: string; engagementRight: number }> = {
  tiktok:    { top: 108, bottom: 320, left: 60,  right: 120, name: 'TikTok',    engagementRight: 120 },
  reels:     { top: 210, bottom: 310, left: 0,   right: 84,  name: 'Reels',     engagementRight: 84 },
  shorts:    { top: 120, bottom: 300, left: 0,   right: 96,  name: 'Shorts',    engagementRight: 96 },
  universal: { top: 210, bottom: 320, left: 60,  right: 120, name: 'Universal', engagementRight: 120 },
}

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'universal', label: 'Universal' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'reels', label: 'Reels' },
  { value: 'shorts', label: 'Shorts' },
]

function DraggableElement({
  id,
  position,
  children
}: {
  id: string
  position: { x: number; y: number }
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id })

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'absolute',
        left: `${position.x}%`,
        top: `${position.y}%`,
        transform: `translate(-50%, -50%)${transform ? ` translate(${transform.x}px, ${transform.y}px)` : ''}`,
        cursor: 'grab',
        touchAction: 'none',
        zIndex: transform ? 10 : 1
      }}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  )
}

const SNAP_THRESHOLD_PX = 8

/** Renders a small sample line in the selected caption style so the preview reflects real output. */
function CaptionSample({ style, text }: { style: CaptionStyle; text: string }): React.JSX.Element {
  const isGlow = style.animation === 'glow'
  const isBox = style.borderStyle === 3
  const textShadow = isGlow
    ? `0 0 6px ${style.outlineColor}, 0 0 12px ${style.outlineColor}, 0 0 2px ${style.outlineColor}`
    : isBox
      ? 'none'
      : style.outline === 0 && style.shadow > 0
        ? `1px 1px ${style.shadow}px ${style.outlineColor}`
        : `0 0 ${style.outline}px ${style.outlineColor}`

  return (
    <span
      className="font-bold leading-tight text-center whitespace-nowrap select-none"
      style={{
        fontSize: 16,
        color: style.highlightColor,
        textShadow,
        backgroundColor: isBox ? 'rgba(25,25,25,0.78)' : 'transparent',
        padding: isBox ? '2px 8px' : '0',
        borderRadius: isBox ? 4 : 0,
        textTransform: style.id === 'hormozi-bold' ? 'uppercase' : 'none'
      }}
    >
      {text}
    </span>
  )
}

export function TemplateEditor() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const snappedRef = useRef({ x: false, y: false })
  const [isSnapped, setIsSnapped] = useState({ x: false, y: false })
  const settings = useStore((s) => s.settings)
  const templateLayout = useStore((s) => s.templateLayout)
  const setTemplateLayout = useStore((s) => s.setTemplateLayout)
  const targetPlatform = useStore((s) => s.targetPlatform)
  const setTargetPlatform = useStore((s) => s.setTargetPlatform)
  const hooks = useStore((s) => s.hooks)
  const hookTexts = useStore((s) => s.hookTexts)
  const captionStyle = useStore((s) => s.captionStyle)

  // Dialog session: snapshot the layout on open so Cancel can revert in-session drags.
  const [open, setOpen] = useState(false)
  const sessionStartLayout = useRef<TemplateLayout | null>(null)

  // Real preview content drawn from the user's first hook and selected caption style.
  const firstHook = hooks[0]
  const hookText = (firstHook && hookTexts[firstHook.id]?.trim()) || ''
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) sessionStartLayout.current = templateLayout
      setOpen(next)
    },
    [templateLayout]
  )

  const aspectRatio = settings.resolution.width / settings.resolution.height
  const canvasHeight = 420
  const canvasWidth = Math.min(600, Math.round(canvasHeight * aspectRatio))

  const deadZone = PLATFORM_DEAD_ZONES[targetPlatform]

  /** Convert a pixel value on the 1080×1920 canvas to a percentage of the preview canvas */
  const scaleX = canvasWidth / CANVAS_W
  const scaleY = canvasHeight / CANVAS_H

  /** Dead zone overlay rects in preview-canvas pixels */
  const dzOverlays = useMemo(() => ({
    top: { left: 0, top: 0, width: canvasWidth, height: deadZone.top * scaleY },
    bottom: { left: 0, top: canvasHeight - deadZone.bottom * scaleY, width: canvasWidth, height: deadZone.bottom * scaleY },
    left: deadZone.left > 0
      ? { left: 0, top: deadZone.top * scaleY, width: deadZone.left * scaleX, height: canvasHeight - (deadZone.top + deadZone.bottom) * scaleY }
      : null,
    right: { left: canvasWidth - deadZone.right * scaleX, top: deadZone.top * scaleY, width: deadZone.right * scaleX, height: canvasHeight - (deadZone.top + deadZone.bottom) * scaleY },
  }), [canvasWidth, canvasHeight, deadZone, scaleX, scaleY])

  /** Safe zone rect in preview pixels */
  const safeRect = useMemo(() => ({
    left: deadZone.left * scaleX,
    top: deadZone.top * scaleY,
    width: (CANVAS_W - deadZone.left - deadZone.right) * scaleX,
    height: (CANVAS_H - deadZone.top - deadZone.bottom) * scaleY,
  }), [deadZone, scaleX, scaleY])

  // Pure modifier — only writes to ref, never calls setState
  const snapToCenter = useCallback(
    ({ active, transform }: { active: { id: string | number } | null; transform: { x: number; y: number; scaleX: number; scaleY: number } }) => {
      if (!canvasRef.current || !active) return transform

      const rect = canvasRef.current.getBoundingClientRect()
      const key = active.id as keyof TemplateLayout
      const pos = templateLayout[key]

      const result = { ...transform }
      let sx = false
      let sy = false

      const startX = (pos.x / 100) * rect.width
      const projectedX = startX + transform.x
      if (Math.abs(projectedX - rect.width / 2) < SNAP_THRESHOLD_PX) {
        result.x = rect.width / 2 - startX
        sx = true
      }

      const startY = (pos.y / 100) * rect.height
      const projectedY = startY + transform.y
      if (Math.abs(projectedY - rect.height / 2) < SNAP_THRESHOLD_PX) {
        result.y = rect.height / 2 - startY
        sy = true
      }

      snappedRef.current = { x: sx, y: sy }
      return result
    },
    [templateLayout]
  )

  // Update visual guideline highlights from event handler (safe to setState here)
  const handleDragMove = useCallback((_event: DragMoveEvent) => {
    const snap = snappedRef.current
    setIsSnapped((prev) =>
      prev.x === snap.x && prev.y === snap.y ? prev : { x: snap.x, y: snap.y }
    )
  }, [])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, delta } = event
    if (!canvasRef.current) return

    const rect = canvasRef.current.getBoundingClientRect()
    const deltaXPct = (delta.x / rect.width) * 100
    const deltaYPct = (delta.y / rect.height) * 100

    const key = active.id as keyof TemplateLayout
    const current = templateLayout[key]

    // Compute raw new position
    let newX = snappedRef.current.x
      ? 50
      : current.x + deltaXPct
    let newY = snappedRef.current.y
      ? 50
      : current.y + deltaYPct

    // Clamp to safe zone bounds (percentage of canvas)
    const safeLeftPct = (deadZone.left / CANVAS_W) * 100
    const safeRightPct = ((CANVAS_W - deadZone.right) / CANVAS_W) * 100
    const safeTopPct = (deadZone.top / CANVAS_H) * 100
    const safeBottomPct = ((CANVAS_H - deadZone.bottom) / CANVAS_H) * 100

    newX = Math.max(safeLeftPct, Math.min(safeRightPct, newX))
    newY = Math.max(safeTopPct, Math.min(safeBottomPct, newY))

    setTemplateLayout({
      ...templateLayout,
      [key]: { x: newX, y: newY }
    })

    snappedRef.current = { x: false, y: false }
    setIsSnapped({ x: false, y: false })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <LayoutTemplate className="w-4 h-4" />
          Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate className="w-5 h-5" />
            Template Editor
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {/* Platform selector */}
          <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
            {PLATFORMS.map((p) => (
              <button
                key={p.value}
                onClick={() => setTargetPlatform(p.value)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  targetPlatform === p.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <DndContext
            modifiers={[restrictToParentElement, snapToCenter]}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
          >
            <div
              ref={canvasRef}
              className="relative bg-zinc-900 rounded-lg overflow-hidden border border-border"
              style={{ width: canvasWidth, height: canvasHeight }}
            >
              {/* Dead zone overlays */}
              {/* Top */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: dzOverlays.top.left,
                  top: dzOverlays.top.top,
                  width: dzOverlays.top.width,
                  height: dzOverlays.top.height,
                  background: 'rgba(239, 68, 68, 0.18)',
                }}
              />
              {/* Bottom */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: dzOverlays.bottom.left,
                  top: dzOverlays.bottom.top,
                  width: dzOverlays.bottom.width,
                  height: dzOverlays.bottom.height,
                  background: 'rgba(239, 68, 68, 0.18)',
                }}
              />
              {/* Left */}
              {dzOverlays.left && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: dzOverlays.left.left,
                    top: dzOverlays.left.top,
                    width: dzOverlays.left.width,
                    height: dzOverlays.left.height,
                    background: 'rgba(239, 68, 68, 0.18)',
                  }}
                />
              )}
              {/* Right (engagement button column) */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: dzOverlays.right.left,
                  top: dzOverlays.right.top,
                  width: dzOverlays.right.width,
                  height: dzOverlays.right.height,
                  background: 'rgba(239, 68, 68, 0.12)',
                }}
              >
                {/* Engagement button dots */}
                <div className="flex flex-col items-center justify-center gap-2 h-full opacity-40">
                  {['♥', '💬', '↗', '🔖'].map((icon, i) => (
                    <div key={i} className="text-[8px] text-white">{icon}</div>
                  ))}
                </div>
              </div>

              {/* Safe zone border */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: safeRect.left,
                  top: safeRect.top,
                  width: safeRect.width,
                  height: safeRect.height,
                  border: '1px dashed rgba(34, 197, 94, 0.35)',
                  borderRadius: 4,
                }}
              />

              {/* Horizontal center guideline */}
              <div
                className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-px transition-colors duration-75"
                style={{
                  borderLeft: '1px dashed',
                  borderColor: isSnapped.x ? 'rgba(139,92,246,0.7)' : 'rgba(255,255,255,0.15)'
                }}
              />
              {/* Vertical center guideline */}
              <div
                className="absolute left-0 right-0 top-1/2 h-px -translate-y-px transition-colors duration-75"
                style={{
                  borderTop: '1px dashed',
                  borderColor: isSnapped.y ? 'rgba(139,92,246,0.7)' : 'rgba(255,255,255,0.15)'
                }}
              />

              {/* Real clip frame as background, or a neutral silhouette fallback */}
              {firstHook?.thumbnail ? (
                <img
                  src={firstHook.thumbnail}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none">
                  <div className="w-24 h-52 bg-white rounded-full" />
                </div>
              )}

              {/* Title Text — the user's real hook text when present */}
              <DraggableElement id="titleText" position={templateLayout.titleText}>
                {hookText ? (
                  <div className="max-w-[80%] bg-violet-500 rounded-full px-4 py-1.5 text-white text-sm font-semibold text-center select-none">
                    {hookText}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 bg-violet-500/80 rounded-full px-4 py-1.5 text-white/90 text-sm font-semibold whitespace-nowrap select-none">
                    <Type className="w-3.5 h-3.5" />
                    Title Text
                  </div>
                )}
              </DraggableElement>

              {/* Subtitles — a sample rendered in the selected caption style */}
              <DraggableElement id="subtitles" position={templateLayout.subtitles}>
                <CaptionSample style={captionStyle} text="Sample captions" />
              </DraggableElement>

              {/* Media */}
              <DraggableElement id="media" position={templateLayout.media}>
                <div className="flex items-center justify-center gap-1.5 border-2 border-dashed border-white/50 rounded-xl px-6 py-4 text-white/70 text-sm whitespace-nowrap select-none">
                  <Image className="w-4 h-4" />
                  Media
                </div>
              </DraggableElement>
            </div>
          </DndContext>

          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>Drag elements to reposition</span>
            <span className="text-green-500/70 font-medium">{deadZone.name}</span>
            <span className="font-mono">
              Safe: {CANVAS_W - deadZone.left - deadZone.right}&times;{CANVAS_H - deadZone.top - deadZone.bottom}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 w-full pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => setTemplateLayout(DEFAULT_TEMPLATE_LAYOUT)}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to default
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (sessionStartLayout.current) setTemplateLayout(sessionStartLayout.current)
                  setOpen(false)
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
