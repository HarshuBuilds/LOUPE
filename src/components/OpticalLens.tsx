import { useEffect, useRef } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { sound } from '../lib/soundEngine'
import type { LensState, PaletteColor } from '../lib/types'

const TAU = Math.PI * 2

export interface LensProbe {
  r: number
  g: number
  b: number
  hex: string
  oklch: string
  /** BASE / ELA / X-RAY / DITHER — what the reticle is actually sitting on. */
  source: string
}

interface Props {
  lens: LensState
  cx: number
  cy: number
  r: number
  viewport: { width: number; height: number }
  palette: PaletteColor[]
  probe?: LensProbe
  onMove: (nx: number, ny: number) => void
  onParam: (patch: Partial<LensState>) => void
  onActivate: () => void
  onClose: () => void
  index?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function orbitStyle(angleDeg: number, radius: number): CSSProperties {
  const rad = (angleDeg * Math.PI) / 180
  return {
    left: `calc(50% + ${Math.cos(rad) * radius}px)`,
    top: `calc(50% + ${Math.sin(rad) * radius}px)`,
  }
}

/** 72 graduations at 5°; only the cardinals carry a number. */
const TICKS = Array.from({ length: 72 }, (_, i) => i * 5)

export default function OpticalLens({
  lens,
  cx,
  cy,
  r,
  viewport,
  palette,
  probe,
  onMove,
  onParam,
  onActivate,
  onClose,
  index = 0,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ px: number; py: number; nx: number; ny: number } | null>(null)

  // Wheel must be non-passive so the page never scrolls while scrubbing a lens.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const dir = Math.sign(event.deltaY)
      if (!dir) return
      onActivate()
      const turned = (lens.rotation + dir * 6 + 360) % 360
      if (event.altKey) {
        if (lens.type === 'dither') {
          onParam({ dotScale: clamp(lens.dotScale - dir, 1, 6), rotation: turned })
          sound.detent()
        }
        return
      }
      if (event.shiftKey) {
        if (lens.type === 'ela') onParam({ gain: clamp(lens.gain - dir * 2, 10, 40), rotation: turned })
        if (lens.type === 'dither') onParam({ threshold: clamp(lens.threshold - dir * 6, 0, 255), rotation: turned })
        sound.detent()
        return
      }
      onParam({ radius: clamp(lens.radius - dir * 10, 70, 170), rotation: turned })
      sound.detent()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [lens.type, lens.radius, lens.gain, lens.threshold, lens.dotScale, lens.rotation, onParam, onActivate])

  const startDrag = (event: ReactPointerEvent<Element>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-nodrag]')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { px: event.clientX, py: event.clientY, nx: lens.x, ny: lens.y }
    onActivate()
    sound.unlock()
  }

  const moveDrag = (event: ReactPointerEvent<Element>) => {
    const drag = dragRef.current
    if (!drag) return
    onMove(
      drag.nx + (event.clientX - drag.px) / Math.max(1, viewport.width),
      drag.ny + (event.clientY - drag.py) / Math.max(1, viewport.height),
    )
  }

  const endDrag = (event: ReactPointerEvent<Element>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const dragProps = {
    onPointerDown: startDrag,
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }

  // A lens is one tab stop; arrows nudge it, brackets turn the bezel, and the
  // same +/- that the gain stepper uses opens and closes the aperture.
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const step = event.shiftKey ? 0.04 : 0.01

    switch (event.key) {
      case 'ArrowLeft':
        onMove(lens.x - step, lens.y)
        break
      case 'ArrowRight':
        onMove(lens.x + step, lens.y)
        break
      case 'ArrowUp':
        onMove(lens.x, lens.y - step)
        break
      case 'ArrowDown':
        onMove(lens.x, lens.y + step)
        break
      case '+':
      case '=':
        onParam({ radius: lens.radius + 6 })
        break
      case '-':
      case '_':
        onParam({ radius: lens.radius - 6 })
        break
      case '[':
        onParam({ rotation: lens.rotation - 15 })
        break
      case ']':
        onParam({ rotation: lens.rotation + 15 })
        break
      case 'x':
      case 'X':
        onClose()
        break
      case 'Enter':
      case ' ':
        onActivate()
        break
      default:
        return
    }

    event.preventDefault()
  }

  return (
    <div
      ref={rootRef}
      className={`lens lens--${lens.type} lens-enter`}
      style={{
        left: cx - r,
        top: cy - r,
        width: r * 2,
        height: r * 2,
        zIndex: 3 + lens.z,
        animationDelay: `${Math.min(index, 3) * 90}ms`,
      }}
      onPointerDown={onActivate}
      onFocus={onActivate}
      onKeyDown={handleKey}
      tabIndex={0}
      role="group"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - [ ] X"
      aria-label={`${lens.type} lens. Arrow keys move, plus and minus change the aperture, brackets rotate, X closes.`}
    >
      {/* Only the circular glass (and the ring strokes) take pointers, so the
          wrapper corners never block another lens. */}
      <div className="lens-hit" {...dragProps} />

      <svg className="lens-ring" viewBox="0 0 200 200" aria-hidden="true" {...dragProps}>
        <circle className="ring-casing" cx="100" cy="100" r="97" />
        <g
          className="ring-scale"
          style={{ transform: `rotate(${lens.rotation}deg)`, transformOrigin: '100px 100px' }}
        >
          <circle className="ring-metal" cx="100" cy="100" r="93" />
          <circle className="ring-brush" cx="100" cy="100" r="93" />
          {TICKS.map((deg) => {
            const major = deg % 30 === 0
            return (
              <g key={deg} transform={`rotate(${deg} 100 100)`}>
                <line
                  className={major ? 'ring-mark ring-mark--major' : 'ring-mark'}
                  x1="100"
                  y1="5"
                  x2="100"
                  y2={major ? 12 : 9}
                />
                {deg % 90 === 0 ? (
                  <text x="100" y="21" className="ring-label" textAnchor="middle">
                    {deg}°
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
        <circle className="ring-inner" cx="100" cy="100" r="86" />
        <path d="M100 8 L104.5 15 L95.5 15 Z" className="ring-notch" />
      </svg>

      <div className="lens-glass" aria-hidden="true" />
      <div className="lens-reticle" aria-hidden="true" />

      {lens.type === 'chroma'
        ? palette.map((colour, i) => (
            <span
              key={`${colour.hex}-${i}`}
              className="hex-pip"
              style={{ ...orbitStyle(42 + i * 24, r * 0.78), background: colour.hex }}
              title={colour.hex}
              aria-label={`Palette ${colour.hex}`}
              data-nodrag
            />
          ))
        : null}

      {lens.type === 'chroma'
        ? palette.map((colour, i) => (
            <span
              key={`node-${colour.hex}-${i}`}
              className="sample-node"
              style={{
                left: `calc(50% + ${colour.nx * r * 0.86}px)`,
                top: `calc(50% + ${colour.ny * r * 0.86}px)`,
                borderColor: colour.hex,
              }}
              aria-hidden="true"
            >
              <span className="sample-node-core" style={{ background: colour.hex }} />
            </span>
          ))
        : null}

      {lens.type === 'chroma' && probe ? (
        <div className="lens-probe" data-nodrag>
          <span className="probe-source mono">
            {probe.source} · 2.5×
          </span>
          <span className="probe-line mono">
            {probe.r} {probe.g} {probe.b}
          </span>
          <span className="probe-line mono">{probe.hex}</span>
          <span className="probe-line probe-line--oklch mono">{probe.oklch}</span>
        </div>
      ) : null}

    </div>
  )
}

export { TAU }
