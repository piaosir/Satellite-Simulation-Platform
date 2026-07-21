// STK Coverage 覆盖分析 —— 纯几何计算核（无 Vue / DOM 依赖，可离线单测），与 visibility.js 同源同风格。
// 复刻 STK Coverage：在一片区域上撒【网格 Grid】→ 对每个网格胞元跑「资产集(卫星集)在时窗内的可见性」→
// 汇成【覆盖性能指标 Figure of Merit】→ 供渲染层上色成热力图。判据与 visibility.js 同口径（ecfToLookAngles 仰角）。
//
// 性能关键 = 时间主序遍历：传播只依赖 (星, 时刻)、不依赖胞元 → 每个时刻把整星集传播一次、对所有胞元复用
// ecfToLookAngles（廉价，无 SGP4）。远省于「逐胞元重跑 accessWindows（会把每颗星按胞元数重复传播）」。
// 双历元：真实星按 now、合成星按 ccNow 解算（与 visibility.js 的 _cc 约定一致）。
//
// 分批可续算：createCoverageRun 返回 { T, stepBatch(k), finalize() }，由 useVisibility 按「时间批」分帧调用，
// 避免长扫描冻结 UI（accessWindows 分帧同款思路，只是这里状态在累加器里跨批延续）。
import sat from '../constellation/satellite.js'
import { orbitCanReach } from './visibility.js'
import { schemeColorsRGB } from '../grd/colormap.js'

const DEG = Math.PI / 180
const RE = 6378.137   // 地球赤道半径（km），球面覆盖冠半角用

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

// 点在多边形内（射线法，[lon,lat] 顶点串；跨 ±180° 未展开——协调区一般不跨越经度断裂线）
function pointInPoly(lon, lat, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside
  }
  return inside
}

