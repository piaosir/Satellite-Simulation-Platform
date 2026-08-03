// PFD Mask · 地球站发射参考方向图（eirp_mask_es 用）
//
// ★ 这里只放【发射侧】的包络。绝不能用 S.1428——那是给「受扰方接收天线」写的统计型图，
//   含旁瓣波谷，电平比 S.580/S.465 低；拿它当发射包络会给出偏松的 mask，是隐性放宽。
//   S.1528 同理不能用（那是【卫星】天线的图）。两套图在本模块里彻底隔离。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据
//   ITU-R S.580-6   GSO FSS 地球站天线【设计目标】方向图：29 − 25 lg φ
//   ITU-R S.465-6   协调用【参考】方向图：32 − 25 lg φ，48° 之后 −10 dBi
//   ITU-R S.1503-4 §B5.3  e.i.r.p. mask 必须单调不增 —— 真实方向图有旁瓣起伏，
//                         落盘前必须做「后缀取最大」，否则被 BR 打回
// ─────────────────────────────────────────────────────────────────────────────

const LOG10 = Math.log10;

/** 可选的地球站发射方向图牌号。默认顺序即推荐顺序。 */
const ES_PATTERN_KINDS = Object.freeze([
  { v: 'measured', label: '实测 / GRD（推荐）', needsRef: true },
  { v: 'S.580-6', label: 'ITU-R S.580-6（29 − 25 lgφ）', needsRef: false },
  { v: 'S.465-6', label: 'ITU-R S.465-6（32 − 25 lgφ）', needsRef: false },
  { v: 'M.2101', label: 'ITU-R M.2101 相控阵', needsRef: false },
]);

/** 圆口径峰值增益 G = 10lg(η) + 20lg(πD/λ)。 */
function peakGainDbi(diameterM, wavelengthM, efficiency) {
  const D = Number(diameterM), lam = Number(wavelengthM);
  const eff = Number(efficiency) > 0 ? Number(efficiency) : 0.65;
  if (!(D > 0) || !(lam > 0)) throw new RangeError('esPatterns.peakGainDbi: 口径与波长必须为正');
  return 20 * LOG10(Math.PI * D / lam) + 10 * LOG10(eff);
}

/** φ_min（度）：包络的起点。两份建议书都取 max(1°, 100λ/D)。 */
function phiMinDeg(diameterM, wavelengthM) {
  const r = Number(diameterM) / Number(wavelengthM);
  return Math.max(1, 100 / r);
}

/**
 * ITU-R S.580-6 设计目标方向图。
 *   G(φ) = 29 − 25 lg φ    φ_min ≤ φ ≤ 20°
 * 20° 以外原文未规定；工程上沿用 S.465 的做法延伸到 48° 再落到平台，
 * 这一段是【自定口径】，随 mask 打印。
 */
function gainDbiS580(phiDeg, p) {
  const phi = Math.abs(Number(phiDeg));
  const pk = Number(p.peakGainDbi);
  const p0 = phiMinDeg(p.diameterM, p.wavelengthM);
  if (phi < p0) return pk;                       // 主瓣内按峰值（保守）
  if (phi <= 48) return 29 - 25 * LOG10(Math.max(phi, p0));
  return -10;                                    // [S] 48° 之后的平台沿用 S.465
}

/**
 * ITU-R S.465-6 参考方向图。
 *   G(φ) = 32 − 25 lg φ    φ_min ≤ φ < 48°
 *   G(φ) = −10 dBi         48° ≤ φ ≤ 180°
 */
function gainDbiS465(phiDeg, p) {
  const phi = Math.abs(Number(phiDeg));
  const pk = Number(p.peakGainDbi);
  const p0 = phiMinDeg(p.diameterM, p.wavelengthM);
  if (phi < p0) return pk;
  if (phi < 48) return 32 - 25 * LOG10(Math.max(phi, p0));
  return -10;
}

/**
 * ITU-R M.2101 相控阵（单元 × 阵因子的包络近似）。
 * ★ 相控阵的方向图随扫描角变，是四维的；本函数只给【某一扫描角下】的一维切面，
 *   降维到 T 型 mask 的那一步由 buildEirpEs 的「扫描族逐点取最大」完成。
 */
