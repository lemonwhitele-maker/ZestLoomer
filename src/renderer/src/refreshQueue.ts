/** One flight plus a trailing pass. Requests arriving during a pass are never dropped. */
export class RefreshQueue {
  private pending = false
  private force = false
  private flight: Promise<void> | null = null
  constructor(private run: (force: boolean) => Promise<void>) {}

  request(force = false): Promise<void> {
    this.pending = true
    this.force ||= force
    if (!this.flight) {
      this.flight = Promise.resolve().then(async () => {
        try {
          while (this.pending) {
            this.pending = false
            const force = this.force
            this.force = false
            await this.run(force)
          }
        } finally {
          this.flight = null
        }
      })
    }
    return this.flight
  }
}
