import { ipcMain, app } from 'electron'
import ffmpegModule from 'fluent-ffmpeg'
import { ffmpeg, getVideoMetadata, extractAudio, trimVideo, trimVideoReencode, detectLeadingSilence, trimLeadingSilence, getEncoder, getSoftwareEncoder, isGpuSessionError } from './ffmpeg'
import { join, normalize } from 'path'
import { writeFileSync, mkdirSync, unlinkSync, readFileSync, existsSync, statSync } from 'fs'
import { tmpdir, cpus } from 'os'
import { v4 as uuidv4 } from 'uuid'
import { clampToSafeZone, getElementPlacement, CANVAS_WIDTH, CANVAS_HEIGHT, type Platform } from './safe-zones'

function getFontsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'fonts')
  }
  return join(app.getAppPath(), 'resources', 'fonts')
}

const FFMPEG_UNSUPPORTED_PATH_CONTROL_CHARS = /[\r\n]/
const trackedTempFiles = new Set<string>()

export function trackTempFile(filePath: string): string {
  trackedTempFiles.add(filePath)
  return filePath
}

export function releaseTempFile(filePath: string): void {
  trackedTempFiles.delete(filePath)
  try { unlinkSync(filePath) } catch {}
}

export function clearTrackedTempFiles(): void {
  for (const filePath of trackedTempFiles) {
    try { unlinkSync(filePath) } catch {}
  }
  trackedTempFiles.clear()
}

export function getTrackedTempFileCount(): number {
  return trackedTempFiles.size
}

function assertNoFfmpegPathLineBreaks(pathValue: string, context: string): void {
  if (FFMPEG_UNSUPPORTED_PATH_CONTROL_CHARS.test(pathValue)) {
    throw new Error(`${context} cannot contain line breaks`)
  }
}

/**
 * Escape a file path for use inside an FFmpeg -filter_complex option value.
 * fluent-ffmpeg passes filter_complex as one argv entry, so shell escaping is not needed;
 * FFmpeg still parses the filter graph and then the filter option value. Escaping each
 * metacharacter twice leaves one escape for the option parser after graph parsing.
 */
export function escapeFilterPath(p: string): string {
  assertNoFfmpegPathLineBreaks(p, 'FFmpeg filter path')

  return p
    .replace(/\\/g, '/')
    .replace(/([\\':,;\[\]])/g, '\\\\$1')
}

function cssHexToAssBgr(hex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.substring(0, 2)
  const g = clean.substring(2, 4)
  const b = clean.substring(4, 6)
  return `&H00${b}${g}${r}`
}

/** Convert CSS hex (#AARRGGBB or #RRGGBB) to ASS BackColour format &HAABBGGRR */
function cssHexToAssBackColor(hex: string): string {
  const clean = hex.replace('#', '')
  if (clean.length === 8) {
    // #AARRGGBB -> &HAABBGGRR
    const a = clean.substring(0, 2)
    const r = clean.substring(2, 4)
    const g = clean.substring(4, 6)
    const b = clean.substring(6, 8)
    return `&H${a}${b}${g}${r}`
  }
  const r = clean.substring(0, 2)
  const g = clean.substring(2, 4)
  const b = clean.substring(4, 6)
  return `&H00${b}${g}${r}`
}

interface FullCaptionStyle {
  fontName: string
  fontFile: string
  fontSize: number
  primaryColor: string
  highlightColor: string
  outlineColor: string
  backColor: string
  outline: number
  shadow: number
  borderStyle: number
  wordsPerLine: number
  animation: 'karaoke-fill' | 'word-pop' | 'fade-in' | 'glow'
}

type CaptionAnimation = FullCaptionStyle['animation']

const DEFAULT_STYLE: FullCaptionStyle = {
  fontName: 'Inter', fontFile: 'Inter-Bold.ttf',
  fontSize: 0.05, primaryColor: '#FFFFFF', highlightColor: '#FFFF00',
  outlineColor: '#000000', backColor: '#80000000',
  outline: 3, shadow: 1, borderStyle: 1, wordsPerLine: 4, animation: 'karaoke-fill'
}

const MAX_WORDS_PER_LINE = 12
const MAX_ASS_TEXT_LENGTH = 200
const MAX_SEGMENT_DURATION_MS = 12 * 60 * 60 * 1000
const SAFE_FONT_NAME_PATTERN = /^[\p{L}\p{N} ._-]+$/u
const SAFE_FONT_FILE_PATTERN = /^[\p{L}\p{N} ._-]+\.(?:ttf|otf)$/iu
const CSS_HEX_COLOR_PATTERN = /^#(?:[\da-f]{6}|[\da-f]{8})$/i
const CAPTION_ANIMATIONS: ReadonlySet<CaptionAnimation> = new Set([
  'karaoke-fill',
  'word-pop',
  'fade-in',
  'glow'
])

function buildAssHeader(width: number, height: number, styleLines: string[]): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
}

export interface RenderJob {
  id: string
  hookPath: string
  meatPath: string
  ctaPath: string
  outputPath: string
  textOverlay?: string
  hookDurationSec?: number
  captionsAssPath?: string
  autoResize?: boolean
  resolution: { width: number; height: number }
  titlePosition?: { x: number; y: number }
  mediaOverlays?: { meat?: string; cta?: string }
  mediaOverlayPosition?: { x: number; y: number }
  meatDurationSec?: number
  targetPlatform?: string
  captionData?: {
    clipWordChunks: Record<string, Array<{ text: string; start: number; end: number }>>
    captionStyle?: FullCaptionStyle
    captionPosition?: { x: number; y: number }
    captionOffsetMs?: number
  }
}

export type RenderProgressStatus =
  | 'queued'
  | 'normalizing'
  | 'concatenating'
  | 'overlaying'
  | 'rendering'
  | 'done'
  | 'error'
  | 'canceled'

export interface RenderProgress {
  jobId: string
  percent: number
  status: RenderProgressStatus
  error?: string
}

type FfmpegCommand = ffmpegModule.FfmpegCommand

type RenderProgressPhase = 'concat' | 'overlay'

const PROGRESS_EVENT_THROTTLE_MS = 200

function clampProgressPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, percent))
}

function createProgressSender(
  sender: Electron.WebContents,
  results: RenderProgress[]
): (options?: { force?: boolean }) => void {
  let lastSentAt = 0
  return ({ force = false } = {}) => {
    const now = Date.now()
    if (!force && now - lastSentAt < PROGRESS_EVENT_THROTTLE_MS) return
    lastSentAt = now
    sender.send('render:progress', results.map((result) => ({ ...result })))
  }
}

function mapPhaseProgress(phase: RenderProgressPhase, percent: number): number {
  const safePercent = clampProgressPercent(percent)
  if (phase === 'concat') return Math.round(safePercent * 0.2)
  return Math.round(20 + safePercent * 0.8)
}

interface RenderCancellationState {
  isCanceled: boolean
  commands: Set<FfmpegCommand>
}

const activeRenderBatches = new Map<string, RenderCancellationState>()

class RenderCanceledError extends Error {
  constructor() {
    super('Render canceled')
    this.name = 'RenderCanceledError'
  }
}

