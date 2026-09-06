// 独立《服务等级指标（SLA）》报告的 Word 出口（.docx，主进程）。
//
// 版式与链路预算报告完全同一套（模板《技术文档标准模板.docx》）：封面、目录、三线表、
// 页眉 logo、页脚页码、题注在表上方 —— 全部取自 reportDocxKit.js，本文件只管【印什么】。
// A4 纵向，全篇不需横向。
//
// 章节：
//   1 服务范围      链路清单 + 报告口径 kv 表
//   2 指标定义与考核口径  五栏定义表 + 免责事件（只列名，日凌给数）
//   3 服务等级指标总表    条款 × 链路的矩阵 + SLA 参数行
//   4 逐链路指标明细      每链一节：明细五列 / 可用度档位 / 日凌预计窗口
//   5 参数与假设          SLA 参数表 + 可用度构成 + 单位档
//   6 引用标准            编号 / 名称 / 用途
//
// 表号全篇连续（nextTableNo）；详情章按「链路序号-块序号」编，不走那个计数器。
// 纯数字：本文件不产出任何「达标 / 合格 / 受限 / 满足」一类文字判定（见仓库根 CLAUDE.md）。
const { Document, Packer } = require('docx')
const {
  paragraphStyles, P, docTable, kvTable, coverSection, tocSection,
  logoHeader, pageFooter, sectPage, nextTableNo, capTable, TPL, half, FN
} = require('./reportDocxKit')
const { buildSlaMatrix } = require('./report')

// —— 小工具 ——
const S = (v) => (v == null || v === '' ? '—' : String(v))
const fx = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—')
// 数值列的小数位：可用度 3、dB 2、min 0、% 2（与屏上那张档位表同档）
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }

// 节：A4 纵向 + 页眉 logo + 页脚页码
const bodySection = (model, children) => ({
  properties: sectPage(false, { start: 1 }),
  headers: { default: logoHeader((model.doc || {}).logo) },
  footers: { default: pageFooter() },
  children
})

const H = (text, level) => P(text, 'RptH' + level)

// 表：题注（表上方）+ 三线表
function table(model, title, head, rows, opts) {
  if (!rows || !rows.length) return []
  const no = nextTableNo(model)
  return [P(capTable(model, no, 0, 1, title), 'RptCaption'), docTable(head, rows, opts || {})]
}
// 详情章的表：按「链路序号-块序号」编，不占全篇计数器
function subTable(model, linkNo, idx, title, head, rows, opts) {
  if (!rows || !rows.length) return []
  const en = model.lang === 'en'
  const L = model.t || {}
  const seq = linkNo + '-' + idx
  const cap = en ? `Table ${seq}  ${title}` : `${L.table || '表'} ${seq}　${title}`
  return [P(cap, 'RptCaption'), docTable(head, rows, opts || {})]
}

// ============================ 各章 ============================

// 1 服务范围：链路清单 + 报告口径
function scopeSection(model) {
  const L = model.t || {}
  const links = model.links || []
  const out = [H('1　' + L.slaScope, 1)]
  const head = [L.no, L.tx, L.rx, L.satellite, L.band, L.carrier]
  const rows = links.map((l) => {
    const s = l.summary || {}
    const c = s.carrier || {}
    const carrier = [c.infoRate != null ? fx(c.infoRate, 0) + ' kbps' : '', c.modcod,
      c.symbolRate != null ? fx(c.symbolRate, 2) + ' ksps' : ''].filter(Boolean).join('　·　')
    return ['#' + l.no, S(l.txName), S(l.rxName), S(s.satellite), S(s.band), carrier || '—']
  })
  out.push(...table(model, L.schedule, head, rows, { widths: [8, 20, 20, 16, 10, 26] }))
  // 报告口径：体制 / 计算方式 / 考核周期 / 单位档 / 软件版本 / 生成时间
  const d = model.doc || {}
  const kv = [
    [L.scheme, S(model.schemeText)],
    [L.calcMode, S((model.calc || {}).mode)],
    [L.period, model.monthly ? L.periodMonth : L.periodYear],
    [L.unitMode, model.adaptUnits ? L.unitAdaptive : L.unitLocked],
    [L.appVersion, S(d.appVersion)],
    [L.generated, S(d.generatedAt ? String(d.generatedAt).replace('T', ' ').slice(0, 19) : '')]
  ]
  out.push(kvTable(kv))
  return out
}

