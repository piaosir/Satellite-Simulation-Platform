// D 路验证：平台 deltaTOverT（施扰侧，只含上行 ΔTs/Ts）vs RR AP8 完整 ΔT/T（γΔTs + ΔTe）/T
const path = require('path');
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台/packages/core/utils/interference/';
const A = require(ROOT + 'ciAsi.js');
const G = require(ROOT + 'geometry.js');
const P = require(ROOT + 'patterns.js');
const lin = (d) => Math.pow(10, d / 10), dB = (x) => 10 * Math.log10(x);
const lam = (f) => 299792458 / (f * 1e9);

// ---- 1) 平台出厂配置下的「协调判据 ΔT/T」 ----
const st = { lon: 116.4074, lat: 39.9042, alt: 0 };
const plat = A.deltaTOverT({
  station: st,
  tx: { diameterM: 4.5, efficiency: 0.65, freqGHz: 14.25, powerW: 40, feederLossDb: 3.5, bandwidthHz: 36e6 },
  wanted: { lonDeg: 110.5 },
  victim: { lonDeg: 113, gOverTDbPerK: 2, rxGainDbi: 30 }
});
console.log('[平台] θt=%s°  旁瓣EIRP密度=%s dBW/Hz  ΔTs=%s K  Ts=%s K  ΔTs/Ts=%s%%',
  plat.thetaDeg.toFixed(3), plat.sidelobeEirpDensityDbWPerHz.toFixed(2), plat.deltaTK.toFixed(2), plat.victimTk.toFixed(1), plat.deltaTOverTPct.toFixed(3));

// ---- 2) 同一对网络补上 AP8 下行路径 ΔTe（本星 110.5°E 下行 → 邻网 113°E 的收端站）----
// 本星下行：出厂 carrier EIRP 50 dBW / 36 MHz（平台只给均匀平均；AP8 要的是最坏 4 kHz 的最大密度，这里取均匀值 = 偏乐观）
const eirpDen = 50 - dB(36e6);
// 邻网收端站：取北京、1.2 m Ku（AP8 Annex III 的 D/λ<100 档）
const vSt = { lon: 116.4074, lat: 39.9042, alt: 0 };
const sep = G.gsoSeparation(vSt, 113, 110.5);          // 邻网站对准 113°E，本星在 110.5°E
const f = 12.5, D = 1.2, L = lam(f), r = D / L;
// AP8 Annex III, D/λ<100：52 − 10lg(D/λ) − 25lgφ（100λ/D ≤ φ < 48°）
const phi = sep.thetaDeg;
const g4 = (phi >= 100 / r && phi < 48) ? 52 - 10 * Math.log10(r) - 25 * Math.log10(phi) : NaN;
const ld = G.fsl(sep.interferer.rangeKm, f);
const dTe_dBK = eirpDen + g4 - ld + 228.6;
const dTe = lin(dTe_dBK);
// 邻网链路：Te=150 K（Ku VSAT 典型），Ts=600 K，γ=−10 dB（典型弯管 VSAT，假设值，仅示量级）
const Te = 150, Ts = 600, gam = lin(-10);
const T = Te + gam * Ts;
const dTs = plat.deltaTK;      // 上行那一路沿用平台算出的 ΔTs
const ap8 = (gam * dTs + dTe) / T * 100;
console.log('[AP8 下行] θt=%s°  G4(θt)=%s dBi  ld=%s dB  ΔTe=%s K', phi.toFixed(3), g4.toFixed(2), ld.toFixed(2), dTe.toFixed(1));
console.log('[AP8 合成] T=%s K  γΔTs=%s K  ΔT/T=%s%%  （平台只报 ΔTs/Ts=%s%%）', T.toFixed(0), (gam * dTs).toFixed(3), ap8.toFixed(1), plat.deltaTOverTPct.toFixed(2));

// ---- 3) AP8 Annex 4 算例（金标准）复现：ΔTs=145 K, ΔTe=3.6 K, ΔT/T=7.8% ----
const dTs4 = lin(-37 + 14.5 + 15.5 + 228.6 - 200);
const dTe4 = lin(-57 + 15.5 + 14.5 + 228.6 - 196);
const r4 = (lin(-15) * dTs4 + dTe4) / 105 * 100;
console.log('[AP8 Annex4] ΔTs=%s K  ΔTe=%s K  ΔT/T=%s%%（原文 145 / 3.6 / 7.8%%）', dTs4.toFixed(1), dTe4.toFixed(2), r4.toFixed(2));

// ---- 4) 站位保持容差对 θt 的影响（AP8 要求计入经度保持容差）----
for (const tol of [0, 0.05, 0.1]) {
  const s2 = G.gsoSeparation(st, 110.5 + tol, 113 - tol);
  const gS = P.offAxisS580Hybrid(4.5, lam(14.25), 0.65, s2.thetaDeg);   // 2026-10-17 起原 offAxisAP8 改名（行为不变）
  console.log('[保持容差 ±%s°] θt=%s°  本站旁瓣增益=%s dBi', tol, s2.thetaDeg.toFixed(3), gS.toFixed(2));
}
