import { describe, expect, it, vi } from 'vitest'
import type { ProjectCloseAction } from '../shared/project-close'
import {
  type CloseEventLike,
  type ProjectCloseIpc,
  type ProjectCloseWindow,
  setupProjectCloseGuard
} from './project-close-guard'

interface CloseGuardHarness {
  sender: object
  sendCloseRequest: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  showClosePrompt: ReturnType<typeof vi.fn>
  triggerClose: () => CloseEventLike
  chooseAction: (isDirty: boolean) => Promise<ProjectCloseAction>
  completeClose: (shouldClose: boolean) => void
}

function createHarness(response: number): CloseGuardHarness {
  const sender = {}
  let closeListener: ((event: CloseEventLike) => void) | null = null
  let chooseActionListener:
    | ((sender: object, isDirty: unknown) => Promise<ProjectCloseAction>)
    | null = null
  let completeListener: ((sender: object, shouldClose: unknown) => void) | null = null

  const sendCloseRequest = vi.fn()
  const close = vi.fn()
  const showClosePrompt = vi.fn(async () => response)
  const window: ProjectCloseWindow = {
    sender,
    onClose: (listener) => {
      closeListener = listener
    },
    onClosed: vi.fn(),
    sendCloseRequest,
    close
  }
  const ipc: ProjectCloseIpc = {
    registerChooseAction: (listener) => {
      chooseActionListener = listener
    },
    registerComplete: (listener) => {
      completeListener = listener
    },
    removeHandlers: vi.fn()
  }

  setupProjectCloseGuard(window, {
    ipc,
    showClosePrompt,
    reportError: vi.fn()
  })

  return {
    sender,
    sendCloseRequest,
    close,
    showClosePrompt,
    triggerClose: () => {
      if (closeListener === null) throw new Error('Close listener was not registered')
      const event = { preventDefault: vi.fn() }
      closeListener(event)
      return event
    },
    chooseAction: async (isDirty) => {
      if (chooseActionListener === null)
        throw new Error('Choose-action listener was not registered')
      return chooseActionListener(sender, isDirty)
    },
    completeClose: (shouldClose) => {
      if (completeListener === null) throw new Error('Complete-close listener was not registered')
      completeListener(sender, shouldClose)
    }
  }
}

describe('project close guard', () => {
  it.each([
    { response: 0, action: 'save' },
    { response: 1, action: 'discard' },
    { response: 2, action: 'cancel' }
  ] as const)(
    'maps the native $action choice without bypassing the guard',
    async ({ response, action }) => {
      const harness = createHarness(response)
      const event = harness.triggerClose()

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(harness.sendCloseRequest).toHaveBeenCalledOnce()
      await expect(harness.chooseAction(true)).resolves.toBe(action)

      harness.completeClose(action !== 'cancel')
      expect(harness.close).toHaveBeenCalledTimes(action === 'cancel' ? 0 : 1)
    }
  )

  it('allows another close attempt after cancellation', async () => {
    const harness = createHarness(2)
    harness.triggerClose()
    await expect(harness.chooseAction(true)).resolves.toBe('cancel')
    harness.completeClose(false)

    const secondEvent = harness.triggerClose()
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.sendCloseRequest).toHaveBeenCalledTimes(2)
    expect(harness.close).not.toHaveBeenCalled()
  })

  it('closes a clean workspace without showing the unsaved-changes prompt', async () => {
    const harness = createHarness(0)
    harness.triggerClose()

    await expect(harness.chooseAction(false)).resolves.toBe('discard')
    harness.completeClose(true)

    expect(harness.showClosePrompt).not.toHaveBeenCalled()
    expect(harness.close).toHaveBeenCalledOnce()
  })
})
