// 应用场景仿真 · 方案报告（Excel，走平台既有的三线表版式档 style:'report'，与链路预算报告同款）。
//
// ★ 报告里必须保住三档判据的区分 —— 这是整套东西可信与否的分界：
//   · 功率预算档的行给 dB 余量；
//   · 约束校验档的行给「实际 / 上限」两列，余量列留空（它没有余量这回事）；
//   · 契约档的行在「判据」列写「契约（承诺值）」，数字照录不加工。
//   把三者压进同一列同一口径，报告就成了一份看起来算过、其实没算的东西。
//
// 六张表：方案概览 / 模块清单 / 连线清单 / 业务流结果 / 逐段读数 / 能量账。
// 拓扑图 PNG 由拓扑视图自己那颗按钮出（4× 口径），不塞进工作簿 —— exceljs 的锚点是 EMU、
// 图片一进表格就要和行高较劲，那条路平台在链路预算报告里踩过。

import { sheetModel, exportSheets, safeFileName } from './gridXlsx.js'

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? +n.toFixed(d == null ? 2 : d) : null
}
const rate = (b) => {
  const n = Number(b)
  if (!Number.isFinite(n)) return ''
  if (n >= 1e9) return (n / 1e9).toFixed(3) + ' Gbps'
  if (n >= 1e6) return (n / 1e6).toFixed(3) + ' Mbps'
  if (n >= 1e3) return (n / 1e3).toFixed(2) + ' kbps'
  return Math.round(n) + ' bps'
}
const TIER_ZH = { power: '功率预算', constraint: '约束校验', contract: '契约（承诺值）', satellite: '卫星段', supply: '供电' }
const dirZh = (d) => (d === 'ab' ? '正向' : '返向')

/**
 * @param ctx { scene, result, effective, mediaOf, tierOf, modName }
 * @returns sheetModel[] —— 交给 exportSheets
 */
