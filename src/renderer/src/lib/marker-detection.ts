import type { BucketType } from '../store'

export interface WhisperChunk {
  text: string
  start: number // seconds
  end: number   // seconds
}

export interface SpeechInterval {
  start: number
  end: number
}

/** Minimum silence before a marker phrase for it to count as a real cue (not speech-internal). */
const MARKER_LEAD_SILENCE_SEC = 0.3

/** Find the gap index between two speech intervals covering time `t`, or null. */
function silenceAfter(
  t: number,
  intervals: SpeechInterval[]
): { start: number; end: number } | null {
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i].start >= t) {
      const prevEnd = i > 0 ? intervals[i - 1].end : 0
      return { start: Math.max(prevEnd, t), end: intervals[i].start }
    }
  }
  // Past the last speech interval → silence until end
  const last = intervals[intervals.length - 1]
  if (last && t >= last.end) return { start: t, end: Infinity }
  return null
}

/** True if there is ≥ MARKER_LEAD_SILENCE_SEC of silence ending at or just before `t`. */
function hasSilenceBefore(t: number, intervals: SpeechInterval[]): boolean {
  if (intervals.length === 0) return true // no VAD info → don't gate
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i].start >= t) {
      const prevEnd = i > 0 ? intervals[i - 1].end : 0
      return t - prevEnd >= MARKER_LEAD_SILENCE_SEC
    }
  }
  return true // t is past all speech → definitely silent lead-in
}

export interface DetectedMarker {
  id: string
  label: string
  bucket: BucketType
  startTime: number // seconds
  endTime: number   // seconds
  markerChunkIndices: number[]
}

/** Strip punctuation, lowercase, trim — so "Hook," → "hook", "CTA!" → "cta" */
export function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const BUCKET_ALIASES: Record<string, BucketType> = {
  hook: 'hook',
  hooks: 'hook',
  meat: 'meat',
  meats: 'meat',
  meet: 'meat',   // homophone — Whisper confuses these constantly
  meets: 'meat',
  body: 'meat',
  bodies: 'meat',
  middle: 'meat',
  cta: 'cta',
  ctas: 'cta',
  calltoaction: 'cta', // "call-to-action" after normalize strips hyphens
  closer: 'cta',
  close: 'cta',
  outro: 'cta',
  outros: 'cta'
}

/**
 * Multi-word sequences that resolve to a bucket type.
 * Sorted longest-first so greedy matching picks the best pattern.
 * All words are already normalized (lowercase, no punctuation).
 */
const MULTI_WORD_BUCKET: Array<{ words: string[]; bucket: BucketType }> = [
  // "call to action"
  { words: ['call', 'to', 'action'], bucket: 'cta' },

  // CTA spelled out — exact letters
  { words: ['c', 't', 'a'], bucket: 'cta' },

  // CTA spelled out — phonetic variants Whisper-tiny produces
  { words: ['see', 'tea', 'a'], bucket: 'cta' },
  { words: ['see', 'tee', 'a'], bucket: 'cta' },
  { words: ['see', 'tea', 'ay'], bucket: 'cta' },
  { words: ['see', 'tee', 'ay'], bucket: 'cta' },
  { words: ['sea', 'tea', 'a'], bucket: 'cta' },
  { words: ['sea', 'tee', 'a'], bucket: 'cta' },
  { words: ['sea', 'tea', 'ay'], bucket: 'cta' },
  { words: ['sea', 'tee', 'ay'], bucket: 'cta' },
  { words: ['si', 'ti', 'ay'], bucket: 'cta' },
  { words: ['si', 'ti', 'a'], bucket: 'cta' },

  // 2-word CTA splits Whisper sometimes produces
  { words: ['ct', 'a'], bucket: 'cta' },
  { words: ['c', 'ta'], bucket: 'cta' },
  { words: ['see', 'ta'], bucket: 'cta' },
  { words: ['sea', 'ta'], bucket: 'cta' }
].sort((a, b) => b.words.length - a.words.length) // longest first

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

export function matchBucketSingle(normalized: string): BucketType | null {
  if (!normalized) return null
  if (BUCKET_ALIASES[normalized]) return BUCKET_ALIASES[normalized]
  // Fuzzy: edit distance 1 for aliases with >= 3 chars
  for (const alias of Object.keys(BUCKET_ALIASES)) {
    if (alias.length >= 3 && editDistance(normalized, alias) <= 1) {
      return BUCKET_ALIASES[alias]
    }
  }
  return null
}

export function parseNumber(normalized: string): number | null {
  if (!normalized) return null
  if (NUMBER_WORDS[normalized] !== undefined) return NUMBER_WORDS[normalized]
  const num = parseInt(normalized, 10)
  if (!isNaN(num) && num >= 1 && num <= 99) return num
  // Fuzzy: edit distance 1 for number words >= 3 chars
  for (const word of Object.keys(NUMBER_WORDS)) {
    if (word.length >= 3 && editDistance(normalized, word) <= 1) {
      return NUMBER_WORDS[word]
    }
  }
  return null
}

