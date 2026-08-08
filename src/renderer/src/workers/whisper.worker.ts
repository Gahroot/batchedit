// Whisper Web Worker — WebGPU-accelerated transcription with Silero VAD for clean clip boundaries.
// Uses @huggingface/transformers v3+.
// VAD pattern adapted from huggingface/transformers.js-examples/moonshine-web.
// WebGPU detection + dtype config pattern adapted from dmtrKovalenko/subtitler.

import { pipeline, AutoModel, Tensor } from '@huggingface/transformers'
import type { AutomaticSpeechRecognitionConfig } from '@huggingface/transformers'
import {
  detectWhisperDevice,
  LARGE_WHISPER_MODEL,
  WASM_DEFAULT_WHISPER_MODEL,
  WHISPER_DEVICE
} from '../lib/whisper-config'

// Silero VAD constants (from transformers.js-examples/moonshine-web/constants.js)
const SAMPLE_RATE = 16000
const SPEECH_THRESHOLD = 0.3
const EXIT_THRESHOLD = 0.1
const MIN_SILENCE_DURATION_MS = 400
const VAD_WINDOW_SIZE = 512  // required Silero VAD window at 16kHz
const DEFAULT_ASR_CHUNK_LENGTH_S = 30
const DEFAULT_ASR_STRIDE_LENGTH_S = 5
const DEFAULT_WHISPER_MODEL = WASM_DEFAULT_WHISPER_MODEL

type WhisperAsrOptions = Pick<
  AutomaticSpeechRecognitionConfig,
  'return_timestamps' | 'chunk_length_s' | 'stride_length_s' | 'task' | 'language' | 'do_sample' | 'num_beams'
>

function isEnglishOnlyWhisperModel(modelName: string): boolean {
  return /(?:^|[\/-])whisper[^/]*\.en(?:$|[-_/])/.test(modelName)
}

export function getWhisperAsrOptions(modelName: string): WhisperAsrOptions {
  const options: WhisperAsrOptions = {
    return_timestamps: 'word',
    chunk_length_s: DEFAULT_ASR_CHUNK_LENGTH_S,
    stride_length_s: DEFAULT_ASR_STRIDE_LENGTH_S,
    task: 'transcribe',
    do_sample: false,
    num_beams: 1
  }

  if (isEnglishOnlyWhisperModel(modelName)) {
    options.language = 'english'
  }

  return options
}

export interface SpeechInterval {
  start: number
  end: number
}

export interface TranscriptionChunk {
  text: string
  start: number
  end: number
}

const DUPLICATE_OVERLAP_SEC = 0.04
const DUPLICATE_GAP_SEC = 0.12

function normalizeChunkText(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
}

function chunksOverlapOrTouch(first: TranscriptionChunk, second: TranscriptionChunk): boolean {
  return second.start <= first.end + DUPLICATE_GAP_SEC && first.start <= second.end + DUPLICATE_OVERLAP_SEC
}

function chooseDuplicateChunk(first: TranscriptionChunk, second: TranscriptionChunk): TranscriptionChunk {
  const firstDuration = first.end - first.start
  const secondDuration = second.end - second.start
  if (secondDuration <= firstDuration) {
    return second
  }
  return first
}

export function normalizeTranscriptionChunks(raw: unknown, offset = 0): TranscriptionChunk[] {
  if (typeof raw !== 'object' || raw == null || !('chunks' in raw) || !Array.isArray(raw.chunks)) {
    return []
  }

  const chunks: TranscriptionChunk[] = []
  for (const chunk of raw.chunks) {
    if (typeof chunk !== 'object' || chunk == null || !('text' in chunk) || !('timestamp' in chunk)) {
      continue
    }
    if (typeof chunk.text !== 'string' || !Array.isArray(chunk.timestamp)) {
      continue
    }

    const text = chunk.text.trim()
    const rawStart = chunk.timestamp[0]
    const rawEnd = chunk.timestamp[1]
    if (text.length === 0 || typeof rawStart !== 'number' || typeof rawEnd !== 'number') {
      continue
    }

    const start = rawStart + offset
    const end = rawEnd + offset
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue
    }

    const clampedStart = Math.max(0, start)
    chunks.push({
      text,
      start: clampedStart,
      end: Math.max(clampedStart, end)
    })
  }

  chunks.sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text))

  const deduped: TranscriptionChunk[] = []
  for (const chunk of chunks) {
    const previous = deduped[deduped.length - 1]
    if (previous && normalizeChunkText(previous.text) === normalizeChunkText(chunk.text) && chunksOverlapOrTouch(previous, chunk)) {
      deduped[deduped.length - 1] = chooseDuplicateChunk(previous, chunk)
    } else {
      deduped.push(chunk)
    }
  }

  return deduped
}

