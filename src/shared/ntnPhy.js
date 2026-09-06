// 3GPP NTN 载波的物理层口径（纯函数，平台无关）——占用带宽 / 信道带宽 / TBS / 信息速率 / 含重复的有效门限。
//
// 由来：平台原先把 3GPP 的两张 MODCOD 表塞进 DVB 那条链算（信息速率 →÷帧效率÷FEC→ 符号率 →×滚降→ 载波带宽），
// 于是「噪声带宽」是由用户填的信息速率和一个经验帧效率 0.9 反推出来的数，PRB 数与子载波间隔在平台里根本不存在。
// 厂家/3GPP 谈的 SNR 不是这个：
//
//   TS 38.215 §5.1.6 的 SS-SINR / CSI-SINR 按【资源元素 RE】定义；MATLAB 5G Toolbox 的链路级仿真
//   （"SNR Definition Used in Link Simulations"）同样 SNR = S_RE / N_RE；gNB 从 DMRS 估出来的 PUSCH SNR、
//   模组 AT 指令回的 SNR 也都是这一口径。
//
//   对 OFDM：信号功率均摊在 N_sc = N_RB×12 个子载波上，S_RE = C / N_sc；每 RE 噪声 N_RE = N₀·SCS；
//   于是 SNR_RE = C / (N₀ · N_RB·12·SCS) = C / (N₀ · B_occ)。又 Es = S_RE/SCS，故 Es/N₀ ≡ SNR_RE。
//   ★ 三者是同一个数，前提只有一条：噪声带宽取【占用带宽 B_occ = N_RB × 12 × SCS】
//     （NB-IoT 上行 = 子载波数 × SCS）。CP 被接收端丢掉、DMRS 不载数据，这些只进 Eb/N₀，不进 SNR。
//
// 所以改法不是「加一个换算系数」，而是让 3GPP 载波按 PRB / SCS / MCS / 重复描述，噪声带宽 = 占用带宽，
// SNR 自然就对上。旧链按帧效率 0.9 反推符号率，比厂家口径高 0.50 dB（下行 OH 0.14）/ 0.20 dB（上行 OH 0.08）。
//
// 出处：TS 38.214 §5.1.3.1 / §5.1.3.2 / §6.1.4.1（MCS 表与 TBS）、TS 38.215 §5.1.6（SINR 定义）、
//       TS 38.306 §4.1.2（速率近似式与 OH）、TS 38.101-5（信道带宽 ↔ N_RB）、
//       TS 36.213 §16.4.1.5 / §16.5.1.2（NB-IoT TBS 与单音 I_MCS 映射）、TR 38.821 / TR 36.763（NTN 链路预算）。
//
// ★ 本文件是 packages/core/utils/ntnPhy.js 的【渲染端手写副本】——那边是 CJS、只在主进程跑，
//   而载波面板要在渲染端实时算占用带宽/信息速率/TBS，走 IPC 问一次不现实。两份必须逐值一致，
//   packages/core/test/ntnPhy.test.mjs 拿同一组向量逐条对拍，改一处必须改另一处。

// ===== 子载波间隔 → numerology μ（时隙长度 = 1 ms / 2^μ）=====
export const MU_OF = { 15: 0, 30: 1, 60: 2, 120: 3 }

// ===== 信道带宽(MHz) → N_RB（TS 38.101-5 Table 5.3.2-1，与 TS 38.101-1 同值）=====
// FR1-NTN：n254(L) / n255(S) / n256(S)，5…30 MHz；30 MHz 是 Rel-18 给 n255 新增的档。
// FR2-NTN：n510 / n511 / n512（Ka），50…400 MHz —— 这一段按 TS 38.101-2 的同带宽档收录，
//   TS 38.101-5 Rel-18 的 FR2-NTN 表尚未逐值核到原文（诚实边界）。
// 同一 SCS 下 FR1 与 FR2 的带宽档不重叠（5/10/15/20/30 vs 50/100/200/400），故并成一张表；
// 需要分开时（例如只给 FR1 的老配置判带宽超限）用下面这两个清单，别拿数值大小去猜。
export const NR_RB_TABLE = {
  15: { 5: 25, 10: 52, 15: 79, 20: 106, 30: 160 },
  30: { 5: 11, 10: 24, 15: 38, 20: 51, 30: 78 },
  60: { 10: 11, 15: 18, 20: 24, 30: 38, 50: 66, 100: 132, 200: 264 },
  120: { 50: 32, 100: 66, 200: 132, 400: 264 }
}

export const NR_FR1_BW_MHZ = [5, 10, 15, 20, 30]      // n254 / n255 / n256（L/S）
export const NR_FR2_BW_MHZ = [50, 100, 200, 400]      // n510 / n511 / n512（Ka）

