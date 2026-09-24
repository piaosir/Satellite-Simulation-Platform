// 天线树里的「同步轨道定点星」→ 星座条目（node 可直接测：packages/core/test/treeGeo.test.mjs）。
//
// 树里「固定经纬度」的星原来只是一个空间点（覆盖源点），星座里没有它：点不中、聚焦不了、跟随不了、挂不上模型。
// 现在凡高度落在同步轨道带的定点星（isTreeGeoNode，与 shared/orbitClass 的 GEO / IGSO 同一口径），都在星座里生成一颗真卫星：
//   · 身份：合成 NORAD（TREE_GEO_NORAD_BASE 段，按 folder 散列，见 treeGeoIds）；树节点本身不改（不写 noradId ——
//     链路预算各窗口照旧当定点星用，NGSO 窗口按号去目录反解会落空）。模型 / 姿态 / 挂点的本体身份 = grdsat:<folder>，
//     与树上 GRD 天线同一份（二期契约 D8），页面的 satKeyOf 按 _grdFolder 认。
//   · 取位：钉在定点上 —— rec.__fix 带地固系位置，satPos.posAt 见到它就按「TEME = Rz(−GMST)·r、速度 = ω⊕ × r」出位置，
//     与覆盖源点（W.geodeticToEcef(lon, lat, alt)）逐位同一点，任何时刻都不离位。
//     ★ 不走 SGP4/SDP4 推演：合成的静止根数按无控 GEO 自由漂移（实测 1 个月 0.3–0.9°、1 年几十度，历元处还有 0.02° 的短周期偏置），
//       与树上的定点对不上 —— 受控 GEO 的定点语义只能由「钉住」来表达。
//   · 读数：同一个 rec 也是一份 GEO 平根数 satrec（近圆、倾角 = |纬度|、半长轴 = 地心距），只供信息栏根数 / 区制 / 定点标注 /
//     模型自动匹配用；定点标注按节点经度直接给（不取 SDP4 历元经度）。历元只是读数参考（REF_EPOCH），不上信息栏（见页面 epochMsOf）。
import sat from '../constellation/satellite.js'
import { geodeticToEcef } from '../wgs84.js'
import { classifyOrbit, fmtGeoSlot } from '../../shared/orbitClass.js'

export const TREE_GEO_NORAD_BASE = 1700000   // 合成号段：目录星 < 34 万、点序列 800000 段、自定义星座 900000 段、向导预览 1800000 段
const TREE_GEO_SPAN = 90000
export const TREE_GEO_GROUP = 'grdtree'       // 不以 cc 开头：按真实时刻轴（calcAt）取位，与合成星座的场景历元轴无关
export const TREE_GEO_LABEL = '卫星天线树'

const RE = 6378.137, MU = 398600.4418, DEG = Math.PI / 180
// 读数用根数的历元：当天 0 时 UTC（同一天内重建不变）。取位不用它；但这颗星若被存进卫星组、再按根数导出 / 发到小程序，
// 下游是拿这份根数用 SGP4 推的 —— 历元贴近此刻，导出前后几天内都落在定点附近（取 J2000 会推出几十年的无控漂移）
const REF_EPOCH = new Date(Math.floor(Date.now() / 864e5) * 864e5).toISOString()
const idOf = (v) => (v == null || v === '' ? '' : String(v))

// 定点星（固定经纬度：custom 固定 / preset 预置）且高度落在同步轨道带（GEO 或 IGSO：周期在恒星日 ±2% 内）。
// 关联星（有号）/ 轨道根数星 / 仰角线一律不是。
export function isTreeGeoNode(n) {
  if (!n || n.kind === 'elevline' || idOf(n.noradId) || n.elements) return false
  const alt = Number(n.altKm), lat = Number(n.lat) || 0
  if (!Number.isFinite(alt) || !Number.isFinite(Number(n.lon))) return false
  const k = classifyOrbit({ aKm: RE + alt, e: 0, inclDeg: Math.abs(lat) })
  return k === 'GEO' || k === 'IGSO'
}

