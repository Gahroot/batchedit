# BatchEdit

Electron + React 19 desktop app that mass-produces short-form video ads by taking clips in three buckets (Hook, Meat, CTA), generating the Cartesian product `hooks × meats × ctas`, and batch-rendering each hook→meat→cta concatenation with FFmpeg, optional burned-in Whisper captions, and text/image overlays.

## Processes & Key Modules

Three Electron targets built by electron-vite: `main/`, `preload/`, `renderer/`.

- `src/main/render-pipeline.ts` — the core (largest file). Two-phase batch render over IPC `render:batch`: Phase 1 normalizes each *unique* clip once (disk cache keyed by `sourcePath:mtime:WxH:autoResize`) so reuse across permutations is cheap; Phase 2 splits jobs into a stream-copy fast path (no overlays) and a single-encode slow path (overlays/captions). Generates ASS subtitles (caption animations: `karaoke-fill`, `word-pop`, `fade-in`, `glow`). Inputs flowing into FFmpeg filter strings are sanitized via allowlist regexes — treat this as a security boundary.
- `src/main/ffmpeg.ts` — FFmpeg/ffprobe binary setup, GPU encoder detection (`h264_nvenc/vaapi/qsv`) with `libx264` fallback.
- `src/main/safe-zones.ts` — per-platform (TikTok/Reels/Shorts) dead-zone layout on a 1080×1920 canvas.
- `src/shared/` — code used by BOTH main and renderer: `marker-detection.ts` (spoken "Hook 1"/"CTA 3" detection, fuzzy + homophones) and `types.ts`.
- `src/renderer/src/store.ts` — Zustand store; buckets, settings, `CAPTION_PRESETS`, permutation counts.
- `src/preload/index.ts` + `index.d.ts` — typed contextBridge API; keep these in sync.

## Cross-Process Quirks (non-obvious)

- **Whisper is split across processes.** Audio extraction runs in main (`ffmpeg:extractAudio` → 16kHz mono WAV → `ffmpeg:readAudioBuffer` → Float32 PCM), but ASR runs in the renderer Web Worker (`workers/whisper.worker.ts`, `@huggingface/transformers` on WebGPU). The renderer sends raw word chunks in `job.captionData`; **main generates the final ASS** after probing normalized durations so timing matches.
- **Boundary QA also uses renderer Whisper.** Main requests transcription through `qaBridge` (`qa:transcribe`), fulfilled by `useQaTranscribeBridge`.
- Transcription and normalization are both cached per clip path, so a clip reused across many permutations is processed once.

## Commands (npm; Node >=22, see `.nvmrc`)

| Task | Command |
|---|---|
| Dev (hot reload) | `npm run dev` |
| Build + typecheck | `npm run build` (alias: `npm run typecheck` — both are `electron-vite build`; there is no standalone `tsc`) |
| Lint/format | `npm run lint` (`biome lint`), `npm run format:check` |
| Renderer + shared tests | `npm test` (vitest, jsdom) |
| Main-process tests | `npm run test:main` (vitest, node env, separate config) |
| Package | `npm run build:mac` / `build:win` / `build:linux` |

Tests are co-located (`*.test.ts(x)`) and split into two suites: `vitest.config.ts` (jsdom, `src/**`) and `vitest.config.main.ts` (node, `src/main/**`). `npm test` does NOT run main-process tests — run `test:main` for those.

## Project-Specific Constraints

- Tooling is **Biome** (lint + format), not ESLint/Prettier. `format:check` only checks `README.md ARCHITECTURE.md biome.json`, not the source tree.
- `src/renderer/src/components/ui/` is shadcn/ui — regenerate via `npx shadcn@latest add <component>` rather than hand-editing.
- Bundled binaries (`ffmpeg-static`, `@ffprobe-installer`) are `asarUnpack`ed and caption fonts ship from `resources/fonts/`; `postinstall` runs `electron-builder install-app-deps`.
- Path alias `@/` → `src/renderer/src/`. Config file is `electron.vite.config.ts` (dot).
- Secrets: the Gemini API key is used only for optional hook-text generation — keep it out of committed code and logs.
