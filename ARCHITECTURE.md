# Architecture

BatchEdit is an Electron desktop app with three main layers:

- `src/main/` contains Electron main-process code for app lifecycle, IPC handlers, FFmpeg setup, rendering, thumbnails, and subtitle generation.
- `src/preload/` exposes the typed IPC bridge used by the renderer through `window.api`.
- `src/renderer/src/` contains the React UI, Zustand state, Whisper worker integration, and user-facing render controls.

The renderer collects clips into Hook, Meat, and CTA buckets, the preload bridge forwards render and filesystem requests to the main process, and the main process uses FFmpeg/ffprobe plus optional transcription data to produce batch video permutations.
