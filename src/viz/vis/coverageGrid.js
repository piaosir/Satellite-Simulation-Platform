// STK Coverage 覆盖分析 —— 纯几何计算核（无 Vue / DOM 依赖，可离线单测），与 visibility.js 同源同风格。
// 复刻 STK Coverage：在一片区域上撒【网格 Grid】→ 对每个网格胞元跑「资产集(卫星集)在时窗内的可见性」→
// 汇成【覆盖性能指标 Figure of Merit】→ 供渲染层上色成热力图。判据 = 星下点覆盖冠（球冠，仰角门限折成地心半角 λ）。
//
// 性能关键 = 时间主序遍历：传播只依赖 (星, 时刻)、不依赖胞元 → 每个时刻把整星集传播一次、只散射到冠内胞元。
// 远省于「逐胞元重跑 accessWindows（会把每颗星按胞元数重复传播）」。相邻两拍之间按区间精确求进出时刻（见 createCoverageRun）。
// 双历元：真实星按 now、合成星按 ccNow 解算（与 visibility.js 的 _cc 约定一致）。
//
// 分批可续算：createCoverageRun 返回 { T, stepBatch(k), finalize() }，由 useVisibility 按「时间批」分帧调用，
// 避免长扫描冻结 UI（accessWindows 分帧同款思路，只是这里状态在累加器里跨批延续）。
import sat from '../constellation/satellite.js'
import { posAt } from '../constellation/satPos.js'   // 取位的唯一入口
import { orbitCanReach } from './visibility.js'
import { schemeColorsRGB } from '../grd/colormap.js'
// 球面多边形（建链模块同一份：边按经纬度线性、跨日界线逐边取短路展开）；区间精确覆盖用的三次 Hermite 与可检出下限（唯一访问引擎）
import { pgRing, pgContains } from '../../../packages/core/models/mapLinkPoints.mjs'
import { temeToEcef, hermitePositive, coverMinDetectSec } from '../../../packages/core/utils/access/accessCore.mjs'

const DEG = Math.PI / 180
const RE = 6378.137   // 地球赤道半径（km），球面覆盖冠半角用
const WGS_A = 6378.137, WGS_E2 = (() => { const f = (6378.137 - 6356.7523142) / 6378.137; return 2 * f - f * f })()   // 与 satellite.js eciToGeodetic 同参

// ==================== 覆盖性能指标（FOM）元数据 ====================
// key 与 createCoverageRun 输出的 fom.<key> 对应；unit 供图例/读数；
// zeroTransparent：值≤0（含未覆盖）画透明（percent/simple/count/total/nasset —— 未覆盖=空）；
//   revisit/avggap 例外——未覆盖=「最差间隔=整个时窗」，应上色（最热档）而非透明。
export const COVERAGE_FOMS = [
  { key: 'percent', label: '覆盖时间百分比', unit: '%', zeroTransparent: true, fixedDomain: [0, 100] },
  { key: 'simple', label: '是否被覆盖', unit: '', zeroTransparent: true, binary: true, fixedDomain: [0, 1] },
  { key: 'nasset', label: '最大同时覆盖重数', unit: '重', zeroTransparent: true, integer: true },
  { key: 'count', label: '累计访问次数', unit: '次', zeroTransparent: true, integer: true },
  { key: 'revisit', label: '最大重访间隔', unit: 'min', zeroTransparent: false, time: true },
  { key: 'total', label: '累计覆盖时长', unit: 'min', zeroTransparent: true, time: true },
  { key: 'avggap', label: '平均覆盖间隔', unit: 'min', zeroTransparent: false, time: true }
]
export const fomMeta = (key) => COVERAGE_FOMS.find((f) => f.key === key) || COVERAGE_FOMS[0]

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const normLon = (lon) => { let x = lon; while (x > 180) x -= 360; while (x < -180) x += 360; return x }
const d180 = (d) => ((d % 360) + 540) % 360 - 180   // 经差折到 [−180, 180)

