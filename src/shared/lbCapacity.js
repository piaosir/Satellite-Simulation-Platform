// 链路预算「容量汇总」（GSO / NGSO / 再生式 三窗共用的纯逻辑；界面在 components/LbCapDialog.vue）。
//
// 2026-10-16 起从链路表表脚搬进独立弹窗（功能区「导出 › 容量」），口径重做——表脚那一行有三处站不住：
//   ① 卫星「逐链路指定」用了多颗星时，功率带宽跨转发器相加。功率带宽 = 功率占用 × 本转发器带宽，两只
//      转发器的份额分母不同，加起来不对应任何一只转发器的功带平衡（与高级计算「一组＝一只转发器」同一前提）；
//   ② 一行按一路载波计。同一条前向载波按不同收端建了几行，带宽与容量就被重复计入几次；
//   ③ 只有合计，不对照可用资源：看不到每只转发器还剩多少带宽、多少功率。
//
// —— 账本的单位＝一只转发器（GSO / NGSO：一份卫星配置；再生式：模块 × 卫星）——
// 体例照运营商的传输计划：Eutelsat Transmission Plan 的 Tx Plan Resources（已分配 / 剩余的功率与带宽，
// 都以 MHz 计）、Intelsat LST 租用汇总（Total BW allocated / PEB / available / margin）。每组：
//   小计  Σ载波数、Σ容量、Σ载波带宽、Σ功率带宽（逐行 × 载波数）
//   可用  可用带宽（缺省＝转发器带宽，即整只转发器）、可用功率（缺省＝可用带宽：功率份额与所租带宽成正比）
//   剩余  可用 − 小计（带宽、功率各一列，同以带宽计、可直接相减）
//   占用  小计 / 可用
//   结算带宽 = max(Σ载波带宽, Σ功率带宽)——两条约束里先用完的那条。与 SLA「结算带宽」逐链路同式，这里按组取：
//            一组载波共用一段转发器资源，前向超发 / 返向欠发在组内互相抵
//   年费 = 单价（万元/MHz/年）× 结算带宽；单位容量成本 = 年费 / Σ容量（万元/Mbps/年）
// 表末合计只加【能跨转发器相加】的量：容量、载波带宽、结算带宽、年费。功率带宽不跨组求和。
//
// —— 三个体制的功率带宽（opts.pbw）——
//   'sum'  GSO：组内求和，出可用功率 / 剩余功率 / 功率占用；
//   'list' NGSO：只逐行列出、组内不求和——每行取的是各自的最差时刻，加起来不对应任何同一时刻的状态，
//          NGSO 也不按功率等效带宽售卖（docs/高级计算仪器级改造.md §2.5，NGSO 窗据此删了高级计算）；
//          结算带宽 = Σ载波带宽；逐行的功率占用按整只转发器折算（没有「可用功率」这一说）；
//   'none' 再生式：星上解调再调制，不占转发器功率（引擎回显的 PowerBWResult 是占位转发器参数算出来的），
//          整列不出；转发器带宽同为占位值，故可用带宽没有缺省，要用户自己填（opts.availDefault = false）。
//
// —— 自定义（都存在场景里，随场景与分享包走）——
//   逐链路 row.cap = { off?: true, n?: 整数 ≥ 2 }：off＝不列入（重复建的收端行、备选方案行）；n＝这一行代表
//          几路同型载波（20 个同型 VSAT 站建一行 × 20）。缺省（列入、1 路）不落盘。
//          ★ 只在本模块里生效：链路表 09-07 随 CnC 回退删掉的「路数」列不恢复，高级计算的组账仍是一行一路。
//   场景级 capParams.tp[组键] = { bwKHz?, pwKHz?, price? }：可用带宽 / 可用功率（kHz，与引擎出参同基准）、
//          单价（万元/MHz/年）。组键见 capKeySat / capKeyMode / capKeyIsl。
import { pickUnit } from './adaptUnits.js'

export const CAP_PBW = Object.freeze({ SUM: 'sum', LIST: 'list', NONE: 'none' })
const N_MAX = 1000000

const fin = (v) => {
  if (v === null || v === undefined || v === '') return NaN
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : NaN
}

// —— 组键（转发器身份）——
// 卫星 id 里不会有「:」「>」（'sat' + 流水号 / 分享包派生的 id），故前缀与连接符可以直接拼、拆
export const capKeySat = (satId) => String(satId || '')
export const capKeyMode = (mode, satId) => `${mode}:${satId || ''}`
export const capKeyIsl = (txId, rxId) => `isl:${txId || ''}>${rxId || ''}`

