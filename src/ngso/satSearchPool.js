// NGSO「搜索卫星」候选池构建。
// 三个来源合并去重：
//   ① CelesTrak「active」全域目录（基底，~1.6 万颗）——但导航星在此组里用「编目名」
//      （GPS→NAVSTAR、GLONASS→COSMOS…），常用名搜不到；
//   ② 友好命名组（gps-ops/glo-ops/galileo/beidou/geo/iridium/o3b/globalstar）——同一颗星
//      叠加其常用名（"GPS BIIR-5 (PRN 22)"），并把 active 的编目名留作 altName 仍可搜；
//   ③ 本地自定义星座（星座3D 页 Walker 生成器，localStorage 持久化）——按经典六根数合成，
//      支持椭圆/HEO，走 buildSatrec 的 type:'elements'（与 SGP4 口径一致）。
//   ④ 本地导入的星历点序列（文件管理 / 星座栏「导入星历」的 .e / OEM / SP3）——没有根数，
//      只带一个引用 ref:{groupId,key}，取位靠插值；表几 MB，绝不进池记录与 IPC 参数。
// 统一记录 schema（供搜索显示 + 选星建 orbit spec）：
//   { name, altName?, noradId, incl, meanMotion, ecc, orbitType:'omm'|'elements'|'ephem',
//     epoch?/raan?/argp?/ma?/bstar?/mdot?/mddot? (omm), elements?{altKm,ecc,incl,raan,argp,ma} + epochFrame?'earth'|'sun' (custom),
//     ref?{groupId,key} + summary?{t0,t1,n,frame,interp} (ephem),
//     apogeeKm, perigeeKm, groupLabel, custom? }

import { fetchGroupLiveOrSup, parseOMMCsv } from '../viz/constellation/tle.js'
import { resolveScenarioEpoch } from '../viz/constellation/useCustomConstellations.js'
import { customConstSats, designFrame } from '../viz/constellation/customConstGen.js'
import sat from '../viz/constellation/satellite.js'
import { geoLonAtEpoch } from '../shared/geoSlot.js'
import { tableFrom, evalTable } from '../viz/constellation/ephemTable.js'
import { metricsFromEphem } from '../shared/satrecMetrics.js'
import { elementsMeanMotion, ommFromElements } from '../shared/sgp4Mean.js'   // 合成根数 → SGP4 Kozai 平均运动（与 3D 页 / 主进程同一口径）

const RE = 6378.137
const MU = 398600.4418
const TWO_PI = 2 * Math.PI

// 友好命名组：这些组在 active 目录里用编目名，叠加常用名让用户搜得到。
// active 里 Starlink/OneWeb/Kuiper 本就是友好名，无需重复叠加（且量大）。
const NAMED_GROUPS = ['gps', 'glonass', 'galileo', 'beidou', 'geo', 'iridium', 'o3b', 'globalstar']
// 每组友好标签（显示用徽标）
const GROUP_LABEL = {
  gps: 'GPS', glonass: 'GLONASS', galileo: 'Galileo', beidou: '北斗',
  geo: 'GEO', iridium: 'Iridium', o3b: 'O3b', globalstar: 'Globalstar'
}
const CUSTOM_KEY = 'constellation3d/customConsts'   // 与 useCustomConstellations 同键
const NORAD_BASE = 900000, NORAD_STEP = 10000

const meanMotionToA = (revDay) => {
  const n = (Number(revDay) || 0) * TWO_PI / 86400
  return n > 0 ? Math.cbrt(MU / (n * n)) : null
}
const apoPeri = (a, e) => (a ? { apogeeKm: a * (1 + e) - RE, perigeeKm: a * (1 - e) - RE } : { apogeeKm: null, perigeeKm: null })

// OMM 记录 → 池记录（保留原始 OMM 字段以原样喂 SGP4；补 apogee/perigee 供显示）
function fromOmm(s, groupLabel) {
  const e = Number(s.ecc) || 0
  const a = meanMotionToA(s.meanMotion)
  return { ...s, noradId: String(s.noradId), orbitType: 'omm', ...apoPeri(a, e), groupLabel: groupLabel || '' }
}