// ==================== 网格生成 ====================
// region: { kind:'global'|'bounds'|'poly', latMin,latMax,lonMin,lonMax, poly:[[lon,lat]...] }
//   bounds：lonMin > lonMax 视为跨日界线（170 → −170 = 以 180° 为中、宽 20° 的一块），不是另一侧 340° 宽的补集。
//   poly：与 2D / 3D 画法、建链模块同一口径 —— 边按【经纬度线性】画（pgRing 逐边取短路展开经度），区内判定 pgContains；
//         跨 ±180° 照常成立，不换大圆。顶点无效（不足 3 个）→ 0 格。
// stepDeg: 胞元步长（度）。返回 { cells:[{lat,lon}], step, latMin,latMax,lonMin,lonMax }
//   cells = 胞元【中心】（经度归一到 [−180, 180]）；四角由渲染层按 lat±step/2、lon±step/2 取（纬度夹到 ±90）。
//   lonMin/lonMax = 生成用的经度起止（跨日界线的 bounds 原样；poly 为展开后的连续经度，可超出 ±180）。
export function makeCoverageGrid(region, stepDeg) {
  const step = clamp(Number(stepDeg) || 5, 0.25, 30)
  const r = region || {}
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, span = 360
  let ring = null
  if (r.kind === 'bounds') {
    latMin = clamp(Number(r.latMin), -90, 90); latMax = clamp(Number(r.latMax), -90, 90)
    lonMin = Number.isFinite(r.lonMin) ? r.lonMin : -180; lonMax = Number.isFinite(r.lonMax) ? r.lonMax : 180
    span = lonMax - lonMin
    if (span < 0) span += 360   // 跨日界线：从 lonMin 往东走到 lonMax
  } else if (r.kind === 'poly' && Array.isArray(r.poly) && r.poly.length >= 3) {
    ring = pgRing(r.poly)
    if (ring.length < 3) return { cells: [], step, latMin, latMax, lonMin, lonMax }
    latMin = 90; latMax = -90; lonMin = Infinity; lonMax = -Infinity
    for (const p of ring) {
      if (p.lat < latMin) latMin = p.lat; if (p.lat > latMax) latMax = p.lat
      if (p.lon < lonMin) lonMin = p.lon; if (p.lon > lonMax) lonMax = p.lon
    }
    span = lonMax - lonMin
  }
  if (!(latMax > latMin)) { const t = latMin; latMin = Math.min(t, latMax); latMax = Math.max(t, latMax) }
  if (latMax === latMin) { latMin -= step; latMax += step }
  const cells = []
  for (let lat = latMin + step / 2; lat < latMax; lat += step) {
    const la = clamp(lat, -89.999, 89.999)
    for (let d = step / 2; d < span; d += step) {
      const rawLon = lonMin + d
      if (ring && !pgContains(ring, la, rawLon)) continue
      cells.push({ lat: la, lon: normLon(rawLon) })
    }
  }
  return { cells, step, latMin, latMax, lonMin, lonMax }
}

// 计算量估算（用于「太大就请缩小」的守卫）。散射法主开销 = 传播(星×采样，SGP4 约为一次累加扫描的 ~10×) +
// 累加扫描(胞元×采样)；不再是「胞元×星×采样」的积（旧法高估几个数量级）。
export function estimateCoverageWork(cellCount, satCount, horizonSec, sampleSec) {
  const T = Math.max(1, Math.floor((horizonSec || 0) / (sampleSec || 60)) + 1)
  return T * ((satCount || 0) * 10 + (cellCount || 0))
}

// ==================== 覆盖计算（分批可续算 · 星下点散射 + 区间精确）====================
// entries: [{rec,name,noradId,group,_cc}]（与 visibility.js 同形）· grid: makeCoverageGrid 结果
// times: { now:Date, ccNow:Date } · params: { horizonSec, minElevDeg, sampleSec }
// 返回 { T, activeCount, ti(), stepBatch(k)->已处理采样数, finalize()->{ N, cells, step, T, sampleSec, minElevDeg, satActive, minDetectSec, fom:{...} } }
//
// 判据（不变）：星下点 + 覆盖冠 λ = acos(Re/(Re+h)·cosε) − ε 的球面冠（ε = 仰角门限），胞元在冠内 ⇔ 余量 m = ĉ·ŝ − cos λ ≥ 0。
// 散射核（保留，对标 STK）：不「每胞元 × 每星」逐对做 ecfToLookAngles；每采样把每颗星传播一次，只碰冠（外扩一圈）内的
//   行 / 经度窗（行内经度已排序，二分取窗，不扫整行）。
// 区间精确（2026-10-17，差距分析 B-01）：旧版按采样计数 —— 访问次数 = 采样上升沿数、最大重访 = 最长未覆盖采样串 × 步长，
//   两个采样之间完整掠过的过境整段丢失（北京 1° 格、132 颗、25°、24 h：访问次数 119 vs 真值 168，最大重访 4.00 vs 3.18 min）。
//   现在相邻两采样之间，对每颗星逐格看两端余量：
//     · 两端都在冠内且离冠边够远 → 全程覆盖（不求根）；
//     · 状态翻转的格、两端都在冠外但被星下点轨迹扫过的格（漏掉的掠过）、两端在冠内但贴边可能先出后进的格
//       → 余量 m(t) 的三次 Hermite（两端值 + 两端导数；星下点方向的导数由地固系速度解析给出）求精确进出时刻。
//     「够远 / 扫过」的界：|m''| ≤ 1.5ω² + |Δω|/h（ω = 星下点角速率），区间内 m 离两端值不超过 |m''|·h²/8。
//   逐格的覆盖子区间按时间扫线：时间覆盖 = 并集长度 ÷ 时窗；访问次数 = 并集段数；中断（含首尾）= 段间空档；
//   最大同时覆盖重数 = 子区间重叠深度的最大值（只在可能刷新最大值时才解子区间）。
//   两套「x% 时间覆盖」的定义不变：本核给逐格 percent，面积加权在 useVisibility.covKpi。
// 时窗按 horizonSec 原值（不是步长整数倍时末尾补一拍落在时窗终点）。
// 最短可检出过境时长由三次 Hermite 的误差定（accessCore.coverMinDetectSec，随采样步长平方缩小）：finalize 给 minDetectSec。
const GAP_EPS = 1e-3   // 两段覆盖相隔 ≤ 1 ms 视为连续（求根精度量级，不算一次中断 / 新访问）

