// 链路预算绘图的纯数学层：刻度取整、线性/对数标度、数值格式化。
// 无 DOM 无 Vue，链路预算各图共用，也便于单测。

// 把区间跨度吸附到 1/2/5×10ⁿ 这类「好看的数」。round=false 时只向上取（保证覆盖数据）。
function niceNum(range, round) {
  if (!(range > 0)) return 1
  const exp = Math.floor(Math.log10(range))
  const f = range / Math.pow(10, exp)
  let nf
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return nf * Math.pow(10, exp)
}

// 线性轴：给定数据范围与期望刻度数，返回取整后的轴范围与刻度点。
// 数据全等（跨度 0）时人为撑开一点，避免除零与零高度绘图区。
export function niceScale(min, max, maxTicks) {
  const n = Math.max(2, maxTicks || 5)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.5, ticks: [0, 0.5, 1] }
  if (max === min) { const d = Math.abs(min) > 1 ? Math.abs(min) * 0.05 : 0.5; min -= d; max += d }
  const step = niceNum((max - min) / (n - 1), true)
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks = []
  // 累加会漂（0.1 加十次 ≠ 1），故按序号乘出每个刻度再抹掉浮点尾巴
  const cnt = Math.round((hi - lo) / step)
  for (let i = 0; i <= cnt; i++) ticks.push(Math.round((lo + i * step) * 1e9) / 1e9)
  return { min: lo, max: hi, step, ticks }
}

// 刻度标签：小数位数由步长定（步长 0.05 → 2 位，步长 5 → 0 位），避免 12.000000001 之流
export function fmtTick(v, step) {
  if (!Number.isFinite(v)) return ''
  const s = Math.abs(step || 1)
  const dec = s >= 10 ? 0 : s >= 1 ? 0 : s >= 0.1 ? 1 : s >= 0.01 ? 2 : 3
  const t = v.toFixed(dec)
  return t === '-0' ? '0' : t
}

// 读数格式化（悬停 / 直接标注）：按量级定小数位，不做单位换算（口径交给调用方）
export function fmtVal(v, dec) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—'
  const n = +v
  if (dec !== undefined && dec !== null) return n.toFixed(dec)
  const a = Math.abs(n)
  return n.toFixed(a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4)
}

// 线性映射工厂：数据域 [d0,d1] → 像素域 [p0,p1]
export function linScale(d0, d1, p0, p1) {
  const dd = (d1 - d0) || 1
  return (v) => p0 + ((v - d0) / dd) * (p1 - p0)
}

// 数据范围两端留白（默认各 6%），使曲线不贴边、极值点标注放得下
export function padRange(min, max, frac) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  const f = frac === undefined ? 0.06 : frac
  if (max === min) { const d = Math.abs(min) > 1 ? Math.abs(min) * 0.05 : 0.5; return [min - d, max + d] }
  const p = (max - min) * f
  return [min - p, max + p]
}

// 「这个量在本次扫描里恒定吗」——场图与它的控制条共用同一把尺（图内据此不画等值线、
// 控制条据此在选项后缀「· 恒定」，两处说法不能打架）。
//
// 不用相对变化：dB / K / ° 这类量的零点是人定的，同样 0.2 的绝对起伏，落在 13 dB 上算
// 「变了」、落在 140 K 上就成了「没变」，同一把尺量出两种结论；斜距 37000 km 更是把 180 km
// 的真实起伏也判成恒定。改按该量在报表里的显示步长定：引擎出参是 toFixed(2) 一类的定点数，
// 起伏不到半个显示步长即恒定——这也正是用户能从数字上读出的最小差别。
// 兜底的 1e-6 相对项留给过求解器的量：二分/反解会在数学上恒定的量上留下末位噪声
// （实测「设置功放功率」方式下功放建议功率跨全图起伏 1e-6 W），照画就是满屏假纹路。
const FLAT_EPS = {
  dB: 0.005, dBW: 0.005, dBi: 0.005, dBHz: 0.005, 'dBW/Hz': 0.005, 'dBW/m²': 0.005, 'dB/K': 0.005,
  K: 0.005, '°': 0.005, km: 0.005, ms: 0.05, '%': 0.0005, 'mm/h': 0.005, m: 0.5, min: 0.005,
  kHz: 0.0005, kBaud: 0.005, 'bps/Hz': 0.0005
}
export function isFlatSpan(lo, hi, unit) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false
  // 单位不在表内（如功放功率的 W——跨度动辄几个数量级，绝对门限定不出来）只走相对项
  const eps = FLAT_EPS[unit] || 0
  return (hi - lo) <= Math.max(eps, 1e-6 * (Math.max(Math.abs(lo), Math.abs(hi)) || 1))
}

// 数组极值（跳过 null/NaN）；全空返回 null
export function extent(arr) {
  let lo = Infinity, hi = -Infinity
  for (const v of arr) { if (v === null || v === undefined || !Number.isFinite(+v)) continue; const n = +v; if (n < lo) lo = n; if (n > hi) hi = n }
  return lo === Infinity ? null : [lo, hi]
}
