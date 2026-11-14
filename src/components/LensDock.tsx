import type { LensType } from '../lib/types'

export const LENS_SPECS: Array<{
  type: LensType
  code: string
  name: string
  glyph: string
}> = [
  { type: 'ela', code: 'A', name: 'FORENSICS', glyph: '◎' },
  { type: 'chroma', code: 'B', name: 'CHROMA', glyph: '◉' },
  { type: 'dither', code: 'C', name: 'DITHER', glyph: '▦' },
  { type: 'sobel', code: 'D', name: 'EXIF X-RAY', glyph: '⌖' },
]

interface Props {
  active: LensType[]
  onToggle: (type: LensType) => void
}

export default function LensDock({ active, onToggle }: Props) {
  return (
    <div className="dock" role="toolbar" aria-label="Optical instrument dock">
      <div className="dock-body">
        {LENS_SPECS.map((spec) => {
          const isOn = active.includes(spec.type)
          return (
            <button
              key={spec.type}
              type="button"
              className={`dock-btn ${isOn ? 'is-on' : ''}`}
              aria-pressed={isOn}
              aria-keyshortcuts={spec.code}
              onClick={() => onToggle(spec.type)}
            >
              <span className="dock-glyph" aria-hidden="true">
                {spec.glyph}
              </span>
              <span className="dock-text">
                <span className="dock-code mono">{spec.code}</span>
                <span className="dock-name engraved">{spec.name}</span>
              </span>
              <span className="dock-led" aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <div className="dock-hint mono">
        DRAG RING · WHEEL APERTURE · SHIFT PARAM · ALT DOTS · ? KEYS
      </div>
    </div>
  )
}
