import { zipSync } from 'fflate'
import { contrastRatio, hexOf, wcagGrade, ditherRegion, makeCanvas } from './layers'
import type { DitherOptions, PaletteColor, PinCard, Specimen } from './types'

const SERIF = '"JetBrains Mono", ui-monospace, monospace'
const SANS = 'Inter, system-ui, -apple-system, sans-serif'
const PAPER = '#F4F1E9'
const PAPER_INK = '#14161A'
const PAPER_MUTED = '#6E6A61'
const ORANGE = '#FF4F00'

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

const uid = () => Math.random().toString(36).slice(2, 9)

function makeCardCanvas(w: number, h: number) {
  const canvas = makeCanvas(w * 2, h * 2)
  const ctx = canvas.getContext('2d')!
  ctx.scale(2, 2)
  return { canvas, ctx }
}

function spacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  gap: number,
) {
  let cursor = x
  for (const ch of text) {
    ctx.fillText(ch, cursor, y)
    cursor += ctx.measureText(ch).width + gap
  }
}

function rule(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, colour = 'rgba(20,22,26,0.18)') {
  ctx.fillStyle = colour
  ctx.fillRect(x, y, w, 1)
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  crop: CropRect,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const targetAspect = dw / dh
  const cropAspect = crop.w / crop.h
  let sx = crop.x
  let sy = crop.y
  let sw = crop.w
  let sh = crop.h
  if (cropAspect > targetAspect) {
    sw = crop.h * targetAspect
    sx = crop.x + (crop.w - sw) / 2
  } else {
    sh = crop.w / targetAspect
    sy = crop.y + (crop.h - sh) / 2
  }
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
}

function paperBase(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, h)
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, 'rgba(255,255,255,0.5)')
  grad.addColorStop(1, 'rgba(160,150,130,0.18)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
}

function cardHeader(
  ctx: CanvasRenderingContext2D,
  w: number,
  kicker: string,
  index: number,
  meta: string,
) {
  ctx.fillStyle = PAPER_INK
  ctx.font = `700 22px ${SANS}`
  ctx.fillText('LOUPE', 28, 38)
  ctx.font = `600 9px ${SERIF}`
  ctx.fillStyle = PAPER_MUTED
  spacedText(ctx, 'OPTICAL LAB 01', 92, 37, 1.2)
  ctx.textAlign = 'right'
  ctx.fillStyle = PAPER_INK
  ctx.font = `600 10px ${SERIF}`
  ctx.fillText(`No. ${String(index).padStart(2, '0')}`, w - 28, 36)
  ctx.textAlign = 'left'
  rule(ctx, 28, 52, w - 56)
  ctx.font = `700 9px ${SERIF}`
  ctx.fillStyle = ORANGE
  spacedText(ctx, kicker, 28, 70, 1.4)
  ctx.textAlign = 'right'
  ctx.fillStyle = PAPER_MUTED
  ctx.font = `500 9px ${SERIF}`
  ctx.fillText(meta, w - 28, 70)
  ctx.textAlign = 'left'
}

function cardFooter(ctx: CanvasRenderingContext2D, w: number, y: number, specimen: Specimen) {
  rule(ctx, 28, y - 14, w - 56)
  ctx.font = `500 8px ${SERIF}`
  ctx.fillStyle = PAPER_MUTED
  ctx.fillText(`${specimen.filename} · ${specimen.provenance.artist} · ${specimen.provenance.license}`, 28, y)
  ctx.textAlign = 'right'
  ctx.fillText(new Date().toISOString().replace('T', ' ').slice(0, 19), w - 28, y)
  ctx.textAlign = 'left'
}

/* ------------------------------------------------------------ swatch --- */

export interface SwatchArgs {
  specimen: Specimen
  crop: CropRect
  palette: PaletteColor[]
  lensRadius: number
  index: number
}

