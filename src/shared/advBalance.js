// 高级计算：多载波「功带平衡」组求解（GEO / NGSO 两窗共用；纯函数，不碰引擎）。
//
// 单条链路的功带平衡（modeSolver 的 balance / overbalance）只看自己：令本载波的功率带宽等于它自己的
// 载波带宽。可真实转发器上跑的是【一组】载波，平衡是整组的事：
//   · VSAT 组网——前向 TDM 大载波按可用度超发（功率占用 > 带宽占用）、返向 TDMA 小站受功放限制欠发
//     （带宽占用 > 功率占用）；单看每条都不平衡，合起来 Σ功率带宽 = Σ载波带宽 才是要的结果。
//   · CNC 载波叠加——两条链路占同一段频谱（带宽只算一份）、功率是叠加态（两条相加），
//     平衡即 P₁ + P₂ = B。
//
// 求解只在核心算法【外层】决定喂给引擎的余量（与 modeSolver 同一层），linkCalculator 一行不动。
// 而且不必迭代搜索——引擎里 carrierTotalCT = 载波门限 + margin、功率占用 = 10^((carrierTotalCT −
// 转发器可用C/T)/10)，载波带宽只由速率/调制/滚降决定（与余量无关），于是
//        【余量抬 x dB  ⇔  功率带宽恰好 ×10^(x/10)】
// 一次闭式解就精确落到平衡点，比二分搜索既快又准（GEO/NGSO 两个引擎此处口径相同，已逐行核对）。
//
// 未知数是【载波配置】而不是链路：系统余量存在载波（基带）条目上，同一份载波被几条链路共用就共用一个余量。
// 组平衡只给出一个方程，多个载波则自由度不止一个，故约定「统一平移」：可调载波在各自基准余量上同抬同降
// 同一个 Δ，个别载波可锁定（维持现状，如前向按设计超发已定）或加固定偏置（相对基准的超发量）。

// —— 两种模式 ——
export const ADV_MODES = [
  {
    key: 'vsat',
    label: 'VSAT 组网平衡',
    enLabel: 'VSAT Network Balance',
    desc: '选中的链路各占各的频谱：Σ载波带宽 与 Σ功率带宽 分别求和后配平（前向超发 / 返向欠发，整组功带平衡）'
  },
  {
    key: 'cnc',
    label: 'CNC 载波叠加',
    enLabel: 'Carrier-in-Carrier',
    desc: '两条链路占同一段频谱：带宽只算一份、功率两条相加后与之配平（要求两条链路引用同一份载波配置）'
  }
]

// —— 基准余量的取法 ——
export const ADV_BASES = [
  { key: 'current', label: '当前余量', desc: '以各载波此刻的余量为起点整体平移，保留你已经定下来的相对关系' },
  { key: 'balance', label: '各自平衡点', desc: '先把每个载波移到它自己单独的功带平衡点，再整体平移；偏置即「相对自身平衡点的超发量」' }
]

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN }
const dB = (ratio) => 10 * Math.log10(ratio)
const lin = (db) => Math.pow(10, db / 10)

// 归一功率带宽：把一条链路的功率带宽折算到 margin = 0（此后任意余量下的功率带宽 = A × 10^(m/10)）
const normPbw = (pbwKHz, marginDb) => pbwKHz / lin(marginDb)

// 选中集合是否够条件求解；返回空串表示可解，否则是拦下来的原因
export function validateAdv(mode, picked) {
  if (!picked || !picked.length) return '请至少选中 1 条链路'
  const bad = picked.find((p) => !isFinite(p.bwKHz) || !isFinite(p.pbwKHz) || !isFinite(p.marginDb))
  if (bad) return `链路 #${bad.no} 没有可用的计算结果（${bad.error || '未计算'}），请先计算或取消勾选`
  if (mode === 'cnc') {
    if (picked.length !== 2) return `CNC 载波叠加需要恰好选中 2 条链路（一对同频叠加的载波），当前选中 ${picked.length} 条`
    if (picked[0].carrierId !== picked[1].carrierId) {
      return `CNC 要求两条链路引用同一份载波配置（当前为「${picked[0].carrierName}」与「${picked[1].carrierName}」）`
    }
  }
  return ''
}

