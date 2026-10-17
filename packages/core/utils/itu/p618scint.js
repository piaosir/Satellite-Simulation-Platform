// itu/p618scint.js — ITU-R P.618-14 §2.4.1 对流层闪烁衰落 A_S(p)
//
// 闪烁不入功率链（用户 2026-07-23 拍板），本函数只出单列读数与 §2.5 总衰减里的 A_S。
// N_wet 缺省 42（P.453 全球中值；实时分支传实测值）。
// 2026-10-17 由 linkCalculator.js / linkCalculatorNGSO.js 两份逐字相同的副本抽出（C-16）。

function calculateScintillationFading(frequencyGHz, elevationDeg, antennaDiameter, availability, antennaEfficiency, Nwet) {
  // P.618-14 §2.4.1 适用范围：θ≥5°，4≤f≤55 GHz
  if (elevationDeg < 5) return 0;
  if (frequencyGHz < 4 || frequencyGHz > 55) return 0;

  const eta = (antennaEfficiency !== undefined) ? antennaEfficiency : 0.5;
  const nwet = (Nwet !== undefined) ? Nwet : 42;

  const elevRad = elevationDeg * Math.PI / 180;

  // Step 1: σ_ref（公式42）
  const sigma_ref = 3.6e-3 + 1e-4 * nwet;

  // Step 2: 有效路径长度 L（公式43），单位 m
  const hL = 1000;
  const L = 2 * hL / (Math.sqrt(Math.pow(Math.sin(elevRad), 2) + 2.35e-4) + Math.sin(elevRad));

  // Step 3: 有效天线直径 Deff（公式44），单位 m
  const Deff = Math.sqrt(eta) * antennaDiameter;

  // Step 4: x（公式46），f 单位 GHz，L 单位 m
  const x = 1.22 * Deff * Deff * (frequencyGHz / L);

  // Step 5: g(x)（公式45）
  if (x >= 7.0) return 0;
  const zeta = (11 / 6) * Math.atan(1 / x);
  const inner = 3.86 * Math.pow(x * x + 1, 11 / 12) * Math.sin(zeta) - 7.08 * Math.pow(x, 5 / 6);
  if (inner <= 0) return 0;
  const gx = Math.sqrt(inner);

  // Step 6: σ（公式47）
  const sigma = sigma_ref * Math.pow(frequencyGHz, 7 / 12) * gx / Math.pow(Math.sin(elevRad), 1.2);

  // Step 7: a(p)（公式48），p = 超越概率%
  const p = 100 - availability;
  if (p > 50) return 0;              // p>50% 超出适用范围（可用度过低，闪烁统计无意义）
  const pEff = Math.max(p, 0.01);    // p<0.01% 钳位到公式(48)有效域下界（而非返 0——避免可用度>99.99% 时闪烁项凭空消失）
  const logP = Math.log10(pEff);
  const a_p = -0.061 * Math.pow(logP, 3) + 0.072 * Math.pow(logP, 2) - 1.71 * logP + 3.0;

  // Step 8: 闪烁衰减（公式49）
  return a_p * sigma;
}

module.exports = { calculateScintillationFading };
