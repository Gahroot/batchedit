import { useCallback, useSyncExternalStore } from 'react'
import { sharedWhisperClient } from './whisper-client'
import type { SpeechInterval, TranscribeResult, WhisperChunk } from './whisper-client'

export type { SpeechInterval, TranscribeResult, WhisperChunk }

export function useWhisper() {
  const whisperState = useSyncExternalStore(sharedWhisperClient.subscribe, sharedWhisperClient.getSnapshot)

  const loadModel = useCallback((model?: string): Promise<void> => {
    return sharedWhisperClient.loadModel(model)
  }, [])

  const transcribe = useCallback((audioData: Float32Array, model?: string): Promise<TranscribeResult> => {
    return sharedWhisperClient.transcribe(audioData, model)
  }, [])

  return {
    loadModel,
    transcribe,
    isModelLoading: whisperState.isModelLoading,
    isModelReady: whisperState.isModelReady,
    isTranscribing: whisperState.isTranscribing,
    loadProgress: whisperState.loadProgress
  }
}
