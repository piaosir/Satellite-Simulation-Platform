// 地面业务干扰 · IMT 有源天线（AAS）波束赋形方向图 —— ITU-R M.2101-0（02/2017）附件 1 §5
//
// 用途：IMT-2020（及采用 AAS 的 IMT）基站 / 终端在共用研究 Monte Carlo 里的天线方向图。
// 非 AAS 基站（传统扇区天线）用 f1336.js——M.2101 §5 开头即说 F.1336 只「可能适用于部分 IMT 场景」。
//
// 两种方向图怎么选（§5 正文，不是口味问题）：
//   · 合成方向图（表 4）  带内、相关的发射——各阵元信号受控、同相叠加成窄波束（指向所服务的 UE）。
//                         IMT 作干扰源时的同频干扰、IMT 作被干扰方时落进其信道带宽内的干扰，都用它。
//   · 单元方向图（表 3）  带外 / 杂散 / 互调等非相关发射——各阵元之间不相关，阵列不成束，
//                         等效为单个阵元的方向图。邻频干扰（IMT 为干扰源的无用发射、IMT 为被干扰方的
//                         邻道干扰）用它。makeAas 的 elementGain 即此口径。
//
// ─────────────────────────────────────────────────────────────────────────────
// 坐标（图 10）
//   阵元均布在 yz 平面、法向（最大辐射方向）沿 +x；z 为面板竖直轴。
//   θ  自 +z 轴起算 0°…180°（M.2101 称 elevation，实为极角：0° 天顶、90° 面板法向/水平、180° 天底）
//   φ  自 +x 轴向 +y 起算 −180°…180°（入参超出按三角函数自然折回）
//   注意与 F.1336 的仰角口径不同：θ_M2101 = 90° − θ_F1336。
//   参数次序随表 4：A(θ, φ)。
//
// 符号约定——由表 4 原式推出，m2101.test.mjs 数值验证：
//   w_{i,n,m}·v_{n,m} 的相位 = 2π[(n−1)(dV/λ)(cosθ + sinθetilt) + (m−1)(dH/λ)(sinθ·sinφ − cosθetilt·sinφescan)]
//   全阵同相 ⇔ cosθ = −sinθetilt 且 sinθ·sinφ = cosθetilt·sinφescan ⇔ θ = 90° + θetilt、φ = φescan。
//   故 θetilt 即电下倾角：正值把波束压到面板法向以下。
//   指向面板坐标里任一方向 (θ0, φ0)：θetilt = θ0 − 90°，φescan = φ0（steeringFor）。
//   阵因子只含 cosθ 与 sinθ·sinφ，对 φ ↔ 180° − φ 前后对称；背面靠单元方向图（Am）压下去。
//
// 机械下倾（表 4 列为输入参数，但未给公式）：
//   按面板绕自身水平 y 轴下压 β 处理（β > 0 = 面板法向压到水平面以下），与 F.1336-5 附件 5 式 (40)(41) 同一几何。
//   全局坐标：z 当地垂直向上，x 为面板方位法向在水平面上的投影（面板方位角由调用方先扣掉），y 水平。
//   全局单位矢量 u = (sinθ·cosφ, sinθ·sinφ, cosθ) → 面板系：
//     x' = ux·cosβ − uz·sinβ，y' = uy，z' = ux·sinβ + uz·cosβ
//   面板法向 (θp, φp) = (90°, 0°) 在全局里是 θ = 90° + β（水平面以下 β），φ = 0。
//   单元方向图与阵因子都在面板系里算；波束（etilt / escan）也是面板系的量。
//
// 快算（Monte Carlo 热路径）：
//   ΣmΣn w·v 可分离为垂直、水平两条等比级数之积：
//     ΣΣ = (1/√(NH·NV)) · Σn e^{j(n−1)ψV} · Σm e^{j(m−1)ψH}
//     ψV = 2π(dV/λ)(cosθ + sinθetilt)，ψH = 2π(dH/λ)(sinθ·sinφ − cosθetilt·sinφescan)
//   且 |Σ_{k=0}^{N−1} e^{jkψ}|² = sin²(Nψ/2)/sin²(ψ/2)（Dirichlet 核，ψ ≡ 0 (mod 2π) 处取极限 N²）。
//   这是代数恒等，不是近似；m2101.test.mjs 对随机方向逐点比 'brute'（逐元双重求和）到 1e-9 dB。
//   每个方向只需 4 次 sin（加坐标变换），与阵元数无关。
//
// 不做的事（建议书原式之外、属引擎层）：
//   · 原式之外的任何阵列增益归一化——本模块按 M.2101-0 原式，合成峰值 = A_E + 10lg(NH·NV)（未计互耦、效率）
//   · 波束扫描范围限制、多波束的功率分配与合成
//
// 波束对象：{ etiltDeg, escanDeg, bV, bH }，bV / bH 为权值相位的每阵元步进（与阵列尺寸无关，可跨面板复用）。
// steeringFor / makeAas.beam / makeAas.beamTo 都返回它；makeAas 的方法也接受只有 { etiltDeg, escanDeg } 的普通对象。
//
// 返回值与出错口径：增益 dBi（number）；严格零点处为 −Infinity（10lg 0）。
// 非法输入一律返回 { error: '中文原因' }（与 f1336.js / p452.js 一致），调用方写 `if (g.error)`。
// 唯一例外：热路径积木 dirichletSq(N, ψ) 不校验，调用方保证 N 为正整数、ψ 为有限数。
//
// 权威依据：ITU-R M.2101-0 官方 PDF §5 表 3、表 4 逐式核对（权值式字号很小，按 400 dpi 渲染复核），未凭记忆。
// 纯函数、无依赖，CommonJS。

