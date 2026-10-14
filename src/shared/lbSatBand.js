// NGSO / 再生式工作台「卫星」分区横带的读数（GSO 那份见 LinkBudgetApp 的 satFacts）。
//
// 三窗同构：定义列表式三行（左栏名 + 右内容，行间发丝线），配置 / 频率 / 轨道。原先 NGSO / 再生式
// 把频率、极化、取星来源、轨道高度拼成一串 mono 摘要塞在星名后面，窄栏下整串被省略号截掉——
// 拆成读数族（.lbx-kv）各占一项，换行而不截断。
// 返回 { freq: [...], orbit: [...] }，每项 { key, label, value, unit, tight, tip }。
const show = (v) => ((v === '' || v == null) ? '—' : String(v))

export function ngsoSatBandFacts(c, srcLabel) {
  if (!c) return { freq: [], orbit: [] }
  const f = c.form || {}
  const ns = c.ngsoSat || {}
  const freq = []
  if (f.frequencyBand) freq.push({ key: 'band', label: '频段', value: f.frequencyBand, unit: '' })
  freq.push({ key: 'fUp', label: '上行', value: show(f.centerFrequency), unit: 'GHz', tip: '上行中心频率（GHz）' })
  freq.push({ key: 'fDn', label: '下行', value: show(f.rxCenterFrequency), unit: 'GHz', tip: '下行中心频率（GHz）' })
  freq.push({ key: 'pol', label: '极化', value: `${show(f.uplinkPolarization)}/${show(f.downlinkPolarization)}`, unit: '', tip: '上行 / 下行极化' })
  const picked = ns.mode !== 'manual' && !!ns.orbit
  const orbit = [{ key: 'src', label: '来源', value: picked ? ((srcLabel && srcLabel[ns.mode]) || '选星定轨') : '手动轨道', unit: '' }]
  if (picked && ns.noradId) orbit.push({ key: 'norad', label: 'NORAD', value: String(ns.noradId), unit: '' })
  if (f.orbitAltitude !== '' && f.orbitAltitude != null) orbit.push({ key: 'alt', label: '轨道高度', value: String(f.orbitAltitude), unit: 'km' })
  if (f.orbitInclination !== '' && f.orbitInclination != null) orbit.push({ key: 'inc', label: '轨道倾角', value: String(f.orbitInclination), unit: '°', tight: true })
  return { freq, orbit }
}
