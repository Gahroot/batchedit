// Whisper Web Worker — WebGPU-accelerated transcription with Silero VAD for clean clip boundaries.
// Uses @huggingface/transformers v3+.
// VAD pattern adapted from huggingface/transformers.js-examples/moonshine-web.
// WebGPU detection + dtype config pattern adapted from dmtrKovalenko/subtitler.

import { pipeline, AutoModel, Tensor } from '@huggingface/transformers'

// Silero VAD constants (from transformers.js-examples/moonshine-web/constants.js)
const SAMPLE_RATE = 16000
const SPEECH_THRESHOLD = 0.3
const EXIT_THRESHOLD = 0.1
const MIN_SILENCE_DURATION_MS = 400
const VAD_WINDOW_SIZE = 512  // required Silero VAD window at 16kHz

export interface SpeechInterval {
  start: number
  end: number
}

async function isWebGPUAvailable(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !(navigator as any).gpu) return false
  try {
    const adapter = await (navigator as any).gpu.requestAdapter()
    return adapter != null
  } catch {
    return false
  }
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
    const targetModel = model || 'onnx-community/whisper-large-v3-turbo_timestamped'

    if (this.instance && this.currentModel !== targetModel) {
      try { await this.instance.dispose?.() } catch {}
      this.instance = null
      this.currentModel = null
    }

    if (!this.instance) {
      const webgpu = await isWebGPUAvailable()
      this.device = webgpu ? 'webgpu' : 'wasm'
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

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data

  switch (type) {
    case 'load': {
      self.postMessage({ type: 'status', status: 'loading' })
      try {
        await PipelineFactory.getInstance(data?.model, (progress) => {
          self.postMessage({ type: 'progress', progress })
        })
        // Warm VAD in parallel — tiny model, no user-visible progress needed
        VadFactory.getInstance().catch(() => {})
        self.postMessage({ type: 'status', status: 'ready', device: PipelineFactory.device })
      } catch (error) {
        self.postMessage({ type: 'status', status: 'error', error: String(error) })
      }
      break
    }
    case 'transcribe': {
      self.postMessage({ type: 'status', status: 'transcribing' })
      try {
        const transcriber = await PipelineFactory.getInstance(data?.model)
        const audio = data.audio as Float32Array
        const MAX_WORD_SEC = 2.0
        const MIN_GAP_SEC = 3.0
        const RESEG_SEC = 12   // max segment size for gap re-transcription
        const PAD_SEC = 0.5    // silence padding prepended for better alignment
        const PAD_SAMPLES = Math.floor(PAD_SEC * SAMPLE_RATE)

        /** Parse raw Whisper chunks: null-safe, offset timestamps, remove hallucinated durations */
        const parseChunks = (raw: any, offset = 0) =>
          (raw.chunks || [])
            .filter((c: any) =>
              c.text?.trim().length > 0 &&
              c.timestamp?.[0] != null &&
              c.timestamp?.[1] != null &&
              (c.timestamp[1] - c.timestamp[0]) <= MAX_WORD_SEC
            )
            .map((c: any) => ({
              text: c.text.trim(),
              start: (c.timestamp[0] as number) + offset,
              end: (c.timestamp[1] as number) + offset
            }))

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
          const recovered: Array<{ text: string; start: number; end: number }> = []
          const gapDuration = gapEnd - gapStart
          const numSegs = Math.ceil(gapDuration / RESEG_SEC)

          for (let s = 0; s < numSegs; s++) {
            const segStart = gapStart + s * RESEG_SEC
            const segEnd = Math.min(gapStart + (s + 1) * RESEG_SEC, gapEnd)
            const startSample = Math.floor(segStart * SAMPLE_RATE)
            const endSample = Math.min(Math.floor(segEnd * SAMPLE_RATE), audio.length)
            if (endSample - startSample < SAMPLE_RATE * 0.5) continue

            const rawSlice = audio.slice(startSample, endSample)
            const padded = new Float32Array(PAD_SAMPLES + rawSlice.length)
            padded.set(rawSlice, PAD_SAMPLES)

            const segResult = await transcriber(padded, { return_timestamps: 'word' })
            const segChunks = parseChunks(segResult, segStart - PAD_SEC)
              .filter((c: { start: number }) => c.start >= Math.max(0, segStart - 0.2))
            recovered.push(...segChunks)
          }
          return recovered
        }

        // Initial transcription
        const result = await transcriber(audio, {
          return_timestamps: 'word',
          chunk_length_s: 30,
          stride_length_s: 5
        })
        const wordChunks: Array<{ text: string; start: number; end: number }> = parseChunks(result)
        wordChunks.sort((a, b) => a.start - b.start)

        // Detect and re-transcribe gaps
        const audioDuration = audio.length / SAMPLE_RATE
        for (let pass = 0; pass < 2; pass++) {
          const gaps = findGaps(wordChunks, audioDuration)
          if (gaps.length === 0) break
          for (const gap of gaps) {
            wordChunks.push(...await retranscribeGap(gap.start, gap.end))
          }
          wordChunks.sort((a, b) => a.start - b.start)
        }

        // Run VAD in parallel with transcription post-processing when possible.
        // VAD is carried-state sequential so we await it here.
        let speechIntervals: SpeechInterval[] = []
        try {
          speechIntervals = await runVad(audio)
        } catch (vadErr) {
          // Non-fatal: marker detection falls back to pre-VAD behavior
          console.warn('VAD failed, continuing without speech intervals', vadErr)
        }

        self.postMessage({ type: 'result', chunks: wordChunks, speechIntervals })
        self.postMessage({ type: 'status', status: 'done' })
      } catch (error) {
        self.postMessage({ type: 'status', status: 'error', error: String(error) })
      }
      break
    }
  }
}
