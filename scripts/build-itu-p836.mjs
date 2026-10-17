// ITU-R P.836-6 年统计数字图打包：官方 ZIP → resources/itu/p836_v2.bin（运行时不联网）。
//
// 数据源（2026-10-17 下载核对）
//   https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.836-6-201712-I!!ZIP-E.zip
//   218 155 416 B，SHA-256 beb4631ee2832db19803d319c0a9d76384f4f4695dd1d04105e469d385a6fc4e
//   （itu.int 走本机 https_proxy 时会挂起，curl 加 --noproxy '*' 直连 4 s 下完；须带浏览器 UA）
//   ZIP 内：TOPO_0DOT5.txt（0.5° 地形，km）+ P_836_Maps_annual.zip →
//     Surface Water Vapor Density/RHO Annual Maps.zip   RHO_{01,02,03,05,1,2,3,5,10,20,30,50,60,70,80,90,95,99}_v4.txt
//     Total Columnar Water Content/V Annual Maps.zip     V_*_v4.txt
//     Total Columnar Water Content/VSCH Annual Maps.zip  VSCH_*_v4.txt（ρ 与 V 共用这一套标高）
//   月统计（P_836_Maps_monthly.zip，197 MB）本轮不打包。
//
// 网格（建议书 Annex 1/2 原文，已对 LAT1dot125/LON1dot125.txt 核对）：161 行 × 321 列，1.125°，
//   行 r → 纬度 90 − 1.125·r（行 0 = 90°N），列 c → 经度 1.125·c（列 0 = 0°E，列 320 = 360°E 与列 0 同经线）。
//   ★ 经度是 0…360 排布：2026-07-25 曾因按 −180 起读把整张图偏了 180°（见 data/waterVaporGrid.js 头注），
//     配准哨兵在 packages/core/test/ituP836.test.mjs。
//   行 1（88.875°N）有 287 格 NaN —— 官方原件如此，保留为缺测（读取侧跳过缺测格）。
//
// 「对应地形高度」：P.836-6 步骤 d) 只在 1.125° 格点上用 TOPO_0DOT5（0.5°，−0.5…360.5°E、90.5…−90.5°N）
//   按 P.1144-13 §2 双三次插值求格点海拔 alt_i，故这里在打包时就把 161×321 个格点的 alt_i 算好存下
//   （运行时与逐点做双三次逐位相同，且不必随包带 0.5° 地形全图）。
//
// 输出格式（小端）：
//   0  'P836'  4 B 魔数          4  u16 版本 = 2        6  u16 概率档数 nP = 18
//   8  u16 行数 161              10 u16 列数 321        12 f32 首行纬度 90      16 f32 首列经度 0
//   20 f32 格距 1.125            24 f32 ρ 比例 1000     28 f32 V 比例 500       32 f32 VSCH 比例 5000
//   36 f32 海拔比例 5000         40 f32×18 概率档（%）  112..127 保留
//   128 起：每个概率档依次 ρ（u16，g/m³×1000）、V（u16，kg/m²×500）、VSCH（u16，km×5000），各 161×321；
//           最后一张格点海拔 alt_i（i16，km×5000）。缺测 = 0xFFFF（u16）/ −32768（i16）。
//   量化：ρ 0.0005 g/m³、V 0.001 kg/m²、VSCH 0.0001 km、海拔 0.1 m（半个最小单位）。
//
// 用法  node scripts/build-itu-p836.mjs <R-REC-P.836-6-201712-I!!ZIP-E.zip> [输出路径]
//   缺省输出 resources/itu/p836_v2.bin；末尾打印输出文件的 SHA-256。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SRC_URL = 'https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.836-6-201712-I!!ZIP-E.zip'
const SRC_SHA256 = 'beb4631ee2832db19803d319c0a9d76384f4f4695dd1d04105e469d385a6fc4e'
const PS = [0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10, 20, 30, 50, 60, 70, 80, 90, 95, 99]
const TAG = { 0.1: '01', 0.2: '02', 0.3: '03', 0.5: '05' }
const ROWS = 161, COLS = 321, STEP = 1.125
const SC = { rho: 1000, v: 500, vsch: 5000, alt: 5000 }
const HDR = 128

