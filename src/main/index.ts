import { GoogleGenerativeAI } from '@google/generative-ai'
import { app, shell, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import { extname, isAbsolute, join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { PROJECT_CLOSE_CHANNELS } from '../shared/project-close'
import { setupFFmpeg, getFFmpegReadiness } from './ffmpeg'
import { findMissingPaths } from './fs-paths'
import { setupRenderPipeline, clearNormalizedCache, clearTrackedTempFiles } from './render-pipeline'
import { setupProjectCloseGuard } from './project-close-guard'
import { setupQaIpc } from './qa-ipc'
import {
  PLATFORM_SAFE_ZONES,
  getSafeZone,
  getDeadZones,
  getElementPlacement,
  clampToSafeZone,
  isInsideSafeZone,
  rectToAssMargins,
  type Platform,
  type ElementType,
  type SafeZoneRect
} from './safe-zones'

function showMainProcessError(title: string, message: string, error: unknown, shouldExit: boolean): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  const detail = `${normalized.message}\n\n${normalized.stack || ''}`
  console.error(title, normalized)
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title,
    message,
    detail,
    buttons: ['Copy Error', shouldExit ? 'Close' : 'Dismiss'],
    defaultId: 0
  })
  if (choice === 0) clipboard.writeText(detail)
  if (shouldExit) app.exit(1)
}

function logProjectIo(operation: 'save' | 'load', projectPath: string, outcome: 'success' | 'error', startedAt: number, error?: unknown): void {
  const details = {
    operation,
    projectPath,
    outcome,
    elapsedMs: Date.now() - startedAt,
    ...(error !== undefined && { error: error instanceof Error ? error.message : String(error) })
  }
  if (outcome === 'error') console.error('[Project I/O]', details)
  else console.info('[Project I/O]', details)
}

// Show copyable error dialog for uncaught exceptions
process.on('uncaughtException', (error) => {
  showMainProcessError(
    'Error',
    'A JavaScript error occurred in the main process',
    error,
    true
  )
})