// ===== TS 38.214 Table 5.1.3.2-1：N_info ≤ 3824 时的 TBS 量化表（93 档）=====
export const TBS_QUANT = [
  24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144, 152, 160, 168, 176,
  184, 192, 208, 224, 240, 256, 272, 288, 304, 320, 336, 352, 368, 384, 408, 432, 456, 480,
  504, 528, 552, 576, 608, 640, 672, 704, 736, 768, 808, 848, 888, 928, 984, 1032, 1064,
  1128, 1160, 1192, 1224, 1256, 1288, 1320, 1352, 1416, 1480, 1544, 1608, 1672, 1736, 1800,
  1864, 1928, 2024, 2088, 2152, 2216, 2280, 2408, 2472, 2536, 2600, 2664, 2728, 2792, 2856,
  2976, 3104, 3240, 3368, 3496, 3624, 3752, 3824
]

// ===== NB-IoT TBS 表（TS 36.213 v13.2.0，Rel-13）=====
// 行 = I_TBS 0–12，列 = I_SF / I_RU 0–7。空档（该 I_TBS 下这个子帧数/RU 数不允许）记 null。
// ★ Rel-14 Cat-NB2 的 I_TBS=13 扩展行未收：原文未核到，不编造。门限表里 I_TBS=13 那一行照收
//   （Kodheli 2019 表 3 给了门限），选到它时 TBS 查不到 → 引擎报错，不静默按 12 档算。
export const NB_TBS_DL = [   // NPDSCH Table 16.4.1.5.1-1，列 I_SF 0–7 ↔ N_SF = 1,2,3,4,5,6,8,10
  [16, 32, 56, 88, 120, 152, 208, 256],
  [24, 56, 88, 144, 176, 208, 256, 344],
  [32, 72, 144, 176, 208, 256, 328, 424],
  [40, 104, 176, 208, 256, 328, 440, 568],
  [56, 120, 208, 256, 328, 408, 552, 680],
  [72, 144, 224, 328, 424, 504, 680, null],
  [88, 176, 256, 392, 504, 600, null, null],
  [104, 224, 328, 472, 584, 680, null, null],
  [120, 256, 392, 536, 680, null, null, null],
  [136, 296, 456, 616, null, null, null, null],
  [144, 328, 504, 680, null, null, null, null],
  [176, 376, 584, null, null, null, null, null],
  [208, 440, 680, null, null, null, null, null]
]
export const NB_TBS_UL = [   // NPUSCH Table 16.5.1.2-2，列 I_RU 0–7 ↔ N_RU = 1,2,3,4,5,6,8,10
  [16, 32, 56, 88, 120, 152, 208, 256],
  [24, 56, 88, 144, 176, 208, 256, 344],
  [32, 72, 144, 176, 208, 256, 328, 424],
  [40, 104, 176, 208, 256, 328, 440, 568],
  [56, 120, 208, 256, 328, 408, 552, 680],
  [72, 144, 224, 328, 424, 504, 680, 872],
  [88, 176, 256, 392, 504, 600, 808, 1000],
  [104, 224, 328, 472, 584, 712, 1000, null],
  [120, 256, 392, 536, 680, 808, null, null],
  [136, 296, 456, 616, 776, 936, null, null],
  [144, 328, 504, 680, 872, 1000, null, null],
  [176, 376, 584, 776, 1000, null, null, null],
  [208, 440, 680, 1000, null, null, null, null]
]
export const NB_SF_COUNT = [1, 2, 3, 4, 5, 6, 8, 10]   // I_SF / I_RU → N_SF / N_RU

// NPUSCH 单音 Table 16.5.1.2-1：I_MCS → (调制, I_TBS)。
// π/2-BPSK 在平台调制体系里记作 BPSK（M-PSK, M=2）、π/4-QPSK 记作 QPSK —— 相位旋转只影响 PAPR，
// 不影响 bit/符号，故调制因子一致。
export const NB_ST_MCS = [
  { modulation: 'BPSK', label: 'pi/2-BPSK', iTbs: 0 },
  { modulation: 'BPSK', label: 'pi/2-BPSK', iTbs: 2 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 1 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 3 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 4 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 5 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 6 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 7 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 8 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 9 },
  { modulation: 'QPSK', label: 'pi/4-QPSK', iTbs: 10 }
]

