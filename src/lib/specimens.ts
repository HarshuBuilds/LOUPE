import { summarizeExif } from './exif'
import type { ExifSummary } from './exif'
import {
  MAX_WORKING_EDGE,
  assertCanvasReadable,
  buildLuminance,
  canvasFromPixels,
  clampToWorking,
  findChromaSeed,
} from './layers'
import { MAX_UPLOAD_EDGE, MAX_UPLOAD_PIXELS, readImageSize } from './imageSize'
import { decodeInWorker, opticsWorkerSupported } from './opticsWorker'
import type { ForensicInfo, Specimen, SpecimenProvenance } from './types'

const BASE = import.meta.env.BASE_URL

const PLAN = [
  { slot: '01-camera-exif.jpg', label: 'SPECIMEN 01', role: 'EXIF / PRIVACY' },
  { slot: '02-color-study.jpg', label: 'SPECIMEN 02', role: 'COLOUR / PRINT' },
  { slot: '03-forensic-edit.jpg', label: 'SPECIMEN 03', role: 'FORENSIC SPLICE' },
] as const

const DECODE_FAILED = 'Decode failed — this file is not a readable JPEG, PNG or WebP'

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

/**
 * A specimen reduced to its working resolution, with everything the table needs
 * to sample it. Decoding happens in the optics worker where possible, straight
 * to the working edge, so a 50 MP file never becomes a full-size bitmap.
 */
interface Prepared {
  canvas: HTMLCanvasElement
  w: number
  h: number
  nativeWidth: number
  nativeHeight: number
  lum: Uint8Array
  chromaSeed: { x: number; y: number }
  exif: ExifSummary
  bytes: number
}

/**
 * Main-thread fallback decode, still resized where the header tells us the
 * dimensions. Engines without a worker keep working, just without the offload.
 */
async function decodeBitmap(
  blob: Blob,
  header: { width: number; height: number } | null,
): Promise<ImageBitmap> {
  const longer = header ? Math.max(header.width, header.height) : 0
  const scale = longer ? Math.min(1, MAX_WORKING_EDGE / longer) : 1
  const resize: ImageBitmapOptions =
    header && scale < 1
      ? header.width >= header.height
        ? { resizeWidth: Math.max(1, Math.round(header.width * scale)), resizeQuality: 'high' }
        : { resizeHeight: Math.max(1, Math.round(header.height * scale)), resizeQuality: 'high' }
      : {}

  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image', ...resize })
  } catch {
    try {
      return await createImageBitmap(blob, resize)
    } catch {
      return await createImageBitmap(blob)
    }
  }
}

async function prepare(buffer: ArrayBuffer, type: string): Promise<Prepared> {
  const bytes = buffer.byteLength

  if (opticsWorkerSupported()) {
    try {
      const decoded = await decodeInWorker(buffer, type, MAX_WORKING_EDGE)
      return {
        canvas: canvasFromPixels(decoded.pixels, decoded.width, decoded.height),
        w: decoded.width,
        h: decoded.height,
        // The file's own dimensions read better than the resized bitmap's.
        nativeWidth: decoded.fileWidth || decoded.nativeWidth,
        nativeHeight: decoded.fileHeight || decoded.nativeHeight,
        lum: decoded.lum,
        chromaSeed: decoded.chromaSeed,
        exif: decoded.exif,
        bytes,
      }
    } catch (error) {
      const message = (error as Error).message ?? ''
      // The buffer was transferred, so a worker failure cannot be retried here.
      throw new Error(message.includes('DECODE') ? DECODE_FAILED : message || DECODE_FAILED)
    }
  }

  const header = readImageSize(buffer)
  let bitmap: ImageBitmap
  try {
    bitmap = await decodeBitmap(new Blob([buffer], { type }), header)
  } catch {
    throw new Error(DECODE_FAILED)
  }

  try {
    const { canvas, w, h } = clampToWorking(bitmap)
    return {
      canvas,
      w,
      h,
      // Without a header the resized bitmap is the best size we have.
      nativeWidth: header?.width ?? bitmap.width,
      nativeHeight: header?.height ?? bitmap.height,
      lum: buildLuminance(canvas),
      chromaSeed: findChromaSeed(canvas, w, h, Math.round(Math.min(w, h) * 0.15)),
      exif: await summarizeExif(buffer),
      bytes,
    }
  } finally {
    bitmap.close?.()
  }
}

interface AssembleInput {
  id: string
  filename: string
  label: string
  role: string
  prepared: Prepared
  provenance: SpecimenProvenance
  forensic?: ForensicInfo
}

async function assemble(input: AssembleInput): Promise<Specimen> {
  const { prepared } = input
  // Refuse early if the pixels are not readable, instead of failing mid-eject.
  if (!assertCanvasReadable(prepared.canvas)) throw new Error('CANVAS TAINTED · SPECIMEN REJECTED')

  return {
    id: input.id,
    filename: input.filename,
    label: input.label,
    role: input.role,
    bytes: prepared.bytes,
    nativeWidth: prepared.nativeWidth,
    nativeHeight: prepared.nativeHeight,
    w: prepared.w,
    h: prepared.h,
    work: prepared.canvas,
    lum: prepared.lum,
    exif: prepared.exif.rows,
    tagCount: prepared.exif.tagCount,
    gps: prepared.exif.gps,
    provenance: input.provenance,
    forensic: input.forensic,
    chromaSeed: prepared.chromaSeed,
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
      const prepared = await prepare(buffer, 'image/jpeg')
      const credit = credits.specimens.find((s) => s.slot === plan.slot)

      return assemble({
        id: plan.slot,
        filename: plan.slot,
        label: plan.label,
        role: plan.role,
        prepared,
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

  const size = readImageSize(buffer)
  if (size && (Math.max(size.width, size.height) > MAX_UPLOAD_EDGE || size.width * size.height > MAX_UPLOAD_PIXELS)) {
    throw new Error(
      `IMAGE TOO LARGE · ${size.width}×${size.height} · LIMIT ${MAX_UPLOAD_EDGE} PX / 80 MP`,
    )
  }

  // Some operating systems hand over an empty MIME type; fall back to the name.
  const type =
    file.type ||
    (/\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : 'image/jpeg')

  const prepared = await prepare(buffer, type)

  return assemble({
    id: `upload-${Date.now()}`,
    filename: file.name,
    label: 'UPLOADED',
    role: 'OPERATOR UPLOAD',
    prepared,
    provenance: {
      title: file.name,
      page: '',
      license: 'LOCAL FILE · NEVER LEAVES THIS MACHINE',
      usage: 'LOCAL FILE',
      artist: 'OPERATOR',
    },
  })
}