export function buildSwatchCard({ specimen, crop, palette, lensRadius, index }: SwatchArgs): PinCard {
  const W = 560
  const H = 830
  const { canvas, ctx } = makeCardCanvas(W, H)
  paperBase(ctx, W, H)
  cardHeader(ctx, W, 'CHROMATIC HARVEST / PANTONE CARD', index, `${palette.length} CLUSTERS`)

  ctx.save()
  ctx.strokeStyle = 'rgba(20,22,26,0.35)'
  ctx.lineWidth = 1
  ctx.strokeRect(28.5, 84.5, 504, 300)
  drawCover(ctx, specimen.work, crop, 28, 84, 504, 300)
  ctx.restore()

  // crop corner marks
  ctx.strokeStyle = ORANGE
  ctx.lineWidth = 2
  const marks = [
    [28, 84, 1, 1],
    [532, 84, -1, 1],
    [28, 384, 1, -1],
    [532, 384, -1, -1],
  ] as const
  for (const [x, y, sx, sy] of marks) {
    ctx.beginPath()
    ctx.moveTo(x + 16 * sx, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + 16 * sy)
    ctx.stroke()
  }

  ctx.font = `500 9px ${SERIF}`
  ctx.fillStyle = PAPER_MUTED
  ctx.fillText('SPECIMEN', 28, 404)
  ctx.fillStyle = PAPER_INK
  ctx.fillText(specimen.filename.toUpperCase(), 28, 418)
  ctx.textAlign = 'right'
  ctx.fillStyle = PAPER_MUTED
  ctx.fillText(`LENS Ø ${Math.round(lensRadius * 2)} PX · 2× OPTICAL ZOOM`, W - 28, 418)
  ctx.textAlign = 'left'

  const rowsTop = 436
  const rowH = 56
  palette.forEach((colour, i) => {
    const y = rowsTop + i * rowH
    ctx.fillStyle = colour.hex
    ctx.fillRect(28, y, 48, 48)
    ctx.strokeStyle = 'rgba(20,22,26,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(28.5, y + 0.5, 47, 47)

    ctx.fillStyle = PAPER_INK
    ctx.font = `600 18px ${SERIF}`
    ctx.fillText(colour.hex, 92, y + 24)

    ctx.fillStyle = PAPER_MUTED
    ctx.font = `500 9px ${SERIF}`
    ctx.fillText(`${Math.round(colour.share * 100)}% OF SAMPLED PIXELS`, 92, y + 40)

    ctx.textAlign = 'right'
    ctx.font = `600 9px ${SERIF}`
    ctx.fillStyle = i === 0 ? ORANGE : PAPER_MUTED
    ctx.fillText(i === 0 ? 'PRIMARY' : i === 1 ? 'SECONDARY' : `CLUSTER ${i + 1}`, W - 28, y + 24)
    ctx.textAlign = 'left'
    if (i < palette.length - 1) rule(ctx, 28, y + rowH - 6, W - 56, 'rgba(20,22,26,0.1)')
  })

  const ratio = palette.length > 1 ? contrastRatio(palette[0], palette[1]) : 1
  const badgeY = rowsTop + palette.length * rowH + 14
  ctx.strokeStyle = 'rgba(20,22,26,0.5)'
  ctx.lineWidth = 1
  rounded(ctx, 28.5, badgeY + 0.5, 504, 56, 3)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,79,0,0.08)'
  ctx.fill()

  ctx.fillStyle = PAPER_MUTED
  ctx.font = `600 9px ${SERIF}`
  ctx.fillText('WCAG 2.1 CONTRAST', 48, badgeY + 24)
  ctx.fillStyle = PAPER_INK
  ctx.font = `600 9px ${SERIF}`
  ctx.fillText('PRIMARY ON SECONDARY', 48, badgeY + 40)

  ctx.font = `700 26px ${SERIF}`
  ctx.fillStyle = PAPER_INK
  ctx.textAlign = 'center'
  ctx.fillText(`${ratio.toFixed(2)}:1`, W / 2 + 40, badgeY + 38)

  ctx.textAlign = 'right'
  ctx.font = `700 11px ${SERIF}`
  ctx.fillStyle = ratio >= 4.5 ? '#1F6B3A' : ratio >= 3 ? '#8A5A00' : '#A3241B'
  ctx.fillText(`WCAG ${wcagGrade(ratio)}`, W - 48, badgeY + 34)
  ctx.textAlign = 'left'

  cardFooter(ctx, W, H - 28, specimen)

  const css = [
    ':root {',
    ...palette.map((c, i) => `  --swatch-${i + 1}: ${c.hex}; /* ${Math.round(c.share * 100)}% */`),
    `  --swatch-contrast: ${ratio.toFixed(2)};`,
    '}',
  ].join('\n')

  return {
    id: uid(),
    kind: 'swatch',
    title: `SWATCH ${palette[0]?.hex ?? '#------'}`,
    subtitle: `${specimen.filename} · ${ratio.toFixed(2)}:1 ${wcagGrade(ratio)}`,
    createdAt: Date.now(),
    png: canvas.toDataURL('image/png'),
    canvas,
    css,
    json: {
      kind: 'loupe.swatch',
      specimen: specimen.filename,
      source: specimen.provenance,
      lensDiameter: Math.round(lensRadius * 2),
      crop,
      palette: palette.map((c) => ({ hex: c.hex, share: Number(c.share.toFixed(4)) })),
      wcagContrast: Number(ratio.toFixed(2)),
      wcagGrade: wcagGrade(ratio),
      capturedAt: new Date().toISOString(),
    },
  }
}

