// PFD Mask · ITU-R S.1528 非 GSO 卫星天线参考方向图
//
// S.1528「Satellite antenna radiation patterns for non-geostationary orbit satellite antennas
// operating in the fixed-satellite service below 30 GHz」(2001)，至今仍是唯一版本。
//
// 它只用在 mask 的【生成侧】。BR 的核查侧不用它——S.1503-4 全文检索 "1528" 零命中，
// 核查侧用的是 S.1428（FSS 地球站收）、BO.1443（BSS 地球站收）、S.672（GSO 卫星）。
// 所以本文件属于「方向图库层」，与 GRD 模块同层，不进 mask 的核查路径。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据：ITU-R S.1528 (2001) 正文逐段核对，非凭记忆。三个 recommends 全部实现。
// 原文自带算例已用作 golden test（Annex 1 的 MEO/LEO/S.672 三例、Annex 2 的 A 与 σ）。
//
// ★ 两处必须写明的原文问题：
//
//   [1] §1.4 的 σ 分子，原文印作 J₀(l)，是笔误。本实现用 μ_l。
//       用 ITU 自带的 Annex 2 数据双向验证（SLR=20 dB、l=4 ⇒ 原文印 A=0.95277、σ=1.1692）：
//         走 μ₄：4.2410629 / √(0.9077662+3.5²) = 4.2410629 / 3.6273635 = 1.1691876  ✓ 对上
//         走 J₀(4)：−0.3971498 / 3.6273635 = −0.1094900               ✗ 差了一个数量级且反号
//       且 σ 在 Taylor 综合里的标准定义就是展宽因子 σ = μ_n̄ / √(A² + (n̄−½)²)，
//       与 μ_l 的读法一致。照抄原文的 J₀(l) 会得到完全错误的方向图。
//
//   [2] §1.3 只写了 "For D/λ < 35"，D/λ ≥ 35 的形式原文【没有给】。
//       这是规范的空缺，不是本实现的偷懒。默认对 D/λ ≥ 35 抛异常，
//       调用方可显式选择外推口径并自负其责（口径会随 mask 一起打印）。
//
// ★ 一处与 PMGT 界面的映射歧义（未证实，必须由 UI 层显式处理）：
//       PMGT 屏3 的 "Beamwidth 1 (deg) = 2.0" 配 "Peak Gain = 32 dBi"。
//       若 Beamwidth1 读作【半波束宽 ψb】：D/λ = √1200/2 = 17.32 ⇒ Gm ≈ 32.1~32.8 dBi（η=0.55~0.65）✓ 自洽
//       若读作【3 dB 全宽】（ψb = 1°）：D/λ = 34.64 ⇒ Gm ≈ 38.9 dBi ✗ 与 32 差 6.9 dB
//       ⇒ 截图那组默认值只在「Beamwidth1 = ψb」的读法下自洽。但两个量是独立输入，
//         用户本可以填不自洽的值，所以这不是铁证。
//       ⇒ 本模块一律收 psibDeg（明确是 S.1528 定义的半波束宽），歧义不进引擎；
//         UI 层若要提供 "Beamwidth 1" 标签，须显式声明它映射到哪个量并标注未证实。
// ─────────────────────────────────────────────────────────────────────────────

const LOG10 = Math.log10;

// ---------------------------------------------------------------------------
// Bessel 函数（§1.4 用）
// ---------------------------------------------------------------------------

