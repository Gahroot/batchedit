import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import { path as ffprobePath } from '@ffprobe-installer/ffprobe'

export function setupFFmpeg(): void {
  if (ffmpegPath) {
    const correctedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
    ffmpeg.setFfmpegPath(correctedFfmpegPath)
  }

  const correctedFfprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked')
  ffmpeg.setFfprobePath(correctedFfprobePath)
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

export { ffmpeg }
