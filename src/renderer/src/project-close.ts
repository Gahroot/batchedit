import type { ProjectCloseAction } from '../../shared/project-close'

interface ProjectStateForClose {
  isDirty: boolean
  saveProject: () => Promise<string | null>
}

export interface ProjectCloseRequestDependencies {
  getState: () => ProjectStateForClose
  chooseAction: (isDirty: boolean) => Promise<ProjectCloseAction>
  completeClose: (shouldClose: boolean) => Promise<void>
  onSaved: (path: string, isClean: boolean) => void
  onError: (error: unknown) => void
}

export async function handleProjectCloseRequest(
  dependencies: ProjectCloseRequestDependencies
): Promise<void> {
  let shouldClose = false

  try {
    const stateBeforeChoice = dependencies.getState()
    const action = await dependencies.chooseAction(stateBeforeChoice.isDirty)

    if (action === 'save') {
      const savedPath = await stateBeforeChoice.saveProject()
      if (savedPath !== null) {
        const isClean = !dependencies.getState().isDirty
        dependencies.onSaved(savedPath, isClean)
        shouldClose = isClean
      }
    } else if (action === 'discard') {
      shouldClose = stateBeforeChoice.isDirty || !dependencies.getState().isDirty
    }
  } catch (error) {
    dependencies.onError(error)
  } finally {
    try {
      await dependencies.completeClose(shouldClose)
    } catch (error) {
      dependencies.onError(error)
    }
  }
}
