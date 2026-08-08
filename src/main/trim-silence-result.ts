import type { TrimLeadingSilenceResult } from '../shared/types'

interface SuccessfulTrim {
  outputPath: string
  trimmedSeconds: number
}

export async function captureTrimLeadingSilenceResult(
  trim: () => Promise<SuccessfulTrim>
): Promise<TrimLeadingSilenceResult> {
  try {
    const result = await trim()
    return { outcome: 'trim-success', ...result }
  } catch (error) {
    return {
      outcome: 'trim-failure',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
