/**
 * Maps engineer-grade FFmpeg/ffprobe stderr into plain-language, actionable hints
 * that a non-technical user can act on. The raw text is always preserved alongside
 * the hint so it stays available for bug reports (e.g. behind a Copy affordance).
 *
 * Shared between the main process (render-pipeline) and the renderer (RenderPanel)
 * so a failure is described identically no matter where it surfaces.
 */

export interface HumanizedError {
  /** Plain-language, actionable message shown to the user. */
  hint: string
  /** The original, unmodified FFmpeg/ffprobe text, kept for bug reports. */
  raw: string
}

interface ErrorSignature {
  /** Substrings (any match, case-insensitive) that identify this failure. */
  patterns: string[]
  /** The actionable, plain-language hint to surface. */
  hint: string
}

/**
 * Ordered most-specific → most-generic. The first signature whose patterns appear
 * in the raw text wins, so put broad catch-alls (e.g. "invalid data") last.
 */
const SIGNATURES: readonly ErrorSignature[] = [
  {
    patterns: ['no space left on device', 'enospc'],
    hint: 'Your disk is full. Free up space (or pick a different output folder) and try again.'
  },
  {
    patterns: ['no such file or directory', 'enoent', 'could not open file', 'unable to open'],
    hint: "This clip's file is missing or was moved. Re-add the clip from its current location and try again."
  },
  {
    patterns: ['permission denied', 'eacces', 'operation not permitted'],
    hint: "BatchEdit can't read this clip or write to the output folder. Check the file and folder permissions and try again."
  },
  {
    patterns: ['does not contain any stream', 'output file does not contain any stream'],
    hint: 'This clip has no usable video or audio. Re-export it from your editor and try again.'
  },
  {
    patterns: ['does not contain any image', 'no video stream', 'video stream not found'],
    hint: 'This clip has no video track. Use a clip that actually contains video.'
  },
  {
    patterns: ['stream map', 'matches no streams', 'audio stream not found', 'no audio'],
    hint: 'This clip is missing an audio track. Add audio to the clip, or use one that already has sound.'
  },
  {
    patterns: [
      'decoder not found',
      'encoder not found',
      'not found for input stream',
      'unknown codec',
      'codec not currently supported',
      'unsupported codec',
      'could not find codec parameters'
    ],
    hint: "This clip uses a video format BatchEdit can't read. Re-export it as a standard MP4 (H.264) and try again."
  },
  {
    patterns: ['moov atom not found', 'truncat', 'invalid nal', 'corrupt'],
    hint: 'This clip looks damaged or incomplete. Re-export or re-download it and try again.'
  },
  {
    patterns: ['invalid data found when processing input', 'invalid data found'],
    hint: "BatchEdit couldn't read this clip — the file may be corrupt or in an unsupported format. Re-export it as a standard MP4 (H.264) and try again."
  }
]

const GENERIC_HINT =
  "BatchEdit couldn't process this clip. Re-export it as a standard MP4 (H.264) and try again. Use Copy to grab the technical details for a bug report."

/**
 * Turn raw FFmpeg/ffprobe output into a user-facing hint, keeping the raw text.
 *
 * @param raw The error message / stderr produced by FFmpeg or ffprobe.
 * @param prefix Optional context prefix (e.g. "Normalization failed"). Applied only
 *               when a signature is matched, so generic failures read cleanly.
 */
export function humanizeFfmpegError(raw: string, prefix?: string): HumanizedError {
  const text = (raw ?? '').toString()
  const haystack = text.toLowerCase()

  for (const signature of SIGNATURES) {
    if (signature.patterns.some((p) => haystack.includes(p))) {
      const hint = prefix ? `${prefix}: ${signature.hint}` : signature.hint
      return { hint, raw: text }
    }
  }

  return { hint: GENERIC_HINT, raw: text }
}
