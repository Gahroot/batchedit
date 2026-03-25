import { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { LayoutTemplate, Type, Captions, Image } from 'lucide-react'
import { useStore, TemplateLayout, Platform } from '../store'
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

export function TemplateEditor() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const snappedRef = useRef({ x: false, y: false })
  const [isSnapped, setIsSnapped] = useState({ x: false, y: false })
  const settings = useStore((s) => s.settings)
  const templateLayout = useStore((s) => s.templateLayout)
  const setTemplateLayout = useStore((s) => s.setTemplateLayout)
  const targetPlatform = useStore((s) => s.targetPlatform)
  const setTargetPlatform = useStore((s) => s.setTargetPlatform)

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
    <Dialog>
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

              {/* Person silhouette */}
              <div className="absolute inset-0 flex items-center justify-center opacity-10">
                <div className="w-24 h-52 bg-white rounded-full" />
              </div>

              {/* Title Text */}
              <DraggableElement id="titleText" position={templateLayout.titleText}>
                <div className="flex items-center gap-1.5 bg-violet-500 rounded-full px-4 py-1.5 text-white text-sm font-semibold whitespace-nowrap select-none">
                  <Type className="w-3.5 h-3.5" />
                  Title Text
                </div>
              </DraggableElement>

              {/* Subtitles */}
              <DraggableElement id="subtitles" position={templateLayout.subtitles}>
                <div className="flex items-center gap-1.5 text-white font-bold text-lg whitespace-nowrap select-none drop-shadow-lg">
                  <Captions className="w-4 h-4" />
                  Subtitles
                </div>
              </DraggableElement>

              {/* Media */}
              <DraggableElement id="media" position={templateLayout.media}>
                <div className="flex items-center justify-center gap-1.5 border-2 border-dashed border-white/50 rounded-xl px-6 py-4 text-white/50 text-sm whitespace-nowrap select-none">
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
