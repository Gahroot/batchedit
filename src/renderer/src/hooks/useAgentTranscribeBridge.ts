import { useEffect } from 'react'
import { useWhisper } from './useWhisper'
import { useStore } from '../store'

/**
 * Bridge the main-process agent's `agent:transcribe` RPC to the renderer's
 * Whisper pipeline.  Three things must be right:
 * 1. Error replies send `{ id, error }` at the top level (not nested in `result`)
 *    so the main-process `callRenderer` rejects instead of silently resolving.
 * 2. `isModelReady` must NOT be in the useEffect dependency array — it changes
 *    when the model finishes loading, which tears down the IPC listener and
 *    re-registers it, creating a window where incoming requests are dropped.
 *    `loadModel()` is idempotent (returns immediately when already loaded), so
 *    we always call it.
 * 3. A cancel listener aborts in-progress work when the main-process RPC times
 *    out, preventing wasted GPU/CPU cycles.
 */
export function useAgentTranscribeBridge(): void {
  const { loadModel, transcribe } = useWhisper()
  const whisperModel = useStore((state) => state.whisperModel)

  useEffect(() => {
    let cancelled = false

    const unsubscribeCancel = window.api.agentBridge.onTranscribeCancel(() => {
      cancelled = true
    })

    const unsubscribe = window.api.agentBridge.onTranscribeRequest(async (req) => {
      try {
        if (cancelled) return
        const model = req.payload.model ?? whisperModel
        // Always call loadModel — it resolves immediately when the model is
        // already loaded with the same key, so the guard is unnecessary and
        // removing it lets us drop `isModelReady` from the dependency array.
        await loadModel(model)
        if (cancelled) return
        const wavPath = await window.api.extractAudio(req.payload.path)
        if (cancelled) return
        const audioBuffer = await window.api.readAudioBuffer(wavPath)
        if (cancelled) return
        const { chunks, speechIntervals } = await transcribe(new Float32Array(audioBuffer), model)
        if (cancelled) return
        window.api.agentBridge.replyTranscribe(req.id, {
          words: chunks,
          full: chunks.map((chunk) => chunk.text).join(' ').trim(),
          speechIntervals
        })
      } catch (error) {
        if (cancelled) return
        // Send the error at the top level so callRenderer's `reply.error`
        // check triggers the reject path, not the resolve path.
        window.api.agentBridge.replyTranscribeError(req.id, error instanceof Error ? error.message : String(error))
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeCancel()
    }
    // `whisperModel` is the only store value the handler reads. `loadModel`,
    // `transcribe` are stable callbacks from useCallback([], ...) and never
    // change identity.  `isModelReady` is intentionally excluded — see docblock.
  }, [loadModel, transcribe, whisperModel])
}
