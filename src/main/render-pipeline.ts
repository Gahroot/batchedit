import { ipcMain, app } from 'electron'
import { ffmpeg, getVideoMetadata, extractAudio, trimVideo } from './ffmpeg'
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
        job.resolution
      )
      const assPath = join(tmpdir(), `batchedit-textoverlay-${uuidv4()}.ass`)
      writeFileSync(assPath, assContent, 'utf-8')
      tempAssFiles.push(assPath)

      const escaped = escapeFilterPath(assPath)
      filters.push(`${currentLabel}ass=${escaped}[vtxt]`)
      currentLabel = '[vtxt]'
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
        }[]
        resolution: { width: number; height: number }
        captionStyle?: { fontName: string; highlightColor: string }
      }
    ) => {
      const assContent = generateCombinedAssFile(data.segments, data.resolution, data.captionStyle)
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
  style?: { fontName: string; highlightColor: string }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * 0.05)
  const isVertical916 = width * 16 <= height * 9
  // 9:16: just below center (40% up from bottom); others: near bottom (5%)
  const marginV = isVertical916 ? Math.round(height * 0.80) : Math.round(height * 0.05)
  const fontName = style?.fontName || 'Arial'
  const highlightBgr = style ? cssHexToAssBgr(style.highlightColor) : '&H0000FFFF'

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,${fontName},${fontSize},${highlightBgr},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  // Group words into display lines of ~4 words each
  const lines: { text: string; start: number; end: number }[][] = []
  for (let i = 0; i < wordChunks.length; i += 4) {
    lines.push(wordChunks.slice(i, i + 4))
  }

  const dialogueLines = lines.map((lineWords) => {
    const lineStart = lineWords[0].start * 1000 // seconds -> ms
    const lineEnd = lineWords[lineWords.length - 1].end * 1000

    // Build karaoke tags: each word gets \kf<centiseconds>
    const karaokeText = lineWords
      .map((word) => {
        const durationCs = Math.round((word.end - word.start) * 100)
        return `{\\kf${durationCs}}${word.text}`
      })
      .join(' ')

    const start = formatAssTimestamp(lineStart)
    const end = formatAssTimestamp(lineEnd)
    return `Dialogue: 0,${start},${end},Karaoke,,0,0,0,,${karaokeText}`
  })

  return header + '\n' + dialogueLines.join('\n') + '\n'
}

export function generateCombinedAssFile(
  segments: { wordChunks: { text: string; start: number; end: number }[]; offsetMs: number }[],
  resolution: { width: number; height: number },
  style?: { fontName: string; highlightColor: string }
): string {
  // Combine all segments with their time offsets applied
  const allChunks: { text: string; start: number; end: number }[] = []

  for (const segment of segments) {
    const offsetSec = segment.offsetMs / 1000
    for (const chunk of segment.wordChunks) {
      allChunks.push({
        text: chunk.text,
        start: chunk.start + offsetSec,
        end: chunk.end + offsetSec
      })
    }
  }

  return generateWordHighlightAssFile(allChunks, resolution, style)
}

function generateTextOverlayAssFile(
  text: string,
  durationSec: number,
  resolution: { width: number; height: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * 0.035)
  const isVertical916 = width * 16 <= height * 9
  const marginV = isVertical916 ? Math.round(height * 0.08) : Math.round(height * 0.03)

  // Estimate box dimensions based on text length and font size
  const charWidth = fontSize * 0.55
  const textWidth = Math.round(text.length * charWidth)
  const padX = Math.round(fontSize * 0.6)
  const padY = Math.round(fontSize * 0.35)
  const boxW = textWidth + padX * 2
  const boxH = fontSize + padY * 2
  const r = 33 // corner radius

  // Position: top-center, offset by marginV from top (alignment 8)
  const boxX = Math.round((width - boxW) / 2)
  const boxY = marginV

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
Style: TextOverlay,Arial,${fontSize},&H00000000,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,8,10,10,${marginV},1
Style: TextBox,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const start = formatAssTimestamp(0)
  const end = formatAssTimestamp(durationSec * 1000)
  const escaped = text.replace(/\n/g, '\\N')

  // Layer 0: white rounded-rect background drawn at absolute position
  const bgLine = `Dialogue: 0,${start},${end},TextBox,,0,0,0,,{\\pos(${boxX},${boxY})\\p1}${roundedRect}{\\p0}`
  // Layer 1: black text on top
  const textLine = `Dialogue: 1,${start},${end},TextOverlay,,0,0,0,,${escaped}`

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
