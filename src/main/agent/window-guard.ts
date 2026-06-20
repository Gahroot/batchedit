import type { BrowserWindow } from 'electron'

/**
 * Returns true if the BrowserWindow and its webContents are still alive.
 * Use before any `webContents.send()` to avoid "Render frame was disposed" errors.
 */
export function isWindowAlive(win: BrowserWindow): boolean {
  return !win.isDestroyed() && !win.webContents.isDestroyed()
}
