import {
  unwrap,
  type DocumentSnapshot,
  type LoomAPI,
  type OpenDocument,
  type Draft
} from '../../shared/documents'
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
export type SessionChange = 'edit' | 'state' | 'replace'

interface DraftTask {
  generation: number
  draft: Draft | null
}

/** A document session outlives its view. Acknowledgements only advance the saved snapshot. */
export class DocumentSession {
  document: DocumentSnapshot
  content: string
  title: string
  status: SaveStatus = 'saved'
  error = ''
  revision = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<boolean> | null = null
  private draftBaseVersion: string

  // Coalesced draft scheduling with generation barriers
  private requestGeneration = 0
  private confirmedGeneration = 0
  private inFlightTask: DraftTask | null = null
  private inFlightPromise: Promise<void> | null = null
  private pendingTask: DraftTask | null = null
  private draftError: Error | null = null

  constructor(
    readonly bookId: string,
    opened: OpenDocument,
    private api: Pick<LoomAPI, 'save' | 'draft'>,
    private changed: (change?: SessionChange) => void = () => {},
    private delay = 650
  ) {
    this.document = opened.document
    this.draftBaseVersion = opened.draft?.baseVersion ?? opened.document.version
    this.content = opened.draft?.content ?? opened.document.content
    this.title = opened.draft?.title ?? opened.document.title
    if (opened.draft) {
      this.status = opened.draft.baseVersion === opened.document.version ? 'dirty' : 'conflict'
      this.error =
        this.status === 'conflict'
          ? '已恢复旧版本草稿，请比较磁盘版本后处理。'
          : '已恢复未保存草稿。'
      if (this.status === 'dirty') this.schedule()
    }
  }

  get dirty(): boolean {
    return this.content !== this.document.content || this.title !== this.document.title
  }

  get isIdle(): boolean {
    return (
      !this.dirty &&
      !this.inFlightTask &&
      !this.pendingTask &&
      !this.pending &&
      !this.draftError &&
      this.status !== 'error' &&
      this.status !== 'conflict'
    )
  }

  edit(content: string, title = this.title): void {
    if (this.document.trashedAt) return
    this.content = content
    this.title = title
    this.revision++
    if (this.status !== 'conflict') {
      this.status = this.dirty ? 'dirty' : 'saved'
      this.error = ''
    }
    this.persistDraft()
    this.schedule()
    this.changed('edit')
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (this.status !== 'conflict' && !this.document.trashedAt)
      this.timer = setTimeout(() => {
        void this.flush()
      }, this.delay)
  }

  private persistDraft(): void {
    const draft: Draft | null = this.dirty
      ? {
          content: this.content,
          title: this.title,
          baseVersion: this.draftBaseVersion,
          savedAt: new Date().toISOString()
        }
      : null

    this.requestGeneration++
    const task: DraftTask = {
      generation: this.requestGeneration,
      draft
    }
    this.draftError = null

    if (this.inFlightTask) {
      // Coalesce: only keep the newest pending task
      this.pendingTask = task
    } else {
      this.startDraftTask(task)
    }
  }

  private startDraftTask(task: DraftTask): void {
    this.inFlightTask = task
    const promise = (async () => {
      try {
        unwrap(await this.api.draft(this.bookId, this.document.id, task.draft))
        this.confirmedGeneration = task.generation
        this.draftError = null
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.draftError = error
        this.error = `恢复草稿保存失败：${error.message}`
        this.changed()
        throw error
      } finally {
        this.inFlightTask = null
        this.inFlightPromise = null
        if (this.pendingTask) {
          const next = this.pendingTask
          this.pendingTask = null
          this.startDraftTask(next)
        }
      }
    })()
    this.inFlightPromise = promise
    // Prevent unhandled rejection; callers catch via flushDraft or flush
    promise.catch(() => {})
  }

