// 高级计算：多载波「功带平衡」组求解（GEO 窗专用；纯函数，不碰引擎）。
//
// 为什么只有 GEO：NGSO 每行结果取的是【各自】最差几何时刻的值，不同行的最差时刻并不重合，Σ功率带宽
// 因此不是任何一个时刻的物理状态；NGSO 容量也不按「转发器功率等效带宽」售卖，这本账的前提不存在。
// 2026-09-05 从 NGSO 窗删除（旧 localStorage 键 ngso/advBalance 留着不清，无害）。
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
// 一次闭式解就精确落到平衡点，比二分搜索既快又准。
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
// 路数：一行代表几路完全相同的载波（组网里 20 个远端跑同一份返向配置是常态，
// 不该逼用户建 20 行）。缺省 1，非正整数一律归 1 —— 0 或负数会把整组账算没。
const cntOf = (p) => { const n = Math.round(num(p && p.count)); return (isFinite(n) && n >= 1) ? n : 1 }

// ============================================================================
// CnC（载波叠加）的物理约束
// ============================================================================
// 载波叠加不是「带宽算一份、功率相加」这么一笔功率账就完了。厂家给的是一套【使用限制】：
// 收端两载波的功率谱密度比必须落在一个窗内、符号率比不得超过 3:1、抵消不是无限深（残余自
// 干扰要并进载波的 C/(N+I)）、而这三样都随雨衰漂——雨一下，C/N 余量还够，CnC 已经先掉线。
//
// 约定：两条链路 L₁（P→Q）与 L₂（Q→P）构成一对双工。收端 X 收【对端发来的那条】、同时收到
// 自己发出去那条的回波（同一段频谱、同一个转发器绕一圈回来）。故：
//   收端 P：期望 = L₂，自身回波 = L₁；收端 Q：期望 = L₁，自身回波 = L₂。
//
// ρ（CnC 比）= 本站自身回波 PSD / 期望载波 PSD，正值＝自身更强：
//   ρ_P = 10lg(f₁/f₂) − 10lg(Rs₁/Rs₂)，ρ_Q = −ρ_P     （f = 功率份额，引擎 powerUsageRatio；
//   同一转发器下功率带宽 ∝ 份额，故这里直接用功率带宽之比）
// 符号约定由 CDM-Qx §9 的非对称算例核对：站 A 份额 0.37 % / 站 B 0.11 % → 10lg(0.37/0.11)
// = +5.27 dB 落在 A 侧，正是「本站自身 / 对端」。
//
// 雨衰耦合：对端上行衰落 r_des 把期望载波压低 ⇒ ρ 抬高；本端上行衰落 r_own 把自身回波压低
// ⇒ ρ 压低；下行雨衰两载波同衰、不进比值。故 ρ ∈ [ρ_clear − r_own, ρ_clear + r_des]。
//   r = max(0, 上行雨衰 − UPC 余量)（引擎出参 uplinkRainAttenuation / UPCmarginResult）。
//   CnC-APC 开 ⇒ 两端自动测量并补偿、ρ 视为被保持，区间坍缩到晴空值。
//
// 残余自干扰：C/I_res = D − ρ（D = 抵消深度）；再并上厂家给的固有处理损耗 deg₀（PSD 比 0 dB
// 时的 Eb/N₀ 退化）折成的等效 C/I_eq = T − 10lg(1 − 10^(−deg₀/10))，T = 目标 C/(N+I)。
// 两者功率并联得 C/I，再折成 C/N 退化 Δ = −10lg(1 − 10^((T − C/I)/10))；C/I ≤ T 即无解。
// 设计点取【雨衰下】的 ρ_max 而不是晴空值——那才是「CnC 的 C/I 可用性」口径。
//
// 解出的 C/I 写到【对应收端那一行】的 carrierExtCI（行级，不进载波配置：它是这组场景的结论），
// 引擎据此抬高该载波的 C/N 要求，份额/功放/级联自然跟随。
//
// 出处：
//   [1] Comtech EF Data CDM-625A 数据表（DoubleTalk Carrier-in-Carrier）：PSD 比窗口、
//       最大符号率比 3:1、卫星时延 0–330 ms、PSD 比 0 dB 时的 Eb/N₀ 退化、CnC-APC。
//   [2] Comtech EF Data CDM-Qx 手册 §9：CnC 比通常 < 10 dB、非对称速率比至 3、最小符号率
//       128 ksps、典型时延 230–270 ms、非对称雨衰算例 Table 9-2。
//   [3] ViaSat PCMA 资料：前向/返向须同转发器、一对双工、各站须收到自己的上行（回环）。
// 卫星时延窗（0–330 ms）不做输入：GEO 单跳回环恒在窗内，只在界面 title 注明。

