// 可编程波束地图 · 覆盖库来源：文件管理「波束地图管理」页把库里的波束（不经 3D 页绘制）交给脚本。
//
// 输入是库里逐个波束读出的归一化数据（coverage:get / coverageGxt:get 的 { lon, bore, contours:[{g,p}] }，
// 加上树上的卫星名 / 频段 / 波束名 / 类型），输出是 model.js buildBeamMap 认的原始件（只有 library）。
// 库里的波束没有「屏上颜色」：按 3D 页新建批次的缺省「渐变」配色补上 —— 同一卫星同一类型的波束共用一条色标
//（3D 页一个批次就是同星同类型的一组波束），电平最低蓝、最高红。

const clamp01 = (v) => Math.max(0, Math.min(1, v))
// HSL(蓝→红) → #rrggbb，与 ConstellationMap3D.vue 的 gainHex 同式
export function gainRampHex(t) {
  const h = (1 - clamp01(t)) * 240 / 360, s = 0.9, l = 0.55, a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
}

/**
 * beams: [{ satName, lon, band, beam, type, bore, contours:[{g,p}] }]（树上的顺序）
 * meta:  { title, version, simTime, lang }
 */
export function libraryBeamMapRaw(beams, meta = {}) {
  const range = new Map()
  const keyOf = (b) => `${String(b.satName || '').toLowerCase()}|${b.type || 'EIRP'}`
  for (const b of beams) {
    const k = keyOf(b)
    const r = range.get(k) || { lo: Infinity, hi: -Infinity }
    for (const c of (b.contours || [])) if (Number.isFinite(c.g)) { if (c.g < r.lo) r.lo = c.g; if (c.g > r.hi) r.hi = c.g }
    range.set(k, r)
  }
  const library = beams.map((b) => {
    const r = range.get(keyOf(b))
    return {
      satName: b.satName || '', lon: b.lon, band: b.band || '', beam: b.beam || '', type: b.type || 'EIRP', bore: b.bore || [],
      contours: (b.contours || []).map((c) => ({ g: c.g, p: c.p, color: gainRampHex(r.hi > r.lo ? (c.g - r.lo) / (r.hi - r.lo) : 1) }))
    }
  })
  return { library, meta: { ...meta, scope: 'library' } }
}
