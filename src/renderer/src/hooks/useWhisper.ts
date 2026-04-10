import { useState, useRef, useCallback, useEffect } from 'react'

export interface WhisperChunk {
  text: string
  start: number // seconds
  end: number   // seconds
}

export interface SpeechInterval {
  start: number
  end: number
}

export interface TranscribeResult {
  chunks: WhisperChunk[]
  speechIntervals: SpeechInterval[]
}

export function useWhisper() {
  const workerRef = useRef<Worker | null>(null)
  const [isModelLoading, setIsModelLoading] = useState(false)
  const [isModelReady, setIsModelReady] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [loadProgress, setLoadProgress] = useState(0)
  const loadedModelRef = useRef<string | null>(null)

  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../workers/whisper.worker.ts', import.meta.url),
      { type: 'module' }
    )
    return () => {
      workerRef.current?.terminate()
    }
  }, [])

  const loadModel = useCallback((model?: string) => {
    return new Promise<void>((resolve, reject) => {
      const worker = workerRef.current
      if (!worker) return reject(new Error('Worker not initialized'))

      // If already loaded with the same model, skip
      if (isModelReady && model && loadedModelRef.current === model) return resolve()

      setIsModelLoading(true)
      setIsModelReady(false)
      setLoadProgress(0)
      const handler = (e: MessageEvent) => {
        const msg = e.data
        if (msg.type === 'progress' && msg.progress?.progress != null) {
          setLoadProgress(Math.round(msg.progress.progress))
        }
        if (msg.type === 'status') {
          if (msg.status === 'ready') {
            setIsModelLoading(false)
            setIsModelReady(true)
            setLoadProgress(100)
            loadedModelRef.current = model || null
            worker.removeEventListener('message', handler)
            resolve()
          } else if (msg.status === 'error') {
            setIsModelLoading(false)
            worker.removeEventListener('message', handler)
            reject(new Error(msg.error))
          }
        }
      }
      worker.addEventListener('message', handler)
      worker.postMessage({ type: 'load', data: { model } })
    })
  }, [isModelReady])

  const transcribe = useCallback((audioData: Float32Array, model?: string): Promise<TranscribeResult> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current
      if (!worker) return reject(new Error('Worker not initialized'))

      setIsTranscribing(true)
      const handler = (e: MessageEvent) => {
        const msg = e.data
        if (msg.type === 'result') {
          setIsTranscribing(false)
          worker.removeEventListener('message', handler)
          resolve({ chunks: msg.chunks, speechIntervals: msg.speechIntervals || [] })
        } else if (msg.type === 'status' && msg.status === 'error') {
          setIsTranscribing(false)
          worker.removeEventListener('message', handler)
          reject(new Error(msg.error))
        }
      }
      worker.addEventListener('message', handler)
      worker.postMessage({ type: 'transcribe', data: { audio: audioData, model } })
    })
  }, [])

  return {
    loadModel,
    transcribe,
    isModelLoading,
    isModelReady,
    isTranscribing,
    loadProgress
  }
}
