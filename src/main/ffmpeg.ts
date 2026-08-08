import ffmpeg from 'fluent-ffmpeg'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'

export interface FFmpegReadiness {
  ready: boolean
  ffmpegPath: string | null
  ffprobePath: string | null
  encoder: string | null
  issues: string[]
}

interface BinaryResolution {
  path: string | null
  issues: string[]
}

function normalizeAsarUnpackedPath(binaryPath: string): string {
  return binaryPath.replace('app.asar', 'app.asar.unpacked')
}

function isUsableFile(filePath: string | null): filePath is string {
  return filePath !== null && existsSync(filePath)
}

function resolvePackageBinaryPath(name: 'ffmpeg' | 'ffprobe'): BinaryResolution {
  try {
    if (name === 'ffmpeg') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const packagePath = require('ffmpeg-static') as string | null
      const unpackedPath = packagePath ? normalizeAsarUnpackedPath(packagePath) : null
      return isUsableFile(unpackedPath)
        ? { path: unpackedPath, issues: [] }
        : { path: null, issues: [`ffmpeg-static did not provide a usable binary path (${unpackedPath ?? 'null'}).`] }
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { path: packagePath } = require('@ffprobe-installer/ffprobe') as { path: string }
    const unpackedPath = normalizeAsarUnpackedPath(packagePath)
    return isUsableFile(unpackedPath)
      ? { path: unpackedPath, issues: [] }
      : { path: null, issues: [`@ffprobe-installer/ffprobe did not provide a usable binary path (${unpackedPath}).`] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { path: null, issues: [`Unable to load ${name} npm package: ${message}`] }
  }
}

function getFfprobePlatformPackage(): string {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return `${process.platform}-${arch}`
}

function resolveBinaryPath(name: 'ffmpeg' | 'ffprobe'): BinaryResolution {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const binary = `${name}${ext}`
  const issues: string[] = []

  if (app.isPackaged) {
    const resourceBin = join(process.resourcesPath, 'bin', binary)
    if (existsSync(resourceBin)) return { path: resourceBin, issues }
    issues.push(`Missing packaged ${name} binary at ${resourceBin}.`)
  }

  const packageResolution = resolvePackageBinaryPath(name)
  issues.push(...packageResolution.issues)
  if (packageResolution.path) return { path: packageResolution.path, issues }

  if (app.isPackaged) {
    const unpackedNodeModules = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    const candidates = name === 'ffmpeg'
      ? [join(unpackedNodeModules, 'ffmpeg-static', binary)]
      : [
          join(unpackedNodeModules, '@ffprobe-installer', 'ffprobe', binary),
          join(unpackedNodeModules, '@ffprobe-installer', getFfprobePlatformPackage(), binary)
        ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) return { path: candidate, issues }
    }
    issues.push(`Missing unpacked ${name} binary under ${unpackedNodeModules}.`)
  }

  return { path: null, issues }
}

let ffmpegReady = false
let ffmpegIssues: string[] = []
let resolvedFfmpegPath: string | null = null
let resolvedFfprobePath: string | null = null

export function setupFFmpeg(): FFmpegReadiness {
  const ffmpegBin = resolveBinaryPath('ffmpeg')
  const ffprobeBin = resolveBinaryPath('ffprobe')

  resolvedFfmpegPath = ffmpegBin.path
  resolvedFfprobePath = ffprobeBin.path
  ffmpegIssues = [...ffmpegBin.issues, ...ffprobeBin.issues]
  cachedEncoder = null

  if (resolvedFfmpegPath) {
    ffmpeg.setFfmpegPath(resolvedFfmpegPath)
  }
  if (resolvedFfprobePath) {
    ffmpeg.setFfprobePath(resolvedFfprobePath)
  }

  ffmpegReady = Boolean(resolvedFfmpegPath && resolvedFfprobePath)
  if (ffmpegReady) {
    detectHardwareEncoder()
  }

  return getFFmpegReadiness()
}

// --- Hardware encoder detection ---

export interface EncoderConfig {
  encoder: string
  presetFlag: string[]
}

const hwEncoderPriority = ['h264_nvenc', 'h264_vaapi', 'h264_qsv'] as const
type HwEncoder = (typeof hwEncoderPriority)[number] | 'libx264'

let cachedEncoder: HwEncoder | null = null

