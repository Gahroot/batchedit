import { GoogleGenerativeAI } from '@google/generative-ai'
import { app, shell, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupFFmpeg } from './ffmpeg'
import { setupRenderPipeline, clearNormalizedCache, clearTrackedTempFiles } from './render-pipeline'
import { setupAgent } from './agent/ipc'
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

  setupAgent(mainWindow)

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

  // IPC: Save project file
  ipcMain.handle('project:save', async (_event, projectData: string) => {
    const result = await dialog.showSaveDialog({
      filters: [{ name: 'BatchEdit Project', extensions: ['batchedit'] }],
      defaultPath: 'project.batchedit'
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, projectData, 'utf-8')
    return result.filePath
  })

  // IPC: Load project file
  ipcMain.handle('project:load', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'BatchEdit Project', extensions: ['batchedit'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const data = await readFile(result.filePaths[0], 'utf-8')
    return data
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
