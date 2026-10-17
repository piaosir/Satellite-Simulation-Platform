// ITU-R P.452-18 数据构建（两件产物，来源 URL 与 SHA-256 记在下方 SOURCES，下载或解包结果对不上就中止、不写盘）：
//
// ① 无线电气象数字地图（ΔN、N0）→ packages/core/utils/terrestrial/data/p452_dn50_n050.bin（约 228 KB，随包分发）
//    P.452-18 附件 1 的附录 1 §2：两张图是建议书的组成部分，随补充文件 R-REC-P.452-18-202310-I!!ZIP-E.zip
//    分发（DN50.TXT / N050.TXT / LAT.TXT / LON.TXT，1.5° 网格，纬度 +90→−90、经度 0→360，121 × 241 点，三位小数）。
//    旁证：ITU-R 第 3 研究组 P.452-18 官方 MATLAB 实现（OFCOM，版权放弃声明）private/DigitalMaps_*.m 内嵌同一份表，
//    2026-10-17 逐点核对 29 161 × 2 个值完全相同。
//
// ② 官方验证例集 → packages/core/test/fixtures/p452_18_validation.json.gz（约 110 KB，给 p452.test.mjs 逐例对拍）
//    ITU-R 第 3 研究组「Validation examples for Recommendation ITU-R P.452-18 - Ver 18.0」（OFCOM，版权放弃声明，
//    见 zip 内 README.txt）：17 条剖面 × 35 组（频率 / 时间百分比扫描）= 595 例，含剖面分析中间量与各机制损耗。
//    夹具只做格式转换（CSV → JSON 数值，结果表里每剖面恒定的中间量只存一份），并记下每个 CSV 的 SHA-256。
//
// 用法：
//   node scripts/build-itu-p452.mjs                           生成 ①（curl 下载，带浏览器 User-Agent——itu.int 拒绝裸 UA）
//   node scripts/build-itu-p452.mjs --zip <路径>               生成 ①，用已下载的 ZIP（离线）
//   node scripts/build-itu-p452.mjs --check [--zip <路径>]     只校验现有 ① 与源数据逐字节一致
//   node scripts/build-itu-p452.mjs --validation [--zip <路径>]  生成 ②（--zip 此时指验证例集 zip）
//
// 原始 ZIP 与 TXT/CSV 不进仓库。
//
// ① 的 .bin 格式（小端）：
//   0   8  魔数 'P452RM18'
//   8   2  uint16 版本 = 1
//   10  2  uint16 nLat = 121          12  2  uint16 nLon = 241        14  2  uint16 保留 0
//   16  4  int32 lat0 = 90000（毫度） 20  4  int32 dLat = −1500       24  4  int32 lon0 = 0       28  4  int32 dLon = 1500
//   32  4  int32 scale = 1000（值 × 1000 取整，源数据恰为三位小数，无损）
//   36  4  uint32 保留 0
//   40  …  int32[nLat·nLon] ΔN × 1000（行主序：行 i ↔ 纬度 90 − 1.5i，列 j ↔ 经度 1.5j）
//   …   …  int32[nLat·nLon] N0 × 1000
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unzip } from './lib/shapefile.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const MAP_OUT = path.join(ROOT, 'packages', 'core', 'utils', 'terrestrial', 'data', 'p452_dn50_n050.bin')
const VAL_OUT = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'p452_18_validation.json.gz')

