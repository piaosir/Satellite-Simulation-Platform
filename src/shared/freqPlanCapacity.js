// 转发器频率计划 · 频率分配表（渲染端 ESM）。
//
// 两件事在这一份里：
//   ① 装填核算（computeLoading）—— 口径承接平台既有的「功率带宽」（功率占用 × 转发器带宽，
//      见 LbCapFoot）：一个转发器同时受两条约束，两条都以 MHz 计、可直接与转发器带宽相比——
//        · 带宽占用 Σ occBwMHz   （载波频谱实占，= Rs × (1+α)）
//        · 功率占用 Σ pwrBwMHz   （载波从转发器功率里拿走的等效带宽）
//      功带平衡即两者相等；带宽占用大 = 受带宽限，功率占用大 = 受功率限。这里不下文字结论，
//      只把两个数并列摆出来（遵循平台「结果输出纯数字」口径）。
//   ② 分配表行模型（buildAllocation）—— 逐转发器成组、组内逐载波一行的那张表，体例照
//      运营内部的「转发器装载表 / 载波分配清单」（Intelsat 式）：组头写转发器身份，组内每条载波
//      写【起—中—止】三个频率与两条带宽，组末小计、表末整星合计。核算仍走 ①，这一层只排版。
//
// 两条贯穿全篇的口径：
//   · 【归属】载波挂在转发器的 **id** 上，不挂编号 —— 编号可以重（一份计划里两条 C1 是常事：
//     不同波束/不同极化各一条），按编号归属时第二条永远抢不到自己的载波。只存过编号的老载波
//     退回按编号认第一条同号的（见 tpFinder）。
//   · 【域】载波的 fcMHz 存的恒是【上行】中心频率（载波的身份是它从地面打在哪个频点上，下行随
//     所属转发器的 LO 走）；opts.side 只决定几何与读数落在哪一侧。分配表界面走 side='dn'
//     —— 现场的载波管理只认下行。收发不等宽的转发器（18 上 / 36 下）下行频带不是上行频带的
//     平移，故 side='dn' 时频带真取下行，只有载波中心是按 Δ 换过去的。

import {
  resolveAll, resolveChannel, channelByNo, beamLabel, fmtFreqNum, unitLabel, cleanFreq
} from './freqPlanModel.js'

// ★ Number(null) 是 0、Number('') 也是 0：显式传 null 的字段（复制粘贴整条载波、从链路表提取时
//   取不到的那几项）若直接 Number 一下，「没有这个数」就成了「填了 0」—— 一条没定频的载波会被
//   搬到零频去、一条没给带宽的会算成 0 占用。故走这一个收口。
const numOrNull = (v) => {
  const x = (v === '' || v == null) ? NaN : Number(v)
  return Number.isFinite(x) ? x : null
}

export function newCarrier(patch = {}) {
  return {
    id: patch.id || ('cr' + Math.random().toString(36).slice(2, 9)),
    name: patch.name || '载波',
    // 归属转发器：★ id 是主键。编号可以重（一份计划里两条 C1 是常事：不同波束/不同极化各一条），
    // 按编号归属时第二条永远抢不到自己的载波 —— 加上去的那条会落到同号的另一条上。
    // channelNo 留着当读数与老计划（只存过编号）的兼容口，取组一律先认 id。
    channelId: patch.channelId || '',
    channelNo: patch.channelNo || '',        // 归属转发器编号（空 = 未分配）
    // ★ 存的恒是【上行】中心频率：载波的身份是它从地面打在哪一个频点上，下行随所属转发器的 LO 走
    //   （改一次 LO，整条转发器连同它的载波在下行域一起平移，这正是物理事实）。
    //   界面按哪一侧写是另一件事（分配表只写下行，见 side 选项）。null = 待自动排布。
    fcMHz: numOrNull(patch.fcMHz),
    occBwMHz: numOrNull(patch.occBwMHz),
    pwrBwMHz: numOrNull(patch.pwrBwMHz),
    infoRateKbps: numOrNull(patch.infoRateKbps),
    modcod: patch.modcod || '',
    pol: patch.pol || '',
    // 钉死的波束（空 = 随所属转发器，见 rowBeam）。DTP 载荷一条转发器上挂几个波束，
    // 哪一条载波算在哪个波束上不是频率能一概而论的，故留一个显式覆盖口。
    beamId: patch.beamId || '',
    linkId: patch.linkId || '',              // 来自链路预算的行号，便于回溯
    note: patch.note || ''
  }
}

