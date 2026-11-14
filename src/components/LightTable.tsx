import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BAYER_8,
  ELA_REFERENCE_GAIN,
  buildElaLayer,
  buildSobelLayer,
  contrastRatio,
  ctx2d,
  ditherRegion,
  elaStats,
  extractPalette,
  formatOklch,
  hexOf,
  makeCanvas,
  sourceRectOf,
} from '../lib/layers'
import type { ElaLayer } from '../lib/layers'
import {
  blendFor,
  circlePair,
  clipVesica,
  compoundChips,
  isMagnifier,
  placeChrome,
  strokeCompoundArcs,
} from '../lib/compound'
import type { ChromeItem, Circle } from '../lib/compound'
import { buildReportCard, buildSwatchCard, exportDither, exportScrubbed } from '../lib/cards'
import { sound } from '../lib/soundEngine'
import type {
  DitherOptions,
  Layout,
  LensState,
  PaletteColor,
  PinCard,
  Specimen,
  SpliceBox,
  ThemeName,
} from '../lib/types'
import OpticalLens, { TAU } from './OpticalLens'
import type { LensProbe } from './OpticalLens'
import LensControls from './LensControls'

const ACTION_LABEL: Record<LensState['type'], string> = {
  ela: 'REPORT',
  chroma: 'SWATCH',
  dither: 'STAMP',
  sobel: 'SCRUB',
}

interface Props {
  specimen: Specimen
  lenses: LensState[]
  theme: ThemeName
  coldOpen: boolean
  onLensMove: (id: string, nx: number, ny: number) => void
  onLensParam: (id: string, patch: Partial<LensState>) => void
  onLensActivate: (id: string) => void
  onLensClose: (id: string) => void
  onEject: (pin: PinCard) => void
  onNotice: (message: string) => void
}

interface Frame {
  cx: number
  cy: number
  r: number
  src: { x: number; y: number; w: number; h: number; cx: number; cy: number; r: number }
}

function samePalettes(
  a: Record<string, PaletteColor[]>,
  b: Record<string, PaletteColor[]>,
): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  for (const key of keys) {
    const left = a[key]
    const right = b[key]
    if (!left || left.length !== right.length) return false
    for (let i = 0; i < right.length; i++) if (left[i].hex !== right[i].hex) return false
  }
  return true
}

function sameReadouts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  for (const key of keys) if (Math.abs((a[key] ?? 0) - b[key]) > 0.05) return false
  return true
}

function sameProbes(a: Record<string, LensProbe>, b: Record<string, LensProbe>): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  for (const key of keys) {
    const left = a[key]
    const right = b[key]
    if (!left || !right) return false
    if (left.hex !== right.hex || left.source !== right.source) return false
  }
  return true
}