// ===== 重复次数 N_rep 的值域 =====
// NB-IoT 是【枚举】不是任意整数：填 3 或 5000 照算的话，门限按 10lg N 白降下来，
// 配出来的是网络根本下发不了的重复次数。TS 36.213 Table 16.4.1.3-2（NPDSCH）与 16.5.1.1-3（NPUSCH）。
export const NB_NREP_DL = [1, 2, 4, 8, 16, 32, 64, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048]
export const NB_NREP_UL = [1, 2, 4, 8, 16, 32, 64, 128]
// NR 只判上限（档位随版本增补，卡死枚举会把合法配置误判成错）。2026-09-06 逐条核 TS 38.331 V17.5.0：
//   PDSCH：repetitionNumber-r16 / -v1730 = {n2,n3,n4,n5,n6,n7,n8,n16}、pdsch-AggregationFactor = {n2,n4,n8}
//          → 上限 16。
//   PUSCH：numberOfRepetitionsExt-r17 = {n1,n2,n3,n4,n7,n8,n12,n16}（★ 到 16，不是 32——原任务书把它
//          写成 n32 了）、pusch-AggregationFactor = {n2,n4,n8}；到 n32 的是同一个扩展组里的
//          numberOfSlotsTBoMS-r17（一个传输块跨多个时隙），它在链路预算上与重复同效——门限 −10lg N、
//          速率 ÷ N，故上行上限仍按 32 收，不把 Rel-17 覆盖增强的这一档挡在外面。
export const NR_NREP_MAX_UL = 32
export const NR_NREP_MAX_DL = 16

// ===== TS 38.306 §4.1.2 的开销系数 OH（近似速率式用）=====
// FR1 下行 0.14 / 上行 0.08；FR2 下行 0.18 / 上行 0.10。FR1/FR2 以 SCS 分界（120 kHz 只在 FR2）。
function ohOf(phy) {
  const fr2 = Number(phy.scs) >= 120
  return phy.dir === 'ul' ? (fr2 ? 0.10 : 0.08) : (fr2 ? 0.18 : 0.14)
}

// 一个资源单元 RU 的时长(ms)：子载波数 + SCS 决定（TS 36.211 Table 10.1.2.3-1）
export function nbRuMs(phy) {
  if (Number(phy.scs) === 3.75) return 32
  const t = Number(phy.nTones)
  if (t === 1) return 8
  if (t === 3) return 4
  if (t === 6) return 2
  return 1                                       // 12 子载波
}

const numOr = (v, d) => { const n = Number(v); return isFinite(n) ? n : d }
const intOr = (v, d) => { const n = Math.round(Number(v)); return isFinite(n) ? n : d }

