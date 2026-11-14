export const MAX_UPLOAD_PIXELS = 80_000_000
export const MAX_UPLOAD_EDGE = 12_000

/**
 * Intrinsic size straight from the file header, so an oversized image is
 * refused before the browser allocates a full-resolution bitmap. Returns null
 * when the header cannot be read, in which case the decode error path handles it.
 *
 * Shared by the main thread and the optics worker: it reads bytes only.
 */
export function readImageSize(buffer: ArrayBuffer): { width: number; height: number } | null {
  if (buffer.byteLength < 32) return null
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = view.getUint16(offset + 2)
      if (length < 2) return null
      const isFrameHeader =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrameHeader) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      offset += 2 + length
    }
    return null
  }

  const isWebp =
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // 'WEBP'
  if (isWebp) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunk === 'VP8X') {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      }
    }
    if (chunk === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
  }

  return null
}
