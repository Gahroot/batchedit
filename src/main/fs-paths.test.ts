import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { findMissingPaths, getSourceFileSignatures } from './fs-paths'

describe('findMissingPaths', () => {
  let dir: string
  let existing: string
  let existingOverlay: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'batchedit-fspaths-'))
    existing = join(dir, 'clip.mp4')
    existingOverlay = join(dir, 'proof.png')
    await writeFile(existing, 'data', 'utf-8')
    await writeFile(existingOverlay, 'image data', 'utf-8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list when all paths exist', async () => {
    expect(await findMissingPaths([existing])).toEqual([])
  })

  it('returns only missing clip and image-overlay dependencies', async () => {
    const missingClip = join(dir, 'moved.mp4')
    const missingOverlay = join(dir, 'moved-proof.png')
    expect(
      await findMissingPaths([existing, missingClip, existingOverlay, missingOverlay])
    ).toEqual([missingClip, missingOverlay])
  })

  it('reports all missing paths when none exist', async () => {
    const a = join(dir, 'a.mp4')
    const b = join(dir, 'b.mp4')
    expect(await findMissingPaths([a, b])).toEqual([a, b])
  })

  it('deduplicates repeated paths', async () => {
    const missing = join(dir, 'dup.mp4')
    expect(await findMissingPaths([missing, missing, existing])).toEqual([missing])
  })

  it('handles an empty input', async () => {
    expect(await findMissingPaths([])).toEqual([])
  })

  it('returns stable size and modification identities for transcript cache freshness', async () => {
    const missing = join(dir, 'missing.mp4')
    const result = await getSourceFileSignatures([existing, existing, missing])

    expect(result.unavailable).toEqual([missing])
    expect(result.signatures).toHaveLength(1)
    expect(result.signatures[0]).toMatchObject({ path: existing, size: 4 })
    expect(result.signatures[0]?.mtimeMs).toBeGreaterThan(0)
  })
})
