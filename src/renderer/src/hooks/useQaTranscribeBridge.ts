import { useEffect } from 'react'
import { useStore } from '../store'
import { useWhisper } from './useWhisper'

/** Runs boundary-QA transcription requests in the renderer's Whisper pipeline. */
export function useQaTranscribeBridge(): void {
  const { loadModel, transcribe, cancel } = useWhisper()
  const whisperModel = useStore((state) => state.whisperModel)

  useEffect(() => {
    const cancelledRequestIds = new Set<string>()
    let disposed = false

    const unsubscribeCancel = window.api.qaBridge.onTranscribeCancel(({ id }) => {
      cancelledRequestIds.add(id)
      cancel()
      void window.api.cancelMediaOperation(id).catch(() => false)
    })

    const unsubscribe = window.api.qaBridge.onTranscribeRequest(async (request) => {
      const isCancelled = (): boolean => disposed || cancelledRequestIds.has(request.id)

      try {
        const model = request.payload.model ?? whisperModel
        await loadModel(model)
        if (isCancelled()) return

        const wavPath = await window.api.extractAudio(request.payload.path, request.id)
        if (isCancelled()) {
          await window.api.releaseTempFile(wavPath)
          return
        }

        const audioBuffer = await window.api.readAudioBuffer(wavPath)
        if (isCancelled()) return

        const { chunks, speechIntervals } = await transcribe(new Float32Array(audioBuffer), model)
        if (isCancelled()) return

        window.api.qaBridge.replyTranscribe(request.id, {
          words: chunks,
          full: chunks
            .map((chunk) => chunk.text)
            .join(' ')
            .trim(),
          speechIntervals
        })
      } catch (error) {
        if (isCancelled()) return
        window.api.qaBridge.replyTranscribeError(
          request.id,
          error instanceof Error ? error.message : String(error)
        )
      } finally {
        cancelledRequestIds.delete(request.id)
      }
    })

    return () => {
      disposed = true
      unsubscribe()
      unsubscribeCancel()
    }
  }, [cancel, loadModel, transcribe, whisperModel])
}
