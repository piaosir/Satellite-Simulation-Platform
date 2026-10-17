// C/CCI 复用方案 · 渲染端那一半：频率计划推逐波束段、GRD 波束 ↔ 计划波束自动匹配、逐波束表（Excel / 手工）、
// 出 IPC 的纯数据。耦合与干扰一概在主进程（packages/core/utils/interference/htsCoupling.js）——这里只整理三份
// 只有渲染端读得到的数据（频率计划的 ESM 模型、Excel 文件、窗口里的表），不算任何 C/I。
//
// 方向：前向 = 用户下行（频率计划取转发器的下行侧），返向 = 用户上行（取上行侧）。前向转发器的上行侧是信关站上行，
// 与用户上行同挂在用户波束上时会被当成返向段 —— 故两向各给一个频段窗（留空 = 不筛）。
import { normalizePlan, beamSegs, isMark, toMHz } from '../shared/freqPlanModel.js'
import { loadSynthGroups } from '../shared/freqPlanBeamSynth.js'
import { toHalf } from '../shared/num.js'

export const CCI_SOURCES = [
  { key: 'auto', label: '自动' },
  { key: 'freqPlan', label: '频率计划' },
  { key: 'synth', label: '波束合成色号' },
  { key: 'excel', label: 'Excel 导入' },
  { key: 'manual', label: '手工' },
  { key: 'rotation', label: '轮转' }
]
export const SOURCE_NAME = { freqPlan: '频率计划', synth: '波束合成色号', excel: 'Excel 导入', manual: '手工', rotation: '轮转' }

// ---- 小工具 ----
const numOrNull = (v) => {
  if (v === null || v === undefined) return null
  const s = toHalf(String(v)).trim().replace(/[，]/g, '.')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const freqMHz = (v) => { const n = numOrNull(v); return n == null ? null : toMHz(n) }
export function normPolR(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase()
  if (!s || s === '—' || s === '-') return ''
  if (s === 'H' || s === 'HOR' || s.includes('水平')) return 'H'
  if (s === 'V' || s === 'VER' || s.includes('垂直')) return 'V'
  if (s === 'R' || s === 'RHCP' || s === 'RHC' || s.includes('右旋')) return 'R'
  if (s === 'L' || s === 'LHCP' || s === 'LHC' || s.includes('左旋')) return 'L'
  return ''
}
const fmtF = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(10))) : '')
/** 段的读数：「19260–19700 R · 19760–20200 L」（MHz） */
export function segsText(segs) {
  return (segs || []).map((s) => `${fmtF(s.f1)}–${fmtF(s.f2)}${s.pol ? ' ' + s.pol : ''}`).join(' · ')
}

// ---- 频率计划 → 逐计划波束的占段 ----
/**
 * 一份计划在一个方向上，各计划波束占哪几段（绝对频率 MHz）、什么极化、段功率偏置（−转发器 OBO）。
 * 段取自 freqPlanModel.beamSegs（转发器的占段 / 自动排布，与频率计划图上画的同一份），信标遥测遥控不算。
 * band = { f1, f2 }：该方向的频段窗，段裁到窗内（留空 = 不筛）。
 * @returns Map(planBeamId → { id, name, synth, segs:[{f1,f2,pol,pDb}] })，按计划里的波束次序
 */
export function planOccupancy(rawPlan, dir, band) {
  const plan = normalizePlan(rawPlan)
  const side = dir === 'rtn' ? 'up' : 'dn'
  const lo = band ? freqMHz(band.f1) : null, hi = band ? freqMHz(band.f2) : null
  const out = new Map()
  for (const b of plan.beams) out.set(b.id, { id: b.id, name: b.name, synth: b.synth, segs: [] })
  for (const ch of plan.channels) {
    if (isMark(ch) || (ch.kind && ch.kind !== 'transponder')) continue
    const pol = (ch[side] && ch[side].pol) || ''
    const pDb = Number.isFinite(ch.booDb) ? -ch.booDb : 0
    for (const s of beamSegs(plan, ch, side)) {
      if (!Number.isFinite(s.f1) || !Number.isFinite(s.f2) || !(s.f2 > s.f1)) continue
      const f1 = lo != null ? Math.max(s.f1, lo) : s.f1
      const f2 = hi != null ? Math.min(s.f2, hi) : s.f2
      if (!(f2 > f1)) continue
      const e = out.get(s.beam.id)
      if (e) e.segs.push({ f1, f2, pol, pDb })
    }
  }
  return out
}