function gainDbiM2101(phiDeg, p) {
  const phi = Math.abs(Number(phiDeg));
  const n = Number(p.arrayElements) > 0 ? Number(p.arrayElements) : 64;
  // 扫描角 = 波束轴与阵面法线的夹角。M.2101 §5 把方向图拆成「单元方向图 + 阵因子」，
  // 扫描的两个后果分别出自这两项：
  //   峰值 —— 阵因子在指向上恒为 10lg(N_H·N_V)，与扫描无关，故扫描损失全部来自单元方向图，
  //           取该建议书的缺省单元参数 θ₃dB = 65°、A_max = 30 dB ⇒ −min(12(θs/65)², 30)。
  //           不得再叠加 cosθs 的投影损失，那是同一份损失的另一种记法，叠加即双计。
  //   主瓣宽 —— 投影口径按 cosθs 缩 ⇒ 展宽 1/cosθs。单元包络本身不随扫描变。
  const scan = Math.abs(Number(p.scanAngleDeg)) || 0;
  if (!(scan < 90)) throw new RangeError(`esPatterns: M.2101 扫描角须 < 90°（${p.scanAngleDeg}）`);
  const cs = Math.cos(scan * Math.PI / 180);
  const pk = Number(p.peakGainDbi) - Math.min(12 * Math.pow(scan / 65, 2), 30);
  // 阵因子主瓣宽度 ≈ 102/√N 度（等幅方阵近似），旁瓣包络按 −13.2 dB 首旁瓣后 25lg 滚降
  const bw = 102 / Math.sqrt(n) / cs;
  if (phi <= bw / 2) return pk - 12 * Math.pow(2 * phi / bw, 2);
  const env = pk - 13.2 - 25 * LOG10(Math.max(1, 2 * phi / bw));
  return Math.max(env, Number.isFinite(Number(p.floorDbi)) ? Number(p.floorDbi) : -10);
}

/**
 * 统一入口：造一个地球站发射方向图求值器。
 * @param {object} p {kind, peakGainDbi?, diameterM, wavelengthM, efficiency?, samples?, arrayElements?, floorDbi?, scanAngleDeg?}
 *        scanAngleDeg 只对 kind='M.2101' 有意义；反射面天线（S.580/S.465）没有扫描角，忽略。
 *        kind='measured' 时须给 samples: [[phiDeg, gainDbi], ...]（升序，将做单调化前的原始曲线）
 */
function makeEsPattern(p) {
  const kind = String(p.kind || 'S.580-6');
  const q = Object.assign({}, p);
  if (!Number.isFinite(Number(q.peakGainDbi))) {
    q.peakGainDbi = peakGainDbi(q.diameterM, q.wavelengthM, q.efficiency);
  }

  let fn;
  if (kind === 'measured') {
    const s = (q.samples || []).slice().sort((a, b) => a[0] - b[0]);
    if (s.length < 2) throw new RangeError('esPatterns: kind="measured" 需要至少 2 个 [φ, G] 样本');
    fn = (phi) => {
      const x = Math.abs(Number(phi));
      if (x <= s[0][0]) return s[0][1];
      if (x >= s[s.length - 1][0]) return s[s.length - 1][1];
      let lo = 0, hi = s.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m][0] <= x) lo = m; else hi = m; }
      const t = (x - s[lo][0]) / (s[hi][0] - s[lo][0] || 1);
      return s[lo][1] * (1 - t) + s[hi][1] * t;
    };
  } else if (kind === 'S.580-6') fn = (phi) => gainDbiS580(phi, q);
  else if (kind === 'S.465-6') fn = (phi) => gainDbiS465(phi, q);
  else if (kind === 'M.2101') fn = (phi) => gainDbiM2101(phi, q);
  else throw new RangeError(`esPatterns: 未知方向图牌号 "${kind}"（可选 ${ES_PATTERN_KINDS.map((k) => k.v).join(' / ')}）`);

  return { kind, peakGainDbi: q.peakGainDbi, gainDb: fn };
}

/**
 * 单调化（后缀取最大）：v'[i] = max(v[i..n−1])。
 *
 * §B5.3 要求 e.i.r.p. mask 单调不增。真实方向图（尤其实测与相控阵）在旁瓣区有起伏，
 * 直接落盘必被打回。取【后缀最大】而不是排序，因为：
 *   · 它给出的是原曲线的最小单调上包络 —— 处处 ≥ 原值（安全），且是所有单调上包络里最紧的（不浪费容量）
 *   · 排序会打乱角度与值的对应关系，是错的
 *
 * @param {number[]} values 按角度升序排列的值
 * @returns {{values:number[], liftedCount:number, maxLiftDb:number}} 同时报告被抬高了多少
 */
function monotoneEnvelope(values) {
  const out = values.slice();
  let lifted = 0, maxLift = 0;
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i] < out[i + 1]) {
      const lift = out[i + 1] - out[i];
      if (lift > maxLift) maxLift = lift;
      lifted++;
      out[i] = out[i + 1];
    }
  }
  return { values: out, liftedCount: lifted, maxLiftDb: maxLift };
}

/** 校验单调不增（落盘前的硬断言）。 */
function assertMonotonicDecreasing(values, tolDb) {
  const tol = tolDb === undefined ? 1e-9 : tolDb;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1] + tol) {
      return { ok: false, index: i, from: values[i - 1], to: values[i] };
    }
  }
  return { ok: true };
}

module.exports = {
  ES_PATTERN_KINDS,
  peakGainDbi, phiMinDeg,
  gainDbiS580, gainDbiS465, gainDbiM2101,
  makeEsPattern, monotoneEnvelope, assertMonotonicDecreasing,
};
