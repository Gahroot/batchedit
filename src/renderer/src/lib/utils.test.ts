import { describe, it, expect } from 'vitest'
import { cn } from './utils'

describe('cn()', () => {
  it('passes through a single class string', () => {
    expect(cn('text-red-500')).toBe('text-red-500')
  })

  it('merges multiple class strings', () => {
    const result = cn('text-red-500', 'font-bold')
    expect(result).toContain('text-red-500')
    expect(result).toContain('font-bold')
  })

  it('filters out falsy values (undefined, null, false)', () => {
    const result = cn('base', undefined, null, false, 'active')
    expect(result).toBe('base active')
  })

  it('handles conditional classes via expressions', () => {
    const isActive = true
    const isDisabled = false
    const result = cn('btn', isActive && 'btn-active', isDisabled && 'btn-disabled')

    expect(result).toContain('btn')
    expect(result).toContain('btn-active')
    expect(result).not.toContain('btn-disabled')
  })

  it('resolves Tailwind conflicts (last wins)', () => {
    // tailwind-merge should resolve p-4 vs p-2 -> p-2 (last one wins)
    const result = cn('p-4', 'p-2')
    expect(result).toBe('p-2')
  })

  it('resolves conflicting text colors', () => {
    const result = cn('text-red-500', 'text-blue-500')
    expect(result).toBe('text-blue-500')
  })

  it('keeps non-conflicting Tailwind classes', () => {
    const result = cn('p-4', 'mt-2', 'text-lg')
    expect(result).toContain('p-4')
    expect(result).toContain('mt-2')
    expect(result).toContain('text-lg')
  })

  it('handles empty arguments', () => {
    expect(cn()).toBe('')
  })

  it('handles empty string arguments', () => {
    expect(cn('', 'text-sm', '')).toBe('text-sm')
  })

  it('handles array-style clsx input', () => {
    const result = cn(['text-sm', 'font-bold'])
    expect(result).toContain('text-sm')
    expect(result).toContain('font-bold')
  })

  it('handles object-style clsx input', () => {
    const result = cn({ 'text-sm': true, 'font-bold': false, 'underline': true })
    expect(result).toContain('text-sm')
    expect(result).not.toContain('font-bold')
    expect(result).toContain('underline')
  })

  it('resolves conflicts from mixed sources', () => {
    const result = cn('px-4', { 'px-2': true })
    expect(result).toBe('px-2')
  })
})