process.on('unhandledRejection', (reason) => {
  showMainProcessError(
    'Unhandled Promise Rejection',
    'A background task failed in the main process',
    reason,
    false
  )
})

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  setupProjectCloseGuard(
    {
      sender: mainWindow.webContents,
      onClose: (listener) => mainWindow.on('close', listener),
      onClosed: (listener) => mainWindow.once('closed', listener),
      sendCloseRequest: () => mainWindow.webContents.send(PROJECT_CLOSE_CHANNELS.request),
      close: () => mainWindow.close()
    },
    {
      ipc: {
        registerChooseAction: (listener) => {
          ipcMain.handle(PROJECT_CLOSE_CHANNELS.chooseAction, (event, isDirty: unknown) =>
            listener(event.sender, isDirty)
          )
        },
        registerComplete: (listener) => {
          ipcMain.handle(PROJECT_CLOSE_CHANNELS.complete, (event, shouldClose: unknown) =>
            listener(event.sender, shouldClose)
          )
        },
        removeHandlers: () => {
          ipcMain.removeHandler(PROJECT_CLOSE_CHANNELS.chooseAction)
          ipcMain.removeHandler(PROJECT_CLOSE_CHANNELS.complete)
        }
      },
      showClosePrompt: async () => {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Unsaved Changes',
          message: 'Do you want to save your changes before closing?',
          detail: 'Unsaved changes will be permanently lost if you choose Discard.',
          buttons: ['Save', 'Discard', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        })
        return result.response
      },
      reportError: (error) => showMainProcessError(
        'Close Failed',
        'BatchEdit could not confirm whether to close this project',
        error,
        false
      )
    }
  )

  setupQaIpc(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.batchedit.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Setup FFmpeg paths
  setupFFmpeg()

  // IPC: Report FFmpeg/ffprobe readiness so the renderer can warn the user
  // when the bundled binaries fail to resolve (packaged builds, AV quarantine).
  ipcMain.handle('ffmpeg:getReadiness', async (): Promise<{ ready: boolean; issues: string[] }> => {
    const { ready, issues } = getFFmpegReadiness()
    return { ready, issues }
  })

  // Setup IPC handlers for render pipeline
  setupRenderPipeline()

  // IPC: Open file dialog for video selection
  ipcMain.handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mts', 'm4v'] }
      ]
    })
    return result.filePaths
  })

  // IPC: Open file dialog for image selection
  ipcMain.handle('dialog:openImages', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
      ]
    })
    return result.filePaths
  })

  // IPC: Open directory dialog for output
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.filePaths[0] || null
  })

  // IPC: Suggest a sensible default output directory on first run (overridable)
  ipcMain.handle('app:getDefaultOutputDirectory', async (): Promise<string | null> => {
    try {
      return app.getPath('videos')
    } catch {
      try {
        return app.getPath('desktop')
      } catch {
        return null
      }
    }
  })

  // IPC: Reveal a file in the OS file browser (highlighting it)
  ipcMain.handle('shell:showItemInFolder', async (_event, fullPath: string): Promise<void> => {
    if (typeof fullPath !== 'string' || fullPath.length === 0) return
    shell.showItemInFolder(fullPath)
  })

  // IPC: Open a file or directory with the OS default handler
  ipcMain.handle('shell:openPath', async (_event, fullPath: string): Promise<string> => {
    if (typeof fullPath !== 'string' || fullPath.length === 0) return 'Invalid path'
    return shell.openPath(fullPath)
  })

  // IPC: Generate hook text via Gemini AI
  ipcMain.handle(
    'ai:generateHookText',
    async (_event, apiKey: string, transcript: string): Promise<string> => {
      const genAI = new GoogleGenerativeAI(apiKey)
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

      const result = await model.generateContent(
        `You are an elite direct-response copywriter specializing in short-form video ads (TikTok, Reels, Shorts). Your job is to write on-screen hook text that appears in the first 1-3 seconds of a video ad.

The on-screen text MUST:
- Stop the scroll — make the viewer pause and pay attention
- Open a curiosity loop — create an information gap the viewer needs to close
- Trigger an emotional response — shock, intrigue, fear of missing out, or desire
- Feel native to the platform — not like an ad, more like something a friend would say
- Be 1-6 words MAX — this gets overlaid on video, it must be instantly readable

Choose from one of these hook CATEGORIES based on what fits the transcript best:

QUESTION HOOKS — create a mental itch the viewer needs to answer, so they keep watching:
- "Did you know [specific thing]?"
- "Is this even legal?"
- "How did I not know this?"
- "Am I the only one who does this?"
- "Why do [X] pros keep this secret?"
- "What happens if you [Y]?"
- "Can you guess what happens next?"
- "Want the fastest way to [result]?"
- "Ever wondered why [thing] never works?"
- "What would you do?"
- "Think you know [topic]?"

CONTROVERSY / CONTRAST — people are drawn to conflict and disagreement, they want to see who's right:
- "Unpopular opinion:" or "Hot take:" followed by a specific stance
- "Everyone does X. I do Y."
- "They said this was impossible"
- "This is controversial but..."
- "[Expert] was wrong about this"
- "The truth about [popular thing]"
- "What [industry] won't tell you"
- "Before vs after" / "Expectation vs reality"
- "What they show you vs what actually works"
- "Beginners do X. Pros do Y."

Adapt the pattern to be SPECIFIC to the transcript content — fill in the blanks with real details from what's being said. Don't use the templates verbatim.

Do NOT:
- Summarize the video content
- Write full sentences or taglines
- Use generic filler like "Check this out" or "Must watch"
- Sound like a marketing guru or scam
- Add hashtags, emojis, or punctuation beyond "..." or "?"

Given the transcript below, write ONE piece of on-screen hook text. Return ONLY the text, nothing else.

Transcript: "${transcript}"`
      )

      return result.response.text().trim()
    }
  )

  // IPC: Safe zone helpers
  ipcMain.handle('safezones:getSafeZone', (_event, platform: Platform) =>
    getSafeZone(platform)
  )
  ipcMain.handle('safezones:getDeadZones', (_event, platform: Platform) =>
    getDeadZones(platform)
  )
  ipcMain.handle('safezones:getPlacement', (_event, platform: Platform, element: ElementType) =>
    getElementPlacement(platform, element)
  )
  ipcMain.handle('safezones:clamp', (_event, rect: SafeZoneRect, platform: Platform) =>
    clampToSafeZone(rect, platform)
  )
  ipcMain.handle('safezones:isInside', (_event, rect: SafeZoneRect, platform: Platform) =>
    isInsideSafeZone(rect, platform)
  )
  ipcMain.handle('safezones:toAssMargins', (_event, rect: SafeZoneRect) =>
    rectToAssMargins(rect)
  )
  ipcMain.handle('safezones:getAllPlatforms', () => PLATFORM_SAFE_ZONES)

  // IPC: Save project file, reusing the active path after the first confirmed save/load.
  ipcMain.handle('project:save', async (_event, projectData: unknown, projectPath: unknown): Promise<string | null> => {
    if (typeof projectData !== 'string') throw new TypeError('Project data must be a string')
    let targetPath = typeof projectPath === 'string' && isAbsolute(projectPath) &&
      extname(projectPath).toLowerCase() === '.batchedit' ? projectPath : null

    if (targetPath === null) {
      const result = await dialog.showSaveDialog({
        filters: [{ name: 'BatchEdit Project', extensions: ['batchedit'] }],
        defaultPath: 'project.batchedit'
      })
      if (result.canceled || !result.filePath) return null
      targetPath = result.filePath
    }

    const startedAt = Date.now()
    try {
      await writeFile(targetPath, projectData, 'utf-8')
      logProjectIo('save', targetPath, 'success', startedAt)
      return targetPath
    } catch (error) {
      logProjectIo('save', targetPath, 'error', startedAt, error)
      throw error
    }
  })

  // IPC: Report which of the given paths are missing on disk (moved/renamed
  // source clips). Used at project-load time to flag dead clips before render.
  ipcMain.handle('fs:pathsExist', async (_event, paths: string[]) => {
    if (!Array.isArray(paths)) return { missing: [] }
    const missing = await findMissingPaths(paths.filter((p) => typeof p === 'string'))
    return { missing }
  })

  // IPC: Load project file
  ipcMain.handle('project:load', async (): Promise<{ path: string; data: string } | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'BatchEdit Project', extensions: ['batchedit'] }]
    })
    const projectPath = result.filePaths[0]
    if (result.canceled || projectPath === undefined) return null

    const startedAt = Date.now()
    try {
      const data = await readFile(projectPath, 'utf-8')
      logProjectIo('load', projectPath, 'success', startedAt)
      return { path: projectPath, data }
    } catch (error) {
      logProjectIo('load', projectPath, 'error', startedAt, error)
      throw error
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  clearTrackedTempFiles()
  clearNormalizedCache()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
