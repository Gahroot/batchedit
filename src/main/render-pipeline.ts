import { ipcMain, app } from 'electron'
import { ffmpeg, getVideoMetadata, extractAudio, trimVideo, trimVideoReencode, detectLeadingSilence, trimLeadingSilence } from './ffmpeg'
import { join, normalize } from 'path'
import { writeFileSync, mkdirSync, unlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { v4 as uuidv4 } from 'uuid'

function getFontsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'fonts')
  }
  return join(app.getAppPath(), 'resources', 'fonts')
}

/** Escape a file path for use inside an FFmpeg -filter_complex option value.
 *  Needs DOUBLE backslash escaping: the filter graph parser consumes one level,
 *  then the filter option parser consumes the second.
 *  Ref: github.com/ddean2009/MoneyPrinterPlus (confirmed working on Windows) */
function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, '/')        // normalize Windows backslashes to forward slashes
    .replace(/:/g, '\\\\:')     // double-escape colons (C: → C\\:)
    .replace(/'/g, "\\\\'")     // double-escape single quotes
    .replace(/\[/g, '\\\\[')    // double-escape open brackets
    .replace(/\]/g, '\\\\]')    // double-escape close brackets
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

const DEFAULT_STYLE: FullCaptionStyle = {
  fontName: 'Inter', fontFile: 'Inter-Bold.ttf',
  fontSize: 0.05, primaryColor: '#FFFFFF', highlightColor: '#FFFF00',
  outlineColor: '#000000', backColor: '#80000000',
  outline: 3, shadow: 1, borderStyle: 1, wordsPerLine: 4, animation: 'karaoke-fill'
}

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
}

export interface RenderProgress {
  jobId: string
  percent: number
  status: 'queued' | 'rendering' | 'done' | 'error'
  error?: string
}

