// 卫星信息栏扩展读数（状态矢量 / 密切根数 / 同步轨道 / 相对状态 / 星历）的取数与格式化。
// 信息栏与视频叠加共用这一份，串格式两处逐字一致（同 3D 页 cardFor 的约定）。
// 算式全在 shared/orbitState.js；本文件只管「取哪颗星、哪一刻」与「写成几位」。
//
// 读数位数（与 TLE / OEM 原文的分辨率同档，不多给假精度也不吞位）：
//   位置 0.001 km（1 m）· 速度 0.000001 km/s（1 mm/s）· 角度 0.0001°（GEO 上 74 m）· 偏心率 1e-7 · 平均运动 1e-8 圈/日
// 取位一律走 satPos.posAt（叠加星历 / 点序列 / 定点 / SGP4 同一个入口），换帧上下文按 jdFromMs 起 GMST
// （与导出引擎 convertSat 同一条路 —— 信息栏抄下来的数与导出文件逐位一致，见 refFrames.test.mjs ④）。

import sat from './satellite.js'
import { posAt, propOf, validSpan, overlayVersion } from './satPos.js'
import { frameContext, stateVector, oscElements, syncElements, relState, kozaiMeanMotion, RAD_MIN_TO_REV_DAY } from '../../shared/orbitState.js'
import { jdFromMs } from '../../shared/refFrames.js'

const DEG = Math.PI / 180
export const FRAME_LABEL = { FIXED: 'ECEF', J2000: 'J2000', TEME: 'TEME' }

// 定点格式：去掉「-0.000」这种负零
export const fx = (v, d) => {
  if (!Number.isFinite(v)) return ''
  const s = v.toFixed(d)
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s
}
const deg360 = (rad, d = 4) => (Number.isFinite(rad) ? fx(((rad / DEG) % 360 + 360) % 360, d) : '')
const signed = (v, d) => { const s = fx(v, d); return s && !s.startsWith('-') && Number(s) !== 0 ? '+' + s : s }
const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180
export const ctxAt = (ms) => frameContext(ms, sat.gstime)
const gmstAt = (ms) => sat.gstime(jdFromMs(ms))
// 天线树里非同步高度的定点（空间里钉住的一个点）：没有轨道，密切根数 / 同步轨道一律不出
const isPin = (e) => { const o = propOf(e); return !!(o && o.__fix && !o.__fix.sync) }

/* ===================== 状态矢量 + 密切根数 ===================== */
// sv / osc：要的参考系（null = 不要这一块）。返回 { sv, osc }，各块取不到为 null。
export function stateCard(e, tMs, { sv = 'FIXED', osc = 'J2000' } = {}) {
  const pv = posAt(e, tMs)
  if (!pv) return null
  const ctx = ctxAt(tMs)
  const out = { sv: null, osc: null }
  if (sv) {
    const s = stateVector(pv, sv, ctx)
    if (s) {
      out.sv = {
        frame: s.frame,
        x: fx(s.r.x, 3), y: fx(s.r.y, 3), z: fx(s.r.z, 3),
        vx: fx(s.v.x, 6), vy: fx(s.v.y, 6), vz: fx(s.v.z, 6),
        r: fx(Math.hypot(s.r.x, s.r.y, s.r.z), 3)
      }
    }
  }
  if (osc && !isPin(e)) {
    const s = stateVector(pv, osc, ctx)
    const el = s && oscElements(s.r, s.v)
    if (el && el.e < 1) {
      out.osc = {
        frame: s.frame,
        a: fx(el.a, 3), e: fx(el.e, 7), i: fx(el.i / DEG, 4),
        raan: deg360(el.raan), argp: deg360(el.argp), nu: deg360(el.nu),
        u: deg360(el.u), M: deg360(el.M), L: deg360(el.L)
      }
    }
  }
  return out
}

// 「复制状态矢量」：表头一行 + 数值一行（Tab 分隔，可直接贴进 Excel / STK），数值全精度（最短往返串）
export function stateVectorText(e, tMs, frame, en) {
  const pv = posAt(e, tMs)
  const s = pv && stateVector(pv, frame, ctxAt(tMs))
  if (!s) return ''
  const head = en
    ? ['Time (UTC)', 'Frame', 'X (km)', 'Y (km)', 'Z (km)', 'VX (km/s)', 'VY (km/s)', 'VZ (km/s)']
    : ['时刻（UTC）', '坐标系', 'X (km)', 'Y (km)', 'Z (km)', 'VX (km/s)', 'VY (km/s)', 'VZ (km/s)']
  const row = [new Date(tMs).toISOString(), FRAME_LABEL[s.frame] || s.frame, s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z].map(String)
  return head.join('\t') + '\n' + row.join('\t')
}

