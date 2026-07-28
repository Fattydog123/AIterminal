import { BrowserWindow } from 'electron'

export interface BrowserControlResult {
  ok: boolean
  title?: string
  url?: string
  screenshot?: string
  error?: string
}

export class BrowserControlService {
  #window: BrowserWindow | null = null
  #disposed = false

  async navigate(url: string): Promise<BrowserControlResult> {
    if (this.#disposed) return { ok: false, error: 'disposed' }
    try {
      if (!this.#window || this.#window.isDestroyed()) {
        this.#window = new BrowserWindow({
          width: 1280,
          height: 800,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          }
        })
        this.#window.webContents.on('will-navigate', (event, navUrl) => {
          try {
            const parsed = new URL(navUrl)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') event.preventDefault()
          } catch { event.preventDefault() }
        })
        this.#window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      }
      await this.#window.loadURL(url)
      const title = this.#window.webContents.getTitle()
      return { ok: true, title, url }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'navigation_failed' }
    }
  }

  async screenshot(): Promise<BrowserControlResult> {
    if (this.#disposed || !this.#window || this.#window.isDestroyed()) {
      return { ok: false, error: 'no_page' }
    }
    try {
      const image = await this.#window.webContents.capturePage()
      const dataUrl = image.toDataURL()
      const title = this.#window.webContents.getTitle()
      const url = this.#window.webContents.getURL()
      return { ok: true, title, url, screenshot: dataUrl }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'capture_failed' }
    }
  }

  async getContent(): Promise<BrowserControlResult & { content?: string }> {
    if (this.#disposed || !this.#window || this.#window.isDestroyed()) {
      return { ok: false, error: 'no_page' }
    }
    try {
      const title = this.#window.webContents.getTitle()
      const url = this.#window.webContents.getURL()
      const content = await this.#window.webContents.executeJavaScript(
        'document.body ? document.body.innerText.slice(0, 10000) : ""'
      )
      return { ok: true, title, url, content: String(content) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'content_failed' }
    }
  }

  close(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.close()
    }
    this.#window = null
  }

  dispose(): void {
    this.#disposed = true
    this.close()
  }
}