const zipPath = process.argv[2]
const outPath = process.argv[3] || path.join(ROOT, 'resources', 'itu', 'p836_v2.bin')
if (!zipPath) { console.error('用法：node scripts/build-itu-p836.mjs <R-REC-P.836-6-201712-I!!ZIP-E.zip> [输出]\n来源：' + SRC_URL); process.exit(2) }

const zipBuf = fs.readFileSync(zipPath)
const sha = crypto.createHash('sha256').update(zipBuf).digest('hex')
if (sha !== SRC_SHA256) { console.error(`源 ZIP SHA-256 不符：${sha}（期望 ${SRC_SHA256}）`); process.exit(1) }

function parseGrid(txt, rows, cols, name) {
  const lines = txt.trim().split(/\r?\n/)
  if (lines.length !== rows) throw new Error(`${name}: 行数 ${lines.length} ≠ ${rows}`)
  const out = new Float64Array(rows * cols)
  lines.forEach((l, r) => {
    const v = l.trim().split(/\s+/)
    if (v.length !== cols) throw new Error(`${name}: 第 ${r} 行列数 ${v.length} ≠ ${cols}`)
    for (let c = 0; c < cols; c++) out[r * cols + c] = Number(v[c])   // 'NaN' → NaN
  })
  return out
}
async function inner(zip, name) {
  const f = zip.file(name)
  if (!f) throw new Error('ZIP 内缺文件：' + name)
  return f
}

const outer = await JSZip.loadAsync(zipBuf)
const topoTxt = await (await inner(outer, 'TOPO_0DOT5.txt')).async('string')
const annual = await JSZip.loadAsync(await (await inner(outer, 'P_836_Maps_annual.zip')).async('nodebuffer'))
const zRho = await JSZip.loadAsync(await (await inner(annual, 'Surface Water Vapor Density/RHO Annual Maps.zip')).async('nodebuffer'))
const zV = await JSZip.loadAsync(await (await inner(annual, 'Total Columnar Water Content/V Annual Maps.zip')).async('nodebuffer'))
const zVs = await JSZip.loadAsync(await (await inner(annual, 'Total Columnar Water Content/VSCH Annual Maps.zip')).async('nodebuffer'))

// 网格坐标核对（行 0 = 90°N、列 0 = 0°E、格距 1.125°）——这一步就是防「整张图偏 180°」的第一道闸
for (const [z, tag] of [[zRho, 'RHO'], [zV, 'V'], [zVs, 'VSCH']]) {
  const lat = parseGrid(await (await inner(z, 'LAT1dot125.txt')).async('string'), ROWS, COLS, tag + ' LAT')
  const lon = parseGrid(await (await inner(z, 'LON1dot125.txt')).async('string'), ROWS, COLS, tag + ' LON')
  for (let r = 0; r < ROWS; r += 40) for (let c = 0; c < COLS; c += 80) {
    if (Math.abs(lat[r * COLS + c] - (90 - STEP * r)) > 1e-6 || Math.abs(lon[r * COLS + c] - STEP * c) > 1e-6) {
      throw new Error(`${tag} 网格坐标与约定不符：r=${r} c=${c} lat=${lat[r * COLS + c]} lon=${lon[r * COLS + c]}`)
    }
  }
}