function createCancellationState(batchId: string): RenderCancellationState {
  const state = { isCanceled: false, commands: new Set<FfmpegCommand>() }
  activeRenderBatches.set(batchId, state)
  return state
}

function registerFfmpegCommand(command: FfmpegCommand, cancellation: RenderCancellationState): FfmpegCommand {
  cancellation.commands.add(command)
  if (cancellation.isCanceled) {
    command.kill('SIGTERM')
  }
  return command
}

function unregisterFfmpegCommand(command: FfmpegCommand, cancellation: RenderCancellationState): void {
  cancellation.commands.delete(command)
}

function throwIfCanceled(cancellation: RenderCancellationState): void {
  if (cancellation.isCanceled) {
    throw new RenderCanceledError()
  }
}

function toRenderError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

export function cancelActiveRenderBatch(batchId?: string): boolean {
  const batches = batchId
    ? [...activeRenderBatches.entries()].filter(([id]) => id === batchId)
    : [...activeRenderBatches.entries()]

  let canceled = false
  for (const [, state] of batches) {
    state.isCanceled = true
    canceled = true
    for (const command of state.commands) {
      try { command.kill('SIGTERM') } catch {}
    }
  }
  clearTrackedTempFiles()
  return canceled
}

/** Check if a job needs overlays/captions/text (the "slow path") */
function jobNeedsOverlays(job: RenderJob): boolean {
  const hasText = !!(job.textOverlay && job.hookDurationSec)
  const hasCaptions = !!job.captionsAssPath || !!job.captionData
  const hasMedia = !!(job.mediaOverlays && (job.mediaOverlays.meat || job.mediaOverlays.cta))
  return hasText || hasCaptions || hasMedia
}

/** Escape a path for use in ffconcat list files (single-quote wrapping, escape inner quotes) */
export function escapeConcatPath(p: string): string {
  assertNoFfmpegPathLineBreaks(p, 'FFmpeg concat path')

  return p.replace(/\\/g, '/').replace(/'/g, "'\\''")
}

/**
 * Disk cache for pre-normalized clips.
 * Maps a cache key (sourcePath:mtime:WxH:autoResize) to the normalized file path.
 * Persists across batch renders within a single app session; cleaned up on app quit.
 */
const normalizedClipCache = new Map<string, string>()

function getNormCacheKey(
  sourcePath: string,
  width: number,
  height: number,
  autoResize: boolean
): string {
  const mtime = statSync(sourcePath).mtimeMs
  return `${sourcePath}:${mtime}:${width}x${height}:${autoResize}`
}

/**
 * Delete all cached normalized files from disk and clear the in-memory map.
 */
export function clearNormalizedCache(): void {
  for (const cachedPath of normalizedClipCache.values()) {
    try { unlinkSync(cachedPath) } catch {}
  }
  normalizedClipCache.clear()
  console.log('[Normalize] Cache cleared')
}

/**
 * Pre-normalize a single clip to match target resolution, fps=30, h264+aac.
 * Returns the original path if it already matches, otherwise encodes to a temp file.
 * Results are cached on disk so re-renders skip encoding for unchanged clips.
 */
async function preNormalizeClip(
  clipPath: string,
  resolution: { width: number; height: number },
  autoResize: boolean,
  cancellation: RenderCancellationState
): Promise<string> {
  throwIfCanceled(cancellation)
  const { width, height } = resolution

  // Check disk cache first
  const cacheKey = getNormCacheKey(clipPath, width, height, autoResize)
  const cached = normalizedClipCache.get(cacheKey)
  if (cached && existsSync(cached)) {
    console.log(`[Normalize] Cache hit: ${clipPath}`)
    return cached
  }

  const meta = await getVideoMetadata(clipPath)

  // Check if clip already matches target specs
  const resMatch = meta.width === width && meta.height === height
  const fpsMatch = Math.abs(meta.fps - 30) < 0.5
  const codecMatch = meta.codec === 'h264' && meta.audioCodec === 'aac'

  if (resMatch && fpsMatch && codecMatch) {
    console.log(`[Normalize] Skip (already matches): ${clipPath}`)
    return clipPath
  }

  const outPath = join(tmpdir(), `batchedit-norm-${uuidv4()}.mp4`)

  const scaleFilter = autoResize
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setpts=PTS-STARTPTS`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,setpts=PTS-STARTPTS`

  function encodeWithConfig(encoderConfig: { encoder: string; presetFlag: string[] }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const command = registerFfmpegCommand(ffmpeg(normalize(clipPath)), cancellation)
      command
        .videoFilters(scaleFilter)
        .outputOptions([
          '-y',
          '-c:v', encoderConfig.encoder, ...encoderConfig.presetFlag,
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart'
        ])
        .on('start', (cmd) => console.log(`[Normalize] ${cmd}`))
        .on('end', () => {
          unregisterFfmpegCommand(command, cancellation)
          normalizedClipCache.set(cacheKey, outPath)
          resolve(outPath)
        })
        .on('error', (err, _stdout, stderr) => {
          unregisterFfmpegCommand(command, cancellation)
          try { unlinkSync(outPath) } catch {}
          if (cancellation.isCanceled) {
            reject(new RenderCanceledError())
            return
          }
          if (stderr) console.error(`[Normalize] stderr:\n${stderr}`)
          reject(new Error(stderr ? `${err.message}\nFFmpeg output:\n${stderr}` : err.message))
        })
        .save(outPath)
    })
  }

  try {
    return await encodeWithConfig(getEncoder())
  } catch (err: any) {
    if (isGpuSessionError(err.message)) {
      console.log(`[Normalize] GPU session exhausted, retrying with libx264: ${clipPath}`)
      return encodeWithConfig(getSoftwareEncoder())
    }
    throw err
  }
}

/**
 * Pre-normalize all unique clips in parallel.
 * Returns a Map from original path to normalized path.
 */
async function preNormalizeAllClips(
  clipPaths: string[],
  resolution: { width: number; height: number },
  autoResize: boolean,
  onProgress: (completed: number, total: number) => void,
  cancellation: RenderCancellationState
): Promise<Map<string, string>> {
  const uniquePaths = [...new Set(clipPaths)]
  const result = new Map<string, string>()
  let completed = 0
  const queue = [...uniquePaths]

  async function processNext(): Promise<void> {
    throwIfCanceled(cancellation)
    const clipPath = queue.shift()
    if (!clipPath) return

    const normalized = await preNormalizeClip(clipPath, resolution, autoResize, cancellation)
    result.set(clipPath, normalized)
    completed++
    onProgress(completed, uniquePaths.length)

    await processNext()
  }

  const workers = Array.from(
    { length: Math.min(getSlowConcurrency(), uniquePaths.length) },
    () => processNext()
  )
  await Promise.all(workers)

  return result
}

/**
 * Fast path: concat pre-normalized clips via concat demuxer (stream copy, no encoding).
 */