/* ===================== 同步轨道（GEO / IGSO） ===================== */
// 窗口平均 72 次取位，按「条目 + 传播体 + 分钟档 + 叠加注册表版本」缓存 —— 每拍重算的只是格式化。
// 分钟档：平经度 1 min 只走 D·1min（GEO 量级 1e-5°），读数位数之下；倾角 / 偏心率矢量更慢。
const _syncCache = new WeakMap()
export function syncRaw(e, tMs) {
  if (!e || isPin(e)) return null
  const q = Math.round(tMs / 60000), prop = propOf(e), ov = overlayVersion()
  const c = _syncCache.get(e)
  if (c && c.q === q && c.prop === prop && c.ov === ov) return c.s
  const sample = (ms) => {
    const pv = posAt(e, ms)
    return pv ? { r: pv.position, v: pv.velocity, gmst: gmstAt(ms) } : null
  }
  const s = syncElements(sample, q * 60000, validSpan(e))
  _syncCache.set(e, { q, prop, ov, s })
  return s
}
// nominal：标称经度（°，东正）或 null；box：{ ew, ns }（°，0 = 不设）。
// 越界判据按窗口内【实际日轨迹】的极值（含 2e 经度天平动、±i 纬度摆动），与轨迹图上框内框外所见一致。
export function syncCard(e, tMs, nominal, box) {
  const s = syncRaw(e, tMs)
  if (!s) return null
  const nom = Number.isFinite(nominal) ? nominal : null
  let dxMax = 0, dyMax = 0
  if (nom != null) for (const p of s.track) { dxMax = Math.max(dxMax, Math.abs(wrap180(p.lon - nom))); dyMax = Math.max(dyMax, Math.abs(p.lat)) }
  else for (const p of s.track) dyMax = Math.max(dyMax, Math.abs(p.lat))
  const ew = box && box.ew > 0 ? box.ew : 0, ns = box && box.ns > 0 ? box.ns : 0
  return {
    lon: fx(Math.abs(s.lonMean), 4), lonH: s.lonMean < 0 ? '°W' : '°E',
    nom: nom != null ? fx(Math.abs(nom), 2) : '', nomH: nom != null && nom < 0 ? '°W' : '°E',
    dlon: nom != null ? signed(wrap180(s.lonMean - nom), 4) : '',
    drift: signed(s.drift, 4),
    e: fx(s.e, 7), ex: fx(s.ex, 7), ey: fx(s.ey, 7),
    i: fx(s.i, 4), ix: fx(s.ix, 4), iy: fx(s.iy, 4),
    ewOut: !!(ew && nom != null && dxMax > ew), nsOut: !!(ns && dyMax > ns),
    raw: s
  }
}