// —— 厂家约束的缺省值（全部可改；出处见上）——
export const CNC_DEFAULTS = {
  cancelDb: 28,      // 抵消深度 D（dB）。数据表不给，按 CDM-Qx §9 非对称算例反推：QPSK 3/4
                     // （T ≈ 6.3 dB）在 ρ = ±5.3 dB 处总退化 0.1 dB，扣掉 deg₀ 0.3 后残余项
                     // ≈ 0 ⇒ D ≥ 28 才压得到 0.05 dB 以内。实测值请按设备填。
  ratioMax: 3,       // 符号率比上限（TX:RX 或 RX:TX），CDM-Qx §9「asymmetric data rates allowed up to 3」
  minSymKsps: 128,   // 最小符号率（ksps），CDM-Qx §9
  window: null,      // PSD 比窗口 [lo, hi] 手填覆盖；null = 按期望载波的调制查表
  deg0: null,        // 固有处理损耗（PSD 比 0 dB 时的 Eb/N₀ 退化，dB）手填覆盖；null = 按调制查表。
                     // 置 0 即「只算抵消残余、不计固有损耗」——与本功能改造前的纯功率账同口径。
  apc: false         // CnC-APC：两端自动测量并补偿雨衰、维持总合成功率，ρ 视为被保持
}

// —— PSD 比窗口与固有处理损耗（按【期望载波】的调制查）——
// 窗口：BPSK/QPSK/8PSK/8-QAM −7～+11 dB；16-QAM −7～+7 dB（CDM-625A 数据表）。
// 32-ary 数据表未给窗，按 ±7 处理（与 16-QAM 同档，偏保守）；更高阶厂家没有窗，返回 null 并告警。
// deg₀（PSD 比 0 dB 时的 Eb/N₀ 退化）：BPSK/QPSK/OQPSK 0.3、8-QAM 0.4、8PSK 0.5、
// 16-QAM 0.6、32-ary 0.6 dB（CDM-625A 数据表）。
// APSK 是幅相调制，按同阶 QAM 归档（16APSK→16-QAM 档、32APSK→32-ary 档）。
const CNC_MOD_SPEC = {
  BPSK: { win: [-7, 11], deg0: 0.3 },
  QPSK: { win: [-7, 11], deg0: 0.3 },
  OQPSK: { win: [-7, 11], deg0: 0.3 },
  '8QAM': { win: [-7, 11], deg0: 0.4 },
  '8PSK': { win: [-7, 11], deg0: 0.5 },
  '8APSK': { win: [-7, 11], deg0: 0.5 },
  '16QAM': { win: [-7, 7], deg0: 0.6 },
  '16APSK': { win: [-7, 7], deg0: 0.6 },
  '32QAM': { win: [-7, 7], deg0: 0.6 },
  '32APSK': { win: [-7, 7], deg0: 0.6 }
}
// 查表：认得的按表走；认不得（64-ary 及以上，或空）→ 无窗（null）+ deg0 取表里最大的一档 0.6
export function cncModSpec(modulation) {
  const key = String(modulation || '').trim().toUpperCase()
  const hit = CNC_MOD_SPEC[key]
  if (hit) return { win: hit.win.slice(), deg0: hit.deg0, known: true, name: key }
  return { win: null, deg0: 0.6, known: false, name: key }
}

// 面板传进来的 CnC 参数归正（留空即缺省；窗口两端都给才作数）
export function normCncOpt(opt) {
  const o = opt || {}
  const pick = (v, def) => { const n = num(v); return isFinite(n) ? n : def }
  const win = Array.isArray(o.window) ? [num(o.window[0]), num(o.window[1])] : null
  return {
    cancelDb: pick(o.cancelDb, CNC_DEFAULTS.cancelDb),
    ratioMax: pick(o.ratioMax, CNC_DEFAULTS.ratioMax),
    minSymKsps: pick(o.minSymKsps, CNC_DEFAULTS.minSymKsps),
    window: (win && isFinite(win[0]) && isFinite(win[1]) && win[1] > win[0]) ? win : null,
    deg0: isFinite(num(o.deg0)) ? Math.max(0, num(o.deg0)) : null,
    apc: !!o.apc
  }
}

