import type { AgentTool } from '@prestyj/agent'
import type { Provider } from '@prestyj/ai'
import type { BrowserWindow } from 'electron'
import type { GOOGLE_PROVIDER } from '../google-provider'
import type { JobLedger } from '../job-ledger'

export interface ToolContextState {
  win: BrowserWindow
  sourceAllowlist: Set<string>
  clipAllowlist: Set<string>
  approvedRenderAtTurn: number | null
  jobLedger: JobLedger
  apiKey?: string
  provider?: Provider | typeof GOOGLE_PROVIDER
  model?: string
  runId: string
}

export type BatchEditAgentTool = AgentTool

export function stringifyToolResult(details: unknown): string {
  return JSON.stringify(details)
}