// —— TOPO_0DOT5（363×723，行 0 = 90.5°N，列 0 = −0.5°E，0.5°）→ 1.125° 格点海拔，P.1144-13 §2 双三次 ——
const TR = 363, TC = 723
const topo = parseGrid(topoTxt, TR, TC, 'TOPO_0DOT5')
function K(d) { const a = -0.5, x = Math.abs(d); return x <= 1 ? (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1 : (x < 2 ? a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a : 0) }
function bicubicTopo(lat, lon) {
  const r = (90.5 - lat) / 0.5, c = (lon + 0.5) / 0.5
  const R = Math.max(0, Math.min(TR - 4, Math.floor(r) - 1)), C = Math.max(0, Math.min(TC - 4, Math.floor(c) - 1))
  let acc = 0
  for (let i = 0; i < 4; i++) {
    let row = 0
    for (let j = 0; j < 4; j++) row += topo[(R + i) * TC + (C + j)] * K(c - (C + j))
    acc += row * K(r - (R + i))
  }
  return acc
}
const alt = new Float64Array(ROWS * COLS)
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) alt[r * COLS + c] = bicubicTopo(90 - STEP * r, STEP * c)

// —— 打包 ——
const N = ROWS * COLS
const buf = Buffer.alloc(HDR + (PS.length * 3 * N + N) * 2)
buf.write('P836', 0, 'ascii')
buf.writeUInt16LE(2, 4); buf.writeUInt16LE(PS.length, 6); buf.writeUInt16LE(ROWS, 8); buf.writeUInt16LE(COLS, 10)
buf.writeFloatLE(90, 12); buf.writeFloatLE(0, 16); buf.writeFloatLE(STEP, 20)
buf.writeFloatLE(SC.rho, 24); buf.writeFloatLE(SC.v, 28); buf.writeFloatLE(SC.vsch, 32); buf.writeFloatLE(SC.alt, 36)
PS.forEach((p, i) => buf.writeFloatLE(p, 40 + 4 * i))
let off = HDR
const stats = {}
function putU16(arr, scale, name) {
  let maxQ = 0, nan = 0
  for (let i = 0; i < N; i++) {
    const v = arr[i]
    if (!Number.isFinite(v)) { buf.writeUInt16LE(0xFFFF, off); nan++ } else {
      const q = Math.round(v * scale)
      if (q < 0 || q >= 0xFFFF) throw new Error(`${name} 超出 u16 量程：${v}`)
      buf.writeUInt16LE(q, off); maxQ = Math.max(maxQ, Math.abs(q / scale - v))
    }
    off += 2
  }
  stats[name] = { maxQuantErr: maxQ, nan }
}
for (const p of PS) {
  const t = TAG[p] || String(p)
  putU16(parseGrid(await (await inner(zRho, `RHO_${t}_v4.txt`)).async('string'), ROWS, COLS, 'RHO_' + t), SC.rho, 'RHO_' + t)
  putU16(parseGrid(await (await inner(zV, `V_${t}_v4.txt`)).async('string'), ROWS, COLS, 'V_' + t), SC.v, 'V_' + t)
  putU16(parseGrid(await (await inner(zVs, `VSCH_${t}_v4.txt`)).async('string'), ROWS, COLS, 'VSCH_' + t), SC.vsch, 'VSCH_' + t)
}
{
  let maxQ = 0
  for (let i = 0; i < N; i++) {
    const q = Math.round(alt[i] * SC.alt)
    if (q <= -32768 || q > 32767) throw new Error('格点海拔超出 i16 量程：' + alt[i])
    buf.writeInt16LE(q, off); off += 2; maxQ = Math.max(maxQ, Math.abs(q / SC.alt - alt[i]))
  }
  stats.ALT = { maxQuantErr: maxQ, nan: 0 }
}
if (off !== buf.length) throw new Error('长度核对失败')

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, buf)
const worst = Object.entries(stats).reduce((m, [k, s]) => (s.maxQuantErr > m.v ? { k, v: s.maxQuantErr } : m), { k: '', v: 0 })
console.log(`P.836-6 年统计 ${PS.length} 档 × (ρ, V, VSCH) + 格点海拔 → ${outPath}`)
console.log(`  ${buf.length} B，SHA-256 ${crypto.createHash('sha256').update(buf).digest('hex')}`)
console.log(`  源 ZIP SHA-256 ${sha}（已核对）`)
console.log(`  量化误差最大：${worst.k} ${worst.v.toExponential(2)}；缺测格：${stats.RHO_50.nan}（官方原件行 1）`)