// —— 站身份与双工配对 ——
// 身份 = 地球站配置 id + 经纬度（容差 1e-4°，约 11 m）；经纬度缺失时退回站址名。
// 两者都拿不到就返回空串——判不了身份就不该放行（Hub→A 与 Hub→B 正是靠这一条拦下的）。
const COORD_TOL = 1e-4
function siteKey(id, lon, lat, name) {
  const lo = num(lon), la = num(lat)
  if (isFinite(lo) && isFinite(la)) {
    const q = (v) => Math.round(v / COORD_TOL) * COORD_TOL
    return (id ? String(id) : '') + '@' + q(lo).toFixed(4) + ',' + q(la).toFixed(4)
  }
  const nm = String(name || '').trim()
  return nm ? (id ? String(id) + '@' : '') + nm : ''
}
const txSite = (p) => siteKey(p.txStationId, p.longitude, p.latitude, p.txStationName)
const rxSite = (p) => siteKey(p.rxStationId, p.rxLongitude, p.rxLatitude, p.rxStationName)
// 经纬度是量化到格的，落在格边界两侧的一对同站会被判成两站；故再补一次直接比距离
const sameSite = (ka, kb, a, b) => {
  if (ka && kb && ka === kb) return true
  const alo = num(a.lon), ala = num(a.lat), blo = num(b.lon), bla = num(b.lat)
  if (![alo, ala, blo, bla].every(isFinite)) return false
  if (String(a.id || '') !== String(b.id || '')) return false
  return Math.abs(alo - blo) <= COORD_TOL && Math.abs(ala - bla) <= COORD_TOL
}

// —— CnC 校验（§3.4 的 1/2/3/9 四条报错；4/5/6/8 是告警，在求解里出）——
export function validateCnc(picked) {
  const p1 = picked[0], p2 = picked[1]
  // 9：3GPP NTN 载波不支持 CnC（厂家 CnC 是 DVB/SCPC 调制解调器上的功能）
  const ntn = picked.find((p) => p.isNtn)
  if (ntn) return '链路 #' + ntn.no + ' 是 3GPP NTN 载波，不支持 CNC 载波叠加'
  // 2：双工配对——L1 的发站 = L2 的收站 且 L1 的收站 = L2 的发站。
  //    不查这一条，Hub→A 与 Hub→B 两条同载波链路也能过：那不是一对双工，各站收不到自己的回波。
  const t1 = txSite(p1), r1 = rxSite(p1), t2 = txSite(p2), r2 = rxSite(p2)
  if (!t1 || !r1 || !t2 || !r2) {
    return 'CNC 载波叠加须判定两条链路的站身份：所选链路缺少地球站配置与站址（经纬度或站址名）'
  }
  const site = (p, side) => side === 'tx'
    ? { id: p.txStationId, lon: p.longitude, lat: p.latitude }
    : { id: p.rxStationId, lon: p.rxLongitude, lat: p.rxLatitude }
  const okA = sameSite(t1, r2, site(p1, 'tx'), site(p2, 'rx'))
  const okB = sameSite(r1, t2, site(p1, 'rx'), site(p2, 'tx'))
  if (!okA || !okB) {
    const nm = (p, side) => (side === 'tx' ? p.txStationName : p.rxStationName) || (side === 'tx' ? '发站' : '收站')
    return 'CNC 载波叠加须是一对双工链路（各站收到自己的上行回波）：链路 #' + p1.no + ' '
      + nm(p1, 'tx') + ' → ' + nm(p1, 'rx') + '，链路 #' + p2.no + ' ' + nm(p2, 'tx') + ' → ' + nm(p2, 'rx')
  }
  // 3：共频包含 + 同极化（同转发器由 GEO 窗的场景级单颗卫星天然满足，不另校验）
  const bBig = Math.max(p1.bwKHz, p2.bwKHz), bSmall = Math.min(p1.bwKHz, p2.bwKHz)
  const room = (bBig - bSmall) / 2      // 窄载波完整落在宽载波频带内所允许的中心频率偏差（kHz）
  const FREQ = [['fUpGHz', '上行'], ['fDnGHz', '下行']]
  for (let i = 0; i < FREQ.length; i++) {
    const key = FREQ[i][0], label = FREQ[i][1]
    const f1 = num(p1[key]), f2 = num(p2[key])
    if (!isFinite(f1) || !isFinite(f2)) return 'CNC 载波叠加须比对' + label + '频率：所选链路的' + label + '频率为空'
    const dKHz = Math.abs(f1 - f2) * 1e6
    if (dKHz > room + 1e-6) {
      return 'CNC 载波叠加要求两载波同频叠加（窄载波完整落在宽载波频带内）：' + label
        + '中心频率相差 ' + (dKHz / 1000).toFixed(3) + ' MHz，允许 ' + (room / 1000).toFixed(3) + ' MHz'
    }
  }
  const POL = [['polUp', '上行极化'], ['polDn', '下行极化']]
  for (let i = 0; i < POL.length; i++) {
    const a = String(p1[POL[i][0]] || '').trim(), b = String(p2[POL[i][0]] || '').trim()
    if (a && b && a !== b) return 'CNC 载波叠加要求两载波同极化：' + POL[i][1] + '分别为 ' + a + ' 与 ' + b
  }
  return ''
}