// 把选中链路按载波归堆：一份载波 = 一个未知数（A 为该载波下各链路的归一功率带宽之和）
function groupByCarrier(picked) {
  const map = new Map()
  for (const p of picked) {
    let c = map.get(p.carrierId)
    if (!c) { c = { id: p.carrierId, name: p.carrierName, links: [], A: 0, bwKHz: 0, margins: [] }; map.set(p.carrierId, c) }
    c.links.push(p)
    c.A += normPbw(p.pbwKHz, p.marginDb)
    c.bwKHz += p.bwKHz
    c.margins.push(p.marginDb)
  }
  return [...map.values()]
}

/**
 * 组平衡求解。
 * @param {object} o
 *   mode     'vsat' | 'cnc'
 *   picked   [{ no, rowId, carrierId, carrierName, bwKHz, pbwKHz, marginDb, error }] 已勾选的链路（带上一次计算结果）
 *   state    { [carrierId]: { locked:Boolean, bias:Number } } 逐载波的锁定/偏置
 *   base     'current' | 'balance'
 *   overDb   组级超发量（目标总功率带宽相对组占用带宽抬高的 dB 数，0 即严格平衡）
 *   tpBwMHz  转发器带宽（只用于占用率读数，缺省则不报占用率）
 */
export function solveAdv(o) {
  const mode = o.mode || 'vsat'
  const picked = o.picked || []
  // CNC 只有一份载波、一个方程（校验已强制两条链路同载波），锁定/偏置在这里没有意义：
  // 一律忽略，免得 VSAT 那边留下的锁定标记把唯一的未知数也锁死
  const state = mode === 'cnc' ? {} : (o.state || {})
  const base = o.base === 'balance' ? 'balance' : 'current'
  const overDb = num(o.overDb) || 0
  // 不可解也要把载波清单带回去：界面上的锁定/偏置开关就长在那张表里，
  // 表一空（比如「全锁定」这种自己把自己堵死的局面）用户就没地方解锁了
  const fail = (message, carriers) => ({ ok: false, message, carriers: carriers || [], links: [] })
  const carrierRow = (c) => ({
    id: c.id, name: c.name, n: c.links.length, locked: !!c.locked, biasDb: c.biasDb || 0,
    baseDb: c.baseDb, balanceDb: c.balanceDb, fromDb: c.currentDb, toDb: c.toDb, shiftDb: c.shiftDb
  })

  const msg = validateAdv(mode, picked)
  if (msg) return fail(msg)

  const carriers = groupByCarrier(picked)
  const sumBwKHz = picked.reduce((s, p) => s + p.bwKHz, 0)
  // 组占用带宽：VSAT 各占各的 → 求和；CNC 同频叠加 → 只算一份（两条链路同载波，带宽本就相同）
  const occBwKHz = mode === 'cnc' ? Math.max(...picked.map((p) => p.bwKHz)) : sumBwKHz
  if (!(occBwKHz > 0)) return fail('选中链路的载波带宽为 0，无法配平')
  const targetKHz = occBwKHz * lin(overDb)

  // 逐载波定基准：current = 该载波各链路此刻的余量（同一份载波正常取值相同，非「设置余量」方式下取首条）；
  // balance = 令该载波自己的功率带宽等于自己的载波带宽的那个余量（CNC 下带宽只算一份）
  for (const c of carriers) {
    const cBw = mode === 'cnc' ? occBwKHz : c.bwKHz
    c.balanceDb = c.A > 0 ? dB(cBw / c.A) : NaN
    c.currentDb = c.margins[0]
    c.baseDb = base === 'balance' ? c.balanceDb : c.currentDb
    const st = state[c.id] || null
    c.locked = !!(st && st.locked)
    c.biasDb = (st && isFinite(num(st.bias))) ? num(st.bias) : 0
    if (!isFinite(c.baseDb)) return fail(`载波「${c.name}」的基准余量无法确定`, carriers.map(carrierRow))
  }
  const rows = () => carriers.map(carrierRow)
  const adj = carriers.filter((c) => !c.locked)
  const lock = carriers.filter((c) => c.locked)
  if (!adj.length) return fail('全部载波都被锁定，没有可调整的余量——请至少解锁一份载波', rows())

  // Σ功率带宽 = Σ_锁定 A·10^(m/10) + 10^(Δ/10)·Σ_可调 A·10^((基准+偏置)/10) = 目标
  // 锁定＝维持现状，取的是它此刻的余量而非基准：基准选「各自平衡点」时基准已经不是现状了
  const pLock = lock.reduce((s, c) => s + c.A * lin(c.currentDb), 0)
  const pAdjBase = adj.reduce((s, c) => s + c.A * lin(c.baseDb + c.biasDb), 0)
  if (!(pAdjBase > 0)) return fail('可调载波的功率带宽为 0，无法配平', rows())
  const headroom = targetKHz - pLock
  if (!(headroom > 0)) {
    return fail(`锁定载波的功率带宽（${pLock.toFixed(1)} kHz）已达到或超过目标（${targetKHz.toFixed(1)} kHz），`
      + '可调载波无解——请解锁部分载波、下调锁定载波的余量，或调高组超发量', rows())
  }
  const deltaDb = dB(headroom / pAdjBase)

  // 落值：逐载波终余量、逐链路解后功率带宽（闭式，与引擎重算逐位一致）
  const warnings = []
  let afterPbwKHz = 0
  const outLinks = []
  for (const c of carriers) {
    c.toDb = c.locked ? c.currentDb : c.baseDb + c.biasDb + deltaDb
    c.shiftDb = c.toDb - c.currentDb
    for (const p of c.links) {
      const a = normPbw(p.pbwKHz, p.marginDb)
      const after = a * lin(c.toDb)
      afterPbwKHz += after
      outLinks.push({
        rowId: p.rowId, no: p.no, name: p.name, carrierId: c.id, carrierName: c.name,
        bwKHz: p.bwKHz, pbwBefore: p.pbwKHz, pbwAfter: after,
        marginBefore: p.marginDb, marginAfter: c.toDb
      })
    }
    if (!c.locked && c.toDb < 0) warnings.push(`载波「${c.name}」解出的余量为 ${c.toDb.toFixed(2)} dB（负余量：该载波将达不到解调门限）`)
    if (c.margins.some((m) => Math.abs(m - c.currentDb) > 0.005)) {
      warnings.push(`载波「${c.name}」下各链路当前余量不一致（${c.margins.map((m) => m.toFixed(2)).join(' / ')} dB），基准取首条；配平结果仍精确`)
    }
  }
  const beforePbwKHz = picked.reduce((s, p) => s + p.pbwKHz, 0)
  const tpBwKHz = (num(o.tpBwMHz) || 0) * 1000

  return {
    ok: true, message: '', warnings, mode, base, overDb, deltaDb,
    occBwKHz, sumBwKHz, targetKHz, beforePbwKHz, afterPbwKHz,
    residualKHz: afterPbwKHz - targetKHz,
    // 转发器占用率（解后）：带宽按组占用带宽算，功率按 Σ功率带宽算
    bwUsePct: tpBwKHz > 0 ? (occBwKHz / tpBwKHz) * 100 : NaN,
    pwUsePct: tpBwKHz > 0 ? (afterPbwKHz / tpBwKHz) * 100 : NaN,
    carriers: carriers.map(carrierRow),
    links: outLinks
  }
}
