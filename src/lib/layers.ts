import type { DitherMode, DitherOptions, Layout, LensState, PaletteColor, Specimen } from './types'
import { elaInWorker, opticsWorkerSupported } from './opticsWorker'
import {
  MAX_WORKING_EDGE,
  chromaSeedFromPixels,
  elaFromPixels,
  luminanceFromPixels,
} from './opticsCore'

export type { DitherOptions }

export { MAX_WORKING_EDGE }
/**
 * The ELA layer is normalised per image so that this gain renders it at
 * reference brightness. Gain above/below becomes a cheap canvas brightness
 * filter instead of a repaint.
 */
export const ELA_REFERENCE_GAIN = 22

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  return canvas
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas context unavailable')
  return ctx
}

export function loadImage(src: string, crossOrigin: string | null = 'anonymous'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Remote pixels must be requested CORS-clean before decode, or every
    // getImageData/toDataURL touching this canvas throws a SecurityError.
    if (crossOrigin && /^https?:/i.test(src)) img.crossOrigin = crossOrigin
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = src
  })
}

/** Prove the canvas is readable before any lens depends on it. */
export function assertCanvasReadable(canvas: HTMLCanvasElement): boolean {
  try {
    // A single pixel read is enough: a tainted canvas throws here exactly as it
    // would on export, and skipping the full-canvas toDataURL saves the main
    // thread ~40 ms on every 1400 px specimen.
    ctx2d(canvas).getImageData(0, 0, 1, 1)
    return true
  } catch {
    return false
  }
}

/** Clamp an incoming bitmap to the working resolution while preserving aspect ratio. */
export function clampToWorking(bitmap: ImageBitmap): {
  canvas: HTMLCanvasElement
  w: number
  h: number
} {
  const longest = Math.max(bitmap.width, bitmap.height)
  const scale = Math.min(1, MAX_WORKING_EDGE / longest)
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = makeCanvas(w, h)
  const ctx = ctx2d(canvas)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  return { canvas, w, h }
}

export function buildLuminance(canvas: HTMLCanvasElement): Uint8Array {
  const { width: w, height: h } = canvas
  return luminanceFromPixels(ctx2d(canvas).getImageData(0, 0, w, h).data, w, h)
}

/** Put a prepared pixel buffer on a fresh canvas (worker results arrive this way). */
export function canvasFromPixels(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
): HTMLCanvasElement {
  const canvas = makeCanvas(w, h)
  ctx2d(canvas).putImageData(new ImageData(pixels, w, h), 0, 0)
  return canvas
}

/* --------------------------------------------------------------- ELA --- */

export interface ElaLayer {
  canvas: HTMLCanvasElement
  raw: Uint8Array
  w: number
  h: number
  /** Amplification applied to the raw deltas by the per-image normalisation. */
  normalization: number
  /** 99.5th percentile of the raw deltas, used as the normalisation anchor. */
  p995: number
}

/**
 * Real Error Level Analysis: re-encode the specimen at JPEG q0.75, decode it,
 * and keep the absolute per-channel difference.
 *
 * The deltas are then normalised per image: the 99.5th percentile of local
 * error is mapped near white, so a smooth facade and a noisy night street both
 * produce a readable heatmap, while spatially hotter regions (a splice) stay
 * proportionally brighter. Without this, a single fixed multiplier leaves most
 * photographs almost black.
 */
export async function buildElaLayer(source: HTMLCanvasElement): Promise<ElaLayer> {
  const w = source.width
  const h = source.height

  if (opticsWorkerSupported()) {
    try {
      const pixels = ctx2d(source).getImageData(0, 0, w, h).data
      const result = await elaInWorker(pixels, w, h, 0.75)
      return {
        canvas: canvasFromPixels(result.pixels, w, h),
        raw: result.raw,
        w,
        h,
        normalization: result.normalization,
        p995: result.p995,
      }
    } catch {
      // The worker is a performance path, not a requirement: fall through.
    }
  }

  return buildElaLayerLocal(source, w, h)
}

