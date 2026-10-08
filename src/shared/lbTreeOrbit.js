// 链路预算三窗（NGSO / 再生式 / 端到端）卫星库条目里存的轨道 spec（ngsoSat.orbit）的历元口径：送引擎前补历元、刷新时跟上场景历元。
//
// 【为什么】库条目存的是选星那一刻拍下的 spec，有两处历元会和星座3D 页对不上：
//   · 天线树「轨道根数」星：旧条目是 {type:'elements', epoch:null}（当年读的是根本不存在的 node.epoch），主进程按计算那一刻补历元 ——
//     同一颗星每算一次就在轨道上换一处。现在缺历元的一律按所选树节点的历元补（节点找不到按旧数据常量，见 treeOrbitEpoch.js），
//     与 3D 页同一颗星同一时刻同一处。
//   · 自定义星座星（候选池里 orbitType 'elements' 的合成星）：历元＝星座场景历元，按「每天更新」规则解析（resolveScenarioEpoch），
//     选星时拍下的是当天那一个 —— 次日 3D 页已换成新的场景历元，库条目还是旧的，同一颗星两处相位不同。窗口刷新卫星树时换成当前的。
// 纯 ESM、不依赖 Vue：node 可直接测（packages/core/test/treeEpochWindows.test.mjs）。
import { treeOrbitEpoch, orbitSpecWithEpoch, treeElementsSpec } from './treeOrbitEpoch.js'

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
 * 要换返回新 spec（不改入参）；不用换 / 认不出返回 null。
 */
export function scenarioEpochPatch(spec, customSats) {
  if (!spec || typeof spec !== 'object' || spec.type !== 'elements' || spec.noradId == null || spec.noradId === '' || !Array.isArray(customSats)) return null
  const id = String(spec.noradId)
  const rec = customSats.find((r) => r && r.orbitType === 'elements' && String(r.noradId) === id)
  if (!rec || !rec.elements || !rec.epoch || rec.epoch === spec.epoch) return null
  for (const k of EL_KEYS) if ((Number(rec.elements[k]) || 0) !== (Number(spec[k]) || 0)) return null
  return { ...spec, epoch: rec.epoch }
}
