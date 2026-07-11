// NGSO「搜索卫星」候选池构建。
// 三个来源合并去重：
//   ① CelesTrak「active」全域目录（基底，~1.6 万颗）——但导航星在此组里用「编目名」
//      （GPS→NAVSTAR、GLONASS→COSMOS…），常用名搜不到；
//   ② 友好命名组（gps-ops/glo-ops/galileo/beidou/geo/iridium/o3b/globalstar）——同一颗星
//      叠加其常用名（"GPS BIIR-5 (PRN 22)"），并把 active 的编目名留作 altName 仍可搜；
//   ③ 本地自定义星座（星座3D 页 Walker 生成器，localStorage 持久化）——按经典六根数合成，
//      支持椭圆/HEO，走 buildSatrec 的 type:'elements'（与 SGP4 口径一致）。
// 统一记录 schema（供搜索显示 + 选星建 orbit spec）：
//   { name, altName?, noradId, incl, meanMotion, ecc, orbitType:'omm'|'elements',
//     epoch?/raan?/argp?/ma?/bstar?/mdot?/mddot? (omm), elements?{altKm,ecc,incl,raan,argp,ma} (custom),
//     apogeeKm, perigeeKm, groupLabel, custom? }

import { fetchGroupLiveOrSup } from '../viz/constellation/tle.js'
import { generateConstellation } from '../viz/constellation/walker.js'
import { resolveScenarioEpoch } from '../viz/constellation/useCustomConstellations.js'

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
function fromCustom(satObj, noradId, constName, epoch) {
  const el = satObj.elements || {}
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)          // a=(RE+近地点高度)/(1−e)，与 elementsToSatrec 一致
  const meanMotion = 86400 * Math.sqrt(MU / (a * a * a)) / TWO_PI
  return {
    name: satObj.name, noradId: String(noradId), incl: String(el.incl), meanMotion: meanMotion.toFixed(6), ecc: String(ecc),
    orbitType: 'elements', epoch: epoch || null,
    elements: { altKm: Number(el.altKm) || 0, ecc, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0 },
    ...apoPeri(a, ecc), groupLabel: '自定义 · ' + constName, custom: true
  }
}

// 读本地自定义星座（与星座3D 页同键、同 walker 生成逻辑），返回 { sats, names, epoch }
// epoch=共享场景历元：由 resolveScenarioEpoch 按「每天更新」规则解析（默认当天 08:00，当天人为改过则用人为值），
// 与 3D 页同源同规则 → 透传给每颗合成星，供 NGSO 几何按同一设计历元求解、跨窗口一致。
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
    try { gen = generateConstellation(c.params || {}) } catch { gen = [] }
    for (let i = 0; i < gen.length; i++) sats.push(fromCustom(gen[i], b + i, name, epoch))
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
  const real = Array.from(map.values())
  const { sats: custom, names: customNames } = loadCustomSats()
  return { all: custom.concat(real), real, custom, customNames }
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
