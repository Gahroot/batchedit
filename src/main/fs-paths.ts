import { access, stat } from 'fs/promises'
import { constants } from 'fs'
import type { SourceFileSignaturesResult } from '../shared/types'

/**
 * Returns the subset of `paths` that do not exist (or are not readable) on disk.
 *
 * Used to detect clips and image overlays that moved or were renamed after a
 * project was saved, so the renderer can flag them before rendering.
 * Duplicate inputs are checked once; the returned list preserves the first
 * occurrence order of the missing paths.
 */
export async function findMissingPaths(paths: readonly string[]): Promise<string[]> {
  const unique = Array.from(new Set(paths))
  const results = await Promise.all(
    unique.map(async (path) => {
      try {
        await access(path, constants.R_OK)
        return { path, exists: true }
      } catch {
        return { path, exists: false }
      }
    })
  )
  return results.filter((r) => !r.exists).map((r) => r.path)
}

/**
 * Returns source identity data used to invalidate renderer transcript cache entries.
 * Duplicate inputs are statted once and results preserve first-occurrence order.
 */
export async function getSourceFileSignatures(
  paths: readonly string[]
): Promise<SourceFileSignaturesResult> {
  const uniquePaths = Array.from(new Set(paths))
  const results = await Promise.all(
    uniquePaths.map(async (path) => {
      try {
        const sourceStat = await stat(path)
        return {
          available: true as const,
          signature: { path, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs }
        }
      } catch {
        return { available: false as const, path }
      }
    })
  )

  return {
    signatures: results.flatMap((result) => (result.available ? [result.signature] : [])),
    unavailable: results.flatMap((result) => (result.available ? [] : [result.path]))
  }
}
