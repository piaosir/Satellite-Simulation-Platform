// 应用场景仿真 · 平台卫星库的读写与解析（渲染端）。
//
// ============ 为什么共用端到端窗口那份库 ============
// 一期把卫星做成模块库的 A 类条目，20 颗星写死在数据文件里 —— 用户想用 AsiaSat 7 /
// Starlink / 北斗 / 自己导入的星就没辙，NGSO 还只有「圆轨道高度 + 最低仰角」的闭式最差几何。
// 二期改成引用【平台卫星库】：library.json 的命名空间 'e2e' 里那个 sat[]，与端到端链路预算
// 窗口是同一份。一条卫星定义一次，两个工作台都用得上；轨道来源（GSO 定点经度 / NGSO 手填 /
// 从星历搜索一颗真星）也照抄那一套，用户不用学第二套。
//
// ★ 命名空间为兼容不改叫 'e2e'（界面上一律叫「卫星库」）：改名等于让所有已存的库条目指空。
//
// ============ 并发写库（已知边界，写在这里而不是靠记）============
// 两个窗口都可能写 library.json['e2e']。本模块一律「读 → 只改 sat 数组 → 写」，
// es / carrier / seq 原样带回，故不会把对方的地球站库整份抹掉。但两窗【同时】改卫星库时，
// 仍然是「最后写入者赢」—— 这是有意接受的边界（库条目量级只有几十条，且两窗同时改同一条
// 卫星的场景极少）。两边都在 window focus 时重读一次，把窗口失去焦点期间对方的改动收进来。

import { SAT_FIELDS, defaultsFor, orbitSpecOf, blankNgsoSat, normNgsoSat } from '../../e2e/e2eParams.js'

export const LIB_NS = 'e2e'
const api = () => (typeof window !== 'undefined' && window.api) || {}
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))

/** 一条卫星库条目的空壳（字段默认值与端到端窗口逐字同源） */
export function blankSatEntry(id, name) {
  return { id, name: name || '', nameAuto: false, form: { ...defaultsFor(SAT_FIELDS) }, ngsoSat: blankNgsoSat() }
}

// ★ presetKey 必须随库落盘：模板与老存档按它认「这颗预置星已经建过条目了」。
//   落不下去的后果是每次打开场景都新建一条 —— 库里很快堆出十几个「中星 26 号」。
//   端到端窗口不认识这个字段，原样带着即可（它整份读写自己那几个键）。

/** 归一：库里读回来的条目可能缺字段（老库 / 手改过的 json），补齐再用 */
export function normSatEntry(c, i) {
  return {
    id: (c && c.id) || ('satb' + (i + 1)),
    name: (c && c.name) || '',
    nameAuto: !!(c && c.nameAuto),
    form: { ...defaultsFor(SAT_FIELDS), ...((c && c.form) || {}) },
    ngsoSat: normNgsoSat(c && c.ngsoSat),
    presetKey: (c && c.presetKey) || ''
  }
}

/** 整份库（含 es / carrier / seq）。读不到返回 null —— 上层要区分「没有库」和「库是空的」 */
export async function readWholeLibrary() {
  const st = api().store
  if (!st || !st.getLibrary) return null
  try { return await st.getLibrary(LIB_NS) } catch { return null }
}

/**
 * 只改 sat 数组写回。★ 必须走「读 → 改 → 写」：整份覆盖会把端到端窗口的地球站库
 * （同一命名空间下的 es[]）连同 seq 一起抹掉。
 * @returns { ok, error }
 */
