import type { LensType } from './types'

/**
 * Compound optic geometry.
 *
 * Two lenses sharing screen space are not painted over one another: the vesica
 * piscis they form is clipped out and both optical layers are composited inside
 * it, so a magnifier can sample a heatmap and two filters can stack.
 */

export interface Circle {
  cx: number
  cy: number
  r: number
}

export interface ArcSegment {
  c: Circle
  start: number
  end: number
}

export interface CirclePair {
  hit: boolean
  /** Centre distance. */
  d: number
  /** Overlap depth, 0..1 (1 = fully concentric). */
  depth: number
  mid: { x: number; y: number }
  arcs: [ArcSegment, ArcSegment] | null
}

const TAU = Math.PI * 2
const clamp01 = (v: number) => Math.min(1, Math.max(-1, v))

export function circlePair(a: Circle, b: Circle): CirclePair {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const d = Math.hypot(dx, dy)
  const hit = d < a.r + b.r
  const mid = { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 }
  if (!hit) return { hit: false, d, depth: 0, mid, arcs: null }

  // Concentric (or near-concentric) lenses: the intersection is the smaller
  // circle and there is no arc pair to compute, but they are fully compounded.
  if (d < 1) return { hit: true, d, depth: 1, mid: { x: a.cx, y: a.cy }, arcs: null }

  const depth = Math.min(1, (a.r + b.r - d) / (2 * Math.min(a.r, b.r)))
  const phi = Math.atan2(dy, dx)
  const alphaA = Math.acos(clamp01((d * d + a.r * a.r - b.r * b.r) / (2 * d * a.r)))
  const alphaB = Math.acos(clamp01((d * d + b.r * b.r - a.r * a.r) / (2 * d * b.r)))

  return {
    hit: true,
    d,
    depth,
    mid,
    arcs: [
      { c: a, start: phi - alphaA, end: phi + alphaA },
      { c: b, start: phi + Math.PI - alphaB, end: phi + Math.PI + alphaB },
    ],
  }
}

/** Clip to the exact intersection of both circles (two sequential clips). */
export function clipVesica(ctx: CanvasRenderingContext2D, a: Circle, b: Circle): void {
  ctx.beginPath()
  ctx.arc(a.cx, a.cy, a.r, 0, TAU)
  ctx.clip()
  ctx.beginPath()
  ctx.arc(b.cx, b.cy, b.r, 0, TAU)
  ctx.clip()
}


/**
 * Blend policy for two filter lenses. Dither over ELA uses hard-light so the
 * dot pattern modulates the heatmap; the rest stack additively.
 */
export function blendFor(lower: LensType, upper: LensType): GlobalCompositeOperation {
  const pair = [lower, upper].sort().join('+')
  if (pair === 'dither+ela') return 'hard-light'
  return 'screen'
}

export function isMagnifier(type: LensType): boolean {
  return type === 'chroma'
}

export function compoundLabel(count: number): string {
  return `${Math.max(2, count)}× STACK`
}

export interface CompoundChip {
  key: string
  x: number
  y: number
  label: string
}

/** Overlap beyond this reads as stacked rather than side by side. */
const STACKED_DEPTH = 0.62

/**
 * Where the `N× STACK` markers sit. Side-by-side lenses get one at the vesica
 * midpoint; lenses stacked almost concentrically would put that midpoint on
 * their own readout, so their chips move above the rim and collapse into a
 * single marker for the whole cluster.
 */
export function compoundChips(
  pairs: Array<{ key: string; ids: [string, string]; a: Circle; b: Circle }>,
): CompoundChip[] {
  const loose: CompoundChip[] = []
  const stacked: CompoundChip[] = []
  const clustered = new Set<string>()

  for (const { key, ids, a, b } of pairs) {
    const pair = circlePair(a, b)
    if (!pair.hit) continue
    if (pair.depth <= STACKED_DEPTH) {
      loose.push({ key, x: pair.mid.x, y: pair.mid.y, label: compoundLabel(2) })
      continue
    }
    ids.forEach((id) => clustered.add(id))
    stacked.push({
      key,
      x: (a.cx + b.cx) / 2,
      y: Math.min(a.cy - a.r, b.cy - b.r) - 18,
      label: compoundLabel(2),
    })
  }

  if (stacked.length < 2) return [...loose, ...stacked]

  const x = stacked.reduce((sum, chip) => sum + chip.x, 0) / stacked.length
  const y = Math.min(...stacked.map((chip) => chip.y))
  return [...loose, { key: 'cluster', x, y, label: compoundLabel(clustered.size) }]
}

/**
 * Orbit angles that clear every lens's own chrome and the `N× STACK` chip:
 * 0°/45°/180° belong to the gain stepper, the action and close, 270° to the
 * chip, and 90° to the dither mode button.
 */
const READOUT_ANGLES = [315, 225, 135]
const READOUT_GAP = 26
/** Half a readout pill, so a candidate clears a neighbouring rim rather than grazing it. */
const PILL_HALF = 34

/**
 * Readout angle per lens. Each candidate is scored by how far it sits from the
 * other lens rims and from readouts already placed, so overlapping lenses keep
 * their pills apart and out from under the front glass.
 */
export function placeReadouts(lenses: Array<{ id: string; circle: Circle }>): Record<string, number> {
  const placed: Array<{ x: number; y: number }> = []
  const angles: Record<string, number> = {}

  // Topmost lens first so the front glass keeps the default upper-right slot.
  for (const { id, circle } of [...lenses].reverse()) {
    const others = lenses.filter((lens) => lens.id !== id).map((lens) => lens.circle)
    let best = READOUT_ANGLES[0]
    let bestScore = -Infinity

    for (const angle of READOUT_ANGLES) {
      const rad = (angle * Math.PI) / 180
      const point = {
        x: circle.cx + Math.cos(rad) * (circle.r + READOUT_GAP),
        y: circle.cy + Math.sin(rad) * (circle.r + READOUT_GAP),
      }
      const clearance = others.length
        ? Math.min(...others.map((other) => Math.hypot(point.x - other.cx, point.y - other.cy) - other.r - PILL_HALF))
        : Infinity
      // Separation decides; sitting under another lens is a hard demotion.
      const separation = placed.length
        ? Math.min(...placed.map((other) => Math.hypot(point.x - other.x, point.y - other.y)))
        : 10_000
      const score = separation + (clearance < 0 ? -100_000 : 0)
      if (score > bestScore) {
        bestScore = score
        best = angle
      }
    }

    const rad = (best * Math.PI) / 180
    placed.push({ x: circle.cx + Math.cos(rad) * (circle.r + READOUT_GAP), y: circle.cy + Math.sin(rad) * (circle.r + READOUT_GAP) })
    angles[id] = best
  }

  return angles
}

/** Dashed International-Orange arcs along the boundary each lens keeps inside the other. */
export function strokeCompoundArcs(ctx: CanvasRenderingContext2D, pair: CirclePair): void {
  if (!pair.hit || !pair.arcs) return
  ctx.save()
  ctx.strokeStyle = '#FF4F00'
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.lineDashOffset = 0
  for (const arc of pair.arcs) {
    ctx.beginPath()
    ctx.arc(arc.c.cx, arc.c.cy, arc.c.r, arc.start, arc.end)
    ctx.stroke()
  }
  ctx.restore()
}