/** 第一类零阶 Bessel 函数 J₀(x)。Numerical Recipes 多项式近似，相对精度 ~1e-8。 */
function besselJ0(x) {
  const ax = Math.abs(x);
  if (ax < 8.0) {
    const y = x * x;
    const ans1 = 57568490574.0 + y * (-13362590354.0 + y * (651619640.7
      + y * (-11214424.18 + y * (77392.33017 + y * (-184.9052456)))));
    const ans2 = 57568490411.0 + y * (1029532985.0 + y * (9494680.718
      + y * (59272.64853 + y * (267.8532712 + y * 1.0))));
    return ans1 / ans2;
  }
  const z = 8.0 / ax, y = z * z, xx = ax - 0.785398164;
  const p = 1.0 + y * (-0.1098628627e-2 + y * (0.2734510407e-4
    + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
  const q = -0.1562499995e-1 + y * (0.1430488765e-3
    + y * (-0.6911147651e-5 + y * (0.7621095161e-6 + y * (-0.934935152e-7))));
  return Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q);
}

/** 第一类一阶 Bessel 函数 J₁(x)。Numerical Recipes 多项式近似，相对精度 ~1e-8。 */
function besselJ1(x) {
  const ax = Math.abs(x);
  let ans;
  if (ax < 8.0) {
    const y = x * x;
    const ans1 = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1
      + y * (-2972611.439 + y * (15704.48260 + y * (-30.16036606))))));
    const ans2 = 144725228442.0 + y * (2300535178.0 + y * (18583304.74
      + y * (99447.43394 + y * (376.9991397 + y * 1.0))));
    ans = ans1 / ans2;
  } else {
    const z = 8.0 / ax, y = z * z, xx = ax - 2.356194491;
    const p = 1.0 + y * (0.183105e-2 + y * (-0.3516396496e-4
      + y * (0.2457520174e-5 + y * (-0.240337019e-6))));
    const q = 0.04687499995 + y * (-0.2002690873e-3
      + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
    ans = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q);
    if (x < 0.0) ans = -ans;
  }
  return ans;
}

/**
 * J₁ 的前若干个非零根除以 π —— 即 §1.4 的 μ₁, μ₂, μ₃…
 * 原文 Annex 2 印的 μ₁=1.2, μ₂=2.233, μ₃=3.238，与本表前三项一致（原文首项取了两位）。
 */
const MU = Object.freeze([
  1.2196698912665045,   // j₁,₁ = 3.8317059702075123 / π
  2.2331305943751833,   // j₁,₂ = 7.015586669815619  / π
  3.2383154841662722,   // j₁,₃ = 10.173468135062722 / π
  4.2410628637366407,   // j₁,₄ = 13.323691936314223 / π
  5.2427643004232599,   // j₁,₅ = 16.470630050877633 / π
  6.2438898567134498,   // j₁,₆ = 19.615858510468243 / π
  7.2447716841768900,   // j₁,₇ = 22.760084380592772 / π
  8.2452441963612646,   // j₁,₈ = 25.903672087618382 / π
]);

// ---------------------------------------------------------------------------
// §1.2 —— LN 型包络（Table 1）
// ---------------------------------------------------------------------------

/**
 * S.1528 Table 1。a = 2.58·√(1 − c·lg z)，b 与 α 四档相同。
 *
 * ⚠ 原文 NOTE 1：整张 Table 1 的 a、α 是 **provisional**，椭圆波束需实验验证；
 *   且 LN = −30 dB 一档的 a、α 原文明说 "require further study"。
 *   ⇒ z ≠ 1（椭圆）与 LN = −30 两种情况，调用方须知道自己在用暂定值。
 */
const LN_TABLE = Object.freeze({
  '-15': { c: 1.4, b: 6.32, alpha: 1.5, provisional: false },
  '-20': { c: 1.0, b: 6.32, alpha: 1.5, provisional: false },
  '-25': { c: 0.6, b: 6.32, alpha: 1.5, provisional: false },
  '-30': { c: 0.4, b: 6.32, alpha: 1.5, provisional: true },   // 原文：requires further study
});

const LN_VALUES = Object.freeze([-15, -20, -25, -30]);

/**
 * 由口径反推半波束宽 ψb（度）：ψb = √1200 / (D/λ)。
 *
 * √1200 = 34.641，与经典的「3 dB 全宽 ≈ 70λ/D、半宽 ≈ 35λ/D」吻合，
 * 可作为本式确为半宽的旁证（原文该处 PDF 取字混乱，此处按 √1200 实现）。
 *
 * @param {number} dOverLambda D/λ（λ 取【频段下边沿】波长——原文明写 lowest band edge）
 * @param {number} [axisRatioZ=1] z = major/minor。给 >1 时返回 major axis 的 ψb。
 */
