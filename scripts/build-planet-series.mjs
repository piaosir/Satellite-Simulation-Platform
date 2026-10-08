// 行星级数（地图设置 · 宇宙空间 · 行星）：IMCCE 的 VSOP87B 原件 → 截断 → src/viz/planets.data.js（渲染端 src/viz/planets.js 消费）。
//
// 原件：VSOP87B（Bretagnon & Francou 1988，A&A 202, 309），日心球坐标 L / B / R，J2000 动力学黄道与春分点，
//   https://ftp.imcce.fr/pub/ephem/planets/vsop87/VSOP87B.{ear,mer,ven,mar,jup,sat,ura}（共约 4.4 MB，下载到 .planets-src/，不进 git）。
//   每行一项，末三个数是 A（振幅：L / B 为弧度、R 为 AU）、B（相位，弧度）、C（频率，弧度 / 儒略千年）；
//   段头「*T**k」是 τ 的幂次。变量 = Σ_k τ^k Σ_i A_i cos(B_i + C_i τ)。
//   VSOP87 是解析行星理论（拟合 JPL DE200 的常数），IMCCE 公开发布，天文软件普遍内嵌；台账 docs/地图数据来源台账.md #18。
//
// 截断：留 |A| · TAU_MAX^k ≥ EPS 的项（TAU_MAX = 0.15 千年 = 1850–2150 年）。
//   截断误差由本脚本当场量：1850–2150 年每 29 天一个时刻，截断级数与全级数算出的地心方向之差，逐颗取最大值，超过 MAX_ERR_ARCSEC 就报错不落盘。
//   全级数本身对 DE441 的误差（内行星 < 1″、木土 1–2″）见 packages/core/test/planets.test.mjs。
//
// 用法：npm run planets:series        # = node scripts/build-planet-series.mjs；缺原件时自动下载
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, '.planets-src')
const OUT = path.join(ROOT, 'src', 'viz', 'planets.data.js')
const BASE = 'https://ftp.imcce.fr/pub/ephem/planets/vsop87/'
const BODIES = ['ear', 'mer', 'ven', 'mar', 'jup', 'sat', 'ura']
const NAMES = { ear: 'EARTH', mer: 'MERCURY', ven: 'VENUS', mar: 'MARS', jup: 'JUPITER', sat: 'SATURN', ura: 'URANUS' }
const TAU_MAX = 0.15
const EPS = 3e-8
const MAX_ERR_ARCSEC = 0.5

async function ensure(body) {
  fs.mkdirSync(SRC, { recursive: true })
  const f = path.join(SRC, 'VSOP87B.' + body)
  if (fs.existsSync(f) && fs.statSync(f).size > 100000) return f
  process.stdout.write(`  VSOP87B.${body} 下载… `)
  const r = await fetch(BASE + 'VSOP87B.' + body)
  if (!r.ok) throw new Error(`VSOP87B.${body} HTTP ${r.status}`)
  const t = await r.text()
  if (!t.includes('VSOP87 VERSION B2')) throw new Error(`VSOP87B.${body} 内容不对`)
  fs.writeFileSync(f, t)
  console.log((t.length / 1048576).toFixed(2) + ' MB')
  return f
}

/** 原件 → [L, B, R]，每个变量是按幂次排的项数组 [[A, B, C], …] */
function parse(file, body) {
  const vars = [[], [], []]
  let cur = null, want = 0
  for (const line of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.includes('VSOP87 VERSION')) {
      const m = /VERSION B2\s+(\S+)\s+VARIABLE (\d) \(LBR\)\s+\*T\*\*(\d)\s+(\d+) TERMS/.exec(line)
      if (!m || m[1] !== NAMES[body]) throw new Error('段头看不懂：' + line.slice(0, 80))
      const v = +m[2] - 1, k = +m[3]
      if (vars[v].length !== k) throw new Error(`${body} 变量 ${v + 1} 的幂次不连续（应为 ${vars[v].length}，读到 ${k}）`)
      cur = []; vars[v].push(cur); want = +m[4]
      continue
    }
    const tok = line.trim().split(/\s+/)
    const C = Number(tok[tok.length - 1]), B = Number(tok[tok.length - 2]), A = Number(tok[tok.length - 3])
    if (!cur || !Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(C)) throw new Error('项行看不懂：' + line.slice(0, 80))
    cur.push([A, B, C])
    if (cur.length === want) cur = null
  }
  for (const v of vars) if (!v.length) throw new Error(body + ' 缺变量')
  return vars
}

