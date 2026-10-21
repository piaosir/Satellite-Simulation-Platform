// 时区规则（tzdb 2026e，构建期由 scripts/build-timezones.mjs 从 PyPI tzdata 2026.5 的 TZif 打包成 ./tz/tzRules.json）。
//
// ★ 时区图层一律走这一份，不许用 Intl / Date 取任何地方时区的偏移：Electron 31 自带的 ICU 时区库是 2024a，
//   巴拉圭、智利艾森、BC / 阿尔伯塔 / 西北地区 / 曼尼托巴、摩洛哥（2026-09-20 回 +00）都算错。
//
// 每区：显式跃迁段到最后一次为止 + 之后按 POSIX 脚注现算（tzPosix.js，与构建脚本同一份），故 2100 年以后照样有解。
// 夏令时份额 dst 是 rearguard 语义（一律 ≥ 0）：标准时 = off − dst。爱尔兰全年标准时 +0、夏天那 1 h 算夏令时；
// 摩洛哥 2018–2026 期间标准时 +00。
//
// 规则表格式（tzRules.json）：{ v, zones: [名], data: [[off0, dst0, Δt1, off1, dst1, Δt2, …]], foot: [脚注串], fs: [脚注生效时刻] }
//   首段是 1970-01-01 时所处状态（起点 −∞）；Δt 为相邻跃迁的秒差（第一个 Δt 是自 1970 起的绝对秒）；off / dst 单位分钟。
import { parsePosixTz, posixAt, posixStdBase } from './tzPosix.js'

let R = null

export function setRules(json) {
  const zones = json.zones.slice()
  const idx = new Map(zones.map((z, i) => [z, i]))
  const segs = json.data.map((arr, i) => {
    const n = 1 + (arr.length - 2) / 3
    const ts = new Float64Array(n), off = new Float64Array(n), dst = new Float64Array(n)
    ts[0] = -Infinity; off[0] = arr[0]; dst[0] = arr[1]
    let t = 0
    for (let k = 1, p = 2; k < n; k++, p += 3) { t += arr[p]; ts[k] = t; off[k] = arr[p + 1]; dst[k] = arr[p + 2] }
    const f = json.foot[i]
    const tz = f ? parsePosixTz(f) : null
    const fs0 = json.fs ? json.fs[i] : (n > 1 ? ts[n - 1] : 0)
    return { ts, off, dst, tz: tz && tz.dst ? tz : null, base: tz && tz.dst ? posixStdBase(tz) : 0, fs: fs0, a: 0, b: -1, co: 0, cd: 0 }
  })
  R = { v: json.v, zones, idx, segs }
  return R
}

// 规则表懒加载（★ 不带 with { type: 'json' }：dev 期浏览器按 MIME 核对导入属性会整个拒掉）
let loading = null
export function loadRules() {
  if (R) return Promise.resolve(R)
  if (!loading) loading = import('./tz/tzRules.json').then((m) => setRules(m.default || m))
  return loading
}

export const rulesReady = () => !!R
export const rulesVersion = () => (R ? R.v : '')
export const zoneCount = () => (R ? R.zones.length : 0)
export const zoneName = (i) => (R && i >= 0 && i < R.zones.length ? R.zones[i] : '')
export const zoneIndex = (name) => (R && R.idx.has(name) ? R.idx.get(name) : -1)

// 区 i 在 ms 时刻的 { off, dst }（分钟）。命中上次求得的恒定区间时直接返回（每拍对几百个区调一遍，几乎零开销）。
const OUT = { off: 0, dst: 0 }
export function offsetAt(i, ms) {
  const s = R.segs[i]
  const t = ms / 1000
  if (t >= s.a && t < s.b) { OUT.off = s.co; OUT.dst = s.cd; return OUT }
  const ts = s.ts
  let lo = 0, hi = ts.length - 1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= t) lo = m; else hi = m - 1 }
  let off = s.off[lo], dst = s.dst[lo], a = ts[lo], b = lo + 1 < ts.length ? ts[lo + 1] : Infinity
  if (lo === ts.length - 1 && s.tz) {
    if (t < s.fs) b = s.fs                // 脚注还没生效：缓存只到它生效那一刻
    else {
      const st = posixAt(s.tz, t, Math.max(ts[lo], s.fs))
      if (st) { off = st.utoff / 60; dst = (st.utoff - s.base) / 60; a = st.from; b = st.to }
      else { a = 0; b = 0 }               // 脚注生效后、首次脚注跃迁之前（每区至多一段、几小时到几个月）：不缓存
    }
  }
  s.a = a; s.b = b; s.co = off; s.cd = dst
  OUT.off = off; OUT.dst = dst
  return OUT
}

// 民用时（含夏令时）或标准时的偏移（分钟）
export function zoneOffset(i, ms, civil) {
  const r = offsetAt(i, ms)
  return civil ? r.off : r.off - r.dst
}