// ---- 波束号 ----
/**
 * 计划波束名里的 GRD 波束号（1 基）：
 *   纯号段「12」「1-3,7」「1、5」→ 号表（从波束合成导进来的波束，名字就是代号串）；
 *   「Beam 12」「波束12」「B12」「#12」→ 末尾那个号。认不出 → []。
 */
export function parseBeamNos(text) {
  const s = toHalf(String(text == null ? '' : text)).trim().replace(/\s*([-~–])\s*/g, '$1')
  if (!s) return []
  if (/^\d+([-~–]\d+)?([,，、;；\s]+\d+([-~–]\d+)?)*$/.test(s)) {
    const out = []
    for (const part of s.split(/[,，、;；\s]+/)) {
      const m = /^(\d+)[-~–](\d+)$/.exec(part)
      if (m) { const a = +m[1], b = +m[2]; if (b >= a && b - a < 4000) for (let k = a; k <= b; k++) out.push(k) }
      else if (/^\d+$/.test(part)) out.push(+part)
    }
    return [...new Set(out)]
  }
  const m = /(?:beam|波束|^b|#|no\.?)\s*(\d+)\s*$/i.exec(s) || /^(\d+)\s*号?\s*波束$/.exec(s)
  return m ? [+m[1]] : []
}

/**
 * 这副合成天线的波束在整星连续编号里从几号起（波束合成「频率计划 · 自动分配」导进频率计划的代号是整星编号）：
 * 天线名 = 波束组名、同一颗星。认不出（不是合成件 / 组已删）→ null。
 */
export function synthBaseOf(antName, folder, groups) {
  const list = groups || loadSynthGroups()
  let base = 0, hit = null
  for (const g of list) {
    if (g.satFolder !== folder) continue
    if (hit == null && g.name === antName) hit = { base, id: g.id }
    base += g.beamCount
  }
  return hit
}

/**
 * GRD 波束（原始 set 序号）↔ 计划波束的自动匹配。优先级：手工指定 > 波束合成代号（同组、按整星编号换算）> 名字里的号。
 * 一个计划波束可对多个 GRD 波束（同色合并的那一条）；一个 GRD 波束只认第一个认领它的计划波束。
 *   manual: { [原始下标]: 计划波束 id | '__none' }
 *   synth:  synthBaseOf 的结果（null = 不按代号）
 * @returns { map: Map(原始下标 → 计划波束 id), how: Map(原始下标 → 'manual'|'synth'|'name') }
 */
export function autoMatch(beamIdx, planBeams, opt) {
  const o = opt || {}
  const man = o.manual || {}
  const map = new Map(), how = new Map()
  const want = new Set(beamIdx)
  const ids = new Set((planBeams || []).map((b) => b.id))
  for (const i of beamIdx) {
    const v = man[i]
    if (v === '__none') { how.set(i, 'manual'); continue }
    if (v && ids.has(v)) { map.set(i, v); how.set(i, 'manual') }
  }
  const claim = (i, id, k) => { if (want.has(i) && !how.has(i)) { map.set(i, id); how.set(i, k) } }
  const syn = o.synth
  if (syn) {
    for (const b of planBeams || []) {
      const s = b.synth
      if (!s || !Array.isArray(s.nos) || !s.nos.length) continue
      if (s.groupId && syn.id && s.groupId !== syn.id) continue
      for (const no of s.nos) claim(no - syn.base - 1, b.id, 'synth')
    }
  }
  for (const b of planBeams || []) {
    if (syn && b.synth && b.synth.nos && b.synth.nos.length && (!b.synth.groupId || b.synth.groupId === syn.id)) continue
    for (const no of parseBeamNos(b.name)) claim(no - 1, b.id, 'name')
  }
  return { map, how }
}

// ---- 逐波束表（行 = 存活 GRD 波束）----
export function newBeamRow(idx) {
  return { _id: 'cb' + idx, idx, plan: '', mColor: '', fColor: '', fF1: '', fF2: '', fPol: '', rColor: '', rF1: '', rF2: '', rPol: '', pDb: '' }
}
/** 按方向图的存活波束补齐行（已有的按 idx 原样保留，老的手工色号 coloringOverride 只在新建行时种进去） */
export function syncBeamRows(rows, beamIdx, legacyColoring) {
  const have = new Map((rows || []).map((r) => [r.idx, r]))
  const out = []
  for (const i of beamIdx) {
    let r = have.get(i)
    if (!r) {
      r = newBeamRow(i)
      const c = legacyColoring ? legacyColoring[i] : undefined
      if (Number.isInteger(Number(c)) && Number(c) >= 0 && c !== '' && c !== null) r.mColor = Number(c) + 1
    }
    out.push(r)
  }
  return out
}

const colorLabel = (v) => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s }
const segOf = (f1, f2, pol) => { const a = freqMHz(f1), b = freqMHz(f2); return a != null && b != null && b > a ? [{ f1: a, f2: b, pol }] : [] }