type WorkerRequest =
  | {
      type: 'load' | 'transcribe'
      requestId?: string
      data?: {
        model?: string
        audio?: Float32Array
      }
    }
  | {
      type: 'cancel'
      requestIds: string[]
    }

let activeLoadRequestId: string | null = null
let activeTranscribeRequestId: string | null = null

function isStaleLoad(requestId?: string): boolean {
  return requestId != null && activeLoadRequestId !== requestId
}

function isStaleTranscription(requestId?: string): boolean {
  return requestId != null && activeTranscribeRequestId !== requestId
}

function postWorkerMessage(message: Record<string, unknown>, requestId?: string): void {
  self.postMessage(requestId ? { ...message, requestId } : message)
}


function getDtypeConfig(modelName: string, webgpu: boolean) {
  const isLarge = modelName.includes('large-v3') || modelName.includes('distil-large')
  if (webgpu && isLarge) {
    return { encoder_model: 'q4f16' as const, decoder_model_merged: 'q4f16' as const }
  }
  if (webgpu) {
    return { encoder_model: 'fp16' as const, decoder_model_merged: 'q4' as const }
  }
  return { encoder_model: 'fp32' as const, decoder_model_merged: 'q4' as const }
}

class PipelineFactory {
  static instance: any = null
  static currentModel: string | null = null
  static device: 'webgpu' | 'wasm' = 'wasm'

  static async getInstance(model?: string, progressCallback?: (progress: any) => void) {
    const targetModel = model || DEFAULT_WHISPER_MODEL

    if (this.instance && this.currentModel !== targetModel) {
      try { await this.instance.dispose?.() } catch {}
      this.instance = null
      this.currentModel = null
    }

    if (!this.instance) {
      const detectedDevice = await detectWhisperDevice()
      const webgpu = detectedDevice === WHISPER_DEVICE.WEBGPU
      if (!webgpu && targetModel === LARGE_WHISPER_MODEL) {
        throw new Error('Whisper Large requires WebGPU. Choose Whisper Base for WASM on CPU.')
      }

      this.device = detectedDevice
      try {
        this.instance = await pipeline(
          'automatic-speech-recognition',
          targetModel,
          {
            dtype: getDtypeConfig(targetModel, webgpu) as any,
            device: this.device,
            progress_callback: progressCallback
          }
        )
        this.currentModel = targetModel
      } catch (error) {
        this.instance = null
        this.currentModel = null
        throw error
      }
    }
    return this.instance
  }
}

class VadFactory {
  static instance: any = null

  static async getInstance(progressCallback?: (progress: any) => void) {
    if (!this.instance) {
      this.instance = await AutoModel.from_pretrained('onnx-community/silero-vad', {
        config: { model_type: 'custom' } as any,
        dtype: 'fp32',
        progress_callback: progressCallback
      })
    }
    return this.instance
  }
}

/**
 * Run Silero VAD over the full audio buffer and return merged speech intervals
 * (in seconds). Uses hysteresis (SPEECH_THRESHOLD to enter, EXIT_THRESHOLD to exit)
 * and merges intervals separated by less than MIN_SILENCE_DURATION_MS so that
 * natural breath pauses inside a sentence don't fragment speech.
 */