// ===== 载波描述子归一化 =====
// 认不出（非 3GPP 载波、或 kind 不对）一律返回 null —— 引擎据此判「这条不是 snr 行」。
// ★ 入参可能是 IPC 过来的纯数据，也可能是渲染端的响应式代理；本函数只读不写，返回全新纯对象。
export function normalizePhy(p) {
  if (!p || typeof p !== 'object') return null
  const kind = String(p.kind || '').toLowerCase()
  const dir = String(p.dir || '').toLowerCase() === 'ul' ? 'ul' : 'dl'
  const nRep = Math.max(1, intOr(p.nRep, 1))
  const combLossDb = numOr(p.combLossDb, 0)
  if (kind === 'nr') {
    let scs = intOr(p.scs, 15)
    if (MU_OF[scs] === undefined) scs = 15
    const chBw = (p.chBwMHz === '' || p.chBwMHz == null) ? NaN : numOr(p.chBwMHz, NaN)
    const mcsTable = String(p.mcsTable || 't1')
    // ★ 变换预编码表只用于 transform precoding 使能的 PUSCH（TS 38.214 §6.1.4.1）——
    //   PDSCH 没有这两张表。放任它选下行，配出来的是标准里不存在的下行载波（π/2-BPSK 的
    //   MCS 0/1 更是只在上行有），故这里强制归上行，不给用户留一个配得出来的错。
    const tp = mcsTable === 'tp1' || mcsTable === 'tp2'
    const nrDir = tp ? 'ul' : dir
    return {
      kind: 'nr', dir: nrDir, scs,
      nRb: Math.max(1, intOr(p.nRb, 25)),
      chBwMHz: isFinite(chBw) && chBw > 0 ? chBw : null,
      mcsTable,
      mcs: Math.max(0, intOr(p.mcs, 0)),
      q: intOr(p.q, 2) === 1 ? 1 : 2,
      nSymb: Math.max(1, Math.min(14, intOr(p.nSymb, nrDir === 'ul' ? 14 : 12))),
      nDmrs: Math.max(0, intOr(p.nDmrs, 12)),
      nOh: Math.max(0, intOr(p.nOh, 0)),
      rateModel: String(p.rateModel || 'tbs') === 'oh38306' ? 'oh38306' : 'tbs',
      oh: (p.oh === '' || p.oh == null || !isFinite(Number(p.oh))) ? null : numOr(p.oh, null),
      layers: Math.max(1, intOr(p.layers, 1)),
      nRep, combLossDb
    }
  }
  if (kind === 'nbiot') {
    // ★ 下行 NPDSCH 的载波结构是定死的：12 个子载波 × 15 kHz = 180 kHz，一个 NB-IoT 载波就这么宽
    //   （TS 36.211 §10.2.3）。3.75 kHz 子载波间隔与「少于 12 个子载波」都只存在于【上行】NPUSCH
    //   （§10.1.2 的 single-tone / multi-tone）。下行强制归位，不接受这两个参数——放任它们进来，
    //   占用带宽会算成 3.75 kHz，频谱效率报出 34 bps/Hz 这种数。
    const ul = dir === 'ul'
    // ★ st = 这条载波挂的是不是 NPUSCH【单音表】——它是标准属性（跟着 MODCOD 表走，见
    //   modcodTables.PHY_OF），不是用户偏好：
    //     true  = 单音表，恒 1 个子载波；表里的行号是 I_MCS，要经 Table 16.5.1.2-1 映射成 I_TBS
    //     false = 多音表，3/6/12 子载波、恒 15 kHz；行号直接就是 I_TBS，且 TS 36.213 §16.5.1.2
    //             规定 N_sc^RU > 1 时恒 QPSK（单音那两档 π/2-BPSK 套不上来）
    //     null  = 自建标准 / 老配置，行号口径只有填表的人知道，一律不锁（照旧按当前子载波数判）
    //   两张表的门限差 1.6 dB@I_TBS 0 … 3.8 dB@I_TBS 10，选定表之后再改子载波数，
    //   等于拿另一张表的门限算这条载波。
    const st = p.st === true ? true : (p.st === false ? false : null)
    // 3.75 kHz 只在上行 NPUSCH 单音；多音表没有这一档
    const scs = (ul && st !== false && Number(p.scs) === 3.75) ? 3.75 : 15
    let nTones = ul ? intOr(p.nTones, 12) : 12
    if ([1, 3, 6, 12].indexOf(nTones) < 0) nTones = 12
    if (scs === 3.75) nTones = 1                 // 3.75 kHz 只有单音
    if (st === true) nTones = 1                  // 单音表锁死 1 个子载波
    // ★ st === false 且填了 1：【不归正】，留给 resolve() 报错。悄悄改成 3 音等于替用户挑了
    //   一个他没选的配置，而门限还是多音那一列的——比单音低 1.6~3.8 dB，账面上一切正常。
    return {
      kind: 'nbiot', dir, st, scs, nTones,
      iTbs: Math.max(0, intOr(p.iTbs, 0)),
      iSf: Math.max(0, Math.min(7, intOr(p.iSf, 0))),
      iRu: Math.max(0, Math.min(7, intOr(p.iRu, 0))),
      nRep, combLossDb
    }
  }
  return null
}

// ===== NR =====
export function nrRbTable(scs) { return NR_RB_TABLE[Number(scs)] || null }

// 占用带宽 B_occ = N_RB × 12 × SCS（kHz）—— ★ SNR / Es/N₀ / C/N 的噪声带宽就是它
export function nrOccupiedBwKHz(phy) { return phy.nRb * 12 * phy.scs }

// 信道带宽（kHz）：显式给了就用；否则【只对下行】查表取「能装下这些 PRB 的最小档」；查不到退回占用带宽。
// 只用于信道带宽档位核对与转发器占用比，不当噪声带宽（与每 RE SNR 差 0.18~0.46 dB）。
//
// ★ 上行不查表：一条上行载波 = 一个终端本次的分配，它在转发器上占的就是自己那点占用带宽。
//   拿「装得下 1 PRB 的最小信道档」去当它的载波带宽，会把 180 kHz 的 PUSCH 报成 5 MHz——
//   转发器带宽占用比当场虚高 27 倍。要按整载波算占用的，显式填信道带宽（显式恒优先）。
export function nrChannelBwKHz(phy) {
  if (phy.chBwMHz != null && isFinite(phy.chBwMHz) && phy.chBwMHz > 0) return phy.chBwMHz * 1000
  if (phy.dir === 'ul') return nrOccupiedBwKHz(phy)
  const tbl = nrRbTable(phy.scs)
  if (tbl) {
    let best = null
    for (const k of Object.keys(tbl)) {
      const bw = Number(k)
      if (tbl[k] >= phy.nRb && (best == null || bw < best)) best = bw
    }
    if (best != null) return best * 1000
  }
  return nrOccupiedBwKHz(phy)
}