// ============ 逐链路设置 row.cap ============
export function normRowCap(c) {
  if (!c || typeof c !== 'object') return null
  const out = {}
  if (c.off === true) out.off = true
  const n = Math.round(fin(c.n))
  if (Number.isFinite(n) && n >= 2) out.n = Math.min(n, N_MAX)
  return Object.keys(out).length ? out : null
}
// 落到行上：现造纯对象。行是响应式的，嵌套对象从行上浅拷出去是 Vue 的 Proxy，过不了 IPC 的结构化克隆
//（saveConfig 当场抛「保存失败」，见 applyRowSla 同一条）；缺省值不落盘，整键删掉。
export function applyRowCap(row, c) {
  if (!row) return row
  const v = normRowCap(c)
  if (v) row.cap = v
  else delete row.cap
  return row
}
export const capIncluded = (c) => !(c && c.off === true)
export function capCount(c) { const v = normRowCap(c); return v && v.n ? v.n : 1 }
export const setCapIncluded = (c, on) => normRowCap({ ...(c || {}), off: !on })
export const setCapCount = (c, n) => normRowCap({ ...(c || {}), n })

// ============ 场景级参数 capParams ============
function normCapTp(e) {
  if (!e || typeof e !== 'object') return null
  const out = {}
  const bw = fin(e.bwKHz), pw = fin(e.pwKHz), pr = fin(e.price)
  if (bw > 0) out.bwKHz = bw
  if (pw > 0) out.pwKHz = pw
  if (pr >= 0) out.price = pr
  return Object.keys(out).length ? out : null
}
export function normCapParams(p) {
  const tp = {}
  const src = (p && typeof p === 'object' && p.tp && typeof p.tp === 'object') ? p.tp : {}
  for (const k of Object.keys(src)) { const e = normCapTp(src[k]); if (e) tp[k] = e }
  return { tp }
}
// 就地改一组的一项（params 是宿主的 reactive）。value 为 null / 非法即清掉这一项——回到缺省
export function setCapTpParam(params, key, field, value) {
  if (!params || !key) return
  if (!params.tp || typeof params.tp !== 'object') params.tp = {}
  const e = normCapTp({ ...(params.tp[key] || {}), [field]: value })
  if (e) params.tp[key] = e
  else delete params.tp[key]
}
// 分享包导入：组键里的卫星 id 换成对端库里的 id；有一颗换不过去（对端没收这颗星），这组设置就不要了。
// 空位（再生式手动几何的星间组 'isl:>'，两端本就无身份）原样保留。
export function remapCapParams(params, satMap) {
  const src = normCapParams(params).tp
  const tp = {}
  for (const k of Object.keys(src)) {
    const m = /^((?:[a-z]+:)?)(.*)$/.exec(k)
    const to = m[2].split('>').map((id) => (id === '' ? '' : ((satMap && satMap[id]) || null)))
    if (to.some((v) => v === null)) continue
    tp[m[1] + to.join('>')] = src[k]
  }
  return { tp }
}

// ============ 汇总模型 ============
/**
 * @param {Array} items 逐链路一条（宿主从链路行 + 上一次计算结果现造）：
 *   { no, rowId, name, carrier, gkey, gname, tpBwMHz, ok, error, capKbps, bwKHz, pbwKHz, cap }
 *   capKbps / bwKHz / pbwKHz 是【单路】载波的容量 / 载波带宽 / 功率带宽；tpBwMHz＝引擎回显的转发器带宽；
 *   cap＝行上的 row.cap。
 * @param {object} params 场景级 capParams
 * @param {object} opts { pbw: 'sum' | 'list' | 'none', availDefault: 可用带宽是否缺省取转发器带宽（再生式 false）}
 * @returns {{ pbw, groups, total, counts }}
 *   groups 按首次出现的次序；total 只在 ≥ 2 组时给（一组时合计就是那一组）；
 *   counts = { all, on: 列入且算出结果, off: 不列入, failed: 列入但没有结果 }
 */