// 自定义星座单星（经典六根数）→ 池记录（type:'elements'）
// epoch=星座场景历元 scenarioEpoch（与星座3D 页同源、按 resolveScenarioEpoch 同规则解析）：RAAN/MA 依此历元设计，
// 必须一路透传到 buildSatrec，否则历元不一致 → 自定义星地固指向与 3D 页不一致（详见 useCustomConstellations 注释）。
// frame：向导里 RAAN 随历元重解的那类设计量（'earth' / 'sun'，customConstGen.designFrame），记作 epochFrame ——
// 库条目拍下的是选星那天的 RAAN，scenarioEpochPatch 据此认星并连 RAAN 一起换成当前的。惯性 RAAN 的不带这一项。
function fromCustom(satObj, noradId, constName, epoch, frame) {
  const el = satObj.elements || {}
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)          // a=(RE+近地点高度)/(1−e)，与 elementsToSatrec 一致
  const meanMotion = elementsMeanMotion(el)                      // 喂 SGP4 的 Kozai 值（sgp4Mean 通用口径，与建星同一份）
  return {
    name: satObj.name, noradId: String(noradId), incl: String(el.incl), meanMotion: meanMotion.toFixed(6), ecc: String(ecc),
    orbitType: 'elements', epoch: epoch || null,
    elements: { altKm: Number(el.altKm) || 0, ecc, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0 },
    ...apoPeri(a, ecc), groupLabel: '自定义 · ' + constName, custom: true,
    ...(frame ? { epochFrame: frame } : {})
  }
}

// 读本地导入的【星历点序列】组 → 池记录（orbitType 'ephem'）。
// 只读组清单里的元数据（起止 / 点数 / 插值口径），不取采样表 —— 建池时把几十 MB 的表拉过来毫无意义，
// 真要取位时各引擎按 ref 去主进程拿（见 customSats.resolveOrbitSpec）。
// 近远地点由「组清单里没有」→ 留 null：编不出来的数不许编，搜索列表那两列显示为空。
async function loadEphemSats() {
  try {
    const api = (typeof window !== 'undefined') && window.api
    if (!api || !api.omm || !api.omm.customList) return []
    const r = await api.omm.customList()
    const out = []
    for (const g of ((r && r.groups) || [])) {
      if (g.kind !== 'ephem') continue
      for (const s of (g.sats || [])) {
        // 「对应已有卫星」的星不是一颗独立的星：它是目标星的叠加星历，主进程各引擎按目标星编号自动取用
        if (s.bind) continue
        out.push({
          name: s.name, noradId: String(s.noradId), orbitType: 'ephem',
          incl: null, meanMotion: null, ecc: null,
          apogeeKm: null, perigeeKm: null,
          ref: { groupId: g.id, key: s.key },
          summary: { t0: s.t0, t1: s.t1, n: s.n, frame: s.frame, interp: s.interp },
          groupLabel: '星历 · ' + g.name, custom: true, ephem: true
        })
      }
    }
    return out
  } catch { return [] }
}

// 读本地自定义卫星库（文件管理导入的 OMM/TLE，主进程持久化为一份 OMM CSV）→ 池记录（orbitType 'omm'）。
// 与真实目录星同一 schema/同一 SGP4 通路（fromOmm → buildSatrec type:'omm'）；导入星历【保留文件内历元】，
// 与内置真实组同口径。（自建 Walker 星座才用场景历元，见 loadCustomSats。）
async function loadCustomOmmSats() {
  try {
    const api = (typeof window !== 'undefined') && window.api
    if (!api || !api.omm || !api.omm.customCsv) return []
    const raw = await api.omm.customCsv()
    const text = raw && raw.text
    if (!text) return []
    return parseOMMCsv(text).map((s) => fromOmm(s, '自定义卫星'))
  } catch { return [] }
}

