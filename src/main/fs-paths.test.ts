import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { findMissingPaths } from './fs-paths'

describe('findMissingPaths', () => {
  let dir: string
  let existing: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'batchedit-fspaths-'))
    existing = join(dir, 'clip.mp4')
    await writeFile(existing, 'data', 'utf-8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list when all paths exist', async () => {
    expect(await findMissingPaths([existing])).toEqual([])
  })

  it('returns only the paths that do not exist', async () => {
    const missing = join(dir, 'moved.mp4')
    expect(await findMissingPaths([existing, missing])).toEqual([missing])
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
})