/** Main-thread fallback for engines without a usable worker. */
async function buildElaLayerLocal(
  source: HTMLCanvasElement,
  w: number,
  h: number,
): Promise<ElaLayer> {
  const original = ctx2d(source).getImageData(0, 0, w, h).data
  const url = source.toDataURL('image/jpeg', 0.75)
  const img = await loadImage(url)

  const scratch = makeCanvas(w, h)
  const sctx = ctx2d(scratch)
  sctx.drawImage(img, 0, 0, w, h)
  const compressed = sctx.getImageData(0, 0, w, h).data

  // Shared with the worker: identical maths on both paths, so a fallback build
  // is pixel-identical to a worker build.
  const { display, raw, normalization, p995 } = elaFromPixels(original, compressed, w, h)
  return { canvas: paintEla(display, w, h), raw, w, h, normalization, p995 }
}

export function paintEla(raw: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const canvas = makeCanvas(w, h)
  const ctx = ctx2d(canvas)
  const image = ctx.createImageData(w, h)
  const d = image.data
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    d[i] = raw[j]
    d[i + 1] = raw[j + 1]
    d[i + 2] = raw[j + 2]
    d[i + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

export interface ElaStats {
  /** Mean amplified delta inside the region, as a percentage of 255. */
  pct: number
  mean: number
  p99: number
  sampleCount: number
}

export function elaStats(
  raw: Uint8Array,
  w: number,
  h: number,
  rect: { x: number; y: number; w: number; h: number },
): ElaStats {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(w, Math.ceil(rect.x + rect.w))
  const y1 = Math.min(h, Math.ceil(rect.y + rect.h))
  const values: number[] = []
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 3
      const v = (raw[i] + raw[i + 1] + raw[i + 2]) / 3
      sum += v
      count++
      values.push(v)
    }
  }
  values.sort((a, b) => a - b)
  const p99 = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.99))] : 0
  const mean = count ? sum / count : 0
  return { pct: (mean / 255) * 100, mean, p99, sampleCount: count }
}

/* ------------------------------------------------------------- Sobel --- */

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

const EDGE_BG: [number, number, number] = [7, 12, 16]
const EDGE_CYAN: [number, number, number] = [90, 226, 255]
const EDGE_AMBER: [number, number, number] = [255, 176, 0]

/** Sobel edge magnitude rendered as a cyan/amber blueprint map. */
export function buildSobelLayer(lum: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const canvas = makeCanvas(w, h)
  const ctx = ctx2d(canvas)
  const image = ctx.createImageData(w, h)
  const d = image.data
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1]
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1]

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let sx = 0
      let sy = 0
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const v = lum[(y - 1 + ky) * w + (x - 1 + kx)]
          const k = ky * 3 + kx
          sx += v * gx[k]
          sy += v * gy[k]
        }
      }
      const mag = Math.min(255, Math.hypot(sx, sy))
      const t = mag / 255
      const colour = t > 0.62 ? mix(EDGE_CYAN, EDGE_AMBER, (t - 0.62) / 0.38) : mix(EDGE_BG, EDGE_CYAN, t / 0.62)
      const i = (y * w + x) * 4
      d[i] = colour[0]
      d[i + 1] = colour[1]
      d[i + 2] = colour[2]
      d[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

/* ------------------------------------------------------------ dither --- */

function buildBayer(size: number): Float32Array {
  let matrix: number[][] = [[0]]
  while (matrix.length < size) {
    const n = matrix.length
    const next: number[][] = Array.from({ length: n * 2 }, () => new Array(n * 2).fill(0))
    for (let y = 0; y < n * 2; y++) {
      for (let x = 0; x < n * 2; x++) {
        const quadrant = (y >= n ? 2 : 0) + (x >= n ? 1 : 0)
        next[y][x] = matrix[y % n][x % n] * 4 + [0, 2, 3, 1][quadrant]
      }
    }
    matrix = next
  }
  const out = new Float32Array(size * size)
  const max = size * size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out[y * size + x] = matrix[y][x] / max
  }
  return out
}

export const BAYER_8 = buildBayer(8)

/**
 * Dither a source-space rectangle into an output ImageData.
 * Phase is derived from absolute source coordinates, so the pattern stays
 * continuous as the lens moves across the photograph.
 */