function detectHardwareEncoder(): HwEncoder {
  if (cachedEncoder !== null) return cachedEncoder

  if (!resolvedFfmpegPath) {
    cachedEncoder = 'libx264'
    ffmpegIssues.push('FFmpeg encoder probe skipped because no bundled ffmpeg binary was resolved.')
    return cachedEncoder
  }

  try {
    const output = execFileSync(resolvedFfmpegPath, ['-encoders', '-hide_banner'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    for (const enc of hwEncoderPriority) {
      if (output.includes(enc)) {
        cachedEncoder = enc
        console.info(`[FFmpeg] Hardware encoder detected: ${enc}`)
        return enc
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ffmpegIssues.push(`Unable to probe ffmpeg encoders at ${resolvedFfmpegPath}: ${message}`)
  }

  cachedEncoder = 'libx264'
  console.info('[FFmpeg] No hardware encoder found, using libx264')
  return cachedEncoder
}

export function getEncoder(): EncoderConfig {
  const encoder = cachedEncoder ?? detectHardwareEncoder()

  switch (encoder) {
    case 'h264_nvenc':
      return { encoder, presetFlag: ['-preset', 'p4', '-rc', 'vbr', '-cq', '23'] }
    case 'h264_vaapi':
      return { encoder, presetFlag: ['-rc_mode', 'CQP', '-qp', '23'] }
    case 'h264_qsv':
      return { encoder, presetFlag: ['-preset', 'fast', '-global_quality', '23'] }
    default:
      return { encoder: 'libx264', presetFlag: ['-preset', 'veryfast', '-crf', '23'] }
  }
}

/** Software-only fallback encoder (always libx264, never GPU) */
export function getSoftwareEncoder(): EncoderConfig {
  return { encoder: 'libx264', presetFlag: ['-preset', 'veryfast', '-crf', '23'] }
}

/** Check if an FFmpeg error is an NVENC session exhaustion failure */
export function isGpuSessionError(errorMessage: string): boolean {
  return (
    errorMessage.includes('OpenEncodeSessionEx failed') ||
    errorMessage.includes('No capable devices found') ||
    errorMessage.includes('Cannot load nvcuda.dll') ||
    errorMessage.includes('out of memory')
  )
}

export function getFFmpegReadiness(): FFmpegReadiness {
  return {
    ready: ffmpegReady,
    ffmpegPath: resolvedFfmpegPath,
    ffprobePath: resolvedFfprobePath,
    encoder: cachedEncoder,
    issues: [...ffmpegIssues]
  }
}

export function isFFmpegAvailable(): boolean {
  return ffmpegReady
}

export function getResolvedFfmpegPath(): string | null {
  return resolvedFfmpegPath
}

export class MediaOperationCanceledError extends Error {
  constructor() {
    super('Media operation canceled')
    this.name = 'MediaOperationCanceledError'
  }
}

export function isMediaOperationCanceled(error: unknown): boolean {
  return error instanceof MediaOperationCanceledError
}

function throwIfMediaOperationCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaOperationCanceledError()
}

async function executeFfmpegCommand(
  command: ffmpeg.FfmpegCommand,
  start: () => void,
  signal?: AbortSignal
): Promise<void> {
  throwIfMediaOperationCanceled(signal)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const handleAbort = (): void => {
      try {
        command.kill('SIGKILL')
      } catch {}
    }
    const finish = (result: { ok: true } | { ok: false; error: unknown }): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', handleAbort)
      if (result.ok) resolve()
      else reject(result.error)
    }

    signal?.addEventListener('abort', handleAbort, { once: true })
    command
      .on('start', () => {
        if (signal?.aborted) handleAbort()
      })
      .on('end', () => {
        finish(
          signal?.aborted ? { ok: false, error: new MediaOperationCanceledError() } : { ok: true }
        )
      })
      .on('error', (error) => {
        finish({
          ok: false,
          error: signal?.aborted ? new MediaOperationCanceledError() : error
        })
      })

    try {
      start()
    } catch (error) {
      finish({ ok: false, error })
    }
  })
}

interface ProbedVideoMetadata {
  duration: number
  width: number
  height: number
  codec: string
  fps: number
  audioCodec: string
}

export function getVideoMetadata(
  filePath: string,
  signal?: AbortSignal
): Promise<ProbedVideoMetadata> {
  throwIfMediaOperationCanceled(signal)

  return new Promise((resolve, reject) => {
    let settled = false
    const handleAbort = (): void => {
      finish({ ok: false, error: new MediaOperationCanceledError() })
    }
    const finish = (
      result: { ok: true; value: ProbedVideoMetadata } | { ok: false; error: unknown }
    ): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', handleAbort)
      if (result.ok) resolve(result.value)
      else reject(result.error)
    }
    signal?.addEventListener('abort', handleAbort, { once: true })

    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (signal?.aborted) {
        finish({ ok: false, error: new MediaOperationCanceledError() })
        return
      }
      if (error) {
        finish({ ok: false, error })
        return
      }
      const video = metadata.streams.find((stream) => stream.codec_type === 'video')
      if (!video) {
        finish({ ok: false, error: new Error('No video stream found') })
        return
      }
      const audio = metadata.streams.find((stream) => stream.codec_type === 'audio')
      // Parse r_frame_rate (e.g. "30/1", "30000/1001")
      let fps = 0
      const rateStr = video.r_frame_rate || video.avg_frame_rate || ''
      if (rateStr) {
        const parts = rateStr.split('/')
        if (parts.length === 2) {
          const numerator = Number.parseFloat(parts[0] ?? '')
          const denominator = Number.parseFloat(parts[1] ?? '')
          if (denominator > 0) fps = numerator / denominator
        } else {
          fps = Number.parseFloat(rateStr) || 0
        }
      }
      finish({
        ok: true,
        value: {
          duration: metadata.format.duration || 0,
          width: video.width || 0,
          height: video.height || 0,
          codec: video.codec_name || 'unknown',
          fps,
          audioCodec: audio?.codec_name || 'unknown'
        }
      })
    })
  })
}