function psibFromAperture(dOverLambda, axisRatioZ) {
  const r = Number(dOverLambda);
  if (!(r > 0)) throw new RangeError(`s1528.psibFromAperture: D/λ 必须为正（${dOverLambda}）`);
  const z = axisRatioZ === undefined ? 1 : Number(axisRatioZ);
  if (!(z > 0)) throw new RangeError(`s1528.psibFromAperture: z 必须为正（${axisRatioZ}）`);
  return z * Math.sqrt(1200) / r;
}

/** 3 dB 全宽 → ψb（半宽）。UI 层若把 "Beamwidth" 解释为全宽，用这个转，别在引擎里猜。 */
function psibFromFullBeamwidth(fullBeamwidthDeg) {
  const w = Number(fullBeamwidthDeg);
  if (!(w > 0)) throw new RangeError(`s1528.psibFromFullBeamwidth: 波束宽必须为正（${fullBeamwidthDeg}）`);
  return w / 2;
}

/**
 * §1.2 的全部派生量。单独导出是为了让每个中间数都能被单测钉住、被算式树展开。
 *
 * @param {object} p
 * @param {number} p.peakGainDbi  Gm，主瓣最大增益（dBi）
 * @param {number} p.psibDeg      ψb，**半个** 3 dB 波束宽（度）
 * @param {-15|-20|-25|-30} p.Ln  近旁瓣电平（dB，相对峰值）
 * @param {number} [p.axisRatioZ=1] z = major/minor axis
 * @param {number} [p.farOutDbi=0]  LF，远旁瓣电平（dBi）。原文正文写 "0 dBi"
 * @returns {{a,b,alpha,c,z,psib,Gm,Ln,LF,LB,X,Y,seg1End,seg2aEnd,seg2bEnd,
 *            mainlobeEndGain,nearSidelobeGain,stepAtA,provisional,warnings:string[]}}
 */
function derivedS1528_12(p) {
  const Gm = Number(p.peakGainDbi);
  const psib = Number(p.psibDeg);
  const z = p.axisRatioZ === undefined ? 1 : Number(p.axisRatioZ);
  const LF = p.farOutDbi === undefined ? 0 : Number(p.farOutDbi);
  const LnNum = Number(p.Ln);

  if (!Number.isFinite(Gm)) throw new TypeError(`s1528 §1.2: peakGainDbi 非有限数（${p.peakGainDbi}）`);
  if (!(psib > 0)) throw new RangeError(`s1528 §1.2: psibDeg 必须为正（${p.psibDeg}）`);
  if (!(z > 0)) throw new RangeError(`s1528 §1.2: axisRatioZ 必须为正（${p.axisRatioZ}）`);
  if (!Number.isFinite(LF)) throw new TypeError(`s1528 §1.2: farOutDbi 非有限数（${p.farOutDbi}）`);

  const key = String(LnNum);
  const row = LN_TABLE[key];
  if (!row) {
    throw new RangeError(
      `s1528 §1.2: Ln 只能取 ${LN_VALUES.join(' / ')} dB（Table 1 只给了这四档），收到 ${p.Ln}。` +
      `其它取值需要插值，而 Table 1 的 a、α 本身是 provisional，插值无依据。`
    );
  }

  const warnings = [];
  if (row.provisional) {
    warnings.push('Ln = −30 dB 一档的 a 与 α，原文明写 "require further study"，是待细化的暂定值。');
  }
  if (z !== 1) {
    warnings.push('z ≠ 1（椭圆波束）：原文 NOTE 1 声明椭圆波束的方向图需实验验证，Table 1 的 a、α 为暂定值。');
  }

  // a = 2.58·√(1 − c·lg z)
  const inner = 1 - row.c * LOG10(z);
  if (!(inner > 0)) {
    throw new RangeError(
      `s1528 §1.2: z = ${z} 使 1 − c·lg z = ${inner.toFixed(6)} ≤ 0（c = ${row.c}），a 无定义。` +
      `Ln = ${LnNum} dB 时 z 的上界为 10^(1/${row.c}) ≈ ${Math.pow(10, 1 / row.c).toFixed(3)}。`
    );
  }
  const a = 2.58 * Math.sqrt(inner);
  const b = row.b, alpha = row.alpha;

  // LB = max(15 + LN + 0.25·Gm + 5·lg z, 0)   —— 原文 "or 0 dBi, whichever is higher"
  const LB = Math.max(15 + LnNum + 0.25 * Gm + 5 * LOG10(z), 0);

  const seg1End = a * psib;                 // (1) 的上界
  const seg2aEnd = 0.5 * b * psib;          // (2a) 的上界
  const seg2bEnd = b * psib;                // (2b) 的上界
  const X = Gm + LnNum + 25 * LOG10(seg2bEnd);
  const Y = seg2bEnd * Math.pow(10, 0.04 * (Gm + LnNum - LF));

  const mainlobeEndGain = Gm - 3 * Math.pow(a, alpha);       // (1) 在 ψ = a·ψb 处
  const nearSidelobeGain = Gm + LnNum + 20 * LOG10(z);       // (2a) 的电平
  const stepAtA = mainlobeEndGain - nearSidelobeGain;        // 正数 = 向下跌落

  // z 大到让 (2a) 反超主瓣段末端时，方向图在 a·ψb 处向【上】跳，是畸变而非规范本意
  if (stepAtA < 0) {
    warnings.push(
      `z = ${z} 使 (2a) 段的 ${nearSidelobeGain.toFixed(3)} dBi 高于主瓣段末端的 ` +
      `${mainlobeEndGain.toFixed(3)} dBi（+20·lg z = ${(20 * LOG10(z)).toFixed(3)} dB 抬升过大），` +
      `方向图在 ψ = a·ψb 处向上跳 ${(-stepAtA).toFixed(3)} dB。请核对 z 的取值。`
    );
  }
  if (!(seg1End < seg2aEnd)) {
    warnings.push(`a·ψb = ${seg1End.toFixed(4)}° 不小于 0.5·b·ψb = ${seg2aEnd.toFixed(4)}°，(2a) 段为空。`);
  }
  if (!(Y > seg2bEnd)) {
    warnings.push(`Y = ${Y.toFixed(4)}° 不大于 b·ψb = ${seg2bEnd.toFixed(4)}°，(3) 段为空（Gm + LN 已低于 LF）。`);
  }

  return {
    a, b, alpha, c: row.c, z, psib, Gm, Ln: LnNum, LF, LB, X, Y,
    seg1End, seg2aEnd, seg2bEnd,
    mainlobeEndGain, nearSidelobeGain, stepAtA,
    provisional: row.provisional || z !== 1,
    warnings,
  };
}

