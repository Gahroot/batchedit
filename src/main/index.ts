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
      const { GoogleGenerativeAI } = await import('@google/generative-ai')
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
