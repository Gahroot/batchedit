import type { RenderProgress } from '../../renderer/src/store'

export interface JobLogEvent {
  cursor: number
  timestamp: number
  progress: RenderProgress
}

export interface JobLedgerEntry {
  jobId: string
  progress: RenderProgress | null
  events: JobLogEvent[]
}

export class JobLedger {
  private readonly jobs = new Map<string, JobLedgerEntry>()
  private nextCursor = 1

  register(jobId: string): JobLedgerEntry {
    const existing = this.jobs.get(jobId)
    if (existing) return existing
    const entry: JobLedgerEntry = { jobId, progress: null, events: [] }
    this.jobs.set(jobId, entry)
    return entry
  }

  update(jobId: string, progress: RenderProgress): void {
    const entry = this.register(jobId)
    entry.progress = progress
    entry.events.push({
      cursor: this.nextCursor,
      timestamp: Date.now(),
      progress
    })
    this.nextCursor += 1
  }

  get(jobId: string): JobLedgerEntry | null {
    return this.jobs.get(jobId) ?? null
  }

  getLog(jobId: string, since = 0): JobLogEvent[] {
    const entry = this.jobs.get(jobId)
    if (!entry) return []
    return entry.events.filter((event) => event.cursor > since)
  }
}