// ==================== 网格生成 ====================
// region: { kind:'global'|'bounds'|'poly', latMin,latMax,lonMin,lonMax, poly:[[lon,lat]...] }
// stepDeg: 胞元步长（度）。返回 { cells:[{lat,lon}], step, latMin,latMax,lonMin,lonMax }
//   cells = 胞元【中心】；四角由渲染层按 lat±step/2、lon±step/2 取（纬度夹到 ±90）。
export function makeCoverageGrid(region, stepDeg) {
  const step = clamp(Number(stepDeg) || 5, 0.25, 30)
  const r = region || {}
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180
  let poly = null
  if (r.kind === 'bounds') {
    latMin = clamp(Number(r.latMin), -90, 90); latMax = clamp(Number(r.latMax), -90, 90)
    lonMin = Number.isFinite(r.lonMin) ? r.lonMin : -180; lonMax = Number.isFinite(r.lonMax) ? r.lonMax : 180
  } else if (r.kind === 'poly' && Array.isArray(r.poly) && r.poly.length >= 3) {
    poly = r.poly
    latMin = 90; latMax = -90; lonMin = 180; lonMax = -180
    for (const p of poly) {
      const lon = p[0], lat = p[1]
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      if (lat < latMin) latMin = lat; if (lat > latMax) latMax = lat
      if (lon < lonMin) lonMin = lon; if (lon > lonMax) lonMax = lon
    }
  }
  if (!(latMax > latMin)) { const t = latMin; latMin = Math.min(t, latMax); latMax = Math.max(t, latMax) }
  if (latMax === latMin) { latMin -= step; latMax += step }
  const cells = []
  const halfSpanLon = lonMax - lonMin
  for (let lat = latMin + step / 2; lat < latMax; lat += step) {
    const la = clamp(lat, -89.999, 89.999)
    for (let d = step / 2; d < halfSpanLon; d += step) {
      const rawLon = lonMin + d
      const lo = normLon(rawLon)
      if (poly && !pointInPoly(lo, la, poly)) continue
      cells.push({ lat: la, lon: lo })
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

// ==================== 覆盖计算（分批可续算 · 星下点散射法）====================
// entries: [{rec,name,noradId,group,_cc}]（与 visibility.js 同形）· grid: makeCoverageGrid 结果
// times: { now:Date, ccNow:Date } · params: { horizonSec, minElevDeg, sampleSec }
// 返回 { T, activeCount, ti(), stepBatch(k)->已处理采样数, finalize()->{ N, cells, step, T, sampleSec, minElevDeg, satActive, fom:{...} } }
//
// 加速核心（对标 STK）：不再「每胞元 × 每星」逐对做 ecfToLookAngles（旧法 = 胞元×星×采样，大集会爆）。
// 改为逐星【散射】：每采样把每颗有效星传播一次得星下点 (subLat,subLon) 与覆盖地心半角 λ(球面模型)，
// 只往该冠内的行/经度窗胞元 tmpN++。判据 λ=acos(Re/(Re+h)·cosε)−ε（ε=仰角门限），与球面可见性等价。
// 成本 ≈ 传播(星×采样) + 散射(星×采样×冠内胞元) + 累加扫描(胞元×采样)，把「胞元×星」的积去掉。
export function createCoverageRun(entries, grid, times, params) {
  const cells = grid.cells, N = cells.length, M = entries.length
  const minElevDeg = Number(params.minElevDeg) || 0
  const epsRad = minElevDeg * DEG, cosEps = Math.cos(epsRad)
  const sampleSec = Math.max(5, Number(params.sampleSec) || 60)
  const stepMs = sampleSec * 1000
  const T = Math.max(1, Math.floor((Number(params.horizonSec) || 0) / sampleSec) + 1)
  const nowMs = times.now.getTime()
  const ccMs = (times.ccNow || times.now).getTime()

  // 区域纬度范围 → 星集粗筛（不传播）：只留轨道够得着该纬度带的星，跳过整片够不着的（跨赤道带取最宽松纬度=0）
  let rLatMin = 90, rLatMax = -90
  for (const c of cells) { if (c.lat < rLatMin) rLatMin = c.lat; if (c.lat > rLatMax) rLatMax = c.lat }
  const nearLat = (rLatMin <= 0 && rLatMax >= 0) ? 0 : (Math.abs(rLatMin) <= Math.abs(rLatMax) ? rLatMin : rLatMax)
  const active = []
  for (let s = 0; s < M; s++) if (orbitCanReach(entries[s].rec, nearLat, minElevDeg)) active.push(s)

  // 网格按行分桶（同纬度一行、行内经度升序——makeCoverageGrid 行主序生成，天然如此）：散射时只触及少数行
  const rows = []
  for (let i = 0; i < N;) {
    const lat = cells[i].lat
    let j = i; while (j < N && cells[j].lat === lat) j++
    const lons = new Float64Array(j - i), idxs = new Int32Array(j - i)
    for (let k = i; k < j; k++) { lons[k - i] = cells[k].lon; idxs[k - i] = k }
    rows.push({ lat, sinLat: Math.sin(lat * DEG), cosLat: Math.cos(lat * DEG), lons, idxs })
    i = j
  }

  // 逐胞元累加器
  const tmpN = new Uint16Array(N)      // 本采样各胞元同时可见资产数（散射填、扫描后清零）
  const covered = new Uint32Array(N)   // 覆盖采样数
  const maxN = new Uint16Array(N)      // 最大同时可见资产数（N 重覆盖）
  const accCount = new Uint16Array(N)  // 访问次数（覆盖区间数 = 上升沿数）
  const prevCov = new Uint8Array(N)    // 上一采样是否覆盖
  const gapRun = new Uint32Array(N)    // 当前未覆盖连续采样数
  const maxGap = new Uint32Array(N)    // 最长未覆盖连续采样数（含首尾）
  const gapSum = new Float64Array(N)   // 各段未覆盖时长之和（含首尾），/gapCnt=平均间隔
  const gapCnt = new Uint32Array(N)
  const touched = []                   // 本采样被触及的胞元下标（扫后仅清这些，免每采样清整张 N）

  let ti = 0

  // 一颗星在某时刻散射：星下点 + 覆盖冠 λ → 触及行 × 经度窗内胞元 tmpN++（并记 touched 供清零）
  function scatter(rec, cc, tReal, gReal, tCc, gCc) {
    let pv; try { pv = sat.propagate(rec, cc ? tCc : tReal) } catch { return }
    if (!pv || !pv.position) return
    const gd = sat.eciToGeodetic(pv.position, cc ? gCc : gReal)
    const h = gd.height
    if (!(h > 0)) return
    const cosArg = RE / (RE + h) * cosEps
    if (cosArg >= 1) return                              // 星过低：无覆盖
    const lam = Math.acos(cosArg) - epsRad               // 覆盖地心半角（rad）
    if (!(lam > 0)) return
    const lamDeg = lam / DEG, cosLam = Math.cos(lam)
    const subLat = sat.degreesLat(gd.latitude), subLon = sat.degreesLong(gd.longitude)
    const sinSub = Math.sin(subLat * DEG), cosSub = Math.cos(subLat * DEG)
    const latLo = subLat - lamDeg, latHi = subLat + lamDeg
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      if (row.lat < latLo || row.lat > latHi) continue
      const denom = row.cosLat * cosSub
      let wDeg
      if (Math.abs(denom) < 1e-12) wDeg = 181            // 近极点：整行（保守）
      else { const ratio = (cosLam - row.sinLat * sinSub) / denom; if (ratio >= 1) continue; wDeg = ratio <= -1 ? 181 : Math.acos(ratio) / DEG }
      const lons = row.lons, idxs = row.idxs
      for (let k = 0; k < lons.length; k++) {
        let d = lons[k] - subLon; if (d > 180) d -= 360; else if (d < -180) d += 360; if (d < 0) d = -d
        if (d <= wDeg) { const idx = idxs[k]; if (tmpN[idx] === 0) touched.push(idx); if (tmpN[idx] < 65535) tmpN[idx]++ }
      }
    }
  }

  // 处理接下来的 k 个时间采样，累加器就地延续。返回已处理采样数（供进度）。
  function stepBatch(k) {
    const end = Math.min(T, ti + k)
    for (; ti < end; ti++) {
      const dtMs = ti * stepMs
      const tReal = new Date(nowMs + dtMs), gReal = sat.gstime(tReal)
      const tCc = new Date(ccMs + dtMs), gCc = sat.gstime(tCc)
      for (let a = 0; a < active.length; a++) { const e = entries[active[a]]; scatter(e.rec, e._cc, tReal, gReal, tCc, gCc) }
      for (let i = 0; i < N; i++) {
        const n = tmpN[i], cov = n > 0
        if (cov) {
          covered[i]++
          if (n > maxN[i]) maxN[i] = n
          if (!prevCov[i]) accCount[i]++
          if (gapRun[i] > 0) { const g = gapRun[i]; if (g > maxGap[i]) maxGap[i] = g; gapSum[i] += g; gapCnt[i]++; gapRun[i] = 0 }
        } else {
          gapRun[i]++
        }
        prevCov[i] = cov
      }
      for (let t = 0; t < touched.length; t++) tmpN[touched[t]] = 0   // 只清本采样触及的胞元
      touched.length = 0
    }
    return ti
  }

  function finalize() {
    // 收尾未覆盖段（时窗末仍未覆盖 = 一段尾间隔，与首/中段同口径计入）
    for (let i = 0; i < N; i++) { const g = gapRun[i]; if (g > 0) { if (g > maxGap[i]) maxGap[i] = g; gapSum[i] += g; gapCnt[i]++ } }
    const minPer = sampleSec / 60
    const percent = new Float32Array(N), simple = new Float32Array(N), nasset = new Float32Array(N)
    const count = new Float32Array(N), revisit = new Float32Array(N), total = new Float32Array(N), avggap = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const cv = covered[i]
      percent[i] = T > 0 ? cv / T * 100 : 0
      simple[i] = cv > 0 ? 1 : 0
      nasset[i] = maxN[i]
      count[i] = accCount[i]
      total[i] = cv * minPer
      revisit[i] = maxGap[i] * minPer            // 全程覆盖→0；从不覆盖→整个时窗（最差）
      avggap[i] = gapCnt[i] > 0 ? (gapSum[i] / gapCnt[i]) * minPer : 0
    }
    return { N, cells, step: grid.step, T, sampleSec, minElevDeg, satActive: active.length, fom: { percent, simple, nasset, count, revisit, total, avggap } }
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
