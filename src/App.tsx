import { useCallback, useEffect, useRef, useState } from 'react'
import TopTelemetryBar from './components/TopTelemetryBar'
import SlideTray from './components/SlideTray'
import LightTable from './components/LightTable'
import LensDock from './components/LensDock'
import Pinboard from './components/Pinboard'
import { loadSpecimens, specimenFromFile } from './lib/specimens'
import { exportAllZip } from './lib/cards'
import { sound } from './lib/soundEngine'
import type { DitherMode, LensState, LensType, PinCard, Specimen, SpliceBox, ThemeName } from './lib/types'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

type LensDefaults = Omit<LensState, 'id' | 'type'>

const LENS_DEFAULTS: Record<LensType, LensDefaults> = {
  ela: { x: 0.4, y: 0.46, radius: 112, gain: 22, threshold: 128, dotScale: 2, mode: 'bayer', z: 1, rotation: 0 },
  chroma: { x: 0.64, y: 0.4, radius: 100, gain: 22, threshold: 128, dotScale: 2, mode: 'bayer', z: 1, rotation: 0 },
  dither: { x: 0.5, y: 0.64, radius: 104, gain: 22, threshold: 128, dotScale: 2, mode: 'bayer', z: 1, rotation: 0 },
  sobel: { x: 0.56, y: 0.36, radius: 118, gain: 22, threshold: 128, dotScale: 2, mode: 'bayer', z: 1, rotation: 0 },
}

/** The most obvious doctored region on this specimen, in normalised photo space. */
function spliceAnchor(specimen: Specimen): { x: number; y: number } {
  const boxes: SpliceBox[] = specimen.forensic
    ? specimen.forensic.spliceBoxes?.length
      ? specimen.forensic.spliceBoxes
      : [specimen.forensic.spliceBox]
    : []
  // The clone on plain masonry is the composed hero target; fall back to the
  // strongest measured region for uploaded or unlabelled specimens.
  const box =
    boxes.find((candidate) => candidate.label === 'CLONED MASONRY') ??
    [...boxes].sort((a, b) => (b.elaRatio ?? 0) - (a.elaRatio ?? 0))[0]
  if (!box) return { x: 0.44, y: 0.5 }
  return {
    x: clamp((box.left + box.width / 2) / Math.max(1, specimen.nativeWidth), 0.14, 0.86),
    y: clamp((box.top + box.height / 2) / Math.max(1, specimen.nativeHeight), 0.14, 0.86),
  }
}

/**
 * The cold open: one forensic lens parked on the fabrication, one chromatic
 * magnifier on the richest colour region, deliberately overlapping so the
 * compound optic is already on screen three seconds in.
 */
function coldOpenLenses(specimen: Specimen): LensState[] {
  const anchor = spliceAnchor(specimen)
  const boxes: SpliceBox[] = specimen.forensic
    ? specimen.forensic.spliceBoxes?.length
      ? specimen.forensic.spliceBoxes
      : [specimen.forensic.spliceBox]
    : []
  // The colour plate is the vivid half of the forgery; without one, fall back
  // to the measured richest region of the photograph.
  const plate = boxes.find((box) => box.label === 'PASTED PLATE')
  const seed = plate
    ? {
        x: (plate.left + plate.width / 2) / Math.max(1, specimen.nativeWidth),
        y: (plate.top + plate.height / 2) / Math.max(1, specimen.nativeHeight),
      }
    : specimen.chromaSeed ?? { x: clamp(anchor.x + 0.1, 0.2, 0.8), y: clamp(anchor.y + 0.04, 0.2, 0.8) }
  const chromaX = clamp(seed.x, 0.18, 0.82)
  const chromaY = clamp(seed.y, 0.18, 0.82)

  return [
    {
      id: 'ela-primary',
      type: 'ela',
      ...LENS_DEFAULTS.ela,
      x: anchor.x,
      y: anchor.y,
      // 104 keeps the clone fully inside the glass while leaving the magnifier
      // clear of it, so the swatch harvests real colour rather than ELA noise.
      radius: 104,
      gain: 22,
      z: 1,
    },
    {
      id: 'chroma-primary',
      type: 'chroma',
      ...LENS_DEFAULTS.chroma,
      x: chromaX,
      y: chromaY,
      radius: 84,
      z: 2,
    },
  ]
}