function concatStreamCopy(
  clipPaths: string[],
  outputPath: string,
  onProgress: (percent: number) => void,
  cancellation: RenderCancellationState
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Write concat list file
    const listContent = clipPaths
      .map((p) => `file '${escapeConcatPath(p)}'`)
      .join('\n')
    const listPath = trackTempFile(join(tmpdir(), `batchedit-concat-${uuidv4()}.txt`))
    writeFileSync(listPath, listContent, 'utf-8')

    const command = registerFfmpegCommand(ffmpeg(), cancellation)
    command
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-y',
        '-c', 'copy',
        '-movflags', '+faststart'
      ])
      .on('start', (cmd) => console.log(`[FFmpeg concat-copy] ${cmd}`))
      .on('progress', (progress) => onProgress(progress.percent || 0))
      .on('end', () => {
        unregisterFfmpegCommand(command, cancellation)
        releaseTempFile(listPath)
        resolve()
      })
      .on('error', (err, _stdout, stderr) => {
        unregisterFfmpegCommand(command, cancellation)
        releaseTempFile(listPath)
        try { unlinkSync(outputPath) } catch {}
        if (cancellation.isCanceled) {
          reject(new RenderCanceledError())
          return
        }
        if (stderr) console.error(`[FFmpeg concat-copy] stderr:\n${stderr}`)
        reject(new Error(stderr ? `${err.message}\nFFmpeg output:\n${stderr}` : err.message))
      })
      .save(normalize(outputPath))
  })
}

/**
 * Slow path: concat pre-normalized clips via stream copy, then apply overlays/captions
 * in a single encoding pass.
 */
function concatWithOverlays(
  job: RenderJob,
  normalizedPaths: string[],
  onProgress: (phase: RenderProgressPhase, percent: number) => void,
  cancellation: RenderCancellationState
): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputPath = normalize(job.outputPath)

    // Step 1: concat via stream copy into a temp file
    const tempConcat = trackTempFile(join(tmpdir(), `batchedit-tempconcat-${uuidv4()}.mp4`))
    const listContent = normalizedPaths
      .map((p) => `file '${escapeConcatPath(p)}'`)
      .join('\n')
    const listPath = trackTempFile(join(tmpdir(), `batchedit-concat-${uuidv4()}.txt`))
    writeFileSync(listPath, listContent, 'utf-8')

    const concatCmd = registerFfmpegCommand(
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-y', '-c', 'copy', '-movflags', '+faststart']),
      cancellation
    )

    concatCmd
      .on('start', (cmd) => console.log(`[FFmpeg concat-step] ${cmd}`))
      .on('progress', (progress) => onProgress('concat', progress.percent || 0))
      .on('end', () => {
        unregisterFfmpegCommand(concatCmd, cancellation)
        releaseTempFile(listPath)
        // Step 2: apply overlays/captions on the concatenated file
        applyOverlays(job, tempConcat, outputPath, onProgress, cancellation)
          .then(() => {
            releaseTempFile(tempConcat)
            resolve()
          })
          .catch((err) => {
            releaseTempFile(tempConcat)
            reject(err)
          })
      })
      .on('error', (err, _stdout, stderr) => {
        unregisterFfmpegCommand(concatCmd, cancellation)
        releaseTempFile(listPath)
        releaseTempFile(tempConcat)
        try { unlinkSync(outputPath) } catch {}
        if (cancellation.isCanceled) {
          reject(new RenderCanceledError())
          return
        }
        if (stderr) console.error(`[FFmpeg concat-step] stderr:\n${stderr}`)
        reject(new Error(stderr ? `${err.message}\nFFmpeg output:\n${stderr}` : err.message))
      })
      .save(tempConcat)
  })
}

/**
 * Build the filter graph and extra input list for overlay/caption rendering.
 * Extracted so we can reuse it on GPU→CPU retry without regenerating ASS files.
 */
function buildOverlayFilterGraph(
  job: RenderJob,
  tempAssFiles: string[]
): { filters: string[]; extraInputPaths: string[]; finalVideoLabel: string } {
  const { width, height } = job.resolution
  const filters: string[] = []
  let currentLabel = '[0:v]'
  let nextInputIdx = 1
  const extraInputPaths: string[] = []

  // Text overlay on hook segment
  if (job.textOverlay && job.hookDurationSec) {
    const assContent = generateTextOverlayAssFile(
      job.textOverlay,
      job.hookDurationSec,
      job.resolution,
      job.titlePosition
    )
    const assPath = trackTempFile(join(tmpdir(), `batchedit-textoverlay-${uuidv4()}.ass`))
    writeFileSync(assPath, assContent, 'utf-8')
    tempAssFiles.push(assPath)

    const escaped = escapeFilterPath(assPath)
    filters.push(`${currentLabel}ass=filename=${escaped}[vtxt]`)
    currentLabel = '[vtxt]'
  }

  // Media overlay images
  if (job.mediaOverlays && (job.mediaOverlays.meat || job.mediaOverlays.cta)) {
    const overlayW = Math.round(width * 0.8 / 2) * 2
    const pos = job.mediaOverlayPosition || { x: 50, y: 75 }
    const posX = Math.round(width * pos.x / 100)
    const posY = Math.round(height * pos.y / 100)
    const hookDur = job.hookDurationSec || 0
    const meatDur = job.meatDurationSec || 0

    if (job.mediaOverlays.meat) {
      const idx = nextInputIdx++
      extraInputPaths.push(normalize(job.mediaOverlays.meat))
      const outLabel = `[vovl${idx}]`
      filters.push(`[${idx}:v]scale=${overlayW}:-2[ovl_${idx}]`)
      filters.push(`${currentLabel}[ovl_${idx}]overlay=x=${posX}-overlay_w/2:y=${posY}-overlay_h/2:enable='between(t,${hookDur},${hookDur + meatDur})':eof_action=repeat${outLabel}`)
      currentLabel = outLabel
    }

    if (job.mediaOverlays.cta) {
      const idx = nextInputIdx++
      extraInputPaths.push(normalize(job.mediaOverlays.cta))
      const outLabel = `[vovl${idx}]`
      filters.push(`[${idx}:v]scale=${overlayW}:-2[ovl_${idx}]`)
      filters.push(`${currentLabel}[ovl_${idx}]overlay=x=${posX}-overlay_w/2:y=${posY}-overlay_h/2:enable='gte(t,${hookDur + meatDur})':eof_action=repeat${outLabel}`)
      currentLabel = outLabel
    }
  }

  // ASS captions
  if (job.captionsAssPath) {
    const escaped = escapeFilterPath(job.captionsAssPath)
    const fontsDir = escapeFilterPath(getFontsDir())
    filters.push(`${currentLabel}ass=filename=${escaped}:fontsdir=${fontsDir}[vfinal]`)
    currentLabel = '[vfinal]'
  }

  return { filters, extraInputPaths, finalVideoLabel: currentLabel }
}

/**
 * Run the overlay encoding pass with a specific encoder config.
 */
