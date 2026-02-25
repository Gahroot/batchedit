import { useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, X, Type, FileVideo } from 'lucide-react'
import { useStore, BucketType, Clip } from '../store'
import { cn } from '../lib/utils'
import { v4 as uuidv4 } from 'uuid'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { DndContext, closestCenter, DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableClip } from './SortableClip'

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm']

interface BucketProps {
  type: BucketType
  label: string
  color: string
}

export function Bucket({ type, label, color }: BucketProps) {
  const clips = useStore((s) =>
    type === 'hook' ? s.hooks : type === 'meat' ? s.meats : s.ctas
  )
  const addClips = useStore((s) => s.addClips)
  const removeClip = useStore((s) => s.removeClip)
  const reorderClips = useStore((s) => s.reorderClips)
  const hookTexts = useStore((s) => s.hookTexts)
  const setHookText = useStore((s) => s.setHookText)
  const isRendering = useStore((s) => s.isRendering)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleAddClips = useCallback(async () => {
    const filePaths = await window.api.openFiles()
    if (!filePaths || filePaths.length === 0) return

    const newClips: Clip[] = await Promise.all(
      filePaths.map(async (path) => {
        const name = path.split(/[/\\]/).pop() || 'Unknown'
        const [meta, thumbnail] = await Promise.all([
          window.api.getMetadata(path).catch(() => ({ duration: 0 })),
          window.api.getThumbnail(path).catch(() => undefined)
        ])
        return { id: uuidv4(), path, name, duration: meta.duration, thumbnail }
      })
    )

    addClips(type, newClips)
  }, [type, addClips])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = clips.findIndex((c) => c.id === active.id)
    const newIndex = clips.findIndex((c) => c.id === over.id)
    const reordered = arrayMove(clips, oldIndex, newIndex)
    reorderClips(type, reordered)
  }

  return (
    <Card
      className={cn('flex-1 flex flex-col min-w-0 overflow-hidden', isDragOver && 'ring-2 ring-primary bg-primary/5')}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true) }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false) }}
      onDrop={async (e) => {
        e.preventDefault(); e.stopPropagation(); setIsDragOver(false)
        if (isRendering) return
        const files = Array.from(e.dataTransfer.files)
        const videoPaths = files
          .filter((f) => VIDEO_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)))
          .map((f) => window.api.getPathForFile(f))
        if (videoPaths.length === 0) return
        const newClips = await Promise.all(
          videoPaths.map(async (path) => {
            const name = path.split(/[/\\]/).pop() || 'Unknown'
            const [meta, thumbnail] = await Promise.all([
              window.api.getMetadata(path).catch(() => ({ duration: 0 })),
              window.api.getThumbnail(path).catch(() => undefined)
            ])
            return { id: uuidv4(), path, name, duration: meta.duration, thumbnail }
          })
        )
        addClips(type, newClips)
      }}
    >
      {/* Bucket Header */}
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <FileVideo className={cn('w-4 h-4', color)} />
          <h2 className="font-medium text-sm">{label}</h2>
          <Badge variant="outline" className="font-mono text-xs">{clips.length}</Badge>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleAddClips}
          disabled={isRendering}
          className="h-7 text-xs gap-1"
        >
          <Plus className="w-3 h-3" />
          Add
        </Button>
      </CardHeader>

      {/* Clips List */}
      <CardContent className="flex-1 p-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-2 space-y-2">
            {clips.length === 0 ? (
              <AnimatePresence mode="popLayout">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2 py-12"
                >
                  <FileVideo className="w-8 h-8 opacity-30" />
                  <p>Drop clips here or click Add</p>
                </motion.div>
              </AnimatePresence>
            ) : (
              <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis]}>
                <SortableContext items={clips.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  <AnimatePresence mode="popLayout">
                    {clips.map((clip) => (
                      <motion.div
                        key={clip.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                      >
                        <SortableClip id={clip.id} disabled={isRendering}>
                          <div className="group flex flex-col gap-1.5 p-2.5 rounded-md bg-secondary/50 hover:bg-secondary transition-colors">
                            <div className="flex items-center gap-2">
                              {clip.thumbnail ? (
                                <img
                                  src={clip.thumbnail}
                                  alt=""
                                  className="w-16 h-9 rounded object-cover shrink-0"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                />
                              ) : (
                                <FileVideo className={cn('w-8 h-8 shrink-0', color)} />
                              )}
                              <span className="text-xs font-medium truncate flex-1 mr-2">{clip.name}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  {clip.duration > 0 ? `${clip.duration.toFixed(1)}s` : '---'}
                                </span>
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                                        onClick={() => removeClip(type, clip.id)}
                                        disabled={isRendering}
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Remove clip</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                            </div>

                            {/* Text overlay input for hooks */}
                            {type === 'hook' && (
                              <div className="flex items-center gap-1.5">
                                <Type className="w-3 h-3 text-muted-foreground shrink-0" />
                                <Input
                                  type="text"
                                  placeholder="On-screen text (optional)"
                                  value={hookTexts[clip.id] || ''}
                                  onChange={(e) => setHookText(clip.id, e.target.value)}
                                  disabled={isRendering}
                                  className="h-7 flex-1 text-xs px-2 py-1"
                                />
                              </div>
                            )}
                          </div>
                        </SortableClip>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
