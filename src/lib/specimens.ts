import exifr from 'exifr'
import { assertCanvasReadable, buildLuminance, clampToWorking, findChromaSeed } from './layers'
import type { ExifEntry, ForensicInfo, Specimen, SpecimenProvenance } from './types'

const BASE = import.meta.env.BASE_URL

const PLAN = [
  { slot: '01-camera-exif.jpg', label: 'SPECIMEN 01', role: 'EXIF / PRIVACY' },
  { slot: '02-color-study.jpg', label: 'SPECIMEN 02', role: 'COLOUR / PRINT' },
  { slot: '03-forensic-edit.jpg', label: 'SPECIMEN 03', role: 'FORENSIC SPLICE' },
] as const

interface CreditsFile {
  specimens: Array<{
    slot: string
    role: string
    source: {
      title: string
      page: string
      license: string
      licenseUrl?: string
      usageTerms: string
      artist: string
    }
    output: { width: number; height: number; bytes: number }
    forensic?: ForensicInfo
  }>
}

interface Parsed {
  Make?: string
  Model?: string
  LensModel?: string
  Lens?: string
  ISO?: number
  FNumber?: number
  ExposureTime?: number
  FocalLength?: number
  DateTimeOriginal?: Date
  ColorSpace?: number
  Software?: string
  SerialNumber?: string
  latitude?: number
  longitude?: number
  GPSLatitude?: number
  GPSLongitude?: number
  [key: string]: unknown
}

function formatShutter(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1) return `${Number(n.toFixed(n < 10 ? 1 : 0))}s`
  return `1/${Math.round(1 / n)}s`
}

function formatFocal(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? `${Number(n.toFixed(1))}mm` : '—'
}

function formatDate(value: unknown): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function parseExif(buffer: ArrayBuffer): Promise<Parsed | null> {
  try {
    return (await exifr.parse(buffer, {
      tiff: true,
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
      reviveValues: true,
      translateValues: true,
    })) as Parsed | null
  } catch {
    return null
  }
}

function buildExifRows(parsed: Parsed | null, gps: { lat: number; lon: number } | null): ExifEntry[] {
  if (!parsed) return [{ label: 'EXIF HEADER', value: 'NO METADATA PRESENT' }]
  const rows: ExifEntry[] = []
  const push = (label: string, value: string | undefined | null, risk = false) => {
    if (!value || value === '—') return
    rows.push({ label, value, risk })
  }
  const body = [parsed.Make, parsed.Model].filter(Boolean).join(' ').trim()
  push('CAMERA BODY', body || 'NOT RECORDED')
  push('OPTICS', parsed.LensModel ?? parsed.Lens ?? 'NOT RECORDED')
  push('FOCAL LENGTH', formatFocal(parsed.FocalLength))
  push(
    'APERTURE',
    Number.isFinite(parsed.FNumber) ? `f/${Number(Number(parsed.FNumber).toFixed(1))}` : undefined,
  )
  push('SENSITIVITY', parsed.ISO ? `ISO ${parsed.ISO}` : undefined)
  push('SHUTTER', formatShutter(parsed.ExposureTime))
  push('CAPTURED', formatDate(parsed.DateTimeOriginal))
  push(
    'COLOUR SPACE',
    parsed.ColorSpace === 1 ? 'sRGB' : parsed.ColorSpace ? `ID ${parsed.ColorSpace}` : undefined,
  )
  push('SOFTWARE', parsed.Software)
  push('BODY SERIAL', parsed.SerialNumber)
  if (gps) {
    push('GPS POSITION', `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`, true)
  } else {
    push('GPS POSITION', 'NOT PRESENT')
  }
  return rows
}

function readGps(parsed: Parsed | null): { lat: number; lon: number } | null {
  const lat = parsed?.latitude ?? parsed?.GPSLatitude
  const lon = parsed?.longitude ?? parsed?.GPSLongitude
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null
}

