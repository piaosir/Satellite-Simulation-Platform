// 转发器频率计划 · 容量规划（渲染端 ESM）。
//
// 口径承接平台既有的「功率带宽」（功率占用 × 转发器带宽，见 LbCapFoot）：一个转发器同时受
// 两条约束，两条都以 MHz 计、可直接与转发器带宽相比——
//   · 带宽占用 Σ occBwMHz   （载波频谱实占，= Rs × (1+α)）
//   · 功率占用 Σ pwrBwMHz   （载波从转发器功率里拿走的等效带宽）
// 功带平衡即两者相等；带宽占用大 = 受带宽限，功率占用大 = 受功率限。这里不下文字结论，
// 只把两个数并列摆出来（遵循平台「结果输出纯数字」口径）。

import { resolveAll, resolveChannel, channelByNo, beamLabel } from './freqPlanModel.js'

export function newCarrier(patch = {}) {
  return {
    id: patch.id || ('cr' + Math.random().toString(36).slice(2, 9)),
    name: patch.name || '载波',
    channelNo: patch.channelNo || '',        // 归属转发器编号（空 = 未分配）
    fcMHz: Number.isFinite(Number(patch.fcMHz)) ? Number(patch.fcMHz) : null,   // 上行中心频率；null = 待自动排布
    occBwMHz: Number.isFinite(Number(patch.occBwMHz)) ? Number(patch.occBwMHz) : null,
    pwrBwMHz: Number.isFinite(Number(patch.pwrBwMHz)) ? Number(patch.pwrBwMHz) : null,
    infoRateKbps: Number.isFinite(Number(patch.infoRateKbps)) ? Number(patch.infoRateKbps) : null,
    modcod: patch.modcod || '',
    pol: patch.pol || '',
    linkId: patch.linkId || '',              // 来自链路预算的行号，便于回溯
    note: patch.note || ''
  }
}

const GUARD_DEFAULT = 0.0   // 保护带默认 0（是否留、留多少是工程口径，交由界面给值）

/**
 * 计算装填结果。
 * @param {object} plan 频率计划
 * @param {Array} carriers 载波列表
 * @param {object} opts { guardMHz }
 */