// 2 指标定义与考核口径
function defsSection(model) {
  const L = model.t || {}
  const out = [H('2　' + L.slaDefs, 1)]
  const head = [L.slaTerm, L.slaDefinition, L.slaFormula, L.period, L.slaSource]
  const rows = (model.definitions || []).map((d) => [d.term, d.definition, d.formula, d.period, d.basis])
  out.push(...table(model, L.slaDefs, head, rows, { widths: [16, 34, 22, 12, 16] }))
  // 免责事件：合同惯例三条只列名，日凌给数（预计窗口见各链路详情）
  const ex = model.exclusions || []
  if (ex.length) {
    out.push(H('2.1　' + L.slaExcl, 2))
    for (const s of ex) out.push(P('· ' + s, 'RptBody'))
  }
  return out
}

// 3 服务等级指标总表：条款 × 链路矩阵 + SLA 参数行
function matrixSection(model) {
  const L = model.t || {}
  const links = model.links || []
  const out = [H('3　' + L.slaMatrix, 1)]
  const mx = buildSlaMatrix(links, model.lang)
  if (mx) {
    const head = [L.slaTerm, ...links.map((l) => '#' + l.no)]
    const rows = mx.rows.map((r) => (r.group ? [r.label, ...links.map(() => '')] : [r.label, ...r.values.map(S)]))
    const keyRows = mx.rows.map((r) => !!r.group)
    const w = Math.max(10, Math.floor(58 / Math.max(1, links.length)))
    out.push(...table(model, L.slaMatrix, head, rows, {
      widths: [100 - w * links.length, ...links.map(() => w)],
      align: ['left', ...links.map(() => 'right')],
      keyRows
    }))
  }
  const pr = model.slaParams || []
  if (pr.length) {
    out.push(P(L.slaParams + '　' + pr.map((r) => r.label + ' ' + r.value + (r.unit ? ' ' + r.unit : '')).join('　·　'), 'RptNote'))
  }
  return out
}

// 4 逐链路指标明细
function detailSection(model) {
  const L = model.t || {}
  const links = model.links || []
  const out = [H('4　' + L.slaDetail, 1)]
  links.forEach((l) => {
    out.push(H('#' + l.no + '　' + S(l.txName) + ' → ' + S(l.rxName), 3))
    if (!l.ok && l.error) { out.push(P(L.calcFailed + '：' + l.error, 'RptBody')); return }
    const rows = ((l.sla && l.sla.rows) || []).map((r) => [
      r.label + (r.sub ? '　' + r.sub : ''), S(r.basis), S(r.suggest), r.adopt === '' ? '—' : S(r.adopt), S(r.unit)
    ])
    // 分组行（组名各出一次）：三线表不许底纹，层次靠黑体不加粗给
    const withGroups = []
    const keyRows = []
    let cur = ''
    ;((l.sla && l.sla.rows) || []).forEach((r, i) => {
      if (r.groupLabel && r.groupLabel !== cur) { cur = r.groupLabel; withGroups.push([cur, '', '', '', '']); keyRows.push(true) }
      withGroups.push(rows[i]); keyRows.push(false)
    })
    out.push(...subTable(model, l.no, 1, L.sla, [L.slaTerm, L.slaBasis, L.slaSuggest, L.slaAdopt, L.unit],
      withGroups, { widths: [24, 34, 14, 14, 8], align: ['left', 'left', 'right', 'right', 'left'], keyRows }))
    // 可用度档位：整列无数的不出；余量为负的格不着色（Word 里只印数）
    const sc = l.scan
    if (sc && sc.rows.length) {
      const COLS = [
        { k: 'tier', label: L.tier, unit: '%', dec: 2 },
        { k: 'comp', label: L.composite, unit: '%', dec: 3 },
        { k: 'up', label: L.uplink, unit: '%', dec: 3 },
        { k: 'dn', label: L.downlink, unit: '%', dec: 3 },
        { k: 'uplinkRain', label: L.rainUp, unit: 'dB', dec: 2 },
        { k: 'downlinkRain', label: L.rainDown, unit: 'dB', dec: 2 },
        { k: 'margin', label: L.marginCol, unit: 'dB', dec: 2 },
        { k: 'powerUsage', label: L.powerUse, unit: '%', dec: 2 },
        { k: 'bwUsage', label: L.bwUse, unit: '%', dec: 2 },
        { k: 'outage', label: L.outageCol, unit: 'min', dec: 0 }
      ].filter((c) => sc.rows.some((r) => num(r[c.k]) !== null))
      const head = COLS.map((c) => c.label + '（' + c.unit + '）')
      const headEn = COLS.map((c) => c.label + ' (' + c.unit + ')')
      const rows2 = sc.rows.map((r) => COLS.map((c) => {
        const v = num(r[c.k])
        if (v === null) return '—'
        return c.k === 'tier' ? (v % 1 ? v.toFixed(2) : v.toFixed(0)) : v.toFixed(c.dec)
      }))
      out.push(...subTable(model, l.no, 2, L.slaTiers, model.lang === 'en' ? headEn : head, rows2,
        { align: COLS.map(() => 'right') }))
    }
    // 日凌预计窗口（有数时）：UTC 与北京时两列
    const so = l.sunOutage
    if (so) {
      const rows3 = []
      for (const key of ['vernal', 'autumnal']) {
        const seg = so[key]
        if (!seg || !seg.rows) continue
        for (const d of seg.rows) {
          rows3.push([S(d.date), S(d.startUTC) + ' – ' + S(d.endUTC), S(d.startBJT) + ' – ' + S(d.endBJT),
            fx(num(d.durationSec) / 60, 1)])
        }
      }
      out.push(...subTable(model, l.no, 3, L.slaSun,
        [L.date, 'UTC', L.localTime, L.duration + '（min）'], rows3,
        { widths: [22, 28, 28, 22], align: ['left', 'left', 'left', 'right'] }))
    }
  })
  return out
}

