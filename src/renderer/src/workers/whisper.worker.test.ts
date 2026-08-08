import { describe, expect, it, vi } from 'vitest'

import { LARGE_WHISPER_MODEL } from '../lib/whisper-config'
import { getWhisperAsrOptions, normalizeTranscriptionChunks } from './whisper.worker'

describe('getWhisperAsrOptions', () => {
  it('uses shared deterministic transcription options without language for multilingual models', () => {
    expect(getWhisperAsrOptions('onnx-community/whisper-large-v3-turbo_timestamped')).toEqual({
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      do_sample: false,
      num_beams: 1
    })
  })

  it('pins English only for .en whisper models', () => {
    expect(getWhisperAsrOptions('Xenova/whisper-tiny.en')).toEqual({
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      do_sample: false,
      num_beams: 1,
      language: 'english'
    })
  })
})

describe('Whisper worker device boundary', () => {
  it('rejects Whisper Large on WASM before starting a model download', async () => {
    const originalGpuDescriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu')
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined })
    const postMessage = vi.spyOn(self, 'postMessage').mockImplementation(() => undefined)

    try {
      const messageHandler = self.onmessage
      if (!messageHandler) throw new Error('Whisper worker message handler was not registered')

      await messageHandler.call(
        self,
        new MessageEvent('message', {
          data: {
            type: 'load',
            requestId: 'large-on-wasm',
            data: { model: LARGE_WHISPER_MODEL }
          }
        })
      )

      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'status',
          status: 'error',
          requestId: 'large-on-wasm',
          error: expect.stringContaining('requires WebGPU')
        })
      )
    } finally {
      postMessage.mockRestore()
      if (originalGpuDescriptor) {
        Object.defineProperty(navigator, 'gpu', originalGpuDescriptor)
      } else {
        Reflect.deleteProperty(navigator, 'gpu')
      }
    }
  })
})

describe('normalizeTranscriptionChunks', () => {
  it('validates finite timestamps and clamps invalid ranges without dropping long words', () => {
    expect(
      normalizeTranscriptionChunks({
        chunks: [
          { text: ' keep ', timestamp: [-0.25, 0.5] },
          { text: 'long', timestamp: [1, 4.25] },
          { text: 'flip', timestamp: [5, 4.5] },
          { text: 'bad-start', timestamp: [Number.NaN, 6] },
          { text: 'bad-end', timestamp: [6, Number.POSITIVE_INFINITY] }
        ]
      })
    ).toEqual([
      { text: 'keep', start: 0, end: 0.5 },
      { text: 'long', start: 1, end: 4.25 },
      { text: 'flip', start: 5, end: 5 }
    ])
  })

  it('applies offsets before clamping timestamps', () => {
    expect(
      normalizeTranscriptionChunks(
        {
          chunks: [{ text: 'word', timestamp: [0.1, 0.4] }]
        },
        -0.5
      )
    ).toEqual([{ text: 'word', start: 0, end: 0 }])
  })

  it('sorts chunks and removes near-duplicate overlapping words', () => {
    expect(
      normalizeTranscriptionChunks({
        chunks: [
          { text: 'next', timestamp: [1.1, 1.3] },
          { text: 'Hello!', timestamp: [0.02, 0.34] },
          { text: 'hello', timestamp: [0, 0.3] },
          { text: 'hello', timestamp: [0.7, 0.9] }
        ]
      })
    ).toEqual([
      { text: 'hello', start: 0, end: 0.3 },
      { text: 'hello', start: 0.7, end: 0.9 },
      { text: 'next', start: 1.1, end: 1.3 }
    ])
  })
})