export function buildCapModel(items, params, opts = {}) {
  const pbw = (opts.pbw === CAP_PBW.LIST || opts.pbw === CAP_PBW.NONE) ? opts.pbw : CAP_PBW.SUM
  const availDefault = opts.availDefault !== false
  const tpOf = (k) => (params && params.tp && params.tp[k]) || null
  const map = new Map()
  const counts = { all: 0, on: 0, off: 0, failed: 0 }
  for (const it of items || []) {
    if (!it) continue
    counts.all++
    const key = String(it.gkey == null ? '' : it.gkey)
    let g = map.get(key)
    if (!g) {
      g = { key, name: it.gname || '', tpBwMHz: null, rows: [], n: 0, capKbps: 0, bwKHz: 0, pbwKHz: pbw === CAP_PBW.SUM ? 0 : null }
      map.set(key, g)
    }
    const tb = fin(it.tpBwMHz)
    if (!(g.tpBwMHz > 0) && tb > 0) g.tpBwMHz = tb
    const on = capIncluded(it.cap)
    const n = capCount(it.cap)
    const ok = !!it.ok
    const cap = fin(it.capKbps), bw = fin(it.bwKHz), pb = pbw === CAP_PBW.NONE ? NaN : fin(it.pbwKHz)
    const r = {
      no: it.no, rowId: it.rowId, name: it.name || '', carrier: it.carrier || '',
      on, n, ok, error: ok ? '' : (it.error || ''),
      capKbps: ok && Number.isFinite(cap) ? cap * n : null,
      bwKHz: ok && Number.isFinite(bw) ? bw * n : null,
      pbwKHz: ok && Number.isFinite(pb) ? pb * n : null,
      bwPct: null, pwPct: null
    }
    g.rows.push(r)
    if (!on) { counts.off++; continue }
    if (!ok) { counts.failed++; continue }
    counts.on++
    g.n += n
    if (r.capKbps != null) g.capKbps += r.capKbps
    if (r.bwKHz != null) g.bwKHz += r.bwKHz
    if (pbw === CAP_PBW.SUM && r.pbwKHz != null) g.pbwKHz += r.pbwKHz
  }
  const groups = [...map.values()]
  for (const g of groups) finishGroup(g, tpOf(g.key), pbw, availDefault)
  let total = null
  if (groups.length > 1) {
    total = { groups: groups.length, n: 0, capKbps: 0, bwKHz: 0, billKHz: 0, feeWan: 0, effBpsHz: null, unitCostWan: null }
    let anyFee = false, allFee = true
    for (const g of groups) {
      total.n += g.n
      total.capKbps += g.capKbps
      total.bwKHz += g.bwKHz
      total.billKHz += g.billKHz
      if (g.feeWan != null) { total.feeWan += g.feeWan; anyFee = true } else if (g.n > 0) allFee = false
    }
    // 有一组列入了载波却没给单价，合计年费就只是部分之和——不报，免得读成整网的费用
    if (!anyFee || !allFee) total.feeWan = null
    total.effBpsHz = total.bwKHz > 0 ? total.capKbps / total.bwKHz : null
    total.unitCostWan = total.feeWan != null && total.capKbps > 0 ? total.feeWan / (total.capKbps / 1000) : null
  }
  return { pbw, groups, total, counts }
}

function finishGroup(g, tp, pbw, availDefault) {
  const tpKHz = g.tpBwMHz > 0 ? g.tpBwMHz * 1000 : null
  g.availBwDef = availDefault ? tpKHz : null                 // 留空时的取值（输入框占位）
  g.availBwUser = !!(tp && tp.bwKHz > 0)
  g.availBwKHz = g.availBwUser ? tp.bwKHz : g.availBwDef
  if (pbw === CAP_PBW.SUM) {
    g.availPwDef = g.availBwKHz                              // 功率份额与所租带宽成正比
    g.availPwUser = !!(tp && tp.pwKHz > 0)
    g.availPwKHz = g.availPwUser ? tp.pwKHz : g.availPwDef
  } else {
    g.availPwDef = null; g.availPwUser = false; g.availPwKHz = null
  }
  g.remBwKHz = g.availBwKHz != null ? g.availBwKHz - g.bwKHz : null
  g.remPwKHz = (pbw === CAP_PBW.SUM && g.availPwKHz != null) ? g.availPwKHz - g.pbwKHz : null
  g.bwPct = g.availBwKHz > 0 ? g.bwKHz / g.availBwKHz * 100 : null
  g.pwPct = (pbw === CAP_PBW.SUM && g.availPwKHz > 0) ? g.pbwKHz / g.availPwKHz * 100 : null
  // 逐行的占用：GSO 对着本组的可用资源；NGSO 只逐行列功率，没有可用功率，按整只转发器折算
  const pwRef = pbw === CAP_PBW.SUM ? g.availPwKHz : (pbw === CAP_PBW.LIST ? tpKHz : null)
  for (const r of g.rows) {
    r.bwPct = (r.bwKHz != null && g.availBwKHz > 0) ? r.bwKHz / g.availBwKHz * 100 : null
    r.pwPct = (r.pbwKHz != null && pwRef > 0) ? r.pbwKHz / pwRef * 100 : null
  }
  g.effBpsHz = g.bwKHz > 0 ? g.capKbps / g.bwKHz : null       // kbps / kHz = bps/Hz（带宽加权）
  g.billKHz = pbw === CAP_PBW.SUM ? Math.max(g.bwKHz, g.pbwKHz) : g.bwKHz
  g.price = (tp && tp.price >= 0) ? tp.price : null
  g.feeWan = g.price != null ? g.price * g.billKHz / 1000 : null
  g.unitCostWan = (g.feeWan != null && g.capKbps > 0) ? g.feeWan / (g.capKbps / 1000) : null
}

