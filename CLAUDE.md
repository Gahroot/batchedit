# BatchEdit

Electron desktop app that generates combinatorial video permutations from ad creative clips organized into three buckets (Hook, Meat, CTA), then batch renders them using FFmpeg with optional Whisper-powered auto-captions.

## Project Structure

```
src/
├── main/                          # Electron main process
│   ├── index.ts                   # App lifecycle, window creation, IPC handlers
│   ├── ffmpeg.ts                  # FFmpeg/ffprobe binary setup + helpers
│   └── render-pipeline.ts         # Batch render, thumbnails, ASS subtitle generation
│
├── preload/                       # IPC bridge (renderer <-> main)
│   ├── index.ts                   # contextBridge API exposure
│   └── index.d.ts                 # TypeScript types for window.api
│
└── renderer/src/                  # React 19 UI
    ├── App.tsx                    # Root layout (header, buckets, render panel)
    ├── store.ts                   # Zustand store (clips, settings, render state)
    ├── components/
    │   ├── Bucket.tsx             # Clip bucket (drag-drop, thumbnails, reorder)
    │   ├── SortableClip.tsx       # @dnd-kit sortable wrapper
    │   ├── SettingsBar.tsx        # Resolution + output directory
    │   ├── RenderPanel.tsx        # Render controls + Whisper caption pipeline
    │   ├── WhisperStatus.tsx      # Model download/transcription progress
    │   └── ui/                    # ShadCN components (do not edit manually)
    ├── hooks/useWhisper.ts        # Whisper Web Worker lifecycle hook
    ├── workers/whisper.worker.ts  # @huggingface/transformers pipeline
    └── lib/utils.ts               # cn() class merge utility
```

## Organization Rules

- **Main process code** -> `src/main/`, one file per concern
- **IPC types** -> `src/preload/index.d.ts`, keep Api interface in sync with preload bridge
- **React components** -> `src/renderer/src/components/`, one component per file
- **ShadCN UI** -> `src/renderer/src/components/ui/`, auto-generated (use `npx shadcn@latest add <component>`)
- **Hooks** -> `src/renderer/src/hooks/`
- **Workers** -> `src/renderer/src/workers/`
- Path alias: `@/` maps to `src/renderer/src/`
- Config file: `electron.vite.config.ts` (dot, not dash)

## Code Quality

After editing ANY file, run:

```bash
npx electron-vite build
```

Fix ALL errors before continuing. The build includes TypeScript type checking.

For development with hot reload:

```bash
npx electron-vite dev
```

No ESLint is configured. TypeScript strict mode is the primary quality gate.
