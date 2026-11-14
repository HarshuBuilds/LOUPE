/**
 * RPC client for the optics worker.
 *
 * All heavy optical work (decode, downscale, ELA) happens in one module worker
 * so the main thread keeps painting. If the platform cannot host the worker the
 * callers fall back to their main-thread implementations.
 */
import type { ExifSummary } from './exif'

export interface DecodedImage {
  nativeWidth: number
  nativeHeight: number
  /** Dimensions as recorded in the file header (pre-rotation). */
  fileWidth: number
  fileHeight: number
  width: number
  height: number
  pixels: Uint8ClampedArray<ArrayBuffer>
  lum: Uint8Array<ArrayBuffer>
  chromaSeed: { x: number; y: number }
  /** Metadata rows, parsed in the worker so the file bytes never come back. */
  exif: ExifSummary
}

export interface ElaResult {
  pixels: Uint8ClampedArray<ArrayBuffer>
  raw: Uint8Array<ArrayBuffer>
  normalization: number
  p995: number
}

let worker: Worker | null = null
let broken = false
let counter = 0
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

function failAll(message: string) {
  for (const [, entry] of pending) entry.reject(new Error(message))
  pending.clear()
}

function getWorker(): Worker | null {
  if (broken) return null
  if (worker) return worker
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    broken = true
    return null
  }
  try {
    worker = new Worker(new URL('../workers/optics.worker.ts', import.meta.url), {
      type: 'module',
      name: 'loupe-optics',
    })
  } catch {
    broken = true
    return null
  }

  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { id: number; ok: boolean; error?: string }
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.ok) entry.resolve(data)
    else entry.reject(new Error(data.error || 'OPTICS WORKER FAILED'))
  })

  const crash = (message: string) => {
    broken = true
    worker?.terminate()
    worker = null
    failAll(message)
  }
  worker.addEventListener('error', () => crash('OPTICS WORKER CRASHED'))
  worker.addEventListener('messageerror', () => crash('OPTICS WORKER MESSAGE FAILED'))
  return worker
}

export function opticsWorkerSupported(): boolean {
  return !broken && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

function send<T>(message: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
  const instance = getWorker()
  if (!instance) return Promise.reject(new Error('OPTICS WORKER UNAVAILABLE'))
  const id = ++counter
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    instance.postMessage({ id, ...message }, transfer)
  })
}

/** Transfers the buffer: it comes back on the result. */
export function decodeInWorker(
  buffer: ArrayBuffer,
  type: string,
  maxEdge: number,
): Promise<DecodedImage> {
  return send<DecodedImage>({ kind: 'decode', buffer, type, maxEdge }, [buffer])
}

/** Transfers the pixel buffer. */
export function elaInWorker(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  quality: number,
): Promise<ElaResult> {
  return send<ElaResult>(
    { kind: 'ela', width, height, pixels, quality },
    [pixels.buffer as ArrayBuffer],
  )
}
