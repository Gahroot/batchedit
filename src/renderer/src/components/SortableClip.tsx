import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'

interface SortableClipProps {
  id: string
  clipName: string
  bucketLabel: string
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  disabled?: boolean
  children: React.ReactNode
}

const orderingButtonClassName =
  'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30'

export function SortableClip({
  id,
  clipName,
  bucketLabel,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  disabled = false,
  children
}: SortableClipProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({
    id,
    disabled,
    attributes: { roleDescription: 'sortable clip' }
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }

  const bucketDescription = `${bucketLabel} bucket`

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-1">
      <div className="flex shrink-0 flex-col items-center gap-0.5">
        <button
          {...attributes}
          {...listeners}
          ref={setActivatorNodeRef}
          type="button"
          className={`${orderingButtonClassName} cursor-grab active:cursor-grabbing`}
          disabled={disabled}
          aria-label={`Reorder ${clipName} in ${bucketDescription}`}
          title="Drag to reorder"
        >
          <GripVertical className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={orderingButtonClassName}
          onClick={onMoveUp}
          disabled={disabled || !canMoveUp}
          aria-label={`Move Up: ${clipName} in ${bucketDescription}`}
          title="Move Up"
        >
          <ArrowUp className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={orderingButtonClassName}
          onClick={onMoveDown}
          disabled={disabled || !canMoveDown}
          aria-label={`Move Down: ${clipName} in ${bucketDescription}`}
          title="Move Down"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