/**
 * Try to split a single normalized token into bucket + number.
 * Handles Whisper merging them: "cta2", "hook1", "meettwo", "bodyThree", etc.
 */
function matchFused(normalized: string): { bucket: BucketType; num: number } | null {
  if (!normalized || normalized.length < 2) return null

  // Collect all alias keys sorted longest-first so "calltoaction" matches before "call"
  const aliases = Object.keys(BUCKET_ALIASES).sort((a, b) => b.length - a.length)

  for (const alias of aliases) {
    if (normalized.startsWith(alias) && normalized.length > alias.length) {
      const remainder = normalized.slice(alias.length)
      const num = parseNumber(remainder)
      if (num !== null) {
        return { bucket: BUCKET_ALIASES[alias], num }
      }
    }
  }
  return null
}

/** Try multi-word bucket patterns starting at index i. Returns match or null. */
function matchBucketMulti(
  normed: string[],
  startIdx: number
): { bucket: BucketType; wordsConsumed: number } | null {
  for (const pattern of MULTI_WORD_BUCKET) {
    const end = startIdx + pattern.words.length
    if (end > normed.length) continue
    let match = true
    for (let j = 0; j < pattern.words.length; j++) {
      if (normed[startIdx + j] !== pattern.words[j]) {
        match = false
        break
      }
    }
    if (match) {
      return { bucket: pattern.bucket, wordsConsumed: pattern.words.length }
    }
  }
  return null
}

const MIN_CLIP_SEC = 0.5

/** Compute start/end times for markers based on content words and VAD silence. */
function computeTimings(
  markers: DetectedMarker[],
  wordChunks: WhisperChunk[],
  used: Set<number>,
  videoDuration: number,
  speechIntervals: SpeechInterval[]
): void {
  for (let i = 0; i < markers.length; i++) {
    const markerIndices = markers[i].markerChunkIndices
    const hasMarkerWords = markerIndices.length > 0
    const lastMarkerIdx = hasMarkerWords ? markerIndices[markerIndices.length - 1] : -1
    const nextWordIdx = lastMarkerIdx + 1

    // Start: first non-marker word after the marker phrase
    if (hasMarkerWords) {
      markers[i].startTime = nextWordIdx < wordChunks.length
        ? wordChunks[nextWordIdx].start
        : wordChunks[lastMarkerIdx].end
    }

    // Next marker boundary (where the following clip's marker begins)
    const boundaryIdx = i + 1 < markers.length && markers[i + 1].markerChunkIndices.length > 0
      ? markers[i + 1].markerChunkIndices[0]
      : wordChunks.length

    // Find last content word before the next marker
    let lastContentEnd = markers[i].startTime
    for (let j = boundaryIdx - 1; j >= nextWordIdx; j--) {
      if (!used.has(j)) {
        lastContentEnd = wordChunks[j].end
        break
      }
    }

    const nextMarkerStart = i + 1 < markers.length && markers[i + 1].markerChunkIndices.length > 0
      ? wordChunks[markers[i + 1].markerChunkIndices[0]].start
      : videoDuration

    if (lastContentEnd > markers[i].startTime) {
      const silenceGap = nextMarkerStart - lastContentEnd
      const buffer = silenceGap > 0.5 ? 0.1 : 0.2
      markers[i].endTime = Math.min(lastContentEnd + buffer, nextMarkerStart, videoDuration)
    } else {
      markers[i].endTime = Math.min(nextMarkerStart, videoDuration)
    }

    // VAD-based boundary snapping — clamp endTime to end of last speech interval
    // before the next marker phrase, preventing the marker word and trailing
    // silence from bleeding into the clip.
    if (speechIntervals.length > 0) {
      const gap = silenceAfter(lastContentEnd, speechIntervals)
      if (gap && gap.start <= nextMarkerStart && gap.start > markers[i].startTime) {
        // Snap endTime to just after speech ends (+ small breathing buffer)
        const snapEnd = Math.min(gap.start + 0.15, nextMarkerStart, videoDuration)
        if (snapEnd > markers[i].startTime) {
          markers[i].endTime = snapEnd
        }
      }

      // Snap startTime forward past any leading silence after the marker phrase
      const startGap = silenceAfter(markers[i].startTime - 0.01, speechIntervals)
      if (startGap && startGap.end > markers[i].startTime && startGap.end < markers[i].endTime) {
        // Pull in by up to the silence end, minus small pre-roll
        markers[i].startTime = Math.max(markers[i].startTime, startGap.end - 0.05)
      }
    }
  }
}

let nextId = 1

