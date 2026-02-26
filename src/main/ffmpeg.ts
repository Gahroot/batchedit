import ffmpeg from 'fluent-ffmpeg'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

function resolveBinaryPath(name: string): string | null {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const binary = `${name}${ext}`

  // Production: check extraResources/bin
  if (app.isPackaged) {
    const resourceBin = join(process.resourcesPath, 'bin', binary)
    if (existsSync(resourceBin)) return resourceBin

    // Also check asar-unpacked node_modules (legacy)
    const unpackedFfmpeg = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      name === 'ffmpeg' ? 'ffmpeg-static' : '@ffprobe-installer',
      binary
    )
    if (existsSync(unpackedFfmpeg)) return unpackedFfmpeg
  }

  // Dev: use npm packages
  try {
    if (name === 'ffmpeg') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = require('ffmpeg-static') as string | null
      if (p) return p
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { path: p } = require('@ffprobe-installer/ffprobe') as { path: string }
      if (p) return p
    }
  } catch {
    // Package not available for this platform — fall through
  }

  return null
}

let ffmpegReady = false

export function setupFFmpeg(): void {
  const ffmpegBin = resolveBinaryPath('ffmpeg')
  const ffprobeBin = resolveBinaryPath('ffprobe')

  if (ffmpegBin) {
    ffmpeg.setFfmpegPath(ffmpegBin)
  }
  if (ffprobeBin) {
    ffmpeg.setFfprobePath(ffprobeBin)
  }

  ffmpegReady = !!(ffmpegBin && ffprobeBin)
}

export function isFFmpegAvailable(): boolean {
  return ffmpegReady
}

export function getVideoMetadata(
  filePath: string
): Promise<{ duration: number; width: number; height: number; codec: string }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err)
      const video = metadata.streams.find((s) => s.codec_type === 'video')
      if (!video) return reject(new Error('No video stream found'))
      resolve({
        duration: metadata.format.duration || 0,
        width: video.width || 0,
        height: video.height || 0,
        codec: video.codec_name || 'unknown'
      })
    })
  })
}

export function extractAudio(videoPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath)
  })
}

export function trimVideo(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(endTime - startTime)
      .outputOptions(['-y', '-c', 'copy'])
      .on('end', () => resolve(outputPath))
      .on('error', () => {
        // Fallback: re-encode if stream copy fails
        ffmpeg(inputPath)
          .setStartTime(startTime)
          .setDuration(endTime - startTime)
          .outputOptions(['-y', '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac'])
          .on('end', () => resolve(outputPath))
          .on('error', reject)
          .save(outputPath)
      })
      .save(outputPath)
  })
}

export function parseSilenceStart(line: string): number | null {
  const match = line.match(/silence_start:\s*([\d.]+)/)
  return match ? parseFloat(match[1]) : null
}

export function parseSilenceEnd(line: string): number | null {
  const match = line.match(/silence_end:\s*([\d.]+)/)
  return match ? parseFloat(match[1]) : null
}

export interface SilenceBounds {
  leadingEnd: number
  lastSilenceStart: number | null
  lastSilenceEnd: number | null
}

export function detectSilenceBounds(
  filePath: string,
  noiseDb = -40,
  minDuration = 0.1
): Promise<SilenceBounds> {
  return new Promise((resolve) => {
    const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
    let firstSilenceStart: number | null = null
    let leadingEnd = 0
    let leadingResolved = false
    let lastSilenceStart: number | null = null
    let lastSilenceEnd: number | null = null

    ffmpeg(filePath)
      .audioFilters(`silencedetect=noise=${noiseDb}dB:d=${minDuration}`)
      .format('null')
      .output(nullDev)
      .on('stderr', (line: string) => {
        const startVal = parseSilenceStart(line)
        if (startVal !== null) {
          if (firstSilenceStart === null) firstSilenceStart = startVal
          lastSilenceStart = startVal
        }

        const endVal = parseSilenceEnd(line)
        if (endVal !== null) {
          if (!leadingResolved) {
            if (firstSilenceStart !== null && firstSilenceStart < 0.01) {
              leadingEnd = endVal
            }
            leadingResolved = true
          }
          lastSilenceEnd = endVal
        }
      })
      .on('end', () => resolve({ leadingEnd, lastSilenceStart, lastSilenceEnd }))
      .on('error', () => resolve({ leadingEnd: 0, lastSilenceStart: null, lastSilenceEnd: null }))
      .run()
  })
}

export async function detectLeadingSilence(
  filePath: string,
  noiseDb = -40,
  minDuration = 0.1
): Promise<number> {
  const bounds = await detectSilenceBounds(filePath, noiseDb, minDuration)
  return bounds.leadingEnd
}

export async function trimLeadingSilence(
  inputPath: string,
  outputPath: string,
  safetyMarginSec = 0.05
): Promise<{ outputPath: string; trimmedSeconds: number }> {
  const bounds = await detectSilenceBounds(inputPath)
  const meta = await getVideoMetadata(inputPath)

  // Leading: trim if silence >= 100ms at start
  const trimStart = bounds.leadingEnd >= 0.1
    ? Math.max(0, bounds.leadingEnd - safetyMarginSec)
    : 0

  // Trailing: trim if last silence region extends to end of file
  let trimEnd = meta.duration
  if (bounds.lastSilenceStart !== null) {
    // File ends mid-silence (no matching silence_end)
    const inSilence = bounds.lastSilenceEnd === null
      || bounds.lastSilenceStart > bounds.lastSilenceEnd
    // Last silence_end reaches file end
    const endsAtFile = bounds.lastSilenceEnd !== null
      && (meta.duration - bounds.lastSilenceEnd) < 0.05

    if (inSilence || endsAtFile) {
      trimEnd = Math.min(meta.duration, bounds.lastSilenceStart + safetyMarginSec)
    }
  }

  const totalTrimmed = trimStart + (meta.duration - trimEnd)
  if (totalTrimmed < 0.1) {
    return { outputPath: inputPath, trimmedSeconds: 0 }
  }

  // Guard: don't trim to nothing
  if (trimEnd - trimStart < 0.2) {
    return { outputPath: inputPath, trimmedSeconds: 0 }
  }

  await trimVideo(inputPath, outputPath, trimStart, trimEnd)
  return { outputPath, trimmedSeconds: totalTrimmed }
}

export { ffmpeg }
