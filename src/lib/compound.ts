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
  const entries = pairs
    .map((entry) => ({ ...entry, pair: circlePair(entry.a, entry.b) }))
    .filter((entry) => entry.pair.hit)

  // Pairs sharing a lens belong to one stack and share one marker.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const root = parent.get(id) ?? id
    if (root === id) return id
    const lifted = find(root)
    parent.set(id, lifted)
    return lifted
  }
  for (const { ids } of entries) {
    const [a, b] = ids.map(find)
    if (a !== b) parent.set(a, b)
  }

  const groups = new Map<string, typeof entries>()
  for (const entry of entries) {
    const root = find(entry.ids[0])
    groups.set(root, [...(groups.get(root) ?? []), entry])
  }

  const chips: CompoundChip[] = []
  for (const group of groups.values()) {
    const circles = group.flatMap((entry) => [entry.a, entry.b])
    const top = Math.min(...circles.map((circle) => circle.cy - circle.r)) - 18

    if (group.length === 1) {
      const [{ key, pair }] = group
      const tight = pair.depth > STACKED_DEPTH
      chips.push({
        key,
        x: tight ? (group[0].a.cx + group[0].b.cx) / 2 : pair.mid.x,
        y: tight ? top : pair.mid.y,
        label: compoundLabel(2),
      })
      continue
    }

    const ids = new Set(group.flatMap((entry) => entry.ids))
    const left = Math.min(...circles.map((circle) => circle.cx))
    const right = Math.max(...circles.map((circle) => circle.cx))
    chips.push({ key: `cluster-${[...ids].join('-')}`, x: (left + right) / 2, y: top, label: compoundLabel(ids.size) })
  }

  return chips
}

export type ChromeItem = 'readout' | 'action' | 'close' | 'stepper' | 'mode'

export interface ChromeAnchor {
  item: ChromeItem
  angle: number
  radius: number
}

/** The familiar resting layout, kept whenever a lens overlaps nothing. */
const PREFERRED_ANGLE: Record<ChromeItem, number> = {
  readout: 315,
  action: 45,
  close: 180,
  stepper: 0,
  mode: 90,
}

/** Orbit radii beyond the rim, tried in order. */
const CHROME_TIERS = [26, 54]
/** Half a pill, so a slot can clear a neighbouring rim instead of grazing it. */
const PILL_HALF = 34
const MIN_GAP = 74
const CHIP_GAP = 52

function candidateAngles(preferred: number): number[] {
  return Array.from({ length: 8 }, (_, index) => (preferred + index * 45) % 360)
}

/**
 * Chrome slot for every pill of every lens. A lens that touches nothing keeps
 * the familiar layout; inside a stack the slots are solved greedily from the
 * front glass back, so no readout, action or close button lands on another
 * lens's pill, on a neighbouring rim, or on the `N× STACK` chip.
 */
type Fitting = { id: string; circle: Circle; items: ChromeItem[] }

/** Groups of lenses whose circles touch, transitively. */
function clustersOf(lenses: Fitting[]): number[][] {
  const parent = lenses.map((_, index) => index)
  const find = (index: number): number =>
    parent[index] === index ? index : (parent[index] = find(parent[index]))

  for (let i = 0; i < lenses.length; i++) {
    for (let j = i + 1; j < lenses.length; j++) {
      if (circlePair(lenses[i].circle, lenses[j].circle).hit) parent[find(i)] = find(j)
    }
  }

  const groups = new Map<number, number[]>()
  lenses.forEach((_, index) => {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), index])
  })
  return [...groups.values()]
}

/**
 * Three or more lenses leave no room for per-lens orbits, so the whole cluster
 * shares one ring: every pill of every lens gets its own slice, evenly spaced.
 * The ring grows until the widest pill fits between neighbours.
 */
/** Degrees left free at the top of the ring so the `N× STACK` chip stays clear. */
const CHIP_GAP_DEGREES = 60
/** Width the ring has to fit between neighbouring pills. */
const RING_PITCH = 68

