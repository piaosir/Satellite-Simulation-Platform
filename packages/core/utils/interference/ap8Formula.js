// C/I 窗「协调触发」页：RR 附录 8 式(1)–(3) 原式（同频段、同传输方向，Case I），只做原式那几步。
//
//   ΔTs = p′e · g′1(θt) · g2(δe′) / (k · lu)     式(1)
//   ΔTe = p′s · g′3(ηe) · g4(θt)  / (k · ld)     式(2)
//   ΔT  = γ · ΔTs + ΔTe                          式(3)；与链路等效噪温 T 之比 ΔT/T 对 6%（§3）
//
// 入参就是原式里的量（dB 值，T 用 K），不做任何几何、方向图、功放折算：拓扑角、离轴增益、自由空间损耗由工程师自己给。
// 页面约定带撇号的量属施扰方 = 本网、不带撇号的属受扰方 = 邻网（「本网对邻网的影响」），记号与原文一字不改。
// 分项算式与 k、门限取 ../itu/ap8.js 的同一份（附件 4 算例在 ap8.test.mjs 里逐项对账）。

const { deltaTsK, deltaTeK, combineDeltaT, K_DB, THRESHOLD_PCT } = require('../itu/ap8.js');

// 入参键与原式符号（大写 = dB 量，附录 8 §2.1 的记号习惯）
const KEYS = ['PeDb', 'G1Dbi', 'G2Dbi', 'LuDb', 'PsDb', 'G3Dbi', 'G4Dbi', 'LdDb', 'gammaDb', 'TK'];
const SYMBOL = {
  PeDb: 'P′e', G1Dbi: 'G′1(θt)', G2Dbi: 'G2(δe′)', LuDb: 'Lu',
  PsDb: 'P′s', G3Dbi: 'G′3(ηe)', G4Dbi: 'G4(θt)', LdDb: 'Ld',
  gammaDb: 'γ', TK: 'T'
};

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const numOf = (v) => (v === '' || v == null ? NaN : Number(v));

/**
 * @param {object} p { PeDb, G1Dbi, G2Dbi, LuDb, PsDb, G3Dbi, G4Dbi, LdDb, gammaDb, TK }
 * @returns {object} ok:false 时带 missing（缺 / 非法的原式符号）；ok:true 时
 *   { kDb, thresholdPct, deltaTsDbK, deltaTsK, deltaTeDbK, deltaTeK, gammaLin, deltaTK, pct, exceeds }
 *   exceeds 只供着色。
 */
function ap8CaseI(p) {
  const x = {};
  const missing = [];
  for (const k of KEYS) {
    x[k] = numOf(p && p[k]);
    if (!fin(x[k]) || (k === 'TK' && !(x[k] > 0))) missing.push(SYMBOL[k]);
  }
  if (missing.length) return { ok: false, missing, kDb: K_DB, thresholdPct: THRESHOLD_PCT };
  const dTs = deltaTsK(x.PeDb, x.G1Dbi, x.G2Dbi, x.LuDb);
  const dTe = deltaTeK(x.PsDb + x.G3Dbi, x.G4Dbi, x.LdDb);
  const c = combineDeltaT(dTs, dTe, x.gammaDb, x.TK);
  return {
    ok: true,
    kDb: K_DB,
    thresholdPct: THRESHOLD_PCT,
    deltaTsDbK: 10 * Math.log10(dTs), deltaTsK: dTs,
    deltaTeDbK: 10 * Math.log10(dTe), deltaTeK: dTe,
    gammaLin: Math.pow(10, x.gammaDb / 10),
    deltaTK: c.deltaTK,
    pct: c.pct,
    exceeds: c.pct > THRESHOLD_PCT
  };
}

module.exports = { ap8CaseI, AP8_CASE_I_KEYS: KEYS, AP8_CASE_I_SYMBOL: SYMBOL };
