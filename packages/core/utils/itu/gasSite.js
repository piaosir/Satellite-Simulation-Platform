// itu/gasSite.js — 按站址取统计气象参数的斜路径气体衰减（链路预算两引擎与雨衰页同一入口）
//
// 口径（2026-10-17，C-01 / C-03）：
//   · 时间百分比 p = 100 − 可用度。按 ITU-R P.618-14 §2.5 式(65)(66)(68)：p ≥ 5% 用 A_G(p)；p < 5% 取 A_G(5%)；
//     可用度 100%（晴空，p = 0）取中值 p = 50%。
//   · θ ≥ 5°：P.676-13 Annex 2 统计法——γ_o（Annex 1 逐线）与 K_w（Part 2）用年均地面气象，h_o（Part 1）用 p 档地面
//     气象，水汽 A_w = K_w·V(p)/sinθ（§2.3）。年均 ρ 由 P.836-6 年 CCDF 积分得到，ρ(p)/V(p) 取 P.836-6 数字图
//     （data/waterVaporGrid.js，按 VSCH 换算到站高）。地面气压 / 温度沿用平台 P.835 估算（p835.js ②）。
//   · θ < 5°：Annex 1 §2.2.1 分层射线，廓线为按地面 P/T/ρ(p) 锚定的 P.835 参考大气，水汽标高 H = V(p)/ρ(p)
//     （使廓线的柱水汽等于 P.836 的 V(p)）。
//   · 站高高于地形（机载，P.2041-1 §4.2）：地面气象取地形高度处，A_o 乘 e^(−离地高度/h_o)，V 取机高处；
//     离地高度 = 站高 − max(地形, 0)；地形取 P.1511（已注入时）否则 P.836 格点海拔；都缺时视站点在地面。
//     离地不足 0.1 km 仍按地面站（楼顶 / 塔上天线、手填海拔与 5′ 平滑地形之差都在这个量级）：此时地面气象就取站高处。
//     两种算法在 0.1 km 两侧实测只差：氧气 0.2%、水汽 ≤ 1%（北京 / 广州 / 拉萨，20 / 50 GHz），不构成可见跳变。
//   · P.836 v2 未注入时退回瞬时法 1（§1.1 + §2.1，ρ 取旧 RHO_10/RHO_90 两图对 log p 插值或 P.835 纬度带），
//     并对离地高度按 e^(−h/h_o)、e^(−h/2 km) 折减。

const p676 = require('./p676.js');
const p835 = require('./p835.js');
const wv = require('../../data/waterVaporGrid.js');
let elevation = null;
try { elevation = require('../elevation.js'); } catch (e) { /* 地形模块缺失时只用 P.836 格点海拔 */ }

/**
 * 气体衰减取用的时间百分比（P.618-14 §2.5 式 68 + 晴空中值）
 * @param {number} pPct 超越概率 %（= 100 − 可用度）
 */
function gasProbability(pPct) {
  if (!(pPct > 0)) return 50;
  if (pPct < 5) return 5;
  return Math.min(pPct, 99);
}

/** 站点地形高度 km：P.1511（已注入）→ P.836 格点海拔 → NaN */
function terrainKm(lat, lon) {
  try {
    if (elevation && elevation.isElevationReady && elevation.isElevationReady()) {
      const r = elevation.queryElevation(lat, lon);
      if (r && r.success && Number.isFinite(r.altitude)) return r.altitude / 1000;
    }
  } catch (e) { /* 落到下一档 */ }
  const g = wv.gridAltitude(lat, lon);
  return Number.isFinite(g) ? g : NaN;
}

// 结果记忆：同一站址 / 频率 / 仰角 / 概率档在求解器与批量里会被反复调用（功带平衡一行 30 余次），
// θ < 5° 的分层射线一次约 6 ms。键含数据就绪状态，注入新数据后自然失效；上限 4000 条，满了整表清空。
const AGL_GROUND_KM = 0.1;   // 离地不足此值按地面站（见文件头）

const _memo = new Map();
function _memoKey(q) {
  const elevOk = !!(elevation && elevation.isElevationReady && elevation.isElevationReady());
  return [q.f, q.el, q.lat, q.lon, q.hsKm, gasProbability(Number(q.pPct)), wv.isReadyV2() ? 1 : 0, wv.isReady() ? 1 : 0, elevOk ? 1 : 0].join('|');
}

