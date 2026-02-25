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
        const result = await transcriber(data.audio, {
          return_timestamps: 'word',
          chunk_length_s: 30,
          stride_length_s: 5
        })
        // result.chunks is array of { text, timestamp: [start, end] }
        const wordChunks = (result.chunks || []).map((chunk: any) => ({
          text: chunk.text.trim(),
          start: chunk.timestamp[0],  // seconds
          end: chunk.timestamp[1]     // seconds
        })).filter((c: any) => c.text.length > 0)

        self.postMessage({ type: 'result', chunks: wordChunks })
        self.postMessage({ type: 'status', status: 'done' })
      } catch (error) {
        self.postMessage({ type: 'status', status: 'error', error: String(error) })
      }
      break
    }
  }
}
