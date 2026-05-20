import { ipcMain, type BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'

interface PendingRendererCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

const pending = new Map<string, PendingRendererCall>()

const DEFAULT_TIMEOUT_MS = 60_000

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  if (value && typeof value === 'object' && 'message' in value) {
    return new Error(String(value.message))
  }
  return new Error('Renderer RPC failed')
}

export function setupRendererRpc(): void {
  ipcMain.on('agent:renderer-rpc:reply', (_event, reply: { id?: string; result?: unknown; error?: unknown }) => {
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
  })
}

export function callRenderer<T>(
  win: BrowserWindow,
  channel: string,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const id = uuidv4()

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      win.webContents.send(`${channel}:cancel`, { id })
      reject(new Error(`Renderer RPC timed out on ${channel}`))
    }, timeoutMs)

    const abort = (): void => {
      pending.delete(id)
      clearTimeout(timeout)
      win.webContents.send(`${channel}:cancel`, { id })
      reject(new Error('aborted'))
    }

    if (signal?.aborted) {
      clearTimeout(timeout)
      reject(new Error('aborted'))
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

    win.webContents.send(channel, { id, payload })
  })
}
