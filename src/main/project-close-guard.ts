import type { ProjectCloseAction } from '../shared/project-close'

export interface CloseEventLike {
  preventDefault: () => void
}

export interface ProjectCloseWindow {
  sender: object
  onClose: (listener: (event: CloseEventLike) => void) => void
  onClosed: (listener: () => void) => void
  sendCloseRequest: () => void
  close: () => void
}

export interface ProjectCloseIpc {
  registerChooseAction: (
    listener: (sender: object, isDirty: unknown) => Promise<ProjectCloseAction>
  ) => void
  registerComplete: (listener: (sender: object, shouldClose: unknown) => void) => void
  removeHandlers: () => void
}

export interface ProjectCloseGuardDependencies {
  ipc: ProjectCloseIpc
  showClosePrompt: () => Promise<number>
  reportError: (error: unknown) => void
}

export function projectCloseActionForResponse(response: number): ProjectCloseAction {
  if (response === 0) return 'save'
  if (response === 1) return 'discard'
  return 'cancel'
}

export function setupProjectCloseGuard(
  window: ProjectCloseWindow,
  dependencies: ProjectCloseGuardDependencies
): () => void {
  let allowClose = false
  let closeRequestPending = false

  dependencies.ipc.removeHandlers()

  window.onClose((event) => {
    if (allowClose) return

    event.preventDefault()
    if (closeRequestPending) return

    closeRequestPending = true
    window.sendCloseRequest()
  })

  dependencies.ipc.registerChooseAction(async (sender, isDirty) => {
    if (sender !== window.sender || !closeRequestPending || typeof isDirty !== 'boolean') {
      return 'cancel'
    }

    if (!isDirty) return 'discard'

    try {
      const response = await dependencies.showClosePrompt()
      return projectCloseActionForResponse(response)
    } catch (error) {
      dependencies.reportError(error)
      return 'cancel'
    }
  })

  dependencies.ipc.registerComplete((sender, shouldClose) => {
    if (sender !== window.sender || !closeRequestPending) return

    closeRequestPending = false
    if (shouldClose !== true) return

    allowClose = true
    window.close()
  })

  const cleanup = (): void => {
    dependencies.ipc.removeHandlers()
  }
  window.onClosed(cleanup)
  return cleanup
}
