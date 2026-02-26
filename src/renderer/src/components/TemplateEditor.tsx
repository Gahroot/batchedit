import { useRef, useCallback, useState } from 'react'
import { LayoutTemplate, Type, Captions, Image } from 'lucide-react'
import { useStore, TemplateLayout } from '../store'
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

  const aspectRatio = settings.resolution.width / settings.resolution.height
  const canvasHeight = 420
  const canvasWidth = Math.min(600, Math.round(canvasHeight * aspectRatio))

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

    const newX = snappedRef.current.x
      ? 50
      : Math.max(0, Math.min(100, current.x + deltaXPct))
    const newY = snappedRef.current.y
      ? 50
      : Math.max(0, Math.min(100, current.y + deltaYPct))

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
            <span className="font-mono">
              {settings.resolution.width}&times;{settings.resolution.height}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