/* ------------------------------------------------------------ report --- */

export interface ReportArgs {
  specimen: Specimen
  region: HTMLCanvasElement
  stats: { pct: number; mean: number; p99: number }
  gain: number
  lensRadius: number
  verdict: { matched: boolean; ratio: number; overlap: number } | null
  index: number
}

export function buildReportCard({
  specimen,
  region,
  stats,
  gain,
  lensRadius,
  verdict,
  index,
}: ReportArgs): PinCard {
  const W = 560
  const H = 900
  const { canvas, ctx } = makeCardCanvas(W, H)
  paperBase(ctx, W, H)
  cardHeader(ctx, W, 'FORENSIC SNAPSHOT / ELA', index, `GAIN ${gain}×`)

  ctx.save()
  ctx.strokeStyle = 'rgba(20,22,26,0.35)'
  ctx.strokeRect(28.5, 84.5, 504, 310)
  ctx.fillStyle = '#0B0C0E'
  ctx.fillRect(28, 84, 504, 310)
  const targetAspect = 504 / 310
  const aspect = region.width / region.height
  let sx = 0
  let sy = 0
  let sw = region.width
  let sh = region.height
  if (aspect > targetAspect) {
    sw = region.height * targetAspect
    sx = (region.width - sw) / 2
  } else {
    sh = region.width / targetAspect
    sy = (region.height - sh) / 2
  }
  ctx.drawImage(region, sx, sy, sw, sh, 28, 84, 504, 310)
  ctx.restore()

  ctx.font = `500 9px ${SERIF}`
  ctx.fillStyle = PAPER_MUTED
  ctx.fillText(`SAMPLE 1:1 FROM LENS Ø${Math.round(lensRadius * 2)}PX`, 28, 412)
  ctx.textAlign = 'right'
  ctx.fillText('ERROR LEVEL ANALYSIS · q0.75', W - 28, 412)
  ctx.textAlign = 'left'

  const cells: Array<[string, string]> = [
    ['REGION Δ', `${stats.pct.toFixed(1)}%`],
    ['P99 Δ', `${((stats.p99 / 255) * 100).toFixed(1)}%`],
    ['IMAGE GAIN', `${gain}×`],
    ['ANOMALY', verdict ? `${verdict.ratio.toFixed(2)}×` : '—'],
  ]
  const cellW = (W - 56) / cells.length
  cells.forEach(([label, value], i) => {
    const x = 28 + i * cellW
    rule(ctx, x, 428, cellW - 10, 'rgba(20,22,26,0.2)')
    ctx.fillStyle = PAPER_MUTED
    ctx.font = `600 8px ${SERIF}`
    ctx.fillText(label, x, 446)
    ctx.fillStyle = PAPER_INK
    ctx.font = `700 20px ${SERIF}`
    ctx.fillText(value, x, 470)
  })

  rule(ctx, 28, 494, W - 56, 'rgba(20,22,26,0.2)')
  ctx.fillStyle = PAPER_MUTED
  ctx.font = `600 8px ${SERIF}`
  spacedText(ctx, 'EMBEDDED METADATA LEDGER', 28, 510, 1.2)

  const ledger = specimen.exif.slice(0, 9)
  ledger.forEach((entry, i) => {
    const y = 530 + i * 24
    ctx.font = `500 9px ${SERIF}`
    ctx.fillStyle = PAPER_MUTED
    ctx.fillText(entry.label, 28, y)
    ctx.font = `600 10px ${SERIF}`
    ctx.fillStyle = entry.risk ? '#A3241B' : PAPER_INK
    ctx.textAlign = 'right'
    const value = entry.value.length > 34 ? `${entry.value.slice(0, 33)}…` : entry.value
    ctx.fillText(value, W - 28, y)
    ctx.textAlign = 'left'
    if (i < ledger.length - 1) rule(ctx, 28, y + 10, W - 56, 'rgba(20,22,26,0.08)')
  })

  const verdictY = 530 + ledger.length * 24 + 18
  const matched = verdict?.matched ?? false
  ctx.fillStyle = matched ? 'rgba(255,79,0,0.14)' : 'rgba(20,22,26,0.06)'
  ctx.fillRect(28, verdictY, 504, 52)
  ctx.fillStyle = matched ? ORANGE : PAPER_MUTED
  ctx.fillRect(28, verdictY, 4, 52)
  ctx.fillStyle = matched ? '#A3241B' : PAPER_MUTED
  ctx.font = `700 12px ${SERIF}`
  spacedText(ctx, matched ? 'SPLICE SIGNATURE DETECTED' : 'NO COMPRESSION ANOMALY IN REGION', 48, verdictY + 22, 1.1)
  ctx.font = `500 9px ${SERIF}`
  ctx.fillStyle = PAPER_MUTED
  ctx.fillText(
    matched
      ? `Region delta ${verdict?.ratio.toFixed(2)}× image baseline · ${Math.round((verdict?.overlap ?? 0) * 100)}% overlap with known edit`
      : 'Sweep the lens across the plate to raise the local error level',
    48,
    verdictY + 38,
  )

  cardFooter(ctx, W, H - 28, specimen)

  return {
    id: uid(),
    kind: 'report',
    title: matched ? 'SPLICE FOUND' : 'ELA SNAPSHOT',
    subtitle: `${specimen.filename} · Δ ${stats.pct.toFixed(1)}% · ${gain}×`,
    createdAt: Date.now(),
    png: canvas.toDataURL('image/png'),
    canvas,
    css: `/* ELA report · ${specimen.filename} */`,
    json: {
      kind: 'loupe.report',
      specimen: specimen.filename,
      source: specimen.provenance,
      ela: {
        gain,
        regionDeltaPct: Number(stats.pct.toFixed(2)),
        regionP99: Number(stats.p99.toFixed(2)),
        lensDiameter: Math.round(lensRadius * 2),
      },
      verdict: verdict
        ? {
            matched: verdict.matched,
            ratio: Number(verdict.ratio.toFixed(2)),
            overlap: Number(verdict.overlap.toFixed(3)),
          }
        : null,
      metadata: specimen.exif,
      tagCount: specimen.tagCount,
      capturedAt: new Date().toISOString(),
    },
  }
}