export async function extractAudio(
  videoPath: string,
  outputPath: string,
  signal?: AbortSignal
): Promise<string> {
  const command = ffmpeg(videoPath)
    .noVideo()
    .audioFrequency(16000)
    .audioChannels(1)
    .format('wav')

  try {
    await executeFfmpegCommand(command, () => command.save(outputPath), signal)
    return outputPath
  } catch (error) {
    try { unlinkSync(outputPath) } catch {}
    throw error
  }
}

export async function trimVideo(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number,
  signal?: AbortSignal
): Promise<string> {
  const streamCopyCommand = ffmpeg(inputPath)
    .setStartTime(startTime)
    .setDuration(endTime - startTime)
    .outputOptions(['-y', '-c', 'copy'])

  try {
    await executeFfmpegCommand(streamCopyCommand, () => streamCopyCommand.save(outputPath), signal)
    return outputPath
  } catch (error) {
    try { unlinkSync(outputPath) } catch {}
    if (isMediaOperationCanceled(error)) throw error
  }

  const { encoder, presetFlag } = getEncoder()
  const reencodeCommand = ffmpeg(inputPath)
    .setStartTime(startTime)
    .setDuration(endTime - startTime)
    .outputOptions(['-y', '-c:v', encoder, ...presetFlag, '-c:a', 'aac'])

  try {
    await executeFfmpegCommand(reencodeCommand, () => reencodeCommand.save(outputPath), signal)
    return outputPath
  } catch (error) {
    try { unlinkSync(outputPath) } catch {}
    throw error
  }
}

export async function trimVideoReencode(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number,
  signal?: AbortSignal
): Promise<string> {
  const { encoder, presetFlag } = getEncoder()
  const command = ffmpeg(inputPath)
    .setStartTime(startTime)
    .setDuration(endTime - startTime)
    .outputOptions(['-y', '-c:v', encoder, ...presetFlag, '-c:a', 'aac'])

  try {
    await executeFfmpegCommand(command, () => command.save(outputPath), signal)
    return outputPath
  } catch (error) {
    try { unlinkSync(outputPath) } catch {}
    throw error
  }
}

export function parseSilenceStart(line: string): number | null {
  const match = line.match(/silence_start:\s*([\d.]+)/)
  return match ? Number.parseFloat(match[1] ?? '') : null
}

export function parseSilenceEnd(line: string): number | null {
  const match = line.match(/silence_end:\s*([\d.]+)/)
  return match ? Number.parseFloat(match[1] ?? '') : null
}

export interface SilenceBounds {
  leadingEnd: number
  lastSilenceStart: number | null
  lastSilenceEnd: number | null
}

export async function detectSilenceBounds(
  filePath: string,
  noiseDb = -40,
  minDuration = 0.1,
  signal?: AbortSignal
): Promise<SilenceBounds> {
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
  let firstSilenceStart: number | null = null
  let leadingEnd = 0
  let leadingResolved = false
  let lastSilenceStart: number | null = null
  let lastSilenceEnd: number | null = null

  const command = ffmpeg(filePath)
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

  await executeFfmpegCommand(command, () => command.run(), signal)
  return { leadingEnd, lastSilenceStart, lastSilenceEnd }
}

export async function detectLeadingSilence(
  filePath: string,
  noiseDb = -40,
  minDuration = 0.1,
  signal?: AbortSignal
): Promise<number> {
  const bounds = await detectSilenceBounds(filePath, noiseDb, minDuration, signal)
  return bounds.leadingEnd
}

export async function trimLeadingSilence(
  inputPath: string,
  outputPath: string,
  safetyMarginSec = 0.05,
  signal?: AbortSignal
): Promise<{ outputPath: string; trimmedSeconds: number }> {
  const bounds = await detectSilenceBounds(inputPath, -40, 0.1, signal)
  const meta = await getVideoMetadata(inputPath, signal)
  throwIfMediaOperationCanceled(signal)

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
      && meta.duration - bounds.lastSilenceEnd < 0.05

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

  await trimVideo(inputPath, outputPath, trimStart, trimEnd, signal)
  return { outputPath, trimmedSeconds: totalTrimmed }
}

export { ffmpeg }