const LOG10 = Math.log10;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const TWO_PI = 2 * Math.PI;
const ANG_TOL = 1e-9;          // 角度容差（度）

const fail = (msg) => ({ error: msg });
const optNum = (v, dflt) => (v == null ? dflt : Number(v));

// ---------------------------------------------------------------------------
// 入参校验
// ---------------------------------------------------------------------------

// 表 3 的单元参数：GEmax（dBi）、phi3dB / theta3dB（度）、Am / SLAv（dB）
function checkElement(o) {
  const GEmax = Number(o.GEmax), phi3dB = Number(o.phi3dB), theta3dB = Number(o.theta3dB);
  const Am = Number(o.Am), SLAv = Number(o.SLAv);
  if (!Number.isFinite(GEmax)) return fail('G_E,max 须为有限数（dBi）');
  if (!(phi3dB > 0) || !Number.isFinite(phi3dB)) return fail('φ3dB 须为正数（度）');
  if (!(theta3dB > 0) || !Number.isFinite(theta3dB)) return fail('θ3dB 须为正数（度）');
  if (!(Am >= 0) || !Number.isFinite(Am)) return fail('Am 须 ≥ 0（dB）');
  if (!(SLAv >= 0) || !Number.isFinite(SLAv)) return fail('SLAv 须 ≥ 0（dB）');
  return { GEmax, phi3dB, theta3dB, Am, SLAv };
}

// 表 4 的阵列参数：NH（列数）、NV（行数）、dH / dV（阵元间距，以波长计 d/λ）
function checkArray(o) {
  const NH = Number(o.NH), NV = Number(o.NV), dH = Number(o.dH), dV = Number(o.dV);
  if (!Number.isInteger(NH) || NH < 1) return fail('NH 须为正整数');
  if (!Number.isInteger(NV) || NV < 1) return fail('NV 须为正整数');
  if (!(dH > 0) || !Number.isFinite(dH)) return fail('dH 须为正数（d/λ）');
  if (!(dV > 0) || !Number.isFinite(dV)) return fail('dV 须为正数（d/λ）');
  return { NH, NV, dH, dV };
}

// θ ∈ [0, 180]（容差内钳住）；越界返回 NaN
function normTheta(t) {
  if (!Number.isFinite(t)) return NaN;
  if (t < 0) return t >= -ANG_TOL ? 0 : NaN;
  if (t > 180) return t <= 180 + ANG_TOL ? 180 : NaN;
  return t;
}

// ---------------------------------------------------------------------------
// §5.1 表 3 · 单元方向图
// ---------------------------------------------------------------------------

/** 表 3 水平方向图 A_E,H(φ) = −min[12(φ/φ3dB)², Am]（dB，≤ 0）。|φ| = φ3dB·√(Am/12) 处转平。φ 取 −180…180。 */
function elementH(phiDeg, phi3dB, Am) {
  const p = Number(phiDeg), w = Number(phi3dB), a = Number(Am);
  if (!Number.isFinite(p)) return fail('φ 须为有限数');
  if (!(w > 0) || !Number.isFinite(w)) return fail('φ3dB 须为正数（度）');
  if (!(a >= 0) || !Number.isFinite(a)) return fail('Am 须 ≥ 0（dB）');
  const r = p / w;
  return -Math.min(12 * r * r, a);
}

