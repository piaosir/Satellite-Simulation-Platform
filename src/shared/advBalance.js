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
// 组平衡只给出一个方程，多个载波则自由度不止一个，故约定「统一平移」：各载波在自己的基准余量上同抬同降
// 同一个 Δ，个别载波可加固定偏置（相对基准的超发量，如前向按设计超发 +2 dB）错开。
//
// —— 幂等（同样的设置连点几次「应用」，解出的余量必须钉在原地）——
// 「单载波平衡点」基准天生幂等：平衡点由 A（归一功率带宽）与载波带宽定，与此刻的余量无关。
// 「当前余量」基准则是个移动靶——我们上一轮写回的余量里已经含着那一轮的偏置，再拿它当基准，
// 偏置就一轮叠一层；单载波看不出来（唯一未知数由方程定死，偏置被 Δ 抵消），多载波才现形：
// 各载波一轮轮错开，余量永远停不下来。故写回时把【进本功能之前那份原始余量】钉在载波配置上
// （ADV_BASE），下一轮基准取它而不是我们自己写进去的值 —— 见 advBaseMargin。
// 于是「当前余量」的准确含义是：本功能动手之前你自己定下的那份余量。

// —— 两种模式 ——
export const ADV_MODES = [
  {
    key: 'vsat',
    label: 'VSAT 组网平衡',
    enLabel: 'VSAT Network Balance',
    desc: '所选链路各占一段频谱：Σ载波带宽 与 Σ功率带宽 分别求和后配平。前向超发、返向欠发，单条均不平衡，整组功带平衡'
  },
  {
    key: 'cnc',
    label: 'CNC 载波叠加',
    enLabel: 'Carrier-in-Carrier',
    desc: '两条链路共用同一段频谱：带宽只计一份、功率两条相加后与之配平。要求两条链路引用同一份载波配置'
  }
]

// —— 基准余量的取法 ——
export const ADV_BASES = [
  { key: 'current', label: '当前余量', desc: '以各载波当前系统余量为起点整体平移，保留既定的相对关系；已由本功能配平过的载波，基准取其配平前的原始余量，故重复应用不会累加偏置' },
  { key: 'balance', label: '单载波平衡点', desc: '先将每个载波移至其单载波平衡点，再整体平移；此时偏置即相对单载波平衡点的超发量' }
]

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN }
const dB = (ratio) => 10 * Math.log10(ratio)
const lin = (db) => Math.pow(10, db / 10)

// 归一功率带宽：把一条链路的功率带宽折算到 margin = 0（此后任意余量下的功率带宽 = A × 10^(m/10)）
const normPbw = (pbwKHz, marginDb) => pbwKHz / lin(marginDb)

// 选中集合是否够条件求解；返回空串表示可解，否则是拦下来的原因
export function validateAdv(mode, picked) {
  if (!picked || !picked.length) return '请至少勾选 1 条链路'
  const bad = picked.find((p) => !isFinite(p.bwKHz) || !isFinite(p.pbwKHz) || !isFinite(p.marginDb))
  if (bad) return `链路 #${bad.no} 无可用计算结果（${bad.error || '未计算'}）：请先计算，或取消勾选该行`
  if (mode === 'cnc') {
    if (picked.length !== 2) return `CNC 载波叠加须恰好勾选 2 条链路（一对同频叠加的载波），当前已勾选 ${picked.length} 条`
    if (picked[0].carrierId !== picked[1].carrierId) {
      return `CNC 载波叠加要求两条链路引用同一份载波配置，当前分别为「${picked[0].carrierName}」与「${picked[1].carrierName}」`
    }
  }
  return ''
}