async function runVad(audio: Float32Array): Promise<SpeechInterval[]> {
  const vad = await VadFactory.getInstance()
  const sr = new Tensor('int64', [SAMPLE_RATE], [])
  let state = new Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])

  const probs: number[] = []
  for (let offset = 0; offset + VAD_WINDOW_SIZE <= audio.length; offset += VAD_WINDOW_SIZE) {
    const slice = audio.subarray(offset, offset + VAD_WINDOW_SIZE)
    const input = new Tensor('float32', slice, [1, VAD_WINDOW_SIZE])
    const { stateN, output } = await vad({ input, sr, state })
    state = stateN
    probs.push(output.data[0])
  }

  const windowSec = VAD_WINDOW_SIZE / SAMPLE_RATE
  const intervals: SpeechInterval[] = []
  let inSpeech = false
  let speechStart = 0
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]
    const t = i * windowSec
    if (!inSpeech && p > SPEECH_THRESHOLD) {
      inSpeech = true
      speechStart = t
    } else if (inSpeech && p < EXIT_THRESHOLD) {
      inSpeech = false
      intervals.push({ start: speechStart, end: t })
    }
  }
  if (inSpeech) {
    intervals.push({ start: speechStart, end: probs.length * windowSec })
  }

  const minSilenceSec = MIN_SILENCE_DURATION_MS / 1000
  const merged: SpeechInterval[] = []
  for (const iv of intervals) {
    if (merged.length && iv.start - merged[merged.length - 1].end < minSilenceSec) {
      merged[merged.length - 1].end = iv.end
    } else {
      merged.push({ ...iv })
    }
  }
  return merged
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  if (e.data.type === 'cancel') {
    if (activeLoadRequestId && e.data.requestIds.includes(activeLoadRequestId)) {
      activeLoadRequestId = null
    }
    if (activeTranscribeRequestId && e.data.requestIds.includes(activeTranscribeRequestId)) {
      activeTranscribeRequestId = null
    }
    return
  }

  const { type, data, requestId } = e.data

  switch (type) {
    case 'load': {
      activeLoadRequestId = requestId ?? null
      postWorkerMessage({ type: 'status', status: 'loading' }, requestId)
      try {
        await PipelineFactory.getInstance(data?.model, (progress) => {
          if (!isStaleLoad(requestId)) {
            postWorkerMessage({ type: 'progress', progress }, requestId)
          }
        })
        if (isStaleLoad(requestId)) {
          postWorkerMessage({ type: 'status', status: 'cancelled', error: 'Model load superseded' }, requestId)
          break
        }
        // Warm VAD in parallel — tiny model, no user-visible progress needed
        VadFactory.getInstance().catch(() => {})
        postWorkerMessage({ type: 'status', status: 'ready', device: PipelineFactory.device }, requestId)
      } catch (error) {
        if (!isStaleLoad(requestId)) {
          postWorkerMessage({ type: 'status', status: 'error', error: String(error) }, requestId)
        }
      }
      break
    }
    case 'transcribe': {
      activeTranscribeRequestId = requestId ?? null
      postWorkerMessage({ type: 'status', status: 'transcribing' }, requestId)
      try {
        const transcriber = await PipelineFactory.getInstance(data?.model)
        if (isStaleTranscription(requestId)) {
          postWorkerMessage({ type: 'status', status: 'cancelled', error: 'Transcription superseded' }, requestId)
          break
        }
        const audio = data?.audio as Float32Array
        const MIN_GAP_SEC = 3.0
        const RESEG_SEC = 12   // max segment size for gap re-transcription
        const PAD_SEC = 0.5    // silence padding prepended for better alignment
        const PAD_SAMPLES = Math.floor(PAD_SEC * SAMPLE_RATE)

        /** Parse raw Whisper chunks: null-safe, offset timestamps, timestamp validation, and duplicate cleanup */
        const parseChunks = (raw: unknown, offset = 0): TranscriptionChunk[] => normalizeTranscriptionChunks(raw, offset)

        /** Find gaps > MIN_GAP_SEC in sorted word chunks */
        const findGaps = (chunks: Array<{ start: number; end: number }>, totalDuration: number) => {
          const gaps: Array<{ start: number; end: number }> = []
          if (chunks.length > 0 && chunks[0].start > MIN_GAP_SEC) {
            gaps.push({ start: 0, end: chunks[0].start })
          }
          for (let i = 0; i < chunks.length - 1; i++) {
            if (chunks[i + 1].start - chunks[i].end > MIN_GAP_SEC) {
              gaps.push({ start: chunks[i].end, end: chunks[i + 1].start })
            }
          }
          if (chunks.length > 0 && totalDuration - chunks[chunks.length - 1].end > MIN_GAP_SEC) {
            gaps.push({ start: chunks[chunks.length - 1].end, end: totalDuration })
          }
          return gaps
        }

        /**
         * Re-transcribe a gap by splitting into small independent segments
         * with silence padding. If one segment hallucinates, only ~12s is lost
         * instead of the entire gap.
         */
        const retranscribeGap = async (gapStart: number, gapEnd: number) => {
          const recovered: TranscriptionChunk[] = []
          const gapDuration = gapEnd - gapStart
          const numSegs = Math.ceil(gapDuration / RESEG_SEC)

          for (let s = 0; s < numSegs; s++) {
            if (isStaleTranscription(requestId)) break
            const segStart = gapStart + s * RESEG_SEC
            const segEnd = Math.min(gapStart + (s + 1) * RESEG_SEC, gapEnd)
            const startSample = Math.floor(segStart * SAMPLE_RATE)
            const endSample = Math.min(Math.floor(segEnd * SAMPLE_RATE), audio.length)
            if (endSample - startSample < SAMPLE_RATE * 0.5) continue

            const rawSlice = audio.slice(startSample, endSample)
            const padded = new Float32Array(PAD_SAMPLES + rawSlice.length)
            padded.set(rawSlice, PAD_SAMPLES)

            const segResult = await transcriber(padded, getWhisperAsrOptions(PipelineFactory.currentModel ?? DEFAULT_WHISPER_MODEL))
            if (isStaleTranscription(requestId)) break
            const segChunks = parseChunks(segResult, segStart - PAD_SEC)
              .filter((c: { start: number }) => c.start >= Math.max(0, segStart - 0.2))
            recovered.push(...segChunks)
          }
          return recovered
        }

        // Initial transcription
        const result = await transcriber(audio, getWhisperAsrOptions(PipelineFactory.currentModel ?? DEFAULT_WHISPER_MODEL))
        if (isStaleTranscription(requestId)) {
          postWorkerMessage({ type: 'status', status: 'cancelled', error: 'Transcription superseded' }, requestId)
          break
        }
        let wordChunks: TranscriptionChunk[] = parseChunks(result)

        // Detect and re-transcribe gaps
        const audioDuration = audio.length / SAMPLE_RATE
        for (let pass = 0; pass < 2; pass++) {
          const gaps = findGaps(wordChunks, audioDuration)
          if (gaps.length === 0) break
          for (const gap of gaps) {
            if (isStaleTranscription(requestId)) break
            wordChunks.push(...await retranscribeGap(gap.start, gap.end))
          }
          if (isStaleTranscription(requestId)) break
          wordChunks = normalizeTranscriptionChunks({ chunks: wordChunks.map((chunk) => ({ text: chunk.text, timestamp: [chunk.start, chunk.end] })) })
        }

        // Run VAD in parallel with transcription post-processing when possible.
        // VAD is carried-state sequential so we await it here.
        let speechIntervals: SpeechInterval[] = []
        try {
          if (!isStaleTranscription(requestId)) {
            speechIntervals = await runVad(audio)
          }
        } catch (vadErr) {
          // Non-fatal: marker detection falls back to pre-VAD behavior
          console.warn('VAD failed, continuing without speech intervals', vadErr)
        }

        if (isStaleTranscription(requestId)) {
          postWorkerMessage({ type: 'status', status: 'cancelled', error: 'Transcription superseded' }, requestId)
          break
        }
        postWorkerMessage({ type: 'result', chunks: wordChunks, speechIntervals }, requestId)
        postWorkerMessage({ type: 'status', status: 'done' }, requestId)
      } catch (error) {
        if (!isStaleTranscription(requestId)) {
          postWorkerMessage({ type: 'status', status: 'error', error: String(error) }, requestId)
        }
      }
      break
    }
  }
}
