export const PROJECT_CLOSE_CHANNELS = {
  request: 'project:close-requested',
  chooseAction: 'project:choose-close-action',
  complete: 'project:complete-close'
} as const

export type ProjectCloseAction = 'save' | 'discard' | 'cancel'