// 5 参数与假设：SLA 参数 + 可用度构成 + 单位档
function assumeSection(model) {
  const L = model.t || {}
  const out = [H('5　' + L.slaAssump, 1)]
  const pr = model.slaParams || []
  if (pr.length) {
    out.push(...table(model, L.slaParams, [L.param, L.value, L.unit],
      pr.map((r) => [r.label, S(r.value), r.unit || '—']), { widths: [40, 30, 30], align: ['left', 'right', 'left'] }))
  }
  const comp = model.composition || []
  if (comp.length) {
    out.push(...table(model, L.slaComposition, [L.param, L.slaSlots, L.value],
      comp.map((c) => [c.label, String(c.count), S(c.value)]), { widths: [50, 20, 30], align: ['left', 'right', 'right'] }))
  }
  return out
}

// 6 引用标准
function refsSection(model) {
  const L = model.t || {}
  const out = [H('6　' + L.slaRefs, 1)]
  out.push(...table(model, L.slaRefs, [L.mId, L.mTitle, L.mUse],
    (model.refs || []).map((r) => [r.id, r.title, r.use]), { widths: [22, 44, 34] }))
  return out
}

// 目录条目：逐条对应下面正文里真正出现的 H1 / H2（不给页码，理由见 kit 的 tocSection 头注）
function tocItems(model) {
  const L = model.t || {}
  const it = [{ n: '1', t: L.slaScope }, { n: '2', t: L.slaDefs }, { n: '2.1', t: L.slaExcl, sub: true },
    { n: '3', t: L.slaMatrix }, { n: '4', t: L.slaDetail }]
  for (const l of (model.links || [])) it.push({ n: '#' + l.no, t: (l.txName || '') + ' → ' + (l.rxName || ''), sub: true })
  it.push({ n: '5', t: L.slaAssump }, { n: '6', t: L.slaRefs })
  return it
}

async function buildSlaDocx(model) {
  model.__tblNo = 0     // 表号从头数（同一份模型可能被反复渲染）
  const doc = new Document({
    creator: (model.doc && model.doc.org) || '',
    title: (model.doc && model.doc.title) || '',
    description: model.schemeText || '',
    styles: { default: { document: { run: { font: FN, size: half(TPL.size.body) } } }, paragraphStyles: paragraphStyles() },
    sections: [
      coverSection(model),
      tocSection(model, tocItems(model)),
      bodySection(model, [].concat(
        scopeSection(model), defsSection(model), matrixSection(model),
        detailSection(model), assumeSection(model), refsSection(model)
      ))
    ]
  })
  return Packer.toBuffer(doc)
}

module.exports = { buildSlaDocx }
