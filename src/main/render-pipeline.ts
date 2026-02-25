import { ipcMain, app } from 'electron'
import { ffmpeg, getVideoMetadata, extractAudio } from './ffmpeg'
import { join } from 'path'
import { writeFileSync, mkdirSync, unlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { v4 as uuidv4 } from 'uuid'

export interface RenderJob {
  id: string
  hookPath: string
  meatPath: string
  ctaPath: string
  outputPath: string
  textOverlay?: string
  captionsAssPath?: string
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
    const { width, height } = job.resolution

    // Build filter graph: normalize each input then concat
    const scaleFilter = (idx: number): string =>
      `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,setpts=PTS-STARTPTS[v${idx}]`

    const filters = [
      scaleFilter(0),
      scaleFilter(1),
      scaleFilter(2),
      `[v0][0:a][v1][1:a][v2][2:a]concat=n=3:v=1:a=1[vout][aout]`
    ]

    // Add text overlay on hook segment if specified
    if (job.textOverlay) {
      const escapedText = job.textOverlay
        .replace(/\\/g, '\\\\\\\\')
        .replace(/'/g, "\\\\\\'")
        .replace(/:/g, '\\\\:')
        .replace(/%/g, '%%')

      filters.push(
        `[vout]drawtext=text='${escapedText}':` +
          `fontcolor=white:fontsize=60:` +
          `x=(w-text_w)/2:y=(h-text_h)/2:` +
          `box=1:boxcolor=black@0.5:boxborderw=10:` +
          `shadowcolor=black:shadowx=2:shadowy=2[vtxt]`
      )
    }

    // Add ASS captions if provided
    if (job.captionsAssPath) {
      const escapedPath = job.captionsAssPath.replace(/:/g, '\\\\:').replace(/\\/g, '/')
      const inputLabel = job.textOverlay ? '[vtxt]' : '[vout]'
      filters.push(`${inputLabel}ass=${escapedPath}[vfinal]`)
    }

    // Determine final video output label
    let finalVideoLabel = '[vout]'
    if (job.captionsAssPath) finalVideoLabel = '[vfinal]'
    else if (job.textOverlay) finalVideoLabel = '[vtxt]'

    const command = ffmpeg()
      .input(job.hookPath)
      .input(job.meatPath)
      .input(job.ctaPath)
      .complexFilter(filters.join(';'))
      .outputOptions([
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
      .on('progress', (progress) => {
        onProgress(progress.percent || 0)
      })
      .on('end', () => resolve())
      .on('error', (err) => reject(err))

    command.save(job.outputPath)
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
      }
    ) => {
      const assContent = generateCombinedAssFile(data.segments, data.resolution)
      const tmpPath = join(tmpdir(), `batchedit-karaoke-${uuidv4()}.ass`)
      writeFileSync(tmpPath, assContent, 'utf-8')
      return tmpPath
    }
  )

  // Read WAV file and return PCM Float32Array for Whisper
  ipcMain.handle('ffmpeg:readAudioBuffer', async (_event, wavPath: string) => {
    const buffer = readFileSync(wavPath)

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

    return float32.buffer
  })

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

function generateAssFile(
  captions: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * 0.04)

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,10,10,${Math.round(height * 0.05)},1
Style: Highlight,Arial,${fontSize},&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,10,10,${Math.round(height * 0.05)},1

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

function formatAssTimestamp(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function generateWordHighlightAssFile(
  wordChunks: { text: string; start: number; end: number }[],
  resolution: { width: number; height: number }
): string {
  const { width, height } = resolution
  const fontSize = Math.round(height * 0.05)
  const marginV = Math.round(height * 0.05)

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Arial,${fontSize},&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,10,10,${marginV},1

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

function generateCombinedAssFile(
  segments: { wordChunks: { text: string; start: number; end: number }[]; offsetMs: number }[],
  resolution: { width: number; height: number }
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

  return generateWordHighlightAssFile(allChunks, resolution)
}