function runOverlayEncode(
  inputPath: string,
  outputPath: string,
  filters: string[],
  extraInputPaths: string[],
  finalVideoLabel: string,
  encoderConfig: { encoder: string; presetFlag: string[] },
  onProgress: (percent: number) => void,
  cancellation: RenderCancellationState
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = registerFfmpegCommand(ffmpeg().input(inputPath), cancellation)
    for (const imgPath of extraInputPaths) {
      command.input(imgPath)
    }
    command
      .complexFilter(filters.join(';'))
      .outputOptions([
        '-y',
        '-map', finalVideoLabel,
        '-map', '0:a',
        '-c:v', encoderConfig.encoder, ...encoderConfig.presetFlag,
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart'
      ])
      .on('start', (cmd) => console.log(`[FFmpeg overlay] ${cmd}`))
      .on('progress', (progress) => onProgress(progress.percent || 0))
      .on('end', () => {
        unregisterFfmpegCommand(command, cancellation)
        resolve()
      })
      .on('error', (err, _stdout, stderr) => {
        unregisterFfmpegCommand(command, cancellation)
        try { unlinkSync(outputPath) } catch {}
        if (cancellation.isCanceled) {
          reject(new RenderCanceledError())
          return
        }
        if (stderr) console.error(`[FFmpeg overlay] stderr:\n${stderr}`)
        reject(new Error(stderr ? `${err.message}\nFFmpeg output:\n${stderr}` : err.message))
      })
      .save(outputPath)
  })
}

/**
 * Apply overlays, text, and captions to a single concatenated input file.
 * Automatically retries with libx264 if GPU encoder session limit is hit.
 */
async function applyOverlays(
  job: RenderJob,
  inputPath: string,
  outputPath: string,
  onProgress: (phase: RenderProgressPhase, percent: number) => void,
  cancellation: RenderCancellationState
): Promise<void> {
  const tempAssFiles: string[] = []
  const { filters, extraInputPaths, finalVideoLabel } = buildOverlayFilterGraph(job, tempAssFiles)

  const cleanup = (): void => {
    tempAssFiles.forEach(releaseTempFile)
  }

  try {
    await runOverlayEncode(inputPath, outputPath, filters, extraInputPaths, finalVideoLabel, getEncoder(), (percent) => onProgress('overlay', percent), cancellation)
    cleanup()
  } catch (err: any) {
    // If GPU encoder ran out of sessions, retry with software encoder
    if (isGpuSessionError(err.message)) {
      console.log(`[FFmpeg overlay] GPU session exhausted, retrying with libx264`)
      try {
        await runOverlayEncode(inputPath, outputPath, filters, extraInputPaths, finalVideoLabel, getSoftwareEncoder(), (percent) => onProgress('overlay', percent), cancellation)
        cleanup()
      } catch (retryErr: any) {
        cleanup()
        throw retryErr
      }
    } else {
      cleanup()
      throw err
    }
  }
}

// Adaptive concurrency based on encoding method
const CPU_COUNT = cpus().length

/** Fast-path jobs (stream copy) are I/O bound — run up to full CPU count */
const FAST_CONCURRENCY = Math.max(1, CPU_COUNT)

/**
 * Slow-path concurrency depends on the active encoder.
 * GPU encoders have a hard session limit (consumer NVIDIA GPUs: ~3-5 NVENC
 * sessions), so we cap concurrency to avoid "No capable devices found" errors.
 * CPU encoding (libx264) scales with core count.
 */
function getSlowConcurrency(): number {
  const { encoder } = getEncoder()
  if (encoder === 'h264_nvenc') {
    // Consumer GeForce GPUs allow ~3-5 concurrent NVENC sessions.
    // Cap at 3 to be safe across all SKUs.
    return 3
  }
  if (encoder === 'h264_qsv' || encoder === 'h264_vaapi') {
    return Math.min(4, Math.max(2, Math.floor(CPU_COUNT * 0.5)))
  }
  // libx264 — conservative
  return Math.max(1, Math.floor(CPU_COUNT / 2))
}