export function ditherRegion(
  lum: Uint8Array,
  w: number,
  h: number,
  rect: { x: number; y: number; w: number; h: number },
  outW: number,
  outH: number,
  opts: DitherOptions,
): ImageData {
  const canvas = makeCanvas(outW, outH)
  const ctx = ctx2d(canvas)
  const image = ctx.createImageData(outW, outH)
  const d = image.data
  const step = Math.max(1, opts.dotScale)
  const bias = (opts.threshold - 128) / 128
  const [ir, ig, ib] = opts.ink
  const [pr, pg, pb] = opts.paper

  if (opts.mode === 'bayer') {
    for (let y = 0; y < outH; y++) {
      const sy = Math.floor(rect.y + (y * rect.h) / outH)
      for (let x = 0; x < outW; x++) {
        const sx = Math.floor(rect.x + (x * rect.w) / outW)
        const qx = Math.max(0, Math.min(w - 1, Math.floor(sx / step) * step))
        const qy = Math.max(0, Math.min(h - 1, Math.floor(sy / step) * step))
        const v = lum[qy * w + qx] / 255
        const bx = Math.floor(qx / step) % 8
        const by = Math.floor(qy / step) % 8
        const t = BAYER_8[by * 8 + bx]
        const lit = v + bias * 0.5 > t
        const i = (y * outW + x) * 4
        d[i] = lit ? ir : pr
        d[i + 1] = lit ? ig : pg
        d[i + 2] = lit ? ib : pb
        d[i + 3] = 255
      }
    }
    return image
  }

  // Atkinson error diffusion over the sampled region.
  const buffer = new Float32Array(outW * outH)
  for (let y = 0; y < outH; y++) {
    const sy = Math.floor(rect.y + (y * rect.h) / outH)
    for (let x = 0; x < outW; x++) {
      const sx = Math.floor(rect.x + (x * rect.w) / outW)
      const qx = Math.max(0, Math.min(w - 1, Math.floor(sx / step) * step))
      const qy = Math.max(0, Math.min(h - 1, Math.floor(sy / step) * step))
      buffer[y * outW + x] = lum[qy * w + qx] + bias * 90
    }
  }
  const spread = (x: number, y: number, err: number) => {
    if (x < 0 || y < 0 || x >= outW || y >= outH) return
    buffer[y * outW + x] += err / 8
  }
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const i = y * outW + x
      const old = buffer[i]
      const lit = old > 127.5
      const value = lit ? 255 : 0
      const err = old - value
      buffer[i] = value
      spread(x + 1, y, err)
      spread(x + 2, y, err)
      spread(x - 1, y + 1, err)
      spread(x, y + 1, err)
      spread(x + 1, y + 1, err)
      spread(x, y + 2, err)
      const o = i * 4
      d[o] = lit ? ir : pr
      d[o + 1] = lit ? ig : pg
      d[o + 2] = lit ? ib : pb
      d[o + 3] = 255
    }
  }
  return image
}

/* ----------------------------------------------------------- palette --- */

export function hexOf(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

function bucketDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)
}

/**
 * Bucket-quantise the pixels strictly inside the lens circle, then greedily
 * choose five perceptually separated dominant colours.
 */
export function extractPalette(
  image: ImageData,
  cx: number,
  cy: number,
  radius: number,
): PaletteColor[] {
  const { data, width, height } = image
  const r2 = radius * radius
  const buckets = new Map<number, { r: number; g: number; b: number; n: number; sx: number; sy: number }>()

  for (let y = 0; y < height; y++) {
    const dy = y - cy
    for (let x = 0; x < width; x++) {
      const dx = x - cx
      if (dx * dx + dy * dy > r2) continue
      const o = (y * width + x) * 4
      if (data[o + 3] < 8) continue
      const r = data[o]
      const g = data[o + 1]
      const b = data[o + 2]
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      const existing = buckets.get(key)
      if (existing) {
        existing.r += r
        existing.g += g
        existing.b += b
        existing.n++
      } else {
        buckets.set(key, { r, g, b, n: 1, sx: x, sy: y })
      }
    }
  }

  const list = [...buckets.values()]
    .map((b) => {
      const r = b.r / b.n
      const g = b.g / b.n
      const bv = b.b / b.n
      const mx = Math.max(r, g, bv)
      const mn = Math.min(r, g, bv)
      const sat = mx === 0 ? 0 : (mx - mn) / mx
      // A harvester should surface chromatic clusters, not just the largest
      // shadow. Damped frequency × strong saturation weighting keeps the
      // palette colourful while the per-colour share stays truthful.
      return {
        r,
        g: g,
        b: bv,
        n: b.n,
        sx: b.sx,
        sy: b.sy,
        weight:
          Math.pow(b.n, 0.6) * Math.pow(0.05 + sat, 1.5) * Math.pow(0.1 + mx / 255, 1.2),
      }
    })
    .sort((a, b) => b.weight - a.weight)

  const chosen: typeof list = []
  for (const candidate of list) {
    if (chosen.length >= 5) break
    if (chosen.every((c) => bucketDistance(c, candidate) > 52)) chosen.push(candidate)
  }
  for (const candidate of list) {
    if (chosen.length >= 5) break
    if (!chosen.includes(candidate)) chosen.push(candidate)
  }

  const total = chosen.reduce((s, c) => s + c.n, 0) || 1
  return chosen.map((c) => ({
    hex: hexOf(c.r, c.g, c.b),
    r: Math.round(c.r),
    g: Math.round(c.g),
    b: Math.round(c.b),
    share: c.n / total,
    nx: Math.max(-1, Math.min(1, (c.sx - cx) / Math.max(1, radius))),
    ny: Math.max(-1, Math.min(1, (c.sy - cy) / Math.max(1, radius))),
  }))
}

