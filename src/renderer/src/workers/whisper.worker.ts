// Whisper Web Worker — singleton pipeline + message handlers
// Uses @huggingface/transformers v3+ with WASM backend

class PipelineFactory {
  static instance: any = null

  static async getInstance(progressCallback?: (progress: any) => void) {
    if (!this.instance) {
      const { pipeline } = await import('@huggingface/transformers')
      this.instance = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/whisper-tiny.en_timestamped',
        {
          dtype: {
            encoder_model: 'fp32',
            decoder_model_merged: 'q4'
          },
          device: 'wasm',
          progress_callback: progressCallback
        }
      )
    }
    return this.instance
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data

  switch (type) {
    case 'load': {
      self.postMessage({ type: 'status', status: 'loading' })
      try {
        await PipelineFactory.getInstance((progress) => {
          self.postMessage({ type: 'progress', progress })
        })
        self.postMessage({ type: 'status', status: 'ready' })
      } catch (error) {
        self.postMessage({ type: 'status', status: 'error', error: String(error) })
      }
      break
    }
    case 'transcribe': {
      self.postMessage({ type: 'status', status: 'transcribing' })
      try {
        const transcriber = await PipelineFactory.getInstance()
        const audio = data.audio as Float32Array
        const SAMPLE_RATE = 16000
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

            // Prepend silence padding so Whisper doesn't choke on the first word
            const rawSlice = audio.slice(startSample, endSample)
            const padded = new Float32Array(PAD_SAMPLES + rawSlice.length)
            padded.set(rawSlice, PAD_SAMPLES)

            const segResult = await transcriber(padded, { return_timestamps: 'word' })
            // Offset = segStart - PAD_SEC because Whisper sees PAD_SEC of silence first
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

        // Detect and re-transcribe gaps (up to 2 passes — second pass catches
        // sub-gaps left when a single 12s segment still hallucinates)
        const audioDuration = audio.length / SAMPLE_RATE
        for (let pass = 0; pass < 2; pass++) {
          const gaps = findGaps(wordChunks, audioDuration)
          if (gaps.length === 0) break
          for (const gap of gaps) {
            wordChunks.push(...await retranscribeGap(gap.start, gap.end))
          }
          wordChunks.sort((a, b) => a.start - b.start)
        }
        self.postMessage({ type: 'result', chunks: wordChunks })
        self.postMessage({ type: 'status', status: 'done' })
      } catch (error) {
        self.postMessage({ type: 'status', status: 'error', error: String(error) })
      }
      break
    }
  }
}