const GUARD_DEFAULT = 0.0   // 保护带默认 0（是否留、留多少是工程口径，交由界面给值）

// 载波挂在哪条转发器上：先认 id，老载波（只存过编号）退回按编号认第一条同号的。
function tpFinder(list, idOf, noOf) {
  const byId = new Map()
  const byNo = new Map()
  for (const t of list) {
    byId.set(idOf(t), t)
    const k = String(noOf(t) ?? '')
    if (k && !byNo.has(k)) byNo.set(k, t)     // 同号多条 → 老载波落在第一条上（新载波按 id 归属）
  }
  return (c) => (c.channelId && byId.get(c.channelId)) || (c.channelNo ? byNo.get(String(c.channelNo)) : null) || null
}

// 存储域（上行）↔ 工作域（side 那一侧）。Δ = f上 − f下，取实测差而不是取 LO —— cross-strap 的
// 转发器下行是显式填的、与 LO 无关，但整条频带仍是同量平移，两种接法同一条式子。
const xlateOf = (r) => ((r?.up?.fc != null && r?.dn?.fc != null) ? cleanFreq(r.up.fc - r.dn.fc) : null)

/**
 * 计算装填结果。
 * @param {object} plan 频率计划
 * @param {Array} carriers 载波列表
 * @param {object} opts { guardMHz, unit, side } —— unit 只影响提示语里那几个数的写法（内部一律 MHz），
 *   与表上、图上共用工具栏那一把尺子；默认 MHz，与内部存储一致。
 *   side = 'up' | 'dn'：几何（频带、越界、重叠、保护带）在哪一侧上算。载波存的恒是上行中心频率，
 *   side='dn' 时逐条按该转发器的 Δ 换到下行域再比 —— 收发不等宽的转发器（18 上 / 36 下）
 *   下行频带不是上行频带的平移，故不能拿上行的两端减个 Δ 冒充下行。默认 'up'。
 */
