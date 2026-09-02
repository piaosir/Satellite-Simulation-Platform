// 「取一颗真星」的公共口径 —— 端到端链路预算窗口（E2eSatPanel）与应用场景仿真的
// 卫星选择器（components/SatPicker.vue）共用同一份，两处不各写一遍。
//
// 这里只放【逻辑】不放版式：两个窗口的样式体系不同（端到端那套 sp-f / sp-l 是
// lbworkbench.css 里的密排读数行，主窗口没有加载那份），把整个组件搬过去会散架；
// 而真正不能写两遍的是「搜索池怎么搜、选中的星怎么变成轨道 spec、回显哪几个字段」——
// 这三件一旦两处不一致，同一颗星在两个窗口里就会解出不同的几何。
//
// 搜索池本身在 ngso/satSearchPool.js：CelesTrak active 全域 ∪ 常用名组（GPS/GLONASS/
// Galileo/北斗/GEO/Iridium/O3b/Globalstar）∪ 本地自定义卫星 ∪ 本地自定义星座。
// 「全量、含自定义」是那一份池子保证的，本模块不另建。

import { findPoolByNorad } from '../ngso/satSearchPool.js'
import { classifyOrbit, orbitRegimeLabel } from './orbitClass.js'
import { geoSlotOfOmm } from './geoSlot.js'

const MU = 398600.4418, RE = 6378.137

/** 平均角速度（圈/日）→ 圆轨道高度（km）。给不出返回 null */
export function altFromMeanMotion(revDay) {
  const n = (Number(revDay) || 0) * 2 * Math.PI / 86400
  return n > 0 ? Math.cbrt(MU / (n * n)) - RE : null
}

/** 池记录 → 轨道 spec（喂 buildSatrec 的那个）。自定义星座是六根数，其余走 OMM */
export function orbitFromPoolRec(rec) {
  if (!rec) return null
  if (rec.orbitType === 'elements' && rec.elements) {
    const e = rec.elements
    return {
      type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0,
      raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0,
      epoch: rec.epoch || null, noradId: rec.noradId
    }
  }
  return {
    type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion,
    ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma,
    bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot
  }
}

/**
 * 卫星/天线树的一个节点 → 轨道 spec。
 * 带 NORAD 号的先回搜索池反解真实根数（这样树里那颗星与搜索里那颗星是同一条轨道）；
 * 反解不出就如实返回 unresolved 并给出原因 —— 绝不按「大概是个 LEO」兜底。
 */
export async function orbitFromTreeNode(node) {
  if (!node) return null
  const kind = node.kind || ''
  if (node.noradId != null) {
    const rec = await findPoolByNorad(node.noradId)
    if (rec) return orbitFromPoolRec(rec)
    return { type: 'unresolved', noradId: node.noradId, reason: `关联星（NORAD ${node.noradId}）暂未在星历库解析到轨道（可能离线或本地缓存缺失）。请联网后在「从星历搜索」按 NORAD 重选，或改用手动轨道高度+倾角。` }
  }
  if (node.omm && node.omm.meanMotion) return Object.assign({ type: 'omm' }, node.omm)
  const el = node.elements
  if (el && el.altKm != null) {
    return {
      type: 'elements', altKm: Number(el.altKm), ecc: Number(el.ecc) || 0, incl: Number(el.incl) || 0,
      raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0,
      epoch: node.epoch || null, noradId: node.noradId
    }
  }
  if ((kind === 'preset' || kind === 'custom' || !kind) && node.altKm != null) {
    return { type: 'snapshot', lonDeg: Number(node.lon) || 0, latDeg: Number(node.lat) || 0, altKm: Number(node.altKm) || 0, noradId: node.noradId }
  }
  return { type: 'unresolved', noradId: node.noradId, reason: `卫星「${node.satName || node.folder}」缺少可用轨道根数。请在「星座3D」页为其补充轨道根数，或改用手动轨道高度+倾角。` }
}

/**
 * 选星后把轨道高度 / 倾角回显到 SAT_FIELDS 形状的 form 上（这两格随即变成只读「自动」）。
 * ★ 只写这两格：卫星 EIRP / G·T / 转发器参数一律手填（平台既定，方向图自动取值已否决）。
 */
