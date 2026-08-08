import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderJob, RenderProgress } from './render-pipeline'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getVideoMetadata: vi.fn(),
  savedOutputs: [] as string[]
}))

function createFfmpegCommand(): Record<string, unknown> {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const command: Record<string, unknown> = {}
  command.input = () => command
  command.inputOptions = () => command
  command.outputOptions = () => command
  command.videoFilters = () => command
  command.on = (event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(event, handler)
    return command
  }
  command.save = (outputPath: string) => {
    mocks.savedOutputs.push(outputPath)
    handlers.get('start')?.('ffmpeg concat')
    handlers.get('progress')?.({ percent: 100 })
    handlers.get('end')?.()
    return command
  }
  command.kill = () => command
  return command
}

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app'
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))

vi.mock('./ffmpeg', () => ({
  ffmpeg: () => createFfmpegCommand(),
  getVideoMetadata: mocks.getVideoMetadata,
  extractAudio: vi.fn(),
  trimVideo: vi.fn(),
  trimVideoReencode: vi.fn(),
  detectLeadingSilence: vi.fn(),
  trimLeadingSilence: vi.fn(),
  getEncoder: () => ({ encoder: 'libx264', presetFlag: [] }),
  getSoftwareEncoder: () => ({ encoder: 'libx264', presetFlag: [] }),
  isGpuSessionError: () => false
}))

import { clearNormalizedCache, setupRenderPipeline } from './render-pipeline'

let tempDir = ''

function source(name: string): string {
  const path = join(tempDir, name)
  writeFileSync(path, name)
  return path
}

function createJob(id: string, hookPath: string, meatPath: string, ctaPath: string): RenderJob {
  return {
    id,
    hookPath,
    meatPath,
    ctaPath,
    outputPath: join(tempDir, `${id}.mp4`),
    resolution: { width: 1080, height: 1920 }
  }
}

describe('render normalization isolation', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.savedOutputs.length = 0
    mocks.getVideoMetadata.mockReset()
    tempDir = mkdtempSync(join(tmpdir(), 'batchedit-rf004-'))
    setupRenderPipeline()
  })

  afterEach(() => {
    clearNormalizedCache()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('fails only jobs that reference a corrupt source and renders unrelated jobs', async () => {
    const hookPath = source('hook.mp4')
    const corruptMeatPath = source('corrupt-meat.mp4')
    const validMeatPath = source('valid-meat.mp4')
    const ctaPath = source('cta.mp4')
    mocks.getVideoMetadata.mockImplementation(async (path: string) => {
      if (path === corruptMeatPath) throw new Error('Invalid data found when processing input')
      return {
        duration: 4,
        width: 1080,
        height: 1920,
        fps: 30,
        codec: 'h264',
        audioCodec: 'aac'
      }
    })
    const jobs = [
      createJob('uses-corrupt-source', hookPath, corruptMeatPath, ctaPath),
      createJob('all-valid-sources', hookPath, validMeatPath, ctaPath)
    ]
    const renderBatch = mocks.handlers.get('render:batch')
    if (!renderBatch) throw new Error('render:batch handler was not registered')

    const results = (await renderBatch({ sender: { send: vi.fn() } }, jobs)) as RenderProgress[]

    expect(results).toEqual([
      expect.objectContaining({
        jobId: 'uses-corrupt-source',
        status: 'error',
        error: expect.stringContaining('corrupt-meat.mp4')
      }),
      expect.objectContaining({
        jobId: 'all-valid-sources',
        status: 'done',
        percent: 100
      })
    ])
    expect(mocks.savedOutputs).toEqual([join(tempDir, 'all-valid-sources.mp4')])
  })
})
