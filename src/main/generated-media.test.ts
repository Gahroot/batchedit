import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedMediaPath, getManagedMediaDirectory } from './generated-media'

const testDirectories: string[] = []

function makeTestDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  testDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('managed generated media', () => {
  it('survives cleanup of the OS temporary workspace', () => {
    const testRoot = makeTestDirectory('batchedit-generated-media-')
    const userDataPath = join(testRoot, 'user-data')
    const temporaryWorkspace = join(testRoot, 'os-temp')
    const sourcePath = join(temporaryWorkspace, 'source clip.mov')
    mkdirSync(temporaryWorkspace, { recursive: true })
    writeFileSync(sourcePath, 'temporary source')
    const outputPath = createManagedMediaPath({
      userDataPath,
      operation: 'smart-split',
      fileName: '01_Hook 1.mp4',
      runId: 'split-run'
    })

    writeFileSync(outputPath, 'generated clip')
    rmSync(temporaryWorkspace, { recursive: true, force: true })

    expect(outputPath).toBe(join(userDataPath, 'media', 'smart-split', 'split-run', '01_Hook_1.mp4'))
    expect(relative(getManagedMediaDirectory(userDataPath), outputPath)).not.toMatch(/^\.\./)
    expect(dirname(outputPath)).not.toBe(temporaryWorkspace)
    expect(existsSync(sourcePath)).toBe(false)
    expect(existsSync(outputPath)).toBe(true)
  })

  it('allocates separate durable paths for independent editing runs', () => {
    const userDataPath = join(makeTestDirectory('batchedit-generated-media-'), 'user-data')
    const firstPath = createManagedMediaPath({
      userDataPath,
      operation: 'clip-editor',
      fileName: 'source-edited.mp4',
      runId: 'edit-one'
    })
    const secondPath = createManagedMediaPath({
      userDataPath,
      operation: 'clip-editor',
      fileName: 'source-edited.mp4',
      runId: 'edit-two'
    })

    expect(firstPath).not.toBe(secondPath)
    expect(firstPath).toContain(join(userDataPath, 'media'))
    expect(secondPath).toContain(join(userDataPath, 'media'))
  })
})
