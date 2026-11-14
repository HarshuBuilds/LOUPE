import type { CSSProperties } from 'react'
import type { ChromeAnchor } from '../lib/compound'

interface Props {
  lensId: string
  cx: number
  cy: number
  anchors: ChromeAnchor[]
  readout: string
  action: string
  risk?: boolean
  gain?: number
  mode?: string
  onAction: () => void
  onClose: () => void
  onGain?: (delta: number) => void
  onMode?: () => void
}

function at(cx: number, cy: number, anchor: ChromeAnchor): CSSProperties {
  const rad = (anchor.angle * Math.PI) / 180
  return {
    left: cx + Math.cos(rad) * anchor.radius,
    top: cy + Math.sin(rad) * anchor.radius,
  }
}

/**
 * Lens chrome lives in a layer above every glass. A readout belonging to a lens
 * buried under a stack therefore stays legible instead of being cut by the front
 * lens's bezel, and each pill's orbit comes from `placeChrome`, so stacked
 * lenses never drop two readouts or two close buttons on the same spot.
 */
export default function LensControls({
  lensId,
  cx,
  cy,
  anchors,
  readout,
  action,
  risk = false,
  gain,
  mode,
  onAction,
  onClose,
  onGain,
  onMode,
}: Props) {
  const slot = (item: ChromeAnchor['item']) => anchors.find((anchor) => anchor.item === item)
  const readoutSlot = slot('readout')
  const actionSlot = slot('action')
  const closeSlot = slot('close')
  const stepperSlot = slot('stepper')
  const modeSlot = slot('mode')

  return (
    <>
      {readoutSlot ? (
        <div
          className={`lens-pill lens-pill--readout${risk ? ' lens-pill--risk' : ''}`}
          style={at(cx, cy, readoutSlot)}
          data-lens={lensId}
        >
          {readout}
        </div>
      ) : null}

      {actionSlot ? (
        <button
          type="button"
          className="lens-pill lens-pill--action"
          style={at(cx, cy, actionSlot)}
          data-lens={lensId}
          aria-label={`${action} — eject this lens output`}
          onClick={(event) => {
            event.stopPropagation()
            onAction()
          }}
        >
          {action}
        </button>
      ) : null}

      {stepperSlot && gain !== undefined && onGain ? (
        <div className="lens-stepper" style={at(cx, cy, stepperSlot)} data-lens={lensId}>
          <button
            type="button"
            aria-label="Decrease gain"
            onClick={(event) => {
              event.stopPropagation()
              onGain(-2)
            }}
          >
            −
          </button>
          <span className="stepper-val mono">{gain}×</span>
          <button
            type="button"
            aria-label="Increase gain"
            onClick={(event) => {
              event.stopPropagation()
              onGain(2)
            }}
          >
            +
          </button>
        </div>
      ) : null}

      {closeSlot ? (
        <button
          type="button"
          className="lens-pill lens-pill--close"
          style={at(cx, cy, closeSlot)}
          data-lens={lensId}
          aria-label="Close lens"
          title="Close lens"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          ×
        </button>
      ) : null}

      {modeSlot && mode && onMode ? (
        <button
          type="button"
          className="lens-mode-single mono"
          style={{ ...at(cx, cy, modeSlot), bottom: 'auto', transform: 'translate(-50%, -50%)' }}
          data-lens={lensId}
          aria-label="Toggle dither mode"
          onClick={(event) => {
            event.stopPropagation()
            onMode()
          }}
        >
          {mode}
        </button>
      ) : null}
    </>
  )
}
