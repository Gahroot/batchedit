import { describe, expect, it, vi } from 'vitest'
import { handleProjectCloseRequest } from './project-close'

describe('project close requests', () => {
  it('saves and closes only after the workspace is confirmed clean', async () => {
    const state = {
      isDirty: true,
      saveProject: vi.fn(async (): Promise<string | null> => {
        state.isDirty = false
        return '/tmp/campaign.batchedit'
      })
    }
    const chooseAction = vi.fn(async () => 'save' as const)
    const completeClose = vi.fn(async () => undefined)
    const onSaved = vi.fn()
    const onError = vi.fn()

    await handleProjectCloseRequest({
      getState: () => state,
      chooseAction,
      completeClose,
      onSaved,
      onError
    })

    expect(chooseAction).toHaveBeenCalledWith(true)
    expect(state.saveProject).toHaveBeenCalledOnce()
    expect(onSaved).toHaveBeenCalledWith('/tmp/campaign.batchedit', true)
    expect(completeClose).toHaveBeenCalledWith(true)
    expect(onError).not.toHaveBeenCalled()
  })

  it('discards without saving and completes the close', async () => {
    const saveProject = vi.fn(async () => '/tmp/unused.batchedit')
    const completeClose = vi.fn(async () => undefined)

    await handleProjectCloseRequest({
      getState: () => ({ isDirty: true, saveProject }),
      chooseAction: async () => 'discard',
      completeClose,
      onSaved: vi.fn(),
      onError: vi.fn()
    })

    expect(saveProject).not.toHaveBeenCalled()
    expect(completeClose).toHaveBeenCalledWith(true)
  })

  it('keeps the window open when close is cancelled', async () => {
    const saveProject = vi.fn(async () => '/tmp/unused.batchedit')
    const completeClose = vi.fn(async () => undefined)

    await handleProjectCloseRequest({
      getState: () => ({ isDirty: true, saveProject }),
      chooseAction: async () => 'cancel',
      completeClose,
      onSaved: vi.fn(),
      onError: vi.fn()
    })

    expect(saveProject).not.toHaveBeenCalled()
    expect(completeClose).toHaveBeenCalledWith(false)
  })

  it('keeps the window open when Save As is cancelled', async () => {
    const saveProject = vi.fn(async () => null)
    const completeClose = vi.fn(async () => undefined)

    await handleProjectCloseRequest({
      getState: () => ({ isDirty: true, saveProject }),
      chooseAction: async () => 'save',
      completeClose,
      onSaved: vi.fn(),
      onError: vi.fn()
    })

    expect(saveProject).toHaveBeenCalledOnce()
    expect(completeClose).toHaveBeenCalledWith(false)
  })
})
