import type { PinCard } from '../lib/types'
import { copyText, downloadCanvas } from '../lib/cards'

interface Props {
  pins: PinCard[]
  onRemove: (id: string) => void
  onExportAll: () => void
  onCopy: (message: string) => void
}

export default function Pinboard({ pins, onRemove, onExportAll, onCopy }: Props) {
  return (
    <aside className="pinboard" aria-label="Pinboard outputs">
      <header className="pinboard-head">
        <span className="engraved">PINBOARD OUTPUTS</span>
        <span className="mono pinboard-count">{String(pins.length).padStart(2, '0')}</span>
      </header>

      <div className="pinboard-list">
        {pins.length === 0 ? (
          <div className="pinboard-empty">
            <span className="pinboard-empty-mark" aria-hidden="true">
              ▤
            </span>
            <p className="engraved">NO EJECTED PLATES</p>
            <p className="mono">
              SNAP SWATCH or EJECT REPORT from a lens to pin an output here.
            </p>
          </div>
        ) : (
          pins.map((pin) => (
            <article key={pin.id} className="pin">
              <div className="pin-tape" aria-hidden="true" />
              <img className="pin-image" src={pin.png} alt={pin.title} />
              <div className="pin-head">
                <span className={`pin-kind ${pin.kind === 'swatch' ? 'is-swatch' : 'is-report'}`}>
                  {pin.kind === 'swatch' ? 'SWATCH' : 'REPORT'}
                </span>
                <span className="pin-title mono">{pin.title}</span>
                <button
                  type="button"
                  className="pin-remove"
                  onClick={() => onRemove(pin.id)}
                  aria-label={`Unpin ${pin.title}`}
                  title="Unpin"
                >
                  ×
                </button>
              </div>
              <p className="pin-sub mono">{pin.subtitle}</p>
              <div className="pin-actions">
                <button
                  type="button"
                  className="pin-action"
                  onClick={() => downloadCanvas(pin.canvas, `loupe-${pin.kind}-${pin.id}.png`)}
                >
                  PNG
                </button>
                <button
                  type="button"
                  className="pin-action"
                  onClick={() => {
                    void copyText(pin.css).then((ok) => onCopy(ok ? 'CSS COPIED' : 'CLIPBOARD BLOCKED'))
                  }}
                >
                  CSS
                </button>
                <button
                  type="button"
                  className="pin-action"
                  onClick={() => {
                    void copyText(JSON.stringify(pin.json, null, 2)).then((ok) =>
                      onCopy(ok ? 'JSON COPIED' : 'CLIPBOARD BLOCKED'),
                    )
                  }}
                >
                  JSON
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      <footer className="pinboard-foot">
        <button
          type="button"
          className="zip-btn"
          onClick={onExportAll}
          disabled={pins.length === 0}
        >
          EXPORT ALL ZIP
        </button>
      </footer>
    </aside>
  )
}