export function setupRenderPipeline(): void {
  // Get video metadata
  ipcMain.handle(
    'ffmpeg:getMetadata',
    async (_event, filePath: string) => {
      return getVideoMetadata(filePath)
    }
  )

  // Extract audio for whisper
  ipcMain.handle(
    'ffmpeg:extractAudio',
    async (_event, videoPath: string) => {
      const tmpPath = trackTempFile(join(tmpdir(), `batchedit-audio-${uuidv4()}.wav`))
      try {
        return await extractAudio(videoPath, tmpPath)
      } catch (err) {
        releaseTempFile(tmpPath)
        throw err
      }
    }
  )

  // Generate ASS subtitle file from caption data
  ipcMain.handle(
    'ffmpeg:generateAss',
    async (
      _event,
      captions: { text: string; start: number; end: number }[],
      resolution: { width: number; height: number }
    ) => {
      const assContent = generateAssFile(captions, resolution)
      const tmpPath = trackTempFile(join(tmpdir(), `batchedit-subs-${uuidv4()}.ass`))
      writeFileSync(tmpPath, assContent, 'utf-8')
      return tmpPath
    }
  )

  // Generate combined ASS with karaoke word highlighting for multi-segment videos
  ipcMain.handle(
    'ffmpeg:generateCombinedAss',
    async (
      _event,
      data: {
        segments: {
          wordChunks: { text: string; start: number; end: number }[]
          offsetMs: number
          durationMs?: number
        }[]
        resolution: { width: number; height: number }
        captionStyle?: FullCaptionStyle
        captionPosition?: { x: number; y: number }
      }
    ) => {
      const assContent = generateCombinedAssFile(data.segments, data.resolution, data.captionStyle, data.captionPosition)
      const tmpPath = trackTempFile(join(tmpdir(), `batchedit-karaoke-${uuidv4()}.ass`))
      writeFileSync(tmpPath, assContent, 'utf-8')
      return tmpPath
    }
  )

  // Read WAV file and return PCM Float32Array for Whisper
  ipcMain.handle('ffmpeg:readAudioBuffer', async (_event, wavPath: string) => {
    try {
      const buffer = readFileSync(wavPath)
      return parseWavToFloat32(buffer).buffer
    } finally {
      releaseTempFile(wavPath)
    }
  })

  ipcMain.handle('ffmpeg:releaseTempFile', async (_event, filePath: string) => {
    releaseTempFile(filePath)
  })

  // Split video into segments
  ipcMain.handle(
    'ffmpeg:splitVideo',
    async (
      _event,
      videoPath: string,
      segments: Array<{ label: string; bucket: string; startTime: number; endTime: number }>,
      outputDir: string | null
    ) => {
      const dir = outputDir || join(tmpdir(), `batchedit-split-${uuidv4()}`)
      mkdirSync(dir, { recursive: true })

      const results: Array<{ label: string; bucket: string; outputPath: string }> = []
      const nameCount = new Map<string, number>()
      for (const seg of segments) {
        const safeName = seg.label.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_')
        const count = (nameCount.get(safeName) || 0) + 1
        nameCount.set(safeName, count)
        const fileName = count > 1 ? `${safeName}_${count}` : safeName
        const outputPath = join(dir, `${fileName}.mp4`)
        await trimVideo(videoPath, outputPath, seg.startTime, seg.endTime)
        results.push({ label: seg.label, bucket: seg.bucket, outputPath })
      }
      return results
    }
  )

  // Detect leading silence duration
  ipcMain.handle(
    'ffmpeg:detectLeadingSilence',
    async (_event, videoPath: string) => {
      return detectLeadingSilence(videoPath)
    }
  )

  // Trim leading silence from a clip
  ipcMain.handle(
    'ffmpeg:trimLeadingSilence',
    async (_event, videoPath: string, outputDir?: string) => {
      const dir = outputDir || tmpdir()
      const outPath = join(dir, `batchedit-trimmed-${uuidv4()}.mp4`)
      return trimLeadingSilence(videoPath, outPath)
    }
  )

  // Frame-accurate re-encoding trim
  ipcMain.handle(
    'ffmpeg:trimVideoReencode',
    async (
      _event,
      videoPath: string,
      outputDir: string | null,
      startTime: number,
      endTime: number
    ) => {
      const dir = outputDir || tmpdir()
      mkdirSync(dir, { recursive: true })
      const outPath = join(dir, `batchedit-retrim-${uuidv4()}.mp4`)
      return trimVideoReencode(videoPath, outPath, startTime, endTime)
    }
  )

  // Thumbnail generation
  ipcMain.handle('ffmpeg:thumbnail', async (_event, videoPath: string) => {
    const tmpPath = join(tmpdir(), `batchedit-thumb-${uuidv4()}.jpg`)
    return new Promise<string>((resolve, reject) => {
      ffmpeg(videoPath)
        .on('end', () => {
          try {
            const data = readFileSync(tmpPath)
            const base64 = data.toString('base64')
            unlinkSync(tmpPath)
            resolve(`data:image/jpeg;base64,${base64}`)
          } catch (err) {
            reject(err)
          }
        })
        .on('error', reject)
        .screenshots({
          count: 1,
          timestamps: ['00:00:00.500'],
          filename: tmpPath.split(/[/\\]/).pop()!,
          folder: tmpdir(),
          size: '160x?'
        })
    })
  })

  ipcMain.handle('render:cancel', async (_event, batchId?: string) => {
    return cancelActiveRenderBatch(batchId)
  })

  // Batch render
  ipcMain.handle(
    'render:batch',
    async (event, jobs: RenderJob[]) => {
      const batchId = jobs[0]?.id ?? uuidv4()
      const cancellation = createCancellationState(batchId)
      const results: RenderProgress[] = jobs.map((j) => ({
        jobId: j.id,
        percent: 0,
        status: 'queued' as const
      }))
      const sendProgress = createProgressSender(event.sender, results)

      // Create output directory
      if (jobs.length > 0) {
        const outDir = join(jobs[0].outputPath, '..')
        mkdirSync(outDir, { recursive: true })
      }

      // --- Phase 1: Pre-normalize all unique clips ---
      // Mark all jobs as normalizing
      for (const r of results) r.status = 'normalizing'
      sendProgress({ force: true })

      // Collect all unique clip paths and determine autoResize from first job
      const allClipPaths: string[] = []
      for (const job of jobs) {
        allClipPaths.push(job.hookPath, job.meatPath, job.ctaPath)
      }
      const resolution = jobs[0].resolution
      const autoResize = jobs[0].autoResize || false

      let normalizedMap: Map<string, string>
      try {
        normalizedMap = await preNormalizeAllClips(
          allClipPaths,
          resolution,
          autoResize,
          (completed, total) => {
            const pct = Math.round((completed / total) * 100)
            for (const r of results) {
              if (r.status === 'normalizing') r.percent = pct
            }
            sendProgress()
          },
          cancellation
        )
      } catch (err: unknown) {
        const error = toRenderError(err)
        for (const r of results) {
          if (error instanceof RenderCanceledError || cancellation.isCanceled) {
            r.status = 'canceled'
            r.error = 'Render canceled'
          } else {
            r.status = 'error'
            r.error = `Normalization failed: ${error.message}`
          }
        }
        sendProgress({ force: true })
        activeRenderBatches.delete(batchId)
        clearTrackedTempFiles()
        return results
      }

      // --- Phase 1.5: Probe normalized durations, fix overlay timing, generate ASS ---
      const probedDurations = new Map<string, number>()
      try {
        throwIfCanceled(cancellation)
        for (const [originalPath, normalizedPath] of normalizedMap.entries()) {
          try {
            const meta = await getVideoMetadata(normalizedPath)
            probedDurations.set(originalPath, meta.duration)
          } catch {
            // Fall back — leave duration unset, job will use original values
          }
        }

        for (const job of jobs) {
          throwIfCanceled(cancellation)
          // Fix overlay timing with probed durations
        const probedHookDur = probedDurations.get(job.hookPath)
        const probedMeatDur = probedDurations.get(job.meatPath)
        if (probedHookDur !== undefined && job.hookDurationSec !== undefined) {
          job.hookDurationSec = probedHookDur
        }
        if (probedMeatDur !== undefined && job.meatDurationSec !== undefined) {
          job.meatDurationSec = probedMeatDur
        }

        // Generate ASS for jobs with captionData
          if (job.captionData) {
            const cd = job.captionData
            const hookDurMs = (probedHookDur ?? job.hookDurationSec ?? 0) * 1000
            const meatDurMs = (probedMeatDur ?? job.meatDurationSec ?? 0) * 1000
            const ctaDurMs = (probedDurations.get(job.ctaPath) ?? 0) * 1000
            const offsetMs = cd.captionOffsetMs ?? 0

            const segments = [
              { wordChunks: cd.clipWordChunks[job.hookPath] || [], offsetMs: 0 + offsetMs, durationMs: hookDurMs },
              { wordChunks: cd.clipWordChunks[job.meatPath] || [], offsetMs: hookDurMs + offsetMs, durationMs: meatDurMs },
              { wordChunks: cd.clipWordChunks[job.ctaPath] || [], offsetMs: hookDurMs + meatDurMs + offsetMs, durationMs: ctaDurMs }
            ]

            const assContent = generateCombinedAssFile(segments, job.resolution, cd.captionStyle, cd.captionPosition)
            const assPath = trackTempFile(join(tmpdir(), `batchedit-karaoke-${uuidv4()}.ass`))
            writeFileSync(assPath, assContent, 'utf-8')
            job.captionsAssPath = assPath
          }
        }
      } catch (err: unknown) {
        const error = toRenderError(err)
        if (!(error instanceof RenderCanceledError) && !cancellation.isCanceled) {
          throw error
        }
        for (const r of results) {
          r.status = 'canceled'
          r.error = 'Render canceled'
        }
        sendProgress({ force: true })
        activeRenderBatches.delete(batchId)
        clearTrackedTempFiles()
        return results
      }

      // Reset progress for rendering phase
      for (const r of results) {
        r.status = 'queued'
        r.percent = 0
      }
      sendProgress({ force: true })

      // --- Phase 2: Render each combination ---
      // Split into fast (stream copy, I/O bound) and slow (encoding) queues
      const fastQueue = jobs.filter((j) => !jobNeedsOverlays(j))
      const slowQueue = jobs.filter((j) => jobNeedsOverlays(j))

      async function renderJob(job: RenderJob): Promise<void> {
        const idx = jobs.findIndex((j) => j.id === job.id)
        results[idx].status = 'rendering'
        sendProgress({ force: true })

        try {
          const normHook = normalizedMap.get(job.hookPath) || job.hookPath
          const normMeat = normalizedMap.get(job.meatPath) || job.meatPath
          const normCta = normalizedMap.get(job.ctaPath) || job.ctaPath
          const normalizedPaths = [normHook, normMeat, normCta]

          throwIfCanceled(cancellation)
          if (jobNeedsOverlays(job)) {
            await concatWithOverlays(job, normalizedPaths, (phase, percent) => {
              results[idx].status = phase === 'concat' ? 'concatenating' : 'overlaying'
              results[idx].percent = mapPhaseProgress(phase, percent)
              sendProgress()
            }, cancellation)
          } else {
            await concatStreamCopy(normalizedPaths, job.outputPath, (percent) => {
              results[idx].status = 'concatenating'
              results[idx].percent = clampProgressPercent(percent)
              sendProgress()
            }, cancellation)
          }

          results[idx].status = 'done'
          results[idx].percent = 100
        } catch (err: unknown) {
          const error = toRenderError(err)
          if (error instanceof RenderCanceledError || cancellation.isCanceled) {
            results[idx].status = 'canceled'
            results[idx].error = 'Render canceled'
            try { unlinkSync(job.outputPath) } catch {}
          } else {
            results[idx].status = 'error'
            results[idx].error = error.message
          }
        }

        sendProgress({ force: true })
      }

      try {
        // Process fast jobs first (I/O bound — higher concurrency)
        if (fastQueue.length > 0) {
          const fastJobQueue = [...fastQueue]
          async function processFast(): Promise<void> {
            throwIfCanceled(cancellation)
            const job = fastJobQueue.shift()
            if (!job) return
            await renderJob(job)
            if (!cancellation.isCanceled) await processFast()
          }
          const fastWorkers = Array.from(
            { length: Math.min(FAST_CONCURRENCY, fastQueue.length) },
            () => processFast()
          )
          await Promise.all(fastWorkers)
        }

        // Then process slow jobs (encoding — adaptive concurrency)
        if (slowQueue.length > 0) {
          const slowJobQueue = [...slowQueue]
          async function processSlow(): Promise<void> {
            throwIfCanceled(cancellation)
            const job = slowJobQueue.shift()
            if (!job) return
            await renderJob(job)
            if (!cancellation.isCanceled) await processSlow()
          }
          const slowWorkers = Array.from(
            { length: Math.min(getSlowConcurrency(), slowQueue.length) },
            () => processSlow()
          )
          await Promise.all(slowWorkers)
        }
      } catch (err: unknown) {
        const error = toRenderError(err)
        if (error instanceof RenderCanceledError || cancellation.isCanceled) {
          for (const r of results) {
            if (r.status !== 'done' && r.status !== 'error') {
              r.status = 'canceled'
              r.error = 'Render canceled'
            }
          }
          for (const job of jobs) {
            if (results.find((r) => r.jobId === job.id)?.status === 'canceled') {
              try { unlinkSync(job.outputPath) } catch {}
            }
          }
          sendProgress({ force: true })
        } else {
          throw error
        }
      } finally {
        for (const job of jobs) {
          if (job.captionsAssPath) {
            releaseTempFile(job.captionsAssPath)
          }
        }
        activeRenderBatches.delete(batchId)
        if (cancellation.isCanceled) {
          clearTrackedTempFiles()
        }
      }

      return results
    }
  )
}