/**
 * 出 IPC 的复用方案（纯数据，切断响应式代理）。主进程补上波束合成色号后交 htsCoupling.normalizeScheme。
 *   st = { source, colors, xpdDb, rows, colorDefs, plan:{ label, occF:Map, occR:Map, map:Map } | null }
 */
export function schemePayload(st) {
  const s = st || {}
  const rows = s.rows || []
  const out = { source: s.source || 'auto', colors: Number(s.colors) || 4, xpdDb: numOrNull(s.xpdDb) ?? 25 }
  const power = {}
  for (const r of rows) { const p = numOrNull(r.pDb); if (p != null) power[r.idx] = p }
  out.powerDb = power
  // 频率计划
  if (s.plan && s.plan.map && s.plan.map.size) {
    const beams = {}
    for (const [i, id] of s.plan.map) {
      const f = s.plan.occF && s.plan.occF.get(id), r = s.plan.occR && s.plan.occR.get(id)
      const seg = (e) => (e ? e.segs.map((x) => ({ f1: x.f1, f2: x.f2, pol: x.pol, pDb: x.pDb })) : [])
      beams[i] = { fwd: { segs: seg(f) }, rtn: { segs: seg(r) } }
    }
    out.plan = { label: String(s.plan.label || ''), beams }
  }
  // 逐波束表（Excel 导入 / 手工录入的频段与色号）
  const ex = {}
  let exAny = false
  for (const r of rows) {
    const fPol = normPolR(r.fPol), rPol = normPolR(r.rPol)
    const fwd = { segs: segOf(r.fF1, r.fF2, fPol), color: colorLabel(r.fColor), pol: fPol }
    const rtn = { segs: segOf(r.rF1, r.rF2, rPol), color: colorLabel(r.rColor), pol: rPol }
    if (fwd.segs.length || rtn.segs.length || fwd.color != null || rtn.color != null) { ex[r.idx] = { fwd, rtn }; exAny = true }
  }
  if (exAny) out.excel = { beams: ex }
  // 手工色号（1 基录入 → 0 基，与老字段 coloringOverride 同口径）
  const man = manualColoring(rows)
  if (Object.keys(man).length) out.manual = { coloring: man }
  // 色号定义（色号类来源用：F# → 频段 × 极化）
  const defs = {}
  for (const d of (s.colorDefs || [])) {
    const c = Math.round(Number(d.color))
    if (!(c >= 1)) continue
    const fPol = normPolR(d.fPol), rPol = normPolR(d.rPol)
    const f = segOf(d.fF1, d.fF2, fPol), r = segOf(d.rF1, d.rF2, rPol)
    if (!f.length && !r.length) continue
    defs[String(c - 1)] = { ...(f.length ? { fwd: f[0] } : {}), ...(r.length ? { rtn: r[0] } : {}) }
  }
  if (Object.keys(defs).length) out.colorDefs = defs
  return JSON.parse(JSON.stringify(out))
}
/** 手工色号 → { 原始下标: 0 基色号 }（即老字段 coloringOverride 的形状） */
export function manualColoring(rows) {
  const m = {}
  for (const r of rows || []) {
    const c = Math.round(Number(String(r.mColor == null ? '' : r.mColor).replace(/^F/i, '')))
    if (r.mColor !== '' && r.mColor != null && c >= 1) m[r.idx] = c - 1
  }
  return m
}

