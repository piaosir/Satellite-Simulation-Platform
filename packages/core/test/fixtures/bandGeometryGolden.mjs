// bandGeometry【不带交点细化】那条路的金标准：合成一个 P1/P2 高斯双瓣 set（与 glFieldMesh.test 同构、
// 网格更小），跑 stride 1 / 2、开关填充，输出 sha1（逐位）与规模数。改动 bandGeometry 后跑
// edgeRefine.test.mjs 对拍；只有刻意改口径时才允许重新生成（node packages/core/test/fixtures/bandGeometryGolden.mjs --write）。
import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { antennaBasis, projectGrid, fieldDb, bandGeometry } from '../../../../src/viz/grd/coverage.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GOLDEN_PATH = join(HERE, 'bandGeometry.golden.json')

export function makeGoldenSet(NX = 41, NY = 41, span = 14) {
  const N = NX * NY, P1 = new Float32Array(N), P2 = new Float32Array(N)
  const dx = 2 * span / (NX - 1), dy = 2 * span / (NY - 1)
  for (let r = 0; r < NY; r++) {
    const y = -span + dy * r
    for (let c = 0; c < NX; c++) {
      const x = -span + dx * c, k = r * NX + c
      const g1 = Math.exp(-((x - 1.5) ** 2 + (y - 0.7) ** 2) / 6)
      const g2 = 0.5 * Math.exp(-((x - 7.5) ** 2 + (y - 4.0) ** 2) / 6)
      P1[k] = g1 + g2
      P2[k] = 0.3 * g1
      if (r > 19 && r < 23 && c > 23 && c < 27) P1[k] = 0
    }
  }
  return { XS: -span, YS: -span, XE: span, YE: span, NX, NY, P1, P2 }
}
export function computeBox(db, NX, NY, L0) {
  let r0 = NY, r1 = -1, c0 = NX, c1 = -1
  for (let r = 0; r < NY; r++) { const rb = r * NX; for (let c = 0; c < NX; c++) if (db[rb + c] >= L0) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c } }
  if (r1 < 0) return { r0: 0, r1: -1, c0: 0, c1: -1 }
  return { r0: Math.max(0, r0 - 1), r1: Math.min(NY - 1, r1 + 1), c0: Math.max(0, c0 - 1), c1: Math.min(NX - 1, c1 + 1) }
}

const sha = (arrs) => { const h = createHash('sha1'); for (const a of arrs) h.update(JSON.stringify(Array.from(a))); return h.digest('hex') }

export function goldenNow() {
  const set = makeGoldenSet()
  const basis = antennaBasis(110.5, 110.5, 0, 0, 0, 35786.06)
  const f0 = fieldDb(set, null, { pol: 'P1' })
  const NB = 6, levels = []
  for (let k = NB - 1; k >= 0; k--) levels.push(f0.max - 1 - (23 / NB) * k)
  const box = computeBox(f0.db, set.NX, set.NY, levels[0])
  const proj = projectGrid(set, 4, basis, box, null, true)
  const field = fieldDb(set, proj, { pol: 'P1' })
  const out = {}
  for (const stride of [1, 2]) for (const fills of [true, false]) {
    const geo = bandGeometry({ lon: proj.lon, lat: proj.lat, vis: proj.vis, db: field.db, NX: set.NX, NY: set.NY }, levels, fills, box, null, stride)
    const lineArrs = geo.lines.map((segs) => segs.flat(2))
    const fillArrs = geo.fills.flatMap((f) => [f.verts, f.counts])
    out[`s${stride}_f${fills ? 1 : 0}`] = {
      nSegs: geo.lines.map((s) => s.length), nPolys: geo.fills.map((f) => f.counts.length),
      lines: sha(lineArrs), fills: sha(fillArrs)
    }
  }
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const g = goldenNow()
  if (process.argv.includes('--write')) { writeFileSync(GOLDEN_PATH, JSON.stringify(g, null, 2)); console.log('written', GOLDEN_PATH) }
  else console.log(JSON.stringify(g, null, 2), '\nsame as file:', JSON.stringify(g) === JSON.stringify(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))))
}