export async function writeSatList(list) {
  const st = api().store
  if (!st || !st.saveLibrary) return { ok: false, error: '当前环境没有库存储' }
  try {
    const cur = (await readWholeLibrary()) || {}
    const sat = (list || []).map((c) => ({ id: c.id, name: c.name || '', nameAuto: !!c.nameAuto, form: clone(c.form), ngsoSat: normNgsoSat(c.ngsoSat), presetKey: c.presetKey || '' }))
    // seq.sat 只增不减：两窗各自递增，取大的那个，新建条目的 id 才不会撞上对方刚建的
    const seq = Object.assign({ es: 1, sat: 1 }, cur.seq || {})
    seq.sat = Math.max(seq.sat || 1, maxSatSeq(sat) + 1)
    await st.saveLibrary(LIB_NS, Object.assign({}, cur, { sat, seq }))
    return { ok: true, error: '' }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

/** 条目 id 形如 'sat12'，取最大序号（新建时从这里往后排） */
export function maxSatSeq(list) {
  let n = 0
  for (const c of list || []) {
    const m = /^sat(\d+)$/.exec(String((c && c.id) || ''))
    if (m) n = Math.max(n, +m[1])
  }
  return n
}

/** 该条目最终交给几何求解器的轨道 spec（与端到端窗口同一函数，口径逐位一致） */
export const satOrbitSpec = (entry) => (entry ? orbitSpecOf(entry) : null)

// ═══════════════════════════════════════════════════════════════════════════
// core/utils/sceneSat.js 的渲染端镜像
// ═══════════════════════════════════════════════════════════════════════════
// core 是 CommonJS，浏览器侧进不来（平台既有做法：镜像一份，两边手工同步）。
// ★ scene.test.mjs 有一条对拍断言把下面这张表与 core 的那张逐条钉在一起 ——
//   频段 → 空口介质错一条，就是「画得出、算出来的却是另一个频段」。
export const BAND_MEDIUM = {
  UHF: 'sat_uhf', L: 'sat_l', S: 'sat_s', C: 'sat_c', ExtC: 'sat_c', X: 'sat_x',
  Ku: 'sat_ku', ExtKu: 'sat_ku', 'Ku-BSS': 'sat_ku', K: 'sat_ka', Ka: 'sat_ka', Q: 'sat_q', V: 'sat_v'
}
export const satMedium = (band) => BAND_MEDIUM[String(band == null ? '' : band).trim()] || null

/** 卫星节点的端口：空口一个（按工作频段）；NGSO 另给星间微波 / 星间激光两个 */
export function satPorts(form) {
  const f = form || {}
  const band = f.frequencyBand || 'Ku'
  const out = [{ key: 'rf', zh: band + ' 空口', medium: satMedium(band) || 'sat_ku', dir: 'trx', role: 'data' }]
  if ((f.orbitClass || 'GSO') !== 'GSO') {
    out.push({ key: 'isl', zh: '星间微波', medium: 'isl_rf', dir: 'trx', role: 'data' })
    out.push({ key: 'islo', zh: '星间激光', medium: 'isl_laser', dir: 'trx', role: 'data' })
  }
  return out
}

/** 给了 SFD 就是透明转发（与 core 的 payloadKindOf 同判据） */
export const payloadKindOf = (sat) => ((sat && sat.sfdRef != null && sat.sfdRef !== '') ? 'txp' : 'regen')

/** 深合并（只合对象、数组整体替换）—— 与 core 的 merge 同口径 */
function deepMerge(dst, src) {
  if (src == null) return dst
  if (Array.isArray(src) || typeof src !== 'object') return clone(src)
  const out = (dst && typeof dst === 'object' && !Array.isArray(dst)) ? Object.assign({}, dst) : {}
  for (const k of Object.keys(src)) out[k] = deepMerge(out[k], src[k])
  return out
}

/**
 * 库条目 + 实例覆盖 → 场景里那一条已解析的卫星节点（形状与 core 的 resolveSatNode 同构）。
 * @param entry 卫星库条目（{ id, name, form, ngsoSat }）
 * @param inst  场景实例（{ id, name, satId, ov }）
 */
export function resolveSatNode(entry, inst) {
  const form = (entry && entry.form) || {}
  const sat = deepMerge(clone(form), (inst && inst.ov && inst.ov.sat) || null)
  return {
    id: (entry && entry.id) || '',
    instId: (inst && inst.id) || '',
    kind: 'sat', cat: 'A',
    satId: (inst && inst.satId) || (entry && entry.id) || '',
    name: (inst && inst.name) || (entry && entry.name) || sat.satelliteName || '卫星',
    zh: (entry && entry.name) || sat.satelliteName || '卫星',
    sat,
    ports: satPorts(sat),
    place: { mode: 'orbit' },
    payloadKind: payloadKindOf(sat),
    orbit: satOrbitSpec(entry),
    symbol: (sat.orbitClass || 'GSO') === 'GSO' ? 'tabler:satellite' : 'lucide:satellite'
  }
}

/** 条目摘要：GSO 报轨位，NGSO 报选中星名或高度/倾角 */
export function satBrief(entry) {
  if (!entry) return ''
  const f = entry.form || {}
  if ((f.orbitClass || 'GSO') === 'GSO') {
    const lon = parseFloat(f.orbitLongitude)
    const slot = isFinite(lon) ? `${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}` : '—'
    return `${slot} · ${f.frequencyBand || ''}`
  }
  const ns = entry.ngsoSat || {}
  if (ns.mode !== 'manual' && ns.name) return `${ns.name} · ${f.frequencyBand || ''}`
  return `${f.orbitAltitude || '—'} km / ${f.orbitInclination || '—'}° · ${f.frequencyBand || ''}`
}

export default { LIB_NS, blankSatEntry, normSatEntry, readWholeLibrary, writeSatList, satOrbitSpec, satBrief, maxSatSeq }