// ---- 网格列 ----
const parseNum = (v) => { const s = toHalf(String(v == null ? '' : v)).trim().replace(/[，]/g, '.'); if (s === '') return ''; const n = Number(s); return Number.isFinite(n) ? n : undefined }
const showNum = (v) => (v == null || v === '' ? '' : String(v))
const POL_OPTS = [{ value: '—' }, { value: 'H' }, { value: 'V' }, { value: 'L' }, { value: 'R' }]
const parsePolCell = (v) => { const s = String(v == null ? '' : v).trim(); if (s === '' || s === '—' || s === '-') return ''; return normPolR(s) || undefined }
const parseLabel = (v) => String(v == null ? '' : v).trim()
const parseColorNo = (v) => { const s = String(v == null ? '' : v).trim().replace(/^F/i, ''); if (s === '') return ''; const n = Number(s); return Number.isInteger(n) && n >= 1 ? n : undefined }
const num = (key, label, unit, w, extra) => ({ key, label, unit, w, num: true, get: (o) => showNum(o[key]), parse: parseNum, blank: '', ...extra })
const txt = (key, label, w, extra) => ({ key, label, w, get: (o) => String(o[key] == null ? '' : o[key]), parse: parseLabel, blank: '', ...extra })
const pol = (key, label, w, extra) => ({ key, label, w, options: POL_OPTS, get: (o) => o[key] || '—', parse: parsePolCell, blank: '', ...extra })
const NO_COL = { key: 'no', label: '波束', w: 60, editable: false, get: (o) => String(o.idx + 1), parse: () => undefined }
const POWER_COL = num('pDb', '功率偏置', 'dB', 92)

/** 频率计划映射表：计划波束列的选项 / 读数 / 写值由调用方按当前计划给 */
export function planCols(o) {
  return [
    NO_COL,
    { key: 'plan', label: '计划波束', w: 168, options: o.options, get: o.planText, parse: o.planParse, blank: '' },
    { key: 'occF', label: '前向占段', w: 220, editable: false, get: (r) => o.occText(r, 'fwd'), parse: () => undefined },
    { key: 'occR', label: '返向占段', w: 220, editable: false, get: (r) => o.occText(r, 'rtn'), parse: () => undefined },
    POWER_COL
  ]
}
/** 逐波束表（Excel 导入 / 手工录入频段） */
export const TABLE_COLS = [
  NO_COL,
  txt('fColor', '前向色号', 84),
  num('fF1', '前向起', 'MHz', 96),
  num('fF2', '前向止', 'MHz', 96),
  pol('fPol', '前向极化', 84),
  txt('rColor', '返向色号', 84),
  num('rF1', '返向起', 'MHz', 96),
  num('rF2', '返向止', 'MHz', 96),
  pol('rPol', '返向极化', 84),
  POWER_COL
]
/** 色号表（波束合成 / 手工 / 轮转）：色号格的读数与可编辑性由调用方按来源给 */
export function colorCols(o) {
  return [
    NO_COL,
    { key: 'mColor', label: '色号', w: 84, get: o.colorText, parse: parseColorNo, blank: '' },
    POWER_COL
  ]
}
/** 色号定义（F# → 前向 / 返向频段 × 极化）。枚举列不放最末一列（ExcelGrid 的下拉钮贴格子右缘） */
export const DEF_COLS = [
  { key: 'color', label: '色号', w: 64, num: true, get: (o) => (o.color == null || o.color === '' ? '' : 'F' + o.color), parse: parseColorNo, blank: '' },
  pol('fPol', '前向极化', 84),
  num('fF1', '前向起', 'MHz', 96),
  num('fF2', '前向止', 'MHz', 96),
  pol('rPol', '返向极化', 84),
  num('rF1', '返向起', 'MHz', 96),
  num('rF2', '返向止', 'MHz', 96)
]

