import type { Clip } from './store'

export type ClipImportOutcome =
  | { kind: 'metadata-failure'; sourcePath: string; error: unknown }
  | { kind: 'trim-success'; clip: Clip; trimmedSeconds: number }
  | { kind: 'trim-fallback'; clip: Clip }
  | { kind: 'added-original'; clip: Clip }
  | { kind: 'cancelled'; sourcePath: string }

export interface ClipImportSummary {
  title: string
  description: string
  tone: 'success' | 'warning' | 'error'
}

export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || 'Unknown'
}

export function importedClipFromOutcome(outcome: ClipImportOutcome): Clip | null {
  switch (outcome.kind) {
    case 'trim-success':
    case 'trim-fallback':
    case 'added-original':
      return outcome.clip
    default:
      return null
  }
}

export function summarizeClipImports(outcomes: readonly ClipImportOutcome[]): ClipImportSummary {
  let trimmed = 0
  let noSilenceRemoved = 0
  let untrimmedByChoice = 0
  let addedWithoutTrimming = 0
  let rejected = 0
  let cancelled = 0

  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'trim-success':
        if (outcome.trimmedSeconds > 0) trimmed++
        else noSilenceRemoved++
        break
      case 'trim-fallback':
        untrimmedByChoice++
        break
      case 'added-original':
        addedWithoutTrimming++
        break
      case 'metadata-failure':
        rejected++
        break
      case 'cancelled':
        cancelled++
        break
    }
  }

  const added = trimmed + noSilenceRemoved + untrimmedByChoice + addedWithoutTrimming
  const details = [
    trimmed > 0 ? `Trimmed: ${trimmed}` : null,
    noSilenceRemoved > 0 ? `No silence removed: ${noSilenceRemoved}` : null,
    untrimmedByChoice > 0 ? `Untrimmed by choice: ${untrimmedByChoice}` : null,
    addedWithoutTrimming > 0 ? `Added without trimming: ${addedWithoutTrimming}` : null,
    rejected > 0 ? `Rejected: ${rejected}` : null,
    cancelled > 0 ? `Cancelled: ${cancelled}` : null
  ].filter((detail): detail is string => detail !== null)

  const hasIncompleteClips = untrimmedByChoice + rejected + cancelled > 0
  return {
    title: added > 0 ? `Import complete — ${added} added` : 'No clips added',
    description: details.join(' · '),
    tone: added === 0 && rejected > 0 ? 'error' : hasIncompleteClips ? 'warning' : 'success'
  }
}
