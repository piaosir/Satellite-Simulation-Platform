// utils/sceneEnergy.js
// 应用场景仿真 —— 能量预算（纯 JS，平台无关）。
//
// ★ 与 dB 账【并列】的一本独立的账，绝不混算。
// 由来：卫星物联网终端是「择机通信」的——天启 TQZD-08 发射 ≤9.6 W、接收 ≤0.1 W、待机 ≤0.04 W、
// 睡眠 μA 级。一座 100 W 光伏 + 65 Ah 蓄电池的野外站一天能支持多少次上报，是真问题、能算，
// 而且是链路预算完全给不出的那一半。无人值守站装上去半年后掉线，十有八九是这本账没算。
//
// ============ 算法与出处 ============
// 光伏可用能量走真太阳几何，不用「按纬度查 PSH」那种拍脑袋的表：
//   · 太阳赤纬 δ            Cooper (1969)：δ = 23.45·sin(360(284+n)/365)
//   · 日地距离修正 E0        Duffie & Beckman《Solar Engineering of Thermal Processes》4/e 式 (1.4.1a)
//   · 日落时角 ωs           ωs = arccos(−tanφ·tanδ)
//   · 水平面天文日辐照量 H0   Duffie & Beckman 式 (1.10.3)（纯几何，无经验成分）
//   · 地面水平面日辐照量 H   H = Kt·H0，Kt＝晴空指数（气候量，本平台没有这张图 → 用户给，
//                          缺省给一档并【显式标为估算】；中国大部分地区年均 0.45–0.60）
//   · 散射分量 Hd/H         Erbs 等 (1982) 相关式；D&B 式 (2.12.1)
//   · 倾斜面日辐照量 HT      Liu & Jordan 各向同性天空模型；D&B 式 (2.15.1)、Rb 式 (2.19.3)
//   · 逐月取最小            离网系统标准做法：按【最差月】定容，不按年均
// 蓄电池容量：
//   C = E_day·D_aut/(V_sys·DoD·η_out)   离网通行式；DoD 与温度修正见 BATTERY 表出处
//
// ============ 刻意不做的事 ============
//   · 不内置 Kt 地图。晴空指数是逐地逐月的气候量（NASA POWER / 中国气象局辐射年鉴），
//     本平台没有这份数据；编一张表出来会让「野外站能不能撑住」这件事看起来算过了，实则没有。
//   · 不做逐时仿真（PV 出力曲线 × 负载曲线的时序耦合）。日能量平衡 + 自主天数是离网定容的
//     标准判据，逐时只在带峰谷电价/并网调度时才需要。

'use strict';

