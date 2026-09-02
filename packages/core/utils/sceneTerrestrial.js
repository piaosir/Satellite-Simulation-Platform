// utils/sceneTerrestrial.js
// 应用场景仿真 —— 地面段物理层计算器（纯 JS，平台无关）。
//
// 卫星段交给 linkChain.js（正向电平递推），本模块管卫星段之外的一切：光纤、铜缆、同轴中频、
// 串行总线、电力线载波、地面无线、契约链路、供电。现有三引擎一个公式都不重复实现。
//
// ============ ★ 三档判据，出参形状各不相同，绝不混成一个「总余量」============
//   tier='power'      功率预算档 → 出 marginDb（与射频段同构的 dB 账，可比较）
//   tier='constraint' 约束校验档 → 出 checks[]（「实际值 vs 上限」一对数，【没有】marginDb）
//   tier='contract'   契约档     → 原样转录 + quoted:true（承诺带宽/时延/可用率是合同条款不是物理量）
// 把三者折算成同一个数就是编数：铜缆 80 m 与 100 m 上限之间没有「20 dB 余量」这回事，
// 专线的 99.9% 也不是算出来的。上层（sceneReduce）汇总时按档分别处理，见那边的 §汇总。
//
// ============ 算法出处（逐条可查）============
//   自由空间损耗            ITU-R P.525-4
//   无线电视距 / 有效地球半径 ITU-R P.310（k=4/3 标准大气折射）
//   菲涅尔区半径与净空       ITU-R P.526-15
//   室内传播                ITU-R P.1238-11
//   地面点对面（陆地移动）    Okumura-Hata（Hata, IEEE T-VT 29(3), 1980）；
//                          1500–2000 MHz 延伸走 COST 231-Hata（COST Action 231 Final Report）
//   双射线平面地反射         Rappaport, Wireless Communications 2/e §4.6（断点距离 d_b = 4·h_t·h_r/λ）
//   视距微波多径衰落         ITU-R P.530-18 §2.3
//   视距微波雨衰            ITU-R P.530-18 §2.4 + ITU-R P.838-3 比衰减（复用 linkCalculator 的 P.838）
//   大气激光                ITU-R P.1817-1；Kim/McArthur/Korevaar 能见度-消光模型
//   光纤衰减与色散           ITU-T G.652 / G.657；IEC 60793-2-10（多模）
//   铜缆以太网信道长度        TIA-568.2-D；IEEE 802.3（各 PHY 条款见介质表 src）
//   以太网供电              IEEE 802.3-2022 Clause 33；IEEE 802.3bt-2018
//   RS-485 / RS-232 / CAN   TIA/EIA-485-A；TIA/EIA-232-F；ISO 11898-2
//   LoRa 灵敏度与速率        Semtech SX1276 datasheet；AN1200.22
//   WiFi 灵敏度与速率        IEEE 802.11ax-2021 Table 27-53 / 27-58
//   多跳共享信道吞吐衰减      Gupta & Kumar, IEEE T-IT 46(2), 2000
//
// ============ 刻意不做的事 ============
//   · 公网蜂窝（4G/5G/NB-IoT）不做覆盖预测。基站位置/功率/下倾角都不公开，拿 Hata 反推
//     「这里有没有信号」是伪计算 —— 归契约档，由用户断言。
//   · 短波（HF）不算。逐时可通性要跑 ITU-R P.533 电离层预测，本平台没有那套图表。
//   · 多径衰落给的是【最差月】百分比（P.530 原生口径），不擅自折算成年平均——
//     P.841 的换算依气候区而异，混用口径比不给更糟。出参里显式标 worstMonth:true。

'use strict';

const M = require('./sceneMedia.js');
// P.838-3 比衰减系数（含极化合成）——与卫星链路预算同一份实现，不另写一套
let _p838 = null;
try { _p838 = require('./linkCalculator.js').getCoefficients; } catch (e) { /* 雨衰项将标为不可算 */ }