// 该子载波间隔下表里最大的一档信道带宽能装几个 PRB —— 用来判「PRB 数填过了头」。
// 返回 { nRb, bwMHz }；表里没有这个 SCS 返回 null。
export function nrMaxRb(scs) {
  const t = nrRbTable(scs)
  if (!t) return null
  let best = null
  for (const k of Object.keys(t)) if (best == null || t[k] > best.nRb) best = { nRb: t[k], bwMHz: Number(k) }
  return best
}

// TS 38.214 §5.1.3.2 精确 TBS（bit / 时隙）。Qm = 调制阶数(bit/符号), R = 目标码率(0–1)。
// 只算 PDSCH/PUSCH 的数据 RE，不含 PDCCH/SSB/CSI-RS 的系统级开销（那些在 oh38306 模型里）。
export function nrTbsPerSlot(phy, Qm, R) {
  if (!(Qm > 0) || !(R > 0)) return null
  const nRePrime = 12 * phy.nSymb - phy.nDmrs - phy.nOh
  if (!(nRePrime > 0)) return null
  const nRe = Math.min(156, nRePrime) * phy.nRb
  const nInfo = nRe * R * Qm * phy.layers
  if (!(nInfo > 0)) return null
  if (nInfo <= 3824) {
    const n = Math.max(3, Math.floor(Math.log2(nInfo)) - 6)
    const p = Math.pow(2, n)
    const quant = Math.max(24, p * Math.floor(nInfo / p))
    for (let i = 0; i < TBS_QUANT.length; i++) if (TBS_QUANT[i] >= quant) return TBS_QUANT[i]
    return TBS_QUANT[TBS_QUANT.length - 1]
  }
  const n = Math.floor(Math.log2(nInfo - 24)) - 5
  const p = Math.pow(2, n)
  // 标准要求 .5 向上取整；(nInfo−24)/2^n 恒为正，Math.round 正好是这个语义
  const quant = Math.max(3840, p * Math.round((nInfo - 24) / p))
  if (R <= 0.25) {
    const C = Math.ceil((quant + 24) / 3816)
    return 8 * C * Math.ceil((quant + 24) / (8 * C)) - 24
  }
  if (quant > 8424) {
    const C = Math.ceil((quant + 24) / 8424)
    return 8 * C * Math.ceil((quant + 24) / (8 * C)) - 24
  }
  return 8 * Math.ceil((quant + 24) / 8) - 24
}

// 信息速率（kbps）。两个模型：
//   'tbs'      —— 每时隙 TBS × 每秒时隙数(1000·2^μ)，厂家谈的就是这个口径，缺省
//   'oh38306'  —— TS 38.306 §4.1.2 近似式，含 PDCCH/SSB/CSI-RS 的平均系统开销
// 两者都 ÷ 重复次数（重复只提门限、不提速率）。
export function nrInfoRateKbps(phy, Qm, R) {
  if (phy.rateModel === 'oh38306') {
    if (!(Qm > 0) || !(R > 0)) return null
    const oh = (phy.oh != null && isFinite(phy.oh)) ? phy.oh : ohOf(phy)
    // N_RB·12/T_s ≡ B_occ · 14/15（T_s 是含 CP 的平均符号时长 = 1ms/(14·2^μ)）
    return nrOccupiedBwKHz(phy) * (14 / 15) * (1 - oh) * Qm * R * phy.layers / phy.nRep
  }
  const tbs = nrTbsPerSlot(phy, Qm, R)
  if (tbs == null) return null
  return tbs * Math.pow(2, MU_OF[phy.scs]) / phy.nRep
}

// ===== NB-IoT =====
export function nbOccupiedBwKHz(phy) { return phy.nTones * phy.scs }

// 信道带宽（kHz）。下行一条载波就是整个 NB-IoT 载波，落在 200 kHz 栅格上（占用 180 kHz）。
// ★ 上行一律报占用带宽，与 NR 上行同一把尺：一条上行载波 = 一个终端本次的分配，它在转发器上占的
//   就是自己那几个子载波。满 12 子载波曾按 200 kHz 报（把栅格的 20 kHz 保护带算成这个终端占的），
//   转发器带宽占用比虚高 11%，且与 NR 上行「不查表」的口径正好相反。
export function nbChannelBwKHz(phy) {
  if (phy.dir === 'dl') return 200
  return nbOccupiedBwKHz(phy)
}

// TBS（bit / 传输块）。越界（该 I_TBS 下这个 I_SF/I_RU 不存在）返回 null。
export function nbTbs(phy) {
  const tbl = phy.dir === 'ul' ? NB_TBS_UL : NB_TBS_DL
  const row = tbl[phy.iTbs]
  if (!row) return null
  const v = row[phy.dir === 'ul' ? phy.iRu : phy.iSf]
  return v == null ? null : v
}

