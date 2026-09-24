// 星座卫星精模（「考究版」）注册表：星链 / 一网 / GPS / 北斗 / 伽利略 / 格洛纳斯 / 铱星 / 全球星 / O3b / Kuiper 各型的专门造型。
//
// 2026-09-25 用户：「像 starlink oneweb GPS 北斗等比较有名的星座的卫星模型可以尽量考究一些」。
// 此前这些星在 3D 页一律落到通用外形（星链 / 一网 → 平板 LEO，GPS / 北斗 / 伽利略 → GEO 大平台的默认卫星），一眼就不对。
//
// ★ 身份：模型 id = 'param:<型号 id>'（运行时现生成、没有文件、可再分发——与参数化模板同一个 source.kind:'param'），
//   但【不进】paramTemplates 的模板目录（TEMPLATE_IDS / templateCatalog）：生成页只编辑三种布局族的 spec，精模不是 spec 能表达的，
//   金标准单测也按模板目录逐个录制。消费者按下面的 isFleetId 分辨，走 buildFleetModel 现生成：
//     3D 页 modelLayer.paramTemplate / paramInfoOf、工作台库条目（wbStore）、缩略图（modelThumbs / wbStore）、链路预算本体布局图（lbBodyLayout）。
// ★ 自动匹配：autoMatch.match 在具名 NASA 规则之后、平板星座 / GEO 缺省之前查 matchFleet（按 CelesTrak 名称，见 match.mjs）。
// ★ 各型的尺寸出处在各族文件的 facts 表里（URL + 原文），界面只在悬停里给（CLAUDE.md：不写说明文字）。
//
// 导出：
//   FLEET_IDS                    型号 id 列表（界面顺序）
//   FLEET                        { [id]: 型号定义 }（冻结）
//   isFleetId(id)                'param:<型号>' 或裸型号 id 是否精模
//   fleetModelId(id)             'param:<型号>'
//   buildFleetModel(id)          → 与 paramBus.buildTemplateModel 同形的结果（另带 template / fleet 字段）；未知 id 抛 Error(code NO_TEMPLATE)
//   fleetCatalog()               → 库条目（ModelMeta 片段，同 templateCatalog 的形状）
//   matchFleet(sat)              → {id:'param:<型号>', rule} | null（见 match.mjs）

import { createBuilder, finishModel } from './builder.mjs'
import { factUrls } from './sources.mjs'
import { matchFleet } from './match.mjs'

import { STARLINK_MODELS } from './starlink.mjs'
import { GPS_MODELS } from './gps.mjs'
import { BEIDOU_MODELS } from './beidou.mjs'
import { ONEWEB_MODELS } from './oneweb.mjs'
import { GALILEO_MODELS } from './galileo.mjs'
import { GLONASS_MODELS } from './glonass.mjs'
import { IRIDIUM_MODELS } from './iridium.mjs'
import { GLOBALSTAR_MODELS } from './globalstar.mjs'
import { O3B_MODELS } from './o3b.mjs'
import { KUIPER_MODELS } from './kuiper.mjs'

export { matchFleet }

const ALL = [...STARLINK_MODELS, ...ONEWEB_MODELS, ...KUIPER_MODELS, ...GPS_MODELS, ...BEIDOU_MODELS, ...GALILEO_MODELS, ...GLONASS_MODELS,
  ...IRIDIUM_MODELS, ...GLOBALSTAR_MODELS, ...O3B_MODELS]

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const T = {}
for (const d of ALL) {
  if (!ID_RE.test(d.id)) throw new Error(`fleet：型号 id「${d.id}」不合 param: 规则`)
  if (Object.hasOwn(T, d.id)) throw new Error(`fleet：型号 id「${d.id}」重复`)
  T[d.id] = d
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]) } return o }
export const FLEET = deepFreeze(T)
export const FLEET_IDS = Object.freeze(ALL.map((d) => d.id))

const bare = (id) => (typeof id === 'string' ? (id.startsWith('param:') ? id.slice(6) : id) : '')
/** 'param:<型号>' 或裸型号 id 是否精模。 */
export const isFleetId = (id) => Object.hasOwn(T, bare(id))
export const fleetModelId = (id) => `param:${bare(id)}`

/**
 * 现生成一颗精模。
 * @param {string} id 'param:<型号>' 或裸型号 id
 */
export function buildFleetModel(id) {
  const d = T[bare(id)]
  if (!d) { const e = new Error(`未知精模「${id}」`); e.code = 'NO_TEMPLATE'; throw e }
  const B = createBuilder(d)
  d.build(B)
  const r = finishModel(B, d)
  r.template = { id: d.id, title: d.title, titleZh: d.titleZh, needsInput: [], illustrative: d.illustrative ? d.illustrative.slice() : [], specSources: {}, warnings: r.warnings.slice() }
  r.fleet = { id: d.id, family: d.family, rev: d.rev }
  return r
}

/**
 * 生成结果的几何签名（缩略图缓存作废用：造型一改签名就变，不必逐型号记版本号）。
 * specHash + 各网格顶点 / 索引数 + 位置坐标按位抽样（每 5 个取 1 个）+ 节点矩阵 + 材质名，FNV-1a 32。
 */
export function fleetSig(r) {
  let h = 0x811c9dc5
  const mix = (x) => { h ^= (x >>> 0); h = Math.imul(h, 16777619) >>> 0 }
  for (const m of r.ir.meshes) {
    mix(m.position.length); mix(m.index.length)
    const u = new Uint32Array(m.position.buffer, m.position.byteOffset, m.position.length)
    for (let i = 0; i < u.length; i += 5) mix(u[i])
  }
  for (const n of r.ir.nodes) if (n.matrix) for (const v of n.matrix) mix(Math.round(v * 1e6))
  for (const mt of r.ir.materials) for (let i = 0; i < mt.name.length; i++) mix(mt.name.charCodeAt(i))
  return `${r.specHash}:${h.toString(16)}`
}

/**
 * 库条目（ModelMeta 片段；与 paramTemplates.templateCatalog 同形）。source.url = 第一条出处，credit 里列制造商与代表星。
 */
export function fleetCatalog() {
  return FLEET_IDS.map((id) => {
    const d = T[id]
    const urls = factUrls(d.facts)
    return {
      id: fleetModelId(id), templateId: id, title: d.title, titleZh: d.titleZh,
      kind: 'spacecraft', group: 'spacecraft', fidelity: 'parametric',
      source: { kind: 'param', url: urls[0] || '', credit: `卫星仿真平台精细建模；${d.maker}${d.basis ? '；' + d.basis : ''}`, license: 'param', redistributable: true },
      tags: ['param', 'fleet', d.family, ...(d.tags || [])], aliases: [d.title, d.titleZh, ...(d.aliases || [])].filter(Boolean), needsInput: [],
      fleet: { family: d.family, rev: d.rev, sources: urls }
    }
  })
}