/**
 * §1.2 参考方向图 G(ψ)（dBi）。
 *
 *   G = Gm − 3(ψ/ψb)^α          0 < ψ ≤ a·ψb          (1)
 *   G = Gm + LN + 20·lg z       a·ψb < ψ ≤ 0.5·b·ψb   (2a)
 *   G = Gm + LN                 0.5·b·ψb < ψ ≤ b·ψb   (2b)
 *   G = X − 25·lg ψ             b·ψb < ψ ≤ Y          (3)
 *   G = LF                      Y < ψ ≤ 90°           (4a)
 *   G = LB                      90° < ψ ≤ 180°        (4b)
 *
 * ★ ψ = a·ψb 处的垂直跌落是**规范本意**，不是台阶伪影，禁止平滑。
 *   典型值：Gm=32、ψb=1、z=1、Ln=−25 ⇒ 在 2.58° 处跌落 12.5677 dB。
 *
 * @param {number} offAxisDeg ψ，离轴角（度），[0,180]
 * @param {object} p 见 derivedS1528_12
 * @param {object} [d] 已算好的派生量（批量求值时传入以免重复计算）
 */
function gainDbS1528_12(offAxisDeg, p, d) {
  const D = d || derivedS1528_12(p);
  let psi = Number(offAxisDeg);
  if (!Number.isFinite(psi)) throw new TypeError(`s1528 §1.2: offAxisDeg 非有限数（${offAxisDeg}）`);
  psi = Math.abs(psi);
  if (psi > 180) throw new RangeError(`s1528 §1.2: offAxisDeg 超出 [0,180]（${offAxisDeg}）`);

  if (psi <= D.seg1End) return D.Gm - 3 * Math.pow(psi / D.psib, D.alpha);
  if (psi <= D.seg2aEnd) return D.nearSidelobeGain;
  if (psi <= D.seg2bEnd) return D.Gm + D.Ln;
  if (psi <= D.Y) return D.X - 25 * LOG10(psi);
  if (psi <= 90) return D.LF;
  return D.LB;
}