const D2R = Math.PI / 180;
// ★ Number(null) === 0、Number('') === 0、Number([]) === 0 —— 平台踩过多次的坑。
// 「没给」与「给了 0」是两件事：没给必须回落缺省（或 null），给 0 就是 0。
const num = (v, d) => {
  if (v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')) return d;
  const n = Number(v); return Number.isFinite(n) ? n : d;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 太阳常数（WMO / ISO 21348 采用值）
const GSC = 1367;       // W/m²

// 各月代表日（Klein 1977 推荐的月平均日，D&B Table 1.6.1）
const REP_DAY = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344];
const MONTH_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

// 电池化学体系的放电深度与循环/温度特性
// DoD：离网设计通行取值；tempCoef：容量随温度的近似修正（每 °C，相对 25 ℃）
const BATTERY = [
  { key: 'agm', zh: '铅酸 AGM', dod: 0.50, etaRt: 0.85, tempCoef: 0.008, src: 'IEEE 1013-2019 离网铅酸定容推荐 DoD 50%' },
  { key: 'gel', zh: '铅酸胶体', dod: 0.50, etaRt: 0.85, tempCoef: 0.008, src: 'IEEE 1013-2019' },
  { key: 'lifepo4', zh: '磷酸铁锂', dod: 0.80, etaRt: 0.95, tempCoef: 0.004, src: '厂商通行标定（0.8 DoD / 95% 往返效率）' },
  { key: 'liion', zh: '三元锂', dod: 0.80, etaRt: 0.95, tempCoef: 0.005, src: '厂商通行标定' },
  { key: 'primary_li', zh: '一次锂（不可充）', dod: 0.90, etaRt: 1.0, tempCoef: 0.006, src: '一次电池无充放循环，按可用容量占比取 0.9' }
];
const batteryOf = (k) => BATTERY.find((b) => b.key === k) || BATTERY[2];

// ═══════════════════════════════════════════════════════════════════════════
// 太阳几何（纯天文，无经验成分）
// ═══════════════════════════════════════════════════════════════════════════

/** 太阳赤纬（Cooper 1969）。n=年积日 1…365 → 度 */
const declinationDeg = (n) => 23.45 * Math.sin(D2R * 360 * (284 + n) / 365);

/** 日地距离修正因子 E0（D&B 式 1.4.1a） */
const eccentricity = (n) => 1 + 0.033 * Math.cos(D2R * 360 * n / 365);

/** 日落时角（度）。极昼返回 180、极夜返回 0 */
function sunsetHourAngleDeg(latDeg, decDeg) {
  const x = -Math.tan(latDeg * D2R) * Math.tan(decDeg * D2R);
  if (x <= -1) return 180;
  if (x >= 1) return 0;
  return Math.acos(x) / D2R;
}

/**
 * 水平面天文日辐照量 H0（D&B 式 1.10.3），单位 MJ/m²·d
 *   H0 = (24·3600/π)·Gsc·E0·[cosφ·cosδ·sin ωs + (π·ωs/180)·sinφ·sinδ]
 */
function h0Horizontal(latDeg, n) {
  const dec = declinationDeg(n), ws = sunsetHourAngleDeg(latDeg, dec);
  const t = Math.cos(latDeg * D2R) * Math.cos(dec * D2R) * Math.sin(ws * D2R)
    + (Math.PI * ws / 180) * Math.sin(latDeg * D2R) * Math.sin(dec * D2R);
  const j = (24 * 3600 / Math.PI) * GSC * eccentricity(n) * Math.max(0, t);
  return j / 1e6;      // MJ/m²·d
}

/** 散射比 Hd/H（Erbs 等 1982；D&B 式 2.12.1）。分段依日落时角 ωs 分两支 */
function diffuseFraction(kt, wsDeg) {
  const k = clamp(kt, 0, 1);
  if (wsDeg <= 81.4) {
    if (k < 0.715) return 1.0 - 0.2727 * k + 2.4495 * k * k - 11.9514 * k ** 3 + 9.3879 * k ** 4;
    return 0.143;
  }
  if (k < 0.722) return 1.0 + 0.2832 * k - 2.5557 * k * k + 0.8448 * k ** 3;
  return 0.175;
}

/**
 * 倾斜面日辐照量（Liu–Jordan 各向同性天空，D&B 式 2.15.1）
 *   HT = Hb·Rb + Hd·(1+cosβ)/2 + H·ρ·(1−cosβ)/2
 * 朝赤道倾斜 β；北半球正南、南半球正北（本式已按 |φ|−β 处理）。
 */
function tiltedIrradiation(latDeg, n, kt, tiltDeg, albedo) {
  const H0 = h0Horizontal(latDeg, n);
  if (!(H0 > 0)) return { HT: 0, H: 0, H0: 0, Rb: 0, hdRatio: 0 };
  const H = kt * H0;
  const dec = declinationDeg(n);
  const ws = sunsetHourAngleDeg(latDeg, dec);
  const hdR = diffuseFraction(kt, ws);
  const Hd = H * hdR, Hb = H - Hd;

  // 倾斜面等效纬度 φ−β（南半球取 φ+β；用 sign 归一）
  const phiEq = latDeg >= 0 ? (latDeg - tiltDeg) : (latDeg + tiltDeg);
  const wsT = Math.min(ws, sunsetHourAngleDeg(phiEq, dec));
  const numer = Math.cos(phiEq * D2R) * Math.cos(dec * D2R) * Math.sin(wsT * D2R)
    + (Math.PI * wsT / 180) * Math.sin(phiEq * D2R) * Math.sin(dec * D2R);
  const denom = Math.cos(latDeg * D2R) * Math.cos(dec * D2R) * Math.sin(ws * D2R)
    + (Math.PI * ws / 180) * Math.sin(latDeg * D2R) * Math.sin(dec * D2R);
  const Rb = denom > 0 ? Math.max(0, numer / denom) : 0;

  const b = tiltDeg * D2R, rho = num(albedo, 0.2);
  const HT = Hb * Rb + Hd * (1 + Math.cos(b)) / 2 + H * rho * (1 - Math.cos(b)) / 2;
  return { HT, H, H0, Rb, hdRatio: hdR, Hb, Hd };
}

/**
 * 逐月倾斜面日辐照量 + 最差月。
 * @returns { months:[{m,zh,HT,psh}], worst:{...}, meanPsh }
 * psh＝等效峰值日照小时数 = HT(MJ/m²) × 1e6 / 3600 / 1000（按 1 kW/m² 标定辐照度）
 */
function monthlyIrradiation(latDeg, kt, tiltDeg, albedo) {
  const months = REP_DAY.map((n, i) => {
    const t = tiltedIrradiation(latDeg, n, kt, tiltDeg, albedo);
    return { m: i + 1, zh: MONTH_ZH[i], HT: t.HT, H: t.H, H0: t.H0, Rb: t.Rb, psh: t.HT * 1e6 / 3.6e6 };
  });
  let worst = months[0];
  for (const x of months) if (x.psh < worst.psh) worst = x;
  const meanPsh = months.reduce((a, x) => a + x.psh, 0) / 12;
  return { months, worst, meanPsh };
}

/** 朝赤道固定安装的经验最佳倾角：β ≈ |φ|（离网年均最优约为 φ，冬季优先取 φ+10~15°） */
const bestTiltDeg = (latDeg, season) => {
  const a = Math.abs(latDeg);
  if (season === 'winter') return clamp(a + 12, 0, 80);
  if (season === 'summer') return clamp(a - 12, 0, 80);
  return clamp(a, 0, 80);
};

// ═══════════════════════════════════════════════════════════════════════════
// 负载：日能耗
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一台设备的日能耗（Wh/d）。两种写法都收：
 *   ① states: [{ k, label, w, secPerDay }]  —— 逐状态给功率与时长（总时长不必凑满 86400，
 *      缺的那段按 sleepW 补；超了报错，不静默截断）
 *   ② 便捷式：{ reportsPerDay, txSecPerReport, rxSecPerReport, txW, rxW, idleW, sleepW }
 * @returns { whPerDay, breakdown:[{k,label,w,secPerDay,wh}], errors }
 */
function deviceDailyEnergy(load) {
  const out = { whPerDay: 0, breakdown: [], errors: [], warn: [] };
  if (!load) return out;
  let states = Array.isArray(load.states) ? load.states.slice() : null;

  if (!states) {
    const rep = num(load.reportsPerDay, 0);
    const txS = num(load.txSecPerReport, 0) * rep;
    const rxS = num(load.rxSecPerReport, 0) * rep;
    states = [];
    if (txS > 0) states.push({ k: 'tx', label: '发射', w: num(load.txW, 0), secPerDay: txS });
    if (rxS > 0) states.push({ k: 'rx', label: '接收', w: num(load.rxW, 0), secPerDay: rxS });
    if (num(load.idleSecPerDay, 0) > 0) states.push({ k: 'idle', label: '待机', w: num(load.idleW, 0), secPerDay: num(load.idleSecPerDay, 0) });
    // 常供电的负载（摄像机、边缘盒）直接给 alwaysW
    if (num(load.alwaysW, 0) > 0) states.push({ k: 'always', label: '常供电', w: num(load.alwaysW, 0), secPerDay: 86400 });
  }

  let used = 0;
  for (const s of states) {
    const sec = Math.max(0, num(s.secPerDay, 0));
    const wh = num(s.w, 0) * sec / 3600;
    out.breakdown.push({ k: s.k, label: s.label || s.k, w: num(s.w, 0), secPerDay: sec, wh });
    out.whPerDay += wh;
    used += sec;
  }
  if (used > 86400 + 1e-6) {
    out.errors.push(`各状态时长合计 ${(used / 3600).toFixed(2)} h 超过一天 24 h`);
  } else if (used < 86400 && !states.some((s) => s.k === 'always')) {
    // 余下时间按睡眠功率补：μA 级也要算，一年是 8760 小时
    const rest = 86400 - used;
    const sw = num(load.sleepW, 0);
    const wh = sw * rest / 3600;
    out.breakdown.push({ k: 'sleep', label: '睡眠', w: sw, secPerDay: rest, wh });
    out.whPerDay += wh;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 供电：能给多少
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 供电侧算账。
 * @param {object} sup
 *   kind: 'mains' | 'solar' | 'battery' | 'poe' | 'genset'
 *   mains:   { availPct }
 *   solar:   { wp, latDeg, kt, tiltDeg, albedo, etaSys, battery:{ chem, vdc, ah, tempC }, autonomyDays }
 *   battery: { chem, vdc, ah }（一次电池：算可支撑天数）
 * @param {number} whPerDay 负载日能耗
 */
function supplyBudget(sup, whPerDay) {
  const r = { kind: (sup && sup.kind) || 'mains', checks: [], notes: [], warn: [], errors: [], estimated: false };
  const need = Math.max(0, num(whPerDay, 0));
  r.needWhPerDay = need;

  if (r.kind === 'mains' || r.kind === 'poe' || r.kind === 'genset') {
    r.availPct = num(sup && sup.availPct, r.kind === 'mains' ? 99.5 : null);
    r.notes.push(r.kind === 'mains' ? '市电供电：容量不设限，只贡献可用度' : '外部供电：容量不设限');
    return r;
  }

  if (r.kind === 'battery') {
    const b = batteryOf(sup.chem || 'primary_li');
    const cap = num(sup.vdc, 3.6) * num(sup.ah, 0);              // Wh 标称
    const tCoef = 1 - b.tempCoef * Math.max(0, 25 - num(sup.tempC, 25));
    const usable = cap * b.dod * clamp(tCoef, 0.3, 1.05);
    r.batteryWh = cap; r.usableWh = usable;
    r.daysSupported = need > 0 ? usable / need : Infinity;
    r.checks.push({
      k: 'life', label: '电池可支撑', actual: r.daysSupported, limit: num(sup.targetDays, null),
      unit: 'd', over: sup.targetDays != null && r.daysSupported < num(sup.targetDays, 0), low: true, src: b.src
    });
    r.notes.push(`${b.zh} · 标称 ${cap.toFixed(1)} Wh · DoD ${(b.dod * 100).toFixed(0)}% · ${num(sup.tempC, 25)} ℃ 修正 ${(tCoef * 100).toFixed(0)}%`);
    return r;
  }

  if (r.kind === 'solar') {
    const wp = num(sup.wp, 0);
    const lat = num(sup.latDeg, null);
    if (lat == null) { r.errors.push('缺站址纬度，无法算光伏可用能量'); return r; }
    const kt = num(sup.kt, 0.50);
    const tilt = sup.tiltDeg != null ? num(sup.tiltDeg, 0) : bestTiltDeg(lat, 'winter');
    const eta = num(sup.etaSys, 0.75);
    const irr = monthlyIrradiation(lat, kt, tilt, num(sup.albedo, 0.2));

    r.estimated = true;           // ★ Kt 是用户给的气候量，本平台没有那张图 —— 出参必须标为估算
    r.tiltDeg = tilt; r.kt = kt; r.etaSys = eta;
    r.months = irr.months.map((m) => ({ ...m, whPerDay: wp * m.psh * eta }));
    r.worstMonth = { ...irr.worst, whPerDay: wp * irr.worst.psh * eta };
    r.meanWhPerDay = wp * irr.meanPsh * eta;
    r.genWhPerDay = r.worstMonth.whPerDay;      // 定容按最差月

    r.checks.push({
      k: 'pv', label: `光伏日发电（最差月 ${irr.worst.zh}）`, actual: r.genWhPerDay, limit: need,
      unit: 'Wh/d', over: r.genWhPerDay < need, low: true, src: 'Duffie & Beckman 4/e §1.10、§2.15；Erbs 1982'
    });
    r.notes.push(`倾角 ${tilt.toFixed(0)}° · Kt=${kt} · 系统效率 ${(eta * 100).toFixed(0)}% · 最差月 ${irr.worst.zh} PSH ${irr.worst.psh.toFixed(2)} h`);

    // 蓄电池自主天数
    if (sup.battery) {
      const b = batteryOf(sup.battery.chem || 'lifepo4');
      const cap = num(sup.battery.vdc, 12) * num(sup.battery.ah, 0);
      const tCoef = 1 - b.tempCoef * Math.max(0, 25 - num(sup.battery.tempC, 25));
      const usable = cap * b.dod * clamp(tCoef, 0.3, 1.05) * b.etaRt;
      const autonomy = need > 0 ? usable / need : Infinity;
      const target = num(sup.autonomyDays, 3);
      r.batteryWh = cap; r.usableWh = usable; r.autonomyDays = autonomy;
      r.checks.push({ k: 'aut', label: '蓄电池自主天数', actual: autonomy, limit: target, unit: 'd', over: autonomy < target, low: true, src: b.src });
      // 反解所需容量（离网通行式）
      r.needAh = need * target / (num(sup.battery.vdc, 12) * b.dod * clamp(tCoef, 0.3, 1.05) * b.etaRt);
      r.notes.push(`${b.zh} ${cap.toFixed(0)} Wh · 目标自主 ${target} d 需 ${r.needAh.toFixed(0)} Ah @${num(sup.battery.vdc, 12)} V`);
    }
    // 反解所需组件功率（最差月刚好平衡）
    if (r.worstMonth.psh > 0) r.needWp = need / (r.worstMonth.psh * eta);
    return r;
  }

  r.warn.push(`未知供电方式 ${r.kind}`);
  return r;
}

/**
 * 一个模块的完整能量账：负载 + 供电。
 * @returns { load, supply, ok, marginWhPerDay }
 */
function computeEnergy(spec) {
  const load = deviceDailyEnergy(spec && spec.load);
  const supply = supplyBudget((spec && spec.supply) || { kind: 'mains' }, load.whPerDay);
  const out = { load, supply, ok: true, errors: [], warn: [] };
  out.errors.push(...load.errors, ...supply.errors);
  out.warn.push(...load.warn, ...supply.warn);
  if (supply.genWhPerDay != null) out.marginWhPerDay = supply.genWhPerDay - load.whPerDay;
  for (const c of supply.checks) if (c.over) out.ok = false;
  if (out.errors.length) out.ok = false;
  return out;
}

module.exports = {
  GSC, REP_DAY, MONTH_ZH, BATTERY, batteryOf,
  declinationDeg, eccentricity, sunsetHourAngleDeg, h0Horizontal, diffuseFraction,
  tiltedIrradiation, monthlyIrradiation, bestTiltDeg,
  deviceDailyEnergy, supplyBudget, computeEnergy
};
