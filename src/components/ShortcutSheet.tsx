import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  open: boolean
  onClose: () => void
}

const ROWS: Array<[string, string]> = [
  ['A / B / C / D', 'Mount or remove a lens'],
  ['↑ ↓ ← →', 'Move the focused lens'],
  ['Shift + arrows', 'Move in coarse steps'],
  ['+ / −', 'Open or close the aperture'],
  ['[ / ]', 'Rotate the bezel'],
  ['Wheel', 'Aperture'],
  ['Shift + wheel', 'Gain (forensics) · threshold (dither)'],
  ['Alt + wheel', 'Dither dot scale'],
  ['X', 'Close the focused lens'],
  ['?', 'Open or close this sheet'],
]

/**
 * Shortcut reference, opened with `?` or the header button. Focus moves to the
 * close control, Tab cycles inside the dialog, and Escape always dismisses it
 * and hands focus back to whatever had it before.
 */
export default function ShortcutSheet({ open, onClose }: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      // Keep Tab inside the dialog: without this the page behind stays reachable
      // and the sheet stops behaving like a modal at all.
      const sheet = sheetRef.current
      if (!sheet) return
      const focusable = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled'))
      if (!focusable.length) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      restoreRef.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  // Portalled to <body> so the chassis behind it can be made inert without
  // taking the dialog with it.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 className="sheet-title engraved" id="sheet-title">
            OPTICAL CONTROLS
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="sheet-close"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
          >
            ×
          </button>
        </header>

        <dl className="sheet-list">
          {ROWS.map(([keys, action]) => (
            <div className="sheet-row" key={keys}>
              <dt className="mono">{keys}</dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>

        <p className="sheet-note mono">
          Specimens are read on this device only. Nothing is uploaded.
        </p>
      </div>
    </div>,
    document.body,
  )
}
