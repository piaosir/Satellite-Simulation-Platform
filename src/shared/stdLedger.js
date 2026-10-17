// 标准台账的读取口（纯 ESM，渲染端与 Node 测试同用）。
//
// 台账本体是 packages/core/data/standards.json：标准编号、版本、实现条款、数据版本、ValEx 状态。
// 两份交付报告的参考文献都从这里出，不再各自硬编码一张表：
//   · 链路预算报告「引用建议书与标准」—— lbReport.methodology → reportRefGroups
//   · 服务等级指标报告「引用标准」     —— lbSlaReport.slaRefs → slaRefList
// 口径（与 lbReport 方法学章节同一条）：只列【本次计算实际用到的方法】，版本写引擎实现的那一版；
// 用途一栏按条款现拼（只拼本体制真走到的条款：§8 只在 NGSO / 再生式出现）。没实现的、没用到的、
// 没核实的不进报告（台账里照样记着，report 缺键即可）。

import LEDGER from '../../packages/core/data/standards.json' with { type: 'json' }

export const STANDARDS = LEDGER.standards
export const STD_GROUPS = LEDGER.groups
const byId = new Map(STANDARDS.map((s) => [s.id, s]))
export const stdById = (id) => byId.get(id) || null

// 链路预算报告里各组的先后
const LB_GROUP_ORDER = ['prop', 'reg', 'orbit', 'air']

/**
 * 链路预算报告的「用到了哪些」条件。
 * @param ctx { orbitType 'GEO'|'NGSO'|'REGEN'|'E2E', regenModes [..], used }
 *   used = 各链路载波 / 引擎出参归纳出的使用情况（lbReport.usedStandards）：
 *          { dvbS2, dvbS2x, rcs2, nr, nbiot, airborne }；缺省（null）= 不知道载波 —— 按改前口径列
 *          DVB-S2 / S2X 与 3GPP 两族（RCS2 与机载按「没用到」处理，宁少不多）。
 */
export function lbConditions(ctx) {
  const c = ctx || {}
  const ot = c.orbitType || 'GEO'
  const modes = Array.isArray(c.regenModes) ? c.regenModes : []
  const u = c.used || null
  return {
    // 有星地跳才有大气传播：再生式只装了星间 / 激光模块时整组传播不出
    ground: ot !== 'REGEN' || modes.some((m) => m === 'uplink' || m === 'downlink'),
    // RR Art.21 落地 PFD 限值：GSO / NGSO 引擎的下行出参（详细预算「ITU PFD 限值」那一行）；再生式只在装了下行模块时有；
    // 端到端的级联台账不出这一行
    pfd: ot === 'GEO' || ot === 'NGSO' || (ot === 'REGEN' && modes.includes('downlink')),
    orbit: ot === 'NGSO' || ot === 'REGEN' || ot === 'E2E',
    airborne: !!(u && u.airborne),
    dvbS2: u ? !!u.dvbS2 : true,
    dvbS2x: u ? !!u.dvbS2x : true,
    rcs2: !!(u && u.rcs2),
    nr: u ? !!u.nr : true,
    nbiot: u ? !!u.nbiot : true
  }
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
// 印在报告里的编号：label（字符串，或按语言分的 { zh, en }），缺省即 id
const printedId = (s, lang) => (!s.label ? s.id : typeof s.label === 'string' ? s.label : (lang === 'en' ? s.label.en : s.label.zh) || s.id)
/** 用途一栏：本体制走到的条款，「§2.2 雨衰；§2.4.1 …」 */
export function useText(s, orbitType, lang) {
  const en = lang === 'en'
  const parts = (s.clauses || [])
    .filter((c) => !c.only || c.only.includes(orbitType))
    .map((c) => {
      const ref = en ? (c.refEn || c.ref) : c.ref
      const txt = en ? c.en : c.zh
      return ref ? ref + ' ' + txt : txt
    })
  return en ? cap(parts.join('; ')) : parts.join('；')
}

/**
 * 链路预算报告的参考文献（分组）。形状与改前 methodology().refGroups 相同：[{ group, items: [{ id, title, use }] }]。
 * @param ctx 同 lbConditions
 */
export function reportRefGroups(ctx, lang) {
  const en = lang === 'en'
  const cond = lbConditions(ctx)
  const ot = (ctx && ctx.orbitType) || 'GEO'
  const out = []
  for (const g of LB_GROUP_ORDER) {
    const items = STANDARDS
      .filter((s) => s.group === g && s.report && s.report.lb && cond[s.report.lb])
      .map((s) => ({ id: printedId(s, lang), title: en ? s.title.en : s.title.zh, use: useText(s, ot, lang) }))
    if (items.length) out.push({ group: en ? STD_GROUPS[g].en : STD_GROUPS[g].zh, items })
  }
  return out
}

/**
 * SLA 报告的引用标准（一张平表）：传播那几项恒有；月口径才有 P.841；有 DVB / NTN 链路才有各自的标准；
 * 可用度与差错指标的口径基准恒有。
 * @param o { monthly, hasDvb, hasNtn }
 */
export function slaRefList(o, lang) {
  const en = lang === 'en'
  const opt = o || {}
  const cond = { always: true, monthly: !!opt.monthly, dvb: !!opt.hasDvb, ntn: !!opt.hasNtn }
  // 次序：传播 → 月口径 → DVB → NTN → 指标口径基准（与改前 lbSlaReport 的 REFS 分组同序）
  const rank = (s) => (s.group === 'prop' ? 0 : s.report.sla === 'monthly' ? 1 : s.report.sla === 'dvb' ? 2 : s.report.sla === 'ntn' ? 3 : 4)
  return STANDARDS
    .filter((s) => s.report && s.report.sla && cond[s.report.sla])
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => ({
      id: printedId(s, lang),
      title: en ? s.title.en : s.title.zh,
      use: s.sla ? (en ? s.sla.en : s.sla.zh) : useText(s, '', lang)
    }))
}