const evalVar = (powers, tau) => {
  let sum = 0, tk = 1
  for (const terms of powers) { let s = 0; for (const [A, B, C] of terms) s += A * Math.cos(B + C * tau); sum += s * tk; tk *= tau }
  return sum
}
const helio = (vars, tau) => {
  const L = evalVar(vars[0], tau), B = evalVar(vars[1], tau), R = evalVar(vars[2], tau)
  return [R * Math.cos(B) * Math.cos(L), R * Math.cos(B) * Math.sin(L), R * Math.sin(B)]
}
const geoDir = (S, body, tau) => {
  const e = helio(S.ear, tau)
  let p = helio(S[body], tau), g = [p[0] - e[0], p[1] - e[1], p[2] - e[2]]
  const lt = Math.hypot(...g) * 0.0057755183 / 365250   // 光行时一次迭代就够（再迭代一次改变不到 1 km）
  p = helio(S[body], tau - lt); g = [p[0] - e[0], p[1] - e[1], p[2] - e[2]]
  const L = Math.hypot(...g)
  return g.map((x) => x / L)
}

async function main() {
  console.log('原件（.planets-src/）：')
  const full = {}, cut = {}
  let kept = 0, total = 0
  for (const b of BODIES) {
    full[b] = parse(await ensure(b), b)
    cut[b] = full[b].map((powers) => powers.map((terms, k) => terms.filter(([A]) => Math.abs(A) * TAU_MAX ** k >= EPS)))
    const n = full[b].flat().reduce((s, t) => s + t.length, 0), m = cut[b].flat().reduce((s, t) => s + t.length, 0)
    total += n; kept += m
    console.log(`  ${b}：${n} 项 → 留 ${m} 项`)
  }
  console.log(`截断 |A|·${TAU_MAX}^k ≥ ${EPS}：共留 ${kept} / ${total} 项`)
  // 截断误差：1850–2150 年每 29 天，地心方向之差（角秒）
  const worst = {}
  for (const b of BODIES) {
    if (b === 'ear') continue
    let mx = 0
    for (let d = -150 * 365.25; d <= 150 * 365.25; d += 29) {
      const tau = d / 365250, u = geoDir(full, b, tau), v = geoDir(cut, b, tau)
      const ang = Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]) * 206264.806
      if (ang > mx) mx = ang
    }
    worst[b] = +mx.toFixed(3)
  }
  console.log('截断带来的地心方向误差（1850–2150 最大，角秒）：' + JSON.stringify(worst))
  if (Object.values(worst).some((x) => x > MAX_ERR_ARCSEC)) throw new Error('截断误差超过 ' + MAX_ERR_ARCSEC + '″')
  // 编码：float64 小端流 —— 逐天体、逐变量：幂次数；逐幂次：项数，再 3 × 项数个数（A, B, C）
  const nums = []
  for (const b of BODIES) {
    for (const powers of cut[b]) {
      nums.push(powers.length)
      for (const terms of powers) { nums.push(terms.length); for (const t of terms) nums.push(t[0], t[1], t[2]) }
    }
  }
  const buf = Buffer.from(new Float64Array(nums).buffer)
  const mod = [
    '// 由 scripts/build-planet-series.mjs 生成，勿手改（node scripts/build-planet-series.mjs 重新生成）。',
    '// VSOP87B（Bretagnon & Francou 1988，A&A 202, 309；IMCCE）：日心球坐标 L / B / R，J2000 动力学黄道与春分点；',
    `// 截断：留 |A| · ${TAU_MAX}^k ≥ ${EPS} 的项（${kept} / ${total}），1850–2150 年截断误差 ≤ ${Math.max(...Object.values(worst)).toFixed(2)}″。`,
    '// PLANET_SERIES：base64 的 float64 小端流 —— 逐天体、逐变量（L, B, R）：幂次数；逐幂次：项数，再 3 × 项数个数（A, B, C）。',
    `export const PLANET_BODIES = ${JSON.stringify(BODIES)}`,
    `export const PLANET_SERIES = '${buf.toString('base64')}'`,
    ''
  ].join('\n')
  fs.writeFileSync(OUT, mod)
  console.log(`→ ${path.relative(ROOT, OUT)}  ${(mod.length / 1024).toFixed(0)} KB`)
}

main().catch((e) => { console.error('失败：' + ((e && e.stack) || e)); process.exit(1) })