// 该 I_TBS 行允许的最大 I_SF / I_RU 下标（表里最后一个非空格）；整行皆空返回 −1。
// Cat-NB1 的 TBS 有上限（下行 680 bit / 上行 1000 bit），越靠后的 I_TBS 行越短。
export function nbMaxSfIdx(phy) {
  const tbl = phy.dir === 'ul' ? NB_TBS_UL : NB_TBS_DL
  const row = tbl[phy.iTbs]
  if (!row) return -1
  let last = -1
  for (let i = 0; i < row.length; i++) if (row[i] != null) last = i
  return last
}

// I_MCS → (调制, I_TBS)：NPUSCH 单音专用（多音 I_MCS ≡ I_TBS，QPSK）
export function nbSingleToneMcs(iMcs) { return NB_ST_MCS[intOr(iMcs, -1)] || null }

// 信息速率（kbps）：下行 TBS/(N_SF·1ms·N_rep)，上行 TBS/(N_RU·T_RU·N_rep)
export function nbInfoRateKbps(phy) {
  const tbs = nbTbs(phy)
  if (tbs == null) return null
  if (phy.dir === 'ul') return tbs / (NB_SF_COUNT[phy.iRu] * nbRuMs(phy) * phy.nRep)
  return tbs / (NB_SF_COUNT[phy.iSf] * phy.nRep)
}

// ===== 通用 =====
// 重复次数的值域校验。返回空串 = 合法。
// NB-IoT 报枚举全表（合法值就那么几个，列出来用户能直接改）；NR 只报上限。
export function nRepError(phy) {
  const n = phy.nRep
  if (phy.kind === 'nbiot') {
    const ul = phy.dir === 'ul'
    const list = ul ? NB_NREP_UL : NB_NREP_DL
    if (list.indexOf(n) < 0) {
      return '重复次数 ' + n + ' 不是 ' + (ul ? 'NPUSCH' : 'NPDSCH') + ' 的合法档，可取 ' + list.join(' / ')
    }
    return ''
  }
  const mx = phy.dir === 'ul' ? NR_NREP_MAX_UL : NR_NREP_MAX_DL
  if (n > mx) return '重复次数 ' + n + ' 超出 ' + (phy.dir === 'ul' ? 'PUSCH' : 'PDSCH') + ' 上限 ' + mx
  return ''
}

// 含重复的有效门限：SNR_req(N) = SNR_req(1) − 10lg N + L_comb。
// 理想合并 L_comb = 0（MATLAB NB-IoT NTN 示例即按 10lg N 折算）；非理想信道估计下 0.5–1.5 dB，缺省 0。
export function effectiveThresholdDb(thresholdDb, phy) {
  // ★ Number('') 与 Number(null) 都是 0：不先挡住空值，缺门限的行会静默按 0 dB 算出一个像样的余量
  if (thresholdDb === '' || thresholdDb == null) return null
  const t = Number(thresholdDb)
  if (!isFinite(t)) return null
  const rep = phy && phy.nRep > 0 ? phy.nRep : 1
  const loss = phy && isFinite(phy.combLossDb) ? phy.combLossDb : 0
  return t - 10 * Math.log10(rep) + loss
}

export function occupiedBwKHz(phy) { return phy.kind === 'nr' ? nrOccupiedBwKHz(phy) : nbOccupiedBwKHz(phy) }
export function channelBwKHz(phy) { return phy.kind === 'nr' ? nrChannelBwKHz(phy) : nbChannelBwKHz(phy) }
export function infoRateKbps(phy, Qm, R) { return phy.kind === 'nr' ? nrInfoRateKbps(phy, Qm, R) : nbInfoRateKbps(phy) }
export function tbsOf(phy, Qm, R) { return phy.kind === 'nr' ? nrTbsPerSlot(phy, Qm, R) : nbTbs(phy) }

/**
 * 引擎入口：一次算齐 snr 行要的全部量。
 * rawPhy 未归一化亦可；Qm = 调制阶数(bit/符号)、R = 目标码率(0–1)，来自选中的 MODCOD 行。
 * 返回 null = 这不是 3GPP 载波；返回对象里 error 非空 = 参数越界，其余数值字段为 null。
 */
