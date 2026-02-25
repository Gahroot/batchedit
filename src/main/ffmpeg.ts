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

export { ffmpeg }