// 把选中链路按载波归堆：一份载波 = 一个未知数（A 为该载波下各链路的归一功率带宽之和）
function groupByCarrier(picked) {
  const map = new Map()
  for (const p of picked) {
    let c = map.get(p.carrierId)
    if (!c) { c = { id: p.carrierId, name: p.carrierName, links: [], A: 0, bwKHz: 0, margins: [], bases: [] }; map.set(p.carrierId, c) }
    c.links.push(p)
    c.bases.push(num(p.baseDb))
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
 *   picked   [{ no, rowId, carrierId, carrierName, bwKHz, pbwKHz, marginDb, baseDb, error }] 已勾选的链路（带上一次计算结果）
 *            baseDb＝该载波「进本功能之前」的原始余量（宿主用 advBaseMargin 从载波配置上取，缺省即 marginDb）
 *   state    { [carrierId]: { bias:Number } } 逐载波的偏置（相对基准的固定错位）
 *   base     'current' | 'balance'
 *   overDb   组级超发量（目标总功率带宽相对组占用带宽抬高的 dB 数，0 即严格平衡）
 *   tpBwMHz  转发器带宽（只用于占用率读数，缺省则不报占用率）
 */
export function solveAdv(o) {
  const mode = o.mode || 'vsat'
  const picked = o.picked || []
  // CNC 只有一份载波、一个方程（校验已强制两条链路同载波），偏置在这里没有意义：
  // 唯一的未知数由方程本身定死，一律忽略 VSAT 那边留下的偏置
  const state = mode === 'cnc' ? {} : (o.state || {})
  const base = o.base === 'balance' ? 'balance' : 'current'
  const overDb = num(o.overDb) || 0
  // 不可解也要把载波清单带回去：界面上的偏置输入就长在那张表里，表一空用户就没地方改了
  const fail = (message, carriers) => ({ ok: false, message, carriers: carriers || [], links: [] })
  const carrierRow = (c) => ({
    id: c.id, name: c.name, n: c.links.length, biasDb: c.biasDb || 0,
    baseDb: c.baseDb, balanceDb: c.balanceDb, fromDb: c.currentDb, toDb: c.toDb, shiftDb: c.shiftDb
  })

  const msg = validateAdv(mode, picked)
  if (msg) return fail(msg)

  const carriers = groupByCarrier(picked)
  const sumBwKHz = picked.reduce((s, p) => s + p.bwKHz, 0)
  // 组占用带宽：VSAT 各占各的 → 求和；CNC 同频叠加 → 只算一份（两条链路同载波，带宽本就相同）
  const occBwKHz = mode === 'cnc' ? Math.max(...picked.map((p) => p.bwKHz)) : sumBwKHz
  if (!(occBwKHz > 0)) return fail('所选链路的载波带宽为 0，无法配平')
  const targetKHz = occBwKHz * lin(overDb)

  // 逐载波定基准：current = 该载波「进本功能之前」的原始余量（宿主给的 baseDb；缺省即此刻的余量。
  // 拿它而不是此刻的余量，反复应用才不会把偏置一层层叠上去——见文件头「幂等」一节）；
  // balance = 令该载波自己的功率带宽等于自己的载波带宽的那个余量（CNC 下带宽只算一份）
  for (const c of carriers) {
    const cBw = mode === 'cnc' ? occBwKHz : c.bwKHz
    c.balanceDb = c.A > 0 ? dB(cBw / c.A) : NaN
    // 同一份载波正常取值相同，非「设置余量」方式下取首条
    c.currentDb = c.margins[0]
    c.pristineDb = isFinite(c.bases[0]) ? c.bases[0] : c.currentDb
    c.baseDb = base === 'balance' ? c.balanceDb : c.pristineDb
    const st = state[c.id] || null
    c.biasDb = (st && isFinite(num(st.bias))) ? num(st.bias) : 0
    if (!isFinite(c.baseDb)) return fail(`载波「${c.name}」的基准余量无法确定`, carriers.map(carrierRow))
  }
  const rows = () => carriers.map(carrierRow)

  // Σ功率带宽 = 10^(Δ/10)·Σ A·10^((基准+偏置)/10) = 目标
  const pBase = carriers.reduce((s, c) => s + c.A * lin(c.baseDb + c.biasDb), 0)
  if (!(pBase > 0)) return fail('所选链路的功率带宽为 0，无法配平', rows())
  const deltaDb = dB(targetKHz / pBase)

  // 落值：逐载波终余量、逐链路解后功率带宽（闭式，与引擎重算逐位一致）
  const warnings = []
  let afterPbwKHz = 0
  const outLinks = []
  for (const c of carriers) {
    c.toDb = c.baseDb + c.biasDb + deltaDb
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
    if (c.toDb < 0) warnings.push(`载波「${c.name}」配平余量为 ${c.toDb.toFixed(2)} dB：负余量，该载波达不到解调门限`)
    if (c.margins.some((m) => Math.abs(m - c.currentDb) > 0.005)) {
      warnings.push(`载波「${c.name}」各链路当前系统余量不一致（${c.margins.map((m) => m.toFixed(2)).join(' / ')} dB）：基准取首条链路，配平结果不受影响`)
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

// —— 写回落点：解出的余量该写进哪份载波配置 ——
//
// VSAT 组网平衡的结论是【这一组链路在这套工况下】的，不是载波自身的属性：同一份载波换一组链路配平
// 就是另一个余量，一份配置装不下多个结果。故 VSAT 一律派生专用副本，用户原来的载波配置一字不动。
// 反复试错不生冗余：勾选行此刻指着的若已是本功能同模式派生的副本（form 上带 ADV_MARK 标记），
// 就地更新那一份而不是再复制一层。
// CNC 载波叠加不同——两条链路本就引用同一份载波、占同一段频谱，余量就是这份载波自己的属性，
// 故沿用「只改余量」：仅当它还被本表中未勾选的链路引用时才派生副本（免得动到那些链路）。
export const ADV_MARK = 'advBalanceMode'     // 副本标记：由哪种模式派生（＝「这份是高级计算的副本」）
export const ADV_ORIGIN = 'advBalanceFrom'   // 派生自哪份原载波（记根，副本再派生也不丢原始出处）
export const ADV_BASE = 'advBalanceBaseDb'   // 进本功能之前那份原始余量（基准的锚，反复应用都从它起算）
export const ADV_OUT = 'advBalanceOutDb'     // 上次写回的余量（＝当时 margin 字段的原样字符串，用来认「有没有被手改」）
export const ADV_SUFFIX = { vsat: ' · VSAT平衡', cnc: ' · CNC平衡' }

/**
 * 取一份载波配置的【基准余量】：本功能自己写进去的那份不算「当前余量」——它里面含着上一轮的偏置，
 * 再当基准就会一轮叠一层（见文件头「幂等」一节）。配置上钉着的原始基准还作数就用它。
 * @param {object} form 载波配置的 form
 * @param {number} curMarginDb 该载波此刻实际跑的余量（引擎回填的 resolvedMargin）
 */
export function advBaseMargin(form, curMarginDb) {
  const f = form || {}
  const rec = Number(f[ADV_BASE])
  if (!Number.isFinite(rec)) return curMarginDb
  // 认账条件：配置仍是我们写下的那副样子（设置余量 + 余量字符串一字不差）。用户手改过余量、
  // 或把计算方式换成了功带平衡之类，原始基准即作废 —— 那时「当前」就该是此刻这个值
  if (f.calcMode !== 'margin' || String(f.margin) !== String(f[ADV_OUT])) return curMarginDb
  return rec
}
// 副本名去后缀：副本再派生时按【根配置】的名字重起，不叠成「4M · VSAT平衡 · VSAT平衡」
const stripSuffix = (s) => String(s == null ? '' : s).replace(/ · (VSAT|CNC)平衡( \d+)?$/, '')

/**
 * 规划写回（纯函数，什么都不改——只回一份「该怎么改」的清单，由各窗口照单执行）。
 * @param {object} o
 *   mode      'vsat' | 'cnc'
 *   carriers  solveAdv 回的载波清单（用其中的 id / toDb / fromDb）
 *   rowIds    参与本组配平的链路行 id
 *   rows      全表链路行 [{ rowId, carrierId }]（carrierId = 该行此刻解析到的载波条目 id）
 *   configs   载波库 [{ id, name, form }]
 * @returns {{ ops: Array }} ops：
 *   { kind:'inplace', carrierId, name, formPatch }               —— 就地改这份配置
 *   { kind:'fork', fromId, name, rowIds, formPatch }             —— 复制 fromId 一份、名为 name，
 *                                                                   把 rowIds 这些行改指过去
 *   formPatch 一律直接 Object.assign 进目标 form
 */
export function planAdvWriteback(o) {
  const mode = o.mode === 'cnc' ? 'cnc' : 'vsat'
  const picked = new Set(o.rowIds || [])
  const rows = o.rows || []
  const configs = o.configs || []
  const byId = new Map(configs.map((c) => [c.id, c]))
  const names = new Set(configs.map((c) => c.name))
  const ops = []
  for (const c of (o.carriers || [])) {
    const toDb = Number(c.toDb)   // 先收成数：全局 isFinite 连数字字符串都放行，那样 toFixed 会当场炸
    if (!Number.isFinite(toDb)) continue
    const cur = byId.get(c.id)
    if (!cur) continue
    const form = cur.form || {}
    // 留 3 位：2 位小数的取整会在总功率带宽上留下可见残差
    const margin = toDb.toFixed(3)
    const patch = { calcMode: 'margin', margin }
    // 幂等的锚：把「进本功能之前那份原始余量」与「这次写进去的余量」一并记在配置上，下一轮基准
    // 取原始值而不是我们自己写进去的值（见文件头「幂等」一节）。原始值就地从配置上认——配置里那份
    // 锚还作数就沿用（副本再配平/再派生都不丢原始态），作废了才拿此刻的余量当新锚，不依赖调用方
    // 转交（对话框只回 id/name/toDb/fromDb）。
    // CNC 不写——唯一未知数由方程本身定死、解与基准无关，且它的就地改一向不在用户配置上留标记
    if (mode === 'vsat') {
      const keep = advBaseMargin(form, Number(c.fromDb))
      if (Number.isFinite(keep)) { patch[ADV_BASE] = keep; patch[ADV_OUT] = margin }
    }
    const usedByOthers = rows.some((r) => !picked.has(r.rowId) && r.carrierId === c.id)
    const mine = form[ADV_MARK] === mode   // 本功能同模式派生的副本＝我们自己的东西，可以直接改
    if (!usedByOthers && (mine || mode === 'cnc')) {
      ops.push({ kind: 'inplace', carrierId: c.id, name: cur.name, formPatch: patch })
      continue
    }
    const rootId = form[ADV_ORIGIN] || c.id
    const root = byId.get(rootId) || cur
    let name = (stripSuffix(root.name) || '载波') + ADV_SUFFIX[mode]
    if (names.has(name)) { let i = 2; while (names.has(name + ' ' + i)) i++; name = name + ' ' + i }
    names.add(name)
    ops.push({
      kind: 'fork', fromId: c.id, name,
      rowIds: rows.filter((r) => picked.has(r.rowId) && r.carrierId === c.id).map((r) => r.rowId),
      formPatch: { ...patch, [ADV_MARK]: mode, [ADV_ORIGIN]: rootId }
    })
  }
  return { ops }
}
