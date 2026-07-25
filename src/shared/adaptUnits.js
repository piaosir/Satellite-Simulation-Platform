// 结果显示单位自适应 — 渲染端镜像（与 packages/core/utils/adaptiveUnits.js 同档位表同规则；
// Vite ESM 吃不了那份 CJS，两边改动须同步）。
// 线性族按数值大小挑档（0.5 W → 500 mW、2457.6 kHz → 2.4576 MHz）；
// 纯功率 dBW 在整组值 <0 dBW（<1 W）时改记 dBm。只用于显示层，不碰引擎口径。

const FAMILIES = {
  Hz: [['Hz', 1], ['kHz', 1e3], ['MHz', 1e6], ['GHz', 1e9]],
  bps: [['bps', 1], ['kbps', 1e3], ['Mbps', 1e6], ['Gbps', 1e9]],
  sps: [['sps', 1], ['ksps', 1e3], ['Msps', 1e6], ['Gsps', 1e9]],
  cps: [['cps', 1], ['kcps', 1e3], ['Mcps', 1e6], ['Gcps', 1e9]],
  W: [['µW', 1e-6], ['mW', 1e-3], ['W', 1], ['kW', 1e3], ['MW', 1e6]]
}
const UNIT_INDEX = {}
for (const fam of Object.keys(FAMILIES)) {
  for (const [u, f] of FAMILIES[fam]) UNIT_INDEX[u] = { fam, f }
}

// 按最大绝对值挑档位（尾数落在 [1,1000)）；单位不认识 / 无须换档返回 null
export function pickUnit(maxAbs, unit) {
  const info = UNIT_INDEX[unit]
  if (!info || !isFinite(maxAbs) || maxAbs <= 0) return null
  const base = maxAbs * info.f
  const steps = FAMILIES[info.fam]
  let chosen = steps[0]
  for (const s of steps) { if (base / s[1] >= 1) chosen = s }
  if (chosen[0] === unit) return null
  return { unit: chosen[0], factor: info.f / chosen[1] }
}

// 换档后的数值格式：最多 4 位小数并去尾零
export function fmtScaled(n) {
  return isFinite(n) ? String(parseFloat(n.toFixed(4))) : String(n)
}

// 同族线性单位换算 + dBW↔dBm（对比列把第二条链路换算到主链路单位用）；不可换返回 null
export function convertUnit(v, from, to) {
  if (!isFinite(v)) return null
  if (from === to) return v
  if (from === 'dBW' && to === 'dBm') return v + 30
  if (from === 'dBm' && to === 'dBW') return v - 30
  const a = UNIT_INDEX[from]
  const b = UNIT_INDEX[to]
  if (!a || !b || a.fam !== b.fam) return null
  return v * a.f / b.f
}

// 一组同量纲数值（结果列一整列）共选一个显示单位；dBW 仅全组 <0 才转 dBm。
// 返回 { unit, conv } 或 null（保持原单位）
export function pickColumn(vals, unit) {
  const nums = (vals || []).filter((n) => isFinite(n))
  if (!nums.length) return null
  if (unit === 'dBW') {
    if (Math.max(...nums) < 0) return { unit: 'dBm', conv: (v) => v + 30 }
    return null
  }
  const p = pickUnit(Math.max(...nums.map(Math.abs)), unit)
  return p ? { unit: p.unit, conv: (v) => v * p.factor } : null
}

// 单值「数值 + 单位」直出（KPI 卡片用）：非数值原样带单位返回
export function fmtQty(v, unit) {
  const n = parseFloat(v)
  if (!isFinite(n)) return (v === undefined || v === null || v === '' ? '—' : String(v)) + (unit ? ' ' + unit : '')
  if (unit === 'dBW' && n < 0) return fmtScaled(n + 30) + ' dBm'
  const p = pickUnit(Math.abs(n), unit)
  return p ? fmtScaled(n * p.factor) + ' ' + p.unit : String(v) + (unit ? ' ' + unit : '')
}
