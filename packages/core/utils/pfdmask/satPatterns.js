// PFD Mask · 星上发射天线方向图集合
//
// 对齐 PMGT 屏3 的 Antenna Gain Pattern 下拉。该下拉在用户截图里只露出第 3 项（Rec.S.1528），
// 但屏3 那几个灰化字段把其余项反推出来了——它们只在选中对应方向图时才被激活：
//     Dish size + Efficiency          → 理论抛物面（增益由口径算，Peak Gain 变派生只读）
//     Gain Floor 1/2 + Beamwidth 1/2  → 两级带底方向图
//     Peak Gain + Beamwidth 1 + Subcode → S.1528
//
// ─────────────────────────────────────────────────────────────────────────────
// ★ 两类天线在 mask 生成里走【不同的算法分支】，这是本文件最要紧的区分：
//
//   可动点波束（steerable = true）：波束能指向视场内任意合法方向
//       ⇒ Direct Approach 对每个活跃格假设「波束正对此处」，用峰值增益。
//          方向图只通过多波束聚合起作用。
//
//   固定指向（steerable = false，如 isoflux / omni）：波束焊死朝天底，转不了
//       ⇒ 每个方向的增益由该方向的【天底角】决定，不能一律按峰值。
//          按峰值算会把固定波束系统的 mask 抬高整整一个主瓣-旁瓣落差。
//
// ★ isoflux 还有一条建议书直接给的特殊规则：
//   S.1503-4 §C2.3.1 —— pfd_co_i = P_i + G_i − 10lg(4πd²)，其中 **isoflux 时 d ≡ 卫星高度**。
//   isoflux 天线的设计目的就是让地面 PFD 与天底角无关，规范因此直接把 d 钉死为 h。
//   本文件用 fixedRangeIsAltitude 标出这条，引擎据此改用 h 而非真实斜距。
// ─────────────────────────────────────────────────────────────────────────────

const s1528 = require('./s1528.js');

const LOG10 = Math.log10;
const D2R = Math.PI / 180;
const RE_KM = 6378.137;

/**
 * 可选方向图。needs 声明各自要哪些输入——UI 的字段灰化直接读这张表，
 * 新增一项不必改 UI 代码（能力表驱动）。
 */
const SAT_PATTERNS = Object.freeze([
  {
    v: 'isoflux', label: '等通量（Isoflux）', steerable: false, evidence: 'R',
    needs: ['peakGainDbi'],
    note: 'S.1503-4 §C2.3.1 为该类天线规定：功率通量密度计算中的斜距恒取卫星高度。常用于 TT&C 与全球波束下行。',
  },
  {
    v: 'omni', label: '全向 / 各向同性（Omni）', steerable: false, evidence: 'T',
    needs: ['peakGainDbi'],
    note: '各方向增益相同。Transfinite 把它列在「单一固定波束开/关」这一类天线体制里。',
  },
  {
    v: 's1528', label: 'ITU-R S.1528 参考方向图', steerable: true, evidence: 'R',
    needs: ['peakGainDbi', 'psibDeg', 'section', 'Ln'],
    note: '★ S.1528 §1.1 明确：有实测方向图时应当用实测图，本节的参考图是拿不到实测图时的替代品。',
  },
  {
    v: 'parabolic', label: '理论抛物面（均匀照射圆口径）', steerable: true, evidence: 'S',
    needs: ['diameterM', 'efficiency', 'nullFloorDb'],
    note: '增益由口径与效率算出（Peak Gain 变为派生只读）。滚降取均匀照射圆口径的解析式 2J₁(u)/u。',
  },
  {
    v: 'two-level', label: '两级带底包络', steerable: true, evidence: 'S',
    needs: ['peakGainDbi', 'beamwidth1Deg', 'gainFloor1Db', 'beamwidth2Deg', 'gainFloor2Db'],
    note: '主瓣外落到第一级底电平，再向外落到第二级。用于厂商只给了「主瓣宽度 + 两级旁瓣包络」的情形。',
  },
]);

/** 由天底角求斜距（km）。射线-球求交：d = r·cosθ − √(Re² − r²sin²θ)。 */
function slantRangeFromNadirAngle(offNadirDeg, altKm) {
  const r = RE_KM + Number(altKm);
  const t = Math.abs(Number(offNadirDeg)) * D2R;
  const s = r * Math.sin(t);
  const disc = RE_KM * RE_KM - s * s;
  if (disc < 0) return null;                       // 射线擦过地平线之外，打不到地球
  return r * Math.cos(t) - Math.sqrt(disc);
}