function concatWithNormalization(
  job: RenderJob,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Normalize paths for Windows compatibility (mixed separators cause EINVAL)
    const hookPath = normalize(job.hookPath)
    const meatPath = normalize(job.meatPath)
    const ctaPath = normalize(job.ctaPath)
    const outputPath = normalize(job.outputPath)

    const { width, height } = job.resolution

    // Build filter graph: normalize each input then concat
    const scaleFilter = (idx: number): string =>
      job.autoResize
        ? `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height},fps=30,setpts=PTS-STARTPTS[v${idx}]`
        : `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,setpts=PTS-STARTPTS[v${idx}]`

    const filters = [
      scaleFilter(0),
      scaleFilter(1),
      scaleFilter(2),
      `[v0][0:a][v1][1:a][v2][2:a]concat=n=3:v=1:a=1[vout][aout]`
    ]

    // Track temp ASS files to clean up after render
    const tempAssFiles: string[] = []
    let currentLabel = '[vout]'

    // Add text overlay on hook segment via ASS (drawtext not available in ffmpeg-static)
    if (job.textOverlay && job.hookDurationSec) {
      const assContent = generateTextOverlayAssFile(
        job.textOverlay,
        job.hookDurationSec,
        job.resolution,
        job.titlePosition
      )
      const assPath = join(tmpdir(), `batchedit-textoverlay-${uuidv4()}.ass`)
      writeFileSync(assPath, assContent, 'utf-8')
      tempAssFiles.push(assPath)

      const escaped = escapeFilterPath(assPath)
      filters.push(`${currentLabel}ass=${escaped}[vtxt]`)
      currentLabel = '[vtxt]'
    }

    // Media overlay images (proof images on meat/CTA segments)
    // -loop 1 on input produces continuous frames; eof_action=repeat as safety net
    let nextInputIdx = 3
    const extraInputPaths: string[] = []

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

    // Add ASS captions if provided (with fontsdir for bundled fonts)
    if (job.captionsAssPath) {
      const escaped = escapeFilterPath(job.captionsAssPath)
      const fontsDir = escapeFilterPath(getFontsDir())
      filters.push(`${currentLabel}ass=${escaped}:fontsdir=${fontsDir}[vfinal]`)
      currentLabel = '[vfinal]'
    }

    const finalVideoLabel = currentLabel

    const command = ffmpeg()
      .input(hookPath)
      .input(meatPath)
      .input(ctaPath)

    // Add extra inputs for media overlays (eof_action=repeat on each overlay
    // filter repeats the single image frame for the full duration)
    for (const imgPath of extraInputPaths) {
      command.input(imgPath)
    }

    command
      .complexFilter(filters.join(';'))
      .outputOptions([
        '-y',
        '-map',
        finalVideoLabel,
        '-map',
        '[aout]',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart'
      ])
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] ${commandLine}`)
      })
      .on('progress', (progress) => {
        onProgress(progress.percent || 0)
      })
      .on('end', () => {
        tempAssFiles.forEach((f) => { try { unlinkSync(f) } catch {} })
        resolve()
      })
      .on('error', (err, _stdout, stderr) => {
        if (stderr) console.error(`[FFmpeg] stderr:\n${stderr}`)
        tempAssFiles.forEach((f) => { try { unlinkSync(f) } catch {} })
        reject(new Error(stderr ? `${err.message}\nFFmpeg output:\n${stderr}` : err.message))
      })

    command.save(outputPath)
  })
}

// Maximum concurrent renders (leave some CPU for the UI)
const MAX_CONCURRENT = Math.max(1, Math.floor(require('os').cpus().length / 2))

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
      const tmpPath = join(tmpdir(), `batchedit-audio-${uuidv4()}.wav`)
      return extractAudio(videoPath, tmpPath)
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
      const tmpPath = join(tmpdir(), `batchedit-subs-${uuidv4()}.ass`)
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
      const tmpPath = join(tmpdir(), `batchedit-karaoke-${uuidv4()}.ass`)
      writeFileSync(tmpPath, assContent, 'utf-8')
      return tmpPath
    }
  )

  // Read WAV file and return PCM Float32Array for Whisper
  ipcMain.handle('ffmpeg:readAudioBuffer', async (_event, wavPath: string) => {
    const buffer = readFileSync(wavPath)
    return parseWavToFloat32(buffer).buffer
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
      for (const seg of segments) {
        const safeName = seg.label.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_')
        const outputPath = join(dir, `${safeName}.mp4`)
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

  // Batch render
  ipcMain.handle(
    'render:batch',
    async (event, jobs: RenderJob[]) => {
      const results: RenderProgress[] = jobs.map((j) => ({
        jobId: j.id,
        percent: 0,
        status: 'queued' as const
      }))

      // Create output directory
      if (jobs.length > 0) {
        const outDir = join(jobs[0].outputPath, '..')
        mkdirSync(outDir, { recursive: true })
      }

      // Process in batches
      let completed = 0
      const queue = [...jobs]

      async function processNext(): Promise<void> {
        const job = queue.shift()
        if (!job) return

        const idx = jobs.findIndex((j) => j.id === job.id)
        results[idx].status = 'rendering'
        event.sender.send('render:progress', results)

        try {
          await concatWithNormalization(job, (percent) => {
            results[idx].percent = percent
            event.sender.send('render:progress', results)
          })
          results[idx].status = 'done'
          results[idx].percent = 100
          completed++
        } catch (err: any) {
          results[idx].status = 'error'
          results[idx].error = err.message
          completed++
        }

        event.sender.send('render:progress', results)
        await processNext()
      }

      // Start N concurrent workers
      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENT, jobs.length) },
        () => processNext()
      )
      await Promise.all(workers)

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

  const dialogueLines = captions.map((cap) => {
    const start = formatAssTimestamp(cap.start)
    const end = formatAssTimestamp(cap.end)
    const text = cap.text.replace(/\n/g, '\\N')
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`
  })

  return header + '\n' + dialogueLines.join('\n') + '\n'
}

export function formatAssTimestamp(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export function generateWordHighlightAssFile(
  wordChunks: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number },
  style?: FullCaptionStyle,
  position?: { x: number; y: number }
): string {
  const s = style || DEFAULT_STYLE
  switch (s.animation) {
    case 'word-pop':
      return generateWordPopAss(wordChunks, resolution, s, position)
    case 'fade-in':
      return generateFadeInAss(wordChunks, resolution, s, position)
    case 'glow':
      return generateGlowAss(wordChunks, resolution, s, position)
    case 'karaoke-fill':
    default:
      return generateKaraokeFillAss(wordChunks, resolution, s, position)
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
type LineFormatter = (lineWords: WordChunk[], styleName: string) => string

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
  const s = style || DEFAULT_STYLE
  const { width, height } = resolution
  const fontSize = Math.round(height * s.fontSize)
  const marginV = computeMarginV(height, width, position)

  const { styleLine, styleName } = buildAnimationStyleLine(s, fontSize, marginV)
  const header = buildAssHeader(width, height, [styleLine])
  const formatLine = getLineFormatter(s.animation)

  const allDialogueLines: string[] = []

  for (const segment of segments) {
    const offsetSec = segment.offsetMs / 1000
    const durationSec = segment.durationMs != null ? segment.durationMs / 1000 : undefined

    const adjusted: WordChunk[] = []
    for (const chunk of segment.wordChunks) {
      const start = chunk.start + offsetSec
      const end = chunk.end + offsetSec

      if (durationSec != null) {
        const segEnd = offsetSec + durationSec
        // Skip words that start at or after segment end
        if (start >= segEnd) continue
        adjusted.push({ text: chunk.text, start, end: Math.min(end, segEnd) })
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
