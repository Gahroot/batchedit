import { describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Logic extracted from Bucket.tsx — tested in isolation
// ---------------------------------------------------------------------------

/**
 * The accepted video extensions list from Bucket.tsx (line 23):
 *   const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm']
 */
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm']

/**
 * Replicates the video extension filter logic from the onDrop handler
 * (Bucket.tsx lines 79-81):
 *   .filter((f) => VIDEO_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)))
 */
function isVideoFile(filename: string): boolean {
  return VIDEO_EXTS.some((ext) => filename.toLowerCase().endsWith(ext))
}

/**
 * Replicates the filename extraction from Bucket.tsx (lines 49, 85):
 *   const name = path.split(/[/\\]/).pop() || 'Unknown'
 */
function extractFilename(path: string): string {
  return path.split(/[/\\]/).pop() || 'Unknown'
}

// ---------------------------------------------------------------------------
// Tests — Video extension filtering
// ---------------------------------------------------------------------------

describe('Bucket — video extension filtering', () => {
  describe('accepted extensions', () => {
    it.each([
      ['video.mp4', '.mp4'],
      ['clip.mov', '.mov'],
      ['file.avi', '.avi'],
      ['movie.mkv', '.mkv'],
      ['stream.webm', '.webm']
    ])('accepts %s (%s)', (filename) => {
      expect(isVideoFile(filename)).toBe(true)
    })
  })

  describe('rejected extensions', () => {
    it.each([
      ['document.txt', '.txt'],
      ['photo.jpg', '.jpg'],
      ['report.pdf', '.pdf'],
      ['image.png', '.png'],
      ['audio.mp3', '.mp3'],
      ['data.json', '.json'],
      ['style.css', '.css']
    ])('rejects %s (%s)', (filename) => {
      expect(isVideoFile(filename)).toBe(false)
    })
  })

  describe('case insensitivity', () => {
    it('accepts .MP4 (uppercase)', () => {
      expect(isVideoFile('video.MP4')).toBe(true)
    })

    it('accepts .Mov (mixed case)', () => {
      expect(isVideoFile('clip.Mov')).toBe(true)
    })

    it('accepts .AVI (uppercase)', () => {
      expect(isVideoFile('file.AVI')).toBe(true)
    })

    it('accepts .MKV (uppercase)', () => {
      expect(isVideoFile('movie.MKV')).toBe(true)
    })

    it('accepts .WEBM (uppercase)', () => {
      expect(isVideoFile('stream.WEBM')).toBe(true)
    })

    it('accepts .Mp4 (title case)', () => {
      expect(isVideoFile('video.Mp4')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('rejects empty filename', () => {
      expect(isVideoFile('')).toBe(false)
    })

    it('rejects filename with no extension', () => {
      expect(isVideoFile('videofile')).toBe(false)
    })

    it('accepts filename with multiple dots', () => {
      expect(isVideoFile('my.video.clip.mp4')).toBe(true)
    })

    it('rejects file that contains extension mid-name', () => {
      // "mp4" appears in the name but is not the extension
      expect(isVideoFile('mp4_archive.zip')).toBe(false)
    })

    it('rejects similar but wrong extension', () => {
      expect(isVideoFile('video.mp4a')).toBe(false)
    })

    it('accepts extension with path prefix', () => {
      // The filter in Bucket.tsx uses f.name (just the filename), not the full path.
      // But the function itself only checks the ending so both work.
      expect(isVideoFile('video.mp4')).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — Filename extraction from path
// ---------------------------------------------------------------------------

describe('Bucket — filename extraction from path', () => {
  describe('Unix paths', () => {
    it('extracts filename from simple Unix path', () => {
      expect(extractFilename('/home/user/video.mp4')).toBe('video.mp4')
    })

    it('extracts filename from deeply nested Unix path', () => {
      expect(extractFilename('/a/b/c/d.mp4')).toBe('d.mp4')
    })

    it('extracts filename from root path', () => {
      expect(extractFilename('/video.mp4')).toBe('video.mp4')
    })
  })

  describe('Windows paths', () => {
    it('extracts filename from Windows path with backslashes', () => {
      expect(extractFilename('C:\\Users\\video.mp4')).toBe('video.mp4')
    })

    it('extracts filename from deeply nested Windows path', () => {
      expect(extractFilename('C:\\Users\\Admin\\Documents\\Projects\\clip.mov')).toBe('clip.mov')
    })

    it('extracts filename from Windows path with drive letter only', () => {
      expect(extractFilename('D:\\video.mp4')).toBe('video.mp4')
    })
  })

  describe('mixed and edge cases', () => {
    it('handles bare filename (no path)', () => {
      expect(extractFilename('video.mp4')).toBe('video.mp4')
    })

    it('returns "Unknown" for empty string', () => {
      // ''.split(/[/\\]/).pop() returns '' which is falsy, so || 'Unknown' triggers
      expect(extractFilename('')).toBe('Unknown')
    })

    it('handles filename with spaces', () => {
      expect(extractFilename('/home/user/my video file.mp4')).toBe('my video file.mp4')
    })

    it('handles trailing slash (returns "Unknown")', () => {
      // '/path/to/dir/'.split(/[/\\]/) => ['', 'path', 'to', 'dir', '']
      // .pop() => '' which is falsy => 'Unknown'
      expect(extractFilename('/path/to/dir/')).toBe('Unknown')
    })

    it('handles path with mixed separators', () => {
      // The regex /[/\\]/ splits on both forward and back slashes
      expect(extractFilename('C:\\Users/video/clip.mp4')).toBe('clip.mp4')
    })
  })
})
