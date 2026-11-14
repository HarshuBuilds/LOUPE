/**
 * Pixel math shared by the main thread and the optics worker. Nothing in here
 * may touch the DOM: it runs inside a Worker where `document` does not exist.
 */

export const MAX_WORKING_EDGE = 1400

export function luminanceFromPixels(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array {
  const lum = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
    lum[p] = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) | 0
  }
  return lum
}

/**
 * Find the most vivid region of the photograph for the cold-open magnifier.
 * Peak saturation matters more than the average: a small vivid market stall
 * inside a grey facade should still win, and bright content beats tinted glass.
 */
export function chromaSeedFromPixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
): { x: number; y: number } {
  const r = Math.max(20, Math.min(radius, Math.floor(Math.min(w, h) / 2)))
  const step = Math.max(2, Math.round(r / 9))
  const hop = Math.max(10, Math.round(r / 2))
  const r2 = r * r
  let best = { score: -1, x: 0.5, y: 0.5 }

  for (let cy = r; cy <= h - r; cy += hop) {
    for (let cx = r; cx <= w - r; cx += hop) {
      let sum = 0
      let valueSum = 0
      let n = 0
      const sats: number[] = []
      for (let y = cy - r; y < cy + r; y += step) {
        const dy = y - cy
        for (let x = cx - r; x < cx + r; x += step) {
          const dx = x - cx
          if (dx * dx + dy * dy > r2) continue
          const o = (y * w + x) * 4
          const rr = data[o]
          const gg = data[o + 1]
          const bb = data[o + 2]
          const mx = Math.max(rr, gg, bb)
          const mn = Math.min(rr, gg, bb)
          const sat = mx === 0 ? 0 : (mx - mn) / mx
          sum += sat
          valueSum += mx / 255
          sats.push(sat)
          n++
        }
      }
      if (!n) continue
      sats.sort((a, b) => a - b)
      const p90 = sats[Math.floor(sats.length * 0.9)] ?? 0
      const mean = sum / n
      const score = mean * 0.3 + p90 * 0.5 + (valueSum / n) * 0.2
      if (score > best.score) best = { score, x: cx / w, y: cy / h }
    }
  }

  return { x: Math.min(0.86, Math.max(0.14, best.x)), y: Math.min(0.86, Math.max(0.14, best.y)) }
}

/**
 * Error Level Analysis from two decoded pixel buffers: the original and the
 * same image re-encoded at JPEG q0.75. Deltas are normalised per image so the
 * 99.5th percentile lands near white; the display pass is gamma only, while
 * `raw` stays linear so elaStats and the splice ratio keep their meaning.
 */
export function elaFromPixels(
  original: Uint8ClampedArray,
  compressed: Uint8ClampedArray,
  w: number,
  h: number,
): { display: Uint8Array; raw: Uint8Array; normalization: number; p995: number } {
  const pixels = w * h
  const diff = new Uint8Array(pixels * 3)
  for (let i = 0, j = 0; i < original.length; i += 4, j += 3) {
    diff[j] = Math.abs(original[i] - compressed[i])
    diff[j + 1] = Math.abs(original[i + 1] - compressed[i + 1])
    diff[j + 2] = Math.abs(original[i + 2] - compressed[i + 2])
  }

  // Anchor on the 99.5th percentile, sampled coarsely so this stays cheap.
  const samples: number[] = []
  const stride = Math.max(1, Math.floor(pixels / 16000))
  for (let p = 0; p < pixels; p += stride) {
    const i = p * 3
    samples.push((diff[i] + diff[i + 1] + diff[i + 2]) / 3)
  }
  samples.sort((a, b) => a - b)
  const p995 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.995))] ?? 1
  const normalization = Math.min(80, Math.max(3, 235 / Math.max(2, p995)))

  const raw = new Uint8Array(pixels * 3)
  for (let i = 0; i < diff.length; i++) {
    raw[i] = Math.min(255, diff[i] * normalization)
  }

  const display = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    display[i] = Math.round(255 * Math.pow(raw[i] / 255, 1.55))
  }

  return { display, raw, normalization, p995 }
}

/** Expand an RGB triple buffer into RGBA for putImageData. */
export function rgbaFromRgb(
  rgb: Uint8Array,
  w: number,
  h: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    out[i] = rgb[j]
    out[i + 1] = rgb[j + 1]
    out[i + 2] = rgb[j + 2]
    out[i + 3] = 255
  }
  return out
}