export function generateAssFile(
  captions: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * 0.04)
  const isVertical916 = width * 16 <= height * 9
  const marginV = isVertical916 ? Math.round(height * 0.08) : Math.round(height * 0.03)

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,8,10,10,${marginV},1
Style: Highlight,Arial,${fontSize},&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,8,10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const dialogueLines = captions.flatMap((cap) => {
    if (!Number.isFinite(cap.start) || !Number.isFinite(cap.end) || cap.end <= cap.start) return []
    const text = sanitizeAssText(cap.text).trim()
    if (!text) return []
    const start = formatAssTimestamp(cap.start)
    const end = formatAssTimestamp(cap.end)
    return [`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`]
  })

  return header + '\n' + dialogueLines.join('\n') + '\n'
}

export function formatAssTimestamp(ms: number): string {
  const safeMs = clampFiniteNumber(ms, 0, 0, Number.MAX_SAFE_INTEGER)
  const h = Math.floor(safeMs / 3600000)
  const m = Math.floor((safeMs % 3600000) / 60000)
  const s = Math.floor((safeMs % 60000) / 1000)
  const cs = Math.floor((safeMs % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export function generateWordHighlightAssFile(
  wordChunks: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number },
  style?: FullCaptionStyle,
  position?: { x: number; y: number }
): string {
  const s = sanitizeCaptionStyle(style)
  const cleanWordChunks = sanitizeWordChunks(wordChunks)
  switch (s.animation) {
    case 'word-pop':
      return generateWordPopAss(cleanWordChunks, resolution, s, position)
    case 'fade-in':
      return generateFadeInAss(cleanWordChunks, resolution, s, position)
    case 'glow':
      return generateGlowAss(cleanWordChunks, resolution, s, position)
    case 'karaoke-fill':
    default:
      return generateKaraokeFillAss(cleanWordChunks, resolution, s, position)
  }
}

function computeMarginV(
  height: number, width: number,
  position?: { x: number; y: number }
): number {
  if (position) return Math.max(0, Math.round(height * (1 - position.y / 100)))
  const isVertical916 = width * 16 <= height * 9
  return isVertical916 ? Math.round(height * 0.35) : Math.round(height * 0.05)
}

type WordChunk = { text: string; start: number; end: number }
type CaptionSegment = { wordChunks: WordChunk[]; offsetMs: number; durationMs?: number }
type LineFormatter = (lineWords: WordChunk[], styleName: string) => string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clampFiniteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function sanitizeWordsPerLine(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_STYLE.wordsPerLine
  }
  if (value < 1) {
    return MAX_WORDS_PER_LINE
  }
  return Math.round(Math.min(MAX_WORDS_PER_LINE, value))
}

function sanitizeCssHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return CSS_HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toUpperCase() : fallback
}

function sanitizeAssStyleText(value: unknown, fallback: string, pattern: RegExp): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().slice(0, 80)
  if (!trimmed || !pattern.test(trimmed)) return fallback
  return trimmed.replace(/,/g, '')
}

function sanitizeCaptionAnimation(value: unknown): CaptionAnimation {
  return typeof value === 'string' && CAPTION_ANIMATIONS.has(value as CaptionAnimation)
    ? value as CaptionAnimation
    : DEFAULT_STYLE.animation
}