export function computeLoading(plan, carriers, opts = {}) {
  const guard = Number.isFinite(Number(opts.guardMHz)) ? Number(opts.guardMHz) : GUARD_DEFAULT
  const unit = opts.unit || 'MHz'
  const side = opts.side === 'dn' ? 'dn' : 'up'
  const uu = unitLabel(unit)
  const fx = (v) => (Number.isFinite(v) ? fmtFreqNum(v, unit) : '—')
  const rs = resolveAll(plan).filter((r) => r.kind === 'transponder')

  const tps = rs.map((r) => {
    const b = side === 'dn' ? r.dn : r.up
    const beams = (side === 'dn' ? r.beamsDn : r.beamsUp) || []
    return {
      channelId: r.id,
      no: r.no,
      side,
      // 工作侧的频带。side='up' 时带宽仍留着「上行没填就取下行」那条回退（老口径）。
      bwMHz: side === 'dn' ? (r.dn?.bw ?? null) : (r.up?.bw ?? r.dn?.bw ?? null),
      fc: b?.fc ?? null,
      f1: b?.f1 ?? null,
      f2: b?.f2 ?? null,
      pol: b?.pol ?? null,
      // 另一侧的读数（分配表只写工作侧，但组头/导出仍可能要两侧并排）。r.dn 已经把「显式填的」与
      // 「由 LO 推的」合成了一个数，故这里不必再分联动/解耦两种情形。
      upFc: r.up?.fc ?? null,
      upF1: r.up?.f1 ?? null,
      upF2: r.up?.f2 ?? null,
      upPol: r.up?.pol ?? null,
      dnFc: r.dn?.fc ?? null,
      dnF1: r.dn?.bw != null ? r.dn.f1 : null,
      dnF2: r.dn?.bw != null ? r.dn.f2 : null,
      dnPol: r.dn?.pol ?? null,
      xlateMHz: xlateOf(r),
      // 表内行尾的短标签（带宽另有一列，不重复写）。多波束的转发器写成「A + B」。
      beam: beams.map((x) => x.name).filter(Boolean).join(' + '),
      // 汇总按【波束集合】分，不按第一个波束分：一条同时落在 A+B 的转发器与只落在 A 的不是同一组，
      // 并到 A 里去会让 A 的容量把复用出去的那份也算成自己的。同名不同带宽仍是两组（分的是 id）。
      beamId: beams.map((x) => x.id).join('|'),
      beamText: beams.map((x) => beamLabel(x, unit)).join(' + '),
      // 这一侧挂着的波束与它们在本转发器频带里各占的段 —— 载波按频率认领波束靠它（见 rowBeam）
      beams,
      segs: (side === 'dn' ? r.segsDn : r.segsUp) || [],
      // 同频叠放时载波默认归哪个波束（见 rowBeam）。留空 = 第一个
      carrierBeamId: r.raw?.carrierBeamId || '',
      carriers: [],
      occSum: 0,
      pwrSum: 0,
      rateSum: 0,
      issues: []
    }
  })

  const findTp = tpFinder(tps, (t) => t.channelId, (t) => t.no)
  // 载波中心落到工作域：side='up' 就是它自己；side='dn' 减去该转发器的 Δ（Δ 缺 → 这一侧无从谈起）
  const wFc = (c, t) => {
    const x = Number.isFinite(c.fcMHz) ? c.fcMHz : null
    if (x == null) return null
    if (side === 'up') return x
    return t && Number.isFinite(t.xlateMHz) ? cleanFreq(x - t.xlateMHz) : null
  }

  const unassigned = []
  for (const c of carriers || []) {
    const t = findTp(c)
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
        t.issues.push({ code: 'bwOver', msg: `占用带宽 ${fx(t.occSum)} + 保护带 ${fx(t.guardNeedMHz)} 超转发器带宽 ${fx(t.bwMHz)} ${uu}`, over: t.occSum + t.guardNeedMHz - t.bwMHz })
      }
      if (t.pwrSum > t.bwMHz + 1e-6) {
        t.issues.push({ code: 'pwrOver', msg: `功率带宽 ${fx(t.pwrSum)} 超转发器带宽 ${fx(t.bwMHz)} ${uu}`, over: t.pwrSum - t.bwMHz })
      }
    } else {
      t.bwUtil = null; t.pwrUtil = null; t.freeMHz = null
      if (t.count) {
        t.issues.push({
          code: 'nobw',
          msg: side === 'dn' ? `转发器 ${t.no} 没有下行频带 — 无法核占用` : `转发器 ${t.no} 未给带宽 — 无法核占用`
        })
      }
    }

    // 载波频率越界 / 载波间重叠（只在给了中心频率的载波之间查）。几何一律在工作侧上算。
    const placed = t.carriers.map((c) => ({ c, w: wFc(c, t) }))
      .filter((p) => Number.isFinite(p.w) && Number.isFinite(p.c.occBwMHz))
      .map((p) => ({ c: p.c, a: p.w - p.c.occBwMHz / 2, b: p.w + p.c.occBwMHz / 2 }))
      .sort((u, v) => u.a - v.a)
    for (const p of placed) {
      if (Number.isFinite(t.f1) && (p.a < t.f1 - 1e-6 || p.b > t.f2 + 1e-6)) {
        t.issues.push({ code: 'outOfBand', msg: `载波「${p.c.name}」${fx(p.a)}~${fx(p.b)} 越出转发器 ${fx(t.f1)}~${fx(t.f2)} ${uu}`, carrierId: p.c.id })
      }
    }
    for (let i = 1; i < placed.length; i++) {
      const gap = placed[i].a - placed[i - 1].b
      if (gap < -1e-6) {
        t.issues.push({ code: 'carrierOverlap', msg: `载波「${placed[i - 1].c.name}」与「${placed[i].c.name}」重叠 ${fx(-gap)} ${uu}`, carrierId: placed[i].c.id })
      } else if (guard > 0 && gap < guard - 1e-6) {
        t.issues.push({ code: 'guardShort', msg: `载波「${placed[i - 1].c.name}」与「${placed[i].c.name}」间隔 ${fx(gap)} < 保护带 ${fx(guard)} ${uu}`, carrierId: placed[i].c.id })
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

/**
 * 自动排布：把未定中心频率的载波在其所属转发器内依次摆开（首次适配 + 保护带）。
 * 返回新的载波数组（不改原数组——排布是可撤销的动作，原地改会让「撤销」无处可退）。
 */
export function autoPlace(plan, carriers, opts = {}) {
  const guard = Number.isFinite(Number(opts.guardMHz)) ? Number(opts.guardMHz) : GUARD_DEFAULT
  const side = opts.side === 'dn' ? 'dn' : 'up'
  const out = (carriers || []).map((c) => ({ ...c }))
  const rs = resolveAll(plan).filter((r) => r.kind === 'transponder')
  const findTp = tpFinder(rs, (r) => r.id, (r) => r.no)

  const groups = new Map()
  for (const c of out) {
    const r = findTp(c)
    if (!r) continue
    if (!groups.has(r.id)) groups.set(r.id, { r, list: [] })
    groups.get(r.id).list.push(c)
  }

  for (const { r, list } of groups.values()) {
    const b = side === 'dn' ? r.dn : r.up
    if (!b || !Number.isFinite(b.f1) || !Number.isFinite(b.f2)) continue
    // Δ：存储域（上行）↔ 工作域。side='up' 时是 0，整段逐点同从前
    const dx = side === 'dn' ? xlateOf(r) : 0
    if (dx == null) continue                          // 没有下行 → 这一侧排不了，留着不动
    const w = (x) => cleanFreq(x - dx)                // 存储 → 工作
    const s = (x) => cleanFreq(x + dx)                // 工作 → 存储
    // 已定频的先占位，未定频的往空隙里塞
    const fixed = list.filter((c) => Number.isFinite(c.fcMHz) && Number.isFinite(c.occBwMHz))
      .map((c) => ({ a: w(c.fcMHz) - c.occBwMHz / 2, b: w(c.fcMHz) + c.occBwMHz / 2 }))
      .sort((u, v) => u.a - v.a)
    // ★ 空隙按【区间】求，不是拿一个游标点去躲已定频载波：只看游标落没落在禁区里的话，一条比
    //   眼前那截空隙宽的载波会从空隙起点直接横穿到已定频载波身上（一键动作产出即非法），也不会
    //   跳到它后面那段空着的去。保护带在每条已定频载波两侧各让一段，与 computeLoading 的
    //   guardShort 同口径（那边是任意相邻两条之间都要够 guard）。
    const gaps = []
    let cursor = b.f1
    for (const f of fixed) {
      if (f.a - guard - cursor > 1e-9) gaps.push({ x: cursor, end: f.a - guard })
      if (f.b + guard > cursor) cursor = f.b + guard
    }
    if (b.f2 - cursor > 1e-9) gaps.push({ x: cursor, end: b.f2 })
    for (const c of list) {
      if (Number.isFinite(c.fcMHz)) continue
      const bw = Number(c.occBwMHz)
      if (!Number.isFinite(bw) || bw <= 0) continue
      const g = gaps.find((q) => q.x + bw <= q.end + 1e-6)
      if (!g) { c.fcMHz = null; c.note = (c.note ? c.note + '；' : '') + '转发器内已无足够连续带宽'; continue }
      c.fcMHz = s(Math.round((g.x + bw / 2) * 1000) / 1000)
      g.x += bw + guard
    }
  }
  return out
}

/**
 * 载波频带的一端（起始 / 终止）—— 分配表是照着「起~止」录的，不是照着中心录的。
 * 口径与转发器那两格逐条对齐（见 freqPlanModel 的 setChannelEdge），四条分支同名同义：
 *   'resize' 另一端钉住、占用带宽随之变（常态）   · 'shift' 越过另一端 → 带宽不变、整条载波平移
 *   'span'   带宽未定 → 中心钉住、由这一端定出带宽 · 'set'   中心未定 → 由这一端 + 带宽落定
 *   null     没落值（空值 / 数值不成立）
 * 纯函数：返回 { mode, fcMHz, occBwMHz }，落到哪一条由调用方 patch —— 容量页的载波数组是
 * emit 出去的不可变值，原地改会绕开 update:carriers 这一个收口。
 * @param {object} c 载波   @param {'f1'|'f2'} which 哪一端   @param {number} v 上行域的 MHz
 */
export function setCarrierEdge(c, which, v) {
  // 空值不落（起止两格不吃空：清一条载波的频率去中心那一格清）。★ 不能直接 Number(v)——Number('') 是 0，
  // 清空这一格会被当成「填了 0 MHz」，整条载波被搬到零频去。
  const x = (v === '' || v == null) ? NaN : Number(v)
  if (!Number.isFinite(x)) return null
  const lo = which !== 'f2'
  const fc = Number.isFinite(c?.fcMHz) ? c.fcMHz : null
  const bw = Number.isFinite(c?.occBwMHz) && c.occBwMHz > 0 ? c.occBwMHz : null
  const out = (nfc, nbw, mode) => ({ mode, fcMHz: cleanFreq(nfc), occBwMHz: nbw == null ? (bw ?? null) : cleanFreq(nbw) })
  if (fc == null) {
    if (bw == null) return null                      // 中心与带宽都还没有 —— 一端定不出一段频带
    return out(lo ? x + bw / 2 : x - bw / 2, null, 'set')
  }
  if (bw == null) {
    const nbw = (lo ? fc - x : x - fc) * 2
    if (!(nbw > 0)) return null                      // 起始填到中心之上（或反之）→ 负宽，不落
    return out(fc, nbw, 'span')
  }
  const other = lo ? fc + bw / 2 : fc - bw / 2
  const nbw = lo ? other - x : x - other
  if (nbw > 0) return out((x + other) / 2, nbw, 'resize')
  return out(lo ? x + bw / 2 : x - bw / 2, null, 'shift')
}

/**
 * 频率分配表的行模型：逐转发器成组、组内逐载波一行，组末小计、表末整星合计。
 * 核算全部来自 computeLoading（这里一个数都不另算），这一层只做四件事——
 *   ① 把载波的【起—中—止】在上下行两侧各摊开一份（下行按该转发器的 Δ 换算，见 xlateMHz），
 *      并把 opts.side 那一侧挑成 r.f —— 界面读 r.f，读的是哪一侧由调用方一处决定；
 *   ② 组内按工作侧起始频率升序（未定频的排在组末、保持录入序），并给出组内序号；
 *   ③ 逐条认领波束（见 rowBeam）—— 颜色跟着波束走靠它；
 *   ④ 未归属转发器的载波单成一组挂在表末 —— 藏起来只会让人以为它们没录进去。
 * 组上另给两项供界面用：splitSegs = 频带被切开的那几段（有 → 这条按频率认领）、
 * pickBeamId = 同频叠放时这条转发器选定的那个波束（界面在组头上让人改它）。
 * @param {object} opts { guardMHz, unit, side }
 */
export function buildAllocation(plan, carriers, opts = {}) {
  const res = computeLoading(plan, carriers, opts)
  const side = opts.side === 'dn' ? 'dn' : 'up'
  return {
    groups: res.transponders.map((t) => ({
      ...t,
      splitSegs: beamSplitSegs(t),
      pickBeamId: (pickedBeam(t) || {}).id || '',
      rows: allocRows(t.carriers, t, side)
    })),
    unassigned: allocRows(res.unassigned, null, side),
    byBeam: res.byBeam,
    summary: res.summary
  }
}

/**
 * 频带真被切开的那几段 —— 「按频率认领得出结果」的那几段，别的一概不算：
 *   · full 的不算：那几个波束共用整条频带（图上上下分色），频率上分不出谁是谁；
 *   · ★ 铺满整条频带的也不算，哪怕它没打 full 标志 —— 逐格设过占段的转发器不收回同频共用态
 *     （见 freqPlanModel 的 beamSegs），于是「一个波束钉着整条频带」会留成一条满宽的段。
 *     拿它认领 = 整条转发器判给这一个波束，另一个连选都选不出来；
 *   · 压根不沾这条频带的也不算：那是录错或转发器挪过位（校验的 segOut 会指出来），
 *     用它认领只会把频带里的载波判给一个不在场的波束；
 *   · ★ 身上压着别人的也不算：几个波束占同一段频率（同频叠放的常态 —— 27 MHz 的两个波束摆在
 *     32 MHz 的转发器上，谁都没铺满整条频带，故上面那条拦不住它们），频率上照样分不出谁是谁，
 *     与 full 是同一回事。压着的一并去掉，剩下的才是一段一个波束（图上左右分色）；
 *     三个波束里两个叠着、一个单占一段的，那一段仍按频率认得出来，只去掉叠着的那两段。
 *     ★★ 压不压得着要拿【全体】段去比，不能只在上面几条筛剩的里面比：一个铺满整条频带的
 *        波束（那种自己先被筛掉）身下压着的那半条，照样是两个波束共用的一段。
 * ★ 出去的那几段两两不重叠 —— 载波跨段分色（FpAlloc 的 paintOf / gradOf）按这条不变式画：
 *   重叠的段会排出「回头」的渐变停靠点，浏览器把它钳成前一个色，整条载波就涂成头一个波束的色。
 */
export function beamSplitSegs(t) {
  const f1 = t && Number.isFinite(t.f1) ? t.f1 : null
  const f2 = t && Number.isFinite(t.f2) ? t.f2 : null
  const band = f1 != null && f2 != null && f2 > f1
  // 有几何、且沾着这条频带的那几段（含铺满整条频带的）—— 判重叠拿的是这一份全体
  const all = ((t && t.segs) || []).filter((s) => Number.isFinite(s.f1) && Number.isFinite(s.f2) && s.f2 > s.f1
    && (!band || (s.f1 < f2 - 1e-6 && s.f2 > f1 + 1e-6)))
  return all.filter((s) => {
    if (s.full) return false
    if (band && s.f1 <= f1 + 1e-6 && s.f2 >= f2 - 1e-6) return false   // 铺满整条频带
    // 挨着不算叠着：频分排布的相邻两段共一条边（前一段的 f2 = 后一段的 f1）是常态
    return !all.some((o) => o !== s && o.f1 < s.f2 - 1e-6 && o.f2 > s.f1 + 1e-6)
  })
}
// 这条转发器的载波默认归哪个波束：指定过就是它（carrierBeamId），否则第一个
export function pickedBeam(t) {
  const beams = (t && t.beams) || []
  return beams.find((b) => b.id === t.carrierBeamId) || beams[0] || null
}

/**
 * 这一条载波算在哪个波束上。三档，自上而下：
 *   钉死      c.beamId 指到本转发器挂着的某个波束 → 就是它（人手选的最大）；
 *   按频率    频带被切给几个波束时（DTP 载荷的常态），中心落在哪一段就算哪个波束，中心没落进
 *             任何一段则取交叠最多的那一段（见 freqPlanModel 的「波束占段」）；
 *   转发器选定 几个波束同频叠放时频率上分不出谁是谁，取该转发器指定的那一个（留空 = 第一个）。
 * ★ 没有全局开关：切没切开是这条转发器自己的事实，不是一整页的显示模式 —— 同一份计划里
 *   两种转发器并存是常态（一条切成两段给两个波束，另一条两个波束同频复用）。
 */
function rowBeam(r, t) {
  const beams = (t && t.beams) || []
  if (!beams.length) return { beam: null, beamPinned: false, beamFrom: '' }
  if (r.c.beamId) {
    const b = beams.find((x) => x.id === r.c.beamId)
    if (b) return { beam: b, beamPinned: true, beamFrom: 'pin' }
  }
  const segs = beamSplitSegs(t)
  if (segs.length && r.f.fc != null) {
    let hit = segs.find((s) => r.f.fc >= s.f1 - 1e-6 && r.f.fc <= s.f2 + 1e-6)
    if (!hit && r.f.f1 != null) {
      let best = 0
      for (const s of segs) {
        const ov = Math.min(r.f.f2, s.f2) - Math.max(r.f.f1, s.f1)
        if (ov > best) { best = ov; hit = s }
      }
    }
    if (hit) return { beam: hit.beam, beamPinned: false, beamFrom: 'freq' }
  }
  // 认领来源写进行里：导出那份要写「按什么认的」，不能靠 beamPinned 一个布尔反推
  return { beam: pickedBeam(t), beamPinned: false, beamFrom: 'tp' }
}

function allocRows(list, t, side = 'up') {
  const dx = t && Number.isFinite(t.xlateMHz) ? t.xlateMHz : null
  const rows = (list || []).map((c) => {
    const occ = Number.isFinite(c.occBwMHz) && c.occBwMHz > 0 ? c.occBwMHz : null
    const pwr = Number.isFinite(c.pwrBwMHz) ? c.pwrBwMHz : null
    const fc = Number.isFinite(c.fcMHz) ? c.fcMHz : null
    const edges = (x) => ({
      fc: x,
      f1: x != null && occ != null ? cleanFreq(x - occ / 2) : null,
      f2: x != null && occ != null ? cleanFreq(x + occ / 2) : null
    })
    const tpBw = t && Number.isFinite(t.bwMHz) && t.bwMHz > 0 ? t.bwMHz : null
    const up = edges(fc)
    const dn = edges(fc != null && dx != null ? cleanFreq(fc - dx) : null)
    const f = side === 'dn' ? dn : up
    const row = {
      c,
      up,
      dn,
      f,                                   // 工作侧的【起—中—止】：界面读这一份
      occ,
      pwr,
      // 极化留空 = 随所属转发器（界面按灰字继承值显示，同带宽那一格的读法）
      pol: c.pol || (t ? t.pol : '') || '',
      polInherited: !c.pol,
      pctBw: occ != null && tpBw ? occ / tpBw : null,
      pctPwr: pwr != null && tpBw ? pwr / tpBw : null,
      // 工作侧定得下位置才算「定频」：只有上行数、这一侧没有 Δ 的，条上摆不出来
      placed: f.fc != null
    }
    return Object.assign(row, rowBeam(row, t))
  })
  // 定频的按频率排在前，未定频的留在组末（sort 稳定，故它们之间仍是录入序）
  rows.sort((a, b) => (a.placed === b.placed ? (a.placed ? (a.f.f1 ?? a.f.fc) - (b.f.f1 ?? b.f.fc) : 0) : (a.placed ? -1 : 1)))
  rows.forEach((r, i) => { r.idx = i + 1 })
  return rows
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