function ringAnchors(members: Fitting[]): Record<string, ChromeAnchor[]> {
  const items = [...members].reverse().flatMap((member) => member.items.map((item) => ({ id: member.id, item })))
  const maxRadius = Math.max(...members.map((member) => member.circle.r))
  const span = 360 - CHIP_GAP_DEGREES
  const step = span / Math.max(1, items.length - 1)
  const radius = Math.max(
    maxRadius + CHROME_TIERS[0],
    RING_PITCH / 2 / Math.sin((Math.min(step, 90) * Math.PI) / 360),
  )

  const layout: Record<string, ChromeAnchor[]> = {}
  items.forEach((entry, index) => {
    const angle = (270 + CHIP_GAP_DEGREES / 2 + index * step) % 360
    layout[entry.id] = [...(layout[entry.id] ?? []), { item: entry.item, angle, radius }]
  })
  return layout
}

function solvePair(
  lenses: Fitting[],
  avoid: Array<{ x: number; y: number }>,
): Record<string, ChromeAnchor[]> {
  const placed: Array<{ x: number; y: number }> = []
  const layout: Record<string, ChromeAnchor[]> = {}

  for (const { id, circle, items } of [...lenses].reverse()) {
    const others = lenses.filter((lens) => lens.id !== id).map((lens) => lens.circle)
    const crowded = others.some(
      (other) => Math.hypot(other.cx - circle.cx, other.cy - circle.cy) < other.r + circle.r,
    )
    const anchors: ChromeAnchor[] = []

    for (const item of items) {
      if (!crowded) {
        anchors.push({ item, angle: PREFERRED_ANGLE[item], radius: circle.r + CHROME_TIERS[0] })
        continue
      }

      let best: ChromeAnchor = { item, angle: PREFERRED_ANGLE[item], radius: circle.r + CHROME_TIERS[0] }
      let bestScore = -Infinity

      for (const tier of CHROME_TIERS) {
        for (const angle of candidateAngles(PREFERRED_ANGLE[item])) {
          const radius = circle.r + tier
          const rad = (angle * Math.PI) / 180
          const point = { x: circle.cx + Math.cos(rad) * radius, y: circle.cy + Math.sin(rad) * radius }
          const gap = placed.length
            ? Math.min(...placed.map((other) => Math.hypot(point.x - other.x, point.y - other.y)))
            : 10_000
          const chipGap = avoid.length
            ? Math.min(...avoid.map((other) => Math.hypot(point.x - other.x, point.y - other.y)))
            : 10_000
          const covered = others.some(
            (other) => Math.hypot(point.x - other.cx, point.y - other.cy) < other.r + PILL_HALF,
          )

          let score = Math.min(gap, chipGap)
          if (gap < MIN_GAP) score -= 500
          if (chipGap < CHIP_GAP) score -= 500
          if (covered) score -= 1000

          if (score > bestScore) {
            bestScore = score
            best = { item, angle, radius }
          }
        }
      }

      anchors.push(best)
      const rad = (best.angle * Math.PI) / 180
      placed.push({ x: circle.cx + Math.cos(rad) * best.radius, y: circle.cy + Math.sin(rad) * best.radius })
    }

    layout[id] = anchors
  }

  return layout
}

/**
 * Chrome slot for every pill of every lens. A lone lens keeps the familiar
 * layout, a pair is solved slot by slot, and a stack of three or more shares an
 * evenly divided ring, so no readout, action or close button ever lands on
 * another lens's pill or on the `N× STACK` chip.
 */
export function placeChrome(
  lenses: Fitting[],
  avoid: Array<{ x: number; y: number }> = [],
): Record<string, ChromeAnchor[]> {
  const layout: Record<string, ChromeAnchor[]> = {}

  for (const group of clustersOf(lenses)) {
    const members = group.map((index) => lenses[index])
    const anchors =
      members.length === 1
        ? {
            [members[0].id]: members[0].items.map((item) => ({
              item,
              angle: PREFERRED_ANGLE[item],
              radius: members[0].circle.r + CHROME_TIERS[0],
            })),
          }
        : members.length === 2
          ? solvePair(members, avoid)
          : ringAnchors(members)
    Object.assign(layout, anchors)
  }

  return layout
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
