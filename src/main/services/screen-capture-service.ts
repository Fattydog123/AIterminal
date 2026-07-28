import { desktopCapturer, screen } from 'electron'

export interface ScreenCaptureResult {
  ok: boolean
  screenshot?: string
  width?: number
  height?: number
  error?: string
}

export class ScreenCaptureService {
  #disposed = false

  async captureScreen(displayId?: number): Promise<ScreenCaptureResult> {
    if (this.#disposed) return { ok: false, error: 'disposed' }
    try {
      const displays = screen.getAllDisplays()
      const targetDisplay = displayId !== undefined
        ? displays.find((d) => d.id === displayId)
        : screen.getPrimaryDisplay()
      if (!targetDisplay) return { ok: false, error: 'display_not_found' }

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: targetDisplay.size.width,
          height: targetDisplay.size.height,
        }
      })

      const source = sources.find((s) => s.display_id === String(targetDisplay.id))
      if (!source) {
        if (displayId !== undefined) return { ok: false, error: 'source_not_found' }
        const fallback = sources[0]
        if (!fallback) return { ok: false, error: 'no_source' }
        const dataUrl = fallback.thumbnail.toDataURL()
        return { ok: true, screenshot: dataUrl, width: targetDisplay.size.width, height: targetDisplay.size.height }
      }

      const dataUrl = source.thumbnail.toDataURL()
      return {
        ok: true,
        screenshot: dataUrl,
        width: targetDisplay.size.width,
        height: targetDisplay.size.height,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'capture_failed' }
    }
  }

  async listDisplays(): Promise<{ ok: boolean; displays?: Array<{ id: number; label: string; width: number; height: number }> }> {
    if (this.#disposed) return { ok: false }
    try {
      const displays = screen.getAllDisplays().map((d) => ({
        id: d.id,
        label: d.label || `Display ${d.id}`,
        width: d.size.width,
        height: d.size.height,
      }))
      return { ok: true, displays }
    } catch {
      return { ok: false }
    }
  }

  dispose(): void {
    this.#disposed = true
  }
}
