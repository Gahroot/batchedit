import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trimVideo: vi.fn(async () => undefined),
  trimLeadingSilence: vi.fn(async (_sourcePath: string, outputPath: string) => ({
    outputPath,
    trimStart: 0
  })),
  trimVideoReencode: vi.fn(async (_sourcePath: string, outputPath: string) => outputPath),
  testRoot: '',
  userDataPath: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userDataPath,
    isPackaged: false
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

vi.mock('./ffmpeg', () => ({
  ffmpeg: vi.fn(),
  getVideoMetadata: vi.fn(),
  extractAudio: vi.fn(),
  trimVideo: mocks.trimVideo,
  trimVideoReencode: mocks.trimVideoReencode,
  detectLeadingSilence: vi.fn(),
  trimLeadingSilence: mocks.trimLeadingSilence,
  getEncoder: vi.fn(() => ({ encoder: 'libx264' })),
  getSoftwareEncoder: vi.fn(() => ({ encoder: 'libx264' })),
  isGpuSessionError: vi.fn(() => false)
}))

import { setupRenderPipeline } from './render-pipeline'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler
}

describe('generated media render handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.trimVideo.mockClear()
    mocks.trimLeadingSilence.mockClear()
    mocks.trimVideoReencode.mockClear()
    mocks.testRoot = mkdtempSync(join(tmpdir(), 'batchedit-generated-handlers-'))
    mocks.userDataPath = join(mocks.testRoot, 'user-data')
    setupRenderPipeline()
  })

  afterEach(() => {
    rmSync(mocks.testRoot, { recursive: true, force: true })
  })

  it('routes default Smart Splitter, silence-trim, and Clip Editor outputs under userData', async () => {
    const sourcePath = join(tmpdir(), 'source.mp4')
    await getHandler('ffmpeg:splitVideo')(
      { sender: { send: vi.fn() } },
      sourcePath,
      [{ label: 'Hook 1', bucket: 'hook', startTime: 0, endTime: 1 }],
      null
    )
    await getHandler('ffmpeg:trimLeadingSilence')({}, sourcePath)
    await getHandler('ffmpeg:trimVideoReencode')({}, sourcePath, null, 0, 1)

    expect(mocks.trimVideo).toHaveBeenCalledWith(
      sourcePath,
      expect.stringContaining(join(mocks.userDataPath, 'media', 'smart-split')),
      0,
      1
    )
    expect(mocks.trimLeadingSilence).toHaveBeenCalledWith(
      sourcePath,
      expect.stringContaining(join(mocks.userDataPath, 'media', 'silence-trim'))
    )
    expect(mocks.trimVideoReencode).toHaveBeenCalledWith(
      sourcePath,
      expect.stringContaining(join(mocks.userDataPath, 'media', 'clip-editor')),
      0,
      1
    )
  })

  it('keeps generated output in a folder explicitly selected by the user', async () => {
    const sourcePath = join(tmpdir(), 'source.mp4')
    const selectedDirectory = join(mocks.testRoot, 'selected-output')

    await getHandler('ffmpeg:splitVideo')(
      { sender: { send: vi.fn() } },
      sourcePath,
      [{ label: 'Hook 1', bucket: 'hook', startTime: 0, endTime: 1 }],
      selectedDirectory
    )
    await getHandler('ffmpeg:trimLeadingSilence')({}, sourcePath, selectedDirectory)
    await getHandler('ffmpeg:trimVideoReencode')({}, sourcePath, selectedDirectory, 0, 1)

    expect(mocks.trimVideo).toHaveBeenCalledWith(
      sourcePath,
      expect.stringContaining(selectedDirectory),
      0,
      1
    )
    expect(mocks.trimLeadingSilence).toHaveBeenCalledWith(
      sourcePath,
      expect.stringContaining(selectedDirectory)
    )
    expect(mocks.trimVideoReencode).toHaveBeenCalledWith(
      sourcePath,
      expect.stringContaining(selectedDirectory),
      0,
      1
    )
  })
})