// ============ 显示 ============
// 档位：整张表的带宽类数（逐行 / 小计 / 可用 / 剩余 / 结算）共选一档、容量一档——同一列上下要能直接比，
// 小载波不能因为与转发器同列就被压成 0.075。功能区「单位」档锁定（出厂）时恒为引擎基准 kHz / kbps。
export function capUnits(model, adaptive) {
  const bws = [], caps = []
  const push = (arr, ...vs) => { for (const v of vs) if (v != null && Number.isFinite(v)) arr.push(Math.abs(v)) }
  for (const g of (model && model.groups) || []) {
    for (const r of g.rows) { push(bws, r.bwKHz, r.pbwKHz); push(caps, r.capKbps) }
    push(bws, g.bwKHz, g.pbwKHz, g.availBwKHz, g.availPwKHz, g.remBwKHz, g.remPwKHz, g.billKHz)
    push(caps, g.capKbps)
  }
  if (model && model.total) { push(bws, model.total.bwKHz, model.total.billKHz); push(caps, model.total.capKbps) }
  const pick = (vals, base) => {
    if (!adaptive || !vals.length) return { unit: base, f: 1 }
    const p = pickUnit(Math.max(...vals), base)
    return p ? { unit: p.unit, f: p.factor } : { unit: base, f: 1 }
  }
  return { bw: pick(bws, 'kHz'), cap: pick(caps, 'kbps') }
}
// 定点小数；舍入后为 0 的负数写 0（−0.0004 不印成「-0.000」）；缺值印「—」
export function capFx(v, d) {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = v.toFixed(d)
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s
}
export const CAP_DEC = Object.freeze({ bw: 3, cap: 3, pct: 2, eff: 3, fee: 2, unitCost: 3 })

