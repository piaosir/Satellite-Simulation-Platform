// 天线树「轨道根数」星的历元（node.elements.epoch，ISO UTC 串带 Z）：全软件拿树节点根数建 satrec 的唯一口径。
//
// 【为什么】树节点的六根数原来不带历元，各处各编一个：3D 页取页面加载那一刻（每次切回页面都变）、模型工作台取解析那一刻、
//   NGSO / 再生式 / 端到端读一个根本不存在的 node.epoch、最后由主进程按计算那一刻补 —— 同一颗星同一个时刻，几个窗口各在轨道上一处。
//   现在历元跟着节点存（新建 = 时间轴当前时刻，可在弹窗里改），各星的历元可以不同；推演一律在同一条绝对时间轴上（场景时刻）。
// 旧节点没有历元：一律按 TREE_ORBIT_LEGACY_EPOCH 读（固定常量，不取「此刻」——取此刻就又成了每个窗口 / 每次会话各一个），
//   3D 页恢复树时把它写进节点存盘（useGrdCoverage 的迁移），之后各窗口读到的都是节点自己的历元。
// 纯 ESM、不依赖 Vue / satellite.js：node 可直接测（packages/core/test/treeOrbitEpoch.test.mjs）。
import { epochMs } from './epochMs.js'

export const TREE_ORBIT_LEGACY_EPOCH = '2026-01-01T00:00:00.000Z'
const RE = 6378.137, MU = 398600.4418

/** 历元串（带不带 Z、±hh:mm 偏移、毫秒数）→ 规范 ISO（带 Z）；解不出返回 null。不带时区的串按 UTC（同 omm2satrec / epochMs） */
export function normEpoch(v) {
  const ms = typeof v === 'number' ? v : epochMs(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
/** 树节点根数的历元：节点自己的（规范化）> 旧数据常量 */
export function treeOrbitEpoch(el) {
  return normEpoch(el && el.epoch) || TREE_ORBIT_LEGACY_EPOCH
}
/** 根数对象补齐 / 规范化历元：已是规范串原样返回同一个对象（缓存签名不翻）；否则返回带 epoch 的新对象。null / 非对象原样返回 */
export function withTreeEpoch(el) {
  if (!el || typeof el !== 'object') return el
  const ep = treeOrbitEpoch(el)
  return el.epoch === ep ? el : { ...el, epoch: ep }
}
/** 节点根数需不需要迁移（没有历元或历元不规范） */
export function needsTreeEpoch(el) {
  return !!(el && typeof el === 'object' && el.epoch !== treeOrbitEpoch(el))
}

/**
 * 经典六根数（altKm = 近地点高度）→ omm2satrec 的入参。与 3D 页 elementsToSatrec、工作台 satrecFromElements、
 * 主进程 ngsoGeometry.buildSatrec 的 elements 分支同一算式：e 夹 [0, 0.999]，a = (RE + 近地点高度)/(1 − e)，n = √(μ/a³)。
 */
export function elementsOmm(el, noradId) {
  const e = el || {}
  const ecc = Math.max(0, Math.min(0.999, Number(e.ecc) || 0))
  const a = (RE + (Number(e.altKm) || 0)) / (1 - ecc)
  const meanMotion = 86400 * Math.sqrt(MU / (a * a * a)) / (2 * Math.PI)
  return {
    noradId: noradId == null || noradId === '' ? 'SIM' : String(noradId), epoch: treeOrbitEpoch(e), meanMotion, ecc,
    incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0,
    bstar: 0, mdot: 0, mddot: 0
  }
}
/** 树节点根数 → 链路预算的轨道 spec（{type:'elements', …, epoch}，主进程 buildSatrec 认它） */
export function treeElementsSpec(el, noradId) {
  const e = el || {}
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return { type: 'elements', altKm: num(e.altKm), ecc: num(e.ecc), incl: num(e.incl), raan: num(e.raan), argp: num(e.argp), ma: num(e.ma), epoch: treeOrbitEpoch(e), noradId: noradId == null || noradId === '' ? null : noradId }
}
/**
 * 库条目里存的轨道 spec 兜底补历元（旧条目 epoch: null）：elements 型且没有 / 解不出历元 → 给 fallback（缺省旧数据常量）；
 * 其它类型与已有历元的原样返回同一个对象。不改入参。
 */
export function orbitSpecWithEpoch(spec, fallback) {
  if (!spec || typeof spec !== 'object' || spec.type !== 'elements') return spec
  const ep = normEpoch(spec.epoch)
  if (ep && ep === spec.epoch) return spec
  return { ...spec, epoch: ep || normEpoch(fallback) || TREE_ORBIT_LEGACY_EPOCH }
}