// ---------------------------------------------------------------------------
// §1.3 —— LEO / MEO 型
// ---------------------------------------------------------------------------

const LS_BY_MODE = Object.freeze({ MEO: -12, LEO: -6.75 });

/**
 * §1.3 的派生量。
 *
 * @param {object} p
 * @param {number} p.peakGainDbi   Gm
 * @param {number} p.psibDeg       ψb —— 原文此处的定义是「**最大离轴指向角处**所在平面的半个 3 dB 波束宽」
 * @param {'LEO'|'MEO'} p.mode
 * @param {number} p.dOverLambda   D/λ。原文只给了 D/λ < 35 的形式
 * @param {number} [p.farOutDbi]   LF。原文说 "~0 dBi for ideal patterns"，Annex 1 算例用了 3（MEO）与 5（LEO）
 * @param {'throw'|'extrapolate'} [p.outOfDomain='throw'] D/λ ≥ 35 时的处置
 */
function derivedS1528_13(p) {
  const Gm = Number(p.peakGainDbi);
  const psib = Number(p.psibDeg);
  const mode = String(p.mode || '').toUpperCase();
  const r = Number(p.dOverLambda);
  const LF = p.farOutDbi === undefined ? 0 : Number(p.farOutDbi);
  const oob = p.outOfDomain || 'throw';

  if (!Number.isFinite(Gm)) throw new TypeError(`s1528 §1.3: peakGainDbi 非有限数（${p.peakGainDbi}）`);
  if (!(psib > 0)) throw new RangeError(`s1528 §1.3: psibDeg 必须为正（${p.psibDeg}）`);
  if (!(mode in LS_BY_MODE)) throw new RangeError(`s1528 §1.3: mode 只能是 'LEO' 或 'MEO'（收到 ${p.mode}）`);
  if (!(r > 0)) throw new RangeError(`s1528 §1.3: dOverLambda 必须为正（${p.dOverLambda}）`);

  const warnings = [];
  if (r >= 35) {
    const msg = `s1528 §1.3: 原文只给出 D/λ < 35 的形式，D/λ = ${r} 超出【规范本身】的定义域（原文空缺，非本实现限制）。`;
    if (oob === 'throw') {
      throw new RangeError(msg + ` 若确要外推，显式传 outOfDomain:'extrapolate'，该口径会随 mask 一并打印。`);
    }
    warnings.push(msg + ' 已按 outOfDomain:"extrapolate" 沿用同式外推，此口径无 ITU 依据。');
  }

  const Ls = LS_BY_MODE[mode];
  const Y = psib * Math.sqrt(-Ls / 3);          // MEO ⇒ 2ψb，LEO ⇒ 1.5ψb（与原文分支写法一致）
  const Z = Y * Math.pow(10, 0.04 * (Gm + Ls - LF));
  // 原文 MEO/LEO 分支的等价式常数：MEO +3.5、LEO +5.65（成立于 Gm ≈ 20lg(D/λ) + 7.974 时）
  const altConst = mode === 'MEO' ? 3.5 : 5.65;

  return { Gm, psib, mode, Ls, Y, Z, LF, dOverLambda: r, altConst, warnings };
}

/**
 * §1.3 参考方向图 G(ψ)（dBi）。
 *
 *   G = Gm − 3(ψ/ψb)²           ψ ≤ Y        ← 原文写 "ψb < ψ < Y"，未覆盖 0..ψb；
 *                                              该式在 [0,ψb] 上连续且在 ψb 处恰为 Gm−3，
 *                                              故按 0..Y 实现。这是原文表述疏漏，不是口径选择。
 *   G = Gm + Ls − 25·lg(ψ/Y)    Y < ψ ≤ Z
 *   G = LF                      Z < ψ ≤ 180°
 */