export function resolve(rawPhy, Qm, R) {
  const phy = normalizePhy(rawPhy)
  if (!phy) return null
  const bOccKHz = occupiedBwKHz(phy)
  const bChKHz = channelBwKHz(phy)
  const tbs = tbsOf(phy, Qm, R)
  const rate = infoRateKbps(phy, Qm, R)
  let error = ''
  if (!(bOccKHz > 0)) error = '占用带宽为零'
  // 多音表配单子载波：标准里没有这个组合（TS 36.213 §16.5.1.2），且门限、I_MCS↔I_TBS 映射两头都不对
  else if (phy.kind === 'nbiot' && phy.st === false && phy.nTones === 1) {
    error = 'NPUSCH 多音表不含单子载波配置'
  } else if (nRepError(phy)) { error = nRepError(phy) }
  // 占用带宽不能超过信道带宽：显式填了 5 MHz 信道又把 PRB 数改到 50，配出来的是标准里不存在的载波。
  // 上行的信道带宽就是占用带宽本身（见 nrChannelBwKHz），这一条对它恒不触发，故另有下面那条。
  else if (bChKHz > 0 && bOccKHz > bChKHz + 1e-9) {
    error = '占用带宽 ' + bOccKHz + ' kHz 超过信道带宽 ' + bChKHz + ' kHz'
  } else if (phy.kind === 'nr' && (() => { const m = nrMaxRb(phy.scs); return m && phy.nRb > m.nRb })()) {
    const m = nrMaxRb(phy.scs)
    error = 'PRB 数 ' + phy.nRb + ' 超出 ' + phy.scs + ' kHz 的最大信道带宽档（' + m.bwMHz + ' MHz = ' + m.nRb + ' PRB）'
  } else if (tbs == null) {
    if (phy.kind !== 'nbiot') error = 'NR TBS 算不出（调制阶数或码率无效）'
    else if (phy.iTbs > 12) error = 'NB-IoT I_TBS=' + phy.iTbs + ' 的 TBS 表（Rel-14 Cat-NB2）未收录'
    else {
      // 报「上限是多少」而不是「这一格没有」：界面上那个下拉显示的是子帧数 / RU 数本身（1…10），
      // I_SF / I_RU 这个下标一个字都不出现，照抄下标等于没说。
      const ul = phy.dir === 'ul'
      const mx = nbMaxSfIdx(phy)
      error = 'NB-IoT I_TBS=' + phy.iTbs + ' 的' + (ul ? ' RU 数' : '子帧数') + '上限 ' +
        (mx >= 0 ? NB_SF_COUNT[mx] : 0) + '，当前 ' + NB_SF_COUNT[ul ? phy.iRu : phy.iSf]
    }
  } else if (!(rate > 0)) error = '信息速率为零'
  return {
    phy,
    bOccKHz: error ? null : bOccKHz,
    bChKHz: error ? null : bChKHz,
    tbs: error ? null : tbs,
    tbsUnit: phy.kind === 'nr' ? 'slot' : (phy.dir === 'ul' ? 'ru' : 'sf'),
    infoRateKbps: error ? null : rate,
    nRep: phy.nRep,
    combLossDb: phy.combLossDb,
    error
  }
}

/**
 * 引擎的 snr 分支：一次给出「替换 DVB 换算链」要的全部量。
 * thresholdDb = MODCOD 行的门限（表值，不含重复折算）；Qm / R 来自同一行的调制方式与 FEC 码率。
 *
 * 返回 null = 这不是 3GPP 载波，引擎照旧走 DVB 链（信息速率 →÷帧效率÷FEC→ 载波速率 →×扩频→ 码片率
 * →÷调制因子→ 符号率 →×滚降→ 载波带宽）。error 非空 = 参数越界，数值字段一律 null，
 * 调用方应当场抛错，不要拿半个数往下算。
 *
 * ★ symbolRate := B_occ 是【刻意】的：引擎下游一行 `noiseBW = symbolRate` 就是噪声带宽，
 *   把占用带宽放进这个位置，恒等式 thresholdCN = ebno + 10lg(infoRate/noiseBW) 立刻就等于门限 SNR，
 *   整条功率链一个字不用改。代价是这个变量对 3GPP 行名不副实（OFDM 的真符号率 = B_occ×14/15，
 *   即每秒的 RE 数），故引擎【不出】符号率/载波速率/码片速率三个 DVB 读数，改出 noiseBw。
 */