/** 表 3 垂直方向图 A_E,V(θ) = −min[12((θ − 90)/θ3dB)², SLAv]（dB，≤ 0）。|θ − 90| = θ3dB·√(SLAv/12) 处转平。 */
function elementV(thetaDeg, theta3dB, SLAv) {
  const t = normTheta(Number(thetaDeg)), w = Number(theta3dB), a = Number(SLAv);
  if (Number.isNaN(t)) return fail('θ 须在 0°…180°');
  if (!(w > 0) || !Number.isFinite(w)) return fail('θ3dB 须为正数（度）');
  if (!(a >= 0) || !Number.isFinite(a)) return fail('SLAv 须 ≥ 0（dB）');
  const r = (t - 90) / w;
  return -Math.min(12 * r * r, a);
}

// 表 3 单元方向图本体（不校验）：A_E = G_E,max − min{−[A_E,H(φ) + A_E,V(θ)], Am}
function elementCore(thetaDeg, phiDeg, E) {
  const rh = phiDeg / E.phi3dB, rv = (thetaDeg - 90) / E.theta3dB;
  const aH = Math.min(12 * rh * rh, E.Am);       // −A_E,H
  const aV = Math.min(12 * rv * rv, E.SLAv);     // −A_E,V
  const s = aH + aV;
  return E.GEmax - (s < E.Am ? s : E.Am);
}

/**
 * 单元方向图 A_E(θ, φ)（dBi），面板坐标。表 3：A_E = G_E,max − min{−[A_E,H(φ) + A_E,V(θ)], Am}。
 * 峰值 G_E,max 在 (θ, φ) = (90°, 0°)；总衰减封顶 Am（底板 G_E,max − Am）。
 * @param {number} thetaDeg  0…180
 * @param {number} phiDeg
 * @param {{GEmax, phi3dB, theta3dB, Am, SLAv}} el
 */
function elementGain(thetaDeg, phiDeg, el) {
  const E = checkElement(el || {});
  if (E.error) return E;
  const t = normTheta(Number(thetaDeg));
  const p = Number(phiDeg);
  if (Number.isNaN(t)) return fail('θ 须在 0°…180°');
  if (!Number.isFinite(p)) return fail('φ 须为有限数');
  // φ 折回 [−180, 180]：A_E,H 用的是 φ 本身（不是三角函数），必须先折
  const pw = p >= -180 && p <= 180 ? p : ((p + 180) % 360 + 360) % 360 - 180;
  return elementCore(t, pw, E);
}

// ---------------------------------------------------------------------------
// §5.2 表 4 · 阵因子与合成方向图
// ---------------------------------------------------------------------------

/**
 * 等比级数功率 |Σ_{k=0}^{N−1} e^{jkψ}|² = sin²(Nψ/2) / sin²(ψ/2)（Dirichlet 核）。
 * 先把 ψ 规约到 [−π, π]（|·|² 以 2π 为周期），这样主瓣与栅瓣峰附近都不会出现大数相消；
 * |δ| < 1e-9 时用极限展开 N²(1 − (N² − 1)δ²/12)，避开 0/0。
 */
function dirichletSq(N, psi) {
  if (N === 1) return 1;
  const d = psi - TWO_PI * Math.round(psi / TWO_PI);
  if (Math.abs(d) < 1e-9) {
    const n2 = N * N;
    return n2 * (1 - (n2 - 1) * d * d / 12);
  }
  const s = Math.sin(0.5 * d), t = Math.sin(0.5 * N * d);
  return (t * t) / (s * s);
}

// 波束常数：权值相位的两个每阵元步进量（面板系）
function beamConsts(etiltDeg, escanDeg) {
  const et = etiltDeg * D2R, es = escanDeg * D2R;
  return {
    etiltDeg, escanDeg,
    bV: Math.sin(et),                  // 表 4 权值：(n−1)(dV/λ)·sinθetilt
    bH: Math.cos(et) * Math.sin(es)    // 表 4 权值：−(m−1)(dH/λ)·cosθetilt·sinφescan
  };
}

// 阵因子（线性）快算：cz = cosθ，sy = sinθ·sinφ（面板系），A 含 kV = 2π·dV、kH = 2π·dH、invN = 1/(NH·NV)
function afClosedLin(cz, sy, A, b) {
  const psiV = A.kV * (cz + b.bV);
  const psiH = A.kH * (sy - b.bH);
  return dirichletSq(A.NV, psiV) * dirichletSq(A.NH, psiH) * A.invN;
}