  async flushDraft(targetGeneration = this.requestGeneration): Promise<boolean> {
    while (this.confirmedGeneration < targetGeneration) {
      if (this.draftError && !this.inFlightPromise && !this.pendingTask) {
        return false
      }
      if (this.inFlightPromise) {
        try {
          await this.inFlightPromise
        } catch {
          return false
        }
      } else if (this.pendingTask) {
        const next = this.pendingTask
        this.pendingTask = null
        this.startDraftTask(next)
      } else {
        break
      }
    }
    return !this.draftError && this.confirmedGeneration >= targetGeneration
  }

  async flush(): Promise<boolean> {
    clearTimeout(this.timer)
    if (this.pending) {
      return this.pending
    }
    // Reserve before any await (including the recovery-draft barrier).
    const operation = Promise.resolve().then(() => this.flushOnce())
    this.pending = operation
    try {
      return await operation
    } finally {
      if (this.pending === operation) this.pending = null
    }
  }

  private async flushOnce(): Promise<boolean> {
    if (this.document.trashedAt) return true
    if (this.status === 'conflict') return false
    if (this.status === 'error' || this.draftError) this.persistDraft()

    if (!this.dirty) {
      const draftOk = await this.flushDraft()
      if (!draftOk) {
        this.status = 'error'
        this.changed()
        return false
      }
      this.status = 'saved'
      this.error = ''
      this.changed()
      return true
    }

    // Freeze the content covered by this barrier, not later input arriving during it.
    const content = this.content
    const title = this.title
    const expectedVersion = this.document.version
    const draftTarget = this.requestGeneration
    const draftSaved = await this.flushDraft(draftTarget)
    if (!draftSaved) {
      this.status = 'error'
      this.changed()
      return false
    }

    this.status = 'saving'
    this.changed()

    const operation = async (): Promise<boolean> => {
      try {
        const saved = unwrap(
          await this.api.save({
            bookId: this.bookId,
            id: this.document.id,
            content,
            title,
            expectedVersion
          })
        )
        this.document = saved
        // The store trims titles. Accept that normalization only for the input acknowledged
        // by this request, so settling cannot loop and later title edits stay untouched.
        if (this.title === title && saved.title === title.trim()) this.title = saved.title
        this.draftBaseVersion = saved.version

        if (this.dirty) {
          // User typed while save was in-flight.
          // Advance base version, keep dirty in-memory, rewrite draft with new baseline.
          this.status = 'dirty'
          this.error = ''
          this.persistDraft()
          this.schedule()
          return true
        }

        this.status = 'saved'
        this.error = ''
        // Clear recovery draft through the same serial channel
        this.persistDraft()
        const clearOk = await this.flushDraft()
        if (!clearOk) {
          this.status = 'error'
          return false
        }
        return true
      } catch (error) {
        this.status =
          (error as { code?: string }).code === 'CONFLICT' ||
          (error as { code?: string }).code === 'TRASHED'
            ? 'conflict'
            : 'error'
        this.error = (error as Error).message
        return false
      } finally {
        this.changed()
      }
    }
    return operation()
  }

  async settle(): Promise<boolean> {
    if (!(await this.flush())) return false
    return this.dirty ? this.settle() : true
  }

  /** Explicit conflict choice; never silently adopts an external version. */
  useDisk(snapshot: DocumentSnapshot): void {
    clearTimeout(this.timer)
    this.document = snapshot
    this.content = snapshot.content
    this.title = snapshot.title
    this.draftBaseVersion = snapshot.version
    this.status = 'saved'
    this.error = ''
    this.revision++
    this.persistDraft()
    this.changed('replace')
  }

  rebase(snapshot: DocumentSnapshot): void {
    this.document = snapshot
    this.status = this.dirty ? 'dirty' : 'saved'
    this.error = ''
    this.draftBaseVersion = snapshot.version
    this.persistDraft()
    this.changed()
  }

  stop(): void {
    clearTimeout(this.timer)
  }
}