export function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

export function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const light = Math.max(la, lb)
  const dark = Math.min(la, lb)
  return (light + 0.05) / (dark + 0.05)
}

export function wcagGrade(ratio: number): string {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA LARGE'
  return 'FAIL'
}

/* -------------------------------------------------------- geometry --- */

/**
 * The single authoritative lens → working-canvas rectangle. Every filter,
 * magnifier and sampler derives from this, so a lens can never drift against
 * the base photograph at any window size.
 */
export function sourceRectOf(
  lens: LensState,
  specimen: Specimen,
  layout: Layout,
): { x: number; y: number; w: number; h: number; cx: number; cy: number; r: number } {
  const cx = lens.x * specimen.w
  const cy = lens.y * specimen.h
  const r = Math.min(lens.radius / Math.max(0.0001, layout.scale), Math.min(specimen.w, specimen.h) / 2)
  const x = Math.max(0, Math.min(specimen.w - 2 * r, cx - r))
  const y = Math.max(0, Math.min(specimen.h - 2 * r, cy - r))
  return { x, y, w: r * 2, h: r * 2, cx: x + r, cy: y + r, r }
}

/** Exact client → working-pixel mapping: (clientX − rect.left) · (canvas.width / rect.width). */
export function clientToSource(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  specimen: Specimen,
): { x: number; y: number } {
  const sx = specimen.w / Math.max(1, rect.width)
  const sy = specimen.h / Math.max(1, rect.height)
  return {
    x: Math.max(0, Math.min(specimen.w - 1, (clientX - rect.left) * sx)),
    y: Math.max(0, Math.min(specimen.h - 1, (clientY - rect.top) * sy)),
  }
}

/* ------------------------------------------------------------- OKLCH --- */

export interface Oklch {
  l: number
  c: number
  h: number
}

export function srgbToOklch(r: number, g: number, b: number): Oklch {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const lr = lin(r)
  const lg = lin(g)
  const lb = lin(b)

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  const lc = Math.cbrt(l)
  const mc = Math.cbrt(m)
  const sc = Math.cbrt(s)

  const L = 0.2104542553 * lc + 0.793617785 * mc - 0.0040720468 * sc
  const A = 1.9779984951 * lc - 2.428592205 * mc + 0.4505937099 * sc
  const B = 0.0259040371 * lc + 0.7827717662 * mc - 0.808675766 * sc
  let h = (Math.atan2(B, A) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L * 100, c: Math.hypot(A, B), h }
}

export function formatOklch(r: number, g: number, b: number): string {
  const { l, c, h } = srgbToOklch(r, g, b)
  return `oklch(${l.toFixed(1)}% ${c.toFixed(3)} ${h.toFixed(1)})`
}

/* ------------------------------------------------------ chroma seed --- */

/**
 * Pick the most saturated, most varied disc in the photograph so the Chromatic
 * Harvester opens on colour rather than on a grey wall.
 */
export function findChromaSeed(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  radius: number,
): { x: number; y: number } {
  return chromaSeedFromPixels(ctx2d(canvas).getImageData(0, 0, w, h).data, w, h, radius)
}
