import { environmentValue } from './environment'

export class PerfCounters {
  documentReads = 0
  draftWrites = 0
  draftWriteBytes = 0
  queueWaitMs = 0
  queueExecMs = 0
  proposalDiffCount = 0
  listUpdateCount = 0
  ipcPayloadBytes = 0
  sessionCacheEstimate = 0

  enabled = false

  constructor() {
    this.enabled = typeof process !== 'undefined' && environmentValue('PERF', process.env) === '1'
  }

  countDocumentRead() {
    if (!this.enabled) return
    this.documentReads++
  }

  countDraftWrite(bytes: number) {
    if (!this.enabled) return
    this.draftWrites++
    this.draftWriteBytes += bytes
  }

  recordQueueWait(ms: number) {
    if (!this.enabled) return
    this.queueWaitMs += ms
  }

  recordQueueExec(ms: number) {
    if (!this.enabled) return
    this.queueExecMs += ms
  }

  countProposalDiff() {
    if (!this.enabled) return
    this.proposalDiffCount++
  }

  countListUpdate() {
    if (!this.enabled) return
    this.listUpdateCount++
  }

  addIpcPayloadBytes(bytes: number) {
    if (!this.enabled) return
    this.ipcPayloadBytes += bytes
  }

  setSessionCacheEstimate(bytes: number) {
    if (!this.enabled) return
    this.sessionCacheEstimate = bytes
  }

  snapshot() {
    return {
      documentReads: this.documentReads,
      draftWrites: this.draftWrites,
      draftWriteBytes: this.draftWriteBytes,
      queueWaitMs: this.queueWaitMs,
      queueExecMs: this.queueExecMs,
      proposalDiffCount: this.proposalDiffCount,
      listUpdateCount: this.listUpdateCount,
      ipcPayloadBytes: this.ipcPayloadBytes,
      sessionCacheEstimate: this.sessionCacheEstimate
    }
  }

  reset() {
    this.documentReads = 0
    this.draftWrites = 0
    this.draftWriteBytes = 0
    this.queueWaitMs = 0
    this.queueExecMs = 0
    this.proposalDiffCount = 0
    this.listUpdateCount = 0
    this.ipcPayloadBytes = 0
    this.sessionCacheEstimate = 0
  }
}

export const counters = new PerfCounters()