/* ----------------------------------------------------------- exports --- */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, filename)
  }, 'image/png')
}

export function cleanFilename(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
}

/** Re-encode raw pixels through a fresh canvas: every EXIF/IPTC/XMP block is gone. */
export function exportScrubbed(specimen: Specimen) {
  const canvas = makeCanvas(specimen.w, specimen.h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(specimen.work, 0, 0)
  canvas.toBlob(
    (blob) => {
      if (blob) downloadBlob(blob, `${cleanFilename(specimen.filename)}-scrubbed.jpg`)
    },
    'image/jpeg',
    0.92,
  )
}

export function exportDither(
  specimen: Specimen,
  options: DitherOptions,
  region: CropRect | null,
  circular: boolean,
) {
  const zoom = 2
  const rect = region ?? { x: 0, y: 0, w: specimen.w, h: specimen.h }
  const outW = Math.max(1, Math.round(rect.w * zoom))
  const outH = Math.max(1, Math.round(rect.h * zoom))
  const image = ditherRegion(specimen.lum, specimen.w, specimen.h, rect, outW, outH, options)
  const canvas = makeCanvas(outW, outH)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(image, 0, 0)
  if (circular) {
    ctx.globalCompositeOperation = 'destination-in'
    ctx.beginPath()
    ctx.arc(outW / 2, outH / 2, Math.min(outW, outH) / 2, 0, Math.PI * 2)
    ctx.fill()
  }
  downloadCanvas(canvas, `${cleanFilename(specimen.filename)}-dither${circular ? '-lens' : ''}.png`)
}

export function exportAllZip(pins: PinCard[], specimens: Specimen[]) {
  if (!pins.length) return
  const files: Record<string, Uint8Array> = {}
  pins.forEach((pin, i) => {
    const base64 = pin.png.split(',')[1] ?? ''
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j)
    files[`${String(i + 1).padStart(2, '0')}-${pin.kind}-${pin.id}.png`] = bytes
    files[`${String(i + 1).padStart(2, '0')}-${pin.kind}-${pin.id}.json`] = new TextEncoder().encode(
      JSON.stringify(pin.json, null, 2),
    )
  })
  files['specimen-credits.json'] = new TextEncoder().encode(
    JSON.stringify(
      specimens.map((s) => ({
        file: s.filename,
        bytes: s.bytes,
        dimensions: [s.nativeWidth, s.nativeHeight],
        provenance: s.provenance,
        tags: s.tagCount,
      })),
      null,
      2,
    ),
  )
  const zipped = zipSync(files, { level: 6 })
  downloadBlob(
    new Blob([zipped.slice().buffer as ArrayBuffer], { type: 'application/zip' }),
    `loupe-forensics-${new Date().toISOString().slice(0, 10)}.zip`,
  )
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export { hexOf }