function gainDbS1528_13(offAxisDeg, p, d) {
  const D = d || derivedS1528_13(p);
  let psi = Math.abs(Number(offAxisDeg));
  if (!Number.isFinite(psi)) throw new TypeError(`s1528 §1.3: offAxisDeg 非有限数（${offAxisDeg}）`);
  if (psi > 180) throw new RangeError(`s1528 §1.3: offAxisDeg 超出 [0,180]（${offAxisDeg}）`);

  if (psi <= D.Y) return D.Gm - 3 * Math.pow(psi / D.psib, 2);
  if (psi <= D.Z) return D.Gm + D.Ls - 25 * LOG10(psi / D.Y);
  return D.LF;
}

/**
 * §1.3 的 MEO/LEO 等价式：G = 20·lg(D/λ) + K − 25·lg(ψ/ψb)，K = 3.5(MEO) / 5.65(LEO)。
 * 只在旁瓣段有定义。导出它是为了让单测能验证「两种写法在 Gm 由 D/λ 推出时一致」，
 * 从而反查用户给的 Gm 与 D/λ 是否自洽——不自洽时两式的差就是 Gm 的偏离量。
 */
function gainDbS1528_13Alt(offAxisDeg, p, d) {
  const D = d || derivedS1528_13(p);
  const psi = Math.abs(Number(offAxisDeg));
  if (!(psi > D.Y)) return null;                 // 该式只覆盖旁瓣段
  if (psi > D.Z) return D.LF;
  return 20 * LOG10(D.dOverLambda) + D.altConst - 25 * LOG10(psi / D.psib);
}

// ---------------------------------------------------------------------------
// §1.4 —— 圆 Taylor 照射函数解析式
// ---------------------------------------------------------------------------

/**
 * §1.4 的派生量。
 *
 *   A = (1/π)·arccosh(10^(SLR/20))
 *   σ = μ_l / √(A² + (l − ½)²)          ← ★ 原文分子印作 J₀(l)，是笔误，见文件头注 [1]
 *
 * @param {object} p
 * @param {number} p.slrDb        SLR，峰值增益与第一旁瓣峰的增益差（dB）
 * @param {number} p.nSideLobes   l，参与建模的次瓣数（Annex 2 用 4）
 */
function derivedS1528_14(p) {
  const slr = Number(p.slrDb);
  const l = Number(p.nSideLobes);
  if (!Number.isFinite(slr) || slr <= 0) throw new RangeError(`s1528 §1.4: slrDb 必须为正（${p.slrDb}）`);
  if (!Number.isInteger(l) || l < 1) throw new RangeError(`s1528 §1.4: nSideLobes 必须为正整数（${p.nSideLobes}）`);
  if (l > MU.length) throw new RangeError(`s1528 §1.4: nSideLobes ≤ ${MU.length}（μ 表长度）`);

  const t = Math.pow(10, slr / 20);
  const A = Math.acosh(t) / Math.PI;
  const sigma = MU[l - 1] / Math.sqrt(A * A + Math.pow(l - 0.5, 2));
  return { A, sigma, l, slrDb: slr, mu: MU.slice(0, l) };
}

/**
 * §1.4 的 u：u = (π/λ)·√[(L_r·sinθ·cosφ)² + (L_t·sinθ·sinφ)²]
 *
 * (θ, φ) 是测试点相对于**被照射波束中心**在卫星参考系里的坐标（原文 Fig.4）。
 * L_r / L_t 是卫星发射天线有效辐射面的径向与横向尺寸（m），原文明写「由非 GSO 系统作为输入参数提供」。
 */
function uOf(thetaDeg, phiDeg, p) {
  const Lr = Number(p.LrM), Lt = Number(p.LtM), lam = Number(p.lambdaM);
  if (!(Lr > 0) || !(Lt > 0)) throw new RangeError('s1528 §1.4: LrM / LtM 必须为正');
  if (!(lam > 0)) throw new RangeError('s1528 §1.4: lambdaM 必须为正');
  const th = Number(thetaDeg) * Math.PI / 180, ph = Number(phiDeg) * Math.PI / 180;
  const st = Math.sin(th);
  const a = Lr * st * Math.cos(ph), b = Lt * st * Math.sin(ph);
  return (Math.PI / lam) * Math.hypot(a, b);
}