// 阵因子（线性）逐元双重求和：表 4 原式照抄，复数手写 re/im。仅供核对，O(NH·NV)。
function afBruteLin(thetaDeg, phiDeg, A, etiltDeg, escanDeg) {
  const th = thetaDeg * D2R, ph = phiDeg * D2R;
  const ct = Math.cos(th), sts = Math.sin(th) * Math.sin(ph);
  const et = etiltDeg * D2R, es = escanDeg * D2R;
  const se = Math.sin(et), ces = Math.cos(et) * Math.sin(es);
  const norm = 1 / Math.sqrt(A.NH * A.NV);
  let re = 0, im = 0;
  for (let m = 1; m <= A.NH; m++) {
    for (let n = 1; n <= A.NV; n++) {
      // 叠加矢量 v_{n,m} = exp(j·2π((n−1)(dV/λ)cosθ + (m−1)(dH/λ)sinθ·sinφ))
      const pv = TWO_PI * ((n - 1) * A.dV * ct + (m - 1) * A.dH * sts);
      // 权值 w_{i,n,m} = (1/√(NH·NV))·exp(j·2π((n−1)(dV/λ)sinθetilt − (m−1)(dH/λ)cosθetilt·sinφescan))
      const pw = TWO_PI * ((n - 1) * A.dV * se - (m - 1) * A.dH * ces);
      const vr = Math.cos(pv), vi = Math.sin(pv);
      const wr = norm * Math.cos(pw), wi = norm * Math.sin(pw);
      re += wr * vr - wi * vi;
      im += wr * vi + wi * vr;
    }
  }
  return re * re + im * im;
}

function prepArray(A) {
  return { ...A, kV: TWO_PI * A.dV, kH: TWO_PI * A.dH, invN: 1 / (A.NH * A.NV) };
}

/**
 * 阵因子 10·lg|ΣmΣn w_{i,n,m}·v_{n,m}|²（dB），面板坐标。波束正指处 = 10lg(NH·NV)。
 * @param {number} thetaDeg, phiDeg
 * @param {{NH, NV, dH, dV, etiltDeg?, escanDeg?}} cfg   dH / dV 以波长计（d/λ）；etilt / escan 缺省 0
 * @param {'closed'|'brute'} [method='closed']   'closed' = 可分离 Dirichlet 闭式；'brute' = 逐元双重求和（核对用）
 */
function arrayFactorDb(thetaDeg, phiDeg, cfg, method) {
  const c = cfg || {};
  const A0 = checkArray(c);
  if (A0.error) return A0;
  const et = optNum(c.etiltDeg, 0), es = optNum(c.escanDeg, 0);
  if (!Number.isFinite(et) || !Number.isFinite(es)) return fail('θetilt / φescan 须为有限数');
  const t = normTheta(Number(thetaDeg));
  const p = Number(phiDeg);
  if (Number.isNaN(t)) return fail('θ 须在 0°…180°');
  if (!Number.isFinite(p)) return fail('φ 须为有限数');
  const A = prepArray(A0);
  if (method === 'brute') return 10 * LOG10(afBruteLin(t, p, A, et, es));
  if (method != null && method !== 'closed') return fail("method 只认 'closed' / 'brute'");
  const th = t * D2R;
  return 10 * LOG10(afClosedLin(Math.cos(th), Math.sin(th) * Math.sin(p * D2R), A, beamConsts(et, es)));
}

/**
 * 合成方向图 A_A,Beam_i(θ, φ) = A_E(θ, φ) + 10lg|ΣmΣn w·v|²（dBi），面板坐标。表 4。
 * @param {number} thetaDeg, phiDeg
 * @param {object} cfg  { GEmax, phi3dB, theta3dB, Am, SLAv, NH, NV, dH, dV, etiltDeg?, escanDeg?, method? }
 */
function compositeGain(thetaDeg, phiDeg, cfg) {
  const c = cfg || {};
  const ae = elementGain(thetaDeg, phiDeg, c);
  if (ae.error) return ae;
  const af = arrayFactorDb(thetaDeg, phiDeg, c, c.method);
  if (af.error) return af;
  return ae + af;
}

/**
 * 指向面板坐标里的方向 (θ0, φ0) 所需的波束：θetilt = θ0 − 90°，φescan = φ0（符号推导见头注）。
 * @returns {{etiltDeg:number, escanDeg:number, bV:number, bH:number}|{error}}  波束对象，可直接传给 makeAas 的方法
 */
