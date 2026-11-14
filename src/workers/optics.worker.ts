/**
 * Optics worker: image decode, working-size downscale and ELA generation.
 *
 * A 50 MP JPEG decoded on the main thread blocks input for hundreds of
 * milliseconds and exposes a ~200 MB bitmap. Here the file is decoded straight
 * to the working edge with `resizeWidth`/`resizeHeight` (engines that support
 * scaled JPEG decode never materialise the full frame), and the ELA re-encode
 * runs on an OffscreenCanvas away from the compositor.
 */
import { chromaSeedFromPixels, elaFromPixels, luminanceFromPixels, rgbaFromRgb } from '../lib/opticsCore'
import { summarizeExif } from '../lib/exif'
import { readImageSize } from '../lib/imageSize'

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

interface DecodeRequest {
  id: number
  kind: 'decode'
  buffer: ArrayBuffer
  type: string
  maxEdge: number
}

interface ElaRequest {
  id: number
  kind: 'ela'
  width: number
  height: number
  pixels: Uint8ClampedArray<ArrayBuffer>
  quality: number
}

type Request = DecodeRequest | ElaRequest

function canvas2d(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('OFFSCREEN CANVAS UNAVAILABLE')
  return ctx
}

/** Decode straight to the working edge, then clamp with a second cheap draw. */
async function decodeToWorking(buffer: ArrayBuffer, type: string, maxEdge: number) {
  const header = readImageSize(buffer)
  const blob = new Blob([buffer], { type })

  // Pass a single resize dimension so EXIF rotation cannot distort the aspect.
  // The longer native edge drives it; anything still over maxEdge is clamped by
  // the draw below, which never exceeds the working size.
  const longer = header ? Math.max(header.width, header.height) : maxEdge
  const scale = Math.min(1, maxEdge / Math.max(1, longer))
  const targetLong = Math.max(1, Math.round(longer * scale))
  const resize =
    header && header.width >= header.height
      ? { resizeWidth: targetLong, resizeQuality: 'high' as const }
      : { resizeHeight: targetLong, resizeQuality: 'high' as const }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', ...resize })
  } catch {
    try {
      bitmap = await createImageBitmap(blob, resize)
    } catch {
      throw new Error('DECODE FAILED')
    }
  }

  const nativeWidth = bitmap.width
  const nativeHeight = bitmap.height
  const longest = Math.max(nativeWidth, nativeHeight)
  const clampScale = Math.min(1, maxEdge / Math.max(1, longest))
  const width = Math.max(1, Math.round(nativeWidth * clampScale))
  const height = Math.max(1, Math.round(nativeHeight * clampScale))

  const ctx = canvas2d(width, height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const image = ctx.getImageData(0, 0, width, height)
  const pixels = image.data
  const lum = luminanceFromPixels(pixels, width, height)
  const chromaSeed = chromaSeedFromPixels(
    pixels,
    width,
    height,
    Math.round(Math.min(width, height) * 0.15),
  )

  return {
    nativeWidth,
    nativeHeight,
    width,
    height,
    pixels,
    lum,
    chromaSeed,
    fileWidth: header?.width ?? nativeWidth,
    fileHeight: header?.height ?? nativeHeight,
  }
}

async function buildEla(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  quality: number,
) {
  const src = canvas2d(w, h)
  src.putImageData(new ImageData(pixels, w, h), 0, 0)
  const blob = await src.canvas.convertToBlob({ type: 'image/jpeg', quality })

  const reencoded = await createImageBitmap(blob)
  const scratch = canvas2d(w, h)
  scratch.imageSmoothingEnabled = true
  scratch.drawImage(reencoded, 0, 0, w, h)
  reencoded.close?.()

  const compressed = scratch.getImageData(0, 0, w, h).data
  const { display, raw, normalization, p995 } = elaFromPixels(pixels, compressed, w, h)
  return { pixels: rgbaFromRgb(display, w, h), raw, normalization, p995 }
}

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as Request
  if (!request || typeof request.id !== 'number') return

  const respond = (payload: Record<string, unknown>, transfer: Transferable[] = []) => {
    scope.postMessage({ id: request.id, ...payload }, transfer)
  }

  if (request.kind === 'decode') {
    decodeToWorking(request.buffer, request.type, request.maxEdge)
      .then(async (result) => {
        // Metadata is read here too: the main thread then receives pixels, a
        // luminance plane and display rows, and never touches the file bytes.
        const exif = await summarizeExif(request.buffer)
        respond({ ok: true, ...result, exif }, [result.pixels.buffer, result.lum.buffer])
      })
      .catch((error: Error) => respond({ ok: false, error: error.message }))
    return
  }

  buildEla(request.pixels, request.width, request.height, request.quality)
    .then((result) =>
      respond(
        { ok: true, ...result, width: request.width, height: request.height },
        [result.pixels.buffer, result.raw.buffer],
      ),
    )
    .catch((error: Error) => respond({ ok: false, error: error.message }))
})