export function createCoverageRun(entries, grid, times, params) {
  const cells = grid.cells, N = cells.length, M = entries.length
  const minElevDeg = Number(params.minElevDeg) || 0
  const epsRad = minElevDeg * DEG, cosEps = Math.cos(epsRad)
  const sampleSec = Math.max(5, Number(params.sampleSec) || 60)
  const H = Math.max(0, Number(params.horizonSec) || 0)                // 分析时窗（s）
  const nFull = Math.floor(H / sampleSec + 1e-9)
  const T = nFull + 1 + (H - nFull * sampleSec > 1e-6 ? 1 : 0)        // 采样数（含末尾补的那一拍）
  const tOf = (j) => (j <= nFull ? j * sampleSec : H)                  // 第 j 拍的相对时刻（s）
  const nowMs = times.now.getTime()
  const ccMs = (times.ccNow || times.now).getTime()

  // 区域纬度范围 → 星集粗筛（不传播）：只留轨道够得着该纬度带的星，跳过整片够不着的（跨赤道带取最宽松纬度=0）
  let rLatMin = 90, rLatMax = -90
  for (const c of cells) { if (c.lat < rLatMin) rLatMin = c.lat; if (c.lat > rLatMax) rLatMax = c.lat }
  const nearLat = (rLatMin <= 0 && rLatMax >= 0) ? 0 : (Math.abs(rLatMin) <= Math.abs(rLatMax) ? rLatMin : rLatMax)
  const active = []
  for (let s = 0; s < M; s++) if (orbitCanReach(entries[s].rec, nearLat, minElevDeg)) active.push(s)
  const A = active.length

  // 网格按行分桶（同纬度一行），行按纬度升序、行内按经度升序（跨日界线的行生成序不单调）：散射时二分取经度窗
  const rows = []
  for (let i = 0; i < N;) {
    const lat = cells[i].lat
    let j = i; while (j < N && cells[j].lat === lat) j++
    const ord = []
    for (let k = i; k < j; k++) ord.push(k)
    ord.sort((p, q) => cells[p].lon - cells[q].lon)
    const lons = new Float64Array(ord.length), idxs = new Int32Array(ord.length)
    for (let q = 0; q < ord.length; q++) { lons[q] = cells[ord[q]].lon; idxs[q] = ord[q] }
    rows.push({ lat, sinLat: Math.sin(lat * DEG), cosLat: Math.cos(lat * DEG), lons, idxs })
    i = j
  }
  rows.sort((p, q) => p.lat - q.lat)
  const rowLat = new Float64Array(rows.length)
  for (let r = 0; r < rows.length; r++) rowLat[r] = rows[r].lat
  // 胞元单位向量（球面口径，与覆盖冠同一个球）
  const cxA = new Float64Array(N), cyA = new Float64Array(N), czA = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const la = cells[i].lat * DEG, lo = cells[i].lon * DEG, c = Math.cos(la)
    cxA[i] = c * Math.cos(lo); cyA[i] = c * Math.sin(lo); czA[i] = Math.sin(la)
  }

  // 逐星状态（两拍滚动）：ok / ŝ（大地星下点单位向量）/ dŝ/dt（1/s，地固系）/ cos λ（无覆盖冠记 2）/ 星下点经纬（度）及纬度正余弦
  const mkState = () => ({
    ok: new Uint8Array(A), sx: new Float64Array(A), sy: new Float64Array(A), sz: new Float64Array(A),
    dx: new Float64Array(A), dy: new Float64Array(A), dz: new Float64Array(A),
    cl: new Float64Array(A), lat: new Float64Array(A), lon: new Float64Array(A), slat: new Float64Array(A), clat: new Float64Array(A)
  })
  let SA = mkState(), SB = mkState()
  const ecf = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }

  // 逐胞元累加器（时刻一律为相对时窗起点的秒）
  const covT = new Float64Array(N)            // 累计覆盖时长
  const lastEnd = new Float64Array(N).fill(-1) // 上一段覆盖的终点；−1 = 还没覆盖过
  const maxN = new Uint16Array(N)             // 最大同时覆盖重数
  const accCount = new Uint32Array(N)         // 访问次数（覆盖并集的段数）
  const maxGap = new Float64Array(N)          // 最长中断（含首尾）
  const gapSum = new Float64Array(N)          // 各段中断之和（含首尾），/gapCnt = 平均间隔
  const gapCnt = new Uint32Array(N)
  // 一个采样区间内的暂存：全程覆盖的星数、待解的子区间事件（按胞元串链表）、被触及的胞元
  const nBoth = new Uint16Array(N)
  const evHead = new Int32Array(N).fill(-1)
  const tFlag = new Uint8Array(N)
  let touched = new Int32Array(1024), nTouched = 0
  let evCap = 4096, nEv = 0
  let evNext = new Int32Array(evCap), evMa = new Float64Array(evCap), evMb = new Float64Array(evCap), evDa = new Float64Array(evCap), evDb = new Float64Array(evCap)
  let evG = new Float64Array(evCap)   // 该星该区间的 grace：三次式离两端连线的最大偏离（求根前排序用的误差界）
  const tau = new Float64Array(4)
  let ivS = new Float64Array(64), ivE = new Float64Array(64)
  let minDetect = 0

  let ti = 0

  // 一颗星（活跃序号 q）在某拍的状态 → S
  function sampleSat(S, q, rec, cc, tReal, gReal, tCc, gCc) {
    const g = cc ? gCc : gReal
    const pv = posAt(rec, cc ? tCc : tReal)
    if (!pv || !pv.position || !pv.velocity) { S.ok[q] = 0; return }
    const gd = sat.eciToGeodetic(pv.position, g)
    temeToEcef(pv.position, pv.velocity, g, ecf)
    const h = gd.height
    if (!(ecf.vx === ecf.vx) || !(h === h)) { S.ok[q] = 0; return }
    S.ok[q] = 1
    const la = gd.latitude, lo = gd.longitude, cla = Math.cos(la), sla = Math.sin(la)
    const sx = cla * Math.cos(lo), sy = cla * Math.sin(lo), sz = sla
    S.sx[q] = sx; S.sy[q] = sy; S.sz[q] = sz
    S.lat[q] = la / DEG; S.lon[q] = sat.degreesLong(lo); S.slat[q] = sla; S.clat[q] = cla
    // 星下点方向的时间导数：大地法线过卫星 ⇒ ŝ ∝ u = (x, y, k·z)，k = (N + h)/(N(1 − e²) + h) 精确成立；
    // k 只随纬度 / 高度缓变（一个采样区间里相对变化 < 1e-8），故 dŝ/dt = (u̇ − (u̇·ŝ)ŝ)/|u|，u̇ = (vx, vy, k·vz)（地固系速度）
    const Nn = WGS_A / Math.sqrt(1 - WGS_E2 * sla * sla)
    const kk = (Nn + h) / (Nn * (1 - WGS_E2) + h)
    const uz = kk * ecf.z, un = Math.sqrt(ecf.x * ecf.x + ecf.y * ecf.y + uz * uz)
    const vx = ecf.vx, vy = ecf.vy, vz = kk * ecf.vz
    const vs = vx * sx + vy * sy + vz * sz
    S.dx[q] = (vx - vs * sx) / un; S.dy[q] = (vy - vs * sy) / un; S.dz[q] = (vz - vs * sz) / un
    let cl = 2
    if (h > 0) {
      const cosArg = RE / (RE + h) * cosEps
      if (cosArg < 1) { const lam = Math.acos(cosArg) - epsRad; if (lam > 0) cl = Math.cos(lam) }   // 星过低 / 门限过高：无覆盖冠
    }
    S.cl[q] = cl
  }

  function touch(i) {
    if (tFlag[i]) return
    tFlag[i] = 1
    if (nTouched >= touched.length) { const nt = new Int32Array(touched.length * 2); nt.set(touched); touched = nt }
    touched[nTouched++] = i
  }
  function addEvent(i, ma, mb, da, db, gr) {
    if (nEv >= evCap) {
      evCap *= 2
      const g = (a, Ctor) => { const n = new Ctor(evCap); n.set(a); return n }
      evNext = g(evNext, Int32Array); evMa = g(evMa, Float64Array); evMb = g(evMb, Float64Array); evDa = g(evDa, Float64Array); evDb = g(evDb, Float64Array); evG = g(evG, Float64Array)
    }
    const e = nEv++
    evNext[e] = evHead[i]; evHead[i] = e
    evMa[e] = ma; evMb[e] = mb; evDa[e] = da; evDb[e] = db; evG[e] = gr
    touch(i)
  }
  // 行 row 上、以 (sl, cl0) 为星下点纬度正余弦、cos(半径) = cX 的冠的经度半宽（度）：−1 = 够不着这一行；≥ 180 = 整行
  function halfWidth(row, sl, cl0, cX) {
    if (cX <= -1) return 181
    const denom = row.cosLat * cl0
    if (Math.abs(denom) < 1e-12) return 181   // 近极点：整行（保守）
    const ratio = (cX - row.sinLat * sl) / denom
    if (ratio >= 1) return -1
    return ratio <= -1 ? 181 : Math.acos(ratio) / DEG
  }

  // 一颗星在区间 [tA, tA + h] 里碰到的胞元：全程覆盖计数，或记一条子区间事件（三次 Hermite 的四个数）
  function scatterInterval(q, h) {
    if (!SA.ok[q] || !SB.ok[q]) return
    const clA = SA.cl[q], clB = SB.cl[q]
    if (clA > 1 || clB > 1) return
    const ax = SA.dx[q], ay = SA.dy[q], az = SA.dz[q]   // 两端的 dŝ/dt
    const bx = SB.dx[q], by = SB.dy[q], bz = SB.dz[q]
    const wA = Math.sqrt(ax * ax + ay * ay + az * az), wB = Math.sqrt(bx * bx + by * by + bz * bz), w = wA > wB ? wA : wB
    const dcl = (clB - clA) / h
    const grace = (1.5 * w * w + Math.abs(wB - wA) / h) * h * h / 8 + 1e-12
    const md = coverMinDetectSec(w, h, clA < clB ? clA : clB)
    if (md > minDetect) minDetect = md
    // 外扩冠（m ≥ −grace）：cos 半径 = cos λ − grace
    const cXA = clA - grace, cXB = clB - grace
    const lamA = cXA <= -1 ? 180 : Math.acos(cXA) / DEG, lamB = cXB <= -1 ? 180 : Math.acos(cXB) / DEG
    const latA = SA.lat[q], latB = SB.lat[q], lonA = SA.lon[q], lonB = SB.lon[q]
    const latLo = Math.min(latA - lamA, latB - lamB), latHi = Math.max(latA + lamA, latB + lamB)
    const sAx = SA.sx[q], sAy = SA.sy[q], sAz = SA.sz[q], sBx = SB.sx[q], sBy = SB.sy[q], sBz = SB.sz[q]
    // 第一个纬度 ≥ latLo 的行
    let r0 = 0, r1 = rows.length
    while (r0 < r1) { const m = (r0 + r1) >> 1; if (rowLat[m] < latLo) r0 = m + 1; else r1 = m }
    for (let r = r0; r < rows.length; r++) {
      const row = rows[r]
      if (row.lat > latHi) break
      const wa = halfWidth(row, SA.slat[q], SA.clat[q], cXA), wb = halfWidth(row, SB.slat[q], SB.clat[q], cXB)
      if (wa < 0 && wb < 0) continue
      // 经度窗 = 两端冠在这一行的窗的外包（两窗之间若有空隙，那里两端余量都 < −grace，逐格判掉）
      let c0, hw
      if (wa >= 180 || wb >= 180) hw = 360
      else if (wa < 0) { c0 = lonB; hw = wb } else if (wb < 0) { c0 = lonA; hw = wa } else {
        const dl = d180(lonB - lonA), lo = Math.min(-wa, dl - wb), hi = Math.max(wa, dl + wb)
        if (hi - lo >= 360) hw = 360; else { c0 = lonA + (lo + hi) / 2; hw = (hi - lo) / 2 }
      }
      const lons = row.lons, idxs = row.idxs, n = lons.length
      // 窗 → 一段或两段 [a, b]（跨 ±180 拆开），二分取下标
      let a1, b1, a2 = 1, b2 = 0
      if (hw >= 180) { a1 = -Infinity; b1 = Infinity } else {
        let a = c0 - hw, b = c0 + hw
        while (a < -180) { a += 360; b += 360 }
        while (a >= 180) { a -= 360; b -= 360 }
        a1 = a; b1 = b
        if (b > 180) { b1 = 180; a2 = -180; b2 = b - 360 }
      }
      for (let seg = 0; seg < 2; seg++) {
        const a = seg === 0 ? a1 : a2, b = seg === 0 ? b1 : b2
        if (!(b >= a)) continue
        let k0 = 0, k1 = n
        if (a > -Infinity) { while (k0 < k1) { const m = (k0 + k1) >> 1; if (lons[m] < a) k0 = m + 1; else k1 = m } }
        for (let k = k0; k < n; k++) {
          if (lons[k] > b) break
          const i = idxs[k]
          const cx = cxA[i], cy = cyA[i], cz = czA[i]
          const ma = cx * sAx + cy * sAy + cz * sAz - clA
          const mb = cx * sBx + cy * sBy + cz * sBz - clB
          if (ma < -grace && mb < -grace) continue
          if (ma > grace && mb > grace) { if (nBoth[i] < 65535) nBoth[i]++; touch(i); continue }
          const da = h * (cx * ax + cy * ay + cz * az - dcl)
          const db = h * (cx * bx + cy * by + cz * bz - dcl)
          if (ma >= 0 && mb >= 0) {
            // 贴边：可能先出后进；三次式全程 ≥ 0 就按全程覆盖
            const nn = hermitePositive(ma, mb, da, db, tau)
            if (nn === 1 && tau[0] <= 0 && tau[1] >= 1) { if (nBoth[i] < 65535) nBoth[i]++; touch(i) } else addEvent(i, ma, mb, da, db, grace)
          } else if (ma < 0 && mb < 0) {
            if (da > 0 && db < 0) addEvent(i, ma, mb, da, db, grace)   // 两端都在冠外：只有中途回头（余量先升后降）才可能掠过
          } else addEvent(i, ma, mb, da, db, grace)                    // 状态翻转
        }
      }
    }
  }

  // 区间内某胞元事件链的子区间（绝对秒）写进 ivS / ivE，返回个数
  function eventIntervals(e, tA, tB) {
    const h = tB - tA
    let n = 0
    for (let x = e; x >= 0; x = evNext[x]) {
      const m = hermitePositive(evMa[x], evMb[x], evDa[x], evDb[x], tau)
      for (let j = 0; j < m; j++) {
        if (n >= ivS.length) { const s2 = new Float64Array(ivS.length * 2), e2 = new Float64Array(ivS.length * 2); s2.set(ivS); e2.set(ivE); ivS = s2; ivE = e2 }
        const s = tau[2 * j] <= 0 ? tA : tA + tau[2 * j] * h, en = tau[2 * j + 1] >= 1 ? tB : tA + tau[2 * j + 1] * h
        if (en > s) { ivS[n] = s; ivE[n] = en; n++ }
      }
    }
    return n
  }
  // 不求根的重叠深度上界：三次式离两端连线不超过 grace ⇒ 翻转时刻落在连线根 ± grace/|mb − ma| 之内；
  // 出冠的星按最晚出、进冠的星按最早进、其余（掠过 / 贴边）按全程，数最大重叠。（τ 单位，写进 ivS / ivE 的 [0,1] 段）
  function optimisticDepth(e) {
    let n = 0
    for (let x = e; x >= 0; x = evNext[x]) {
      if (n >= ivS.length) { const s2 = new Float64Array(ivS.length * 2), e2 = new Float64Array(ivS.length * 2); s2.set(ivS); e2.set(ivE); ivS = s2; ivE = e2 }
      const ma = evMa[x], mb = evMb[x], g = evG[x]
      if (ma >= 0 && mb < 0) { ivS[n] = 0; ivE[n] = (ma + g) / (ma - mb) } else if (ma < 0 && mb >= 0) { ivS[n] = (-ma - g) / (mb - ma); ivE[n] = 1 } else { ivS[n] = 0; ivE[n] = 1 }
      n++
    }
    let best = 0
    for (let j = 0; j < n; j++) {
      const t = ivS[j]
      let d = 0
      for (let k = 0; k < n; k++) if (ivS[k] <= t && t <= ivE[k]) d++
      if (d > best) best = d
    }
    return best
  }
  // ivS / ivE 前 n 条的最大重叠深度（首尾相接不算重叠）：深度的最大值必出现在某条的起点，逐条起点数一遍（n 很小）
  function overlapDepth(n) {
    if (n <= 1) return n
    let best = 0
    for (let j = 0; j < n; j++) {
      const t = ivS[j]
      let d = 0
      for (let k = 0; k < n; k++) if (ivS[k] <= t && t < ivE[k]) d++
      if (d > best) best = d
    }
    return best
  }
  function recordGap(i, g) { if (g > maxGap[i]) maxGap[i] = g; gapSum[i] += g; gapCnt[i]++ }
  // 逐格区间表的留底（params.traceCells = [胞元下标…]，单测对拍用；不给就不记）
  const trace = Array.isArray(params.traceCells) && params.traceCells.length ? new Map(params.traceCells.map((i) => [i, []])) : null
  // 胞元 i 新增一段覆盖 [s, e]：与上一段相隔 > GAP_EPS 才算一次新访问，并记下其间的中断（首段记时窗起点以来的中断）
  function addCov(i, s, e) {
    const le = lastEnd[i]
    const fresh = le < 0 || s - le > GAP_EPS
    if (le < 0) { accCount[i]++; if (s > GAP_EPS) recordGap(i, s) } else if (s - le > GAP_EPS) { accCount[i]++; recordGap(i, s - le) }
    covT[i] += e - s
    lastEnd[i] = e
    if (trace) { const L = trace.get(i); if (L) { if (fresh || !L.length) L.push([s, e]); else L[L.length - 1][1] = e } }
  }
  // 区间 [tA, tB] 收账：逐个被触及的胞元把本区间的覆盖子区间并起来，更新时间覆盖 / 访问 / 中断 / 最大重数
  function resolveInterval(tA, tB) {
    for (let q = 0; q < nTouched; q++) {
      const i = touched[q]
      const nb = nBoth[i], e = evHead[i]
      if (nb > 0) {
        addCov(i, tA, tB)
        // 最大重数：下界 = 两端拍上的实数；上界 = 全程星 + 全部事件，再收紧成「不求根的排序上界」。
        // 上界刷新不了现值就不解；上下界相等就不解；剩下才逐条求根数重叠
        let ne = 0, na = 0, nbb = 0
        for (let x = e; x >= 0; x = evNext[x]) { ne++; if (evMa[x] >= 0) na++; if (evMb[x] >= 0) nbb++ }
        const lo = nb + (na > nbb ? na : nbb)
        if (lo > maxN[i]) maxN[i] = Math.min(65535, lo)
        if (nb + ne > maxN[i] && nb + optimisticDepth(e) > maxN[i]) {
          const d = nb + overlapDepth(eventIntervals(e, tA, tB))
          if (d > maxN[i]) maxN[i] = Math.min(65535, d)
        }
      } else if (e >= 0) {
        const n = eventIntervals(e, tA, tB)
        if (n) {
          const d = overlapDepth(n)
          if (d > maxN[i]) maxN[i] = Math.min(65535, d)
          // 按起点排序（条数很少，插入排序）后并集扫线
          for (let j = 1; j < n; j++) {
            const s = ivS[j], en = ivE[j]
            let k = j - 1
            while (k >= 0 && ivS[k] > s) { ivS[k + 1] = ivS[k]; ivE[k + 1] = ivE[k]; k-- }
            ivS[k + 1] = s; ivE[k + 1] = en
          }
          let cs = ivS[0], ce = ivE[0]
          for (let j = 1; j < n; j++) {
            if (ivS[j] <= ce + GAP_EPS) { if (ivE[j] > ce) ce = ivE[j] } else { addCov(i, cs, ce); cs = ivS[j]; ce = ivE[j] }
          }
          addCov(i, cs, ce)
        }
      }
      nBoth[i] = 0; evHead[i] = -1; tFlag[i] = 0
    }
    nTouched = 0; nEv = 0
  }

  // 处理接下来的 k 个时间采样（每拍：全星传播一次；从第 2 拍起逐区间散射 + 收账），累加器就地延续。返回已处理采样数（供进度）。
  function stepBatch(k) {
    const end = Math.min(T, ti + k)
    for (; ti < end; ti++) {
      const tRel = tOf(ti), dtMs = tRel * 1000
      const tReal = new Date(nowMs + dtMs), gReal = sat.gstime(tReal)
      const tCc = new Date(ccMs + dtMs), gCc = sat.gstime(tCc)
      const S = ti === 0 ? SA : SB
      for (let q = 0; q < A; q++) { const e = entries[active[q]]; sampleSat(S, q, e.rec, e._cc, tReal, gReal, tCc, gCc) }
      if (ti > 0) {
        const tA = tOf(ti - 1), h = tRel - tA
        if (h > 0) {
          for (let q = 0; q < A; q++) scatterInterval(q, h)
          resolveInterval(tA, tRel)
        }
        const tmp = SA; SA = SB; SB = tmp
      }
    }
    return ti
  }

  function finalize() {
    // 收尾中断（时窗末仍未覆盖 = 一段尾中断；从没覆盖过 = 整个时窗一段），与首 / 中段同口径计入
    for (let i = 0; i < N; i++) {
      const le = lastEnd[i]
      if (le < 0) recordGap(i, H)
      else if (H - le > GAP_EPS) recordGap(i, H - le)
    }
    const percent = new Float32Array(N), simple = new Float32Array(N), nasset = new Float32Array(N)
    const count = new Float32Array(N), revisit = new Float32Array(N), total = new Float32Array(N), avggap = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const cv = covT[i]
      percent[i] = H > 0 ? Math.min(100, cv / H * 100) : 0
      simple[i] = cv > 0 ? 1 : 0
      nasset[i] = maxN[i]
      count[i] = accCount[i]
      total[i] = cv / 60
      revisit[i] = maxGap[i] / 60                // 全程覆盖→0；从不覆盖→整个时窗（最差）
      avggap[i] = gapCnt[i] > 0 ? gapSum[i] / gapCnt[i] / 60 : 0
    }
    const out = { N, cells, step: grid.step, T, sampleSec, minElevDeg, satActive: active.length, minDetectSec: minDetect > 0 ? minDetect : null, fom: { percent, simple, nasset, count, revisit, total, avggap } }
    if (trace) out.trace = Object.fromEntries(trace)
    return out
  }

  return { T, activeCount: active.length, get ti() { return ti }, stepBatch, finalize }
}

