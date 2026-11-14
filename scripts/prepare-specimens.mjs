#!/usr/bin/env node
/**
 * LOUPE · specimen preparation (build-time only, output is committed)
 *
 * 1. Resolve three photographs on Wikimedia Commons and assert they are CC0.
 * 2. Download the ORIGINAL bytes (never the thumbnailer — it strips EXIF),
 *    verify them against the SHA-1 the API reports for that revision.
 * 3. Downscale with EXIF/IPTC/ICC preserved, then re-parse the result with
 *    exifr to prove the camera + GPS tags survived.
 * 4. Build the forged sample: base re-compressed at q70, crisp vector plate
 *    composited on the flattest available region, final encode at the lowest
 *    quality that still leaves the plate near-pristine.
 * 5. Measure real Error Level Analysis on the finished file and refuse to
 *    write it unless the spliced region stands out from the image median.
 * 6. Emit public/specimens/credits.json with the provenance chain.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import exifr from 'exifr'

const ROOT = path.resolve(import.meta.dirname, '..')
const CACHE = path.join(ROOT, '.cache', 'specimens')
const OUT = path.join(ROOT, 'public', 'specimens')
const UA = 'LOUPE-specimen-prep/1.0 (offline image-forensics demo bundle)'

/** Minimum acceptable ELA ratio between the spliced region and the image median. */
const MIN_ELA_RATIO = 2.0

const SOURCES = [
  {
    slot: '01-camera-exif.jpg',
    role: 'Privacy X-Ray · genuine camera body, exposure and GPS tags',
    title: 'File:Sao Paulo Street at night.jpg',
    longEdge: 2200,
    quality: 90,
    requireGps: true,
  },
  {
    slot: '02-color-study.jpg',
    role: 'Chromatic Harvester · dense, high-chroma night market signage',
    title: 'File:Colorful Asian street market (Unsplash).jpg',
    longEdge: 2400,
    quality: 90,
    requireGps: false,
  },
  {
    slot: '03-forensic-edit.jpg',
    role: 'ELA Forensics · re-saved photograph with a splintered pasted region',
    title: 'File:Gray office building facade (Unsplash).jpg',
    longEdge: 2600,
    quality: 92,
    requireGps: false,
    splice: true,
  },
]

/* ------------------------------------------------------------------ utils */

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const fmtBytes = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

function base36ToHex(s) {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  let n = 0n
  for (const ch of String(s).toLowerCase()) {
    const v = digits.indexOf(ch)
    if (v < 0) throw new Error(`bad base36 char ${ch}`)
    n = n * 36n + BigInt(v)
  }
  return n.toString(16).padStart(40, '0')
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

/* --------------------------------------------------------- commons query */

async function commonsInfo(title) {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url|size|sha1|extmetadata',
    titles: title,
  }).toString()

  const json = await getJson(url)
  const page = Object.values(json.query?.pages ?? {})[0]
  if (!page || page.missing !== undefined) throw new Error(`Commons file not found: ${title}`)
  const info = page.imageinfo?.[0]
  if (!info) throw new Error(`No imageinfo for ${title}`)

  const meta = info.extmetadata ?? {}
  return {
    title: page.title,
    page: info.descriptionurl,
    url: String(info.url).split('?')[0],
    bytes: info.size,
    width: info.width,
    height: info.height,
    sha1Base36: info.sha1,
    license: stripTags(meta.License?.value ?? ''),
    licenseShort: stripTags(meta.LicenseShortName?.value ?? ''),
    licenseUrl: stripTags(meta.LicenseUrl?.value ?? ''),
    usageTerms: stripTags(meta.UsageTerms?.value ?? ''),
    attributionRequired: stripTags(meta.AttributionRequired?.value ?? ''),
    artist: stripTags(meta.Artist?.value ?? ''),
  }
}

