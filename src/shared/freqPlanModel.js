// 转发器频率计划 · 数据模型（渲染端 ESM，编辑器窗口 / 链路预算窗口 / 文件区共用）。
//
// ★ 这类图的骨架是 LO，不是图形。四张标准频率计划图（C/Ku/Ka，中星·亚太·前向计划）无一例外满足
//     f_下行 = f_上行 − LO
//   （5950−2320=3630 · 14022−1750=12272 · 14.27−3.3=10.97 …）。于是本模型只存
//   【上行频率 + LO 归属 + 带宽 + 上下行极化 + 波束】，下行是算出来的：
//     · 录入从「填 44 个数字」降为「填首频/步进/数量」（见 genSeries）；
//     · cross-strap（Ku 图 P5~P8→K2/K4/K6/K8 那种上下行不同 LO 的重排）是显式例外——
//       dn.fcMHz 填了值就以填的为准，null 才走 LO 推算。这一个字段同时吃掉两个问题。
//
// 单位：内部一律 MHz（图上 GHz/MHz 混排，入口 toMHz 归一）。极化 H/V（线）与 L/R（圆）并存，
// 且上下行可以不同体制（Ka 前向计划就是上行 R/L、下行 H/V）。

// ---- 单位与基础工具 ----

// 图上频率有 12.77（GHz）与 14022（MHz）两种写法。以 1000 为界判定：卫星通信频率
// 低于 1000 时不可能是 MHz（L 频段最低也在 1500 MHz 上下），故 <1000 一律当 GHz。
export function toMHz(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.abs(n) < 1000 ? n * 1000 : n
}
export const toGHz = (mhz) => (Number.isFinite(Number(mhz)) ? Number(mhz) / 1000 : null)

// 数值归一：null / undefined / 空串 / 非数 一律成 null。
// ★ 不能图省事写 Number.isFinite(Number(v))：Number(null) 和 Number('') 都等于 0，
//   于是「下行留空 = 由 LO 推算」会被存成 0 MHz，推算路径被静默旁路、下行全变 0。
//   留空是这套模型最常走的路径，这个坑必须在入口堵死。
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