// ==================== 上色成分带填充（渲染层 fillBands 直吃）====================
// grid + values(Float32Array over cells) + { scheme, bands, domain, zeroTransparent } →
//   { fillBands:[{color:[r,g,b], verts:Float64Array, counts:Int32Array}], lo, hi, colors, bands }
// 分带 = STK 静态色阶：域 [lo,hi] 均分 bands 档，每胞元四角打进所属档 → 一档一色（嵌套/铺满皆可）。
// zeroTransparent 时 值≤floorEps 的胞元不出（未覆盖=空）。域缺省从数据自适应（去掉透明胞元后取 min/max）。
export function buildCoverageFillBands(grid, values, opts = {}) {
  const scheme = opts.scheme || 'turbo'
  const bands = Math.max(2, Math.min(24, opts.bands || 10))
  const zeroTransparent = opts.zeroTransparent !== false
  const floorEps = opts.floorEps != null ? opts.floorEps : 1e-9
  const cells = grid.cells, N = cells.length, half = grid.step / 2

  let lo, hi
  if (opts.domain && Number.isFinite(opts.domain[0]) && Number.isFinite(opts.domain[1])) { lo = opts.domain[0]; hi = opts.domain[1] } else {
    lo = Infinity; hi = -Infinity
    for (let i = 0; i < N; i++) { const v = values[i]; if (v !== v) continue; if (zeroTransparent && v <= floorEps) continue; if (v < lo) lo = v; if (v > hi) hi = v }
    if (!(lo <= hi)) { lo = 0; hi = 1 }
  }
  if (hi <= lo) hi = lo + 1

  const colors = schemeColorsRGB(scheme, bands)
  const vb = [], cb = []
  for (let b = 0; b < bands; b++) { vb.push([]); cb.push([]) }
  for (let i = 0; i < N; i++) {
    const v = values[i]
    if (v !== v) continue
    if (zeroTransparent && v <= floorEps) continue
    let u = (v - lo) / (hi - lo); if (u < 0) u = 0; if (u > 1) u = 1
    let b = Math.floor(u * bands); if (b >= bands) b = bands - 1; if (b < 0) b = 0
    const c = cells[i], la = c.lat, ln = c.lon
    const laS = Math.max(-90, la - half), laN = Math.min(90, la + half), loW = ln - half, loE = ln + half
    vb[b].push(loW, laS, loE, laS, loE, laN, loW, laN)   // 逆时针四角
    cb[b].push(4)
  }
  const fillBands = []
  for (let b = 0; b < bands; b++) { if (!cb[b].length) continue; fillBands.push({ color: colors[b], verts: new Float64Array(vb[b]), counts: new Int32Array(cb[b]) }) }
  return { fillBands, lo, hi, colors, bands }
}