function assertCc0(info) {
  const short = info.licenseShort.toLowerCase()
  const key = info.license.toLowerCase()
  const terms = info.usageTerms.toLowerCase()
  const ok =
    key === 'cc0' ||
    short.includes('cc0') ||
    terms.includes('zero') ||
    short.includes('public domain')
  if (!ok) {
    throw new Error(
      `LICENCE ASSERTION FAILED for ${info.title}: license="${info.license}" short="${info.licenseShort}"`,
    )
  }
}

/* -------------------------------------------------------------- download */

async function download(info) {
  await mkdir(CACHE, { recursive: true })
  const dest = path.join(CACHE, path.basename(info.url))
  let buf
  if (existsSync(dest)) {
    buf = await readFile(dest)
  } else {
    const res = await fetch(info.url, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`download failed ${res.status} for ${info.url}`)
    buf = Buffer.from(await res.arrayBuffer())
    await writeFile(dest, buf)
  }
  const sha1 = createHash('sha1').update(buf).digest('hex')
  // MediaWiki reports sha1 as 40-char hex on current installs, base36 on older ones.
  const reported = String(info.sha1Base36).trim()
  const expected = /^[0-9a-f]{40}$/i.test(reported) ? reported.toLowerCase() : base36ToHex(reported)
  if (sha1 !== expected) {
    throw new Error(`SHA-1 mismatch for ${info.title}\n  expected ${expected}\n  got      ${sha1}`)
  }
  return buf
}

/* ----------------------------------------------------------- exif report */

async function readExif(buf) {
  const p = await exifr.parse(buf, {
    tiff: true,
    ifd0: true,
    exif: true,
    gps: true,
    iptc: true,
    interop: false,
    xmp: false,
    reviveValues: true,
    translateValues: true,
  })
  const gps =
    Number.isFinite(p?.latitude) && Number.isFinite(p?.longitude)
      ? { lat: +p.latitude.toFixed(6), lon: +p.longitude.toFixed(6), alt: p.GPSAltitude ?? null }
      : null
  return {
    raw: p,
    make: p?.Make ?? null,
    model: p?.Model ?? null,
    lens: p?.LensModel ?? p?.Lens ?? null,
    iso: p?.ISO ?? null,
    fnumber: p?.FNumber ?? null,
    exposure: p?.ExposureTime ?? null,
    focal: p?.FocalLength ?? null,
    dateTime: p?.DateTimeOriginal ? new Date(p.DateTimeOriginal).toISOString() : null,
    colorSpace: p?.ColorSpace ?? null,
    software: p?.Software ?? null,
    gps,
  }
}

/* ------------------------------------------------------------ downscale */