/**
 * §1.4 参考方向图（dB，相对 Gmax 的绝对增益）。
 *
 *   G(u) = Gmax + 20·lg | (2·J₁(u)/u) · ∏_{i=1}^{l−1} [1 − u²/(π²σ²(A² + (i−½)²))] / [1 − u²/μᵢ²] |
 *
 * ⚠ 原文末句：「Further studies are needed to define the bounds of the antenna gain for the nulls
 *   that appear when using a Bessel type of function.」——零点处会掉到 −∞，规范没规定下界。
 *   故 nullFloorDb 是**必填**参数，不给默认值：让调用方自己声明这个口径，并随 mask 打印。
 *
 * @param {number} u
 * @param {object} p {gmaxDbi, slrDb, nSideLobes, nullFloorDb}
 */
function gainDbS1528_14FromU(u, p, d) {
  const D = d || derivedS1528_14(p);
  const Gmax = Number(p.gmaxDbi);
  const floorDb = Number(p.nullFloorDb);
  if (!Number.isFinite(Gmax)) throw new TypeError(`s1528 §1.4: gmaxDbi 非有限数（${p.gmaxDbi}）`);
  if (!Number.isFinite(floorDb)) {
    throw new TypeError(
      's1528 §1.4: nullFloorDb 必填。原文自认零点下界 "needs further study"，' +
      '不给默认值是为了逼出这个口径声明（它会随 mask 一并打印）。'
    );
  }

  const x = Math.abs(Number(u));
  if (!Number.isFinite(x)) throw new TypeError(`s1528 §1.4: u 非有限数（${u}）`);

  // 2·J₁(u)/u 在 u→0 时的极限为 1
  const base = x < 1e-9 ? 1 : 2 * besselJ1(x) / x;

  let prod = base;
  const u2 = x * x, pi2 = Math.PI * Math.PI, s2 = D.sigma * D.sigma;
  for (let i = 1; i <= D.l - 1; i++) {
    const num = 1 - u2 / (pi2 * s2 * (D.A * D.A + Math.pow(i - 0.5, 2)));
    const den = 1 - u2 / (MU[i - 1] * MU[i - 1]);
    if (Math.abs(den) < 1e-12) return Math.max(Gmax + floorDb, Gmax + floorDb); // 落在极点上，钳到底
    prod *= num / den;
  }

  const mag = Math.abs(prod);
  const rel = mag < 1e-12 ? floorDb : Math.max(20 * LOG10(mag), floorDb);
  return Gmax + rel;
}

/** §1.4 的 (θ,φ) 入口：先算 u 再求增益。 */
function gainDbS1528_14(thetaDeg, phiDeg, p, d) {
  return gainDbS1528_14FromU(uOf(thetaDeg, phiDeg, p), p, d);
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/**
 * 按 recommends 分派。UI 的 "Antenna Gain Pattern" 下拉映射到这里。
 * @param {'1.2'|'1.3'|'1.4'} section
 */
function makePattern(section, p) {
  if (section === '1.2') {
    const d = derivedS1528_12(p);
    return { section, derived: d, gainDb: (psi) => gainDbS1528_12(psi, p, d), warnings: d.warnings };
  }
  if (section === '1.3') {
    const d = derivedS1528_13(p);
    return { section, derived: d, gainDb: (psi) => gainDbS1528_13(psi, p, d), warnings: d.warnings };
  }
  if (section === '1.4') {
    const d = derivedS1528_14(p);
    return {
      section, derived: d, warnings: [],
      gainDb: (th, ph) => gainDbS1528_14(th, ph, p, d),
      gainDbFromU: (u) => gainDbS1528_14FromU(u, p, d),
    };
  }
  throw new RangeError(`s1528.makePattern: section 只能是 '1.2' / '1.3' / '1.4'（收到 ${section}）`);
}

module.exports = {
  LN_TABLE, LN_VALUES, MU, LS_BY_MODE,
  besselJ0, besselJ1,
  psibFromAperture, psibFromFullBeamwidth,
  derivedS1528_12, gainDbS1528_12,
  derivedS1528_13, gainDbS1528_13, gainDbS1528_13Alt,
  derivedS1528_14, gainDbS1528_14, gainDbS1528_14FromU, uOf,
  makePattern,
};
