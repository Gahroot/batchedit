import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip } from '../store'
import { useStore } from '../store'
import { Bucket } from './Bucket'

vi.mock('../hooks/useWhisper', () => ({
  useWhisper: () => ({
    loadProgress: 0,
    loadModel: vi.fn(),
    transcribe: vi.fn(),
    cancel: vi.fn()
  })
}))

const clipNames = ['Alpha Hook.mp4', 'Beta Hook.mp4', 'Gamma Hook.mp4']

function createClips(): Clip[] {
  return clipNames.map((name, index) => ({
    id: `hook-${index + 1}`,
    name,
    path: `/clips/${name}`,
    duration: 3 + index
  }))
}

function getHookIds(): string[] {
  return useStore.getState().hooks.map((clip) => clip.id)
}

function installClipRects(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const accessibleName = this.getAttribute('aria-label') ?? ''
    const content = this.textContent ?? ''
    const index = clipNames.findIndex(
      (name) => accessibleName.includes(name) || content.includes(name)
    )
    const top = Math.max(index, 0) * 100

    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 320,
      bottom: top + 80,
      width: 320,
      height: 80,
      toJSON: () => ({})
    } as DOMRect
  })
}

function renderHooksBucket(): void {
  render(<Bucket type="hook" label="Hooks" color="text-blue-400" />)
}

describe('Bucket clip ordering', () => {
  beforeEach(() => {
    useStore.setState({
      hooks: createClips(),
      meats: [],
      ctas: [],
      isRendering: false,
      hookTextProgress: null
    })
    installClipRects()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('names every ordering control with the clip and bucket and exposes boundaries', () => {
    renderHooksBucket()

    expect(
      screen.getByRole('button', { name: 'Reorder Alpha Hook.mp4 in Hooks bucket' })
    ).toHaveAttribute('aria-roledescription', 'sortable clip')
    expect(
      screen.getByRole('button', { name: 'Move Up: Alpha Hook.mp4 in Hooks bucket' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Move Down: Alpha Hook.mp4 in Hooks bucket' })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Move Up: Gamma Hook.mp4 in Hooks bucket' })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Move Down: Gamma Hook.mp4 in Hooks bucket' })
    ).toBeDisabled()
  })

  it('moves clips with one click, announces the new position, and ignores boundary moves', async () => {
    renderHooksBucket()

    fireEvent.click(
      screen.getByRole('button', { name: 'Move Up: Alpha Hook.mp4 in Hooks bucket' })
    )
    expect(getHookIds()).toEqual(['hook-1', 'hook-2', 'hook-3'])

    fireEvent.click(
      screen.getByRole('button', { name: 'Move Down: Alpha Hook.mp4 in Hooks bucket' })
    )

    await waitFor(() => {
      expect(getHookIds()).toEqual(['hook-2', 'hook-1', 'hook-3'])
    })
    expect(
      screen.getByText('Moved Alpha Hook.mp4 to position 2 of 3 in the Hooks bucket.')
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Move Down: Gamma Hook.mp4 in Hooks bucket' })
    )
    expect(getHookIds()).toEqual(['hook-2', 'hook-1', 'hook-3'])
  })

  it('sorts with Space and Arrow Down and announces the keyboard move', async () => {
    renderHooksBucket()
    const handle = screen.getByRole('button', {
      name: 'Reorder Alpha Hook.mp4 in Hooks bucket'
    })

    handle.focus()
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' })
    await waitFor(() => expect(handle).toHaveAttribute('aria-pressed', 'true'))

    fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' })
    await waitFor(() => {
      expect(
        screen.getByText('Moved Alpha Hook.mp4 to position 2 of 3 in the Hooks bucket.')
      ).toBeInTheDocument()
    })

    fireEvent.keyDown(document, { code: 'Space', key: ' ' })
    await waitFor(() => {
      expect(getHookIds()).toEqual(['hook-2', 'hook-1', 'hook-3'])
    })
    expect(handle).toHaveFocus()
  })

  it('keeps pointer sorting on the drag handle', async () => {
    renderHooksBucket()
    const handle = screen.getByRole('button', {
      name: 'Reorder Alpha Hook.mp4 in Hooks bucket'
    })

    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 10,
      clientY: 20,
      isPrimary: true,
      pointerId: 1
    })
    await waitFor(() => expect(handle).toHaveAttribute('aria-pressed', 'true'))

    fireEvent.pointerMove(document, {
      clientX: 10,
      clientY: 120,
      isPrimary: true,
      pointerId: 1
    })
    fireEvent.pointerUp(document, {
      button: 0,
      clientX: 10,
      clientY: 120,
      isPrimary: true,
      pointerId: 1
    })

    await waitFor(() => {
      expect(getHookIds()).toEqual(['hook-2', 'hook-1', 'hook-3'])
    })
  })

  it('disables drag and move controls while rendering', () => {
    useStore.setState({ isRendering: true })
    renderHooksBucket()

    expect(
      screen.getByRole('button', { name: 'Reorder Beta Hook.mp4 in Hooks bucket' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Move Up: Beta Hook.mp4 in Hooks bucket' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Move Down: Beta Hook.mp4 in Hooks bucket' })
    ).toBeDisabled()
  })
})
