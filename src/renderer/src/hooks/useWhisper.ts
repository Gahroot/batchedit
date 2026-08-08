import { useCallback, useSyncExternalStore } from 'react'
import { sharedWhisperClient } from './whisper-client'
import type { SpeechInterval, TranscribeResult, WhisperChunk } from './whisper-client'

export type { SpeechInterval, TranscribeResult, WhisperChunk }

export interface UseWhisperResult {
  loadModel: (model?: string) => Promise<void>
  transcribe: (audioData: Float32Array, model?: string) => Promise<TranscribeResult>
  cancel: () => boolean
  isModelLoading: boolean
  isModelReady: boolean
  isTranscribing: boolean
  isBusy: boolean
  loadProgress: number
  loadingModel: string | null
  loadedModel: string | null
}

export function useWhisper(): UseWhisperResult {
  const whisperState = useSyncExternalStore(sharedWhisperClient.subscribe, sharedWhisperClient.getSnapshot)

  const loadModel = useCallback((model?: string): Promise<void> => {
    return sharedWhisperClient.loadModel(model)
  }, [])

  const transcribe = useCallback((audioData: Float32Array, model?: string): Promise<TranscribeResult> => {
    return sharedWhisperClient.transcribe(audioData, model)
  }, [])

  const cancel = useCallback((): boolean => sharedWhisperClient.cancel(), [])

  return {
    loadModel,
    transcribe,
    cancel,
    isModelLoading: whisperState.isModelLoading,
    isModelReady: whisperState.isModelReady,
    isTranscribing: whisperState.isTranscribing,
    isBusy: whisperState.isModelLoading || whisperState.isTranscribing,
    loadProgress: whisperState.loadProgress,
    loadingModel: whisperState.loadingModel,
    loadedModel: whisperState.loadedModel
  }
}
