export const WHISPER_DEVICE = {
  WEBGPU: 'webgpu',
  WASM: 'wasm'
} as const

export type WhisperDevice = (typeof WHISPER_DEVICE)[keyof typeof WHISPER_DEVICE]
export type WhisperDeviceState = WhisperDevice | 'detecting'

export interface WhisperModelInfo {
  id: string
  label: string
  shortLabel: string
  approxSize: string
  requiresWebGpu: boolean
}

export const WHISPER_MODELS = [
  {
    id: 'onnx-community/whisper-tiny.en_timestamped',
    label: 'Whisper Tiny (fastest)',
    shortLabel: 'Tiny',
    approxSize: '~75 MB',
    requiresWebGpu: false
  },
  {
    id: 'onnx-community/whisper-base.en_timestamped',
    label: 'Whisper Base (recommended for CPU)',
    shortLabel: 'Base',
    approxSize: '~142 MB',
    requiresWebGpu: false
  },
  {
    id: 'onnx-community/whisper-small.en_timestamped',
    label: 'Whisper Small (recommended for WebGPU)',
    shortLabel: 'Small',
    approxSize: '~466 MB',
    requiresWebGpu: false
  },
  {
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    label: 'Whisper Large Turbo (best quality, WebGPU only)',
    shortLabel: 'Large Turbo',
    approxSize: '~1.6 GB',
    requiresWebGpu: true
  }
] as const satisfies readonly WhisperModelInfo[]

export const WASM_DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-base.en_timestamped'
export const WEBGPU_DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-small.en_timestamped'
export const LARGE_WHISPER_MODEL = 'onnx-community/whisper-large-v3-turbo_timestamped'

interface GpuApiLike {
  requestAdapter: () => Promise<unknown>
}

interface NavigatorLike {
  gpu?: GpuApiLike
}

export async function detectWhisperDevice(
  navigatorLike: NavigatorLike = navigator as NavigatorLike
): Promise<WhisperDevice> {
  if (!navigatorLike.gpu) return WHISPER_DEVICE.WASM

  try {
    const adapter = await navigatorLike.gpu.requestAdapter()
    return adapter ? WHISPER_DEVICE.WEBGPU : WHISPER_DEVICE.WASM
  } catch {
    return WHISPER_DEVICE.WASM
  }
}

export function getDefaultWhisperModel(device: WhisperDevice): string {
  return device === WHISPER_DEVICE.WEBGPU
    ? WEBGPU_DEFAULT_WHISPER_MODEL
    : WASM_DEFAULT_WHISPER_MODEL
}

export function getWhisperModelInfo(modelId: string): WhisperModelInfo {
  return (
    WHISPER_MODELS.find((model) => model.id === modelId) ??
    WHISPER_MODELS.find((model) => model.id === WASM_DEFAULT_WHISPER_MODEL) ??
    WHISPER_MODELS[0]
  )
}

export function isWhisperModelSupported(modelId: string, device: WhisperDevice): boolean {
  const model = WHISPER_MODELS.find((candidate) => candidate.id === modelId)
  return model !== undefined && (!model.requiresWebGpu || device === WHISPER_DEVICE.WEBGPU)
}

export function resolveWhisperModel(device: WhisperDevice, preferredModel: string | null): string {
  if (preferredModel && isWhisperModelSupported(preferredModel, device)) {
    return preferredModel
  }

  return getDefaultWhisperModel(device)
}

export function getWhisperDeviceLabel(device: WhisperDeviceState): string {
  if (device === 'detecting') return 'Detecting WebGPU…'
  if (device === WHISPER_DEVICE.WEBGPU) return 'WebGPU acceleration'
  return 'WASM on CPU'
}