// FNV-1a 32 位（folder 字符串 → 散列）
function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
// 定点同步星 → 合成号（folder → 号串）。按 folder 散列进号段；撞号按 folder 字典序先到先得、后到的顺延 ——
// 与树序（拖动 / 插入会变）无关，同一组 folder 永远分到同一组号。
export function treeGeoIds(nodes) {
  const out = new Map(), used = new Set()
  const folders = (nodes || []).filter(isTreeGeoNode).map((n) => String(n.folder)).sort()
  for (const f of folders) {
    if (out.has(f)) continue
    let k = fnv1a(f) % TREE_GEO_SPAN
    while (used.has(k)) k = (k + 1) % TREE_GEO_SPAN
    used.add(k)
    out.set(f, String(TREE_GEO_NORAD_BASE + k))
  }
  return out
}

// 定点 → 读数用的 GEO 平根数 satrec，挂上 __fix（取位用）与定点标注。
// 半长轴要与定点地心距逐位一致（信息栏 a / 近远地点高度就读它）：omm2satrec 吃的是 Kozai 平均运动，SGP4 初始化时
// 按 J2 换成 Brouwer 半长轴，直接按开普勒给会差 ~1 km —— 故按 rec.a 反馈迭代平均运动（两三步收到 1e-12）。
export function treeGeoRec(node, id) {
  const lon = Number(node.lon), lat = Number(node.lat) || 0, alt = Number(node.altKm)
  const r = geodeticToEcef(lon, lat, alt)
  const rad = Math.hypot(r[0], r[1], r[2])
  const g = sat.gstime(new Date(REF_EPOCH)) / DEG
  const mk = (meanMotion) => sat.omm2satrec({
    noradId: idOf(id), epoch: REF_EPOCH, meanMotion, ecc: 0, incl: Math.abs(lat), raan: 0, argp: 0,
    ma: (((lon + g) % 360) + 360) % 360,   // 真经度 = 星下点经度 + 历元 GMST（只进读数）
    bstar: 0, mdot: 0, mddot: 0
  })
  // 目标：信息卡口径 RE + (近地点 + 远地点)/2 = rad，即 (rec.a − 1)·RE = rad − RE（RE = 6378.137，见 satrecMetrics）
  const aWant = 1 + (rad - RE) / RE
  let mm = 86400 * Math.sqrt(MU / (rad * rad * rad)) / (2 * Math.PI)   // rev/day：开普勒初值
  let rec = mk(mm)
  for (let k = 0; k < 6 && Number.isFinite(rec.a) && Math.abs(rec.a - aWant) > 1e-13; k++) { mm *= Math.pow(rec.a / aWant, 1.5); rec = mk(mm) }
  rec.__fix = { r, lon, lat, altKm: alt }
  rec._geoSlot = classifyOrbit({ aKm: RE + alt, e: 0, inclDeg: Math.abs(lat) }) === 'GEO' ? fmtGeoSlot(lon) : ''   // geoSlotOfSatrec 的缓存位
  return rec
}

const sigOf = (n) => `${n.satName}|${Number(n.lon)}|${Number(n.lat) || 0}|${Number(n.altKm)}`

// 按树重建条目表。cache：folder → 条目（跨调用复用同一个对象 —— 选中集 / 跟随 / 聚焦几何 Worker 都按对象同一性认星，
// 节点改了经纬度 / 名字就【就地】换 name / rec，对象不换）。返回 { list, byId, gone }：
//   list 按树序；byId：号串 → 条目；gone：这一轮从表里掉了的条目（节点删了 / 改成非同步高度 / 关联上了星座）
export function syncTreeGeoEntries(nodes, cache) {
  const ids = treeGeoIds(nodes)
  const list = [], byId = new Map(), keep = new Set()
  for (const n of nodes || []) {
    const id = n && ids.get(String(n.folder))
    if (!id) continue
    const f = String(n.folder)
    keep.add(f)
    let e = cache.get(f)
    const sig = sigOf(n)
    if (!e) {
      e = { name: n.satName, noradId: Number(id), group: TREE_GEO_GROUP, groupLabel: TREE_GEO_LABEL, _grdFolder: f, _sig: sig, rec: treeGeoRec(n, id) }
      cache.set(f, e)
    } else if (e._sig !== sig || String(e.noradId) !== id) {
      e.name = n.satName; e.noradId = Number(id); e._sig = sig; e.rec = treeGeoRec(n, id)
    }
    list.push(e); byId.set(id, e)
  }
  const gone = []
  for (const [f, e] of cache) if (!keep.has(f)) { gone.push(e); cache.delete(f) }
  return { list, byId, ids, gone }
}
