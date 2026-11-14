import { useEffect, useRef } from 'react'
import type { Specimen } from '../lib/types'

interface Props {
  specimens: Specimen[]
  activeId: string
  onSelect: (id: string) => void
  onUpload: (file: File) => void
  busy: boolean
}

function SlideThumb({ specimen }: { specimen: Specimen }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = 168
    const h = 96
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)
    const scale = Math.max(w / specimen.w, h / specimen.h)
    const sw = w / scale
    const sh = h / scale
    ctx.drawImage(specimen.work, (specimen.w - sw) / 2, (specimen.h - sh) / 2, sw, sh, 0, 0, w, h)
  }, [specimen])

  return <canvas ref={ref} className="slide-thumb" aria-hidden="true" />
}

export default function SlideTray({ specimens, activeId, onSelect, onUpload, busy }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  return (
    <aside className="tray">
      <header className="tray-head">
        <span className="engraved">35MM SLIDE TRAY</span>
        <span className="tray-count mono">{specimens.length} / 3</span>
      </header>

      <div className="tray-list">
        {specimens.map((specimen) => (
          <button
            key={specimen.id}
            type="button"
            className={`slide ${specimen.id === activeId ? 'is-active' : ''}`}
            onClick={() => onSelect(specimen.id)}
            aria-pressed={specimen.id === activeId}
          >
            <span className="slide-mount">
              <span className="slide-sprockets" aria-hidden="true" />
              <SlideThumb specimen={specimen} />
              <span className="slide-number mono">{specimen.label.replace('SPECIMEN ', '')}</span>
            </span>
            <span className="slide-meta">
              <span className="slide-name mono">{specimen.filename}</span>
              <span className="slide-role engraved">{specimen.role}</span>
              <span className="slide-tags mono">
                <span className="tag">CC0</span>
                {specimen.gps ? <span className="tag tag-risk">GPS</span> : null}
                {specimen.forensic ? <span className="tag tag-accent">EDIT</span> : null}
              </span>
            </span>
            <span className="slide-led" aria-hidden="true" />
          </button>
        ))}
      </div>

      <div
        className={`dropzone ${busy ? 'is-busy' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          const file = event.dataTransfer.files?.[0]
          if (file) onUpload(file)
        }}
      >
        <button type="button" className="dropzone-btn" onClick={() => inputRef.current?.click()}>
          <span className="dropzone-plus" aria-hidden="true">
            +
          </span>
          <span>
            <span className="engraved">DROP IMAGE</span>
            <span className="dropzone-sub mono">PNG · JPEG · WEBP</span>
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) onUpload(file)
            event.target.value = ''
          }}
        />
      </div>

      <footer className="tray-foot mono">
        {busy ? 'MOUNTING…' : 'LOCAL FILES · NO NETWORK'}
      </footer>
    </aside>
  )
}