function sanitizeCaptionStyle(style?: FullCaptionStyle): FullCaptionStyle {
  if (!isRecord(style)) return DEFAULT_STYLE

  return {
    fontName: sanitizeAssStyleText(style.fontName, DEFAULT_STYLE.fontName, SAFE_FONT_NAME_PATTERN),
    fontFile: sanitizeAssStyleText(style.fontFile, DEFAULT_STYLE.fontFile, SAFE_FONT_FILE_PATTERN),
    fontSize: clampFiniteNumber(style.fontSize, DEFAULT_STYLE.fontSize, 0.01, 0.2),
    primaryColor: sanitizeCssHexColor(style.primaryColor, DEFAULT_STYLE.primaryColor),
    highlightColor: sanitizeCssHexColor(style.highlightColor, DEFAULT_STYLE.highlightColor),
    outlineColor: sanitizeCssHexColor(style.outlineColor, DEFAULT_STYLE.outlineColor),
    backColor: sanitizeCssHexColor(style.backColor, DEFAULT_STYLE.backColor),
    outline: clampFiniteNumber(style.outline, DEFAULT_STYLE.outline, 0, 20),
    shadow: clampFiniteNumber(style.shadow, DEFAULT_STYLE.shadow, 0, 20),
    borderStyle: Math.round(clampFiniteNumber(style.borderStyle, DEFAULT_STYLE.borderStyle, 1, 4)),
    wordsPerLine: sanitizeWordsPerLine(style.wordsPerLine),
    animation: sanitizeCaptionAnimation(style.animation)
  }
}

function sanitizeAssText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/[{}]/g, '')
    .replace(/\r\n|\r|\n/g, '\\N')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ASS subtitle sanitization intentionally strips ASCII control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, MAX_ASS_TEXT_LENGTH)
}

function sanitizeWordChunks(chunks: ReadonlyArray<WordChunk>): WordChunk[] {
  const sanitized: WordChunk[] = []
  for (const chunk of chunks) {
    if (!isRecord(chunk)) continue
    const text = sanitizeAssText(chunk.text).trim()
    if (!text) continue
    if (typeof chunk.start !== 'number' || typeof chunk.end !== 'number') continue
    if (!Number.isFinite(chunk.start) || !Number.isFinite(chunk.end)) continue
    if (chunk.start < 0 || chunk.end <= chunk.start) continue
    sanitized.push({ text, start: chunk.start, end: chunk.end })
  }
  return sanitized.sort((a, b) => a.start - b.start || a.end - b.end)
}

function sanitizeCaptionSegments(segments: ReadonlyArray<CaptionSegment>): CaptionSegment[] {
  const sanitized: CaptionSegment[] = []
  for (const segment of segments) {
    if (!isRecord(segment)) continue
    if (!Array.isArray(segment.wordChunks)) continue
    if (typeof segment.offsetMs !== 'number' || !Number.isFinite(segment.offsetMs)) continue
    const offsetMs = Math.max(0, segment.offsetMs)
    const durationMs = clampFiniteNumber(segment.durationMs, Number.NaN, 0, MAX_SEGMENT_DURATION_MS)
    const cleanSegment: CaptionSegment = {
      wordChunks: sanitizeWordChunks(segment.wordChunks),
      offsetMs
    }
    if (Number.isFinite(durationMs) && durationMs > 0) {
      cleanSegment.durationMs = durationMs
    }
    sanitized.push(cleanSegment)
  }
  return sanitized
}

function buildAnimationStyleLine(
  style: FullCaptionStyle,
  fontSize: number,
  marginV: number
): { styleLine: string; styleName: string } {
  const highlightBgr = cssHexToAssBgr(style.highlightColor)
  const primaryBgr = cssHexToAssBgr(style.primaryColor)
  const outlineBgr = cssHexToAssBgr(style.outlineColor)
  const backColor = cssHexToAssBackColor(style.backColor)

  if (style.animation === 'fade-in') {
    return {
      styleName: 'FadeIn',
      styleLine: `Style: FadeIn,${style.fontName},${fontSize},${primaryBgr},&H00FFFFFF,${outlineBgr},${backColor},-1,0,0,0,100,100,0,0,${style.borderStyle},${style.outline},${style.shadow},2,10,10,${marginV},1`
    }
  }

  return {
    styleName: 'Karaoke',
    styleLine: `Style: Karaoke,${style.fontName},${fontSize},${highlightBgr},${primaryBgr},${outlineBgr},${backColor},-1,0,0,0,100,100,0,0,${style.borderStyle},${style.outline},${style.shadow},2,10,10,${marginV},1`
  }
}

function karaokeFillFormatLine(lineWords: WordChunk[], styleName: string): string {
  const lineStart = lineWords[0].start * 1000
  const lineEnd = lineWords[lineWords.length - 1].end * 1000
  const karaokeText = lineWords
    .map((word) => {
      const durationCs = Math.round((word.end - word.start) * 100)
      return `{\\kf${durationCs}}${word.text}`
    })
    .join(' ')
  return `Dialogue: 0,${formatAssTimestamp(lineStart)},${formatAssTimestamp(lineEnd)},${styleName},,0,0,0,,${karaokeText}`
}

function wordPopFormatLine(lineWords: WordChunk[], styleName: string): string {
  const lineStart = lineWords[0].start * 1000
  const lineEnd = lineWords[lineWords.length - 1].end * 1000
  const karaokeText = lineWords
    .map((word) => {
      const durationCs = Math.round((word.end - word.start) * 100)
      return `{\\kf${durationCs}}${word.text}`
    })
    .join(' ')
  const popTag = `{\\t(0,150,\\fscx115\\fscy115)\\t(150,350,\\fscx100\\fscy100)}`
  return `Dialogue: 0,${formatAssTimestamp(lineStart)},${formatAssTimestamp(lineEnd)},${styleName},,0,0,0,,${popTag}${karaokeText}`
}

function fadeInFormatLine(lineWords: WordChunk[], styleName: string): string {
  const lineStart = lineWords[0].start * 1000
  const lineEnd = lineWords[lineWords.length - 1].end * 1000
  const text = lineWords.map((w) => w.text).join(' ')
  return `Dialogue: 0,${formatAssTimestamp(lineStart)},${formatAssTimestamp(lineEnd)},${styleName},,0,0,0,,{\\fad(200,200)}${text}`
}

function glowFormatLine(lineWords: WordChunk[], styleName: string): string {
  const lineStart = lineWords[0].start * 1000
  const lineEnd = lineWords[lineWords.length - 1].end * 1000
  const karaokeText = lineWords
    .map((word) => {
      const durationCs = Math.round((word.end - word.start) * 100)
      return `{\\kf${durationCs}}${word.text}`
    })
    .join(' ')
  return `Dialogue: 0,${formatAssTimestamp(lineStart)},${formatAssTimestamp(lineEnd)},${styleName},,0,0,0,,{\\blur3}${karaokeText}`
}

function getLineFormatter(animation: FullCaptionStyle['animation']): LineFormatter {
  switch (animation) {
    case 'word-pop': return wordPopFormatLine
    case 'fade-in': return fadeInFormatLine
    case 'glow': return glowFormatLine
    case 'karaoke-fill':
    default: return karaokeFillFormatLine
  }
}

function generateDialogueLines(
  chunks: WordChunk[],
  wordsPerLine: number,
  styleName: string,
  formatLine: LineFormatter
): string[] {
  const groups: WordChunk[][] = []
  for (let i = 0; i < chunks.length; i += wordsPerLine) {
    groups.push(chunks.slice(i, i + wordsPerLine))
  }
  return groups.map((lineWords) => formatLine(lineWords, styleName))
}

