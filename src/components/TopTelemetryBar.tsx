import type { Specimen, ThemeName } from '../lib/types'
import { formatBytes } from '../lib/cards'

interface Props {
  specimen: Specimen | null
  theme: ThemeName
  audioOn: boolean
  onTheme: () => void
  onAudio: () => void
  onUpload: () => void
  scanning: boolean
}

export default function TopTelemetryBar({
  specimen,
  theme,
  audioOn,
  onTheme,
  onAudio,
  onUpload,
  scanning,
}: Props) {
  const exposure = specimen
    ? specimen.exif
        .filter((entry) => ['SENSITIVITY', 'APERTURE', 'SHUTTER'].includes(entry.label))
        .map((entry) => entry.value)
        .join(' · ')
    : '—'

  return (
    <header className="topbar">
      <div className="brand">
        <span className={`power-led ${scanning ? 'is-busy' : ''}`} aria-hidden="true" />
        <span className="brand-name">LOUPE</span>
        <span className="brand-sub engraved">OPTICAL LAB 01</span>
      </div>

      <div className="meta-strip">
        {specimen ? (
          <>
            <span className="meta-item">
              <span className="meta-key">SPECIMEN</span>
              <span className="meta-value mono">{specimen.filename}</span>
            </span>
            <span className="meta-sep" aria-hidden="true" />
            <span className="meta-item">
              <span className="meta-key">DIMENSIONS</span>
              <span className="meta-value mono">
                {specimen.nativeWidth}×{specimen.nativeHeight}
              </span>
            </span>
            <span className="meta-sep" aria-hidden="true" />
            <span className="meta-item">
              <span className="meta-key">FILE SIZE</span>
              <span className="meta-value mono">{formatBytes(specimen.bytes)}</span>
            </span>
            <span className="meta-sep" aria-hidden="true" />
            <span className="meta-item">
              <span className="meta-key">BIT DEPTH</span>
              <span className="meta-value mono">8-BIT</span>
            </span>
            <span className="meta-sep" aria-hidden="true" />
            <span className="meta-item meta-item--wide">
              <span className="meta-key">EXPOSURE</span>
              <span className="meta-value mono">{exposure || 'NO EXIF'}</span>
            </span>
            {specimen.gps ? (
              <>
                <span className="meta-sep" aria-hidden="true" />
                <span className="meta-item">
                  <span className="meta-key">GPS</span>
                  <span className="meta-value mono meta-value--risk">EXPOSED</span>
                </span>
              </>
            ) : null}
          </>
        ) : (
          <span className="meta-item">
            <span className="meta-key">SPECIMEN</span>
            <span className="meta-value mono">{scanning ? 'READING…' : '—'}</span>
          </span>
        )}
      </div>

      <div className="topbar-controls">
        <button
          type="button"
          className="switch"
          aria-pressed={theme === 'daylight'}
          onClick={onTheme}
          title="Toggle daylight studio backlight"
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-knob" />
          </span>
          <span className="switch-label engraved">
            {theme === 'daylight' ? 'DAYLIGHT' : 'DARKROOM'}
          </span>
        </button>

        <button
          type="button"
          className="switch"
          aria-pressed={audioOn}
          onClick={onAudio}
          title="Toggle procedural audio"
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-knob" />
          </span>
          <span className="switch-label engraved">AUDIO FX</span>
        </button>

        <button type="button" className="upload-btn" onClick={onUpload}>
          <span aria-hidden="true">+</span> UPLOAD SPECIMEN
        </button>
      </div>
    </header>
  )
}