// 读本地自定义星座（与星座3D 页同键、同一出口 customConstSats 生成），返回 { sats, names, epoch }
// epoch=共享场景历元：由 resolveScenarioEpoch 按「每天更新」规则解析（默认当天 08:00，当天人为改过则用人为值），
// 与 3D 页同源同规则 → 透传给每颗合成星，供 NGSO 几何按同一设计历元求解、跨窗口一致；
// 轨道向导里地固经度 / 地方时为设计量的星座按这个历元重解 RAAN（customConstGen 头注）。
export function loadCustomSats() {
  let blob = null
  try { blob = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null') } catch { return { sats: [], names: [], epoch: null } }
  if (!blob || !Array.isArray(blob.items)) return { sats: [], names: [], epoch: null }
  const epoch = resolveScenarioEpoch(blob)
  const sats = [], names = []
  let base = NORAD_BASE
  for (const c of blob.items) {
    const name = (c.name || '自定义星座').trim() || '自定义星座'
    names.push(name)
    const b = Number.isFinite(c.noradBase) ? c.noradBase : base
    let gen = []
    try { gen = customConstSats(c, epoch) } catch { gen = [] }
    const frame = designFrame(c)
    for (let i = 0; i < gen.length; i++) sats.push(fromCustom(gen[i], b + i, name, epoch, frame))
    base += NORAD_STEP
  }
  return { sats, names, epoch }
}

// 构建完整候选池。返回 { all, real, custom, customNames }（自定义排前，便于优先命中）。
export async function buildSearchPool() {
  const load = async (key, opts) => { try { const p = await fetchGroupLiveOrSup(key, opts); return (p && p.sats) || [] } catch { return [] } }

  // 基底：active 全域（编目名）——允许联网刷新（与旧行为一致，用户期望搜到最新星）
  const map = new Map()
  const activeSats = await load('active')
  for (const s of activeSats) map.set(String(s.noradId), fromOmm(s, ''))

  // 叠加友好命名组：仅为补常用名，走 cacheOnly（有缓存即用、无则跳过，绝不阻塞联网——
  // 否则某组缓存非当日会先试网络，离线时每组可卡到 90s）。常用名优先，原编目名留 altName 仍可搜。
  const named = await Promise.all(NAMED_GROUPS.map(async (g) => ({ g, sats: await load(g, { cacheOnly: true }) })))
  for (const { g, sats } of named) {
    for (const s of sats) {
      const id = String(s.noradId)
      const rec = fromOmm(s, GROUP_LABEL[g] || g.toUpperCase())
      const prev = map.get(id)
      if (prev && prev.name && prev.name !== rec.name) rec.altName = prev.name
      map.set(id, rec)
    }
  }
  // 自定义卫星库（文件管理导入的 OMM/TLE）：以用户库为准覆盖同号目录星（用户明确添加，优先级最高）。
  const customOmm = await loadCustomOmmSats()
  for (const c of customOmm) map.set(String(c.noradId), c)
  // 星历点序列另走一路：它们的合成 NORAD 在 800000 段，与目录星不会撞号，无需并进 map 去重
  const ephemSats = await loadEphemSats()
  const real = Array.from(map.values())
  const { sats: custom, names: customNames } = loadCustomSats()
  // 排序：自定义卫星（OMM 库 + Walker 星座）置顶，确保结果条数上限内先被扫到、搜得到；
  // 从 real 剔除已并入的自定义 OMM 星，避免同一颗出现两次。
  const customIds = new Set(customOmm.map((c) => String(c.noradId)))
  const realTail = real.filter((r) => !customIds.has(String(r.noradId)))
  return { all: custom.concat(ephemSats, customOmm, realTail), real, custom, customNames, ephem: ephemSats }
}

// 单例缓存：天线树选星（按 NORAD 反解真实轨道）与「搜索卫星」面板必须读**同一份**候选池，
// 否则两处各自独立拉取/叠加分组，同一颗星可能命中不同来源的 OMM 记录（如某组缓存非当日）
// → 同一颗星在两处算出不同几何，就是本函数存在的原因（曾经真实复现过）。
let _poolPromise = null
export function ensureSearchPool(force) {
  if (force) _poolPromise = null
  if (!_poolPromise) _poolPromise = buildSearchPool()
  return _poolPromise
}
// 按 NORAD 号在共享候选池里查（天线树 linked 星反解轨道用）。
export async function findPoolByNorad(noradId) {
  if (noradId == null) return null
  const res = await ensureSearchPool()
  const id = String(noradId)
  return res.all.find((r) => String(r.noradId) === id) || null
}

// ============================================================================
// 池记录 → 轨道 spec / 定点经度 —— 取星的【唯一出口】
// ============================================================================
// 各窗口选完星之后要的东西只有两样：喂 SGP4 的轨道 spec，和 GEO 的定点经度。
// 这两件都只跟池记录的形状有关，不该由每个窗口各按 orbitType 分支、各手拼一遍十三个字段。
// 手拼的代价已经实付过一次：只分「六根数 / 其余」两支的手拼把 'ephem' 型池记录（导入的点序列星）拼成全空 OMM，
// 自动最差每行报「SGP4 初始化失败（error=2）」。NGSO 窗口的取星（星历搜索 / 卫星树关联星 / 地图带星）与再生式窗口的
// 地图带星现已走这里（2026-10-16）；再生式 / 端到端的取星面板（RegenSatPanel / E2eSatPanel）仍是手拼，待收。

/** 池记录 → 轨道 spec（packages/core 的 buildSatrec / orbitSource 入参）。未知类型抛错。 */
export function orbitSpecOf(rec) {
  if (!rec) throw new Error('缺少卫星记录')
  const t = rec.orbitType || 'omm'
  if (t === 'omm') {
    return {
      type: 'omm',
      noradId: String(rec.noradId),
      epoch: rec.epoch || null,
      meanMotion: Number(rec.meanMotion),
      ecc: Number(rec.ecc) || 0,
      incl: Number(rec.incl) || 0,
      raan: Number(rec.raan) || 0,
      argp: Number(rec.argp) || 0,
      ma: Number(rec.ma) || 0,
      bstar: Number(rec.bstar) || 0,
      mdot: Number(rec.mdot) || 0,
      mddot: Number(rec.mddot) || 0
    }
  }
  // 星历点序列：只传引用，表由主进程在进 core 之前按 ref 解析（表几 MB，不许进配置文件与 IPC 参数）
  if (t === 'ephem') {
    if (!rec.ref || !rec.ref.groupId) throw new Error('星历点序列缺少引用（组已删除？）')
    return {
      type: 'ephem',
      noradId: String(rec.noradId),
      name: rec.name || '',
      ref: { groupId: rec.ref.groupId, key: rec.ref.key },
      t0: rec.summary ? rec.summary.t0 : null,
      t1: rec.summary ? rec.summary.t1 : null
    }
  }
  if (t === 'elements') {
    const el = rec.elements || {}
    return {
      type: 'elements',
      noradId: String(rec.noradId),
      epoch: rec.epoch || null,
      altKm: Number(el.altKm) || 0,
      ecc: Number(el.ecc) || 0,
      incl: Number(el.incl) || 0,
      raan: Number(el.raan) || 0,
      argp: Number(el.argp) || 0,
      ma: Number(el.ma) || 0
    }
  }
  throw new Error('未知轨道类型：' + t)
}

// ============================================================================
// 星历点序列星 → 表单回显用的轨道高度 / 倾角
// ============================================================================
// 选星后链路预算窗口的「轨道高度 / 轨道倾角」只读显示「自动」：目录星按平均运动 / 倾角回显、六根数星按根数回显；
// 点序列星没有平均根数（池记录的 meanMotion / incl 都是 null），不另取的话表单停在上一颗星的值——手动几何还拿它推
// 各行斜距。口径同星座 3D 页带星进计算窗（ConstellationMap3D 的 ephemCtxGeom）：
//   高度 = 近远地点高度均值（satrecMetrics.metricsFromEphem：整表地心距极值，表须跨满一圈）→ 周期反推半长轴 → 表首一拍的密切半长轴；
//   倾角 = 轨道面法向（metricsFromEphem）→ 表首一拍的密切倾角。取不到的项给 null（编不出来的数不许编）。
const oscOf = (pv) => {   // evalTable 的 { x,y,z,vx,vy,vz }（TEME km / km·s⁻¹）→ 密切半长轴 / 倾角
  const rn = Math.hypot(pv.x, pv.y, pv.z), v2 = pv.vx * pv.vx + pv.vy * pv.vy + pv.vz * pv.vz
  const inv = 2 / rn - v2 / MU                       // 1/a（活力公式）；≤ 0 = 不是绕地闭合轨道
  if (!(rn > 0) || !(inv > 0)) return null
  const hx = pv.y * pv.vz - pv.z * pv.vy, hy = pv.z * pv.vx - pv.x * pv.vz, hz = pv.x * pv.vy - pv.y * pv.vx, h = Math.hypot(hx, hy, hz)
  return h > 0 ? { aKm: 1 / inv, inclDeg: Math.acos(Math.max(-1, Math.min(1, hz / h))) * 180 / Math.PI } : null
}
/** 采样表（ephemTable.tableFrom 建好的）→ { altKm, inclDeg }，取不到的项为 null；不是表返回 null。纯函数。 */
export function ephemEchoFromTable(tab) {
  if (!tab || !tab.__ephem) return null
  const m = metricsFromEphem(tab) || {}
  let altKm = null
  let inclDeg = Number.isFinite(m.incl) ? m.incl : null
  if (m.apogeeKm != null && m.perigeeKm != null) altKm = (m.apogeeKm + m.perigeeKm) / 2
  else if (m.periodMin > 0) altKm = Math.cbrt(MU * Math.pow(m.periodMin * 60 / TWO_PI, 2)) - RE
  if (altKm == null || inclDeg == null) {
    const pv = evalTable(tab, tab.t0)
    const o = pv ? oscOf(pv) : null
    if (o) { if (altKm == null) altKm = o.aKm - RE; if (inclDeg == null) inclDeg = o.inclDeg }
  }
  return { altKm: Number.isFinite(altKm) && altKm > 0 ? altKm : null, inclDeg: Number.isFinite(inclDeg) ? inclDeg : null }
}
/**
 * 点序列星的轨道 spec（orbitSpecOf 出的 {type:'ephem', ref}）→ { altKm, inclDeg }。
 * 表经 omm:ephemTable 现取（几 MB，只在选星 / 重解那一下取，不进配置与 IPC 参数）；不是点序列 / 取不到表返回 null。
 */
export async function ephemOrbitEcho(spec) {
  if (!spec || spec.type !== 'ephem' || !spec.ref || !spec.ref.groupId) return null
  const api = (typeof window !== 'undefined') && window.api
  if (!api || !api.omm || !api.omm.ephemTable) return null
  let t = null
  try { t = await api.omm.ephemTable(spec.ref.groupId) } catch { return null }
  const s = ((t && t.sats) || []).find((x) => x && String(x.key) === String(spec.ref.key))
  return ephemEchoFromTable(s ? tableFrom(s) : null)
}

// 再生式 / 端到端两份卫星面板的 orbitToForm 共用：点序列星的高度 / 倾角按采样表异步回显到表单。
// 同一表单后来又换了星（另一颗点序列星，或目录星 / 六根数星——对它们调一次即作废在途回显），晚到的这次不写；
// 取不到表 / 表坏：表单不动（计算时主进程会点名报因）。NGSO 窗口按条目上的 orbit 自己核对（echoEphemOrbit），不走这里。
const _ephemEchoFor = new WeakMap()   // 表单（同一个响应式代理）→ 最近一次要回显的点序列引用
export function echoEphemToForm(form, spec) {
  if (!form || typeof form !== 'object') return
  if (!spec || spec.type !== 'ephem' || !spec.ref || !spec.ref.groupId) { _ephemEchoFor.delete(form); return }
  const key = spec.ref.groupId + '|' + spec.ref.key
  _ephemEchoFor.set(form, key)
  return ephemOrbitEcho(spec).then((e) => {
    if (!e || _ephemEchoFor.get(form) !== key) return
    _ephemEchoFor.delete(form)
    if (e.altKm != null) form.orbitAltitude = String(Math.round(e.altKm))
    form.orbitInclination = e.inclDeg != null ? String(Math.round(e.inclDeg * 100) / 100) : ''   // 表里推不出倾角就留空，不留上一颗星的
  }).catch(() => {})
}

/**
 * 池记录 → 定点经度（°，西经为负）。取不到返回 NaN（不抛）。
 * 记录自带 summary.lonDeg 时优先用它（将来的 'ephem' 型记录只带摘要，不必建 satrec）。
 */
export function slotLonOf(rec) {
  if (!rec) return NaN
  const given = rec.summary && Number(rec.summary.lonDeg)
  if (Number.isFinite(given)) return given
  try {
    const t = rec.orbitType || 'omm'
    // 点序列没有「定点经度」这个概念（它不是平均根数，也未必是 GEO）：返回 NaN，显示端留空
    if (t === 'ephem') return NaN
    if (t === 'omm') return geoLonAtEpoch(sat.omm2satrec(rec))
    if (t === 'elements') {
      // 与 buildSatrec 的 'elements' 分支同一换算（sgp4Mean.ommFromElements：平半长轴 = (RE+近地点高度)/(1−e)）
      return geoLonAtEpoch(sat.omm2satrec(ommFromElements(rec.elements || {}, rec.epoch || new Date().toISOString(), rec.noradId)))
    }
    return NaN
  } catch { return NaN }
}