// ============ 报告块 ============
// 报告「容量汇总」一节（三份文件同一张表，主进程照排、不另算）：参数做行、转发器做列（≥ 2 组时末列合计）——
// 与 §1「逐参数对照」同一种矩阵，逐链路的速率 / 带宽 / 功率带宽已在那张表里，这里只出转发器级的账。
// 标签按报表语言出好、数按单位档格式化好。首行「链路」写成员的报告编号：noOf(rowId) 由导出流程给
//（再生式分节时全篇 #N 连续编号，本节从几号起只有它知道）；不给 noOf 就不出这一行。
export function capReportBlock(model, { lang = 'zh', adaptive = false, noOf = null } = {}) {
  if (!model || !model.groups || !model.groups.length || !model.counts || !model.counts.on) return null
  const en = lang === 'en'
  const L = (zh, e) => (en ? e : zh)
  const u = capUnits(model, adaptive)
  const groups = model.groups
  const multi = !!model.total
  const pbwSum = model.pbw === CAP_PBW.SUM
  const wrap = (unit) => (unit ? (en ? ` (${unit})` : `（${unit}）`) : '')
  const B = (v) => capFx(v != null ? v * u.bw.f : v, CAP_DEC.bw)
  const C = (v) => capFx(v != null ? v * u.cap.f : v, CAP_DEC.cap)
  const anyAvail = groups.some((g) => g.availBwKHz != null)
  const anyPrice = groups.some((g) => g.price != null)
  const t = model.total
  const members = groups.map((g) => g.rows.filter((r) => r.on && r.ok).map((r) => ({ rowId: r.rowId, n: r.n })))
  const rows = []
  const add = (label, unit, vals, tot) => rows.push([label + wrap(unit), ...vals, ...(multi ? [tot == null ? '—' : tot] : [])])
  if (typeof noOf === 'function') {
    rows.push([L('链路', 'Links'), ...members.map((ms) => capMembersText(ms.map((m) => ({ no: noOf(m.rowId), n: m.n })))), ...(multi ? [''] : [])])
  }
  add(L('载波数', 'Carriers'), '', groups.map((g) => String(g.n)), t ? String(t.n) : null)
  add(L('容量', 'Capacity'), u.cap.unit, groups.map((g) => C(g.capKbps)), t ? C(t.capKbps) : null)
  add(L('载波带宽', 'Allocated BW'), u.bw.unit, groups.map((g) => B(g.bwKHz)), t ? B(t.bwKHz) : null)
  if (pbwSum) add(L('功率带宽', 'Power BW'), u.bw.unit, groups.map((g) => B(g.pbwKHz)), null)
  if (anyAvail) {
    add(L('可用带宽', 'Available BW'), u.bw.unit, groups.map((g) => B(g.availBwKHz)), null)
    if (pbwSum) add(L('可用功率', 'Available power'), u.bw.unit, groups.map((g) => B(g.availPwKHz)), null)
    add(L('剩余带宽', 'Remaining BW'), u.bw.unit, groups.map((g) => B(g.remBwKHz)), null)
    if (pbwSum) add(L('剩余功率', 'Remaining power'), u.bw.unit, groups.map((g) => B(g.remPwKHz)), null)
    add(L('带宽占用', 'Bandwidth Usage'), '%', groups.map((g) => capFx(g.bwPct, CAP_DEC.pct)), null)
    if (pbwSum) add(L('功率占用', 'Power Usage'), '%', groups.map((g) => capFx(g.pwPct, CAP_DEC.pct)), null)
  }
  add(L('频谱效率', 'Spectral Efficiency'), 'bps/Hz', groups.map((g) => capFx(g.effBpsHz, CAP_DEC.eff)), t ? capFx(t.effBpsHz, CAP_DEC.eff) : null)
  add(L('结算带宽', 'Settled bandwidth'), u.bw.unit, groups.map((g) => B(g.billKHz)), t ? B(t.billKHz) : null)
  if (anyPrice) {
    add(L('单价', 'Unit price'), L('万元/MHz/年', '10k CNY/MHz/yr'), groups.map((g) => capFx(g.price, CAP_DEC.fee)), null)
    add(L('年费', 'Annual fee'), L('万元/年', '10k CNY/yr'), groups.map((g) => capFx(g.feeWan, CAP_DEC.fee)), t ? capFx(t.feeWan, CAP_DEC.fee) : null)
    add(L('单位容量成本', 'Cost per capacity'), L('万元/Mbps/年', '10k CNY/Mbps/yr'), groups.map((g) => capFx(g.unitCostWan, CAP_DEC.unitCost)), t ? capFx(t.unitCostWan, CAP_DEC.unitCost) : null)
  }
  const c = model.counts
  const note = en
    ? `Capacity summary (${c.on} link${c.on === 1 ? '' : 's'}${c.off ? ` · ${c.off} not included` : ''}${c.failed ? ` · ${c.failed} failed, excluded` : ''})`
    : `容量汇总（${c.on} 条链路${c.off ? ` · ${c.off} 条未列入` : ''}${c.failed ? ` · ${c.failed} 条失败已排除` : ''}）`
  return {
    note,
    head: [L('参数', 'Parameter'), ...groups.map((g) => g.name || '—'), ...(multi ? [L('合计', 'Total')] : [])],
    members,
    rows
  }
}

// 「链路」那一格：报告编号连号的并成区间（#1–#5），载波数 > 1 的单列并带倍数（#7×20）
export function capMembersText(nums) {
  const list = (nums || []).filter((m) => m && Number.isFinite(m.no)).sort((a, b) => a.no - b.no)
  const out = []
  let i = 0
  while (i < list.length) {
    const m = list[i]
    if (m.n > 1) { out.push(`#${m.no}×${m.n}`); i++; continue }
    let j = i
    while (j + 1 < list.length && list[j + 1].n <= 1 && list[j + 1].no === list[j].no + 1) j++
    out.push(j - i >= 2 ? `#${m.no}–#${list[j].no}` : list.slice(i, j + 1).map((x) => `#${x.no}`).join(', '))
    i = j + 1
  }
  return out.join(', ')
}
