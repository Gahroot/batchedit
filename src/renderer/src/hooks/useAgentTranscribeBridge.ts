import { useEffect } from 'react'
import { useWhisper } from './useWhisper'
import { useStore } from '../store'

export function useAgentTranscribeBridge(): void {
  const { loadModel, transcribe, isModelReady } = useWhisper()
  const whisperModel = useStore((state) => state.whisperModel)

  useEffect(() => {
    return window.api.agentBridge.onTranscribeRequest(async (req) => {
      try {
        const model = req.payload.model ?? whisperModel
        if (!isModelReady) await loadModel(model)
        const wavPath = await window.api.extractAudio(req.payload.path)
        const audioBuffer = await window.api.readAudioBuffer(wavPath)
        const { chunks, speechIntervals } = await transcribe(new Float32Array(audioBuffer), model)
        window.api.agentBridge.replyTranscribe(req.id, {
          words: chunks,
          full: chunks.map((chunk) => chunk.text).join(' ').trim(),
          speechIntervals
        })
      } catch (error) {
        window.api.agentBridge.replyTranscribe(req.id, { error: error instanceof Error ? error.message : String(error) })
      }
    })
  }, [isModelReady, loadModel, transcribe, whisperModel])
}