export default function LightTable({
  specimen,
  lenses,
  theme,
  coldOpen,
  onLensMove,
  onLensParam,
  onLensActivate,
  onLensClose,
  onEject,
  onNotice,
}: Props) {
  const stageRef = useRef<HTMLElement | null>(null)
  const baseRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  const serialRef = useRef(0)
  const cacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const coldRef = useRef<Set<string>>(new Set())

  const [layout, setLayout] = useState<Layout | null>(null)
  const [layers, setLayers] = useState<{ ela: ElaLayer | null; sobel: HTMLCanvasElement | null; median: number }>({
    ela: null,
    sobel: null,
    median: 0,
  })
  const [building, setBuilding] = useState(false)
  const [palettes, setPalettes] = useState<Record<string, PaletteColor[]>>({})
  const [readouts, setReadouts] = useState<Record<string, number>>({})
  const [probes, setProbes] = useState<Record<string, LensProbe>>({})
  const [probeAnnouncement, setProbeAnnouncement] = useState('')
  const announceRef = useRef<{ timer: number | null; pending: string }>({ timer: null, pending: '' })

  const needsEla = lenses.some((lens) => lens.type === 'ela')
  const needsSobel = lenses.some((lens) => lens.type === 'sobel')

  const ordered = useMemo(() => [...lenses].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id)), [lenses])

  /* ----------------------------------------------------------- layout --- */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const rect = stage.getBoundingClientRect()
      const availW = Math.max(160, rect.width - 56)
      const availH = Math.max(160, rect.height - 56 - 92)
      const raw = Math.min(availW / specimen.w, availH / specimen.h)
      const width = Math.max(80, Math.round(specimen.w * raw))
      const height = Math.max(80, Math.round(specimen.h * raw))
      // One scale derived from the rounded width: CSS and working pixels share it.
      setLayout({ width, height, scale: width / specimen.w })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [specimen])

  /* ------------------------------------------------------------- base --- */
  useEffect(() => {
    const canvas = baseRef.current
    if (!canvas || !layout) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(layout.width * dpr)
    canvas.height = Math.round(layout.height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, layout.width, layout.height)
    ctx.drawImage(specimen.work, 0, 0, layout.width, layout.height)
  }, [specimen, layout])

  /* ------------------------------------------------------ layer build --- */
  useEffect(() => {
    let cancelled = false
    setLayers({ ela: null, sobel: null, median: 0 })
    cacheRef.current.clear()
    if (!needsEla && !needsSobel) return

    setBuilding(true)
    ;(async () => {
      try {
        const ela = needsEla ? await buildElaLayer(specimen.work) : null
        const sobel = needsSobel ? buildSobelLayer(specimen.lum, specimen.w, specimen.h) : null
        if (cancelled) return
        let median = 0
        if (ela) {
          const samples: number[] = []
          for (let i = 0; i < ela.raw.length; i += 3 * 41) samples.push(ela.raw[i])
          samples.sort((a, b) => a - b)
          // Flat facades can yield a zero median; floor it in raw units so the
          // splice ratio stays a strength measurement rather than 1/0.
          median = Math.max(samples[Math.floor(samples.length / 2)] ?? 0, ela.normalization * 0.35)
        }
        setLayers({ ela, sobel, median })
      } catch {
        if (!cancelled) onNotice('ELA PIPELINE FAILED · CANVAS REJECTED')
      } finally {
        if (!cancelled) setBuilding(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [specimen, needsEla, needsSobel, onNotice])

  /* ---------------------------------------------------------- geometry --- */
  const frameOf = useCallback(
    (lens: LensState): Frame => {
      if (!layout) {
        return { cx: 0, cy: 0, r: lens.radius, src: { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0, r: 0 } }
      }
      // Radii scale with the light table so the composed cold open keeps its
      // proportions on a laptop screen instead of collapsing into one stack.
      const fit = Math.max(0.5, Math.min(1, layout.width / 900))
      const src = sourceRectOf({ ...lens, radius: lens.radius * fit }, specimen, layout)
      return {
        cx: src.cx * layout.scale,
        cy: src.cy * layout.scale,
        r: (src.w / 2) * layout.scale,
        src,
      }
    },
    [layout, specimen],
  )

  const circleOf = useCallback(
    (lens: LensState): Circle => {
      const frame = frameOf(lens)
      return { cx: frame.cx, cy: frame.cy, r: frame.r }
    },
    [frameOf],
  )

  const ditherOptions = useMemo<DitherOptions>(
    () => ({
      dotScale: 1,
      threshold: 128,
      mode: 'bayer',
      ink: theme === 'darkroom' ? [255, 79, 0] : [17, 18, 20],
      paper: theme === 'darkroom' ? [17, 18, 20] : [250, 248, 245],
    }),
    [theme],
  )

  /* ------------------------------------------------- processed sources --- */
  const processedCanvas = useCallback(
    (lens: LensState, src: { x: number; y: number; w: number; h: number }): HTMLCanvasElement | null => {
      const w = Math.max(2, Math.round(src.w))
      const h = Math.max(2, Math.round(src.h))
      const key = [
        lens.type,
        lens.gain,
        lens.threshold,
        lens.dotScale,
        lens.mode,
        specimen.id,
        Math.round(src.x),
        Math.round(src.y),
        w,
        h,
      ].join('|')
      const cached = cacheRef.current.get(key)
      if (cached) return cached

      const canvas = makeCanvas(w, h)
      const ctx = ctx2d(canvas)
      if (lens.type === 'ela' && layers.ela) {
        ctx.filter = `brightness(${(lens.gain / ELA_REFERENCE_GAIN).toFixed(3)})`
        ctx.drawImage(layers.ela.canvas, src.x, src.y, src.w, src.h, 0, 0, w, h)
        ctx.filter = 'none'
      } else if (lens.type === 'sobel' && layers.sobel) {
        ctx.drawImage(layers.sobel, src.x, src.y, src.w, src.h, 0, 0, w, h)
      } else if (lens.type === 'dither') {
        const options: DitherOptions = {
          ...ditherOptions,
          dotScale: lens.dotScale,
          threshold: lens.threshold,
          mode: lens.mode,
        }
        ctx.putImageData(ditherRegion(specimen.lum, specimen.w, specimen.h, src, w, h, options), 0, 0)
      } else {
        return null
      }

      if (cacheRef.current.size > 24) cacheRef.current.clear()
      cacheRef.current.set(key, canvas)
      return canvas
    },
    [layers, specimen, ditherOptions],
  )

  /* ------------------------------------------------------------ render --- */
  const render = useCallback(() => {
    const canvas = overlayRef.current
    if (!canvas || !layout) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const width = Math.round(layout.width * dpr)
    const height = Math.round(layout.height * dpr)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.scale(dpr, dpr)

    const drawZoom = (
      source: CanvasImageSource,
      fullSource: boolean,
      frame: Frame,
      zoom: number,
    ) => {
      const { src } = frame
      const sw = src.w / zoom
      const sh = src.h / zoom
      const sx = fullSource ? src.x + (src.w - sw) / 2 : (src.w - sw) / 2
      const sy = fullSource ? src.y + (src.h - sh) / 2 : (src.h - sh) / 2
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(source, sx, sy, sw, sh, frame.cx - frame.r, frame.cy - frame.r, frame.r * 2, frame.r * 2)
      ctx.imageSmoothingEnabled = true
    }

    const paintFilter = (lens: LensState, frame: Frame) => {
      const { src } = frame
      if (lens.type === 'ela' && layers.ela) {
        ctx.filter = `brightness(${(lens.gain / ELA_REFERENCE_GAIN).toFixed(3)})`
        ctx.drawImage(layers.ela.canvas, src.x, src.y, src.w, src.h, frame.cx - frame.r, frame.cy - frame.r, frame.r * 2, frame.r * 2)
        ctx.filter = 'none'
        return
      }
      if (lens.type === 'sobel' && layers.sobel) {
        ctx.drawImage(layers.sobel, src.x, src.y, src.w, src.h, frame.cx - frame.r, frame.cy - frame.r, frame.r * 2, frame.r * 2)
        ctx.strokeStyle = 'rgba(90,226,255,0.16)'
        ctx.lineWidth = 1
        ctx.beginPath()
        const step = 26
        for (let x = frame.cx - frame.r + step; x < frame.cx + frame.r; x += step) {
          ctx.moveTo(x, frame.cy - frame.r)
          ctx.lineTo(x, frame.cy + frame.r)
        }
        for (let y = frame.cy - frame.r + step; y < frame.cy + frame.r; y += step) {
          ctx.moveTo(frame.cx - frame.r, y)
          ctx.lineTo(frame.cx + frame.r, y)
        }
        ctx.stroke()
        return
      }
      if (lens.type === 'dither') {
        const outScale = Math.min(dpr, 1.5)
        const outW = Math.max(8, Math.round(2 * frame.r * outScale))
        const outH = outW
        const options: DitherOptions = {
          ...ditherOptions,
          dotScale: lens.dotScale,
          threshold: lens.threshold,
          mode: lens.mode,
        }
        const image = ditherRegion(specimen.lum, specimen.w, specimen.h, src, outW, outH, options)
        let scratch = scratchRef.current
        if (!scratch) {
          scratch = makeCanvas(outW, outH)
          scratchRef.current = scratch
        }
        if (scratch.width !== outW || scratch.height !== outH) {
          scratch.width = outW
          scratch.height = outH
        }
        scratch.getContext('2d')?.putImageData(image, 0, 0)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(scratch, frame.cx - frame.r, frame.cy - frame.r, frame.r * 2, frame.r * 2)
        ctx.imageSmoothingEnabled = true
      }
    }

    const paintChroma = (lens: LensState, frame: Frame) => {
      drawZoom(specimen.work, true, frame, 2.5)

      // Compound case 1: magnify what the overlapping filter has produced —
      // whichever side of the magnifier it sits on. A physical loupe reads
      // through the filter in front of it, so stacking order cannot hide this.
      const self = { cx: frame.cx, cy: frame.cy, r: frame.r }
      const filtersUnder: LensState[] = ordered
        .filter((other) => !isMagnifier(other.type))
        .filter((other) => circlePair(circleOf(other), self).hit)
        .sort((a, b) => a.z - b.z)

      for (const under of filtersUnder) {
        const source = processedCanvas(under, frame.src)
        if (!source) continue
        ctx.save()
        clipVesica(ctx, circleOf(under), self)
        drawZoom(source, false, frame, 2.5)
        ctx.restore()
      }

      // Crisp source-pixel grid.
      const px = layout.scale * 2.5
      const step = px < 3 ? Math.ceil(4 / px) * px : px
      ctx.strokeStyle = 'rgba(255,255,255,0.11)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = frame.cx - frame.r + step; x < frame.cx + frame.r; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, frame.cy - frame.r)
        ctx.lineTo(Math.round(x) + 0.5, frame.cy + frame.r)
      }
      for (let y = frame.cy - frame.r + step; y < frame.cy + frame.r; y += step) {
        ctx.moveTo(frame.cx - frame.r, Math.round(y) + 0.5)
        ctx.lineTo(frame.cx + frame.r, Math.round(y) + 0.5)
      }
      ctx.stroke()

      // Centre reticle: segmented crosshair + sampled pixel tick.
      const cxr = Math.round(frame.cx) + 0.5
      const cyr = Math.round(frame.cy) + 0.5
      ctx.strokeStyle = 'rgba(243,242,238,0.62)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cxr - 24, cyr)
      ctx.lineTo(cxr - 7, cyr)
      ctx.moveTo(cxr + 7, cyr)
      ctx.lineTo(cxr + 24, cyr)
      ctx.moveTo(cxr, cyr - 24)
      ctx.lineTo(cxr, cyr - 7)
      ctx.moveTo(cxr, cyr + 7)
      ctx.lineTo(cxr, cyr + 24)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,79,0,0.95)'
      ctx.strokeRect(cxr - 3.5, cyr - 3.5, 7, 7)
    }

    const filters = ordered.filter((lens) => !isMagnifier(lens.type))
    const chromas = ordered.filter((lens) => isMagnifier(lens.type))

    const paintGlass = (frame: Frame) => {
      const glass = ctx.createRadialGradient(
        frame.cx - frame.r * 0.32,
        frame.cy - frame.r * 0.38,
        frame.r * 0.08,
        frame.cx,
        frame.cy,
        frame.r,
      )
      glass.addColorStop(0, 'rgba(255,255,255,0.10)')
      glass.addColorStop(0.62, 'rgba(255,255,255,0.015)')
      glass.addColorStop(1, 'rgba(0,0,0,0.45)')
      ctx.fillStyle = glass
      ctx.fillRect(frame.cx - frame.r, frame.cy - frame.r, frame.r * 2, frame.r * 2)
    }

    const paintRim = (circle: Circle) => {
      ctx.beginPath()
      ctx.arc(circle.cx, circle.cy, circle.r + 0.5, 0, TAU)
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Pass 1 — filter lenses, in stacking order. Magnifiers repaint their whole
    // circle opaquely in pass 3, so a filter never needs clipping around them.
    for (const lens of filters) {
      const frame = frameOf(lens)
      const circle = circleOf(lens)
      ctx.save()
      ctx.beginPath()
      ctx.arc(circle.cx, circle.cy, circle.r, 0, TAU)
      ctx.clip()
      paintFilter(lens, frame)
      paintGlass(frame)
      ctx.restore()
      ctx.save()
      paintRim(circle)
      ctx.restore()
    }

    // Pass 2 — filter/filter overlaps are composited inside the vesica.
    for (let i = 0; i < filters.length; i++) {
      for (let j = i + 1; j < filters.length; j++) {
        const lower = filters[i]
        const upper = filters[j]
        const a = circleOf(lower)
        const b = circleOf(upper)
        const pair = circlePair(a, b)
        if (!pair.hit) continue
        ctx.save()
        clipVesica(ctx, a, b)
        paintFilter(lower, frameOf(lower))
        ctx.globalCompositeOperation = blendFor(lower.type, upper.type)
        paintFilter(upper, frameOf(upper))
        ctx.restore()
      }
    }

    // Pass 3 — magnifiers last, so a filter dragged over them compounds instead
    // of hiding the glass.
    for (const lens of chromas) {
      const frame = frameOf(lens)
      const circle = circleOf(lens)
      ctx.save()
      ctx.beginPath()
      ctx.arc(circle.cx, circle.cy, circle.r, 0, TAU)
      ctx.clip()
      paintChroma(lens, frame)
      paintGlass(frame)
      ctx.restore()
      ctx.save()
      paintRim(circle)
      ctx.restore()
    }

    // Pass 4 — compound indicators.
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const pair = circlePair(circleOf(ordered[i]), circleOf(ordered[j]))
        if (pair.hit) strokeCompoundArcs(ctx, pair)
      }
    }
  }, [ordered, layout, layers, specimen, ditherOptions, frameOf, circleOf, processedCanvas])

  useEffect(() => {
    const frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [render])

  /**
   * The probe numerals live inside a lens bezel, which a screen reader cannot
   * follow. Mirror the newest sample into a polite live region, throttled: a
   * drag samples every frame and a 60 Hz announcement is worse than none.
   */
  useEffect(() => {
    const entries = Object.values(probes)
    if (!entries.length) {
      setProbeAnnouncement('')
      return
    }
    const latest = entries[entries.length - 1]
    const next = `${latest.source} at 2.5× · RGB ${latest.r} ${latest.g} ${latest.b} · ${latest.hex}`
    const slot = announceRef.current
    if (next === slot.pending) return
    slot.pending = next
    if (slot.timer !== null) return
    slot.timer = window.setTimeout(() => {
      slot.timer = null
      setProbeAnnouncement(slot.pending)
    }, 700)
  }, [probes])

  useEffect(
    () => () => {
      if (announceRef.current.timer !== null) window.clearTimeout(announceRef.current.timer)
    },
    [],
  )

  /* ---------------------------------------------------------- sampling --- */
  const underFor = useCallback(
    (lens: LensState): LensState | null => {
      const self = circleOf(lens)
      const candidates = ordered
        .filter((other) => !isMagnifier(other.type))
        .filter((other) => circlePair(circleOf(other), self).hit)
      if (!candidates.length) return null
      // Prefer the filter actually beneath the reticle; otherwise the one that
      // would be painted on top, so the readout names the visible result.
      const containing = candidates.filter((other) => {
        const circle = circleOf(other)
        return Math.hypot(self.cx - circle.cx, self.cy - circle.cy) <= circle.r
      })
      const pool = containing.length ? containing : candidates
      return [...pool].sort((a, b) => b.z - a.z)[0]
    },
    [ordered, circleOf],
  )

  useEffect(() => {
    if (!layout) return
    const wantsChroma = lenses.some((lens) => lens.type === 'chroma')
    const wantsEla = lenses.some((lens) => lens.type === 'ela')
    if (!wantsChroma && !wantsEla) {
      setPalettes({})
      setReadouts({})
      setProbes({})
      return
    }

    let cancelled = false
    const ctx = ctx2d(specimen.work)

    const tick = () => {
      if (cancelled) return
      const nextPalettes: Record<string, PaletteColor[]> = {}
      const nextReadouts: Record<string, number> = {}
      const nextProbes: Record<string, LensProbe> = {}

      for (const lens of lenses) {
        const frame = frameOf(lens)
        const src = frame.src

        if (lens.type === 'ela' && layers.ela) {
          const stats = elaStats(layers.ela.raw, specimen.w, specimen.h, {
            x: src.x,
            y: src.y,
            w: src.w,
            h: src.h,
          })
          nextReadouts[lens.id] = stats.pct
        }

        if (lens.type !== 'chroma') continue

        const under = underFor(lens)
        try {
          const sx = Math.max(0, Math.round(src.x))
          const sy = Math.max(0, Math.round(src.y))
          const sw = Math.max(2, Math.min(specimen.w - sx, Math.round(src.w)))
          const sh = Math.max(2, Math.min(specimen.h - sy, Math.round(src.h)))
          const baseImage = ctx.getImageData(sx, sy, sw, sh)
          // The swatch always harvests the photograph in the glass, even while a
          // compound pass is magnifying a heatmap underneath it.
          nextPalettes[lens.id] = extractPalette(baseImage, src.cx - sx, src.cy - sy, src.r)

          const px = Math.max(0, Math.min(specimen.w - 1, Math.round(src.cx)))
          const py = Math.max(0, Math.min(specimen.h - 1, Math.round(src.cy)))

          let r = 0
          let g = 0
          let b = 0
          let sourceLabel = 'BASE'

          // The reticle reads whatever is literally beneath it: a filter lens in
          // a compound stack wins, otherwise the photograph itself.
          if (under) {
            const underFrame = frameOf(under).src
            const inside = Math.hypot(px - underFrame.cx, py - underFrame.cy) <= underFrame.r
            const processed = inside ? processedCanvas(under, src) : null
            if (processed) {
              const sample = ctx2d(processed).getImageData(0, 0, processed.width, processed.height)
              const localX = Math.max(0, Math.min(sample.width - 1, Math.round(px - Math.round(src.x))))
              const localY = Math.max(0, Math.min(sample.height - 1, Math.round(py - Math.round(src.y))))
              const o = (localY * sample.width + localX) * 4
              r = sample.data[o]
              g = sample.data[o + 1]
              b = sample.data[o + 2]
              sourceLabel = under.type === 'ela' ? 'ELA' : under.type === 'sobel' ? 'X-RAY' : 'DITHER'
            }
          }

          if (sourceLabel === 'BASE') {
            const o = ((py - sy) * sw + (px - sx)) * 4
            r = baseImage.data[o]
            g = baseImage.data[o + 1]
            b = baseImage.data[o + 2]
          }

          nextProbes[lens.id] = {
            r,
            g,
            b,
            hex: hexOf(r, g, b),
            oklch: formatOklch(r, g, b),
            source: sourceLabel,
          }
        } catch {
          nextPalettes[lens.id] = []
        }
      }

      setPalettes((prev) => (samePalettes(prev, nextPalettes) ? prev : nextPalettes))
      setReadouts((prev) => (sameReadouts(prev, nextReadouts) ? prev : nextReadouts))
      setProbes((prev) => (sameProbes(prev, nextProbes) ? prev : nextProbes))
    }

    tick()
    const interval = window.setInterval(tick, 150)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [lenses, layout, layers, specimen, frameOf, underFor, processedCanvas])

  /* --------------------------------------------------------- card makers --- */
  const cropOf = useCallback(
    (lens: LensState) => {
      const src = frameOf(lens).src
      return { x: src.x, y: src.y, w: src.w, h: src.h }
    },
    [frameOf],
  )

  const swatchCardFor = useCallback(
    (lens: LensState): PinCard | null => {
      const palette = palettes[lens.id] ?? []
      if (palette.length < 2) return null
      return buildSwatchCard({
        specimen,
        crop: cropOf(lens),
        palette,
        lensRadius: frameOf(lens).r,
        index: ++serialRef.current,
      })
    },
    [palettes, specimen, cropOf, frameOf],
  )

  const reportCardFor = useCallback(
    (lens: LensState): PinCard | null => {
      if (!layers.ela) return null
      const frame = frameOf(lens)
      const crop = cropOf(lens)
      const stats = elaStats(layers.ela.raw, specimen.w, specimen.h, crop)
      const region = makeCanvas(560, 360)
      const regionCtx = region.getContext('2d')
      if (regionCtx) {
        regionCtx.fillStyle = '#0B0C0E'
        regionCtx.fillRect(0, 0, 560, 360)
        regionCtx.filter = `brightness(${(lens.gain / ELA_REFERENCE_GAIN).toFixed(3)})`
        regionCtx.drawImage(layers.ela.canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, 560, 360)
        regionCtx.filter = 'none'
      }

      const ratio = stats.mean / Math.max(1, layers.median)
      const boxes: SpliceBox[] = specimen.forensic
        ? specimen.forensic.spliceBoxes?.length
          ? specimen.forensic.spliceBoxes
          : [specimen.forensic.spliceBox]
        : []
      const factor = specimen.nativeWidth / specimen.w
      let overlap = 0
      for (const box of boxes) {
        const local = { x: crop.x * factor, y: crop.y * factor, w: crop.w * factor, h: crop.h * factor }
        const overlapW = Math.max(0, Math.min(local.x + local.w, box.left + box.width) - Math.max(local.x, box.left))
        const overlapH = Math.max(0, Math.min(local.y + local.h, box.top + box.height) - Math.max(local.y, box.top))
        overlap = Math.max(overlap, (overlapW * overlapH) / Math.max(1, local.w * local.h))
      }

      const matched = ratio >= 2 && overlap >= 0.05
      return buildReportCard({
        specimen,
        region,
        stats,
        gain: lens.gain,
        lensRadius: frame.r,
        verdict: { matched, ratio, overlap },
        index: ++serialRef.current,
      })
    },
    [layers, specimen, cropOf, frameOf],
  )

  /* ------------------------------------------------------------- cold open --- */
  useEffect(() => {
    if (!coldOpen || !layout || building || !layers.ela) return
    if (coldRef.current.has(specimen.id)) return
    const ela = lenses.find((lens) => lens.type === 'ela')
    const chroma = lenses.find((lens) => lens.type === 'chroma')
    if (!ela || !chroma) return
    if ((palettes[chroma.id] ?? []).length < 2) return

    const report = reportCardFor(ela)
    const swatch = swatchCardFor(chroma)
    if (!report || !swatch) return

    coldRef.current.add(specimen.id)
    onEject(report)
    window.setTimeout(() => onEject(swatch), 120)
    onNotice('COLD OPEN · TWO PLATES ALREADY PINNED')
  }, [coldOpen, layout, building, layers.ela, lenses, palettes, specimen.id, reportCardFor, swatchCardFor, onEject, onNotice])

  /* ----------------------------------------------------------- actions --- */
  const handleAction = (lens: LensState, action: 'primary' | 'secondary') => {
    if (!layout) return
    const frame = frameOf(lens)
    const crop = cropOf(lens)
    const serial = ++serialRef.current

    if (lens.type === 'chroma') {
      const palette = palettes[lens.id] ?? []
      if (palette.length < 2) {
        onNotice('NO OPTICAL SAMPLE IN THE GLASS · RESIZE THE LENS')
        return
      }
      const card = buildSwatchCard({ specimen, crop, palette, lensRadius: frame.r, index: serial })
      sound.shutter()
      onEject(card)
      onNotice('SWATCH PLATE EJECTED TO PINBOARD')
      return
    }

    if (lens.type === 'ela') {
      if (!layers.ela) {
        onNotice('ELA PASS STILL RUNNING')
        return
      }
      const stats = elaStats(layers.ela.raw, specimen.w, specimen.h, crop)
      const region = makeCanvas(560, 360)
      const regionCtx = region.getContext('2d')
      if (regionCtx) {
        regionCtx.fillStyle = '#0B0C0E'
        regionCtx.fillRect(0, 0, 560, 360)
        regionCtx.filter = `brightness(${(lens.gain / ELA_REFERENCE_GAIN).toFixed(3)})`
        regionCtx.drawImage(layers.ela.canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, 560, 360)
        regionCtx.filter = 'none'
      }

      const ratio = stats.mean / Math.max(1, layers.median)
      const boxes: SpliceBox[] = specimen.forensic
        ? specimen.forensic.spliceBoxes?.length
          ? specimen.forensic.spliceBoxes
          : [specimen.forensic.spliceBox]
        : []
      const factor = specimen.nativeWidth / specimen.w
      let overlap = 0
      for (const box of boxes) {
        const local = { x: crop.x * factor, y: crop.y * factor, w: crop.w * factor, h: crop.h * factor }
        const overlapW = Math.max(0, Math.min(local.x + local.w, box.left + box.width) - Math.max(local.x, box.left))
        const overlapH = Math.max(0, Math.min(local.y + local.h, box.top + box.height) - Math.max(local.y, box.top))
        overlap = Math.max(overlap, (overlapW * overlapH) / Math.max(1, local.w * local.h))
      }

      const matched = ratio >= 2 && overlap >= 0.05
      const card = buildReportCard({
        specimen,
        region,
        stats,
        gain: lens.gain,
        lensRadius: frame.r,
        verdict: { matched, ratio, overlap },
        index: serial,
      })
      sound.shutter()
      onEject(card)
      onNotice(matched ? 'SPLICE SIGNATURE DETECTED · REPORT EJECTED' : 'FORENSIC REPORT EJECTED')
      return
    }

    if (lens.type === 'dither') {
      const options: DitherOptions = {
        ...ditherOptions,
        dotScale: lens.dotScale,
        threshold: lens.threshold,
        mode: lens.mode,
      }
      if (action === 'primary') exportDither(specimen, options, crop, true)
      else exportDither(specimen, options, null, false)
      sound.click()
      onNotice(action === 'primary' ? 'DITHER LENS CROP EXPORTED' : 'FULL-FRAME DITHER EXPORTED')
      return
    }

    exportScrubbed(specimen)
    sound.shutter()
    onNotice('METADATA SCRUBBED · CLEAN JPEG DOWNLOADED')
  }

  /* ------------------------------------------------------- compound HUD --- */
  const compoundBadges = useMemo(() => {
    if (!layout) return []
    const pairs: Array<{ key: string; ids: [string, string]; a: Circle; b: Circle }> = []
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        pairs.push({
          key: `${ordered[i].id}-${ordered[j].id}`,
          ids: [ordered[i].id, ordered[j].id],
          a: circleOf(ordered[i]),
          b: circleOf(ordered[j]),
        })
      }
    }
    return compoundChips(pairs)
  }, [ordered, layout, circleOf])

  const chromeLayout = useMemo(
    () =>
      placeChrome(
        ordered.map((lens) => ({
          id: lens.id,
          circle: circleOf(lens),
          items: [
            'readout',
            'action',
            'close',
            ...(lens.type === 'ela' ? ['stepper' as const] : []),
            ...(lens.type === 'dither' ? ['mode' as const] : []),
          ] as ChromeItem[],
        })),
        compoundBadges.map((badge) => ({ x: badge.x, y: badge.y })),
      ),
    [ordered, circleOf, compoundBadges],
  )

  const readoutFor = (lens: LensState): string => {
    if (lens.type === 'ela') {
      const delta = readouts[lens.id]
      return delta === undefined ? 'Δ —' : `Δ ${delta.toFixed(1)}%`
    }
    if (lens.type === 'chroma') {
      const palette = palettes[lens.id] ?? []
      const ratio = palette.length > 1 ? contrastRatio(palette[0], palette[1]) : 0
      return ratio ? `${ratio.toFixed(2)}:1` : '—'
    }
    if (lens.type === 'dither') return `THR ${lens.threshold}`
    return specimen.gps ? 'GPS EXPOSED' : 'GPS CLEAR'
  }

  /* -------------------------------------------------------------- view --- */
  const topLabels = layout
    ? Array.from({ length: Math.floor(layout.width / 100) + 1 }, (_, i) => i * 100)
    : []
  const leftLabels = layout
    ? Array.from({ length: Math.floor(layout.height / 100) + 1 }, (_, i) => i * 100)
    : []

  return (
    <section className="stage" ref={stageRef} role="main" aria-label="Illuminated light table">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {probeAnnouncement}
      </div>

      {layout ? (
        <div className="plate" style={{ width: layout.width + 30, height: layout.height + 30 }}>
          <div className="ruler ruler--top" aria-hidden="true">
            {topLabels.map((value) => (
              <span key={value} className="ruler-label mono" style={{ left: value }}>
                {value}
              </span>
            ))}
          </div>
          <div className="ruler ruler--left" aria-hidden="true">
            {leftLabels.map((value) => (
              <span key={value} className="ruler-label mono" style={{ top: value }}>
                {value}
              </span>
            ))}
          </div>

          <div className="photo-frame" style={{ width: layout.width, height: layout.height }}>
            <canvas ref={baseRef} className="layer layer--base" />
            <canvas ref={overlayRef} className="layer layer--overlay" />
            {ordered.map((lens, index) => {
              const frame = frameOf(lens)
              return (
                <OpticalLens
                  key={lens.id}
                  lens={lens}
                  cx={frame.cx}
                  cy={frame.cy}
                  r={frame.r}
                  viewport={{ width: layout.width, height: layout.height }}
                  palette={palettes[lens.id] ?? []}
                  probe={probes[lens.id]}
                  onMove={(nx, ny) => onLensMove(lens.id, nx, ny)}
                  onParam={(patch) => onLensParam(lens.id, patch)}
                  onActivate={() => onLensActivate(lens.id)}
                  onClose={() => onLensClose(lens.id)}
                  index={index}
                />
              )
            })}

            <div className="lens-controls-layer">
              {ordered.map((lens) => {
                const frame = frameOf(lens)
                return (
                  <LensControls
                    key={lens.id}
                    lensId={lens.id}
                    cx={frame.cx}
                    cy={frame.cy}
                    anchors={chromeLayout[lens.id] ?? []}
                    readout={readoutFor(lens)}
                    action={ACTION_LABEL[lens.type]}
                    risk={lens.type === 'sobel' && Boolean(specimen.gps)}
                    gain={lens.type === 'ela' ? lens.gain : undefined}
                    mode={lens.type === 'dither' ? (lens.mode === 'bayer' ? 'BAYER' : 'ATKINSON') : undefined}
                    onAction={() => handleAction(lens, 'primary')}
                    onClose={() => onLensClose(lens.id)}
                    onGain={
                      lens.type === 'ela'
                        ? (delta) => onLensParam(lens.id, { gain: Math.min(40, Math.max(10, lens.gain + delta)) })
                        : undefined
                    }
                    onMode={
                      lens.type === 'dither'
                        ? () => onLensParam(lens.id, { mode: lens.mode === 'bayer' ? 'atkinson' : 'bayer' })
                        : undefined
                    }
                  />
                )
              })}
            </div>

            {compoundBadges.map((badge) => (
              <div
                key={badge.key}
                className="compound-badge mono"
                style={{ left: badge.x, top: badge.y }}
                aria-hidden="true"
              >
                {badge.label}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {building ? <div className="scan-badge mono">ELA PASS · ANALYSING PIXELS</div> : null}
    </section>
  )
}
