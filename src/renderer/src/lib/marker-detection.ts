import type { BucketType } from '../store'

export interface WhisperChunk {
  text: string
  start: number // seconds
  end: number   // seconds
}

export interface DetectedMarker {
  id: string
  label: string
  bucket: BucketType
  startTime: number // seconds
  endTime: number   // seconds
  markerChunkIndices: number[]
}

const BUCKET_ALIASES: Record<string, BucketType> = {
  hook: 'hook',
  hooks: 'hook',
  meat: 'meat',
  meats: 'meat',
  body: 'meat',
  middle: 'meat',
  cta: 'cta',
  ctas: 'cta',
  'call-to-action': 'cta',
  closer: 'cta',
  close: 'cta',
  outro: 'cta'
}

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

function matchBucket(word: string): BucketType | null {
  const lower = word.toLowerCase().trim()
  if (BUCKET_ALIASES[lower]) return BUCKET_ALIASES[lower]
  // Fuzzy: allow edit distance of 1 for bucket keywords
  for (const alias of Object.keys(BUCKET_ALIASES)) {
    if (alias.length >= 3 && editDistance(lower, alias) <= 1) {
      return BUCKET_ALIASES[alias]
    }
  }
  return null
}

function parseNumber(word: string): number | null {
  const lower = word.toLowerCase().trim()
  if (NUMBER_WORDS[lower] !== undefined) return NUMBER_WORDS[lower]
  const num = parseInt(lower, 10)
  if (!isNaN(num) && num >= 1 && num <= 99) return num
  return null
}

let nextId = 1

export function detectMarkers(wordChunks: WhisperChunk[], videoDuration: number): DetectedMarker[] {
  const markers: DetectedMarker[] = []
  const used = new Set<number>()

  // Sliding window: try 3-word then 2-word windows
  for (const windowSize of [3, 2]) {
    for (let i = 0; i <= wordChunks.length - windowSize; i++) {
      if (used.has(i)) continue

      const words = wordChunks.slice(i, i + windowSize)
      const texts = words.map((w) => w.text.toLowerCase().trim())

      let bucket: BucketType | null = null
      let num: number | null = null
      let markerIndices: number[] = []

      if (windowSize === 3) {
        // Pattern: bucket word number (e.g., "hook one now")
        // Try first two words as bucket + number
        bucket = matchBucket(texts[0])
        num = bucket ? parseNumber(texts[1]) : null
        if (bucket && num !== null) {
          markerIndices = [i, i + 1]
        }
      }

      if (windowSize === 2) {
        bucket = matchBucket(texts[0])
        num = bucket ? parseNumber(texts[1]) : null
        if (bucket && num !== null) {
          markerIndices = [i, i + 1]
        }
      }

      if (bucket && num !== null && markerIndices.length > 0) {
        const bucketLabel = bucket === 'cta' ? 'CTA' : bucket.charAt(0).toUpperCase() + bucket.slice(1)
        markers.push({
          id: `marker-${nextId++}`,
          label: `${bucketLabel} ${num}`,
          bucket,
          startTime: 0, // Will be set below
          endTime: 0,
          markerChunkIndices: markerIndices
        })
        markerIndices.forEach((idx) => used.add(idx))
      }
    }
  }

  // Sort markers by the timestamp of the marker phrase
  markers.sort((a, b) => {
    const aTime = wordChunks[a.markerChunkIndices[0]].start
    const bTime = wordChunks[b.markerChunkIndices[0]].start
    return aTime - bTime
  })

  // Set start/end times: content starts after marker phrase, ends at next marker
  for (let i = 0; i < markers.length; i++) {
    const lastMarkerIdx = markers[i].markerChunkIndices[markers[i].markerChunkIndices.length - 1]
    // Content starts at the first word after the marker phrase
    const nextWordIdx = lastMarkerIdx + 1
    markers[i].startTime = nextWordIdx < wordChunks.length
      ? wordChunks[nextWordIdx].start
      : wordChunks[lastMarkerIdx].end

    // Content ends at the start of the next marker (or video duration)
    if (i + 1 < markers.length) {
      const nextMarkerFirstIdx = markers[i + 1].markerChunkIndices[0]
      markers[i].endTime = wordChunks[nextMarkerFirstIdx].start
    } else {
      markers[i].endTime = videoDuration
    }
  }

  return markers
}
