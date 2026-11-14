// Only system-wide quantities belong in the chain comparison table and formula pool.
// Segment C/N, carrier MODCOD, satellite power and station parameters stay in the detailed budget.
export const E2E_RESULT_DEFS = [
  { key: 'e2eMarginResult', label: '端到端余量', unit: 'dB', tip: '各段独立解调，端到端余量取所有段余量的最小值' },
  { key: 'systemAvailabilityResult', label: '系统可用度', unit: '%', tip: '各星地跳站址可用度与各星间跳可用度之积；按各跳独立假设计算' },
  { key: 'e2eBerResult', label: '端到端 BER', unit: '', scientific: true, tip: '各段设计误码率之和' },
  { key: 'e2eDelayResult', label: '端到端时延', unit: 'ms' },
  { key: 'propDelayResult', label: '传播时延', unit: 'ms' },
  { key: 'interruptionMinutes', label: '年中断时长', unit: 'min' },
  { key: 'interruptionHours', label: '年中断时长（小时）', unit: 'h' },
  { key: 'totalDistanceResult', label: '全链路总距离', unit: 'km' },
  { key: 'hopCount', label: '总跳数', unit: '' }
]
export const E2E_DEFAULT_RESULT_KEYS = ['e2eMarginResult', 'systemAvailabilityResult', 'e2eBerResult', 'e2eDelayResult']

const numeric = (v) => v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const superscripts = { '⁻': '-', '⁺': '+', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' }
export function systemBerValue(v) {
  return numeric(String(v ?? '').replace(/×10([⁻⁺⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_, exp) => 'e' + [...exp].map((c) => superscripts[c]).join('')))
}
export function e2eSystemResultData(data) {
  if (!data) return null
  const out = {}
  for (const def of E2E_RESULT_DEFS) out[def.key] = def.scientific ? systemBerValue(data[def.key]) : numeric(data[def.key])
  const distances = (data.hops || []).map((hop) => numeric(hop.distanceResult))
  out.totalDistanceResult = distances.length && distances.every((v) => v !== null) ? Number(distances.reduce((a, b) => a + b, 0).toFixed(2)) : null
  return out
}

// Reconcile the result with this calculation's exact hop inputs before any view or report consumes it.
// In particular, an RF/laser hop's specified availability must not disappear in a backend echo.
export function reconcileChainAvailability(data, chain) {
  if (!data || !Array.isArray(data.hops) || !data.hops.length) return data
  const avails = data.hops.map((hop) => numeric(hop.availabilityResult))
  let changed = false
  const hops = data.hops.map((hop, i) => {
    if (hop.type !== 'isl' && hop.type !== 'laser') return hop
    const input = chain?.hops?.[hop.index ?? i]
    if (!input) return hop
    const raw = input.availability
    const value = raw == null || String(raw).trim() === '' ? 100 : numeric(raw)
    if (value == null || value < 0 || value > 100) return hop
    // 回显只有五位小数；修复旧回包时，乘积仍须使用本次输入的完整精度。
    avails[i] = value
    if (numeric(hop.availabilityResult) !== Number(value.toFixed(5))) changed = true
    return { ...hop, availabilityResult: value.toFixed(5) }
  })
  // 正确回包的汇总由引擎用未舍入值计算，不能再用逐跳显示值反算覆盖它。
  if (!changed && ['systemAvailabilityResult', 'interruptionMinutes', 'interruptionHours'].every((key) => numeric(data[key]) !== null)) return { ...data, hops }
  if (avails.some((v) => v == null || v < 0 || v > 100)) return { ...data, hops }
  const availability = avails.reduce((product, v) => product * v / 100, 100)
  const format = (key, value, dp) => value.toFixed(Math.max(dp, Math.min(13, String(data[key] ?? '').split('.')[1]?.length || 0)))
  return {
    ...data, hops,
    systemAvailabilityResult: format('systemAvailabilityResult', availability, 5),
    interruptionMinutes: format('interruptionMinutes', (100 - availability) / 100 * 365.25 * 24 * 60, 2),
    interruptionHours: format('interruptionHours', (100 - availability) / 100 * 365.25 * 24, 2)
  }
}
