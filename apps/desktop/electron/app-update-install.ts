/** All update exits (including normal quit) share this gate. */
export class AppUpdateInstaller {
  private pending?: Promise<void>
  approved = false

  private readonly options: {
    ready: () => boolean
    blocker: () => string | undefined
    prepare: () => Promise<void>
    install: () => void
  }

  constructor(options: AppUpdateInstaller['options']) { this.options = options }

  get preparing() { return Boolean(this.pending) }

  install(): Promise<void> {
    if (this.pending) return this.pending
    if (this.approved) return Promise.resolve()
    if (!this.options.ready()) return Promise.reject(new Error('更新尚未下载完成。'))
    const reason = this.options.blocker()
    if (reason) return Promise.reject(new Error(reason))
    // Defer work until the lock is visible, including synchronous failure paths.
    this.pending = Promise.resolve().then(async () => {
      await this.options.prepare()
      const reason = this.options.blocker()
      if (reason) throw new Error(reason)
      this.approved = true
      try { this.options.install() }
      catch (error) { this.approved = false; throw error }
    }).finally(() => { this.pending = undefined })
    return this.pending
  }
}