function generateKaraokeFillAss(
  wordChunks: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number },
  style: FullCaptionStyle,
  position?: { x: number; y: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * style.fontSize)
  const marginV = computeMarginV(height, width, position)
  const { styleLine, styleName } = buildAnimationStyleLine(style, fontSize, marginV)
  const header = buildAssHeader(width, height, [styleLine])
  const dialogueLines = generateDialogueLines(wordChunks, style.wordsPerLine, styleName, karaokeFillFormatLine)
  return header + '\n' + dialogueLines.join('\n') + '\n'
}

function generateWordPopAss(
  wordChunks: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number },
  style: FullCaptionStyle,
  position?: { x: number; y: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * style.fontSize)
  const marginV = computeMarginV(height, width, position)
  const { styleLine, styleName } = buildAnimationStyleLine(style, fontSize, marginV)
  const header = buildAssHeader(width, height, [styleLine])
  const dialogueLines = generateDialogueLines(wordChunks, style.wordsPerLine, styleName, wordPopFormatLine)
  return header + '\n' + dialogueLines.join('\n') + '\n'
}

function generateFadeInAss(
  wordChunks: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number },
  style: FullCaptionStyle,
  position?: { x: number; y: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * style.fontSize)
  const marginV = computeMarginV(height, width, position)
  const { styleLine, styleName } = buildAnimationStyleLine(style, fontSize, marginV)
  const header = buildAssHeader(width, height, [styleLine])
  const dialogueLines = generateDialogueLines(wordChunks, style.wordsPerLine, styleName, fadeInFormatLine)
  return header + '\n' + dialogueLines.join('\n') + '\n'
}

function generateGlowAss(
  wordChunks: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number },
  style: FullCaptionStyle,
  position?: { x: number; y: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * style.fontSize)
  const marginV = computeMarginV(height, width, position)
  const { styleLine, styleName } = buildAnimationStyleLine(style, fontSize, marginV)
  const header = buildAssHeader(width, height, [styleLine])
  const dialogueLines = generateDialogueLines(wordChunks, style.wordsPerLine, styleName, glowFormatLine)
  return header + '\n' + dialogueLines.join('\n') + '\n'
}

export function generateCombinedAssFile(
  segments: { wordChunks: { text: string; start: number; end: number }[]; offsetMs: number; durationMs?: number }[],
  resolution: { width: number; height: number },
  style?: FullCaptionStyle,
  position?: { x: number; y: number }
): string {
  const s = sanitizeCaptionStyle(style)
  const cleanSegments = sanitizeCaptionSegments(segments)
  const { width, height } = resolution
  const fontSize = Math.round(height * s.fontSize)
  const marginV = computeMarginV(height, width, position)

  const { styleLine, styleName } = buildAnimationStyleLine(s, fontSize, marginV)
  const header = buildAssHeader(width, height, [styleLine])
  const formatLine = getLineFormatter(s.animation)

  const allDialogueLines: string[] = []

  for (const segment of cleanSegments) {
    const offsetSec = segment.offsetMs / 1000
    const durationSec = segment.durationMs != null ? segment.durationMs / 1000 : undefined

    const adjusted: WordChunk[] = []
    for (const chunk of segment.wordChunks) {
      const start = chunk.start + offsetSec
      const end = chunk.end + offsetSec

      if (durationSec != null) {
        const segEnd = offsetSec + durationSec
        if (start >= segEnd) continue
        const clippedEnd = Math.min(end, segEnd)
        if (clippedEnd <= start) continue
        adjusted.push({ text: chunk.text, start, end: clippedEnd })
      } else {
        adjusted.push({ text: chunk.text, start, end })
      }
    }

    // Group this segment's words independently (no cross-clip bleed)
    const lines = generateDialogueLines(adjusted, s.wordsPerLine, styleName, formatLine)
    allDialogueLines.push(...lines)
  }

  return header + '\n' + allDialogueLines.join('\n') + '\n'
}

function generateTextOverlayAssFile(
  text: string,
  durationSec: number,
  resolution: { width: number; height: number },
  position?: { x: number; y: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * 0.035)
  const isVertical916 = width * 16 <= height * 9
  const defaultMarginV = isVertical916 ? Math.round(height * 0.12) : Math.round(height * 0.03)

  // Estimate box dimensions based on text length and font size
  const charWidth = fontSize * 0.55
  const textWidth = Math.round(text.length * charWidth)
  const padX = Math.round(fontSize * 0.6)
  const padY = Math.round(fontSize * 0.35)
  const boxW = textWidth + padX * 2
  const boxH = fontSize + padY * 2
  const r = 33 // corner radius

  // Position: use template position or default top-center
  const boxX = position
    ? Math.max(0, Math.round(width * (position.x / 100) - boxW / 2))
    : Math.round((width - boxW) / 2)
  const boxY = position
    ? Math.round(height * (position.y / 100))
    : defaultMarginV

  // ASS \p1 drawing for rounded rectangle (relative coordinates)
  // m = moveto, l = lineto, b = cubic bezier
  const roundedRect =
    `m ${r} 0 ` +
    `l ${boxW - r} 0 ` +
    `b ${boxW} 0 ${boxW} 0 ${boxW} ${r} ` +
    `l ${boxW} ${boxH - r} ` +
    `b ${boxW} ${boxH} ${boxW} ${boxH} ${boxW - r} ${boxH} ` +
    `l ${r} ${boxH} ` +
    `b 0 ${boxH} 0 ${boxH} 0 ${boxH - r} ` +
    `l 0 ${r} ` +
    `b 0 0 0 0 ${r} 0`

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TextOverlay,Arial,${fontSize},&H00000000,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,10,10,${defaultMarginV},1
Style: TextBox,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const start = formatAssTimestamp(0)
  const end = formatAssTimestamp(durationSec * 1000)
  const escaped = text.replace(/\n/g, '\\N')

  // Layer 0: white rounded-rect background drawn at absolute position
  const bgLine = `Dialogue: 0,${start},${end},TextBox,,0,0,0,,{\\pos(${boxX},${boxY})\\p1}${roundedRect}{\\p0}`
  // Layer 1: black text centered in the box
  const textPosX = position
    ? Math.round(width * (position.x / 100))
    : Math.round(width / 2)
  const textPosY = Math.round(boxY + boxH / 2)
  const textLine = `Dialogue: 1,${start},${end},TextOverlay,,0,0,0,,{\\pos(${textPosX},${textPosY})}${escaped}`

  return header + '\n' + bgLine + '\n' + textLine + '\n'
}

export function parseWavToFloat32(buffer: Buffer): Float32Array {
  // Parse WAV header to find data chunk
  // Standard RIFF WAV: 'RIFF' + size + 'WAVE' + chunks
  let offset = 12 // Skip RIFF header
  let dataOffset = 0
  let dataSize = 0

  while (offset < buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)

    if (chunkId === 'data') {
      dataOffset = offset + 8
      dataSize = chunkSize
      break
    }
    offset += 8 + chunkSize
    // WAV chunks are word-aligned
    if (chunkSize % 2 !== 0) offset++
  }

  if (dataOffset === 0) throw new Error('No data chunk found in WAV file')

  // Convert 16-bit PCM to Float32
  const int16 = new Int16Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 2)
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768
  }

  return float32
}
