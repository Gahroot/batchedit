import { describe, expect, it } from 'vitest'
import { classifyShotFromFaceBox } from './analyze-shot'

describe('classifyShotFromFaceBox', () => {
  it('classifies missing face as wide', () => {
    expect(classifyShotFromFaceBox(null)).toBe('wide')
  })

  it('classifies large faces as selfie', () => {
    expect(classifyShotFromFaceBox({ x: 0.2, y: 0.1, width: 0.6, height: 0.7 })).toBe('selfie')
  })

  it('classifies small faces as full body', () => {
    expect(classifyShotFromFaceBox({ x: 0.45, y: 0.2, width: 0.1, height: 0.15 })).toBe('full-body')
  })
})
