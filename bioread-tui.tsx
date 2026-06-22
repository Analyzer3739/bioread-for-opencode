const BOLD = 1

// ============================================================
// Color helpers
// ============================================================
function detectStride(fg: Float32Array, w: number, h: number): number {
  const cells = w * h
  if (cells <= 0) return 5
  const perCell = fg.length / cells
  if (perCell === 4 || perCell === 5) return perCell
  return 5
}

function rgbaKey(buf: Float32Array, off: number): number {
  return (
    (Math.round(buf[off] * 255) << 24) |
    (Math.round(buf[off + 1] * 255) << 16) |
    (Math.round(buf[off + 2] * 255) << 8) |
    Math.round(buf[off + 3] * 255)
  )
}

function isAlpha(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
}

// ============================================================
// Color deduplication
// Ensures every theme key has a unique RGBA.
// Duplicates get progressive ±0.004 blue channel offsets.
// ============================================================
function dedupThemeKeys(theme: any): void {
  const groups = new Map<number, string[]>()
  for (const [key, rgba] of Object.entries(theme) as [string, any][]) {
    if (!rgba?.buffer) continue
    const ck = rgbaKey(rgba.buffer, 0)
    const list = groups.get(ck) || []
    list.push(key)
    groups.set(ck, list)
  }

  for (const [, keys] of groups) {
    if (keys.length <= 1) continue
    for (let i = 1; i < keys.length; i++) {
      const buf = theme[keys[i]].buffer as Float32Array
      const step = Math.ceil(i / 2)
      const sign = i % 2 === 1 ? 1 : -1
      const shift = sign * step * 0.004
      const newB = buf[2] + shift
      if (newB >= 0 && newB <= 1) buf[2] = newB
    }
  }
}

// ============================================================
// Build skip color set from theme key names
// ============================================================
function buildColorSkipSet(theme: any, skipKeys: string[]): Set<number> {
  const skipSet = new Set<number>()
  for (const key of skipKeys) {
    const rgba = theme[key]
    if (rgba?.buffer) skipSet.add(rgbaKey(rgba.buffer, 0))
  }
  return skipSet
}

// ============================================================
// Post-process function
// ============================================================
function createProcessFn(enabled: () => boolean, strength: number, skipColors: Set<number>) {
  return function process(buffer: any, _dt: number): void {
    if (!enabled()) return

    const { char, attributes, fg } = buffer.buffers
    const w: number = buffer.width
    const h: number = buffer.height

    if (w <= 0 || h <= 0) return

    const fgStride = detectStride(fg, w, h)

    const skip = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x
        const ch = char[idx]
        if (ch === 32 || ch === 0) continue
        if (skipColors.has(rgbaKey(fg, idx * fgStride))) skip[idx] = 1
      }
    }

    for (let y = 0; y < h; y++) {
      let wordStart = -1
      let wordLen = 0
      let wordHasSkip = false

      for (let x = 0; x < w; x++) {
        const idx = y * w + x
        const ch = char[idx]

        if (isAlpha(ch) && !skip[idx]) {
          if (wordStart === -1) wordStart = idx
          wordLen++
        } else if (isAlpha(ch) && skip[idx]) {
          if (wordStart === -1) wordStart = idx
          wordLen++
          wordHasSkip = true
        } else {
          if (wordStart !== -1) {
            if (!wordHasSkip) {
              const n = Math.max(1, Math.floor(wordLen * strength))
              for (let i = 0; i < n; i++) {
                attributes[wordStart + i] |= BOLD
              }
            }
            wordStart = -1
            wordLen = 0
            wordHasSkip = false
          }
        }
      }

      if (wordStart !== -1 && !wordHasSkip) {
        const n = Math.max(1, Math.floor(wordLen * strength))
        for (let i = 0; i < n; i++) {
          attributes[wordStart + i] |= BOLD
        }
      }
    }
  }
}

// ============================================================
// Config loading
// ============================================================
interface Config {
  enabled: boolean
  strength: number
  skip: string[]
}

function defaultConfigDir(): string {
  const proc = globalThis as any
  if (typeof proc.process !== "undefined" && proc.process.env?.HOME) {
    return proc.process.env.HOME + "/.config/opencode/plugins"
  }
  return ""
}

function readConfigFile(path: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = (globalThis as any).require("fs")
    if (fs.existsSync(path)) return fs.readFileSync(path, "utf-8")
  } catch { /* fs unavailable */ }
  return null
}

async function loadConfig(api: any): Promise<Config> {
  const dir = (globalThis as any).process.env.BIOREAD_CONFIG_DIR || defaultConfigDir()
  const configPath = dir ? dir + "/bioread.json" : ""

  let raw: any = {}
  if (configPath) {
    const content = (api.fs?.readFile ? await api.fs.readFile(configPath) : null)
      ?? readConfigFile(configPath)
    if (content) {
      try { raw = JSON.parse(content) } catch { /* invalid JSON */ }
    }
  }

  return {
    enabled: raw.enabled !== false,
    strength:
      typeof raw.strength === "number" && raw.strength >= 0 && raw.strength <= 1
        ? raw.strength
        : 0.5,
    skip: Array.isArray(raw.skip) ? raw.skip : [],
  }
}

// ============================================================
// Plugin entry
// ============================================================
export default {
  id: "bioread-tui",
  tui: async (api: any) => {
    const config = await loadConfig(api)

    dedupThemeKeys(api.theme.current)
    const skipColors = buildColorSkipSet(api.theme.current, config.skip)

    let enabled = config.enabled
    const postProcessFn = createProcessFn(() => enabled, config.strength, skipColors)
    api.renderer.addPostProcessFn(postProcessFn)

    api.command.register(() => [{
      title: "Toggle Bionic Reading",
      value: "bioread.toggle",
      category: "View",
      slash: { name: "bioread" },
      onSelect: () => {
        enabled = !enabled
        api.ui.toast({
          variant: "info",
          title: "Bionic Reading",
          message: enabled ? "ON" : "OFF",
          duration: 1500,
        })
      },
    }])

    api.lifecycle.onDispose(() => {
      api.renderer.removePostProcessFn(postProcessFn)
    })
  },
}