/** 星下视场半张角（度）：sin ρ = Re / (Re + h)。 */
function earthHalfAngleDeg(altKm) {
  return Math.asin(RE_KM / (RE_KM + Number(altKm))) / D2R;
}

/**
 * 造一个星上方向图求值器。
 * @param {object} p {kind, peakGainDbi?, psibDeg?, section?, Ln?, diameterM?, efficiency?,
 *                    wavelengthM?, beamwidth1Deg?, gainFloor1Db?, beamwidth2Deg?, gainFloor2Db?,
 *                    nullFloorDb?, satHeightKm?}
 * @returns {{kind, steerable, fixedRangeIsAltitude, peakGainDbi, gainDb(deg), warnings, derived}}
 */
function makeSatPattern(p) {
  const kind = String(p.kind || 's1528');
  const meta = SAT_PATTERNS.find((x) => x.v === kind);
  if (!meta) {
    throw new RangeError(`satPatterns: 未知方向图「${kind}」（可选 ${SAT_PATTERNS.map((x) => x.v).join(' / ')}）`);
  }
  const warnings = [];

  // ── 等通量（isoflux）
  //
  // 物理上 isoflux 天线的增益随天底角抬升，恰好补偿斜距增长，使地面 PFD 与天底角无关：
  //     PFD(θ) = EIRP + G(θ) − 10lg(4π·d(θ)²)  ≡ 常数,   其中 G(θ) = G_nadir + 20lg(d(θ)/h)
  //
  // ★ 而 S.1503-4 §C2.3.1 直接规定「isoflux 时 d ≡ 卫星高度」。把这条与上式合起来看，
  //   规范实际上是让计算走【等效形式】：常数增益 G_nadir + 固定距离 h，结果同样是常数 PFD。
  //   两种写法等价，但**不能混用**——若既按天底角抬增益、又把 d 钉死为 h，就是双重补偿，
  //   算出来的 PFD 会随天底角虚假上升整整 20lg(d_max/h)（h=900 km/ε₀=20° 时是 6.7 dB）。
  //   本实现按规范的等效形式：增益取天底值不随角变，距离取 h。
  if (kind === 'isoflux') {
    const gm = Number(p.peakGainDbi);
    const h = Number(p.satHeightKm);
    if (!Number.isFinite(gm)) throw new TypeError('satPatterns/isoflux: 需要 peakGainDbi（天底方向增益）');
    if (!(h > 0)) throw new RangeError('satPatterns/isoflux: 需要 satHeightKm');
    const rho0 = earthHalfAngleDeg(h);
    const dEdge = slantRangeFromNadirAngle(rho0 * 0.999999, h);
    const physicalEdgeLift = dEdge > 0 ? 20 * LOG10(dEdge / h) : 0;
    return {
      kind, steerable: false,
      fixedRangeIsAltitude: true,          // ★ §C2.3.1
      peakGainDbi: gm,
      warnings,
      derived: {
        nadirGainDbi: gm, earthHalfAngleDeg: rho0,
        // 记录物理上的边缘抬升量，供报告说明「等效形式」这一步吃掉了多少
        physicalEdgeLiftDb: physicalEdgeLift,
      },
      gainDb() { return gm; },             // 等效形式：增益不随天底角变，距离已固定为 h
    };
  }

  // ── 全向
  if (kind === 'omni') {
    const gm = Number(p.peakGainDbi);
    if (!Number.isFinite(gm)) throw new TypeError('satPatterns/omni: 需要 peakGainDbi');
    return {
      kind, steerable: false, fixedRangeIsAltitude: false, peakGainDbi: gm, warnings, derived: {},
      gainDb() { return gm; },
    };
  }

  // ── S.1528（三个 recommends 全在 s1528.js 里，本文件只做分派）
  if (kind === 's1528') {
    const sec = String(p.section || '1.2');
    const pat = s1528.makePattern(sec, p);
    warnings.push(...(pat.warnings || []));
    // §1.1：有实测图时应当优先用实测图——这条是建议书本身的次序，不是本平台的偏好
    warnings.push('S.1528 §1.1：有实测方向图时应当优先使用实测图，参考方向图是拿不到实测图时的替代。');
    const gm = Number(p.peakGainDbi);
    return {
      kind, steerable: true, fixedRangeIsAltitude: false, peakGainDbi: gm, warnings,
      derived: pat.derived,
      gainDb: (deg) => (sec === '1.4' ? pat.gainDb(deg, 0) : pat.gainDb(deg)),
    };
  }

  // ── 理论抛物面：均匀照射圆口径 G(ψ) = Gmax + 20lg|2J₁(u)/u|，u = (πD/λ)·sinψ
  if (kind === 'parabolic') {
    const D = Number(p.diameterM), lam = Number(p.wavelengthM);
    const eff = Number(p.efficiency) > 0 ? Number(p.efficiency) : 0.65;
    const floorDb = Number(p.nullFloorDb);
    if (!(D > 0)) throw new RangeError('satPatterns/parabolic: 需要 diameterM');
    if (!(lam > 0)) throw new RangeError('satPatterns/parabolic: 需要 wavelengthM');
    if (!Number.isFinite(floorDb)) {
      throw new TypeError('satPatterns/parabolic: 需要 nullFloorDb —— 解析式在方向图零点会掉到 −∞，'
        + '下界必须由调用方声明（与 S.1528 §1.4 同一处置）');
    }
    // Gmax = 10lg(η·(πD/λ)²)
    const gm = 10 * LOG10(eff * Math.pow(Math.PI * D / lam, 2));
    const k = Math.PI * D / lam;
    return {
      kind, steerable: true, fixedRangeIsAltitude: false, peakGainDbi: gm, warnings,
      derived: { peakGainDbi: gm, dOverLambda: D / lam, efficiency: eff },
      gainDb(deg) {
        const t = Math.abs(Number(deg)) * D2R;
        if (t < 1e-9) return gm;
        const u = k * Math.sin(t);
        if (u < 1e-9) return gm;
        const f = 2 * s1528.besselJ1(u) / u;
        const rel = Math.abs(f) < 1e-12 ? floorDb : Math.max(20 * LOG10(Math.abs(f)), floorDb);
        return gm + rel;
      },
    };
  }

  // ── 两级带底
  if (kind === 'two-level') {
    const gm = Number(p.peakGainDbi);
    const bw1 = Number(p.beamwidth1Deg), bw2 = Number(p.beamwidth2Deg);
    const f1 = Number(p.gainFloor1Db), f2 = Number(p.gainFloor2Db);
    if (!Number.isFinite(gm)) throw new TypeError('satPatterns/two-level: 需要 peakGainDbi');
    if (!(bw1 > 0) || !(bw2 > 0)) throw new RangeError('satPatterns/two-level: 需要 beamwidth1Deg 与 beamwidth2Deg');
    if (!Number.isFinite(f1) || !Number.isFinite(f2)) throw new TypeError('satPatterns/two-level: 需要两级底电平');
    if (!(bw2 > bw1)) warnings.push(`第二级宽度 ${bw2}° 不大于第一级 ${bw1}°，第一级平台为空。`);
    if (f2 > f1) warnings.push(`第二级底电平 ${f2} dB 高于第一级 ${f1} dB，方向图在外层反而抬升，请核对。`);
    // 主瓣按 3 dB 全宽的抛物线，落到第一级底为止（取 max 保证连续且不低于底电平）
    return {
      kind, steerable: true, fixedRangeIsAltitude: false, peakGainDbi: gm, warnings,
      derived: { mainlobeEndDeg: bw1 / 2, firstFloorDbi: gm + f1, secondFloorDbi: gm + f2 },
      gainDb(deg) {
        const t = Math.abs(Number(deg));
        if (t <= bw2 / 2) {
          const main = gm - 3 * Math.pow(2 * t / bw1, 2);
          return Math.max(main, gm + f1);
        }
        return gm + f2;
      },
    };
  }

  throw new RangeError(`satPatterns: 方向图「${kind}」尚未实现`);
}

/** 受支持的方向图 kind 集合。UI 侧的清单在 src/viz/pfd/useMaskWorkbench.js，
 *  两处必须一致——由 test/pfdMask.test.js 的 X 组断言锁住，漂移会被测试抓到。 */
const SUPPORTED_KINDS = Object.freeze(SAT_PATTERNS.map((x) => x.v));

module.exports = {
  SAT_PATTERNS, SUPPORTED_KINDS, makeSatPattern,
  slantRangeFromNadirAngle, earthHalfAngleDeg,
};
