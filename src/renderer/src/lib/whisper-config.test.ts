import { describe, expect, it, vi } from 'vitest'
import {
  detectWhisperDevice,
  getDefaultWhisperModel,
  LARGE_WHISPER_MODEL,
  resolveWhisperModel,
  WASM_DEFAULT_WHISPER_MODEL,
  WEBGPU_DEFAULT_WHISPER_MODEL,
  WHISPER_DEVICE
} from './whisper-config'

describe('Whisper capability-based defaults', () => {
  it('uses Whisper Base when WebGPU is unavailable', async () => {
    const device = await detectWhisperDevice({})

    expect(device).toBe(WHISPER_DEVICE.WASM)
    expect(getDefaultWhisperModel(device)).toBe(WASM_DEFAULT_WHISPER_MODEL)
  })

  it('uses the balanced model after a WebGPU adapter is detected', async () => {
    const requestAdapter = vi.fn().mockResolvedValue({ name: 'test-adapter' })

    const device = await detectWhisperDevice({ gpu: { requestAdapter } })

    expect(requestAdapter).toHaveBeenCalledOnce()
    expect(device).toBe(WHISPER_DEVICE.WEBGPU)
    expect(getDefaultWhisperModel(device)).toBe(WEBGPU_DEFAULT_WHISPER_MODEL)
    expect(getDefaultWhisperModel(device)).not.toBe(LARGE_WHISPER_MODEL)
  })

  it('falls back to WASM when adapter detection fails', async () => {
    const device = await detectWhisperDevice({
      gpu: { requestAdapter: vi.fn().mockRejectedValue(new Error('adapter failed')) }
    })

    expect(device).toBe(WHISPER_DEVICE.WASM)
  })

  it('honors an explicit Large preference only on WebGPU', () => {
    expect(resolveWhisperModel(WHISPER_DEVICE.WEBGPU, LARGE_WHISPER_MODEL)).toBe(
      LARGE_WHISPER_MODEL
    )
    expect(resolveWhisperModel(WHISPER_DEVICE.WASM, LARGE_WHISPER_MODEL)).toBe(
      WASM_DEFAULT_WHISPER_MODEL
    )
  })
})