const SOURCES = {
  maps: {
    url: 'https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.452-18-202310-I!!ZIP-E.zip',
    zipSha256: 'b2d25952e85fb60d3c57f0078c201f243767fd285e1371931509437dc92a0208',
    files: {
      'DN50.TXT': '4847bf9542b775850daab6f0fb1bdc933a4d9a28aff65549bcfc45e141cd230d',
      'N050.TXT': 'd27590ce5c7cf7ff7b4457ce31b9bf3591f0b97e367732195de0f1a98bd35f2a',
      'LAT.TXT': '62b555e7fb42f0e1051b80d1447f23710c286f97d9b607b59c65126a8bd0af8a',
      'LON.TXT': 'e23c97490faebab7cac0830d835a98b89fc92a5a14aaa5aca954ea02b85a5e02'
    }
  },
  validation: {
    page: 'https://www.itu.int/en/ITU-R/study-groups/rsg3/Pages/iono-tropo-spheric.aspx',
    url: 'https://www.itu.int/en/ITU-R/study-groups/rsg3/rwp3m/Validation%20Example/Validation%20examples%20for%20Recommendation%20ITU-R%20P.452-18%20-%20Ver%2018.0.zip',
    zipSha256: '8394280779f71d8e15a6360e677af7af6b390af9db3a9fd005ca278a712ddaea',
    version: 'P452 Version 18.0 (16.05.24)'
  }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const N_LAT = 121, N_LON = 241, SCALE = 1000, HEADER = 40

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const die = (msg) => { console.error('✗ ' + msg); process.exit(1) }
const rel = (p) => path.relative(process.cwd(), p)

function download(url) {
  const tmp = path.join(os.tmpdir(), `p452-18-${process.pid}-${Date.now()}.zip`)
  console.log('下载 ' + url)
  const r = spawnSync('curl', ['-sS', '-L', '--fail', '--retry', '3', '-A', UA, '-o', tmp, url], { stdio: 'inherit' })
  if (r.error) die('找不到 curl（Windows 10 起自带 curl.exe）：' + r.error.message)
  if (r.status !== 0) die('curl 失败，退出码 ' + r.status)
  const buf = fs.readFileSync(tmp)
  fs.rmSync(tmp, { force: true })
  return buf
}

function getZip(args, src) {
  const zi = args.indexOf('--zip')
  const buf = zi >= 0 ? fs.readFileSync(args[zi + 1] || die('--zip 后要跟路径')) : download(src.url)
  const h = sha256(buf)
  if (h !== src.zipSha256) die(`ZIP 的 SHA-256 不符：${h}（应为 ${src.zipSha256}）`)
  return unzip(buf)
}

// ---------- ① 地图 ----------

function parseGrid(text, name) {
  const v = text.trim().split(/\s+/).map(Number)
  if (v.length !== N_LAT * N_LON || v.some((x) => !Number.isFinite(x))) die(`${name} 不是 ${N_LAT}×${N_LON} 的数值网格`)
  return v
}

function loadMaps(files) {
  const txt = {}
  for (const [name, want] of Object.entries(SOURCES.maps.files)) {
    const key = Object.keys(files).find((k) => k.toUpperCase() === name)
    if (!key) die('ZIP 里缺 ' + name)
    const h = sha256(files[key])
    if (h !== want) die(`${name} 的 SHA-256 不符：${h}（应为 ${want}）`)
    txt[name] = files[key].toString('latin1')
  }
  const lat = parseGrid(txt['LAT.TXT'], 'LAT.TXT'), lon = parseGrid(txt['LON.TXT'], 'LON.TXT')
  for (let i = 0; i < N_LAT; i++) {
    for (let j = 0; j < N_LON; j++) {
      const k = i * N_LON + j
      if (Math.abs(lat[k] - (90 - 1.5 * i)) > 1e-9 || Math.abs(lon[k] - 1.5 * j) > 1e-9) die(`网格坐标与 1.5° 规则网格不符（行 ${i} 列 ${j}）`)
    }
  }
  return { dn: parseGrid(txt['DN50.TXT'], 'DN50.TXT'), n0: parseGrid(txt['N050.TXT'], 'N050.TXT') }
}

function encodeMaps({ dn, n0 }) {
  const n = N_LAT * N_LON
  const buf = Buffer.alloc(HEADER + 8 * n)
  buf.write('P452RM18', 0, 'latin1')
  buf.writeUInt16LE(1, 8); buf.writeUInt16LE(N_LAT, 10); buf.writeUInt16LE(N_LON, 12); buf.writeUInt16LE(0, 14)
  buf.writeInt32LE(90000, 16); buf.writeInt32LE(-1500, 20); buf.writeInt32LE(0, 24); buf.writeInt32LE(1500, 28)
  buf.writeInt32LE(SCALE, 32); buf.writeUInt32LE(0, 36)
  for (let k = 0; k < n; k++) {
    const a = Math.round(dn[k] * SCALE), b = Math.round(n0[k] * SCALE)
    if (Math.abs(a / SCALE - dn[k]) > 1e-9 || Math.abs(b / SCALE - n0[k]) > 1e-9) die('源数据超出三位小数，×1000 取整会有损')
    buf.writeInt32LE(a, HEADER + 4 * k)
    buf.writeInt32LE(b, HEADER + 4 * (n + k))
  }
  return buf
}

// ---------- ② 验证例集 ----------

const INPUT_COLS = ['f', 'p', 'htg', 'hrg', 'phit_e', 'phit_n', 'phir_e', 'phir_n', 'Gt', 'Gr', 'pol', 'dct', 'dcr', 'press', 'temp']
const MID_COLS = ['ae', 'dtot', 'hts', 'hrs', 'theta_t', 'theta_r', 'theta', 'hm', 'hte', 'hre', 'hstd', 'hsrd', 'dlt', 'dlr', 'path',
  'dtm', 'dlm', 'b0', 'omega', 'DN', 'N0']
const LOSS_COLS = ['Lb', 'Lbfsg', 'Lb0p', 'Lb0b', 'Ldsph', 'Ld50', 'Ldp', 'Lbs', 'Lba']

function csvRows(buf) {
  return buf.toString('utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(',').map((s) => s.trim()))
}

function buildValidation(files) {
  const names = Object.keys(files)
  const profiles = names.filter((k) => /\/profiles\/test_profile_.*\.csv$/.test(k)).sort()
  if (profiles.length !== 17) die(`验证例集应有 17 条剖面，实得 ${profiles.length}`)
  const out = []
  for (const pk of profiles) {
    const base = pk.slice(pk.lastIndexOf('/') + 1)
    const rk = names.find((k) => k.endsWith('/results/test_result' + base.slice('test_profile'.length)))
    if (!rk) die('缺结果文件：' + base)
    const prow = csvRows(files[pk]).slice(1)
    const prof = { d: [], h: [], R: [], zone: [] }
    for (const c of prow) {
      const z = Number(c[4])
      if (c.length < 5 || ![1, 2, 3].includes(z)) die(`${base} 剖面行格式不符：${c.join(',')}`)
      prof.d.push(Number(c[0])); prof.h.push(Number(c[1])); prof.R.push(Number(c[2])); prof.zone.push(z)
    }
    const rr = csvRows(files[rk])
    const hdr = rr[0].map((s) => s.split(' ')[0])
    const col = (name) => { const i = hdr.indexOf(name); if (i < 0) die(`${rk} 缺列 ${name}`); return i }
    const rows = rr.slice(1)
    const inputs = {}
    for (const k of INPUT_COLS.slice(2)) inputs[k] = Number(rows[0][col(k)])
    const mid = {}
    for (const k of MID_COLS) mid[k] = k === 'path' ? rows[0][col(k)] : Number(rows[0][col(k)])
    for (const r of rows) {
      for (const k of INPUT_COLS.slice(2)) if (Number(r[col(k)]) !== inputs[k]) die(`${base}：输入列 ${k} 在各行不一致`)
      for (const k of MID_COLS) if (r[col(k)] !== rows[0][col(k)]) die(`${base}：中间量 ${k} 在各行不一致`)
    }
    out.push({
      profile: base, profileSha256: sha256(files[pk]), resultSha256: sha256(files[rk]),
      d: prof.d, h: prof.h, R: prof.R, zone: prof.zone,
      inputs, mid,
      cols: ['f', 'p'].concat(LOSS_COLS),
      rows: rows.map((r) => [Number(r[col('f')]), Number(r[col('p')])].concat(LOSS_COLS.map((k) => Number(r[col(k)]))))
    })
  }
  return { source: SOURCES.validation, note: 'CSV → JSON 格式转换，数值未改动；mid 为结果表中每剖面恒定的中间量', profiles: out }
}

// ---------- 主流程 ----------

const args = process.argv.slice(2)
if (args.includes('--validation')) {
  const fx = buildValidation(getZip(args, SOURCES.validation))
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(fx)), { level: 9 })
  fs.mkdirSync(path.dirname(VAL_OUT), { recursive: true })
  fs.writeFileSync(VAL_OUT, gz)
  const nRows = fx.profiles.reduce((s, p) => s + p.rows.length, 0)
  console.log(`✓ 写出 ${rel(VAL_OUT)}：${fx.profiles.length} 条剖面、${nRows} 例，${gz.length} 字节`)
} else {
  const bin = encodeMaps(loadMaps(getZip(args, SOURCES.maps)))
  if (args.includes('--check')) {
    if (!fs.existsSync(MAP_OUT)) die('还没有 ' + MAP_OUT)
    const cur = fs.readFileSync(MAP_OUT)
    if (!cur.equals(bin)) die(`现有 .bin 与源数据重算结果不一致（现有 ${sha256(cur)}，重算 ${sha256(bin)}）`)
    console.log(`✓ ${rel(MAP_OUT)} 与源数据逐字节一致（SHA-256 ${sha256(bin)}）`)
  } else {
    fs.mkdirSync(path.dirname(MAP_OUT), { recursive: true })
    fs.writeFileSync(MAP_OUT, bin)
    console.log(`✓ 写出 ${rel(MAP_OUT)}：${bin.length} 字节，SHA-256 ${sha256(bin)}`)
  }
}
