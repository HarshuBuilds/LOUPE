export type LensType = 'ela' | 'chroma' | 'dither' | 'sobel'
export type DitherMode = 'bayer' | 'atkinson'
export type ThemeName = 'darkroom' | 'daylight'

export interface LensState {
  id: string
  type: LensType
  /** Centre of the lens, normalised against the displayed photograph (0..1). */
  x: number
  y: number
  /** Glass radius in CSS pixels (aperture diameter is 2 × radius). */
  radius: number
  /** ELA gain, 10..40 */
  gain: number
  /** Dither luminance threshold, 0..255 */
  threshold: number
  /** Dither dot size in source pixels, 1..6 */
  dotScale: number
  mode: DitherMode
  /** Stacking order. Highest renders last, on top of every other lens. */
  z: number
  /** Degrees the bezel scale has been turned by the wheel. */
  rotation: number
}

export interface DitherOptions {
  dotScale: number
  threshold: number
  ink: [number, number, number]
  paper: [number, number, number]
  mode: DitherMode
}

export interface PaletteColor {
  hex: string
  r: number
  g: number
  b: number
  share: number
  /** Normalised position of the sampled cluster inside the lens circle. */
  nx: number
  ny: number
}

export interface ExifEntry {
  label: string
  value: string
  risk?: boolean
}

export interface SpecimenProvenance {
  title: string
  page: string
  license: string
  usage: string
  artist: string
}

export interface SpliceBox {
  left: number
  top: number
  width: number
  height: number
  label?: string
  /** ELA ratio measured for this box, when the prep script recorded one. */
  elaRatio?: number
}

export interface ForensicInfo {
  spliceBox: SpliceBox
  /** Every doctored region. Falls back to [spliceBox] when absent. */
  spliceBoxes?: SpliceBox[]
  ela: { boxMean: number; median: number; ratio: number; p99?: number }
}

export interface Specimen {
  id: string
  filename: string
  label: string
  role: string
  bytes: number
  nativeWidth: number
  nativeHeight: number
  w: number
  h: number
  work: HTMLCanvasElement
  lum: Uint8Array
  exif: ExifEntry[]
  tagCount: number
  gps: { lat: number; lon: number } | null
  provenance: SpecimenProvenance
  forensic?: ForensicInfo
  /** Normalised position of the richest saturated region, chosen at assembly. */
  chromaSeed?: { x: number; y: number }
}

export interface PinCard {
  id: string
  kind: 'swatch' | 'report'
  title: string
  subtitle: string
  createdAt: number
  png: string
  canvas: HTMLCanvasElement
  css: string
  json: Record<string, unknown>
}

export interface Layout {
  width: number
  height: number
  /** Display pixels per source pixel. */
  scale: number
}