// —— CnC 求解：功率账 + 残余自干扰的定点迭代 ——
// 一轮做两件事：① 拿当前的退化量把归一功率带宽抬一抬，按闭式解出整体平移量 Δ（功率账）；
// ② 由解后的份额算 ρ、查窗、算残余 C/I 与退化量（干扰账）。两账互相喂，故迭代。
// 收敛很快：ρ 只取决于两条链路余量【之差】与两侧退化量之差（整体平移 Δ 在比值里被约掉），
// 退化量对目标 C/N 的敏感度 d(deg)/dT ≈ 0.23·deg，环路增益远小于 1。
// 收敛后【再走一次功率账】：迭代中的 Δ 用的是上一轮的退化量，不补这一次 Σ功率带宽 就差目标一点点。
const CNC_TOL = 1e-6      // 退化量收敛判据（dB）。任务书给的是 |Δρ| < 0.01 / ≤6 轮，这里收紧到
const CNC_MAX_IT = 12     // 1e-6 并放宽轮数：0.01 dB 的残差会在 Σ功率带宽 上留下可见的量
function solveCnc(ctx) {
  const carriers = ctx.carriers, picked = ctx.picked, opt = ctx.opt, warnings = ctx.warnings
  const p1 = picked[0], p2 = picked[1]
  const cOf = (p) => carriers.find((c) => c.links.some((l) => l.rowId === p.rowId))
  // 归一功率带宽的【干净】值：把上一轮写回的附加 C/I 退化也剥掉，否则反复应用一轮叠一层
  // （同文件头「幂等」一节的老问题：基准是移动靶，这里多一个会动的量）
  const cleanA = (p) => p.pbwKHz / lin(p.marginDb + (num(p.extDegDb) || 0))
  const A = {}
  A[p1.rowId] = cleanA(p1); A[p2.rowId] = cleanA(p2)
  // 门限 C/N（不随余量变）：引擎的 carrierTotalCN = 门限 + 余量 + 附加C/I退化，三项都要剥掉。
  // ★ 漏剥 extDeg 的后果是反复应用一路漂：上一轮写回的附加 C/I 已经算进了这个数。
  const thr = (p) => num(p.targetCN) - p.marginDb - (num(p.extDegDb) || 0)
  // 上行残余雨衰 r = max(0, 上行雨衰 − UPC 余量)
  const resid = (p) => Math.max(0, (num(p.rainUpDb) || 0) - (num(p.upcDb) || 0))
  const r1 = resid(p1), r2 = resid(p2)
  // 两个收端：P = L1 的发站（期望 = L2、自身回波 = L1）；Q = L1 的收站（期望 = L1、回波 = L2）
  const SIDES = [
    { key: 'P', desired: p2, own: p1, rOwn: r1, rDes: r2, rxName: p1.txStationName || ('链路 #' + p1.no + ' 发站') },
    { key: 'Q', desired: p1, own: p2, rOwn: r2, rDes: r1, rxName: p1.rxStationName || ('链路 #' + p1.no + ' 收站') }
  ]
  const rsRatioDb = (a, b) => {
    const x = num(a.symbolRateKsps), y = num(b.symbolRateKsps)
    return (isFinite(x) && isFinite(y) && x > 0 && y > 0) ? dB(x / y) : 0
  }

  // 功率账：Σ A·10^(退化量/10)·10^((基准+偏置+Δ)/10) = 目标 —— 闭式解出 Δ 并落到各载波
  function powerPass(deg) {
    const pBase = carriers.reduce((s, c) =>
      s + c.links.reduce((t, l) => t + A[l.rowId] * lin(deg[l.rowId] || 0), 0) * lin(c.baseDb + c.biasDb), 0)
    if (!(pBase > 0)) return NaN
    const d = dB(ctx.targetKHz / pBase)
    for (const c of carriers) c.toDb = c.baseDb + c.biasDb + d
    return d
  }
  // 干扰账：份额（同一转发器下 ∝ 功率带宽）→ ρ → 查窗 → 残余 C/I → 退化量
  function interfPass(deg) {
    const pbwOf = (p) => A[p.rowId] * lin(cOf(p).toDb + (deg[p.rowId] || 0))
    const rhoClearP = dB(pbwOf(p1) / pbwOf(p2)) - rsRatioDb(p1, p2)
    const sides = SIDES.map((s) => {
      const rhoClear = s.key === 'P' ? rhoClearP : -rhoClearP
      const rhoMin = opt.apc ? rhoClear : rhoClear - s.rOwn
      const rhoMax = opt.apc ? rhoClear : rhoClear + s.rDes
      const spec = cncModSpec(s.desired.modulation)
      const win = opt.window || spec.win
      const deg0 = opt.deg0 === null ? spec.deg0 : opt.deg0
      const T = thr(s.desired) + cOf(s.desired).toDb
      const ciRes = opt.cancelDb - rhoMax               // 设计点取雨衰下的 ρ_max（不是晴空值）
      // 固有处理损耗折成的等效 C/I；deg0 = 0 时它是 +∞（并联里不出力），单独短路免得 log(0)
      const ciEq = deg0 > 0 ? T - dB(1 - lin(-deg0)) : Infinity
      const ci = -dB(lin(-ciRes) + (deg0 > 0 ? lin(-ciEq) : 0))
      return {
        key: s.key, rxName: s.rxName, rowId: s.desired.rowId, desiredNo: s.desired.no, ownNo: s.own.no,
        rhoClear: rhoClear, rhoMin: rhoMin, rhoMax: rhoMax,
        window: win ? win.slice() : null, modKnown: spec.known, deg0: deg0,
        windowMargin: win ? Math.min(rhoMin - win[0], win[1] - rhoMax) : NaN,
        allowFadeDes: win ? win[1] - rhoClear : NaN, designFadeDes: s.rDes,
        targetCN: T, ciRes: ciRes, ciEq: ciEq, ci: ci, deg: NaN
      }
    })
    for (const s of sides) {
      if (!(s.ci > s.targetCN)) {
        return { fail: '收端「' + s.rxName + '」的残余自干扰 C/I ' + s.ci.toFixed(2)
          + ' dB 不高于目标 C/N ' + s.targetCN.toFixed(2) + ' dB：抵消深度 ' + opt.cancelDb + ' dB 下这一对载波无解' }
      }
      s.deg = -dB(1 - lin(s.targetCN - s.ci))
    }
    return { sides: sides }
  }

  let deg = {}
  deg[p1.rowId] = 0; deg[p2.rowId] = 0     // 逐链路的退化量（发生在【它的收端】）
  let iters = 0, converged = false, sides = null, deltaDb = NaN
  for (let it = 1; it <= CNC_MAX_IT; it++) {
    iters = it
    deltaDb = powerPass(deg)
    if (!isFinite(deltaDb)) return { fail: '所选链路的功率带宽为 0，无法配平' }
    const r = interfPass(deg)
    if (r.fail) return { fail: r.fail }
    sides = r.sides
    const next = {}
    next[sides[0].rowId] = sides[0].deg
    next[sides[1].rowId] = sides[1].deg
    const moved = Math.max(Math.abs(next[p1.rowId] - deg[p1.rowId]), Math.abs(next[p2.rowId] - deg[p2.rowId]))
    deg = next
    if (moved < CNC_TOL) { converged = true; break }
  }
  // 收敛后的末一次功率账：Σ功率带宽 由此精确等于目标（此时 T 只再动 <1e-6 dB，退化量不必重算）
  deltaDb = powerPass(deg)
  if (!isFinite(deltaDb)) return { fail: '所选链路的功率带宽为 0，无法配平' }

  // 校验 4/5/6/8：能算但越界 → 告警（只留状态，不写建议）
  const rsRatio = (function () {
    const x = num(p1.symbolRateKsps), y = num(p2.symbolRateKsps)
    return (isFinite(x) && isFinite(y) && x > 0 && y > 0) ? Math.max(x / y, y / x) : NaN
  })()
  if (isFinite(rsRatio) && rsRatio > opt.ratioMax + 1e-9) {
    warnings.push('符号率比 ' + rsRatio.toFixed(2) + ':1 超过上限 ' + opt.ratioMax + ':1')
  }
  for (const p of picked) {
    const rs = num(p.symbolRateKsps)
    if (isFinite(rs) && rs > 0 && rs < opt.minSymKsps) {
      warnings.push('链路 #' + p.no + ' 符号率 ' + rs.toFixed(1) + ' ksps 低于 ' + opt.minSymKsps + ' ksps')
    }
    if (p.modulation && !cncModSpec(p.modulation).known) {
      warnings.push('链路 #' + p.no + ' 调制 ' + p.modulation + ' 无厂家 PSD 比窗口（数据表只到 32-ary）')
    }
  }
  for (const s of sides) {
    if (isFinite(s.windowMargin) && s.windowMargin < 0) {
      warnings.push('收端「' + s.rxName + '」PSD 比窗口裕量 ' + s.windowMargin.toFixed(2) + ' dB')
    }
  }
  if (!converged) warnings.push('残余自干扰迭代 ' + CNC_MAX_IT + ' 轮未收敛，结果取末轮值')

  return {
    deltaDb: deltaDb,
    deg: deg,
    ciByRow: (function () { const m = {}; for (const s of sides) m[s.rowId] = s.ci; return m })(),
    cnc: {
      cancelDb: opt.cancelDb, ratioMax: opt.ratioMax, minSymKsps: opt.minSymKsps, apc: opt.apc,
      deg0Manual: opt.deg0 !== null,
      windowManual: !!opt.window, rsRatio: rsRatio, iters: iters, converged: converged,
      sides: sides,
      // 节省带宽：相对两条各占一段的常规做法省下的那一份
      bwSaving: ctx.sumBwKHz > 0 ? 1 - ctx.occBwKHz / ctx.sumBwKHz : NaN
    }
  }
}


