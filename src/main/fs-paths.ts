import { access } from 'fs/promises'
import { constants } from 'fs'

/**
 * Returns the subset of `paths` that do not exist (or are not readable) on disk.
 *
 * Used to detect clips whose source files moved/renamed since a project was
 * saved, so the renderer can flag them before a render fails on a dead path.
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