// 日轨迹图几何（纯函数，像素坐标）：横轴 Δλ（相对标称经度，东正），纵轴 φ（北正），两轴各自对称、各自取整刻度。
// 没给标称经度时以平经度为中心、不画框。W / H：整图像素宽高。返回 { path, box, ticksX, ticksY, dot, ox, oy, plot }
const NICE = [1, 2, 2.5, 5, 10]
// 离目标步长最近（对数意义上）的 1 / 2 / 2.5 / 5 × 10ⁿ
export function niceStep(h) {
  if (!(h > 0)) return 1
  const p = Math.pow(10, Math.floor(Math.log10(h)))
  let best = p, bd = Infinity
  for (const k of NICE) { const d = Math.abs(Math.log(k * p / h)); if (d < bd) { bd = d; best = k * p } }
  return best
}
const tickText = (v, step) => {
  if (Math.abs(v) < step * 1e-6) return '0'
  // 步长 = m × 10^e：2.5 档多给一位小数（0.025 → 3 位、0.25 → 2 位；按字符串找「2.5」会漏掉 0.025 / 0.25）
  const e = Math.floor(Math.log10(step) + 1e-9), m = step / 10 ** e
  const d = Math.max(0, Math.min(6, -e + (Math.abs(m - 2.5) < 1e-6 ? 1 : 0)))
  return fx(v, d)
}
export function syncPlot(raw, now, nominal, box, W, H) {
  if (!raw || !raw.track || !raw.track.length || !(W > 40) || !(H > 40)) return null
  const c = Number.isFinite(nominal) ? nominal : raw.lonMean
  const pts = raw.track.map((p) => [wrap180(p.lon - c), p.lat])
  const cur = now && Number.isFinite(now.lon) && Number.isFinite(now.lat) ? [wrap180(now.lon - c), now.lat] : null
  const ew = Number.isFinite(nominal) && box && box.ew > 0 ? box.ew : 0
  const ns = Number.isFinite(nominal) && box && box.ns > 0 ? box.ns : 0
  let hx = ew, hy = ns
  for (const p of pts) { hx = Math.max(hx, Math.abs(p[0])); hy = Math.max(hy, Math.abs(p[1])) }
  if (cur) { hx = Math.max(hx, Math.abs(cur[0])); hy = Math.max(hy, Math.abs(cur[1])) }
  hx = Math.max(hx * 1.12, 1e-4); hy = Math.max(hy * 1.12, 1e-4)
  const sx = niceStep(hx / 2.2), sy = niceStep(hy / 2.2)   // 每侧两档左右
  // 版心：左留纵轴刻度字宽、下留横轴刻度字高
  const L = 40, R = 6, T = 6, B = 18
  const pw = W - L - R, ph = H - T - B
  const X = (v) => L + (v + hx) / (2 * hx) * pw
  const Y = (v) => T + (hy - v) / (2 * hy) * ph
  const r1 = (v) => Math.round(v * 10) / 10
  let path = ''
  pts.forEach((p, k) => { path += (k ? 'L' : 'M') + r1(X(p[0])) + ' ' + r1(Y(p[1])) })
  // 不强行闭合：首尾之间的开口就是这一恒星日的漂移（受控 GEO 几乎首尾相接；漂移中的星硬闭合会多出一条横穿的假连线）
  const ticks = (h, s) => { const m = Math.floor(h / s + 1e-9), out = []; for (let k = -m; k <= m; k++) out.push(k * s); return out }
  return {
    path,
    box: ew || ns ? { x: r1(X(-(ew || hx))), y: r1(Y(ns || hy)), w: r1(X(ew || hx) - X(-(ew || hx))), h: r1(Y(-(ns || hy)) - Y(ns || hy)) } : null,
    ticksX: ticks(hx, sx).map((v) => ({ x: r1(X(v)), t: tickText(v, sx) })),
    ticksY: ticks(hy, sy).map((v) => ({ y: r1(Y(v)), t: tickText(v, sy) })),
    dot: cur ? { x: r1(X(cur[0])), y: r1(Y(cur[1])) } : null,
    ox: r1(X(0)), oy: r1(Y(0)),
    plot: { x: L, y: T, w: pw, h: ph }
  }
}

/* ===================== 相对状态 ===================== */
// 目标 es 相对参考 ep（主选），参考星的 RIC 系（TEME 里算；RIC 分量与惯性系的选取无关）
export function relCard(ep, es, tMs) {
  const a = posAt(ep, tMs), b = posAt(es, tMs)
  if (!a || !b) return null
  const s = relState(a.position, a.velocity, b.position, b.velocity)
  if (!s) return null
  return {
    range: fx(s.range, 3), rate: fx(s.rate, 6), theta: fx(s.theta / DEG, 4),
    R: fx(s.R, 3), I: fx(s.I, 3), C: fx(s.C, 3),
    dR: fx(s.dR, 6), dI: fx(s.dI, 6), dC: fx(s.dC, 6)
  }
}

/* ===================== 星历（源数据） ===================== */
// 平均根数星：传播模型 + TLE 原文口径的平均运动（Kozai）与 B*；点序列星：插值方式 / 点数 / 时段 / 原帧；定点星只给模型名。
export function ephemInfo(e) {
  const o = propOf(e)
  if (!o) return null
  if (o.__ephem) {
    return { kind: 'ephem', method: o.method === 'hermite' ? 'hermite' : 'lagrange', samples: o.samples, n: o.n, t0: o.t0, t1: o.t1, frame: o.srcFrame || 'TEME' }
  }
  if (o.__fix) return { kind: 'fix' }
  const nk = kozaiMeanMotion(o)
  const b = Number(o.bstar)
  return {
    kind: 'gp', prop: o.method === 'd' ? 'SDP4' : 'SGP4',
    n: nk ? fx(nk * RAD_MIN_TO_REV_DAY, 8) : '',
    bstar: Number.isFinite(b) ? (b === 0 ? '0' : b.toExponential(4)) : ''
  }
}

export default { FRAME_LABEL, fx, ctxAt, stateCard, stateVectorText, syncRaw, syncCard, syncPlot, relCard, ephemInfo }