export function detectMarkers(
  wordChunks: WhisperChunk[],
  videoDuration: number,
  speechIntervals: SpeechInterval[] = []
): DetectedMarker[] {
  const markers: DetectedMarker[] = []
  const used = new Set<number>()

  // Pre-normalize all chunk texts once
  const normed = wordChunks.map((w) => normalize(w.text))

  /**
   * Gate candidate markers: the marker phrase must be preceded by ≥300ms of
   * silence (per VAD). This kills false positives like "my hook is..." where
   * "hook" is speech-internal rather than a real cue.
   */
  const markerHasSilenceLead = (firstChunkIdx: number): boolean => {
    if (speechIntervals.length === 0) return true
    return hasSilenceBefore(wordChunks[firstChunkIdx].start, speechIntervals)
  }

  // Pass 0: fused single-token bucket+number (e.g. "cta2", "hook1", "meettwo")
  for (let i = 0; i < wordChunks.length; i++) {
    if (used.has(i)) continue
    if (!normed[i]) continue

    const fused = matchFused(normed[i])
    if (!fused) continue
    if (!markerHasSilenceLead(i)) continue

    const bucketLabel = fused.bucket === 'cta'
      ? 'CTA'
      : fused.bucket.charAt(0).toUpperCase() + fused.bucket.slice(1)

    markers.push({
      id: `marker-${nextId++}`,
      label: `${bucketLabel} ${fused.num}`,
      bucket: fused.bucket,
      startTime: 0,
      endTime: 0,
      markerChunkIndices: [i]
    })
    used.add(i)
  }

  // Pass 1: multi-word bucket patterns (CTA spelled out, "call to action", etc.)
  for (let i = 0; i < wordChunks.length; i++) {
    if (used.has(i)) continue
    if (!normed[i]) continue

    const multi = matchBucketMulti(normed, i)
    if (!multi) continue

    const numberIdx = i + multi.wordsConsumed
    if (numberIdx >= wordChunks.length || used.has(numberIdx)) continue

    const num = parseNumber(normed[numberIdx])
    if (num === null) continue
    if (!markerHasSilenceLead(i)) continue

    const indices = Array.from({ length: multi.wordsConsumed + 1 }, (_, k) => i + k)
    const bucketLabel = multi.bucket === 'cta'
      ? 'CTA'
      : multi.bucket.charAt(0).toUpperCase() + multi.bucket.slice(1)

    markers.push({
      id: `marker-${nextId++}`,
      label: `${bucketLabel} ${num}`,
      bucket: multi.bucket,
      startTime: 0,
      endTime: 0,
      markerChunkIndices: indices
    })
    indices.forEach((idx) => used.add(idx))
  }

  // Pass 2: single-word bucket + number (e.g. "hook one", "body 2")
  for (let i = 0; i < wordChunks.length - 1; i++) {
    if (used.has(i)) continue
    if (!normed[i]) continue

    const bucket = matchBucketSingle(normed[i])
    if (!bucket) continue

    const numIdx = i + 1
    if (used.has(numIdx)) continue

    const num = parseNumber(normed[numIdx])
    if (num === null) continue
    if (!markerHasSilenceLead(i)) continue

    const bucketLabel = bucket === 'cta'
      ? 'CTA'
      : bucket.charAt(0).toUpperCase() + bucket.slice(1)

    markers.push({
      id: `marker-${nextId++}`,
      label: `${bucketLabel} ${num}`,
      bucket,
      startTime: 0,
      endTime: 0,
      markerChunkIndices: [i, numIdx]
    })
    used.add(i)
    used.add(numIdx)
  }

  // Sort markers by their position in the audio
  markers.sort((a, b) => {
    const aTime = wordChunks[a.markerChunkIndices[0]].start
    const bTime = wordChunks[b.markerChunkIndices[0]].start
    return aTime - bTime
  })

  // Deduplicate retakes: if the same label appears multiple times, keep only the last
  // occurrence (the final retake). Poison all word chunks between removed and kept markers
  // so bad-take content won't bleed into the previous clip's end time.
  const labelLastIndex = new Map<string, number>()
  for (let i = 0; i < markers.length; i++) {
    labelLastIndex.set(markers[i].label, i)
  }
  const removedIndices = new Set<number>()
  for (let i = 0; i < markers.length; i++) {
    const lastIdx = labelLastIndex.get(markers[i].label)!
    if (i !== lastIdx) {
      removedIndices.add(i)
      // Poison all chunk indices from this marker's first chunk up to (but not including)
      // the kept marker's first chunk — covers the marker phrase + bad-take content
      const poisonStart = markers[i].markerChunkIndices[0]
      const poisonEnd = markers[lastIdx].markerChunkIndices[0]
      for (let j = poisonStart; j < poisonEnd; j++) {
        used.add(j)
      }
    }
  }
  const dedupedMarkers = markers.filter((_, i) => !removedIndices.has(i))

  // Compute initial timings
  computeTimings(dedupedMarkers, wordChunks, used, videoDuration, speechIntervals)

  // Drop markers producing unusably short clips (hallucinated rapid-fire markers)
  const validMarkers = dedupedMarkers.filter(m => m.endTime - m.startTime >= MIN_CLIP_SEC)

  // Recompute — removing bad markers shifts boundaries outward for survivors
  computeTimings(validMarkers, wordChunks, used, videoDuration, speechIntervals)

  return validMarkers
}
