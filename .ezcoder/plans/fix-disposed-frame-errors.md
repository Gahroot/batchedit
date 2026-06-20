# Fix "Render frame was disposed" error storm

## Problem

When the BrowserWindow's renderer frame is destroyed (dev hot-reload, window close, navigation), `AgentService.sendEvent()` and `callRenderer()` keep calling `webContents.send()` which throws `"Render frame was disposed before WebFrameMain could be accessed"`. The agent loop doesn't detect this and keeps retrying, producing 30+ cascading errors per turn across turns 11–14.

## Root Cause

No guard checks `win.isDestroyed()` / `win.webContents.isDestroyed()` before any IPC send. The error is thrown but never caught or used to terminate the agent run.

## Approach

Add a single `isWindowAlive(win)` helper, then apply it at every `webContents.send()` call site. Distinguish between fire-and-forget sends (drop silently) and request/reply RPC (reject immediately).

## Files to change

1. **`src/main/agent/renderer-rpc.ts`** — guard `callRenderer`: check window alive before sending; reject immediately with a descriptive error if dead. Also guard the timeout-cancellation send.

2. **`src/main/agent/service.ts`** — guard `sendEvent`: if window is dead, silently drop the event (no receiver = no point throwing). Also guard `cancel()`.

3. **`src/main/agent/tools/store-actions.ts`** — guard `ctx.win.webContents.send('agent:applyAction', ...)` (fire-and-forget, line 32).

4. **`src/main/agent/tools/review.ts`** — guard two `ctx.win.webContents.send(...)` calls (lines 53 and 66).

5. **`src/main/agent/tools/render.ts`** — guard `ctx.win.webContents.send('agent:startRender', ...)` (line 49).

## Changes per file

### `renderer-rpc.ts`
- Import nothing extra; use `win.isDestroyed()` (available on BrowserWindow) and `win.webContents.isDestroyed()` (available on WebContents).
- At top of `callRenderer`, before creating the promise: if window is dead, reject immediately.
- In the timeout callback and abort callback: guard the `webContents.send(...)` cancel call.

### `service.ts`
- In `sendEvent`: wrap `this.win.webContents.send(...)` in an `isWindowAlive` check. If dead, return silently. Log once at info level on first detection per run to avoid spam.
- In `cancel`: guard the `webContents.send('agent:event', ...)` call.
- In `runAgent`: after the `catch`/`finally`, the `currentRun` is already cleared — no change needed there.

### `tools/store-actions.ts`, `tools/review.ts`, `tools/render.ts`
- Guard each direct `ctx.win.webContents.send(...)` with an alive check. These are fire-and-forget sends — just skip if window is dead.

## Verification

1. `npm run typecheck` — no type errors
2. `npm run test:main` — existing tests pass
3. Manual: run agent, close devtools or trigger hot-reload mid-run → no error storm in logs, agent terminates cleanly