/**
 * @param {object} q
 *   f      频率 GHz；el 视仰角（度，≥ 0）；lat/lon 站址；hsKm 站高（海拔 km，机载即机高）；
 *   pPct   超越概率 %（= 100 − 可用度；0 = 晴空）
 * @returns {object} { A, Ao, Aw, method, pGas, hSurf, agl, P, T, rhoMean, rho, V, H }（只读，勿改）
 */
function gaseousAttenuationSite(q) {
  const key = _memoKey(q);
  const hit = _memo.get(key);
  if (hit) return hit;
  const r = Object.freeze(_compute(q));
  if (_memo.size >= 4000) _memo.clear();
  _memo.set(key, r);
  return r;
}

function _compute(q) {
  const f = Number(q.f), lat = Number(q.lat), lon = Number(q.lon);
  const el = Math.min(90, Math.max(0, Number.isFinite(q.el) ? q.el : 90));
  const hs = Math.max(0, Number(q.hsKm) || 0);
  const pGas = gasProbability(Number(q.pPct));
  const out = { A: 0, Ao: 0, Aw: 0, method: '', pGas, hSurf: hs, agl: 0, P: NaN, T: NaN, rhoMean: NaN, rho: NaN, V: NaN, H: NaN };
  if (!(f > 0)) return out;

  const ter = terrainKm(lat, lon);
  let hSurf = Number.isFinite(ter) ? Math.min(hs, Math.max(0, ter)) : hs;
  if (hs - hSurf < AGL_GROUND_KM) hSurf = hs;
  const agl = hs - hSurf;
  const P = p835.surfacePressure(hSurf), T = p835.surfaceTemperature(lat, hSurf);
  Object.assign(out, { hSurf, agl, P, T });

  const v2 = wv.isReadyV2() && Number.isFinite(lat) && Number.isFinite(lon);
  let rho, rhoMean, V = NaN, H = 2;
  if (v2) {
    rho = wv.getRhoP(lat, lon, pGas, hSurf);
    rhoMean = wv.getRhoMean(lat, lon, hSurf);
    V = wv.getVP(lat, lon, pGas, hs);                    // P.2041-1 式(7)：V 取终端所在高度
    const Vs = wv.getVP(lat, lon, pGas, hSurf);
    if (Number.isFinite(Vs) && rho > 0) H = Math.max(0.5, Math.min(6, Vs / rho));
  }
  if (!Number.isFinite(rho) || !Number.isFinite(rhoMean)) {
    const r = wv.rhoAt(lat, lon, pGas, hSurf);
    rho = r.rho; rhoMean = wv.rhoAt(lat, lon, 50, hSurf).rho; V = NaN; H = 2;
  }
  Object.assign(out, { rho, rhoMean, V, H });

  if (el < 5) {
    const prof = p676.anchoredProfile({ hs: hSurf, Ps: P, Ts: T, rho, H });
    const r = p676.slantPathLayered(f, el, hs, 100, prof);
    return Object.assign(out, { A: r.A, Ao: r.Ao, Aw: r.Aw, method: 'annex1-layered' });
  }
  const s = Math.sin(el * Math.PI / 180);
  if (Number.isFinite(V)) {
    const st = p676.slantPathStatistical({ f, el, P, T, rho: rhoMean, Pp: P, Tp: T, rhop: rho, V });
    const kO = agl > 0 && st.ho > 0 ? Math.exp(-agl / st.ho) : 1;
    const Ao = st.Ao * kO;
    return Object.assign(out, { A: Ao + st.Aw, Ao, Aw: st.Aw, ho: st.ho, method: 'annex2-stat' });
  }
  const g = p676.specificAttenuation(f, P, T, rho);
  const ho = p676.oxygenEquivalentHeight(f, P, T, rho), hw = p676.waterVapourEquivalentHeight(f);
  const Ao = g.gammaO * Math.max(ho, 0) * (agl > 0 && ho > 0 ? Math.exp(-agl / ho) : 1) / s;
  const Aw = g.gammaW * Math.max(hw, 0) * (agl > 0 ? Math.exp(-agl / 2) : 1) / s;
  return Object.assign(out, { A: Ao + Aw, Ao, Aw, ho, method: 'annex2-inst' });
}

module.exports = { gasProbability, terrainKm, gaseousAttenuationSite, AGL_GROUND_KM };