interface AssembleInput {
  id: string
  filename: string
  label: string
  role: string
  bytes: number
  buffer: ArrayBuffer
  bitmap: ImageBitmap
  provenance: SpecimenProvenance
  forensic?: ForensicInfo
}

async function assemble(input: AssembleInput): Promise<Specimen> {
  const { canvas, w, h } = clampToWorking(input.bitmap)
  // Refuse early if the pixels are not readable, instead of failing mid-eject.
  if (!assertCanvasReadable(canvas)) throw new Error('CANVAS TAINTED · SPECIMEN REJECTED')
  const lum = buildLuminance(canvas)
  const chromaSeed = findChromaSeed(canvas, w, h, Math.round(Math.min(w, h) * 0.15))
  const parsed = await parseExif(input.buffer.slice(0))
  const gps = readGps(parsed)
  const nativeWidth = input.bitmap.width
  const nativeHeight = input.bitmap.height
  input.bitmap.close?.()

  return {
    id: input.id,
    filename: input.filename,
    label: input.label,
    role: input.role,
    bytes: input.bytes,
    nativeWidth,
    nativeHeight,
    w,
    h,
    work: canvas,
    lum,
    exif: buildExifRows(parsed, gps),
    tagCount: parsed ? Object.keys(parsed).length : 0,
    gps,
    provenance: input.provenance,
    forensic: input.forensic,
    chromaSeed,
  }
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    return await createImageBitmap(blob)
  }
}

export async function loadSpecimens(): Promise<Specimen[]> {
  let credits: CreditsFile = { specimens: [] }
  try {
    const res = await fetch(`${BASE}specimens/credits.json`, {
      cache: 'no-cache',
      mode: 'cors',
      credentials: 'same-origin',
    })
    if (res.ok) credits = (await res.json()) as CreditsFile
  } catch {
    credits = { specimens: [] }
  }

  return Promise.all(
    PLAN.map(async (plan) => {
      // Same-origin by default; CORS-clean if BASE ever points at a CDN.
      // Same-origin credentials keeps gated preview hosts working while still
      // sending no cookies cross-origin.
      const res = await fetch(`${BASE}specimens/${plan.slot}`, {
        mode: 'cors',
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error(`Could not load ${plan.slot} (${res.status})`)
      const buffer = await res.arrayBuffer()
      const bitmap = await decode(new Blob([buffer], { type: 'image/jpeg' }))
      const credit = credits.specimens.find((s) => s.slot === plan.slot)

      return assemble({
        id: plan.slot,
        filename: plan.slot,
        label: plan.label,
        role: plan.role,
        bytes: buffer.byteLength,
        buffer,
        bitmap,
        provenance: {
          title: credit?.source.title ?? plan.slot,
          page: credit?.source.page ?? '',
          license: `${credit?.source.license ?? 'CC0'} · ${credit?.source.usageTerms ?? 'PUBLIC DOMAIN DEDICATION'}`,
          usage: credit?.source.usageTerms ?? 'CC0 1.0 UNIVERSAL',
          artist: credit?.source.artist ?? 'UNKNOWN',
        },
        forensic: credit?.forensic,
      })
    }),
  )
}

export async function specimenFromFile(file: File): Promise<Specimen> {
  const buffer = await file.arrayBuffer()
  let bitmap: ImageBitmap
  try {
    bitmap = await decode(new Blob([buffer], { type: file.type }))
  } catch {
    throw new Error('Decode failed — this file is not a readable JPEG, PNG or WebP')
  }

  return assemble({
    id: `upload-${Date.now()}`,
    filename: file.name,
    label: 'UPLOADED',
    role: 'OPERATOR UPLOAD',
    bytes: buffer.byteLength,
    buffer,
    bitmap,
    provenance: {
      title: file.name,
      page: '',
      license: 'LOCAL FILE · NEVER LEAVES THIS MACHINE',
      usage: 'LOCAL FILE',
      artist: 'OPERATOR',
    },
  })
}
