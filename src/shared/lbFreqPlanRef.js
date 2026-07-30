// 链路预算 ← 频率计划「引用」（渲染端 ESM，GSO / NGSO / 再生式共用）。
//
// 引用做的事：卫星配置里选定「频率计划 → 转发器 C5」，把这条转发器的
//   上行频率 · 上行极化 · 下行频率 · 下行极化 · 转发器带宽
// 直接填进卫星表单并锁住（可解锁覆盖），另把转发器自带的 SFD/G-T/IBO/OBO/C-IM 一并带过去（填了才带）。
// 与 frequencyBand 预设自动填频率、GRD 天线自动回填 EIRP/G-T 是同一个范式，只是数据源换成了频率计划。
//
// 口径咽喉在 freqPlanModel.channelToLinkFields —— 链路预算认哪几项、单位怎么换，只在那一处定义，
// 这里只负责取数、筛选与写入。

import { normalizePlan, resolveAll, channelByNo, channelToLinkFields } from './freqPlanModel.js'

const api = typeof window !== 'undefined' ? window.api : null

/** 频率计划索引（轻量，供下拉列表用） */
export async function listPlans() {
  try { return (api?.freqPlan?.list ? await api.freqPlan.list() : []) || [] } catch { return [] }
}

/** 取一份计划全文（已规范化） */
export async function getPlan(id) {
  if (!id) return null
  try {
    const p = api?.freqPlan?.get ? await api.freqPlan.get(id) : null
    return p ? normalizePlan(p) : null
  } catch { return null }
}

/**
 * 计划下的转发器下拉项。只列 kind='transponder' 的——信标/遥测遥控不承载业务载波，
 * 让它们出现在「这条链路走哪个转发器」的下拉里只会误选。
 */
export function transponderOptions(plan) {
  if (!plan) return []
  return resolveAll(plan)
    .filter((r) => r.kind === 'transponder' && r.no)
    .map((r) => ({
      no: r.no,
      label: `${r.no}　${r.up ? fmt(r.up.fc) : '—'}${r.up?.pol ? ' ' + r.up.pol : ''} / ${r.dn ? fmt(r.dn.fc) : '—'}${r.dn?.pol ? ' ' + r.dn.pol : ''}　${Number.isFinite(r.up?.bw) ? r.up.bw + ' MHz' : ''}`,
      resolved: r
    }))
}
const fmt = (mhz) => (Number.isFinite(mhz) ? (mhz / 1000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + ' GHz' : '—')

/** 链路预算表单里由频率计划托管的字段——引用生效时这几项灰显锁定 */
export const MANAGED_KEYS = ['centerFrequency', 'uplinkPolarization', 'rxCenterFrequency', 'downlinkPolarization', 'transponderBandwidth']

/**
 * 把某转发器应用到卫星表单。
 * @returns { ok, applied:{key:value}, error }
 */
export function applyChannel(form, plan, channelNo) {
  if (!form || !plan) return { ok: false, error: '无频率计划' }
  const ch = channelByNo(plan, channelNo)
  if (!ch) return { ok: false, error: `计划中没有转发器 ${channelNo}` }
  const fields = channelToLinkFields(plan, ch)
  const applied = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue
    // 表单字段一律是字符串（与手填的输入框同类型，避免下游 parseFloat 遇到 number 又遇到 string）
    form[k] = String(v)
    applied[k] = form[k]
  }
  return { ok: true, applied }
}

/**
 * 校验「这条链路的载波」是否放得进所引用的转发器。只出数值，不下文字结论。
 * @param linkForm 链路行（含 occupiedBandwidth 之类的结果字段）或基带配置
 * @returns [{ code, msg, nums }]
 */
export function checkAgainstChannel(plan, channelNo, { occBwMHz, fcMHz, polUp, polDn } = {}) {
  const out = []
  if (!plan || !channelNo) return out
  const ch = channelByNo(plan, channelNo)
  if (!ch) return out
  const r = resolveAll(plan).find((x) => x.id === ch.id)
  if (!r) return out
  const bw = r.up?.bw ?? r.dn?.bw
  if (Number.isFinite(occBwMHz) && Number.isFinite(bw) && occBwMHz > bw + 1e-6) {
    out.push({ code: 'bwOver', msg: `载波占用带宽 ${round(occBwMHz)} MHz > 转发器 ${r.no} 带宽 ${round(bw)} MHz`, nums: { occBwMHz, bw } })
  }
  if (Number.isFinite(fcMHz) && r.up && Number.isFinite(r.up.f1)) {
    const half = Number.isFinite(occBwMHz) ? occBwMHz / 2 : 0
    if (fcMHz - half < r.up.f1 - 1e-6 || fcMHz + half > r.up.f2 + 1e-6) {
      out.push({ code: 'outOfBand', msg: `载波 ${round(fcMHz - half)}~${round(fcMHz + half)} MHz 越出转发器 ${r.no} 的 ${round(r.up.f1)}~${round(r.up.f2)} MHz`, nums: { f1: r.up.f1, f2: r.up.f2 } })
    }
  }
  if (polUp && r.up && r.up.pol !== polUp) out.push({ code: 'polUp', msg: `上行极化 ${polUp} 与转发器 ${r.no} 的 ${r.up.pol} 不一致` })
  if (polDn && r.dn && r.dn.pol !== polDn) out.push({ code: 'polDn', msg: `下行极化 ${polDn} 与转发器 ${r.no} 的 ${r.dn.pol} 不一致` })
  return out
}
const round = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v)