export function applyOrbitToForm(form, orbit) {
  if (!form || !orbit) return
  if (orbit.type === 'elements') {
    if (orbit.altKm != null) form.orbitAltitude = String(Math.round(orbit.altKm))
    if (orbit.incl != null) form.orbitInclination = String(orbit.incl)
  } else if (orbit.type === 'omm') {
    const h = altFromMeanMotion(orbit.meanMotion)
    if (h != null) form.orbitAltitude = h.toFixed(0)
    if (orbit.incl != null) form.orbitInclination = String(orbit.incl)
  } else if (orbit.type === 'snapshot') {
    if (orbit.altKm != null) form.orbitAltitude = String(Math.round(orbit.altKm))
    form.orbitInclination = String(Math.abs(Number(orbit.latDeg) || 0).toFixed(2))
  }
}

/** 轨道 spec → 形状读数（近/远地点、偏心率、周期、区制）。给不出返回 null */
export function orbitShapeOf(o) {
  if (!o) return null
  let a = null, e = 0
  if (o.type === 'elements') { e = Math.max(0, Math.min(0.999, Number(o.ecc) || 0)); a = (RE + (Number(o.altKm) || 0)) / (1 - e) }
  else if (o.type === 'omm') { e = Number(o.ecc) || 0; const n = (Number(o.meanMotion) || 0) * 2 * Math.PI / 86400; a = n > 0 ? Math.cbrt(MU / (n * n)) : null }
  else return null
  if (!a) return null
  const periodMin = (2 * Math.PI) / (Math.sqrt(MU / (a * a * a)) * 60)
  const perigeeKm = a * (1 - e) - RE, apogeeKm = a * (1 + e) - RE
  const regime = classifyOrbit({ aKm: a, e, inclDeg: Number(o.incl) || 0, perigeeAltKm: perigeeKm, apogeeAltKm: apogeeKm, periodMin })
  return { apogeeKm, perigeeKm, ecc: e, periodMin, elliptical: e >= 0.01, regime, regimeZh: orbitRegimeLabel(regime) }
}

/** 池记录的轨道区制（列表徽标用） */
export function regimeOfRec(r) {
  const mm = Number(r.meanMotion) || 0
  return classifyOrbit({ e: Number(r.ecc) || 0, inclDeg: Number(r.incl) || 0, perigeeAltKm: Number(r.perigeeKm), apogeeAltKm: Number(r.apogeeKm), periodMin: mm > 0 ? 1440 / mm : NaN })
}

/**
 * 池里搜。命中名称 / 别名 / NORAD 号 / 组标签；
 * ★「gps」要能搜到编目名 NAVSTAR —— active 目录里导航星用的是编目名，不特判就搜不到。
 * @param aliases 额外的中文别名表 [{ zh, en }]：搜「中星 26」命中 CHINASAT 26（场景侧的轨位目录用）
 */
export function searchPool(pool, kw, limit, aliases) {
  const q = String(kw || '').trim().toLowerCase()
  if (!pool || !q) return []
  const wantNavstar = q.includes('gps')
  // 中文别名 → 英文编目名（前缀匹配即可，编目名一律大写无歧义）
  const alias = []
  for (const a of aliases || []) {
    if (a && a.zh && a.en && String(a.zh).toLowerCase().includes(q)) alias.push(String(a.en).toLowerCase())
  }
  const cap = limit || 60
  const out = []
  for (const s of pool) {
    const nm = String(s.name || '').toLowerCase()
    const alt = String(s.altName || '').toLowerCase()
    if (nm.includes(q) || (alt && alt.includes(q)) || String(s.noradId).includes(q) ||
      (s.groupLabel && String(s.groupLabel).toLowerCase().includes(q)) ||
      (wantNavstar && (nm.includes('navstar') || alt.includes('navstar'))) ||
      alias.some((x) => nm.includes(x) || alt.includes(x))) {
      out.push(s)
      if (out.length >= cap) break
    }
  }
  return out.map((s) => ({ ...s, _regime: regimeOfRec(s), _slot: geoSlotOfOmm(s) }))
}

export default { altFromMeanMotion, orbitFromPoolRec, orbitFromTreeNode, applyOrbitToForm, orbitShapeOf, regimeOfRec, searchPool }