export function engineChain(rawPhy, thresholdDb, Qm, R) {
  const rv = resolve(rawPhy, Qm, R)
  if (!rv) return null
  const out = {
    phy: rv.phy, tbs: rv.tbs, tbsUnit: rv.tbsUnit, nRep: rv.nRep, combLossDb: rv.combLossDb,
    thresholdTable: null, tbsReported: null, error: rv.error,
    infoRate: null, symbolRate: null, allocBandwidth: null, k: null, esno: null, ebno: null
  }
  if (rv.error) return out
  const thr = effectiveThresholdDb(thresholdDb, rv.phy)
  if (thr == null) { out.error = '门限值为空'; return out }
  out.thresholdTable = Number(thresholdDb)
  // 走 38.306 近似式时不报 TBS：那条路的速率不是「每时隙 TBS × 时隙数」，两个数并列摆在级联表里
  // 只会让人去乘一遍然后发现对不上。NB-IoT 的速率本来就由 TBS 定，照报。
  out.tbsReported = (rv.phy.kind === 'nr' && rv.phy.rateModel === 'oh38306') ? null : rv.tbs
  out.infoRate = rv.infoRateKbps
  out.symbolRate = rv.bOccKHz
  out.allocBandwidth = rv.bChKHz
  out.k = rv.infoRateKbps / rv.bOccKHz          // 占用带宽上的频谱效率 bit/s/Hz
  out.esno = thr                                 // 含重复折算的有效门限 ≡ 每 RE SNR ≡ B_occ 内的 C/N
  out.ebno = thr - 10 * Math.log10(out.k)        // Eb/N₀ 自动把 CP / DMRS / 开销 / 重复全算进去
  return out
}

// MCS 表 key → 短名（描述串与级联用）
export const MCS_TABLE_SHORT = { t1: 'T1', t2: 'T2', t3: 'T3', tp1: 'TP1', tp2: 'TP2' }
export const MCS_TABLE_ZH = { t1: '表1', t2: '表2', t3: '表3', tp1: '预编码表1', tp2: '预编码表2' }

// 这条载波在标准表里的档位：NR 报「哪张 MCS 表 + 第几档」，NB-IoT 报 I_TBS（一个纯数，无需翻译）。
// 级联表拿它当「MCS」/「I_TBS」那一行的值；标签随 kind 走，由级联表按当前语言给。
export function mcsLabel(rawPhy, lang) {
  const phy = normalizePhy(rawPhy)
  if (!phy) return ''
  if (phy.kind !== 'nr') return String(phy.iTbs)
  const en = String(lang || 'zh').toLowerCase().indexOf('en') === 0
  const tbl = en ? (MCS_TABLE_SHORT[phy.mcsTable] || phy.mcsTable) : (MCS_TABLE_ZH[phy.mcsTable] || phy.mcsTable)
  return tbl + ' · MCS ' + phy.mcs
}

// 传输方向的中/英文本（数据的呈现由 core 现造，呈现层不许翻——见 describe 的同款说明）
export function dirLabel(rawPhy, lang) {
  const phy = normalizePhy(rawPhy)
  if (!phy) return ''
  const en = String(lang || 'zh').toLowerCase().indexOf('en') === 0
  return phy.dir === 'ul' ? (en ? 'Uplink' : '上行') : (en ? 'Downlink' : '下行')
}

// NB-IoT 一个传输块摊在几个子帧（下行 NPDSCH）/ 几个资源单元（上行 NPUSCH）上 —— 报的是数目本身
// （1…10），不是 I_SF / I_RU 那个下标。NR 没有这个概念，返回 null。
export function nbUnitCount(rawPhy) {
  const phy = normalizePhy(rawPhy)
  if (!phy || phy.kind !== 'nbiot') return null
  return NB_SF_COUNT[phy.dir === 'ul' ? phy.iRu : phy.iSf]
}

/**
 * 载波描述短串（资源库自动命名 / 级联表头用）。
 * ★ 这是数据不是界面文案：中英两版由 lang 现造，绝不在渲染时替换（自动名必须 byLang 生成）。
 */
export function describe(rawPhy, lang) {
  const phy = normalizePhy(rawPhy)
  if (!phy) return ''
  const en = String(lang || 'zh').toLowerCase().indexOf('en') === 0
  const dir = phy.dir === 'ul' ? (en ? 'UL' : '上行') : (en ? 'DL' : '下行')
  if (phy.kind === 'nr') {
    const tbl = en ? (MCS_TABLE_SHORT[phy.mcsTable] || phy.mcsTable) : (MCS_TABLE_ZH[phy.mcsTable] || phy.mcsTable)
    return 'NR ' + dir + ' · ' + phy.nRb + ' PRB × ' + phy.scs + ' kHz · ' + tbl + ' MCS' + phy.mcs + ' · ×' + phy.nRep
  }
  // ★ 「音数」不是规范用词：TS 36.211 §10.1.2 的参数是 N_sc^RU（每资源单元的子载波数，1/3/6/12）。
  //   single-tone / multi-tone 是【传输模式】的名字，只用在 NPUSCH 那两张 MODCOD 表的表名上；
  //   参数本身一律叫「子载波数」，免得同行读成别的东西。
  const sc = phy.nTones + (en ? ' SC × ' : ' 子载波 × ') + phy.scs + ' kHz'
  return 'NB-IoT ' + dir + ' · ' + sc + ' · I_TBS ' + phy.iTbs + ' · ×' + phy.nRep
}