// ---- Excel 导入：表头别名（中星26 一类逐波束频率计划表）----
// 起 / 止缺、只有中心 + 带宽的也认（导入时换算）；频率小于 1000 按 GHz 读（同频率计划的 toMHz）。
export const IMPORT_COLS = [
  { key: 'no', label: '波束', alias: ['波束号', '波束编号', '波束代号', '编号', '序号', 'Beam', 'Beam No', 'Beam ID', 'No'] },
  { key: 'fColor', label: '前向色号', alias: ['下行色号', '用户下行色号', '前向下行色号', 'DL color', 'Forward color', 'Color'] },
  { key: 'fF1', label: '前向起', alias: ['前向起始', '下行起始', '前向下行起始', '用户下行起始', '下行起', 'DL start', 'Forward start'] },
  { key: 'fF2', label: '前向止', alias: ['前向终止', '下行终止', '前向下行终止', '用户下行终止', '下行止', 'DL stop', 'Forward stop'] },
  { key: 'fFc', label: '前向中心', alias: ['下行中心', '前向下行中心', '用户下行中心', 'DL center'] },
  { key: 'fBw', label: '前向带宽', alias: ['下行带宽', '前向下行带宽', '用户下行带宽', 'DL bandwidth'] },
  { key: 'fPol', label: '前向极化', alias: ['下行极化', '用户下行极化', '前向下行极化', 'DL pol', 'DL polarization'] },
  { key: 'rColor', label: '返向色号', alias: ['上行色号', '用户上行色号', '返向上行色号', 'UL color', 'Return color'] },
  { key: 'rF1', label: '返向起', alias: ['返向起始', '上行起始', '返向上行起始', '用户上行起始', '上行起', 'UL start', 'Return start'] },
  { key: 'rF2', label: '返向止', alias: ['返向终止', '上行终止', '返向上行终止', '用户上行终止', '上行止', 'UL stop', 'Return stop'] },
  { key: 'rFc', label: '返向中心', alias: ['上行中心', '返向上行中心', '用户上行中心', 'UL center'] },
  { key: 'rBw', label: '返向带宽', alias: ['上行带宽', '返向上行带宽', '用户上行带宽', 'UL bandwidth'] },
  { key: 'rPol', label: '返向极化', alias: ['上行极化', '用户上行极化', '返向上行极化', 'UL pol', 'UL polarization'] },
  { key: 'pDb', label: '功率偏置', alias: ['功率偏置 (dB)', 'Power offset'] }
]
/**
 * 导入记录（gridXlsx.sheetToRecords 的结果）落到逐波束行上：按「波束」号对行（号 = 原始 set 序号 + 1）。
 * 中心 + 带宽换成起止。返回 { matched, skipped }（skipped = 号对不上任何存活波束的行）。
 */
export function applyImportRecords(rows, records) {
  const byNo = new Map((rows || []).map((r) => [r.idx + 1, r]))
  let matched = 0, skipped = 0
  for (const rec of records || []) {
    const nos = parseBeamNos(rec.no)
    const r = nos.length === 1 ? byNo.get(nos[0]) : null
    if (!r) { skipped++; continue }
    matched++
    const put = (k, v) => { if (v !== undefined) r[k] = v }
    put('fColor', rec.fColor !== undefined ? parseLabel(rec.fColor) : undefined)
    put('rColor', rec.rColor !== undefined ? parseLabel(rec.rColor) : undefined)
    put('fPol', rec.fPol !== undefined ? (parsePolCell(rec.fPol) ?? '') : undefined)
    put('rPol', rec.rPol !== undefined ? (parsePolCell(rec.rPol) ?? '') : undefined)
    put('pDb', rec.pDb !== undefined ? (parseNum(rec.pDb) ?? '') : undefined)
    for (const p of ['f', 'r']) {
      let a = numOrNull(rec[p + 'F1']), b = numOrNull(rec[p + 'F2'])
      const c = numOrNull(rec[p + 'Fc']), w = numOrNull(rec[p + 'Bw'])
      if ((a == null || b == null) && c != null && w != null && w > 0) {
        // 中心与带宽各按自己的量级换算（带宽 440 是 MHz，中心 19.48 是 GHz）
        const cm = toMHz(c)
        a = cm - w / 2; b = cm + w / 2
      }
      if (a != null) r[p + 'F1'] = a
      if (b != null) r[p + 'F2'] = b
    }
  }
  return { matched, skipped }
}
