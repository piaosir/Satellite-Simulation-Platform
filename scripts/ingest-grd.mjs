// GRD → .fld 入库（离线）。用法: node scripts/ingest-grd.mjs
// SATSOFT 模型：卫星 → 天线（一条命名覆盖，如 "EIRP 中国" / "G/T 中国"）。每个 GRD 文件 = 一个天线。
// 天线内部的 N 个 set = Beams To Plot 的 Beam 1..N（当前显示 set0；逐波束绘制为后续）。
// 输出 resources/coverage-grd/<卫星>/<天线>.fld.json + index.json（卫星→天线[]）。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseGrd } from '../src/viz/grd/parse.js'
import { antennaBasis, projectGrid, fieldDb } from '../src/viz/grd/coverage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC = 'C:/Users/Lenovo/Desktop/GRD/GRD'
const OUT = path.join(ROOT, 'resources', 'coverage-grd')

// 天线清单（先 CS10R）。name=SATSOFT 式天线名；type 决定默认量纲标注。
const ANT = [
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'EIRP 中国', type: 'EIRP', band: 'Ku', file: 'CS10R/300grd(公开)-China/300_X01G_EIRP.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'G/T 中国', type: 'GT', band: 'Ku', file: 'CS10R/300grd(公开)-China/300_X03G_GT.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'EIRP 东部', type: 'EIRP', band: 'Ku', file: 'CS10R/400grd(公开)-East/400_X01G_EIRP.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'G/T 东部', type: 'GT', band: 'Ku', file: 'CS10R/400grd(公开)-East/400_X02G_GT.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'EIRP 西部', type: 'EIRP', band: 'Ku', file: 'CS10R/100grd(公开)-West/100_X01G_EIRP.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'G/T 西部', type: 'GT', band: 'Ku', file: 'CS10R/100grd(公开)-West/100_X02G_GT.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'EIRP 印尼', type: 'EIRP', band: 'Ku', file: 'CS10R/200grd(公开)-Indonesia/200_X01G_EIRP.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'G/T 印尼', type: 'GT', band: 'Ku', file: 'CS10R/200grd(公开)-Indonesia/200_X03G_GT.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'EIRP 东南亚', type: 'EIRP', band: 'Ku', file: 'CS10R/500grd(公开)-Southsea/500_X01G_EIRP.grd' },
  { folder: '中星10R', satName: 'CHINASAT 10R', lon: 110.5, name: 'G/T 东南亚', type: 'GT', band: 'Ku', file: 'CS10R/500grd(公开)-Southsea/500_X02G_GT.grd' }
]

const r6 = (a) => Array.from(a, (v) => (v === v ? +v.toFixed(6) : null))
const r4 = (a) => Array.from(a, (v) => (v === v ? +v.toFixed(4) : null))
const sat = {}

for (const a of ANT) {
  const abs = path.join(SRC, a.file)
  if (!fs.existsSync(abs)) { console.warn('SKIP 缺文件', a.file); continue }
  const g = parseGrd(fs.readFileSync(abs, 'latin1'))
  const set = g.sets[0]
  const basis = antennaBasis(a.lon)
  const proj = projectGrid(set, g.igrid, basis)
  const field = fieldDb(set, proj, { pol: 'RSS' })   // 与界面默认极化一致（总功率）
  const peak = [+proj.lon[field.maxIdx].toFixed(4), +proj.lat[field.maxIdx].toFixed(4)]
  const meta = {
    sat: a.satName, folder: a.folder, name: a.name, type: a.type, band: a.band, satLon: a.lon,
    igrid: g.igrid, icomp: g.icomp, ncomp: g.ncomp, beams: g.nset,
    grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY },
    antenna: { satLon: a.lon, boreLon: a.lon, boreLat: 0, yaw: 0 },
    peakDb: +field.max.toFixed(3), peak
  }
  const fld = { meta, P1: r6(set.P1), P2: r6(set.P2), lon: r4(proj.lon), lat: r4(proj.lat), slant: r4(proj.slant) }
  const dir = path.join(OUT, a.folder); fs.mkdirSync(dir, { recursive: true })
  const fname = `${a.name.replace(/[\\/]/g, '_')}.fld.json`
  fs.writeFileSync(path.join(dir, fname), JSON.stringify(fld))
  const s = (sat[a.folder] ||= { folder: a.folder, satName: a.satName, lon: a.lon, antennas: [] })
  s.antennas.push({ name: a.name, type: a.type, band: a.band, beams: g.nset, peakDb: meta.peakDb, peak, file: `${a.folder}/${fname}` })
  console.log(`OK ${a.folder} · ${a.name}  igrid=${g.igrid} ${set.NX}x${set.NY} ×${g.nset}beam  peak ${meta.peakDb}dB @ ${peak}`)
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ satellites: Object.values(sat) }, null, 1))
console.log('index.json:', Object.values(sat).length, '颗卫星')
