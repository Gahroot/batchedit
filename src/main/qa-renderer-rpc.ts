import { ipcMain, type BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'

interface PendingRendererCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

const pending = new Map<string, PendingRendererCall>()
const QA_TRANSCRIBE_CHANNEL = 'qa:transcribe'
const QA_RENDERER_REPLY_CHANNEL = 'qa:renderer-rpc:reply'

function isWindowAlive(win: BrowserWindow): boolean {
  return !win.isDestroyed() && !win.webContents.isDestroyed()
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  if (value && typeof value === 'object' && 'message' in value) {
    return new Error(String(value.message))
  }
  return new Error('Renderer transcription failed')
}

export function setupQaRendererRpc(): void {
  ipcMain.on(
    QA_RENDERER_REPLY_CHANNEL,
    (_event, reply: { id?: string; result?: unknown; error?: unknown }) => {
      if (!reply.id) return
      const call = pending.get(reply.id)
      if (!call) return
      pending.delete(reply.id)
      clearTimeout(call.timeout)
      if (reply.error !== undefined) {
        call.reject(toError(reply.error))
        return
      }
      call.resolve(reply.result)
    }
  )
}

export function requestQaTranscription<T>(
  win: BrowserWindow,
  payload: { path: string; model?: string },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (!isWindowAlive(win)) {
    return Promise.reject(
      new Error('Renderer window is no longer alive — cannot transcribe for boundary QA')
    )
  }

  const id = uuidv4()
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      if (isWindowAlive(win)) win.webContents.send(`${QA_TRANSCRIBE_CHANNEL}:cancel`, { id })
      reject(new Error('Renderer transcription timed out during boundary QA'))
    }, timeoutMs)

    const abort = (): void => {
      pending.delete(id)
      clearTimeout(timeout)
      if (isWindowAlive(win)) win.webContents.send(`${QA_TRANSCRIBE_CHANNEL}:cancel`, { id })
      reject(new Error('Boundary QA transcription aborted'))
    }

    if (signal?.aborted) {
      clearTimeout(timeout)
      reject(new Error('Boundary QA transcription aborted'))
      return
    }

    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', abort)
        resolve(value as T)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      },
      timeout
    })

    win.webContents.send(QA_TRANSCRIBE_CHANNEL, { id, payload })
  })
}