const LOG10 = Math.LN10;
const log10 = (x) => Math.log(x) / LOG10;
const dbToLin = (db) => Math.pow(10, db / 10);
const linToDb = (x) => 10 * log10(x);
// ★ Number(null) === 0、Number('') === 0、Number([]) === 0 —— 平台踩过多次的坑。
// 「没给」与「给了 0」是两件事：没给必须回落缺省（或 null），给 0 就是 0。
const num = (v, d) => {
  if (v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')) return d;
  const n = Number(v); return Number.isFinite(n) ? n : d;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ═══════════════════════════════════════════════════════════════════════════
// 传播模型（可单测）
// ═══════════════════════════════════════════════════════════════════════════

/** ITU-R P.525-4 自由空间基本传输损耗。d: km，f: GHz → dB */
function fspl(dKm, fGHz) {
  if (!(dKm > 0) || !(fGHz > 0)) return 0;
  return 92.44 + 20 * log10(dKm) + 20 * log10(fGHz);
}

/**
 * 无线电视距（ITU-R P.310 标准大气，有效地球半径因子 k=4/3）。
 *   d = √(2·k·Re·h₁) + √(2·k·Re·h₂)，Re=6371 km → 系数 4.12（h 取 m，d 得 km）
 * 天线高度取【离地】高度；两端都为 0 时视距为 0（贴地不通）。
 */
function radioHorizonKm(h1M, h2M) {
  const c = Math.sqrt(2 * M.K_EFF * M.RE_KM * 1000) / 1000;   // ≈4.1213
  return c * (Math.sqrt(Math.max(0, h1M)) + Math.sqrt(Math.max(0, h2M)));
}

/**
 * 第 n 菲涅尔区半径（ITU-R P.526-15）。d1/d2/d 取 km，f 取 GHz → m
 *   r_n = 17.32·√( n·d1·d2 / (f·d) )
 * P.526 建议主径净空 ≥ 0.6·r₁ 才可按自由空间处理。
 */
function fresnelRadiusM(n, d1Km, d2Km, fGHz) {
  const d = d1Km + d2Km;
  if (!(d > 0) || !(fGHz > 0)) return 0;
  return 17.32 * Math.sqrt((n * d1Km * d2Km) / (fGHz * d));
}

/**
 * 双射线平面地反射（Rappaport, Wireless Communications 2/e 式 4.52）：
 *   远区 P_r = P_t·G_t·G_r·h_t²·h_r²/d⁴  ⇒  PL = 40·lg d − 20·lg h_t − 20·lg h_r
 * 近区走自由空间，两段在【渐近线交点】处切换：
 *   ★ d_c = 4π·h_t·h_r/λ，不是常被顺手写成的 4·h_t·h_r/λ。
 *   后者是第一菲涅尔区首次被地面切到的距离（双斜率模型里的「菲涅尔断点」），
 *   在那里两条式子差 20·lg(4π/4) = 9.97 dB —— 按它切会在断点上凭空掉近 10 dB，
 *   且方向是【偏乐观】的（算出来的损耗比自由空间还小）。取交点才连续。
 * 天线增益不含在内（本模块统一在链路预算里单列）。d/h 取 m，f 取 GHz → dB
 */
function twoRayLossDb(dM, htM, hrM, fGHz) {
  const lambda = M.C_LIGHT / (fGHz * 1e9);
  const ht = Math.max(0.1, htM), hr = Math.max(0.1, hrM);
  const dc = 4 * Math.PI * ht * hr / lambda;
  if (dM < dc) return fspl(dM / 1000, fGHz);
  return 40 * log10(dM) - 20 * log10(ht) - 20 * log10(hr);
}
/** 双射线的渐近线交点距离（m）—— 上式的切换点，出参里要报出来 */
const twoRayCrossoverM = (htM, hrM, fGHz) =>
  4 * Math.PI * Math.max(0.1, htM) * Math.max(0.1, hrM) / (M.C_LIGHT / (fGHz * 1e9));

/**
 * 对数距离模型：PL = PL(d0) + 10·n·log10(d/d0) + Σ 障碍物损耗
 * PL(d0) 取 d0=1 m 处的自由空间损耗。n 由用户给（自由空间 2.0、市区 2.7–3.5、室内 3–5）。
 */
function logDistanceLossDb(dM, fGHz, n, extraDb) {
  const pl0 = fspl(0.001, fGHz);          // d0 = 1 m
  return pl0 + 10 * num(n, 2.5) * log10(Math.max(1, dM) / 1) + num(extraDb, 0);
}

/**
 * ITU-R P.1238-11 室内传播：L = 20·log10(f_MHz) + N·log10(d_m) + Lf(n) − 28
 * N 与 Lf 由环境给（表 2 / 表 3）；★ N 已经把该类环境的典型内墙折在里面，
 * 再叠一层显式墙损就是双计 —— 要逐面墙算请改用 logdist 档。
 */
const P1238_N = {
  // [2.4 GHz, 5 GHz]；来源：ITU-R P.1238-11 Table 2（住宅/办公/商业）
  residential: { n24: 28, n5: 30 },
  office: { n24: 30, n5: 31 },
  commercial: { n24: 22, n5: 22 },
  factory: { n24: 22, n5: 22 }
};
// 楼层穿透因子 Lf(n)，dB；ITU-R P.1238-11 Table 3（2 GHz 段办公/住宅）
const P1238_LF = {
  residential: (n) => 4 * Math.max(0, n),
  office: (n) => (n <= 0 ? 0 : (n === 1 ? 9 : (n === 2 ? 19 : (n === 3 ? 24 : 24 + 3 * (n - 3))))),
  commercial: (n) => (n <= 0 ? 0 : 6 + 3 * (n - 1)),
  factory: (n) => (n <= 0 ? 0 : 6 + 3 * (n - 1))
};
function p1238LossDb(dM, fGHz, env, floors) {
  const e = P1238_N[env] || P1238_N.office;
  const N = fGHz >= 4 ? e.n5 : e.n24;
  const lf = (P1238_LF[env] || P1238_LF.office)(num(floors, 0));
  return 20 * log10(fGHz * 1000) + N * log10(Math.max(1, dM)) + lf - 28;
}

/**
 * Okumura-Hata（Hata 1980）与 COST 231-Hata 延伸。
 *   适用：f 150–1500 MHz（Hata）/ 1500–2000 MHz（COST-231）；h_b 30–200 m；h_m 1–10 m；d 1–20 km
 * 超出适用域【不外推静默返回】，而是把越界项写进 warn，由上层如实呈现。
 * area: 'urban-large' | 'urban' | 'suburban' | 'rural'
 */
function hataLossDb(dKm, fMHz, hbM, hmM, area) {
  const warn = [];
  if (fMHz < 150 || fMHz > 2000) warn.push(`频率 ${fMHz.toFixed(0)} MHz 超出 Hata/COST-231 适用域 150–2000 MHz`);
  if (hbM < 30 || hbM > 200) warn.push(`基站高 ${hbM} m 超出适用域 30–200 m`);
  if (hmM < 1 || hmM > 10) warn.push(`终端高 ${hmM} m 超出适用域 1–10 m`);
  if (dKm < 1 || dKm > 20) warn.push(`距离 ${dKm.toFixed(2)} km 超出适用域 1–20 km`);

  const f = clamp(fMHz, 150, 2000), hb = clamp(hbM, 1, 200), hm = clamp(hmM, 1, 10), d = Math.max(0.01, dKm);
  const lf = log10(f);
  // 移动台天线高度修正 a(h_m)
  let a;
  if (area === 'urban-large') {
    a = f <= 200 ? (8.29 * Math.pow(log10(1.54 * hm), 2) - 1.1)
      : (3.2 * Math.pow(log10(11.75 * hm), 2) - 4.97);
  } else {
    a = (1.1 * lf - 0.7) * hm - (1.56 * lf - 0.8);
  }
  const slope = (44.9 - 6.55 * log10(hb)) * log10(d);
  let L;
  if (f > 1500) {
    // COST 231-Hata：Cm = 0（中小城市/郊区）、3 dB（大城市中心）
    const cm = area === 'urban-large' ? 3 : 0;
    L = 46.3 + 33.9 * lf - 13.82 * log10(hb) - a + slope + cm;
  } else {
    L = 69.55 + 26.16 * lf - 13.82 * log10(hb) - a + slope;
  }
  // 郊区 / 开阔地修正（Hata 1980）
  if (area === 'suburban') L += -2 * Math.pow(log10(f / 28), 2) - 5.4;
  else if (area === 'rural') L += -4.78 * Math.pow(lf, 2) + 18.33 * lf - 40.94;
  return { lossDb: L, warn };
}

/**
 * ITU-R P.530-18 §2.3 视距微波多径衰落：给定超时百分比 p_w（最差月，%），求所需衰落余量 A。
 *   p_w = K·d^3.6·f^0.89·(1+|εp|)^(−1.4)·10^(−A/10)   [%]
 *   K（无地形粗糙度数据，§2.3.2 快速法）= 10^(−4.6 − 0.0027·dN1)
 *   K（有地形粗糙度 s_a，§2.3.1 详细法）= 10^(−4.4 − 0.0027·dN1)·(10 + s_a)^(−0.46)
 * dN1：ITU-R P.453 图给出的「一年 1% 时间不被超过的最低 65 m 折射率梯度」；本平台没有这张图，
 *      故作为参数由用户给（中纬度内陆典型 −300，海岸/高湿区更负）。s_a 留空即走快速法。
 * ★ 出参是【最差月】口径，不折算年平均（P.841 的换算依气候区而异，混用比不给更糟）。
 */
function p530MultipathMarginDb(dKm, fGHz, epMrad, pwPct, dN1, saM) {
  const K = (saM != null && saM > 0)
    ? Math.pow(10, -4.4 - 0.0027 * num(dN1, -300)) * Math.pow(10 + saM, -0.46)
    : Math.pow(10, -4.6 - 0.0027 * num(dN1, -300));
  const p0 = K * Math.pow(dKm, 3.6) * Math.pow(fGHz, 0.89) * Math.pow(1 + Math.abs(num(epMrad, 0)), -1.4);
  if (!(p0 > 0) || !(pwPct > 0)) return { marginDb: 0, K, p0 };
  // p0 ≤ p_w 表示不加余量就已满足指标（短/低频链路常见）
  const marginDb = Math.max(0, 10 * log10(p0 / pwPct));
  return { marginDb, K, p0 };
}

/** 路径倾角 εp（mrad）：|h_r − h_e| / d，h 取 m（海拔+天线高），d 取 km */
const pathInclinationMrad = (h1M, h2M, dKm) => (dKm > 0 ? Math.abs(h1M - h2M) / dKm : 0);

/**
 * ITU-R P.530-18 §2.4 视距微波雨衰。
 *   γ_R = k·R_0.01^α（P.838-3，地面链路仰角取 0°）
 *   距离因子 r = 1/(0.477·d^0.633·R_0.01^(0.073α)·f^0.123 − 10.579·(1−e^(−0.024d)))，r ≤ 2.5
 *   A_0.01 = γ_R·d·r
 *   其他百分比（0.001%–1%）：A_p/A_0.01 = C1·p^(−(C2+C3·log10 p))
 *     f ≥ 10 GHz：C0 = 0.12 + 0.4·[log10(f/10)]^0.8；f < 10 GHz：C0 = 0.12
 *     C1 = 0.07^C0 · 0.12^(1−C0)；C2 = 0.855·C0 + 0.546·(1−C0)；C3 = 0.139·C0 + 0.043·(1−C0)
 */
function p530RainMarginDb(dKm, fGHz, r001MmH, pol, pPct) {
  if (!_p838) return { attenDb: null, err: 'P.838 系数不可用' };
  if (!(r001MmH > 0)) return { attenDb: 0, gammaR: 0, r: 0 };
  const [k, alpha] = _p838(fGHz, pol || 'V', 0);       // 地面链路：路径仰角 0°
  const gammaR = k * Math.pow(r001MmH, alpha);
  const denom = 0.477 * Math.pow(dKm, 0.633) * Math.pow(r001MmH, 0.073 * alpha) * Math.pow(fGHz, 0.123)
    - 10.579 * (1 - Math.exp(-0.024 * dKm));
  const r = denom > 0 ? Math.min(2.5, 1 / denom) : 2.5;
  const a001 = gammaR * dKm * r;
  const p = clamp(num(pPct, 0.01), 0.001, 1);
  const c0 = fGHz >= 10 ? (0.12 + 0.4 * Math.pow(log10(fGHz / 10), 0.8)) : 0.12;
  const c1 = Math.pow(0.07, c0) * Math.pow(0.12, 1 - c0);
  const c2 = 0.855 * c0 + 0.546 * (1 - c0);
  const c3 = 0.139 * c0 + 0.043 * (1 - c0);
  const scale = c1 * Math.pow(p, -(c2 + c3 * log10(p)));
  return { attenDb: a001 * scale, a001, gammaR, r, k, alpha, pPct: p };
}

/**
 * 大气激光衰减：几何扩散 + 大气消光。
 *   几何：束宽 = θ·L（θ 全角，rad），接收口径 D → L_geo = 20·log10(θ·L / D)（θ·L > D 时）
 *   消光：Kim 模型 σ(dB/km) = (3.912/V)·(λ/550nm)^(−q)，q 按能见度分档（ITU-R P.1817-1 同式）
 */
function fsoLossDb(distM, divMrad, apertureM, wavelengthNm, visibilityKm) {
  const L = Math.max(1, distM);
  const beamM = (num(divMrad, 2) / 1000) * L;
  const geoDb = beamM > apertureM ? 20 * log10(beamM / Math.max(1e-3, apertureM)) : 0;
  const V = Math.max(0.05, num(visibilityKm, 10));
  let q;
  if (V > 50) q = 1.6;
  else if (V > 6) q = 1.3;
  else if (V > 1) q = 0.16 * V + 0.34;
  else if (V > 0.5) q = V - 0.5;
  else q = 0;
  const sigma = (3.912 / V) * Math.pow(num(wavelengthNm, 1550) / 550, -q);   // dB/km
  const atmDb = sigma * (L / 1000);
  return { geoDb, atmDb, sigmaDbKm: sigma, q, beamM };
}

/**
 * 多跳共享信道的吞吐折减。
 * 同频同信道链式转发是半双工共享媒质：每一跳都要占用同一信道一次，n 跳端到端上界 ≈ R/n
 * （Gupta & Kumar 2000 的链式退化情形；实测因空间复用通常略优于 1/n，故这是保守侧）。
 * 异频（每跳独立信道 / 多射频背靠背）不折减。
 */
function meshDerate(rateBps, hops, sameChannel) {
  const n = Math.max(1, Math.round(num(hops, 1)));
  return sameChannel ? rateBps / n : rateBps;
}

// ═══════════════════════════════════════════════════════════════════════════
// 段计算器
// ═══════════════════════════════════════════════════════════════════════════

// 出参骨架。★ tier 决定哪些字段有意义：
//   power      → marginDb / budget[]（台账）
//   constraint → checks[]（实际 vs 上限），marginDb 恒为 null
//   contract   → quoted:true，全部数字来自入参
function blank(medium, tier) {
  return {
    ok: true, medium, tier,
    marginDb: null,          // 仅 power 档
    budget: [],              // 仅 power 档：逐项台账 [{k,label,v,unit}]
    checks: [],              // 仅 constraint 档：[{k,label,actual,limit,unit,over}]
    quoted: tier === 'contract',
    rateBps: null,           // 该段可承载速率
    latencyMs: null,         // 该段时延（传播 + 设备）
    availPct: null,          // 该段可用度；null = 不贡献（真空/无统计依据）
    powerW: null,            // 该段两端设备之外的额外功耗（PoE 线损等）
    notes: [], warn: [], errors: []
  };
}
const fail = (medium, tier, msg) => {
  const r = blank(medium, tier); r.ok = false; r.errors.push(msg); return r;
};

/** 传播时延：km ÷ (c·vf)，vf 为介质速度因子 */
function propDelayMs(km, vf) {
  const v = (M.C_LIGHT / 1000) * num(vf, 1);   // km/s
  return v > 0 ? (km / v) * 1000 : 0;
}

// ── 铜缆以太网（约束档）────────────────────────────────────────────────────
function computeCopper(med, p) {
  const r = blank(med.key, 'constraint');
  const L = num(p.lengthM, med.defaults.lengthM);
  if (!(L >= 0)) return fail(med.key, 'constraint', '缺电缆长度');
  const preset = p.ratePreset || med.defaults.ratePreset;
  const rate = (med.limits.rates || []).find((x) => x.key === preset) || (med.limits.rates || [])[0];
  if (!rate) return fail(med.key, 'constraint', '未知速率档');

  r.checks.push({ k: 'len', label: '信道长度', actual: L, limit: rate.maxM, unit: 'm', over: L > rate.maxM, src: rate.src });
  r.rateBps = rate.bps;
  r.latencyMs = propDelayMs(L / 1000, med.vf);
  // 双绞线本身没有「可用度」这一说（无衰落），不贡献
  r.notes.push(`${rate.key} · ${rate.src}`);

  // PoE 同缆供电（可选）：与数据速率互不影响，但长度上限取两者更严的那个
  if (p.poe && p.poe !== 'none') {
    const poeMed = M.mediaOf('poe');
    const t = (poeMed.limits.types || []).find((x) => x.key === p.poe);
    if (!t) r.warn.push(`未知 PoE 类型 ${p.poe}`);
    else {
      const awg = num(p.awg, med.defaults.awg);
      const rc = M.CU_R_PER_M[awg];
      if (rc == null) r.warn.push(`未知线规 AWG${awg}，PoE 压降未计算`);
      else {
        // 2 对供电：去/回各一对（每对 2 导体并联）→ R_loop = L·Rc
        // 4 对供电：去/回各两对（每侧 4 导体并联）→ R_loop = L·Rc/2
        const rLoop = t.pairs >= 4 ? (L * rc / 2) : (L * rc);
        const need = num(p.poeLoadW, t.pdPw);
        // 解 I²·R − V·I + P = 0 取小根：I = [V − √(V² − 4RP)]/(2R)
        const disc = t.vPseMin * t.vPseMin - 4 * rLoop * need;
        if (disc < 0) {
          r.checks.push({ k: 'poe', label: 'PoE 末端功率', actual: null, limit: need, unit: 'W', over: true, src: poeMed.src });
          r.errors.push(`PoE 线损过大：${t.key} 在 ${L} m / AWG${awg} 上无法送出 ${need} W`);
          r.ok = false;
        } else {
          const I = rLoop > 0 ? (t.vPseMin - Math.sqrt(disc)) / (2 * rLoop) : need / t.vPseMin;
          const vPd = t.vPseMin - I * rLoop;
          const lossW = I * I * rLoop;
          r.checks.push({ k: 'poeR', label: 'PoE 信道回路电阻', actual: rLoop, limit: t.rChMax, unit: 'Ω', over: rLoop > t.rChMax, src: poeMed.src });
          r.checks.push({ k: 'poeV', label: 'PD 端电压', actual: vPd, limit: t.vPdMin, unit: 'V', over: vPd < t.vPdMin, low: true, src: poeMed.src });
          r.checks.push({ k: 'poeP', label: 'PD 端可得功率', actual: t.pdPw, limit: need, unit: 'W', over: need > t.pdPw, low: true, src: poeMed.src });
          r.powerW = lossW;
          r.notes.push(`${t.key} · 线损 ${lossW.toFixed(2)} W`);
        }
      }
    }
  }
  return r;
}

// ── 光纤（功率预算档）────────────────────────────────────────────────────
function computeFiber(med, p) {
  const r = blank(med.key, 'power');
  const d = med.defaults;
  const Lkm = num(p.lengthKm, d.lengthKm);
  const a = num(p.attnDbKm, d.attnDbKm);
  const nc = num(p.connectors, d.connectors), lc = num(p.connLossDb, d.connLossDb);
  const ns = num(p.splices, d.splices), ls = num(p.spliceLossDb, d.spliceLossDb);
  const tx = num(p.txDbm, d.txDbm), sens = num(p.rxSensDbm, d.rxSensDbm);
  const sysM = num(p.marginDb, d.marginDb);
  if (!(Lkm >= 0)) return fail(med.key, 'power', '缺光纤长度');

  const aFiber = a * Lkm, aConn = nc * lc, aSplice = ns * ls;
  const total = aFiber + aConn + aSplice;
  const rxDbm = tx - total;
  const margin = rxDbm - sens - sysM;

  r.budget = [
    { k: 'tx', label: '发送光功率', v: tx, unit: 'dBm' },
    { k: 'fib', label: `光纤衰减 ${Lkm} km × ${a} dB/km`, v: -aFiber, unit: 'dB' },
    { k: 'conn', label: `连接器 ${nc} × ${lc} dB`, v: -aConn, unit: 'dB' },
    { k: 'splice', label: `熔接 ${ns} × ${ls} dB`, v: -aSplice, unit: 'dB' },
    { k: 'rx', label: '接收光功率', v: rxDbm, unit: 'dBm' },
    { k: 'sens', label: '接收灵敏度', v: sens, unit: 'dBm' },
    { k: 'sysm', label: '系统余量（老化/维修）', v: -sysM, unit: 'dB' }
  ];
  r.marginDb = margin;
  r.latencyMs = propDelayMs(Lkm, med.vf);
  r.rateBps = num(p.rateBps, null);

  if (med.limits && med.limits.attnMaxDbKm && a > med.limits.attnMaxDbKm) {
    r.warn.push(`衰减系数 ${a} dB/km 超过 ${med.src} 规定的上限 ${med.limits.attnMaxDbKm}`);
  }
  // 单模长距还要过色散关：1 dB 功率代价下 L_max = ε/(D·Δλ·B)，NRZ 取 ε=0.306
  // （ITU-T G.957 附录 / Agrawal, Fiber-Optic Communication Systems §2.4）
  if (med.limits && med.limits.dispPsNmKm && p.rateBps > 0 && p.laserWidthNm > 0) {
    const B = p.rateBps, D = med.limits.dispPsNmKm, dl = p.laserWidthNm;
    const lmax = 0.306 / (D * 1e-12 * dl * B);   // km
    r.checks.push({ k: 'disp', label: '色散受限距离', actual: Lkm, limit: lmax, unit: 'km', over: Lkm > lmax, src: 'ITU-T G.957 / 1 dB 代价判据' });
    if (Lkm > lmax) r.warn.push(`色散受限：${lmax.toFixed(1)} km`);
  }
  // 多模按标准传输距离另判（限制多为模式带宽而非功率）
  if (med.limits && med.limits.reachM && p.phy) {
    const reach = med.limits.reachM[p.phy];
    if (reach) r.checks.push({ k: 'reach', label: `${p.phy} 标准传输距离`, actual: Lkm * 1000, limit: reach, unit: 'm', over: Lkm * 1000 > reach, src: med.src });
  }
  return r;
}

// ── 同轴（中频 / 射频）────────────────────────────────────────────────────
function coaxAttnDbPer100m(cable, fMHz) {
  const table = M.mediaOf('ifl_l').limits.cables;
  const c = table.find((x) => x.key === cable) || table.find((x) => x.key === 'LMR-400');
  const per100ft = c.k1 * Math.sqrt(fMHz) + c.k2 * fMHz;
  return { db100m: per100ft / 0.3048, rLoop100m: c.rLoop100m, cable: c };
}

function computeIfl(med, p) {
  const r = blank(med.key, 'constraint');
  const d = med.defaults;
  const L = num(p.lengthM, d.lengthM);
  const cable = p.cable || d.cable;
  const fHi = (med.limits.ifBandMHz || [950, 2150])[1];
  const { db100m, rLoop100m } = coaxAttnDbPer100m(cable, fHi);
  const attn = db100m * (L / 100);
  const maxLoss = num(p.ifMaxLossDb, d.ifMaxLossDb);
  r.checks.push({ k: 'ifloss', label: `中频衰减 @${fHi} MHz`, actual: attn, limit: maxLoss, unit: 'dB', over: attn > maxLoss, src: `${cable} · ${med.src}` });

  // BUC/LNB 直流供电压降：I = P/V（BUC 恒功率近似），V_end = V − I·R_loop
  const V = num(p.bucVdc, d.bucVdc), I = num(p.bucAmps, d.bucAmps);
  if (V > 0 && I > 0) {
    const rLoop = rLoop100m * (L / 100);
    const vDrop = I * rLoop;
    const vEnd = V - vDrop;
    const vMin = V * num(med.limits.bucVminFrac, 0.83);
    r.checks.push({ k: 'bucv', label: 'BUC 端电压', actual: vEnd, limit: vMin, unit: 'V', over: vEnd < vMin, low: true, src: 'BUC 输入电压范围' });
    r.powerW = I * I * rLoop;
    r.notes.push(`回路 ${rLoop.toFixed(2)} Ω · 压降 ${vDrop.toFixed(2)} V · 线损 ${r.powerW.toFixed(1)} W`);
  }
  r.latencyMs = propDelayMs(L / 1000, med.vf);
  return r;
}

function computeCoaxRf(med, p) {
  const r = blank(med.key, 'power');
  const d = med.defaults;
  const L = num(p.lengthM, d.lengthM);
  const fMHz = num(p.freqGHz, d.freqGHz) * 1000;
  const { db100m, cable } = coaxAttnDbPer100m(p.cable || d.cable, fMHz);
  const attn = db100m * (L / 100);
  const conn = num(p.connectors, d.connectors) * num(p.connLossDb, d.connLossDb);
  r.budget = [
    { k: 'cable', label: `${cable.key} ${L} m @${(fMHz / 1000).toFixed(2)} GHz`, v: -attn, unit: 'dB' },
    { k: 'conn', label: '连接器', v: -conn, unit: 'dB' }
  ];
  // 射频跳线不是一条独立链路，它是【别人链路里的一项插损】：marginDb 留 null，
  // 只出 insertionLossDb 供上层并进那一端的馈线损耗。
  r.insertionLossDb = attn + conn;
  r.latencyMs = propDelayMs(L / 1000, med.vf);
  r.notes.push(`插损 ${r.insertionLossDb.toFixed(2)} dB（并入所属射频端的馈线损耗）`);
  return r;
}

// ── 串行 / 总线（约束档）──────────────────────────────────────────────────
function computeSerial(med, p) {
  const r = blank(med.key, 'constraint');
  const d = med.defaults, lim = med.limits || {};
  const L = num(p.lengthM, d.lengthM), baud = num(p.baud, d.baud);
  r.rateBps = baud;
  r.latencyMs = propDelayMs(L / 1000, med.vf);

  if (med.key === 'rs485') {
    const maxByProduct = lim.rateDistProduct / Math.max(1, baud);
    const limitM = Math.min(lim.maxM, maxByProduct);
    r.checks.push({ k: 'len', label: '总线长度', actual: L, limit: limitM, unit: 'm', over: L > limitM, src: med.src });
    r.checks.push({ k: 'nodes', label: '挂载节点数', actual: num(p.nodes, d.nodes), limit: lim.maxNodes, unit: '个', over: num(p.nodes, d.nodes) > lim.maxNodes, src: med.src });
    r.notes.push(`速率×距离积判据 ${(lim.rateDistProduct / 1e6).toFixed(0)}×10⁶ bps·m`);
  } else if (med.key === 'rs232') {
    const cap = L * lim.cablePfPerM;
    r.checks.push({ k: 'cap', label: '负载电容', actual: cap, limit: lim.maxCapPf, unit: 'pF', over: cap > lim.maxCapPf, src: med.src });
    r.checks.push({ k: 'baud', label: '波特率', actual: baud, limit: lim.maxBaud, unit: 'bps', over: baud > lim.maxBaud, src: med.src });
  } else if (med.key === 'can') {
    // ISO 11898-2 速率-距离对照，双对数插值
    const pairs = lim.pairs.slice().sort((a, b) => a[0] - b[0]);
    let limitM = pairs[0][1];
    if (baud <= pairs[0][0]) limitM = pairs[0][1];
    else if (baud >= pairs[pairs.length - 1][0]) limitM = pairs[pairs.length - 1][1];
    else {
      for (let i = 0; i < pairs.length - 1; i++) {
        if (baud >= pairs[i][0] && baud <= pairs[i + 1][0]) {
          const t = (log10(baud) - log10(pairs[i][0])) / (log10(pairs[i + 1][0]) - log10(pairs[i][0]));
          limitM = Math.exp(Math.log(pairs[i][1]) + t * (Math.log(pairs[i + 1][1]) - Math.log(pairs[i][1])));
          break;
        }
      }
    }
    r.checks.push({ k: 'len', label: '总线长度', actual: L, limit: limitM, unit: 'm', over: L > limitM, src: med.src });
    r.checks.push({ k: 'nodes', label: '节点数', actual: num(p.nodes, d.nodes), limit: lim.maxNodes, unit: '个', over: num(p.nodes, d.nodes) > lim.maxNodes, src: med.src });
  } else if (med.key === 'mbus') {
    r.checks.push({ k: 'len', label: '总线长度', actual: L, limit: lim.maxM, unit: 'm', over: L > lim.maxM, src: med.src });
    r.checks.push({ k: 'nodes', label: '从站数', actual: num(p.nodes, d.nodes), limit: lim.maxNodes, unit: '个', over: num(p.nodes, d.nodes) > lim.maxNodes, src: med.src });
    r.checks.push({ k: 'baud', label: '波特率', actual: baud, limit: lim.maxBaud, unit: 'bps', over: baud > lim.maxBaud, src: med.src });
  }
  return r;
}

// ── 电力线载波（约束档）──────────────────────────────────────────────────
function computePowerline(med, p) {
  const r = blank(med.key, 'constraint');
  const d = med.defaults, lim = med.limits;
  const meters = num(p.meters, d.meters), hops = num(p.hops, d.hops);
  r.checks.push({ k: 'meters', label: '台区表计数', actual: meters, limit: lim.maxMeters, unit: '只', over: meters > lim.maxMeters, src: med.src });
  r.checks.push({ k: 'hops', label: '组网跳数', actual: hops, limit: lim.maxHops, unit: '跳', over: hops > lim.maxHops, src: med.src });
  // ★ 载波是共享媒质的多跳广播网：物理层速率是全台区共享的，逐表可得速率 ≈ PHY/(表数×跳数)。
  //   这不是点对点 dB 预算能表达的东西，故归约束档 —— 判据是「几只表、几跳」不是「几 dB」。
  r.rateBps = lim.phyBps / Math.max(1, meters);
  r.latencyMs = num(p.pollMs, hops * 200);
  r.notes.push(`PHY ${(lim.phyBps / 1e6).toFixed(2)} Mbps 全台区共享，逐表 ${(r.rateBps / 1000).toFixed(2)} kbps`);
  return r;
}

// ── 地面无线（功率预算档）────────────────────────────────────────────────
// 路径损耗分派。model:
//   'fs'        自由空间（ITU-R P.525）
//   'two-ray'   双射线平面地反射
//   'logdist'   对数距离 + 显式障碍损耗
//   'p1238'     ITU-R P.1238 室内
//   'hata-*'    Okumura-Hata / COST-231（urban-large|urban|suburban|rural）
//   'los'       视距微波（另加 P.530 多径 + 雨衰，见 computeWireless）
//   'los-air'   空地视距（自由空间 + 视距校验；机载/无人机）
//   'los-sea'   海面视距（双射线 + 视距校验）
function pathLoss(model, o) {
  const fGHz = o.fGHz, dM = o.distM, dKm = dM / 1000;
  switch (model) {
    case 'fs': case 'los': case 'los-air':
      return { lossDb: fspl(dKm, fGHz), warn: [], model };
    case 'two-ray': case 'los-sea':
      return { lossDb: twoRayLossDb(dM, o.hTxM, o.hRxM, fGHz), warn: [], model };
    case 'logdist':
      return { lossDb: logDistanceLossDb(dM, fGHz, o.n, o.extraDb), warn: [], model };
    case 'p1238':
      return { lossDb: p1238LossDb(dM, fGHz, o.env || 'office', o.floors), warn: [], model };
    case 'hata-urban-large': case 'hata-urban': case 'hata-suburban': case 'hata-rural': {
      const area = model.slice(5);
      const h = hataLossDb(dKm, fGHz * 1000, o.hTxM, o.hRxM, area);
      return { lossDb: h.lossDb, warn: h.warn, model };
    }
    default:
      return { lossDb: fspl(dKm, fGHz), warn: [`未知传播模型 ${model}，已按自由空间算`], model: 'fs' };
  }
}

function computeWireless(med, p) {
  const r = blank(med.key, 'power');
  const d = med.defaults || {};
  const fGHz = num(p.freqGHz, d.freqGHz);
  const distM = num(p.distM, num(p.distKm, d.distKm) * 1000 || d.distM);
  if (!(fGHz > 0)) return fail(med.key, 'power', '缺工作频率');
  if (!(distM > 0)) return fail(med.key, 'power', '缺链路距离');
  const model = p.model || d.model || 'fs';
  const hTx = num(p.hTxM, d.hTxM), hRx = num(p.hRxM, d.hRxM);

  // ① 灵敏度：LoRa/WiFi 由体制表算，其余直接给
  let sens = num(p.sensDbm, d.sensDbm);
  let rateBps = num(p.rateBps, d.rateBps);
  if (med.key === 'lora') {
    const sf = clamp(Math.round(num(p.sf, d.sf)), 7, 12);
    const bw = num(p.bwKHz, d.bwKHz);
    const base = M.LORA_SENS[sf];
    const adj = M.LORA_BW_ADJ[bw] != null ? M.LORA_BW_ADJ[bw] : 10 * log10(bw / 125);
    sens = base + adj;
    rateBps = M.loraBitrate(sf, bw, num(p.crDen, d.crDen));
    r.notes.push(`SF${sf} @${bw} kHz · 灵敏度 ${sens.toFixed(1)} dBm · ${rateBps.toFixed(0)} bps`);
  } else if (med.limits && med.limits.sens && p.mcs != null) {
    const mcs = clamp(Math.round(num(p.mcs, d.mcs)), 0, 11);
    const bw = num(p.bwMHz, d.bwMHz);
    // 热噪带宽随信道翻倍：相对 20 MHz 每翻一倍 +3 dB
    sens = med.limits.sens[mcs] + 10 * log10(Math.max(20, bw) / 20);
    const ss = Math.max(1, Math.round(num(p.streams, 1)));
    rateBps = med.limits.rate20[mcs] * 1e6 * (Math.max(20, bw) / 20) * ss;
    r.notes.push(`MCS${mcs} @${bw} MHz × ${ss} 流 · 灵敏度 ${sens.toFixed(1)} dBm`);
  }
  if (!Number.isFinite(sens)) return fail(med.key, 'power', '缺接收灵敏度');

  // ② 路径损耗
  const pl = pathLoss(model, { fGHz, distM, hTxM: hTx, hRxM: hRx, n: p.n, extraDb: p.extraDb, env: p.env, floors: p.floors });
  r.warn.push(...pl.warn);

  const tx = num(p.txDbm, d.txDbm), gTx = num(p.gTxDbi, d.gTxDbi), gRx = num(p.gRxDbi, d.gRxDbi);
  const lTx = num(p.lossTxDb, d.lossTxDb), lRx = num(p.lossRxDb, d.lossRxDb);
  const eirp = tx + gTx - lTx;

  r.budget = [
    { k: 'tx', label: '发射功率', v: tx, unit: 'dBm' },
    { k: 'gtx', label: '发射天线增益', v: gTx, unit: 'dBi' },
    { k: 'ltx', label: '发射馈线损耗', v: -lTx, unit: 'dB' },
    { k: 'eirp', label: 'EIRP', v: eirp, unit: 'dBm', sub: true },
    { k: 'pl', label: `路径损耗（${pl.model}）`, v: -pl.lossDb, unit: 'dB' }
  ];

  // ③ 视距与菲涅尔净空（有天线高度就算）
  let extraFade = 0;
  if (hTx > 0 || hRx > 0) {
    const losKm = radioHorizonKm(hTx, hRx);
    r.checks.push({ k: 'los', label: '无线电视距', actual: distM / 1000, limit: losKm, unit: 'km', over: distM / 1000 > losKm, src: 'ITU-R P.310 (k=4/3)' });
    if (distM / 1000 > losKm) r.warn.push(`超视距 ${(distM / 1000 - losKm).toFixed(1)} km：本模型只算视距路径，绕射损耗未计入（需 ITU-R P.526 地形剖面）`);
    const dKm = distM / 1000;
    const r1 = fresnelRadiusM(1, dKm / 2, dKm / 2, fGHz);
    r.notes.push(`第一菲涅尔区半径（中点）${r1.toFixed(1)} m，P.526 建议净空 ≥ ${(0.6 * r1).toFixed(1)} m`);
    if (p.clearanceM != null) {
      r.checks.push({ k: 'fresnel', label: '主径净空', actual: num(p.clearanceM, 0), limit: 0.6 * r1, unit: 'm', over: num(p.clearanceM, 0) < 0.6 * r1, low: true, src: 'ITU-R P.526-15' });
    }
  }

  // ④ 视距微波：P.530 多径衰落 + 雨衰
  if (model === 'los' && med.key === 'microwave_ptp') {
    const dKm = distM / 1000;
    const availPct = num(p.availPct, d.availPct);
    const pOut = clamp(100 - availPct, 0.0001, 10);
    const ep = pathInclinationMrad(num(p.hTxAmslM, hTx), num(p.hRxAmslM, hRx), dKm);
    const mp = p530MultipathMarginDb(dKm, fGHz, ep, pOut, num(p.dN1, d.dN1), p.saM);
    extraFade += mp.marginDb;
    r.budget.push({ k: 'mp', label: `多径衰落余量（P.530 最差月 ${pOut}%）`, v: -mp.marginDb, unit: 'dB' });
    r.notes.push(`多径 K=${mp.K.toExponential(2)}，路径倾角 ${ep.toFixed(2)} mrad — ★最差月口径，未折算年平均`);

    const rain = p530RainMarginDb(dKm, fGHz, num(p.rainMmH, d.rainMmH), p.pol || 'V', pOut);
    if (rain.attenDb == null) r.warn.push(rain.err);
    else {
      extraFade += rain.attenDb;
      r.budget.push({ k: 'rain', label: `雨衰（P.530 §2.4，p=${pOut}%）`, v: -rain.attenDb, unit: 'dB' });
      r.notes.push(`γ_R=${rain.gammaR.toFixed(3)} dB/km · 距离因子 r=${rain.r.toFixed(3)}`);
    }
    r.availPct = availPct;
    r.worstMonth = true;
  } else if (p.marginDb != null || d.marginDb != null) {
    // 其余无线介质：把用户给的衰落储备当作一项显式扣除（不假装算出它）
    const fm = num(p.marginDb, d.marginDb);
    extraFade += fm;
    r.budget.push({ k: 'fade', label: '衰落储备（用户给定）', v: -fm, unit: 'dB' });
  }

  // ⑤ 大气激光走自己的一套
  if (med.key === 'fso') {
    const f = fsoLossDb(distM, num(p.divMrad, d.divMrad), num(p.apertureM, d.apertureM),
      num(p.wavelengthNm, d.wavelengthNm), num(p.visibilityKm, d.visibilityKm));
    r.budget = [
      { k: 'tx', label: '发射光功率', v: num(p.txDbm, d.txDbm), unit: 'dBm' },
      { k: 'geo', label: `几何扩散（束宽 ${f.beamM.toFixed(2)} m / 口径 ${num(p.apertureM, d.apertureM)} m）`, v: -f.geoDb, unit: 'dB' },
      { k: 'atm', label: `大气消光（能见度 ${num(p.visibilityKm, d.visibilityKm)} km，σ=${f.sigmaDbKm.toFixed(2)} dB/km）`, v: -f.atmDb, unit: 'dB' },
      { k: 'point', label: '指向损耗', v: -num(p.pointingLossDb, d.pointingLossDb), unit: 'dB' },
      { k: 'sens', label: '接收灵敏度', v: num(p.rxSensDbm, d.rxSensDbm), unit: 'dBm' },
      { k: 'fade', label: '衰落储备', v: -num(p.marginDb, d.marginDb), unit: 'dB' }
    ];
    const rx = num(p.txDbm, d.txDbm) - f.geoDb - f.atmDb - num(p.pointingLossDb, d.pointingLossDb);
    r.marginDb = rx - num(p.rxSensDbm, d.rxSensDbm) - num(p.marginDb, d.marginDb);
    r.rxLevelDbm = rx;
    r.rateBps = num(p.rateBps, null);
    r.latencyMs = propDelayMs(distM / 1000, 1);
    r.notes.push('Kim 消光模型（ITU-R P.1817-1 同式）；闪烁未单列，含在衰落储备里');
    return r;
  }

  const rx = eirp - pl.lossDb + gRx - lRx;
  r.budget.push(
    { k: 'grx', label: '接收天线增益', v: gRx, unit: 'dBi' },
    { k: 'lrx', label: '接收馈线损耗', v: -lRx, unit: 'dB' },
    { k: 'rx', label: '接收电平', v: rx, unit: 'dBm', sub: true },
    { k: 'sens', label: '接收灵敏度', v: sens, unit: 'dBm' }
  );
  r.rxLevelDbm = rx;
  r.marginDb = rx - sens - extraFade;
  r.latencyMs = propDelayMs(distM / 1000, 1);

  // ⑥ 发射限值（各国微功率/ISM 规定）
  if (med.limits) {
    if (med.limits.eirpMaxDbm != null) {
      r.checks.push({ k: 'eirp', label: 'EIRP', actual: eirp, limit: med.limits.eirpMaxDbm, unit: 'dBm', over: eirp > med.limits.eirpMaxDbm, src: med.src });
    }
    if (med.limits.erpMaxDbm != null) {
      // ERP = EIRP − 2.15 dB（相对半波振子）
      const erp = eirp - 2.15;
      r.checks.push({ k: 'erp', label: 'ERP', actual: erp, limit: med.limits.erpMaxDbm, unit: 'dBm', over: erp > med.limits.erpMaxDbm, src: med.src });
    }
  }

  // ⑦ 多跳吞吐折减（mesh / MANET）
  const hops = num(p.hops, d.hops);
  if (hops > 1 && rateBps > 0) {
    const same = p.sameChannel != null ? !!p.sameChannel : !!d.sameChannel;
    const eff = meshDerate(rateBps, hops, same);
    r.notes.push(`${hops} 跳${same ? '同频' : '异频'} · 端到端吞吐 ${(eff / 1e6).toFixed(2)} Mbps（单跳 ${(rateBps / 1e6).toFixed(2)}）`);
    r.latencyMs = (r.latencyMs || 0) * hops + num(p.hopProcMs, 1) * hops;
    rateBps = eff;
    if (med.limits && med.limits.maxHops && hops > med.limits.maxHops) {
      r.checks.push({ k: 'hops', label: '跳数', actual: hops, limit: med.limits.maxHops, unit: '跳', over: true, src: med.src });
    }
  }
  r.rateBps = rateBps || null;
  return r;
}

// ── 契约档 ──────────────────────────────────────────────────────────────
function computeContract(med, p) {
  const r = blank(med.key, 'contract');
  const d = med.defaults || {};
  r.rateBps = num(p.rateBps, d.rateBps);
  r.rateUpBps = num(p.rateUpBps, num(d.rateUpBps, r.rateBps));
  r.latencyMs = num(p.latencyMs, d.latencyMs);
  r.availPct = num(p.availPct, d.availPct);
  if (med.key === 'hf_ssb') {
    r.notes.push('可通率为用户给定；逐时可通性需 ITU-R P.533 电离层预测，本平台不计算');
  } else if (/^(cellular_|nbiot)/.test(med.key)) {
    if (p.covered === false) { r.ok = false; r.errors.push('该点无公网覆盖（用户断言）'); }
    r.notes.push('公网覆盖为用户断言；本平台不做蜂窝覆盖预测');
  } else {
    r.notes.push('承诺带宽 / 时延 / 可用率来自运营商 SLA，非计算值');
  }
  return r;
}

// ── 供电边 ──────────────────────────────────────────────────────────────
function computeSupply(med, p) {
  const r = blank(med.key, 'supply');
  r.availPct = med.key === 'ac_mains' ? num(p.availPct, (med.defaults || {}).availPct) : null;
  r.notes.push('供电边不进 dB 账，走能量预算（sceneEnergy）');
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外单咽喉
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 算一条地面段。
 * @param {object} seg { medium, params }
 * @returns 见 blank() 的形状；tier 决定哪些字段有意义
 */
function computeSegment(seg) {
  const key = seg && seg.medium;
  const med = M.mediaOf(key);
  if (!med) return fail(key || '(未指定)', 'constraint', `未知介质：${key}`);
  if (med.tier === 'satellite') return fail(key, 'satellite', '卫星段不由本模块计算（交给 linkChain）');
  const p = seg.params || {};
  switch (med.cat) {
    case 'copper': return computeCopper(med, p);
    case 'fiber': return computeFiber(med, p);
    case 'coax': return med.key === 'ifl_l' ? computeIfl(med, p) : computeCoaxRf(med, p);
    case 'serial': return computeSerial(med, p);
    case 'powerline': return computePowerline(med, p);
    case 'wireless': return med.tier === 'contract' ? computeContract(med, p) : computeWireless(med, p);
    case 'contract': return computeContract(med, p);
    case 'supply': return med.key === 'poe' ? computeCopper(M.mediaOf('cat5e'), Object.assign({ poe: p.type || '802.3at' }, p)) : computeSupply(med, p);
    default: return fail(key, med.tier, `介质 ${key} 没有对应的计算器`);
  }
}

module.exports = {
  computeSegment,
  // 传播模型（单测与上层复用）
  fspl, radioHorizonKm, fresnelRadiusM, twoRayLossDb, twoRayCrossoverM, logDistanceLossDb, p1238LossDb,
  hataLossDb, p530MultipathMarginDb, p530RainMarginDb, pathInclinationMrad, fsoLossDb,
  meshDerate, coaxAttnDbPer100m, propDelayMs, pathLoss
};
