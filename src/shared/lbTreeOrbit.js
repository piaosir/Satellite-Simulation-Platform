// 链路预算三窗（NGSO / 再生式 / 端到端）卫星库条目里存的轨道 spec（ngsoSat.orbit）的历元口径：送引擎前补历元、刷新时跟上场景历元。
//
// 【为什么】库条目存的是选星那一刻拍下的 spec，有两处历元会和星座3D 页对不上：
//   · 天线树「轨道根数」星：旧条目是 {type:'elements', epoch:null}（当年读的是根本不存在的 node.epoch），主进程按计算那一刻补历元 ——
//     同一颗星每算一次就在轨道上换一处。现在缺历元的一律按所选树节点的历元补（节点找不到按旧数据常量，见 treeOrbitEpoch.js），
//     与 3D 页同一颗星同一时刻同一处。
//   · 自定义星座星（候选池里 orbitType 'elements' 的合成星）：历元＝星座场景历元，按「每天更新」规则解析（resolveScenarioEpoch），
//     选星时拍下的是当天那一个 —— 次日 3D 页已换成新的场景历元，库条目还是旧的，同一颗星两处相位不同。窗口刷新卫星树时换成当前的。
//     轨道向导里地固经度 / 地方时为设计量的星座，RAAN 也随场景历元重解（customConstGen.js），拍下的 RAAN 要一起换。
// 纯 ESM、不依赖 Vue：node 可直接测（packages/core/test/treeEpochWindows.test.mjs）。
import { treeOrbitEpoch, orbitSpecWithEpoch, treeElementsSpec } from './treeOrbitEpoch.js'
import { designRaanShiftDeg } from '../viz/constellation/customConstGen.js'

/** 库条目所选的树节点：tree 模式且 folder 还在树里才有，否则 null */
export function pickedTreeNode(ns, sats) {
  if (!ns || ns.mode !== 'tree' || !ns.folder || !Array.isArray(sats)) return null
  return sats.find((s) => s && s.folder === ns.folder) || null
}

/**
 * 库条目 → 送引擎的轨道 spec：深拷贝（切断响应式代理，见 ipc-no-reactive-proxy）+ elements 型缺历元补上
 * （树来源取所选节点的历元，否则旧数据常量）。其余类型、已带历元的原样拷贝。没有 spec 返回 null。
 */
export function lbOrbitSpec(ns, sats) {
  const node = pickedTreeNode(ns, sats)
  // 选的是天线树里的轨道根数星：一律按节点【现在的】根数 + 历元出（与工作台 lbTreeNode 同一口径）——3D 页改了根数 / 历元，
  // 这一条若没赶上窗口获得焦点时的那次同步（当时它不是当前星 / 不在链路里），也不会把旧根数送进引擎
  if (node && node.elements && !node.noradId) return treeElementsSpec(node.elements, node.noradId)
  if (!ns || !ns.orbit) return null
  return orbitSpecWithEpoch(JSON.parse(JSON.stringify(ns.orbit)), node && node.elements ? treeOrbitEpoch(node.elements) : undefined)
}

/**
 * 手动圆轨道 spec（无相位）的历元钉到本批起点 t0：主进程星间端点（ngsoGeometry._islNode）圆轨道缺历元按计算那一刻补，
 * 而时窗起点走时间轴 —— 两者不同步，时间轴停着每点一次「计算」相位就漂一截。与「星间链路距离」工具（LbIslRangeTool.specOf）同口径。
 * 其余类型 / 已带历元原样返回；要钉返回新对象（不改入参）。
 */
export function pinCircularEpoch(spec, t0ISO) {
  return spec && spec.type === 'circular' && !spec.epoch && t0ISO ? { ...spec, epoch: t0ISO } : spec
}

const EL_KEYS = ['altKm', 'ecc', 'incl', 'raan', 'argp', 'ma']
/**
 * 自定义星座星的 spec 换成当前场景历元。customSats＝satSearchPool.loadCustomSats().sats（现读 localStorage，历元按当天规则解析）。
 * 认星：spec 是 elements 型且带 NORAD，customSats 里同号、六根数逐位相同的那条（星座改过参数就不再是同一颗，不动）。
 * 向导里 RAAN 随场景历元重解的星座（池记录带 epochFrame）：其余五根数逐位相同、RAAN 恰好差这段历元的 GMST / 太阳平黄经增量，
 * 才是同一颗（差得不对 = 设计改过，不动）；RAAN 连同历元一起换成当前的。
 * 例外：这类设计的近地点高度 / 偏心率 / 倾角由 SGP4 长期率反解（sgp4Mean.refineDesign，A-05）——地球同步 / Molniya 按
 * 场景历元的日月长期项重解，随历元有毫米—米级漂动；改口径前（J2 一阶式）选下的库条目与现在的解差到千分之一量级。
 * 故这三项在 RAAN 精确对上的前提下放宽到「与设计同一颗」的量级（地心距相对 1e-3、偏心率 1e-3、倾角 0.05°；
 * 校正量最大的是给倾角解高度的太阳同步，约 8e-4），并一起换成当前的。
 * 要换返回新 spec（不改入参）；不用换 / 认不出返回 null。
 */
const DRIFT_TOL = { altKm: (a) => 1e-3 * (6378.137 + Math.abs(a)), ecc: () => 1e-3, incl: () => 0.05 }
export function scenarioEpochPatch(spec, customSats) {
  if (!spec || typeof spec !== 'object' || spec.type !== 'elements' || spec.noradId == null || spec.noradId === '' || !Array.isArray(customSats)) return null
  const id = String(spec.noradId)
  const rec = customSats.find((r) => r && r.orbitType === 'elements' && String(r.noradId) === id)
  if (!rec || !rec.elements || !rec.epoch || rec.epoch === spec.epoch) return null
  const fr = rec.epochFrame
  for (const k of EL_KEYS) {
    if (fr && k === 'raan') continue
    const a = Number(rec.elements[k]) || 0, b = Number(spec[k]) || 0
    if (a === b) continue
    if (!(fr && DRIFT_TOL[k] && Math.abs(a - b) <= DRIFT_TOL[k](a))) return null
  }
  if (!fr) return { ...spec, epoch: rec.epoch }
  const raan = Number(rec.elements.raan) || 0
  const d = raan - (Number(spec.raan) || 0) - designRaanShiftDeg(fr, spec.epoch, rec.epoch)
  // 两边 RAAN 都由同一个 gstime / 平黄经式现解，残差只有浮点舍入（~1e-12°）；1e-6° 远小于任何一次手改设计
  if (!(Math.abs(((d % 360) + 540) % 360 - 180) < 1e-6)) return null
  const el = rec.elements
  return { ...spec, epoch: rec.epoch, raan, altKm: Number(el.altKm) || 0, ecc: Number(el.ecc) || 0, incl: Number(el.incl) || 0 }
}