// 选中集合是否够条件求解；返回空串表示可解，否则是拦下来的原因
export function validateAdv(mode, picked) {
  if (!picked || !picked.length) return '请至少勾选 1 条链路'
  const bad = picked.find((p) => !isFinite(p.bwKHz) || !isFinite(p.pbwKHz) || !isFinite(p.marginDb))
  if (bad) return `链路 #${bad.no} 无可用计算结果（${bad.error || '未计算'}）：请先计算，或取消勾选该行`
  if (mode === 'cnc') {
    if (picked.length !== 2) return `CNC 载波叠加须恰好勾选 2 条链路（一对同频叠加的载波），当前已勾选 ${picked.length} 条`
    // 「两条链路必须引用同一份载波配置」这条要求已撤（2026-09-05）：真实 CnC 多数是非对称的
    // ——前向大、返向小，窄载波完整落在宽载波频带内。同不同一份配置不是判据，同频同极化才是。
    return validateCnc(picked)
  }
  return ''
}

// 把选中链路按载波归堆：一份载波 = 一个未知数（A 为该载波下各链路的归一功率带宽之和）
function groupByCarrier(picked) {
  const map = new Map()
  for (const p of picked) {
    let c = map.get(p.carrierId)
    if (!c) { c = { id: p.carrierId, name: p.carrierName, links: [], A: 0, bwKHz: 0, nWays: 0, margins: [], bases: [] }; map.set(p.carrierId, c) }
    const k = cntOf(p)
    c.links.push(p)
    c.bases.push(num(p.baseDb))
    c.A += normPbw(p.pbwKHz, p.marginDb) * k
    c.bwKHz += p.bwKHz * k
    c.nWays += k
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
  // 偏置：CnC 放开非对称之后，两份载波是两个未知数、一个方程，偏置重新有意义（两条链路仍引用
  // 同一份配置时它自然失效——唯一未知数由方程定死，偏置被 Δ 原样抵消，不必特判）
  const state = o.state || {}
  const base = o.base === 'balance' ? 'balance' : 'current'
  const overDb = num(o.overDb) || 0
  // 不可解也要把载波清单带回去：界面上的偏置输入就长在那张表里，表一空用户就没地方改了
  const fail = (message, carriers) => ({ ok: false, message, carriers: carriers || [], links: [] })
  const carrierRow = (c) => ({
    id: c.id, name: c.name, n: c.links.length, nWays: c.nWays, biasDb: c.biasDb || 0,
    baseDb: c.baseDb, balanceDb: c.balanceDb, fromDb: c.currentDb, toDb: c.toDb, shiftDb: c.shiftDb
  })

  const msg = validateAdv(mode, picked)
  if (msg) return fail(msg)

  const carriers = groupByCarrier(picked)
  const sumBwKHz = picked.reduce((s, p) => s + p.bwKHz * cntOf(p), 0)
  // 组占用带宽：VSAT 各占各的 → 求和；CNC 同频叠加 → 只算一份（两条链路同载波，带宽本就相同）
  const occBwKHz = mode === 'cnc' ? Math.max(...picked.map((p) => p.bwKHz)) : sumBwKHz
  if (!(occBwKHz > 0)) return fail('所选链路的载波带宽为 0，无法配平')
  // 配平目标二选一：Σ载波带宽（各载波紧挨着排）/ 指定带宽（对着租下来的那一段配，
  // 保护带与载波间隔留白由此进账 —— 租 9 MHz 而载波只占 8.2 MHz 时，功率该按 9 MHz 配）。
  // 指定带宽只对 VSAT 有意义：CnC 的组占用带宽由那一份载波定死，没有「租多少」可言。
  const fixedKHz = num(o.targetBwMHz) * 1000
  const useFixed = mode !== 'cnc' && o.target === 'fixed'
  if (useFixed && !(fixedKHz > 0)) return fail('指定带宽须为正数')
  const baseKHz = useFixed ? fixedKHz : occBwKHz
  const targetKHz = baseKHz * lin(overDb)

  // 逐载波定基准：current = 该载波「进本功能之前」的原始余量（宿主给的 baseDb；缺省即此刻的余量。
  // 拿它而不是此刻的余量，反复应用才不会把偏置一层层叠上去——见文件头「幂等」一节）；
  // balance = 令该载波自己的功率带宽等于自己的载波带宽的那个余量（CNC 下带宽只算一份）
  for (const c of carriers) {
    const cBw = mode === 'cnc' ? Math.max(...c.links.map((l) => l.bwKHz)) : c.bwKHz
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

  const warnings = []
  let deltaDb, cncOut = null, degByRow = {}, ciByRow = {}
  if (mode === 'cnc') {
    const r = solveCnc({ carriers, picked, targetKHz, occBwKHz, sumBwKHz, opt: normCncOpt(o.cncOpt), warnings })
    if (r.fail) return fail(r.fail, rows())
    deltaDb = r.deltaDb; cncOut = r.cnc; degByRow = r.deg; ciByRow = r.ciByRow
  } else {
    // Σ功率带宽 = 10^(Δ/10)·Σ A·10^((基准+偏置)/10) = 目标
    const pBase = carriers.reduce((s, c) => s + c.A * lin(c.baseDb + c.biasDb), 0)
    if (!(pBase > 0)) return fail('所选链路的功率带宽为 0，无法配平', rows())
    deltaDb = dB(targetKHz / pBase)
    for (const c of carriers) c.toDb = c.baseDb + c.biasDb + deltaDb
    // 行上带着 CNC 写进去的附加 C/I：VSAT 不动它（那是另一组场景的结论），但要说一声——
    // 本次配平用的功率带宽里含着它，不是纯热噪声账
    for (const p of picked) {
      const d = num(p.extDegDb)
      if (isFinite(d) && d > 0.005) {
        warnings.push(`链路 #${p.no} 行上有附加 C/I 退化 ${d.toFixed(2)} dB，本次配平按含它的功率带宽计`)
      }
    }
  }

  // 落值：逐载波终余量、逐链路解后功率带宽（闭式，与引擎重算逐位一致）
  let afterPbwKHz = 0
  const outLinks = []
  for (const c of carriers) {
    c.shiftDb = c.toDb - c.currentDb
    for (const p of c.links) {
      // CnC 下归一值要把上一轮写回的附加 C/I 退化剥掉（幂等），VSAT 下照旧只剥余量
      const a = mode === 'cnc' ? p.pbwKHz / lin(p.marginDb + (num(p.extDegDb) || 0)) : normPbw(p.pbwKHz, p.marginDb)
      const degHere = degByRow[p.rowId] || 0
      const k = cntOf(p)
      const after = a * lin(c.toDb + degHere) * k
      afterPbwKHz += after
      // 功放可行性（闭式）：引擎里 UPPOWER 含 −转发器工作区回退、DOWNPOWER 含 +载波总C/T，
      // 两者随余量 1:1 平移且选择支不随余量翻转（两个功率比同乘一个因子），故解后功放功率
      // 可以直接由此刻的值平移预测，不必再跑一遍引擎。测试 ⑨ 钉死这条标度律。
      const paW = num(p.paW)
      const paAfterW = isFinite(paW) ? paW * lin(c.toDb - p.marginDb) : NaN
      const paPresetW = num(p.paPresetW)
      outLinks.push({
        rowId: p.rowId, no: p.no, name: p.name, carrierId: c.id, carrierName: c.name,
        count: k,
        bwKHz: p.bwKHz, pbwBefore: p.pbwKHz * k, pbwAfter: after,
        marginBefore: p.marginDb, marginAfter: c.toDb,
        paBeforeW: paW, paAfterW, paPresetW,
        paOver: isFinite(paAfterW) && isFinite(paPresetW) && paPresetW > 0 && paAfterW > paPresetW,
        // 本行收端的附加 C/I 与它吃掉的 C/N（CnC 才有；写回时落到这一行的 carrierExtCI）
        extCI: isFinite(ciByRow[p.rowId]) ? ciByRow[p.rowId] : null,
        extDeg: degHere
      })
    }
    if (c.toDb < 0) warnings.push(`载波「${c.name}」配平余量为 ${c.toDb.toFixed(2)} dB：负余量，该载波达不到解调门限`)
    // 无需再算：功放解后超过发端站型预设值，说明这个余量买不到
    for (const l of outLinks) {
      if (l.carrierId === c.id && l.paOver) {
        warnings.push(`链路 #${l.no} 功放需 ${l.paAfterW.toFixed(1)} W，发端站型预设 ${l.paPresetW.toFixed(1)} W`)
      }
    }
    if (c.margins.some((m) => Math.abs(m - c.currentDb) > 0.005)) {
      warnings.push(`载波「${c.name}」各链路当前系统余量不一致（${c.margins.map((m) => m.toFixed(2)).join(' / ')} dB）：基准取首条链路，配平结果不受影响`)
    }
  }
  // 转发器工作点：整组超过一路载波，而卫星条目上的回退还是单载波那一档 —— 份额整体偏乐观。
  // 阈值取工程常用的多载波下限（OBO ≥ 2 dB / IBO ≥ 4 dB）；卫星条目没给这两个数则不判。
  const nWaysAll = picked.reduce((s, p) => s + cntOf(p), 0)
  if (nWaysAll >= 2) {
    const boo = num(picked[0].booDb), boi = num(picked[0].boiDb)
    if ((isFinite(boo) && boo < 2) || (isFinite(boi) && boi < 4)) {
      warnings.push(`多载波组（${nWaysAll} 路）· 转发器 OBO ${isFinite(boo) ? boo.toFixed(1) : '—'} dB / `
        + `IBO ${isFinite(boi) ? boi.toFixed(1) : '—'} dB`)
    }
  }
  const beforePbwKHz = picked.reduce((s, p) => s + p.pbwKHz * cntOf(p), 0)
  const tpBwKHz = (num(o.tpBwMHz) || 0) * 1000

  return {
    ok: true, message: '', warnings, mode, base, overDb, deltaDb, cnc: cncOut,
    occBwKHz, sumBwKHz, targetKHz, beforePbwKHz, afterPbwKHz,
    residualKHz: afterPbwKHz - targetKHz,
    // 转发器占用率（解后）：带宽按组占用带宽算，功率按 Σ功率带宽算
    bwUsePct: tpBwKHz > 0 ? (occBwKHz / tpBwKHz) * 100 : NaN,
    pwUsePct: tpBwKHz > 0 ? (afterPbwKHz / tpBwKHz) * 100 : NaN,
    ...allUse(o.allRows, outLinks, tpBwKHz),
    carriers: carriers.map(carrierRow),
    links: outLinks
  }
}

// —— 全表占用：本组之外的载波也在同一只转发器上 ——
// 只看本组会低估转发器资源：表里还有别的行没参与这次配平，它们照样占着带宽与功率。
// 参与本组的行取【解后】值，其余行取它们此刻的值；都按各自的路数计。
// allRows 缺省（宿主没给）时返回空对象，读数自然不出——不编一个数。
function allUse(allRows, outLinks, tpBwKHz) {
  if (!Array.isArray(allRows) || !allRows.length || !(tpBwKHz > 0)) return {}
  const solved = new Map(outLinks.map((l) => [l.rowId, l]))
  let bw = 0, pw = 0, n = 0
  for (const r of allRows) {
    const hit = solved.get(r.rowId)
    const k = cntOf(r)
    const b = hit ? hit.bwKHz * hit.count : num(r.bwKHz) * k
    const p = hit ? hit.pbwAfter : num(r.pbwKHz) * k
    if (!isFinite(b) || !isFinite(p)) continue
    bw += b; pw += p; n++
  }
  if (!n) return {}
  return { bwUseAllPct: (bw / tpBwKHz) * 100, pwUseAllPct: (pw / tpBwKHz) * 100, allRowsN: n }
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
 *   links     solveAdv 回的链路清单（只取 rowId / extCI —— CnC 解出的附加 C/I）
 * @returns {{ ops: Array, rowPatches: Array }} ops：
 *   { kind:'inplace', carrierId, name, formPatch }               —— 就地改这份配置
 *   { kind:'fork', fromId, name, rowIds, formPatch }             —— 复制 fromId 一份、名为 name，
 *                                                                   把 rowIds 这些行改指过去
 *   formPatch 一律直接 Object.assign 进目标 form
 * rowPatches：{ rowId, patch } —— 直接写在【链路行】上的字段（不进载波配置）。
 *   目前只有 CnC 的 carrierExtCI：残余自干扰是「这一对双工链路在这套工况下」的结论，
 *   收端各是各的数，载波配置装不下（同一份载波两条链路要写两个不同的值）。
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
  // 行级写回：CnC 解出的附加 C/I 落到【对应收端那一行】。VSAT 一条不发——行上若已有 CnC
  // 写进去的值，那是另一组场景的结论，不该被这一组顺手抹掉（solveAdv 里已就此告警）。
  const rowPatches = []
  if (mode === 'cnc') {
    for (const l of (o.links || [])) {
      const ci = Number(l && l.extCI)
      if (Number.isFinite(ci)) rowPatches.push({ rowId: l.rowId, patch: { carrierExtCI: ci.toFixed(3) } })
    }
  }
  return { ops, rowPatches }
}
