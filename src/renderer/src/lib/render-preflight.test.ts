import { describe, expect, it, vi } from 'vitest'
import type { Clip } from '../store'
import { findKnownClipPreflightIssues, runRenderClipPreflight } from './render-preflight'

function createClip(id: string, path: string, duration = 4, missing = false): Clip {
  return {
    id,
    path,
    name: path.split('/').pop() || id,
    duration,
    missing
  }
}

describe('render clip preflight', () => {
  it('blocks known missing and invalid clips before checking the filesystem', async () => {
    const clips = [
      createClip('hook', '/clips/hook.mp4', 4, true),
      createClip('meat', '/clips/meat.mp4', 0),
      createClip('cta', '/clips/cta.mp4')
    ]
    const checkPathsExist = vi.fn(async (_paths: string[]) => ({ missing: [] as string[] }))

    const result = await runRenderClipPreflight(clips, checkPathsExist)

    expect(result).toMatchObject({
      ok: false,
      issues: [
        { clip: { id: 'hook' }, kind: 'missing' },
        { clip: { id: 'meat' }, kind: 'invalid' }
      ]
    })
    expect(checkPathsExist).not.toHaveBeenCalled()
    expect(findKnownClipPreflightIssues(clips).map((issue) => issue.message)).toEqual([
      expect.stringContaining('Relink or remove'),
      expect.stringContaining('Remove this card, then re-export')
    ])
  })

  it('blocks a source that disappears after import and preserves valid paths', async () => {
    const clips = [
      createClip('hook', '/clips/hook.mp4'),
      createClip('meat', '/clips/meat.mp4'),
      createClip('cta', '/clips/cta.mp4')
    ]
    const checkPathsExist = vi.fn(async (_paths: string[]) => ({
      missing: ['/clips/meat.mp4']
    }))

    const result = await runRenderClipPreflight(clips, checkPathsExist)

    expect(checkPathsExist).toHaveBeenCalledWith([
      '/clips/cta.mp4',
      '/clips/hook.mp4',
      '/clips/meat.mp4'
    ])
    expect(result).toMatchObject({
      ok: false,
      issues: [{ clip: { id: 'meat' }, kind: 'missing' }]
    })
  })
})
