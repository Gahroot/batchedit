import type { Clip } from '../store'

export type ClipPreflightIssueKind = 'missing' | 'invalid'

export interface ClipPreflightIssue {
  clip: Clip
  kind: ClipPreflightIssueKind
  message: string
}

export type RenderClipPreflightResult =
  | { ok: true }
  | { ok: false; issues: ClipPreflightIssue[] }
  | { ok: false; checkError: string; detail: string }

type CheckPathsExist = (paths: string[]) => Promise<{ missing: string[] }>

export function findKnownClipPreflightIssues(clips: readonly Clip[]): ClipPreflightIssue[] {
  return clips.flatMap<ClipPreflightIssue>((clip) => {
    if (clip.missing) {
      return [
        {
          clip,
          kind: 'missing' as const,
          message: 'Source file is missing. Relink or remove this clip before rendering.'
        }
      ]
    }
    if (!clip.path.trim()) {
      return [
        {
          clip,
          kind: 'invalid' as const,
          message: 'Source path is empty. Remove this clip and add the source video again.'
        }
      ]
    }
    if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
      return [
        {
          clip,
          kind: 'invalid' as const,
          message:
            'Duration metadata is missing or invalid. Remove this card, then re-export the source and add it again.'
        }
      ]
    }
    return []
  })
}

export async function runRenderClipPreflight(
  clips: readonly Clip[],
  checkPathsExist: CheckPathsExist
): Promise<RenderClipPreflightResult> {
  const knownIssues = findKnownClipPreflightIssues(clips)
  if (knownIssues.length > 0) return { ok: false, issues: knownIssues }

  const uniquePaths = Array.from(new Set(clips.map((clip) => clip.path))).sort()
  try {
    const { missing } = await checkPathsExist(uniquePaths)
    const missingPaths = new Set(missing)
    const issues = clips.flatMap<ClipPreflightIssue>((clip) =>
      missingPaths.has(clip.path)
        ? [
            {
              clip,
              kind: 'missing' as const,
              message: 'Source file is missing. Relink or remove this clip before rendering.'
            }
          ]
        : []
    )
    return issues.length > 0 ? { ok: false, issues } : { ok: true }
  } catch (error) {
    return {
      ok: false,
      checkError:
        'BatchEdit could not verify the source files. Try Render again; if this continues, re-add the clips.',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}