export function buildSceneSheets(ctx) {
  const { scene, result } = ctx
  const eff = (m) => ctx.effective(m) || {}
  const nameOf = (id) => { const m = (scene.modules || []).find((x) => x.id === id); return m ? m.name : id }
  const sheets = []

  // ── ① 方案概览 ──
  {
    const rows = [
      { k: '方案名称', v: scene.name || '' },
      { k: '模块数', v: (scene.modules || []).length },
      { k: '连线数', v: (scene.links || []).length },
      { k: '业务流数', v: (scene.flows || []).length },
      { k: '载波体制', v: `${scene.carrier.modulation} ${scene.carrier.fec}，门限 ${scene.carrier.ebno} dB，滚降 ${scene.carrier.bandwidthFactor}` }
    ]
    if (result) {
      for (const f of result.flows || []) {
        rows.push({ k: `业务流「${f.name}」余量`, v: f.summary.marginDb == null ? '—' : `${num(f.summary.marginDb)} dB（${dirZh(f.summary.marginDir)}）` })
        rows.push({ k: `业务流「${f.name}」可用度`, v: f.summary.availPct == null ? '—' : `${num(f.summary.availPct, 4)} %` })
        rows.push({ k: `业务流「${f.name}」时延`, v: f.summary.rttMs != null ? `${num(f.summary.rttMs, 1)} ms（往返）` : (f.summary.latencyMs != null ? `${num(f.summary.latencyMs, 1)} ms` : '—') })
      }
    }
    sheets.push(sheetModel({
      name: '方案概览', rows,
      cols: [{ key: 'k', label: '项' }, { key: 'v', label: '值' }]
    }))
  }

  // ── ② 模块清单 ──
  sheets.push(sheetModel({
    name: '模块清单',
    cols: [
      { key: 'name', label: '名称' }, { key: 'cat', label: '类别' }, { key: 'lib', label: '库条目' },
      { key: 'lat', label: '纬度', unit: '°', num: true, fix: 4 }, { key: 'lon', label: '经度', unit: '°', num: true, fix: 4 },
      { key: 'alt', label: '海拔', unit: 'm', num: true, fix: 0 }, { key: 'host', label: '挂载于' },
      { key: 'dia', label: '天线口径', unit: 'm', num: true, fix: 2 }, { key: 'pw', label: '功放', unit: 'W', num: true, fix: 1 },
      { key: 'typ', label: '电平口径' }, { key: 'src', label: '出处' }
    ],
    rows: (scene.modules || []).map((m) => {
      const e = eff(m)
      const p = m.place || {}
      return {
        name: m.name, cat: e.cat || '', lib: m.libId || (m.kind === 'sat' ? '卫星库 ' + (m.satId || '') : ''),
        lat: p.mode === 'mounted' ? null : p.lat, lon: p.mode === 'mounted' ? null : p.lon, alt: p.altM,
        host: p.mode === 'mounted' ? nameOf(p.hostId) : '',
        dia: e.rf ? e.rf.antennaDiameter : null, pw: e.rf ? e.rf.opPowerW : null,
        typ: e.typical ? '该类典型值' : '型号实测/公开值',
        src: e.src || ''
      }
    })
  }))

  // ── ③ 连线清单 ──
  sheets.push(sheetModel({
    name: '连线清单',
    cols: [
      { key: 'a', label: 'A 端' }, { key: 'ap', label: 'A 端口' }, { key: 'b', label: 'B 端' }, { key: 'bp', label: 'B 端口' },
      { key: 'med', label: '介质' }, { key: 'tier', label: '判据档' }, { key: 'role', label: '角色' }, { key: 'par', label: '关键参数' }
    ],
    rows: (scene.links || []).map((l) => {
      const med = ctx.mediaOf(l.medium)
      const par = Object.entries(l.params || {}).filter(([, v]) => v !== null && v !== '' && v !== undefined)
        .map(([k, v]) => `${k}=${v}`).join('; ')
      return {
        a: nameOf(l.a.modId), ap: l.a.portKey, b: nameOf(l.b.modId), bp: l.b.portKey,
        med: med ? med.zh : l.medium, tier: TIER_ZH[ctx.tierOf(l.medium)] || '',
        role: l.role === 'backup' ? '备份' : '主用', par
      }
    })
  }))

  if (result) {
    // ── ④ 业务流结果（逐向一行：一个方案是双向的，两向绝不合成一行）──
    const fr = []
    for (const f of result.flows || []) {
      for (const d of f.dirs || []) {
        fr.push({
          flow: f.name, dir: dirZh(d.dir), from: d.fromName, to: d.toName,
          rate: rate(d.rateBps), cap: rate(d.capacityBps), bott: d.bottleneckLabel,
          mar: num(d.marginDb), weak: d.weakestLabel,
          lat: num(d.latencyMs, 2), av: num(d.availPct, 5),
          quoted: (d.quotedSegs || []).join('；'),
          err: (d.errors || []).join('；')
        })
      }
    }
    sheets.push(sheetModel({
      name: '业务流结果',
      cols: [
        { key: 'flow', label: '业务流' }, { key: 'dir', label: '方向' }, { key: 'from', label: '起' }, { key: 'to', label: '止' },
        { key: 'rate', label: '业务速率' }, { key: 'cap', label: '可承载速率' }, { key: 'bott', label: '瓶颈段' },
        { key: 'mar', label: '余量', unit: 'dB', num: true, fix: 2 }, { key: 'weak', label: '最弱 RF 段' },
        { key: 'lat', label: '时延', unit: 'ms', num: true, fix: 2 }, { key: 'av', label: '可用度', unit: '%', num: true, fix: 5 },
        { key: 'quoted', label: '契约段（数值为承诺值）' }, { key: 'err', label: '诊断' }
      ],
      rows: fr,
      note: '一个方案是双向的：两个方向各自成链，余量与瓶颈几乎从不在同一段上，故逐向一行、绝不合成。'
    }))

    // ── ⑤ 逐段读数（★三档判据分列，不折算成同一个数）──
    const sr = []
    for (const f of result.flows || []) {
      for (const d of f.dirs || []) {
        for (const s of d.segments || []) {
          const chk = (s.checks || []).filter((c) => c.actual != null)
          const base = {
            flow: f.name, dir: dirZh(d.dir), seg: s.label || (s.names || []).join(' → '),
            tier: TIER_ZH[s.tier] || s.tier,
            mar: s.tier === 'power' ? num(s.marginDb) : null,
            lat: num(s.latencyMs, 3), av: num(s.availPct, 5),
            cap: s.capacityBps != null ? rate(s.capacityBps) : '',
            note: (s.notes || []).join('；')
          }
          if (!chk.length) { sr.push(base); continue }
          for (const c of chk) {
            sr.push(Object.assign({}, base, {
              item: c.label, actual: num(c.actual, 3), lim: num(c.limit, 3), unit: c.unit,
              rel: c.low ? '≥' : '≤', src: c.src || ''
            }))
          }
        }
      }
    }
    sheets.push(sheetModel({
      name: '逐段读数',
      cols: [
        { key: 'flow', label: '业务流' }, { key: 'dir', label: '方向' }, { key: 'seg', label: '段' }, { key: 'tier', label: '判据档' },
        { key: 'mar', label: '余量', unit: 'dB', num: true, fix: 2 },
        { key: 'item', label: '校验项' }, { key: 'actual', label: '实际', num: true, fix: 3 },
        { key: 'rel', label: '关系' }, { key: 'lim', label: '上/下限', num: true, fix: 3 }, { key: 'unit', label: '单位' },
        { key: 'cap', label: '可承载' }, { key: 'lat', label: '时延', unit: 'ms', num: true, fix: 3 },
        { key: 'av', label: '可用度', unit: '%', num: true, fix: 5 }, { key: 'src', label: '判据出处' }, { key: 'note', label: '说明' }
      ],
      rows: sr,
      note: '★ 余量列只有功率预算档才有值：约束校验档给的是「实际 vs 上/下限」，契约档的数字是承诺值不是计算值。三者不可折算成同一个口径。'
    }))

    // ── ⑥ 能量账 ──
    const er = (result.modules || []).filter((m) => m.energy).map((m) => {
      const e = m.energy, sp = e.supply || {}
      return {
        name: m.name, need: num(e.load.whPerDay, 2), kind: sp.kind,
        gen: sp.genWhPerDay != null ? num(sp.genWhPerDay, 1) : null,
        worst: sp.worstMonth ? sp.worstMonth.zh : '',
        needWp: sp.needWp != null ? num(sp.needWp, 1) : null,
        aut: sp.autonomyDays != null ? num(sp.autonomyDays, 2) : (sp.daysSupported != null ? num(sp.daysSupported, 2) : null),
        needAh: sp.needAh != null ? num(sp.needAh, 0) : null,
        est: sp.estimated ? '光伏为估算（Kt 由用户给定）' : '',
        note: (sp.notes || []).join('；')
      }
    })
    if (er.length) {
      sheets.push(sheetModel({
        name: '能量账',
        cols: [
          { key: 'name', label: '模块' }, { key: 'need', label: '日能耗', unit: 'Wh/d', num: true, fix: 2 },
          { key: 'kind', label: '供电方式' }, { key: 'gen', label: '日发电（最差月）', unit: 'Wh/d', num: true, fix: 1 },
          { key: 'worst', label: '最差月' }, { key: 'needWp', label: '所需组件', unit: 'Wp', num: true, fix: 1 },
          { key: 'aut', label: '自主天数', unit: 'd', num: true, fix: 2 }, { key: 'needAh', label: '所需容量', unit: 'Ah', num: true, fix: 0 },
          { key: 'est', label: '口径' }, { key: 'note', label: '说明' }
        ],
        rows: er,
        note: '能量账与 dB 账并列，两者不折算、不混算。光伏走真太阳几何（Duffie & Beckman）＋用户给定的晴空指数 Kt，故标为估算。'
      }))
    }
  }
  return sheets
}

/** 一键导出（走主进程保存框；版式档 report＝三线表，与链路预算报告同款） */
export async function exportSceneReport(ctx) {
  const sheets = buildSceneSheets(ctx)
  return exportSheets({
    defaultName: safeFileName((ctx.scene.name || '应用场景') + '_方案报告', '方案报告') + '.xlsx',
    title: (ctx.scene.name || '应用场景') + ' · 方案报告',
    style: 'report',
    sheets
  })
}
