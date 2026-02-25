import { app, shell, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupFFmpeg } from './ffmpeg'
import { setupRenderPipeline } from './render-pipeline'

// Show copyable error dialog for uncaught exceptions
process.on('uncaughtException', (error) => {
  const detail = `${error.message}\n\n${error.stack || ''}`
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Error',
    message: 'A JavaScript error occurred in the main process',
    detail,
    buttons: ['Copy Error & Close', 'Close'],
    defaultId: 0
  })
  if (choice === 0) {
    clipboard.writeText(detail)
  }
  app.exit(1)
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
      const { GoogleGenerativeAI } = await import('@google/generative-ai')
      const genAI = new GoogleGenerativeAI(apiKey)
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

      const result = await model.generateContent(
        `You are a direct-response advertising copywriter. Given the transcript of a short video hook clip, generate punchy on-screen text (1-5 words) that would grab attention when overlaid on the video. The text should be a bold hook phrase, NOT a summary. Return ONLY the text, no quotes, no explanation.\n\nTranscript: "${transcript}"`
      )

      return result.response.text().trim()
    }
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
