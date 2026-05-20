import { app } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import type { SpeechInterval, WordChunk } from '../../shared/types'

const wordChunkSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number()
})

const speechIntervalSchema = z.object({
  start: z.number(),
  end: z.number()
})

const transcriptCacheEntrySchema = z.object({
  words: z.array(wordChunkSchema),
  full: z.string(),
  srtPath: z.string().optional(),
  speechIntervals: z.array(speechIntervalSchema).optional()
})

export interface TranscriptCacheEntry {
  words: WordChunk[]
  full: string
  srtPath?: string
  speechIntervals?: SpeechInterval[]
}

function cacheKey(path: string, model?: string): string {
  return createHash('sha1').update(`${path}\0${model ?? ''}`).digest('hex')
}

function cacheDirectory(): string {
  return join(app.getPath('userData'), 'transcripts')
}

function cachePath(path: string, model?: string): string {
  return join(cacheDirectory(), `${cacheKey(path, model)}.json`)
}

export async function readTranscriptCache(path: string, model?: string): Promise<TranscriptCacheEntry | null> {
  try {
    const startedAt = Date.now()
    const raw = await readFile(cachePath(path, model), 'utf-8')
    const parsed = transcriptCacheEntrySchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    console.info('transcript_cache_read', { path, model, ok: true, elapsedMs: Date.now() - startedAt })
    return parsed.data
  } catch (error) {
    console.info('transcript_cache_read', {
      path,
      model,
      ok: false,
      elapsedMs: 0,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export async function writeTranscriptCache(
  path: string,
  model: string | undefined,
  entry: TranscriptCacheEntry
): Promise<void> {
  const startedAt = Date.now()
  await mkdir(cacheDirectory(), { recursive: true })
  await writeFile(cachePath(path, model), JSON.stringify(entry, null, 2), 'utf-8')
  console.info('transcript_cache_write', { path, model, ok: true, elapsedMs: Date.now() - startedAt })
}