let _seq = 0
export function genId(prefix = 'x') {
  _seq = (_seq + 1) % 1e6
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`
}

export const POLS = ['H', 'V', 'L', 'R']
export const POL_LABEL = { H: 'H（水平）', V: 'V（垂直）', L: 'LHCP（左旋）', R: 'RHCP（右旋）' }
// 正交极化对——同频复用的判定依据：同频且正交 = 合法复用，同频且同极化 = 冲突。
export const POL_ORTHO = { H: 'V', V: 'H', L: 'R', R: 'L' }

export const CHANNEL_KINDS = [
  { key: 'transponder', label: '转发器' },
  { key: 'beacon', label: '信标' },
  { key: 'tc', label: '遥控 TC' },
  { key: 'tm', label: '遥测 TM' },
  { key: 'reserved', label: '保留/其他' }
]
export const KIND_LABEL = Object.fromEntries(CHANNEL_KINDS.map((k) => [k.key, k.label]))

// 波束默认配色：取自标准计划图的惯用色（红=区域、黄=全球、绿=东部、蓝=点波束）。
export const DEFAULT_BEAM_COLORS = ['#4472C4', '#E03C31', '#F2C200', '#2E9E5B', '#8E5BC4', '#E07B39', '#4BB3C4', '#C4547E']

// ---- 建模 ----

export function newBeam(patch = {}) {
  return {
    id: patch.id || genId('b'),
    code: patch.code || '',
    name: patch.name || '波束',
    color: patch.color || DEFAULT_BEAM_COLORS[0]
  }
}

export function newLo(patch = {}) {
  return {
    id: patch.id || genId('l'),
    name: patch.name || 'LO',
    // 下变频（转发器常态）：f_dn = f_up − valueMHz，故 valueMHz > 0。上变频场景填负值即可，
    // 推算公式不分支——少一条分支就少一处口径分歧。
    valueMHz: num(patch.valueMHz),
    note: patch.note || ''
  }
}

export function newChannel(patch = {}) {
  const up = patch.up || {}
  const dn = patch.dn || {}
  return {
    id: patch.id || genId('c'),
    no: patch.no != null ? String(patch.no) : '',
    kind: patch.kind || 'transponder',
    up: {
      fcMHz: num(up.fcMHz),
      bwMHz: num(up.bwMHz),
      pol: POLS.includes(up.pol) ? up.pol : 'H'
    },
    loId: patch.loId || '',
    // 全 null = 由 LO 推算；填任意一项即以填的为准（cross-strap / 下行重排 / 收发带宽不等）
    dn: {
      fcMHz: num(dn.fcMHz),
      bwMHz: num(dn.bwMHz),
      pol: POLS.includes(dn.pol) ? dn.pol : (POL_ORTHO[up.pol] || 'V')
    },
    beamUpId: patch.beamUpId || '',
    beamDnId: patch.beamDnId || '',
    switchableBeamIds: Array.isArray(patch.switchableBeamIds) ? patch.switchableBeamIds.slice() : [],
    // 接链路预算用的转发器属性（可留空——留空则链路预算仍用卫星配置里手填的那份）
    sfdDbwm2: num(patch.sfdDbwm2),
    gtDbK: num(patch.gtDbK),
    eirpDbw: num(patch.eirpDbw),
    boiDb: num(patch.boiDb),
    booDb: num(patch.booDb),
    cimDb: num(patch.cimDb),
    note: patch.note || ''
  }
}

export function newPlan(patch = {}) {
  const p = {
    id: patch.id || genId('fp'),
    name: patch.name || '频率计划',
    satFolder: patch.satFolder || '',     // 卫星树节点 key（与 GRD 天线同源，见 useGrdCoverage 的 folder）
    satName: patch.satName || '',
    band: patch.band || 'Ku',
    note: patch.note || '',
    los: (patch.los || []).map(newLo),
    beams: (patch.beams || []).map(newBeam),
    channels: (patch.channels || []).map(newChannel),
    updatedAt: patch.updatedAt || new Date().toISOString()
  }
  return p
}

// 反序列化兜底：老版本 / 手改过的 JSON 都从这里进，缺字段补默认、类型归一。
export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return newPlan()
  const p = newPlan(raw)
  // 通道引用的 LO/波束若已被删，清成空引用而不是留悬挂 id（悬挂 id 会让下行推算静默失败）
  const loIds = new Set(p.los.map((l) => l.id))
  const beamIds = new Set(p.beams.map((b) => b.id))
  for (const ch of p.channels) {
    if (ch.loId && !loIds.has(ch.loId)) ch.loId = ''
    if (ch.beamUpId && !beamIds.has(ch.beamUpId)) ch.beamUpId = ''
    if (ch.beamDnId && !beamIds.has(ch.beamDnId)) ch.beamDnId = ''
    ch.switchableBeamIds = ch.switchableBeamIds.filter((id) => beamIds.has(id))
  }
  return p
}

// ---- LO 推算与解析 ----

export const findLo = (plan, loId) => (plan.los || []).find((l) => l.id === loId) || null
export const findBeam = (plan, beamId) => (plan.beams || []).find((b) => b.id === beamId) || null

// 下行中心频率：显式值优先，否则 f_up − LO。两者都无 → null（渲染时该通道下行为空位）。
export function downlinkFc(plan, ch) {
  if (Number.isFinite(ch?.dn?.fcMHz)) return ch.dn.fcMHz
  const lo = findLo(plan, ch?.loId)
  if (!lo || !Number.isFinite(lo.valueMHz) || !Number.isFinite(ch?.up?.fcMHz)) return null
  return ch.up.fcMHz - lo.valueMHz
}
// 下行带宽默认跟上行（转发器收发带宽一致是常态；不一致时 dn.bwMHz 显式填）
export const downlinkBw = (ch) => (Number.isFinite(ch?.dn?.bwMHz) ? ch.dn.bwMHz : ch?.up?.bwMHz ?? null)

// 通道 → 画图与校验都吃的这一份解析结果。f1/f2 为频段两端（含边界），null 表示该侧未定义。
export function resolveChannel(plan, ch) {
  const upFc = Number.isFinite(ch?.up?.fcMHz) ? ch.up.fcMHz : null
  const upBw = Number.isFinite(ch?.up?.bwMHz) ? ch.up.bwMHz : null
  const dnFc = downlinkFc(plan, ch)
  const dnBw = downlinkBw(ch)
  const half = (bw) => (Number.isFinite(bw) ? bw / 2 : 0)
  return {
    id: ch.id,
    no: ch.no,
    kind: ch.kind,
    up: upFc == null ? null : { fc: upFc, bw: upBw, f1: upFc - half(upBw), f2: upFc + half(upBw), pol: ch.up.pol },
    dn: dnFc == null ? null : { fc: dnFc, bw: dnBw, f1: dnFc - half(dnBw), f2: dnFc + half(dnBw), pol: ch.dn.pol },
    // 下行是推算出来的还是显式填的——渲染端据此给 cross-strap 通道加标记
    dnDerived: !Number.isFinite(ch?.dn?.fcMHz) && dnFc != null,
    lo: findLo(plan, ch.loId),
    beamUp: findBeam(plan, ch.beamUpId),
    beamDn: findBeam(plan, ch.beamDnId) || findBeam(plan, ch.beamUpId),
    switchable: (ch.switchableBeamIds || []).map((id) => findBeam(plan, id)).filter(Boolean),
    raw: ch
  }
}

export const resolveAll = (plan) => (plan.channels || []).map((ch) => resolveChannel(plan, ch))

// 频段跨度：给渲染器定坐标轴。side='up'|'dn'，留 padRatio 的边距。
export function planExtent(plan, side, padRatio = 0.02) {
  const vals = []
  for (const r of resolveAll(plan)) {
    const s = side === 'dn' ? r.dn : r.up
    if (!s) continue
    vals.push(s.f1, s.f2)
  }
  if (!vals.length) return null
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (hi - lo < 1e-6) { lo -= 1; hi += 1 }
  const pad = (hi - lo) * padRatio
  return { min: lo - pad, max: hi + pad, dataMin: lo, dataMax: hi }
}

// ---- 序列生成（录入的主入口）----

// 图上一排转发器几乎总是等差的（C 段 40MHz 步进、Ku 段 41.5MHz 步进…）。
// 给「首频 + 步进 + 数量」即可批量建通道，编号与极化按规则铺开。
//   polMode: 'fixed' 全同极化 | 'alternate' 逐个交替（H,V,H,V…）| 'pair' 两行交错（图上常见的上下两排）
//   noPattern: 'C{n}' 之类的模板，{n} 替换为序号；也可给数组逐个指定
export function genSeries(spec = {}) {
  const {
    count = 1, startFcMHz = 0, stepMHz = 0, bwMHz = 36,
    pol = 'H', polMode = 'fixed', dnPol = null,
    loId = '', beamUpId = '', beamDnId = '', kind = 'transponder',
    noStart = 1, noPattern = '{n}', noList = null, noStep = 1
  } = spec
  const out = []
  const n = Math.max(0, Math.min(512, Math.floor(count)))
  for (let i = 0; i < n; i++) {
    let p = pol
    if (polMode === 'alternate') p = i % 2 === 0 ? pol : (POL_ORTHO[pol] || pol)
    const no = Array.isArray(noList) && noList[i] != null
      ? String(noList[i])
      : String(noPattern).replace(/\{n\}/g, String(noStart + i * noStep))
    out.push(newChannel({
      no, kind, loId, beamUpId, beamDnId: beamDnId || beamUpId,
      up: { fcMHz: startFcMHz + i * stepMHz, bwMHz, pol: p },
      dn: { fcMHz: null, bwMHz: null, pol: dnPol || POL_ORTHO[p] || 'V' }
    }))
  }
  return out
}

// 频段猜测：按卫星固定业务的实际划分，不按「S 段是 2~4 GHz」这种泛频段定义——
// 3.4~4.2 GHz 是 C 段下行而非 S 段，边界卡在 3 GHz 上。只是个默认值，界面上可改。
export function guessBand(fMHz) {
  const f = Number(fMHz)
  if (!Number.isFinite(f)) return 'Ku'
  if (f < 2000) return 'L'
  if (f < 3000) return 'S'          // S 段：上行 2.025~2.11、下行 2.2~2.29 GHz
  if (f < 5000) return 'C'          // C 段下行 3.4~4.2 GHz
  if (f < 7100) return 'C'          // C 段上行 5.85~6.725 GHz
  if (f < 9000) return 'X'
  if (f < 15500) return 'Ku'        // Ku 下行 10.7~12.75 / 上行 12.75~14.5 GHz
  if (f < 40000) return 'Ka'        // Ka 下行 17.7~21.2 / 上行 27.5~31 GHz
  if (f < 50000) return 'Q'
  return 'V'
}

// ---- 校验 ----
// 只出数值与定位，不下文字结论（遵循平台「结果输出纯数字」口径）：每条 issue 给出
// 严重度 + 涉及通道 + 两个可比对的数，判断留给人。

const OVERLAP_EPS = 1e-6

export function validatePlan(plan) {
  const issues = []
  const rs = resolveAll(plan)
  const add = (severity, code, msg, refs, nums) => issues.push({ severity, code, msg, refs: refs || [], nums: nums || null })

  for (const r of rs) {
    if (!r.up && !r.dn) add('warn', 'empty', `通道 ${r.no || r.id} 上下行皆无频率`, [r.id])
    if (r.up && !Number.isFinite(r.up.bw)) add('warn', 'nobw', `通道 ${r.no} 未给带宽`, [r.id])
    if (r.up && !r.lo && !Number.isFinite(r.raw.dn.fcMHz)) {
      add('warn', 'nolo', `通道 ${r.no} 未指定 LO 且未显式给下行频率 — 下行无法定位`, [r.id])
    }
    // 下行落到负频率/异常低频 = LO 填错的典型症状
    if (r.dn && r.dn.fc <= 0) add('error', 'badlo', `通道 ${r.no} 下行频率 ${r.dn.fc.toFixed(2)} MHz ≤ 0`, [r.id], { dn: r.dn.fc })
  }

  // 同侧同极化的频段重叠（正交极化重叠 = 合法的极化复用，不报）
  for (const side of ['up', 'dn']) {
    const segs = rs.map((r) => ({ r, s: side === 'up' ? r.up : r.dn })).filter((x) => x.s && Number.isFinite(x.s.bw))
    segs.sort((a, b) => a.s.f1 - b.s.f1)
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[j].s.f1 >= segs[i].s.f2 - OVERLAP_EPS) break   // 已排序，后面的更不会重叠
        if (segs[i].s.pol !== segs[j].s.pol) continue           // 正交/异极化 → 复用，放行
        const ov = Math.min(segs[i].s.f2, segs[j].s.f2) - Math.max(segs[i].s.f1, segs[j].s.f1)
        if (ov > OVERLAP_EPS) {
          add('error', 'overlap',
            `${side === 'up' ? '上行' : '下行'} ${segs[i].r.no} 与 ${segs[j].r.no} 同极化 ${segs[i].s.pol} 重叠 ${ov.toFixed(2)} MHz`,
            [segs[i].r.id, segs[j].r.id], { overlapMHz: ov })
        }
      }
    }
  }

  // LO 一致性：显式填了下行频率的通道，若同时也挂了 LO，两者对不上就提示（cross-strap 属正常，
  // 故只报 info，由人判断是「真 cross-strap」还是「数字录错」）
  for (const r of rs) {
    if (!Number.isFinite(r.raw.dn.fcMHz) || !r.lo || !Number.isFinite(r.lo.valueMHz) || !r.up) continue
    const derived = r.up.fc - r.lo.valueMHz
    const d = Math.abs(derived - r.raw.dn.fcMHz)
    if (d > 0.05) {
      add('info', 'loMismatch',
        `通道 ${r.no} 显式下行 ${r.raw.dn.fcMHz} MHz 与 LO 推算 ${derived.toFixed(2)} MHz 差 ${d.toFixed(2)} MHz`,
        [r.id], { explicit: r.raw.dn.fcMHz, derived, deltaMHz: d })
    }
  }

  // 编号重复（图上编号是人读图的唯一锚点，重了必是录入笔误）
  const byNo = new Map()
  for (const r of rs) {
    if (!r.no) continue
    if (byNo.has(r.no)) add('warn', 'dupNo', `编号 ${r.no} 重复`, [byNo.get(r.no), r.id])
    else byNo.set(r.no, r.id)
  }
  return issues
}

export const errorCount = (issues) => issues.filter((i) => i.severity === 'error').length

// ---- 查询：给链路预算引用用 ----

// 按编号取通道（链路表里存的是编号，取用时解引用）
export const channelByNo = (plan, no) => (plan.channels || []).find((c) => String(c.no) === String(no)) || null

// 某频率落在哪个通道内（「这条载波落在哪个转发器」用它）
export function channelAtFreq(plan, fMHz, side = 'up', pol = null) {
  const f = Number(fMHz)
  if (!Number.isFinite(f)) return null
  for (const r of resolveAll(plan)) {
    const s = side === 'dn' ? r.dn : r.up
    if (!s || !Number.isFinite(s.bw)) continue
    if (pol && s.pol !== pol) continue
    if (f >= s.f1 - OVERLAP_EPS && f <= s.f2 + OVERLAP_EPS) return r
  }
  return null
}

// 频率计划 → 链路预算卫星字段。这是「引用」的口径咽喉：链路预算只认这五项 + 可选的转发器属性。
export function channelToLinkFields(plan, ch) {
  const r = resolveChannel(plan, ch)
  const out = {}
  if (r.up) {
    out.centerFrequency = toGHz(r.up.fc)      // 链路预算的频率字段单位是 GHz
    out.uplinkPolarization = r.up.pol
  }
  if (r.dn) {
    out.rxCenterFrequency = toGHz(r.dn.fc)
    out.downlinkPolarization = r.dn.pol
  }
  const bw = r.up?.bw ?? r.dn?.bw
  if (Number.isFinite(bw)) out.transponderBandwidth = bw   // 转发器带宽单位是 MHz
  if (Number.isFinite(ch.sfdDbwm2)) out.sfdRef = ch.sfdDbwm2
  if (Number.isFinite(ch.gtDbK)) out.sfdGtRef = ch.gtDbK
  if (Number.isFinite(ch.boiDb)) out.BOi = ch.boiDb
  if (Number.isFinite(ch.booDb)) out.BOo = ch.booDb
  if (Number.isFinite(ch.cimDb)) out.xpdrIntermodFactor = ch.cimDb
  return out
}

// 摘要（文件区列表与库条目一行速览）
export function planSummary(plan) {
  const chs = plan.channels || []
  const tp = chs.filter((c) => c.kind === 'transponder')
  const bws = tp.map((c) => c.up?.bwMHz).filter(Number.isFinite)
  const ext = planExtent(plan, 'up', 0)
  const parts = [`${plan.band || '—'} 频段`, `${tp.length} 转发器`]
  if (bws.length) {
    const uniq = [...new Set(bws.map((b) => Math.round(b * 100) / 100))]
    parts.push(uniq.length === 1 ? `${uniq[0]} MHz` : `${Math.min(...bws)}~${Math.max(...bws)} MHz`)
  }
  if (ext) parts.push(`↑${(ext.dataMin / 1000).toFixed(2)}~${(ext.dataMax / 1000).toFixed(2)} GHz`)
  if (plan.beams?.length) parts.push(`${plan.beams.length} 波束`)
  return parts.join(' · ')
}
