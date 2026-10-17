// 自定义星座 → 合成星：全软件唯一出口。3D 页（useCustomConstellations 的 build / customConstellationsToOmmRecords）、
// NGSO / 再生式 / 端到端 / 模型工作台（satSearchPool.loadCustomSats）、干扰分析（useInterference.readCustomConsts）同走这里 ——
// 同一场景历元下，同一颗合成星在各窗口是同一组根数。纯 ESM、不依赖 Vue（lbTreeOrbit 认星也用，node 可直接测）。
//
// 【为什么要按场景历元重解】合成星 satrec 的历元恒为场景历元，而场景历元每天回到当天 08:00（resolveScenarioEpoch）。
// 轨道向导里 RAAN 由地固经度 / 地方时定的类型（orbitDesign.RAAN_FRAME 的 'earth' / 'sun'），建星时按 GMST / 太阳平黄经
// 折成惯性 RAAN 存进 params.raan0 —— 只对建星那天的历元成立。历元每前移一天，GMST(08:00) 与太阳平黄经各多走 0.9856°：
// 地固类星下点每天西漂 0.9856°（110.5°E → 次日 109.5°E、30 天 80.9°E），日固类 LTAN 每天提前 3.9 min（10:30 → 30 天后 08:32）。
// 故这两类按【传入的场景历元】由 design 输入现解；圆轨道 / 自定义根数 / 没有 design 的老存档与纯 Walker 用存下的 params，
// RAAN 仍是惯性量（语义不变）。
import sat from './satellite.js'
import OD from './orbitDesign.js'
import { generateConstellation } from './walker.js'

const RAD = 180 / Math.PI
// 历元：ISO 串 / 毫秒 / Date → 毫秒（坏值 NaN）
const msOf = (ep) => (typeof ep === 'number' ? ep : ep instanceof Date ? ep.getTime() : Date.parse(ep))

/** 星座配置里 RAAN 随历元走的那类设计量：'earth' | 'sun'；RAAN 是惯性输入 / 没有 design → null */
export function designFrame(c) {
  const d = c && c.design
  const f = d && typeof d === 'object' ? OD.RAAN_FRAME[d.type] : null
  return f === 'earth' || f === 'sun' ? f : null
}

/**
 * 星座配置在场景历元 epoch 下的生成参数（generateConstellation 的入参）。
 * 地固 / 日固设计量的类型按 epoch 重解（布局 pattern/T/P/F、星名前缀沿用存下的 params）；其余原样返回 c.params。
 * 解不出来（坏存档）退回存下的 params。epoch：ISO 串 / 毫秒 / Date。
 */
export function customConstParams(c, epoch) {
  const p = (c && c.params) || {}
  if (!designFrame(c)) return p
  const ms = msOf(epoch)
  if (!Number.isFinite(ms)) return p
  let s = null
  // GMST 与 3D 页向导读数（constSolved）同一个 gstime、同一时刻 → 同一历元下两边逐位相同；
  // sgp4 = 渲染端 satellite.js：回归 / 太阳同步 / 地球同步 / Molniya 的目标按 SGP4 长期率校正到严格成立（sgp4Mean.refineDesign）
  try { s = OD.solveDesign(c.design.type, c.design.inputs || {}, ms, { gmst: sat.gstime(new Date(ms)), sgp4: sat }) } catch { s = null }
  if (!s || !s.ok || !s.seed) return p
  return { ...p, ...OD.seedToParams(s.seed, { pattern: p.pattern, T: p.T, P: p.P, F: p.F }, p.name) }
}

/** 星座配置在场景历元 epoch 下的合成星（generateConstellation 的出参 [{ name, plane, slot, elements }]） */
export function customConstSats(c, epoch) {
  return generateConstellation(customConstParams(c, epoch))
}

/**
 * 同一份设计、历元 from → to 时 RAAN 的增量（°，折到 (−180, 180]——角度只认模 360）：'earth' = GMST 的增量，
 * 'sun' = 太阳平黄经的增量，其余 0。供认星（lbTreeOrbit.scenarioEpochPatch）：其余根数逐位相同、RAAN 恰好差这一段的，
 * 才是「星座没改过」的同一颗。取不到 NaN。
 */
export function designRaanShiftDeg(frame, from, to) {
  const a = msOf(from), b = msOf(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN
  let d = 0
  if (frame === 'earth') d = (sat.gstime(new Date(b)) - sat.gstime(new Date(a))) * RAD
  else if (frame === 'sun') d = OD.meanSunLongitudeDeg(b) - OD.meanSunLongitudeDeg(a)
  d = ((d % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}
