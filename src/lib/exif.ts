import exifr from 'exifr'
import type { ExifEntry } from './types'

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

export interface ExifSummary {
  rows: ExifEntry[]
  gps: { lat: number; lon: number } | null
  tagCount: number
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

export async function parseExif(buffer: ArrayBuffer): Promise<Parsed | null> {
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

export function readGps(parsed: Parsed | null): { lat: number; lon: number } | null {
  const lat = parsed?.latitude ?? parsed?.GPSLatitude
  const lon = parsed?.longitude ?? parsed?.GPSLongitude
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null
}

export function buildExifRows(
  parsed: Parsed | null,
  gps: { lat: number; lon: number } | null,
): ExifEntry[] {
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

/** Parse metadata into the rows the inspector displays. Safe in a Worker. */
export async function summarizeExif(buffer: ArrayBuffer): Promise<ExifSummary> {
  const parsed = await parseExif(buffer)
  const gps = readGps(parsed)
  return {
    rows: buildExifRows(parsed, gps),
    gps,
    tagCount: parsed ? Object.keys(parsed).length : 0,
  }
}