async function downscale(raw, longEdge, quality) {
  const meta = await sharp(raw, { failOn: 'none' }).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  const longest = Math.max(w, h)
  if (longest <= longEdge) return { buf: raw, note: 'original size kept', from: { w, h } }

  const buf = await sharp(raw, { failOn: 'none' })
    .rotate()
    .resize({
      width: w >= h ? longEdge : undefined,
      height: h > w ? longEdge : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .withMetadata() // keeps EXIF (incl. GPS), IPTC and ICC
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer()

  return { buf, note: `downscaled to long edge ${longEdge} @ q${quality}`, from: { w, h } }
}

/* -------------------------------------------------- flat region search */

function rectsOverlap(a, b, margin = 0) {
  return (
    a.left < b.left + b.width + margin &&
    a.left + a.width + margin > b.left &&
    a.top < b.top + b.height + margin &&
    a.top + a.height + margin > b.top
  )
}

async function findFlatRegion(jpegBuf, plateW, plateH, avoid = []) {
  const SMALL_W = 200
  const { data, info } = await sharp(jpegBuf)
    .removeAlpha()
    .toColourspace('b-w')
    .resize({ width: SMALL_W })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const sw = info.width
  const sh = info.height
  const full = await sharp(jpegBuf).metadata()
  const scale = (full.width ?? sw) / sw

  const rw = Math.max(3, Math.round(plateW / scale))
  const rh = Math.max(2, Math.round(plateH / scale))
  const x0 = Math.round(sw * 0.04)
  const x1 = sw - rw - Math.round(sw * 0.04)
  const y0 = Math.round(sh * 0.34)
  const y1 = sh - rh - Math.round(sh * 0.06)

  let best = { variance: Infinity, x: x0, y: y0 }
  for (let y = y0; y <= Math.max(y0, y1); y += 2) {
    for (let x = x0; x <= Math.max(x0, x1); x += 2) {
      const candidate = { left: x * scale, top: y * scale, width: plateW, height: plateH }
      if (avoid.some((rect) => rectsOverlap(candidate, rect, 32))) continue
      let sum = 0
      let sumSq = 0
      let n = 0
      for (let j = 0; j < rh; j++) {
        const row = (y + j) * sw
        for (let i = 0; i < rw; i++) {
          const v = data[row + x + i]
          sum += v
          sumSq += v * v
          n++
        }
      }
      const mean = sum / n
      const variance = sumSq / n - mean * mean
      if (variance < best.variance) best = { variance, x, y }
    }
  }

  return {
    left: Math.round(best.x * scale),
    top: Math.round(best.y * scale),
    width: plateW,
    height: plateH,
    varianceSmall: +best.variance.toFixed(1),
  }
}

/* ------------------------------------------------------------ the plate */

/**
 * A flat vector plate compresses almost losslessly, so it averages back down to
 * the image median and the ELA lens sees nothing. The forgery therefore pastes a
 * genuinely photographic crop (pristine, single generation) and overlays hard
 * vector furniture: dense detail across the whole region is what actually rings
 * when the file is re-encoded at 0.75.
 */
function plateOverlaySvg(w, h) {
  const bars = []
  const pattern = [0.42, 0.78, 0.55, 0.92, 0.62, 0.84, 0.48, 0.72, 0.58]
  const barW = Math.max(2, Math.round(w * 0.012))
  pattern.forEach((frac, i) => {
    const x = Math.round(w * 0.07 + i * (w * 0.1))
    const bh = Math.round(h * 0.5 * frac)
    bars.push(`<rect x="${x}" y="${h - bh - 6}" width="${barW}" height="${bh}" fill="#F3F2EE"/>`)
  })
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="#F3F2EE" stroke-width="2"/>
      <rect x="1" y="1" width="${w - 2}" height="${Math.round(h * 0.15)}" fill="#0B0C0E"/>
      <rect x="${Math.round(w * 0.06)}" y="${Math.round(h * 0.05)}" width="${Math.round(w * 0.22)}" height="${Math.max(3, Math.round(h * 0.055))}" fill="#FF4F00"/>
      <rect x="${Math.round(w * 0.33)}" y="${Math.round(h * 0.05)}" width="${Math.round(w * 0.14)}" height="${Math.max(3, Math.round(h * 0.055))}" fill="#FFB000"/>
      ${bars.join('')}
    </svg>`,
  )
}

/* ------------------------------------------------------------- ELA maths */

async function measureEla(jpegBuf, box) {
  const src = await sharp(jpegBuf)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })

  const recompressed = await sharp(jpegBuf).jpeg({ quality: 75, mozjpeg: false }).toBuffer()
  const cmp = await sharp(recompressed)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width: w, height: h, channels: c } = src.info
  const a = src.data
  const b = cmp.data
  const n = w * h
  const delta = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const o = i * c
    delta[i] = (Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2])) / 3
  }

  let sum = 0
  let count = 0
  const bx1 = Math.min(w, box.left + box.width)
  const by1 = Math.min(h, box.top + box.height)
  for (let y = box.top; y < by1; y++) {
    for (let x = box.left; x < bx1; x++) {
      sum += delta[y * w + x]
      count++
    }
  }

  const sorted = Float32Array.from(delta).sort()
  const median = sorted[Math.floor(n * 0.5)]
  const p95 = sorted[Math.floor(n * 0.95)]
  const p99 = sorted[Math.floor(n * 0.99)]
  const boxMean = count ? sum / count : 0

  return {
    boxMean: +boxMean.toFixed(2),
    median: +median.toFixed(2),
    p95: +p95.toFixed(2),
    p99: +p99.toFixed(2),
    // A perfectly flat facade can re-encode with a median delta of zero; floor the
    // denominator so the ratio stays a meaningful strength, not a division artefact.
    ratio: +(boxMean / Math.max(median, 0.35)).toFixed(2),
  }
}

/* ---------------------------------------------------------------- forged */

async function buildForensic(raw, src, plateSourcePath) {
  // One clean pass first (the "original file"), then per-candidate base saves.
  const clean = await sharp(raw, { failOn: 'none' })
    .rotate()
    .resize({ width: src.longEdge, height: src.longEdge, fit: 'inside', withoutEnlargement: true })
    .withMetadata()
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer()

  const meta = await sharp(clean).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0

  const plateW = Math.round(W * 0.2)
  const plateH = Math.round(plateW * 0.36)
  const region = await findFlatRegion(clean, plateW, plateH)

  const platePhoto = await sharp(plateSourcePath, { failOn: 'none' })
    .resize(plateW, plateH, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 96, mozjpeg: true })
    .toBuffer()
  const overlay = plateOverlaySvg(plateW, plateH)

  // Second fabrication: a block of window masonry cloned onto a blank wall.
  // It reads as an obvious copy-paste to the eye and as a hard seam to ELA.
  const cloneW = Math.round(W * 0.17)
  const cloneH = Math.round(cloneW * 0.62)
  const cloneDest = await findFlatRegion(clean, cloneW, cloneH, [region])
  const cloneSrcRect = {
    left: Math.round(W * 0.055),
    top: Math.round(H * 0.1),
    width: cloneW,
    height: cloneH,
  }
  const clonePhoto = await sharp(clean)
    .extract(cloneSrcRect)
    .resize(cloneW, cloneH, { fit: 'cover' })
    .modulate({ brightness: 1.03, saturation: 0.92 })
    .jpeg({ quality: 96, mozjpeg: true })
    .toBuffer()
  const cloneEdge = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cloneW}" height="${cloneH}" viewBox="0 0 ${cloneW} ${cloneH}">
      <rect x="1" y="1" width="${cloneW - 2}" height="${cloneH - 2}" fill="none" stroke="#F3F2EE" stroke-width="2"/>
      <rect x="1" y="1" width="${cloneW - 2}" height="6" fill="#0B0C0E" fill-opacity="0.72"/>
    </svg>`,
  )

  const attempts = []
  let best = null

  for (const baseQuality of [70, 58, 48]) {
    const baseBuf = await sharp(clean)
      .withMetadata()
      .jpeg({ quality: baseQuality, mozjpeg: true })
      .toBuffer()

    for (const finalQuality of [88, 80, 72]) {
      const out = await sharp(baseBuf)
        .composite([
          { input: clonePhoto, left: cloneDest.left, top: cloneDest.top },
          { input: cloneEdge, left: cloneDest.left, top: cloneDest.top },
          { input: platePhoto, left: region.left, top: region.top },
          { input: overlay, left: region.left, top: region.top },
        ])
        .withMetadata()
        .jpeg({ quality: finalQuality, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .toBuffer()

      const ela = await measureEla(out, region)
      const elaClone = await measureEla(out, cloneDest)
      attempts.push({ baseQuality, finalQuality, plateRatio: ela.ratio, cloneRatio: elaClone.ratio })
      console.log(
        `      base q${baseQuality} → final q${finalQuality}: plate ${ela.ratio}× · clone ${elaClone.ratio}× (median ${ela.median})`,
      )

      const score = Math.min(ela.ratio, elaClone.ratio)
      if (!best || score > best.score) {
        best = { buf: out, baseQuality, finalQuality, ela, elaClone, score }
      }
    }
  }

  if (!best || best.score < MIN_ELA_RATIO) {
    throw new Error(
      `ELA assertion failed: weakest splice ${best ? best.score : 0}× < ${MIN_ELA_RATIO}× (plate ${best?.ela.ratio}×, clone ${best?.elaClone.ratio}×)`,
    )
  }
  const primary = best.ela.ratio >= best.elaClone.ratio ? best.ela : best.elaClone
  return {
    ...best,
    ela: primary,
    box: best.ela.ratio >= best.elaClone.ratio ? region : cloneDest,
    boxes: [
      { ...region, label: 'PASTED PLATE', elaRatio: best.ela.ratio },
      { ...cloneDest, label: 'CLONED MASONRY', elaRatio: best.elaClone.ratio },
    ],
    plate: { width: plateW, height: plateH },
    attempts,
    workingDims: { w: W, h: H },
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  await mkdir(OUT, { recursive: true })
  console.log('\nLOUPE · specimen preparation\n' + '─'.repeat(78))

  const credits = {
    generatedAt: new Date().toISOString(),
    note: 'CC0 photographs from Wikimedia Commons. Files are served locally from /public/specimens; nothing is fetched at runtime.',
    minElaRatio: MIN_ELA_RATIO,
    specimens: [],
  }

  for (const src of SOURCES) {
    console.log(`\n· ${src.slot}  ←  ${src.title}`)
    const info = await commonsInfo(src.title)
    assertCc0(info)
    console.log(
      `  licence: ${info.license || info.licenseShort} · ${info.usageTerms} · attribution required: ${info.attributionRequired || 'no'}`,
    )
    console.log(`  page:    ${info.page}`)
    console.log(`  original: ${info.width}×${info.height}  ${fmtBytes(info.bytes)}  sha1 ${info.sha1Base36}`)

    const raw = await download(info)
    console.log(`  sha1 verified against Commons API ✓`)

    let entry
    if (src.splice) {
      const forensic = await buildForensic(raw, src, path.join(OUT, '01-camera-exif.jpg'))
      const outDims = forensic.workingDims
      const finalMeta = await readExif(forensic.buf)
      await writeFile(path.join(OUT, src.slot), forensic.buf)
      entry = {
        slot: src.slot,
        role: src.role,
        source: {
          title: info.title,
          page: info.page,
          license: info.license || info.licenseShort,
          licenseUrl: info.licenseUrl,
          usageTerms: info.usageTerms,
          artist: info.artist,
          originalSha1: info.sha1Base36,
        },
        original: { width: info.width, height: info.height, bytes: info.bytes },
        output: {
          width: outDims.w,
          height: outDims.h,
          bytes: forensic.buf.length,
        },
        exif: exifSummary(finalMeta),
        prep: [
          `downscaled to long edge ${src.longEdge}`,
          `base re-saved at q${forensic.baseQuality} (compression history)`,
          `photographic crop ${forensic.plate.width}×${forensic.plate.height} pasted at ${forensic.box.left},${forensic.box.top} + vector overlay`,
          `cloned masonry block pasted at ${forensic.boxes[1].left},${forensic.boxes[1].top}`,
          `whole file re-saved at q${forensic.finalQuality}`,
        ],
        forensic: {
          spliceBox: forensic.box,
          spliceBoxes: forensic.boxes,
          ela: forensic.ela,
          elaClone: forensic.elaClone,
          candidates: forensic.attempts,
        },
      }
      for (const box of forensic.boxes) {
        console.log(`  splice: ${box.label} at ${box.left},${box.top} ${box.width}×${box.height} → ${box.elaRatio}×`)
      }
      console.log(
        `  ELA median ${forensic.ela.median} · plate Δ ${forensic.ela.boxMean} · clone Δ ${forensic.elaClone.boxMean}`,
      )
    } else {
      const out = await downscale(raw, src.longEdge, src.quality)
      let exif = await readExif(out.buf)
      let usedFallback = false

      if (src.requireGps && !exif.gps) {
        console.log('  ! GPS lost in downscale — keeping original bytes instead')
        usedFallback = true
        const original = await readExif(raw)
        exif = original
        await writeFile(path.join(OUT, src.slot), raw)
        entry = {
          slot: src.slot,
          role: src.role,
          source: {
            title: info.title,
            page: info.page,
            license: info.license || info.licenseShort,
            licenseUrl: info.licenseUrl,
            usageTerms: info.usageTerms,
            artist: info.artist,
            originalSha1: info.sha1Base36,
          },
          original: { width: info.width, height: info.height, bytes: info.bytes },
          output: { width: info.width, height: info.height, bytes: raw.length },
          exif: exifSummary(exif),
          prep: ['original bytes kept so GPS survives'],
        }
      } else {
        await writeFile(path.join(OUT, src.slot), out.buf)
        const outMeta = await sharp(out.buf).metadata()
        entry = {
          slot: src.slot,
          role: src.role,
          source: {
            title: info.title,
            page: info.page,
            license: info.license || info.licenseShort,
            licenseUrl: info.licenseUrl,
            usageTerms: info.usageTerms,
            artist: info.artist,
            originalSha1: info.sha1Base36,
          },
          original: { width: info.width, height: info.height, bytes: info.bytes },
          output: {
            width: outMeta.width ?? 0,
            height: outMeta.height ?? 0,
            bytes: out.buf.length,
          },
          exif: exifSummary(exif),
          prep: [out.note, 'EXIF/IPTC/ICC preserved via sharp withMetadata()'],
        }
        console.log(`  ${out.note} → ${outMeta.width}×${outMeta.height} ${fmtBytes(out.buf.length)}`)
      }
      if (!usedFallback) console.log('  EXIF re-verified after encode ✓')
    }

    credits.specimens.push(entry)
  }

  await writeFile(path.join(OUT, 'credits.json'), JSON.stringify(credits, null, 2) + '\n')

  /* -------------------------------------------------------------- report */
  console.log('\n' + '─'.repeat(78))
  console.log('LICENCE / METADATA REPORT')
  console.log('─'.repeat(78))
  for (const s of credits.specimens) {
    const e = s.exif
    const gps = e.gps ? `${e.gps.lat}, ${e.gps.lon}` : '—'
    console.log(`\n  ${s.slot}`)
    console.log(`    licence     ${s.source.license} · ${s.source.usageTerms}`)
    console.log(`    author      ${s.source.artist}`)
    console.log(`    source      ${s.source.page}`)
    console.log(`    file        ${s.output.width}×${s.output.height}  ${fmtBytes(s.output.bytes)}`)
    console.log(`    camera      ${e.make ?? '—'} ${e.model ?? ''}`.trimEnd())
    console.log(`    lens        ${e.lens ?? '—'}`)
    console.log(
      `    exposure    ISO ${e.iso ?? '—'} · f/${e.fnumber ?? '—'} · ${e.exposure ? e.exposure + 's' : '—'} · ${e.focal ?? '—'}mm`,
    )
    console.log(`    captured    ${e.dateTime ?? '—'}`)
    console.log(`    GPS         ${gps}${e.gps ? '  ← PRIVACY RISK' : ''}`)
    if (s.forensic) {
      console.log(
        `    ELA         splice Δ ${s.forensic.ela.boxMean} vs median ${s.forensic.ela.median} → ${s.forensic.ela.ratio}× (threshold ${MIN_ELA_RATIO}×) ✓`,
      )
    }
  }

  const total = credits.specimens.reduce((n, s) => n + s.output.bytes, 0)
  console.log('\n' + '─'.repeat(78))
  console.log(`bundled payload: ${fmtBytes(total)} across ${credits.specimens.length} specimens`)
  console.log('wrote public/specimens/credits.json\n')
}

function exifSummary(e) {
  return {
    make: e.make,
    model: e.model,
    lens: e.lens,
    iso: e.iso,
    fnumber: e.fnumber,
    exposure: e.exposure,
    focal: e.focal,
    dateTime: e.dateTime,
    colorSpace: e.colorSpace,
    software: e.software,
    gps: e.gps,
  }
}

main().catch((err) => {
  console.error('\n✗ specimen preparation failed\n')
  console.error(err.message ?? err)
  process.exitCode = 1
})