export function computeLoading(plan, carriers, opts = {}) {
  const guard = Number.isFinite(Number(opts.guardMHz)) ? Number(opts.guardMHz) : GUARD_DEFAULT
  const rs = resolveAll(plan).filter((r) => r.kind === 'transponder')
  const byNo = new Map(rs.map((r) => [String(r.no), r]))

  const tps = rs.map((r) => ({
    channelId: r.id,
    no: r.no,
    bwMHz: r.up?.bw ?? r.dn?.bw ?? null,
    f1: r.up?.f1 ?? null,
    f2: r.up?.f2 ?? null,
    pol: r.up?.pol ?? null,
    // 表内行尾的短标签（带宽另有一列，不重复写）。多波束的转发器写成「A + B」。
    beam: (r.beamsUp || []).map((b) => b.name).filter(Boolean).join(' + '),
    // 汇总按【波束集合】分，不按第一个波束分：一条同时落在 A+B 的转发器与只落在 A 的不是同一组，
    // 并到 A 里去会让 A 的容量把复用出去的那份也算成自己的。同名不同带宽仍是两组（分的是 id）。
    beamId: (r.beamsUp || []).map((b) => b.id).join('|'),
    beamText: (r.beamsUp || []).map((b) => beamLabel(b)).join(' + '),
    carriers: [],
    occSum: 0,
    pwrSum: 0,
    rateSum: 0,
    issues: []
  }))
  const tpByNo = new Map(tps.map((t) => [String(t.no), t]))

  const unassigned = []
  for (const c of carriers || []) {
    const t = c.channelNo ? tpByNo.get(String(c.channelNo)) : null
    if (!t) { unassigned.push(c); continue }
    t.carriers.push(c)
    t.occSum += Number(c.occBwMHz) || 0
    t.pwrSum += Number(c.pwrBwMHz) || 0
    t.rateSum += Number(c.infoRateKbps) || 0
  }

  for (const t of tps) {
    t.count = t.carriers.length
    if (Number.isFinite(t.bwMHz) && t.bwMHz > 0) {
      t.bwUtil = t.occSum / t.bwMHz
      t.pwrUtil = t.pwrSum / t.bwMHz
      t.bwFreeMHz = t.bwMHz - t.occSum
      t.pwrFreeMHz = t.bwMHz - t.pwrSum
      // 带宽/功率两条约束里更紧的那条决定还能装多少
      t.freeMHz = Math.min(t.bwFreeMHz, t.pwrFreeMHz)
      // 需要的保护带总量（n 个载波之间 n-1 段 + 两端各半段）
      t.guardNeedMHz = t.count > 0 ? guard * t.count : 0
      if (t.occSum + t.guardNeedMHz > t.bwMHz + 1e-6) {
        t.issues.push({ code: 'bwOver', msg: `占用带宽 ${fx(t.occSum)} + 保护带 ${fx(t.guardNeedMHz)} 超转发器带宽 ${fx(t.bwMHz)} MHz`, over: t.occSum + t.guardNeedMHz - t.bwMHz })
      }
      if (t.pwrSum > t.bwMHz + 1e-6) {
        t.issues.push({ code: 'pwrOver', msg: `功率带宽 ${fx(t.pwrSum)} 超转发器带宽 ${fx(t.bwMHz)} MHz`, over: t.pwrSum - t.bwMHz })
      }
    } else {
      t.bwUtil = null; t.pwrUtil = null; t.freeMHz = null
      if (t.count) t.issues.push({ code: 'nobw', msg: `转发器 ${t.no} 未给带宽 — 无法核占用` })
    }

    // 载波频率越界 / 载波间重叠（只在给了中心频率的载波之间查）
    const placed = t.carriers.filter((c) => Number.isFinite(c.fcMHz) && Number.isFinite(c.occBwMHz))
      .map((c) => ({ c, a: c.fcMHz - c.occBwMHz / 2, b: c.fcMHz + c.occBwMHz / 2 }))
      .sort((u, v) => u.a - v.a)
    for (const p of placed) {
      if (Number.isFinite(t.f1) && (p.a < t.f1 - 1e-6 || p.b > t.f2 + 1e-6)) {
        t.issues.push({ code: 'outOfBand', msg: `载波「${p.c.name}」${fx(p.a)}~${fx(p.b)} 越出转发器 ${fx(t.f1)}~${fx(t.f2)} MHz`, carrierId: p.c.id })
      }
    }
    for (let i = 1; i < placed.length; i++) {
      const gap = placed[i].a - placed[i - 1].b
      if (gap < -1e-6) {
        t.issues.push({ code: 'carrierOverlap', msg: `载波「${placed[i - 1].c.name}」与「${placed[i].c.name}」重叠 ${fx(-gap)} MHz`, carrierId: placed[i].c.id })
      } else if (guard > 0 && gap < guard - 1e-6) {
        t.issues.push({ code: 'guardShort', msg: `载波「${placed[i - 1].c.name}」与「${placed[i].c.name}」间隔 ${fx(gap)} < 保护带 ${fx(guard)} MHz`, carrierId: placed[i].c.id })
      }
    }
  }

  // 整星汇总
  const withBw = tps.filter((t) => Number.isFinite(t.bwMHz))
  const totalBw = withBw.reduce((s, t) => s + t.bwMHz, 0)
  const totalOcc = tps.reduce((s, t) => s + t.occSum, 0)
  const totalPwr = tps.reduce((s, t) => s + t.pwrSum, 0)
  const totalRate = tps.reduce((s, t) => s + t.rateSum, 0)
  const usedTp = tps.filter((t) => t.count > 0).length

  // 按「波束/带宽」组汇总（一颗多波束星最关心的就是「每个波束卖出去多少」）
  const beamMap = new Map()
  for (const t of tps) {
    const k = t.beamId || ''
    if (!beamMap.has(k)) beamMap.set(k, { beamId: k, beam: t.beamText || '（未分波束）', tpCount: 0, bwMHz: 0, occMHz: 0, pwrMHz: 0, rateKbps: 0, carriers: 0 })
    const g = beamMap.get(k)
    g.tpCount++
    g.bwMHz += Number(t.bwMHz) || 0
    g.occMHz += t.occSum; g.pwrMHz += t.pwrSum; g.rateKbps += t.rateSum; g.carriers += t.count
  }

  return {
    transponders: tps,
    unassigned,
    byBeam: [...beamMap.values()],
    summary: {
      tpTotal: tps.length,
      tpUsed: usedTp,
      totalBwMHz: totalBw,
      occupiedBwMHz: totalOcc,
      powerBwMHz: totalPwr,
      bwUtil: totalBw > 0 ? totalOcc / totalBw : null,
      pwrUtil: totalBw > 0 ? totalPwr / totalBw : null,
      freeBwMHz: totalBw - Math.max(totalOcc, totalPwr),
      totalRateKbps: totalRate,
      totalRateMbps: totalRate / 1000,
      // 频谱效率按已占用带宽算（不是按总带宽——空着的转发器不该拉低效率读数）
      avgEffBpsHz: totalOcc > 0 ? (totalRate * 1000) / (totalOcc * 1e6) : null,
      carrierCount: (carriers || []).length,
      unassignedCount: unassigned.length,
      issueCount: tps.reduce((s, t) => s + t.issues.length, 0)
    }
  }
}