function startingLenses(specimen: Specimen): LensState[] {
  return specimen.forensic ? coldOpenLenses(specimen) : []
}

export default function App() {
  const [bundled, setBundled] = useState<Specimen[]>([])
  const [uploads, setUploads] = useState<Specimen[]>([])
  const [activeId, setActiveId] = useState('')
  const [lenses, setLenses] = useState<LensState[]>([])
  const [pins, setPins] = useState<PinCard[]>([])
  const [theme, setTheme] = useState<ThemeName>('darkroom')
  const [audioOn, setAudioOn] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(true)
  const [busyUpload, setBusyUpload] = useState(false)
  const [coldOpen, setColdOpen] = useState(false)

  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const zCounter = useRef(2)

  const specimens = [...uploads, ...bundled]
  const active = specimens.find((specimen) => specimen.id === activeId) ?? specimens[0] ?? null

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2800)
  }, [])

  /* --------------------------------------------------------------- boot --- */
  useEffect(() => {
    let cancelled = false
    setScanning(true)
    loadSpecimens()
      .then((list) => {
        if (cancelled) return
        setBundled(list)
        const target = list.find((specimen) => specimen.forensic) ?? list[0]
        if (target) {
          setActiveId(target.id)
          setLenses(startingLenses(target))
          setColdOpen(true)
        }
      })
      .catch((error: Error) => {
        if (!cancelled) showNotice(error.message || 'SPECIMEN LOAD FAILED')
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setScanning(false)
      })
    return () => {
      cancelled = true
    }
  }, [showNotice])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    sound.setEnabled(audioOn)
  }, [audioOn])

  useEffect(() => {
    const unlock = () => sound.unlock()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])

  /* -------------------------------------------------------------- lenses --- */
  const promoteLens = useCallback((id: string) => {
    setLenses((prev) => {
      const target = prev.find((lens) => lens.id === id)
      if (!target) return prev
      const top = prev.reduce((max, lens) => Math.max(max, lens.z), 0)
      if (target.z === top) return prev
      zCounter.current = top + 1
      return prev.map((lens) => (lens.id === id ? { ...lens, z: top + 1 } : lens))
    })
  }, [])

  const removeLens = useCallback((id: string) => {
    sound.click()
    setLenses((prev) => prev.filter((lens) => lens.id !== id))
  }, [])

  const toggleLens = (type: LensType) => {
    sound.click()
    setLenses((prev) => {
      if (prev.some((lens) => lens.type === type)) return prev.filter((lens) => lens.type !== type)
      const index = prev.length
      zCounter.current = Math.max(zCounter.current, ...prev.map((lens) => lens.z), 0) + 1
      return [
        ...prev,
        {
          id: `${type}-${Date.now()}`,
          type,
          ...LENS_DEFAULTS[type],
          z: zCounter.current,
          x: clamp(LENS_DEFAULTS[type].x + (index % 3) * 0.05, 0.2, 0.8),
          y: clamp(LENS_DEFAULTS[type].y + (index % 2) * 0.06, 0.2, 0.8),
        },
      ]
    })
  }

  const moveLens = (id: string, nx: number, ny: number) => {
    setLenses((prev) =>
      prev.map((lens) => (lens.id === id ? { ...lens, x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) } : lens)),
    )
  }

  const patchLens = (id: string, patch: Partial<LensState>) => {
    setLenses((prev) =>
      prev.map((lens) => {
        if (lens.id !== id) return lens
        const next: LensState = { ...lens, ...patch }
        if (patch.radius !== undefined) next.radius = clamp(patch.radius, 70, 170)
        if (patch.gain !== undefined) next.gain = clamp(Math.round(patch.gain), 10, 40)
        if (patch.threshold !== undefined) next.threshold = clamp(Math.round(patch.threshold), 0, 255)
        if (patch.dotScale !== undefined) next.dotScale = clamp(Math.round(patch.dotScale), 1, 6)
        if (patch.rotation !== undefined) next.rotation = ((patch.rotation % 360) + 360) % 360
        return next
      }),
    )
  }

  /* -------------------------------------------------------------- uploads --- */
  const handleUpload = async (file: File) => {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      showNotice('UNSUPPORTED FORMAT · JPEG / PNG / WEBP ONLY')
      sound.click()
      return
    }
    if (file.size > 40 * 1024 * 1024) {
      showNotice('FILE REJECTED · 40 MB LIMIT')
      sound.click()
      return
    }
    setBusyUpload(true)
    try {
      const specimen = await specimenFromFile(file)
      setUploads((prev) => [specimen, ...prev].slice(0, 5))
      setActiveId(specimen.id)
      showNotice(`SPECIMEN MOUNTED · ${specimen.filename.toUpperCase()}`)
      sound.shutter()
    } catch (error) {
      showNotice((error as Error).message || 'SPECIMEN REJECTED')
    } finally {
      setBusyUpload(false)
    }
  }

  /* ----------------------------------------------------------------- pins --- */
  const addPin = useCallback((pin: PinCard) => {
    setPins((prev) => [pin, ...prev].slice(0, 20))
  }, [])

  const removePin = (id: string) => {
    setPins((prev) => prev.filter((pin) => pin.id !== id))
    sound.click()
  }

  return (
    <div className="studio">
      <TopTelemetryBar
        specimen={active}
        theme={theme}
        audioOn={audioOn}
        scanning={scanning}
        onTheme={() => {
          sound.click()
          setTheme((prev) => (prev === 'darkroom' ? 'daylight' : 'darkroom'))
        }}
        onAudio={() => {
          setAudioOn((prev) => !prev)
          sound.click()
        }}
        onUpload={() => uploadInputRef.current?.click()}
      />

      <SlideTray
        specimens={specimens}
        activeId={active?.id ?? ''}
        onSelect={(id) => {
          if (id === activeId) return
          const target = specimens.find((specimen) => specimen.id === id)
          setActiveId(id)
          // The forensic slide opens composed; every other slide starts as a
          // clean table so the operator mounts the optics they want.
          setLenses(target ? startingLenses(target) : [])
          sound.click()
        }}
        onUpload={(file) => void handleUpload(file)}
        busy={busyUpload || loading}
      />

      {active ? (
        <LightTable
          specimen={active}
          lenses={lenses}
          theme={theme}
          coldOpen={coldOpen}
          onLensMove={moveLens}
          onLensParam={patchLens}
          onLensActivate={promoteLens}
          onLensClose={removeLens}
          onEject={addPin}
          onNotice={showNotice}
        />
      ) : (
        <section className="stage stage--empty">
          <div className="boot">
            <span className="boot-mark">LOUPE</span>
            <span className="engraved">
              {loading ? 'CALIBRATING OPTICS · READING SPECIMENS' : 'NO SPECIMEN MOUNTED'}
            </span>
            <span className="boot-bar" aria-hidden="true">
              <span />
            </span>
          </div>
        </section>
      )}

      <LensDock active={lenses.map((lens) => lens.type)} onToggle={toggleLens} />

      <Pinboard
        pins={pins}
        onRemove={removePin}
        onCopy={showNotice}
        onExportAll={() => {
          exportAllZip(pins, specimens)
          showNotice('ARCHIVE WRITTEN · ZIP DOWNLOADED')
          sound.shutter()
        }}
      />

      <input
        ref={uploadInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleUpload(file)
          event.target.value = ''
        }}
      />

      <div className={`notice ${notice ? 'is-visible' : ''}`} role="status" aria-live="polite">
        {notice}
      </div>
    </div>
  )
}