function steeringFor(thetaDeg, phiDeg) {
  const t = normTheta(Number(thetaDeg));
  const p = Number(phiDeg);
  if (Number.isNaN(t)) return fail('θ 须在 0°…180°');
  if (!Number.isFinite(p)) return fail('φ 须为有限数');
  return beamConsts(t - 90, p);
}

// 波束入参规整：缺省用 dflt；完整波束对象原样用；只有 { etiltDeg, escanDeg } 的普通对象补算 bV / bH
function asBeam(b, dflt) {
  if (b == null) return dflt;
  if (b.error) return b;
  if (typeof b.bV === 'number' && typeof b.bH === 'number') return b;
  const et = Number(b.etiltDeg), es = Number(b.escanDeg);
  if (!Number.isFinite(et) || !Number.isFinite(es)) return fail('θetilt / φescan 须为有限数');
  return beamConsts(et, es);
}

// ---------------------------------------------------------------------------
// 机械下倾：全局 ↔ 面板（绕面板水平 y 轴，见头注）
// ---------------------------------------------------------------------------

function rotate(thetaDeg, phiDeg, betaDeg, inverse) {
  const t = normTheta(Number(thetaDeg));
  const p = Number(phiDeg), b = Number(betaDeg);
  if (Number.isNaN(t)) return fail('θ 须在 0°…180°');
  if (!Number.isFinite(p)) return fail('φ 须为有限数');
  if (!(Math.abs(b) < 90)) return fail('机械下倾须在 (−90°, 90°)');
  const th = t * D2R, ph = p * D2R, bb = b * D2R;
  const cb = Math.cos(bb), sb = inverse ? -Math.sin(bb) : Math.sin(bb);
  const st = Math.sin(th);
  const ux = st * Math.cos(ph), uy = st * Math.sin(ph), uz = Math.cos(th);
  const x = ux * cb - uz * sb, z = ux * sb + uz * cb;     // 绕 y 轴转 β（逆变换转 −β）
  return { thetaDeg: Math.atan2(Math.sqrt(x * x + uy * uy), z) * R2D, phiDeg: Math.atan2(uy, x) * R2D };
}

/**
 * 全局方向 → 面板坐标（机械下倾 β，向下为正）。x' = ux·cosβ − uz·sinβ，y' = uy，z' = ux·sinβ + uz·cosβ。
 * 与 F.1336-5 式 (3b)(3c) 同一变换（换算 θ_F1336 = 90° − θ）。
 * @returns {{thetaDeg, phiDeg}|{error}}
 */
function globalToPanel(thetaDeg, phiDeg, mechTiltDeg) {
  return rotate(thetaDeg, phiDeg, mechTiltDeg, false);
}

/** globalToPanel 的逆变换：面板坐标 → 全局方向。 */
function panelToGlobal(thetaDeg, phiDeg, mechTiltDeg) {
  return rotate(thetaDeg, phiDeg, mechTiltDeg, true);
}

// ---------------------------------------------------------------------------
// 预解析版：一副面板、多个波束、海量方向
// ---------------------------------------------------------------------------

/**
 * AAS 面板预解析。
 * @param {object} opts
 * @param {number} opts.GEmax, opts.phi3dB, opts.theta3dB, opts.Am, opts.SLAv   表 3 单元参数
 * @param {number} opts.NH, opts.NV        阵列列数、行数（表 4「Row × Column」= NV × NH）
 * @param {number} opts.dH, opts.dV        阵元间距（d/λ）
 * @param {number} [opts.mechTiltDeg=0]    面板机械下倾 β（向下为正）
 * @param {number} [opts.etiltDeg=0], [opts.escanDeg=0]   缺省波束（面板系）；gain 不传 beam 时用它
 * @returns {object|{error}} {
 *   element, array, mechTiltDeg, peakGainDb（= G_E,max + 10lg(NH·NV)，波束正指面板法向时的峰值）, defaultBeam,
 *   beam(etiltDeg, escanDeg)        → 波束对象（面板系转向参数）
 *   beamTo(thetaDeg, phiDeg)        → 指向全局方向的波束对象（先换到面板系，再取 θetilt = θp − 90°、φescan = φp）
 *   gain(thetaDeg, phiDeg, beam?)   → 合成增益 dBi（全局方向；beam 缺省 defaultBeam）——带内 / 相关发射
 *   elementGain(thetaDeg, phiDeg)   → 单元增益 dBi（全局方向）——带外 / 非相关发射
 *   arrayFactorDb(thetaDeg, phiDeg, beam?, method?) → 阵因子 dB（全局方向）
 *   toPanel(thetaDeg, phiDeg)       → 面板坐标
 * }
 */