const fx = (v) => (Number.isFinite(v) ? (Math.round(v * 100) / 100).toString() : '—')

/**
 * 自动排布：把未定中心频率的载波在其所属转发器内依次摆开（首次适配 + 保护带）。
 * 返回新的载波数组（不改原数组——排布是可撤销的动作，原地改会让「撤销」无处可退）。
 */
export function autoPlace(plan, carriers, opts = {}) {
  const guard = Number.isFinite(Number(opts.guardMHz)) ? Number(opts.guardMHz) : GUARD_DEFAULT
  const out = (carriers || []).map((c) => ({ ...c }))
  const rs = resolveAll(plan).filter((r) => r.kind === 'transponder')
  const byNo = new Map(rs.map((r) => [String(r.no), r]))

  const groups = new Map()
  for (const c of out) {
    if (!c.channelNo) continue
    if (!groups.has(c.channelNo)) groups.set(c.channelNo, [])
    groups.get(c.channelNo).push(c)
  }

  for (const [no, list] of groups) {
    const r = byNo.get(String(no))
    if (!r || !r.up || !Number.isFinite(r.up.f1)) continue
    // 已定频的先占位，未定频的往空隙里塞
    const fixed = list.filter((c) => Number.isFinite(c.fcMHz) && Number.isFinite(c.occBwMHz))
      .map((c) => ({ a: c.fcMHz - c.occBwMHz / 2, b: c.fcMHz + c.occBwMHz / 2 }))
      .sort((u, v) => u.a - v.a)
    let cursor = r.up.f1
    const advance = () => {
      // 跳过与已定频载波冲突的区间
      for (const f of fixed) {
        if (cursor < f.b + guard && cursor + 1e-9 > f.a - guard - 1e-9) cursor = f.b + guard
      }
    }
    for (const c of list) {
      if (Number.isFinite(c.fcMHz)) continue
      const bw = Number(c.occBwMHz)
      if (!Number.isFinite(bw) || bw <= 0) continue
      advance()
      if (cursor + bw > r.up.f2 + 1e-6) { c.fcMHz = null; c.note = (c.note ? c.note + '；' : '') + '转发器内已无足够连续带宽'; continue }
      c.fcMHz = Math.round((cursor + bw / 2) * 1000) / 1000
      cursor += bw + guard
    }
  }
  return out
}

/**
 * 从链路预算的链路表行提取载波。行的字段名对齐三个链路预算窗口的结果口径。
 * 取不到的项留 null——宁可空着让人看见，也不猜一个数填进去。
 */
export function carriersFromLinkRows(rows, opts = {}) {
  return (rows || []).map((row, i) => {
    const r = row || {}
    const occ = firstNum(r.occupiedBandwidth, r.allocatedBandwidth, r.occBwMHz, r.bandwidthMHz)
    const pwr = firstNum(r.powerBandwidth, r.pwrBwMHz, r.powerBandwidthMHz)
    return newCarrier({
      name: r.name || r.configName || r.basebandName || `载波 ${i + 1}`,
      channelNo: r.channelNo || r.transponderNo || '',
      occBwMHz: occ,
      pwrBwMHz: pwr,
      infoRateKbps: firstNum(r.infoRate, r.infoRateKbps),
      modcod: [r.modulation, r.fec].filter(Boolean).join(' '),
      pol: r.uplinkPolarization || '',
      linkId: r._id || r.id || String(i)
    })
  })
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = Number(v)
    if (Number.isFinite(n) && n !== 0) return n
  }
  for (const v of vals) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}
