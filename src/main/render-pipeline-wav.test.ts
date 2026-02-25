import { describe, it, expect } from 'vitest'
import { parseWavToFloat32 } from './render-pipeline'

/**
 * Helper to build a minimal valid WAV file buffer.
 *
 * WAV structure:
 *   'RIFF' (4) + fileSize (4) + 'WAVE' (4)
 *   'fmt ' (4) + chunkSize (4) + audioFormat (2) + numChannels (2)
 *          + sampleRate (4) + byteRate (4) + blockAlign (2) + bitsPerSample (2)
 *   'data' (4) + dataSize (4) + <PCM samples>
 */
function buildWavBuffer(samples: number[]): Buffer {
  const numSamples = samples.length
  const bitsPerSample = 16
  const numChannels = 1
  const sampleRate = 16000
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = numSamples * (bitsPerSample / 8)
  const fmtChunkSize = 16
  // Total file size = 4 (WAVE) + 8+fmtChunkSize (fmt chunk) + 8+dataSize (data chunk)
  const fileSize = 4 + (8 + fmtChunkSize) + (8 + dataSize)

  const buffer = Buffer.alloc(12 + 8 + fmtChunkSize + 8 + dataSize)
  let offset = 0

  // RIFF header
  buffer.write('RIFF', offset)
  offset += 4
  buffer.writeUInt32LE(fileSize, offset)
  offset += 4
  buffer.write('WAVE', offset)
  offset += 4

  // fmt chunk
  buffer.write('fmt ', offset)
  offset += 4
  buffer.writeUInt32LE(fmtChunkSize, offset)
  offset += 4
  buffer.writeUInt16LE(1, offset) // PCM format
  offset += 2
  buffer.writeUInt16LE(numChannels, offset)
  offset += 2
  buffer.writeUInt32LE(sampleRate, offset)
  offset += 4
  buffer.writeUInt32LE(byteRate, offset)
  offset += 4
  buffer.writeUInt16LE(blockAlign, offset)
  offset += 2
  buffer.writeUInt16LE(bitsPerSample, offset)
  offset += 2

  // data chunk
  buffer.write('data', offset)
  offset += 4
  buffer.writeUInt32LE(dataSize, offset)
  offset += 4

  // Write 16-bit PCM samples
  for (const sample of samples) {
    buffer.writeInt16LE(sample, offset)
    offset += 2
  }

  return buffer
}

describe('parseWavToFloat32', () => {
  it('converts a valid WAV to Float32Array', () => {
    const samples = [0, 16384, -16384, 32767, -32768]
    const wav = buildWavBuffer(samples)
    const result = parseWavToFloat32(wav)

    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(samples.length)
  })

  it('normalizes 16-bit PCM by dividing by 32768', () => {
    const samples = [0, 32767, -32768, 16384, -16384]
    const wav = buildWavBuffer(samples)
    const result = parseWavToFloat32(wav)

    expect(result[0]).toBeCloseTo(0 / 32768, 5)
    expect(result[1]).toBeCloseTo(32767 / 32768, 5)
    expect(result[2]).toBeCloseTo(-32768 / 32768, 5)
    expect(result[3]).toBeCloseTo(16384 / 32768, 5)
    expect(result[4]).toBeCloseTo(-16384 / 32768, 5)
  })

  it('handles silence (all zeros)', () => {
    const samples = [0, 0, 0, 0]
    const wav = buildWavBuffer(samples)
    const result = parseWavToFloat32(wav)

    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('throws if no data chunk is found', () => {
    // Build a buffer with RIFF header but no 'data' chunk
    const buffer = Buffer.alloc(44)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16) // fmt chunk size
    // Fill the rest with zeros (no 'data' chunk ID)
    buffer.write('junk', 36) // some non-data chunk
    buffer.writeUInt32LE(0, 40)

    expect(() => parseWavToFloat32(buffer)).toThrow('No data chunk found in WAV file')
  })

  it('handles WAV with extra chunks before data', () => {
    // Build a WAV with an extra 'LIST' chunk before data
    const samples = [1000, -1000]
    const bitsPerSample = 16
    const dataSize = samples.length * 2

    // Extra chunk: 'LIST' with 10 bytes of data (even size)
    const listChunkSize = 10
    const fmtChunkSize = 16

    const totalSize =
      12 + // RIFF header
      8 +
      fmtChunkSize + // fmt chunk
      8 +
      listChunkSize + // LIST chunk
      8 +
      dataSize // data chunk

    const buffer = Buffer.alloc(totalSize)
    let offset = 0

    // RIFF header
    buffer.write('RIFF', offset)
    offset += 4
    buffer.writeUInt32LE(totalSize - 8, offset)
    offset += 4
    buffer.write('WAVE', offset)
    offset += 4

    // fmt chunk
    buffer.write('fmt ', offset)
    offset += 4
    buffer.writeUInt32LE(fmtChunkSize, offset)
    offset += 4
    buffer.writeUInt16LE(1, offset) // PCM
    offset += 2
    buffer.writeUInt16LE(1, offset) // channels
    offset += 2
    buffer.writeUInt32LE(16000, offset) // sample rate
    offset += 4
    buffer.writeUInt32LE(32000, offset) // byte rate
    offset += 4
    buffer.writeUInt16LE(2, offset) // block align
    offset += 2
    buffer.writeUInt16LE(bitsPerSample, offset)
    offset += 2

    // LIST chunk (extra, should be skipped)
    buffer.write('LIST', offset)
    offset += 4
    buffer.writeUInt32LE(listChunkSize, offset)
    offset += 4
    offset += listChunkSize // skip past list data

    // data chunk
    buffer.write('data', offset)
    offset += 4
    buffer.writeUInt32LE(dataSize, offset)
    offset += 4
    for (const s of samples) {
      buffer.writeInt16LE(s, offset)
      offset += 2
    }

    const result = parseWavToFloat32(buffer)
    expect(result.length).toBe(2)
    expect(result[0]).toBeCloseTo(1000 / 32768, 5)
    expect(result[1]).toBeCloseTo(-1000 / 32768, 5)
  })

  it('handles single sample', () => {
    const wav = buildWavBuffer([12345])
    const result = parseWavToFloat32(wav)

    expect(result.length).toBe(1)
    expect(result[0]).toBeCloseTo(12345 / 32768, 5)
  })
})