function makeAas(opts) {
  const o = opts || {};
  const E = checkElement(o);
  if (E.error) return E;
  const A0 = checkArray(o);
  if (A0.error) return A0;
  const A = prepArray(A0);
  const mech = optNum(o.mechTiltDeg, 0);
  if (!(Math.abs(mech) < 90)) return fail('机械下倾须在 (−90°, 90°)');
  const tilted = mech !== 0;
  const cb = Math.cos(mech * D2R), sb = Math.sin(mech * D2R);

  function mkBeam(etiltDeg, escanDeg) {
    const et = Number(etiltDeg), es = Number(escanDeg);
    if (!Number.isFinite(et) || !Number.isFinite(es)) return fail('θetilt / φescan 须为有限数');
    return beamConsts(et, es);
  }
  const defaultBeam = mkBeam(optNum(o.etiltDeg, 0), optNum(o.escanDeg, 0));
  if (defaultBeam.error) return defaultBeam;

  // 全局方向 → 面板系单位矢量 [x', y', z']；θ 越界返回 null
  function panelVec(thetaDeg, phiDeg) {
    const t = normTheta(Number(thetaDeg));
    const p = Number(phiDeg);
    if (Number.isNaN(t) || !Number.isFinite(p)) return null;
    const th = t * D2R, ph = p * D2R;
    const st = Math.sin(th), uz = Math.cos(th);
    const ux = st * Math.cos(ph), uy = st * Math.sin(ph);
    if (!tilted) return [ux, uy, uz];
    return [ux * cb - uz * sb, uy, ux * sb + uz * cb];
  }
  const vecTheta = (v) => Math.atan2(Math.sqrt(v[0] * v[0] + v[1] * v[1]), v[2]) * R2D;
  const vecPhi = (v) => Math.atan2(v[1], v[0]) * R2D;
  const BAD_DIR = 'θ 须在 0°…180°、φ 须为有限数';

  return {
    pattern: 'M.2101-0 §5', element: E, array: A0, mechTiltDeg: mech,
    peakGainDb: E.GEmax + 10 * LOG10(A0.NH * A0.NV),
    defaultBeam,
    beam: mkBeam,
    beamTo(thetaDeg, phiDeg) {
      const v = panelVec(thetaDeg, phiDeg);
      if (!v) return fail(BAD_DIR);
      return beamConsts(vecTheta(v) - 90, vecPhi(v));
    },
    gain(thetaDeg, phiDeg, beam) {
      const b = asBeam(beam, defaultBeam);
      if (b.error) return b;
      const v = panelVec(thetaDeg, phiDeg);
      if (!v) return fail(BAD_DIR);
      // 面板系里：cosθp = z'，sinθp·sinφp = y'——阵因子直接吃方向余弦，不必再取三角函数
      const ae = elementCore(vecTheta(v), vecPhi(v), E);
      return ae + 10 * LOG10(afClosedLin(v[2], v[1], A, b));
    },
    elementGain(thetaDeg, phiDeg) {
      const v = panelVec(thetaDeg, phiDeg);
      if (!v) return fail(BAD_DIR);
      return elementCore(vecTheta(v), vecPhi(v), E);
    },
    arrayFactorDb(thetaDeg, phiDeg, beam, method) {
      const b = asBeam(beam, defaultBeam);
      if (b.error) return b;
      const v = panelVec(thetaDeg, phiDeg);
      if (!v) return fail(BAD_DIR);
      if (method === 'brute') return 10 * LOG10(afBruteLin(vecTheta(v), vecPhi(v), A, b.etiltDeg, b.escanDeg));
      if (method != null && method !== 'closed') return fail("method 只认 'closed' / 'brute'");
      return 10 * LOG10(afClosedLin(v[2], v[1], A, b));
    },
    toPanel(thetaDeg, phiDeg) {
      const v = panelVec(thetaDeg, phiDeg);
      if (!v) return fail(BAD_DIR);
      return { thetaDeg: vecTheta(v), phiDeg: vecPhi(v) };
    }
  };
}

module.exports = {
  // 表 3 单元方向图
  elementH, elementV, elementGain,
  // 表 4 阵因子 / 合成方向图
  dirichletSq, arrayFactorDb, compositeGain, steeringFor,
  // 机械下倾
  globalToPanel, panelToGlobal,
  // 预解析
  makeAas
};
