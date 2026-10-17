// 地面业务干扰 · 固定 / 陆地移动业务参考天线方向图 —— ITU-R F.1336-5（01/2019）
//
// 用途：共用研究里 P-MP 固定无线、陆地移动（含 IMT 非 AAS 基站）天线的参考方向图，适用 400 MHz – 约 70 GHz。
// 建议书 Note 1 说得明白：有实测方向图就用实测，这里是「拿不到时」的参考包络。
//
// 选哪一条：
//   · 方位全向天线          recommends 2    仰角一维方向图 G(θ)，可带电下倾（2.5）
//   · 扇区天线 0.4–6 GHz    recommends 3.1  附件 7 的算法：方位 Ghr、俯仰 Gvr 分开算，再用压缩比 R 合成
//                                           （式 (2a1)(2a2)），k 参数取附件 7 表 4
//   · 扇区天线 6–70 GHz     recommends 3.2  附件 3/6 的椭圆波束：离轴角 ψ 除以该切面的等效波束宽度 ψα，
//                                           x = ψ/ψα，再查 Gref(x)
//   · 低增益定向 1–3 GHz    recommends 4.1  圆对称、主瓣增益 ≲ 20 dBi；只有峰值包络
//                                           （平均包络建议书指向 F.1245，本模块不实现）
//   · IMT AAS 基站 / 终端    不在本模块——用 m2101.js（M.2101-0 §5 自己也说 F.1336「可能适用于部分 IMT 场景」）
//
// 峰值还是平均（considering b / c），与 interference/patterns.js 头注同一个道理：
//   · peak     单个、静止的干扰路径（一座基站对一座地球站），取包络峰值，偏保守。
//   · average  大量基站对一个接收机的集总干扰、或角度连续变化（NGSO）——旁瓣的峰与谷都会被扫到，
//              用峰值包络会系统性高估。considering c) 原文列举的正是这几种情况。
//   全向 k（recommends 2.3/2.4）：0.4–3 GHz 一般天线 0.7；改进旁瓣天线与 3–70 GHz 一切天线 0。
//   扇区 kh/kv/kp/ka（附件 7 表 4）：一般型 0.8/0.7/0.7/0.7；改进型（亦适用 IMT 基站天线）0.7/0.3/0.7/0.7。
//
// ─────────────────────────────────────────────────────────────────────────────
// 角度口径（全模块统一，与建议书一致）
//   θ  仰角，自水平面起算，−90°…90°，向上为正（注意：M.2101 的 θ 是自天顶起算的 0…180°，两者差 90° 且反号）
//   φ  方位，自最大增益方位起算，−180°…180°；入参超出会折回
//   β  倾角，「主波束轴低于水平面」为正（向下倾）；机械倾 mechTiltDeg、电倾 elecTiltDeg / tiltDeg 同此号
//   参数次序随建议书：扇区 G(φ, θ)，全向 G(θ)，低增益 G(离轴角)
//
// 返回值与出错口径
//   单点函数返回增益 dBi（number）。非法输入一律返回 { error: '中文原因' }（与同目录 p452.js 一致），
//   调用方统一写 `if (g.error)` 即可（number 上取 .error 得 undefined）。
//   make* 预解析版把只与天线参数有关的量提到循环外，返回 { …参数, warnings: [], gain(...) }；
//   warnings 收「仍可算、但已出建议书适用范围」的软提示（如 (3a) 用于 φ3 > 120°）。
//   唯一例外：吃预解析参数 P 的积木 Ghr / Gvr / compressionRatio / phi3m / theta3m / sectoralHighX 不再校验（热路径），
//   P 须来自 sectoralLowParams / sectoralHighParams / makeSectoral。
//
// ─────────────────────────────────────────────────────────────────────────────
// 判断与取舍（建议书没写死、或正文与附件不一致之处）
//   ① 6–70 GHz 式 (2d3) 第一支（ψ ≤ 90°）：正文写 φ3，附件 6 式 (50) 写 φ3m，且附件 6 末句明言
//      「(50) 与 (52) 即正文 (2d3) 所指」。两者只在 φth < |φ| ≤ 90° 时不同；按正文字面，方位面 ψ = 90°
//      处 ψα 会从 φ3 跳到 φ3m(90°)，增益断开数 dB（φ3 = 65°、θ3 = 10° 时约 5.6 dB）。缺省取附件 6 式 (50)；
//      psiAlphaRule: 'mainText' 可复现正文字面，供对拍。
//   ② 式 (47) 的 λk 建议书未定义（附件 7 的 λk = 12 − 10lg(1+8kp) 属 0.4–6 GHz 口径，6–70 GHz 没有 kp）。
//      取使 G(±180°, 0°) = G0 − FBR 成立的值：峰值 (2e) 取 12，平均 (2f) 取 15。
//   ③ 机械倾 + 电倾同时存在：建议书未写组合次序。取物理次序——先按 (3b)(3c) 把站址水平坐标换到机械倾斜后的
//      天线坐标，再在天线坐标里按 (1e) 做电倾（总下倾 = 机械 + 电倾，主瓣在 φh = 0、θh = −(βm + βe)）。
//   ④ Note 3（recommends 5 明言 Notes 属建议书正文）：C 因子只适用 θ3 < 20°。0.4–6 GHz 扇区 θ3 ≥ 20° 返回 { error }。
//   ⑤ 式 (4) 低增益：G0 < 6 dBi 时 φ2 < φ1，四段边界失序，返回 { error }；G0 = 6 时第三段退化为空、仍连续。
//   ⑥ 频率只用来选段（< 6 GHz → 3.1，≥ 6 GHz → 3.2）与选全向 k（一般型 < 3 GHz → 0.7），不作适用性硬拦截。
//
// 建议书自身的不连续 / 非单调之处——照原文实现、不修；f1336.test.mjs 逐一按解析值钉住：
//   · (1d) 平均全向：θ3 处跌 3 − 10lg(k+1) dB（k = 0 跌 3 dB，k = 0.7 跌 0.696 dB）；
//          θ5 处再跌 10lg((θ5/θ3)^−1.5 + k) − 10lg(k+1)（k = 0 为 −0.727 dB，k = 0.7 为 −0.107 dB）。均向下。
//   · (2b3)/(2c3) 俯仰面 xk 处：−12xk² 与第二段不相接。台阶（外侧减内侧）：
//          峰值 kv = 0.3 → +0.133 dB（向上）；峰值 kv = 0.7 → −0.139 dB；
//          平均 kv = 0.3 → +0.400 dB（向上）；平均 kv = 0.7 → +0.314 dB（向上）。合成增益里乘以 R。
//   · (2f) x = 1.152 处 +0.0035 dB（向上）。(2e) 在 x = 1 处连续。
//   · (4) 1.08φ3 处 −0.0032 dB（12·1.08² = 13.9968 ≠ 14）；φ1、φ2 处连续。
//   · 0.4–6 GHz 扇区的方位单调性：由 (2a1)(2a2) 代数可得 ∂G/∂Ghr = 1 − Gvr/Ghr(180°/φ3)。方位 180° 处 Ghr 已触底
//     （Ghr(180°/φ3) = G180，φ3 = 65° 一类常见参数）时 G 随 |φ| 单调不增；宽波束（如 φ3 = 120°）未触底时，
//     在 Gvr < Ghr(180°/φ3) 的大仰角上 G 随 |φ| 增大反而上升——这是该合成式的性质，不是实现错误。
//   · 同上原因，0.4–6 GHz 模型在天顶（θ = ±90°，Gvr = G180）的增益 G0 + Ghr + R·G180：已触底时恰为 G0 + G180、
//     与 φ 无关；宽波束未触底时随 φ 变（同一物理方向给出不同增益，二维可分离模型的固有现象）。
//     6–70 GHz 模型在天顶总与 φ 无关（α = 90° ⇒ ψα = θ3）。
//
// 权威依据：ITU-R F.1336-5 官方 PDF 逐式核对（recommends 2–4、附件 5/6/7），未凭记忆。
// 纯函数、无依赖，CommonJS。

const LOG10 = Math.log10;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ANG_TOL = 1e-9;          // 角度容差（度）：越界不超过它的按边界钳住，超过则报错

const fail = (msg) => ({ error: msg });

// 仰角规整：[−90, 90]，容差内钳住，越界返回 NaN
function normElev(t) {
  if (!Number.isFinite(t)) return NaN;
  if (t > 90) return t <= 90 + ANG_TOL ? 90 : NaN;
  if (t < -90) return t >= -90 - ANG_TOL ? -90 : NaN;
  return t;
}

// 方位规整：折回 [−180, 180]
function wrapAz(p) {
  if (!Number.isFinite(p)) return NaN;
  if (p >= -180 && p <= 180) return p;
  return ((p + 180) % 360 + 360) % 360 - 180;
}

// 可选数值参数：缺省（undefined / null）给 dflt，否则转 Number
const optNum = (v, dflt) => (v == null ? dflt : Number(v));

// ---------------------------------------------------------------------------
// recommends 2 · 全向天线（方位全向，仰角一维）
// ---------------------------------------------------------------------------

/** 全向天线俯仰面 3 dB 波束宽度（度）。recommends 2.1 式 (1b)：θ3 = 107.6 × 10^(−0.1·G0)。 */
function omniTheta3(G0) {
  const g = Number(G0);
  if (!Number.isFinite(g)) return fail('G0 须为有限数（dBi）');
  return 107.6 * Math.pow(10, -0.1 * g);
}

// θ4 / θ5 共用：c = 1（θ4）或 1.25（θ5）
function omniTheta45(theta3, k, c, name) {
  const t = Number(theta3), kk = Number(k);
  if (!(t > 0) || !Number.isFinite(t)) return fail('θ3 须为正数（度）');
  if (!(kk >= 0) || !Number.isFinite(kk)) return fail('k 须 ≥ 0');
  const v = t * Math.sqrt(c - LOG10(kk + 1) / 1.2);
  return Number.isFinite(v) ? v : fail(`k = ${kk} 过大，${name} 无实数解`);
}

/** 峰值全向图主瓣与平台的交点（度）。recommends 2.1 式 (1c)：θ4 = θ3·√(1 − lg(k+1)/1.2)。 */
function omniTheta4(theta3, k) {
  return omniTheta45(theta3, k, 1, 'θ4');
}

/** 平均全向图平台的外端（度）。recommends 2.2：θ5 = θ3·√(1.25 − lg(k+1)/1.2)。 */
function omniTheta5(theta3, k) {
  return omniTheta45(theta3, k, 1.25, 'θ5');
}

/**
 * 全向天线 k 参数。recommends 2.3：0.4–3 GHz 一般天线 k = 0.7；recommends 2.4：改进旁瓣天线、以及 3–70 GHz
 * 的一切天线 k = 0。3 GHz 整点归 2.4（f < 3 才取 0.7）。
 * @param {number} fGHz
 * @param {'typical'|'improved'} [type='typical']
 */
function omniK(fGHz, type) {
  const f = Number(fGHz);
  if (!(f > 0) || !Number.isFinite(f)) return fail('fGHz 须为正数');
  const t = type == null ? 'typical' : type;
  if (t !== 'typical' && t !== 'improved') return fail("全向天线 type 只认 'typical' / 'improved'");
  return t === 'typical' && f < 3 ? 0.7 : 0;
}

// 全向方向图本体：th 为相对最大增益方向的仰角（已做过电倾换算），theta45 = θ4（峰值）或 θ5（平均）
function omniCore(G0, th, theta3, k, avg, theta45) {
  const a = Math.abs(th);
  const r = a / theta3;
  if (!avg) {
    // recommends 2.1 式 (1a)
    if (a < theta45) return G0 - 12 * r * r;                      // 0 ≤ |θ| < θ4
    if (a < theta3) return G0 - 12 + 10 * LOG10(k + 1);           // θ4 ≤ |θ| < θ3（k = 0 时 θ4 = θ3，本段为空）
    return G0 - 12 + 10 * LOG10(Math.pow(r, -1.5) + k);           // θ3 ≤ |θ| ≤ 90°
  }
  // recommends 2.2 式 (1d)——θ3 处跌 3 − 10lg(k+1) dB、θ5 处再跌一级，原文如此（见头注）
  if (a < theta3) return G0 - 12 * r * r;                         // 0 ≤ |θ| < θ3
  if (a < theta45) return G0 - 15 + 10 * LOG10(k + 1);            // θ3 ≤ |θ| < θ5（k ≥ 0.995 时 θ5 ≤ θ3，本段为空）
  return G0 - 15 + 10 * LOG10(Math.pow(r, -1.5) + k);             // θ5 ≤ |θ| ≤ 90°
}

/**
 * 电倾仰角换算。recommends 2.5 式 (1e)（= 附件 5 §3 式 (45)）：
 *   θe = 90(θh + β)/(90 + β)   θh + β ≥ 0
 *   θe = 90(θh + β)/(90 − β)   θh + β < 0
 * 主瓣落在 θh = −β；天顶 / 天底（θh = ±90°）不动。扇区天线同样适用（recommends 3.5）。
 * @param {number} thetaHDeg 站址水平面起算的仰角 θh（−90…90）
 * @param {number} betaDeg   下倾角 β（向下为正），|β| < 90
 * @returns {number|{error}} θe（度）
 */
function electricalTiltElevation(thetaHDeg, betaDeg) {
  const th = normElev(Number(thetaHDeg));
  const b = Number(betaDeg);
  if (Number.isNaN(th)) return fail('θh 须在 −90°…90°');
  if (!(Math.abs(b) < 90)) return fail('倾角须在 (−90°, 90°)');
  const s = th + b;
  return s >= 0 ? 90 * s / (90 + b) : 90 * s / (90 - b);         // 式 (1e)
}

/**
 * 全向天线预解析版。
 * @param {object} opts
 * @param {number} opts.G0            方位面最大增益（dBi）
 * @param {number} [opts.theta3]      俯仰 3 dB 波束宽度（度）；缺省按式 (1b)
 * @param {number} [opts.k]           旁瓣抬升参数；缺省：给了 fGHz 则按 omniK(fGHz, type)，否则 0（3–70 GHz 口径，覆盖 C 频段）
 * @param {number} [opts.fGHz]
 * @param {'typical'|'improved'} [opts.type='typical']
 * @param {'peak'|'average'} [opts.mode='peak']
 * @param {number} [opts.tiltDeg=0]   电下倾 β（度，向下为正）
 * @returns {{pattern, mode, G0, theta3, theta3Source, k, theta4?, theta5?, tiltDeg, warnings, gain:(thetaHDeg:number)=>number|{error}}|{error}}
 *   gain 的入参是站址水平面起算的仰角 θh；不倾时即相对最大增益方向的仰角 θ。
 */
function makeOmni(opts) {
  const o = opts || {};
  const G0 = Number(o.G0);
  if (!Number.isFinite(G0)) return fail('G0 须为有限数（dBi）');
  const mode = o.mode == null ? 'peak' : o.mode;
  if (mode !== 'peak' && mode !== 'average') return fail("mode 只认 'peak' / 'average'");
  const avg = mode === 'average';

  let theta3, theta3Source;
  if (o.theta3 != null) {
    theta3 = Number(o.theta3);
    theta3Source = 'input';
    if (!(theta3 > 0) || !Number.isFinite(theta3)) return fail('θ3 须为正数（度）');
  } else {
    theta3 = omniTheta3(G0);
    theta3Source = '(1b)';
  }

  let k;
  if (o.k != null) {
    k = Number(o.k);
    if (!(k >= 0) || !Number.isFinite(k)) return fail('k 须 ≥ 0');
  } else if (o.fGHz != null) {
    k = omniK(o.fGHz, o.type);
    if (k.error) return k;
  } else {
    k = 0;
  }

  const theta45 = avg ? omniTheta5(theta3, k) : omniTheta4(theta3, k);
  if (theta45.error) return theta45;

  const tilt = optNum(o.tiltDeg, 0);
  if (!(Math.abs(tilt) < 90)) return fail('电下倾须在 (−90°, 90°)');

  const out = {
    pattern: 'F.1336-5 omni', mode, G0, theta3, theta3Source, k, tiltDeg: tilt, warnings: [],
    gain(thetaHDeg) {
      let th = normElev(Number(thetaHDeg));
      if (Number.isNaN(th)) return fail('仰角须在 −90°…90°');
      if (tilt !== 0) {
        // recommends 2.5 式 (1e)
        const s = th + tilt;
        th = s >= 0 ? 90 * s / (90 + tilt) : 90 * s / (90 - tilt);
      }
      return omniCore(G0, th, theta3, k, avg, theta45);
    }
  };
  if (avg) out.theta5 = theta45; else out.theta4 = theta45;
  return out;
}

/**
 * 全向天线单点增益（dBi）。opts 同 makeOmni，另加 thetaDeg（站址水平面起算的仰角 θh）。
 * 热路径（同一副天线算很多方向）请用 makeOmni 预解析。
 */
function omni(opts) {
  const m = makeOmni(opts);
  if (m.error) return m;
  return m.gain((opts || {}).thetaDeg);
}

// ---------------------------------------------------------------------------
// recommends 3.3 / 3.4 · 扇区天线的波束宽度与机械下倾坐标变换
// ---------------------------------------------------------------------------

/**
 * 扇区天线俯仰 3 dB 波束宽度（度）。recommends 3.3 式 (3a)（附件 2 式 (28a)）：θ3 = 31000 × 10^(−0.1·G0) / φ3。
 * 建议书限定 φ3 ≲ 120°（暂定关系）；Note 5：已知 θ3 时应直接用已知值。
 */
function sectoralTheta3(G0, phi3) {
  const g = Number(G0), p = Number(phi3);
  if (!Number.isFinite(g)) return fail('G0 须为有限数（dBi）');
  if (!(p > 0) || !Number.isFinite(p)) return fail('φ3 须为正数（度）');
  return 31000 * Math.pow(10, -0.1 * g) / p;
}

/**
 * 机械下倾：站址水平坐标 (θh, φh) → 倾斜后的天线坐标 (θ, φ)。
 * recommends 3.4 式 (3b)(3c)，推导见附件 5 §2 式 (40)(41)(42)：
 *   (40) zh = sinθh，xh = cosθh·cosφh，yh = cosθh·sinφh
 *   (41) 绕 y 轴下压 β：z = zh·cosβ + xh·sinβ，x = −zh·sinβ + xh·cosβ，y = yh
 *   (42) θ = arcsin z = arcsin(sinθh·cosβ + cosθh·cosφh·sinβ)                       即式 (3b)
 *        φ = arccos(x / cosθ) = arccos((−sinθh·sinβ + cosθh·cosφh·cosβ) / cosθ) ∈ [0°,180°]  即式 (3c)
 * 数值上 θ、φ 都用 atan2 求（附件 5 §2 原文：φ 由 arctan(y/x) 按 x、y 符号修正，取 −180°…180°），
 * 在主瓣附近不像 arcsin / arccos 那样丢精度；返回的 φ 带符号（与 φh 同号），|φ| 与式 (3c) 相同。
 * 附件 5 Note 1：arccos 只给 0…180° 不影响使用——方向图对 x-z、x-y 平面镜像对称。
 * cosθ = 0（方向正对天线 z 轴）时 φ 无定义，atan2 按舍入给 0 或 ±180°；只有 0.4–6 GHz 宽波束（Ghr 未触底）
 * 的天顶增益随 φ 变，那是模型在该点本身多值（见头注），测度为零，Monte Carlo 里碰不到。
 * @returns {{thetaDeg:number, phiDeg:number}|{error}}
 */
function tiltToAntennaFrame(thetaHDeg, phiHDeg, betaDeg) {
  const th = normElev(Number(thetaHDeg));
  const ph = wrapAz(Number(phiHDeg));
  const b = Number(betaDeg);
  if (Number.isNaN(th)) return fail('θh 须在 −90°…90°');
  if (Number.isNaN(ph)) return fail('φh 须为有限数');
  if (!(Math.abs(b) < 90)) return fail('倾角须在 (−90°, 90°)');
  const t = th * D2R, p = ph * D2R, bb = b * D2R;
  const cb = Math.cos(bb), sb = Math.sin(bb);
  const zh = Math.sin(t), ct = Math.cos(t);                       // 式 (40)
  const xh = ct * Math.cos(p), yh = ct * Math.sin(p);
  const z = zh * cb + xh * sb;                                    // 式 (41)
  const x = -zh * sb + xh * cb;
  const y = yh;
  return { thetaDeg: Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D, phiDeg: Math.atan2(y, x) * R2D };
}

// ---------------------------------------------------------------------------
// recommends 3.1 · 扇区天线 0.4–6 GHz（附件 7）
// ---------------------------------------------------------------------------

// 附件 7 表 4。峰值 / 平均两列数值相同；kp 用于峰值、ka 用于平均。
// 改进型「亦适用于 IMT 基站天线」（recommends 3.1.1.1.2 等各条同此句）。
const SECTORAL_K = Object.freeze({
  typical: Object.freeze({ kh: 0.8, kv: 0.7, kp: 0.7, ka: 0.7 }),
  improved: Object.freeze({ kh: 0.7, kv: 0.3, kp: 0.7, ka: 0.7 })
});

function normSectoralType(t) {
  if (t == null || t === 'typical') return 'typical';
  if (t === 'improved' || t === 'imt') return 'improved';
  return null;
}

/**
 * 表 4 缺省 k 参数。
 * @param {'typical'|'improved'|'imt'} [type='typical']  'imt' 同 'improved'
 * @returns {{kh, kv, kp, ka}|{error}}
 */
function sectoralK(type) {
  const t = normSectoralType(type);
  if (!t) return fail("扇区 type 只认 'typical' / 'improved' / 'imt'");
  return { ...SECTORAL_K[t] };
}

/**
 * 相对最小增益 G180（dB）。
 *   峰值 recommends 3.1.1.1 式 (2b1)：G180 = −12 + 10lg(1 + 8kp) − 15lg(180°/θ3)
 *   平均 recommends 3.1.2.1 式 (2c1)：G180 = −15 + 10lg(1 + 8ka) − 15lg(180°/θ3)
 * （附件 7 式 (57)(58) 写成 −λk − 15lg(180°/θ3)、−λk − 3 − 15lg(180°/θ3)，λk = 12 − 10lg(1 + 8kp/ka)，同式。）
 */
function G180(theta3, kpa, mode) {
  const t = Number(theta3), k = Number(kpa);
  if (!(t > 0) || !Number.isFinite(t)) return fail('θ3 须为正数（度）');
  if (!(k >= 0) || !Number.isFinite(k)) return fail('kp / ka 须 ≥ 0');
  return (mode === 'average' ? -15 : -12) + 10 * LOG10(1 + 8 * k) - 15 * LOG10(180 / t);
}

// 解析扇区公共入参：G0、φ3、θ3（缺省按 (3a)）、mode
function parseSectoralCommon(o, warnings) {
  const G0 = Number(o.G0);
  if (!Number.isFinite(G0)) return fail('G0 须为有限数（dBi）');
  const phi3 = Number(o.phi3);
  if (!(phi3 > 0) || !Number.isFinite(phi3)) return fail('φ3 须为正数（度）');
  const mode = o.mode == null ? 'peak' : o.mode;
  if (mode !== 'peak' && mode !== 'average') return fail("mode 只认 'peak' / 'average'");
  let theta3, theta3Source;
  if (o.theta3 != null) {
    theta3 = Number(o.theta3);
    theta3Source = 'input';
    if (!(theta3 > 0) || !Number.isFinite(theta3)) return fail('θ3 须为正数（度）');
  } else {
    theta3 = sectoralTheta3(G0, phi3);
    theta3Source = '(3a)';
    // recommends 3.3：(3a) 是「φ3 小于约 120°」的暂定关系
    if (phi3 > 120) warnings.push(`φ3 = ${phi3}° > 120°：式 (3a) 超出 recommends 3.3 适用范围`);
  }
  return { G0, phi3, theta3, theta3Source, mode, avg: mode === 'average' };
}

/**
 * 0.4–6 GHz 扇区天线的参数预解析（与方向、倾角无关的量全部在此算好）。
 * @param {object} opts
 * @param {number} opts.G0                 方位面最大增益（dBi）
 * @param {number} opts.phi3               方位 3 dB 波束宽度（度）
 * @param {number} [opts.theta3]           俯仰 3 dB 波束宽度（度）；缺省按式 (3a)
 * @param {'peak'|'average'} [opts.mode='peak']
 * @param {'typical'|'improved'|'imt'} [opts.type='typical']  表 4 缺省 k 的列；IMT 基站取 'improved'（或 'imt'）
 * @param {{kh?, kv?, kp?, ka?}} [opts.params]  逐项覆盖表 4 缺省值
 * @returns {object|{error}} P：{ band:'low', mode, avg, G0, phi3, theta3, theta3Source, type, kh, kv, kpa,
 *          g180, lambdaKh, xk, C, lambdaKv, xvMax, ghrBack, warnings }
 */
function sectoralLowParams(opts) {
  const o = opts || {};
  const warnings = [];
  const c = parseSectoralCommon(o, warnings);
  if (c.error) return c;
  const type = normSectoralType(o.type);
  if (!type) return fail("扇区 type 只认 'typical' / 'improved' / 'imt'");
  const dflt = SECTORAL_K[type];
  const pr = o.params || {};
  const kh = optNum(pr.kh, dflt.kh);
  const kv = optNum(pr.kv, dflt.kv);
  const kpa = c.avg ? optNum(pr.ka, dflt.ka) : optNum(pr.kp, dflt.kp);
  // recommends 3.1.1.2 / 3.1.1.3：0 ≤ kh ≤ 1、0 ≤ kv ≤ 1
  if (!(kh >= 0 && kh <= 1)) return fail('kh 须在 [0, 1]');
  if (!(kv >= 0 && kv <= 1)) return fail('kv 须在 [0, 1]');
  if (!(kpa >= 0) || !Number.isFinite(kpa)) return fail(c.avg ? 'ka 须 ≥ 0' : 'kp 须 ≥ 0');

  const theta3 = c.theta3;
  // Note 3：C 的公式只适用于俯仰 3 dB 波束宽度 < 20°（θ3 ≥ 22.5° 时 C 的分母 lg(22.5°/θ3) ≤ 0，公式本身也不成立）
  if (!(theta3 < 20)) return fail(`θ3 = ${+theta3.toFixed(3)}° ≥ 20°：超出 F.1336-5 Note 3（C 因子）适用范围`);

  // G180：峰值式 (2b1)，平均式 (2c1)
  const g180 = (c.avg ? -15 : -12) + 10 * LOG10(1 + 8 * kpa) - 15 * LOG10(180 / theta3);
  // 相对最小增益须为负：否则式 (2a2) 的分母 Ghr(0) − Ghr(180°/φ3) 不再为正（kp / ka 取到几十才会发生）
  if (!(g180 < 0)) return fail(`G180 = ${g180.toFixed(3)} dB ≥ 0：kp / ka 过大`);
  // λkh = 3(1 − 0.5^−kh)：式 (2b2) / (2c2) 下方定义，保证 Ghr 在 xh = 0.5 处连续
  const lambdaKh = 3 * (1 - Math.pow(0.5, -kh));
  // C（衰减斜率因子）：峰值 3.1.1.3、平均 3.1.2.3 同形，分母里的 1 + 8kp 换成 1 + 8ka
  const C = 10 * LOG10(Math.pow(180 / theta3, 1.5) * (Math.pow(4, -1.5) + kv) / (1 + 8 * kpa)) / LOG10(22.5 / theta3);
  // λkv = 12 − C·lg4 − 10lg(4^−1.5 + kv)：保证 Gvr 在 xv = 4 处连续（峰值、平均同一定义）
  const lambdaKv = 12 - C * LOG10(4) - 10 * LOG10(Math.pow(4, -1.5) + kv);
  // xk：峰值 √(1 − 0.36kv)（3.1.1.3），平均 √(1.33 − 0.33kv)（3.1.2.3）
  const xk = c.avg ? Math.sqrt(1.33 - 0.33 * kv) : Math.sqrt(1 - 0.36 * kv);
  if (!(C > 0)) warnings.push(`C = ${C.toFixed(3)} ≤ 0：俯仰第三段不再随角度下降`);

  const P = {
    band: 'low', pattern: 'F.1336-5 recommends 3.1', mode: c.mode, avg: c.avg,
    G0: c.G0, phi3: c.phi3, theta3, theta3Source: c.theta3Source, type,
    kh, kv, kpa, g180, lambdaKh, xk, C, lambdaKv, xvMax: 90 / theta3, ghrBack: 0, warnings
  };
  // 式 (2a2) 分母要用的 Ghr(180°/φ3)（方位正后方的相对增益，含 ≥ G180 的钳位）
  P.ghrBack = Ghr(180 / c.phi3, P);
  return P;
}

/**
 * 方位面相对增益 Ghr(xh)（dB），xh = |φ|/φ3。
 * 峰值 recommends 3.1.1.2 式 (2b2)、平均 3.1.2.2 式 (2c2)，两式相同，只是钳位用的 G180 不同：
 *   Ghr = −12xh²                     xh ≤ 0.5
 *   Ghr = −12xh^(2−kh) − λkh          0.5 < xh
 *   Ghr ≥ G180
 * @param {number} xh
 * @param {object} P  sectoralLowParams 的返回值（不再校验）
 */
function Ghr(xh, P) {
  const g = xh <= 0.5 ? -12 * xh * xh : -12 * Math.pow(xh, 2 - P.kh) - P.lambdaKh;
  return g > P.g180 ? g : P.g180;
}

/**
 * 俯仰面相对增益 Gvr(xv)（dB），xv = |θ|/θ3。
 * 峰值 recommends 3.1.1.3 式 (2b3)：
 *   −12xv²                       xv < xk
 *   −12 + 10lg(xv^−1.5 + kv)     xk ≤ xv < 4
 *   −λkv − C·lg(xv)              4 ≤ xv < 90°/θ3
 *   G180                         xv ≥ 90°/θ3
 * 平均 recommends 3.1.2.3 式 (2c3)：第二段常数 −15、第三段多 −3，其余同形。
 * xk 处两段不相接（见头注台阶表）；xv = 4 与 xv = 90°/θ3 处由 λkv、C 的定义保证连续。
 * @param {number} xv
 * @param {object} P  sectoralLowParams 的返回值（不再校验）
 */
function Gvr(xv, P) {
  if (xv < P.xk) return -12 * xv * xv;
  if (P.avg) {
    if (xv < 4) return -15 + 10 * LOG10(Math.pow(xv, -1.5) + P.kv);   // 式 (2c3) 第二段
    if (xv < P.xvMax) return -P.lambdaKv - 3 - P.C * LOG10(xv);       // 式 (2c3) 第三段
    return P.g180;                                                     // 式 (2c3) 第四段
  }
  if (xv < 4) return -12 + 10 * LOG10(Math.pow(xv, -1.5) + P.kv);     // 式 (2b3) 第二段
  if (xv < P.xvMax) return -P.lambdaKv - P.C * LOG10(xv);             // 式 (2b3) 第三段
  return P.g180;                                                       // 式 (2b3) 第四段
}

/**
 * 水平增益压缩比 R。recommends 3.1.1 式 (2a2)（附件 7 式 (56)）：
 *   R = (Ghr(xh) − Ghr(180°/φ3)) / (Ghr(0) − Ghr(180°/φ3))，Ghr(0) = 0
 * 方位正前方 R = 1、正后方 R = 0（正后方增益与仰角无关）。
 */
function compressionRatio(xh, P) {
  return (Ghr(xh, P) - P.ghrBack) / (0 - P.ghrBack);
}

// 0.4–6 GHz 合成：天线坐标 (φ, θ)，已做过倾角换算。recommends 3.1.1 式 (2a1)：G = G0 + Ghr(xh) + R·Gvr(xv)
function sectoralLowCore(phiDeg, thetaDeg, P) {
  const xh = Math.abs(phiDeg) / P.phi3;
  const xv = Math.abs(thetaDeg) / P.theta3;
  const gh = Ghr(xh, P);
  const R = (gh - P.ghrBack) / (0 - P.ghrBack);                       // 式 (2a2)
  return P.G0 + gh + R * Gvr(xv, P);                                  // 式 (2a1)
}

// ---------------------------------------------------------------------------
// recommends 3.2 · 扇区天线 6–70 GHz（附件 3 / 附件 6）
// ---------------------------------------------------------------------------

/**
 * 由前后比推方位 180° 处的等效波束宽度 φ3(180)（度）。附件 6 Note 1 式 (47)：φ3(180) = 180 / 10^((FBR − λk)/15)。
 * λk 建议书未定义，取使 G(±180°, 0°) = G0 − FBR 的值：峰值 12（式 (2e)）、平均 15（式 (2f)）——见头注 ②。
 */
function phi3At180FromFbr(fbrDb, mode) {
  const f = Number(fbrDb);
  const lk = mode === 'average' ? 15 : 12;
  if (!Number.isFinite(f)) return fail('FBR 须为有限数（dB）');
  if (f < lk) return fail(`FBR = ${f} dB < ${lk} dB：式 (47) 不适用`);
  return 180 / Math.pow(10, (f - lk) / 15);
}

/**
 * 6–70 GHz 扇区天线的参数预解析。
 * @param {object} opts
 * @param {number} opts.G0, opts.phi3, [opts.theta3], [opts.mode]   同 sectoralLowParams
 * @param {number} [opts.phi3At180]   方位 ±180° 处的等效波束宽度 φ3(180)（度）；缺省按式 (46) 取 θ3
 * @param {number} [opts.fbr]         前后比（dB）；给了且没给 phi3At180 时按式 (47) 推 φ3(180)
 * @param {'annex6'|'mainText'} [opts.psiAlphaRule='annex6']  式 (2d3) 第一支用 φ3m（附件 6 式 (50)）还是 φ3（正文字面），见头注 ①
 * @returns {object|{error}} P：{ band:'high', mode, avg, G0, phi3, theta3, theta3Source, phiTh, phi3At180, xBreak, psiAlphaRule, warnings }
 */
function sectoralHighParams(opts) {
  const o = opts || {};
  const warnings = [];
  const c = parseSectoralCommon(o, warnings);
  if (c.error) return c;
  const rule = o.psiAlphaRule == null ? 'annex6' : o.psiAlphaRule;
  if (rule !== 'annex6' && rule !== 'mainText') return fail("psiAlphaRule 只认 'annex6' / 'mainText'");
  let phi3At180;
  if (o.phi3At180 != null) {
    phi3At180 = Number(o.phi3At180);
    if (!(phi3At180 > 0) || !Number.isFinite(phi3At180)) return fail('φ3(180) 须为正数（度）');
  } else if (o.fbr != null) {
    phi3At180 = phi3At180FromFbr(o.fbr, c.mode);                       // 式 (47)
    if (phi3At180.error) return phi3At180;
  } else {
    phi3At180 = c.theta3;                                               // 式 (46)
  }
  return {
    band: 'high', pattern: 'F.1336-5 recommends 3.2', mode: c.mode, avg: c.avg,
    G0: c.G0, phi3: c.phi3, theta3: c.theta3, theta3Source: c.theta3Source,
    // 式 (48a)(48b)：方位边界角 φth，峰值 φ3、平均 1.152φ3（recommends 3.2.2 末句同）
    phiTh: c.avg ? 1.152 * c.phi3 : c.phi3,
    phi3At180, xBreak: c.avg ? 1.152 : 1, psiAlphaRule: rule, warnings
  };
}

/**
 * 方位方向的等效 3 dB 波束宽度 φ3m（度）。
 *   recommends 3.2.1 式 (2d6)：φ3m = φ3                                              0 ≤ |φ| ≤ φth
 *   式 (2d7) / 附件 6 式 (49)：φ3m = 1/√((cos(u)/φ3)² + (sin(u)/φ3(180))²)，u = 90·(|φ| − φth)/(180 − φth)   φth < |φ| ≤ 180°
 *   （正文 (2d7) 正弦项分母写 θ3，即式 (46) 的缺省 φ3(180) = θ3。）
 * φ3m 在 φth 处连续（u = 0），在 ±180° 处等于 φ3(180)。
 */
function phi3m(absPhiDeg, P) {
  if (absPhiDeg <= P.phiTh) return P.phi3;
  const u = (absPhiDeg - P.phiTh) / (180 - P.phiTh) * 90 * D2R;
  const a = Math.cos(u) / P.phi3, b = Math.sin(u) / P.phi3At180;
  return 1 / Math.sqrt(a * a + b * b);
}

/**
 * 背面俯仰面（|φ| = 180°、90° < ψ ≤ 180°，θ = 180° − ψ）的等效波束宽度 θ3m（度）。附件 6 式 (51)：
 *   θ3m = 1/√((cosθ/φ3(180))² + (sinθ/θ3)²)，从 ψ = 90° 处的 θ3 渐变到 ψ = 180° 处的 φ3(180)。
 * 计算里不单独用它：式 (52) 在 |φ| = 180°（φ3m = φ3(180)）时正好化成本式；φ3(180) = θ3（式 (46) 缺省）时恒为 θ3。
 */
function theta3m(thetaDeg, P) {
  const t = thetaDeg * D2R;
  const a = Math.cos(t) / P.phi3At180, b = Math.sin(t) / P.theta3;
  return 1 / Math.sqrt(a * a + b * b);
}

/**
 * 6–70 GHz 的离轴归一化：返回 { psi, psiAlpha, phi3m, x }（角度单位度）。
 *   式 (2d4) ψ = arccos(cosφ·cosθ)（数值上用等价的 atan2(√(y² + z²), x)，主瓣附近不丢精度）
 *   式 (2d2) α = arctan(tanθ / sinφ)；只用到 cos²α = y²/(y² + z²)、sin²α = z²/(y² + z²)，
 *            其中 x = cosθcosφ、y = cosθsinφ、z = sinθ（附件 3 图 18：α 是过视轴与该方向的切面相对水平面的倾角）
 *   式 (2d3) / 附件 6 式 (50)：ψ ≤ 90°  ψα = 1/√((cosα/φ3m)² + (sinα/θ3)²)（psiAlphaRule 'mainText' 时用 φ3）
 *   式 (2d3) / 附件 6 式 (52)：ψ > 90°  ψα = 1/√((cosθ/φ3m)² + (sinθ/θ3)²)
 *   式 (2d5) x = ψ / ψα
 * @param {number} phiDeg, thetaDeg  天线坐标（已做过倾角换算）
 * @param {object} P  sectoralHighParams 的返回值（不再校验）
 */
function sectoralHighX(phiDeg, thetaDeg, P) {
  const ph = phiDeg * D2R, th = thetaDeg * D2R;
  const ct = Math.cos(th), st = Math.sin(th);
  const x = ct * Math.cos(ph), y = ct * Math.sin(ph), z = st;
  const r2 = y * y + z * z;
  const psi = Math.atan2(Math.sqrt(r2), x) * R2D;                     // 式 (2d4)
  const p3m = phi3m(Math.abs(phiDeg), P);                             // 式 (2d6)(2d7)
  if (r2 === 0) return { psi: 0, psiAlpha: P.phi3, phi3m: p3m, x: 0 };  // 正视轴（ψ = 0）：α 无定义，x = 0
  let psiAlpha;
  if (psi <= 90) {
    const pa = P.psiAlphaRule === 'mainText' ? P.phi3 : p3m;          // 正文 (2d3) 写 φ3；附件 6 式 (50) 写 φ3m
    const c2 = y * y / r2, s2 = z * z / r2;                           // cos²α、sin²α，式 (2d2)
    psiAlpha = 1 / Math.sqrt(c2 / (pa * pa) + s2 / (P.theta3 * P.theta3));
  } else {
    const a = ct / p3m, b = st / P.theta3;                            // 附件 6 式 (52)：不依赖 α，只依赖 θ
    psiAlpha = 1 / Math.sqrt(a * a + b * b);
  }
  return { psi, psiAlpha, phi3m: p3m, x: psi / psiAlpha };            // 式 (2d5)
}

/**
 * 6–70 GHz 参考增益 Gref(x)（dBi）。
 *   峰值 recommends 3.2.1 式 (2e)：G0 − 12x²（0 ≤ x < 1）；G0 − 12 − 15lg x（1 ≤ x）——x = 1 处连续
 *   平均 recommends 3.2.2 式 (2f)：G0 − 12x²（0 ≤ x < 1.152）；G0 − 15 − 15lg x（1.152 ≤ x）——1.152 处 +0.0035 dB 台阶
 */
function Gref(x, G0, mode) {
  const xx = Number(x), g = Number(G0);
  if (!(xx >= 0) || !Number.isFinite(xx)) return fail('x 须 ≥ 0');
  if (!Number.isFinite(g)) return fail('G0 须为有限数（dBi）');
  if (mode != null && mode !== 'peak' && mode !== 'average') return fail("mode 只认 'peak' / 'average'");
  if (mode === 'average') return xx < 1.152 ? g - 12 * xx * xx : g - 15 - 15 * LOG10(xx);
  return xx < 1 ? g - 12 * xx * xx : g - 12 - 15 * LOG10(xx);
}

// 6–70 GHz 合成：天线坐标 (φ, θ)。recommends 3.2.1 式 (2d1)：G(φ, θ) = Gref(x)
function sectoralHighCore(phiDeg, thetaDeg, P) {
  const x = sectoralHighX(phiDeg, thetaDeg, P).x;
  return P.avg
    ? (x < 1.152 ? P.G0 - 12 * x * x : P.G0 - 15 - 15 * LOG10(x))    // 式 (2f)
    : (x < 1 ? P.G0 - 12 * x * x : P.G0 - 12 - 15 * LOG10(x));        // 式 (2e)
}

// ---------------------------------------------------------------------------
// 扇区天线统一入口（含 recommends 3.4 机械倾、3.5 电倾）
// ---------------------------------------------------------------------------

/**
 * 扇区天线预解析版。
 * @param {object} opts
 * @param {'low'|'high'} [opts.band]   'low' = recommends 3.1（0.4–6 GHz），'high' = 3.2（6–70 GHz）；缺省按 fGHz（< 6 → low）
 * @param {number} [opts.fGHz]
 * @param {number} opts.G0, opts.phi3, [opts.theta3], [opts.mode='peak']
 * @param {'typical'|'improved'|'imt'} [opts.type='typical']  仅 low 段用（表 4）
 * @param {{kh?, kv?, kp?, ka?}} [opts.params]                 仅 low 段用
 * @param {number} [opts.phi3At180], [opts.fbr], [opts.psiAlphaRule]  仅 high 段用，见 sectoralHighParams
 * @param {number} [opts.mechTiltDeg=0]  机械下倾 β（度，向下为正）——recommends 3.4 式 (3b)(3c)
 * @param {number} [opts.elecTiltDeg=0]  电下倾 β（度，向下为正）——recommends 3.5 用式 (1e)；与机械倾的组合次序见头注 ③
 * @returns {object|{error}} P（sectoralLowParams / sectoralHighParams 的全部字段）+ { mechTiltDeg, elecTiltDeg,
 *          gain:(phiHDeg, thetaHDeg) => number|{error} }
 *   gain 的入参是站址水平坐标：φh 自天线最大增益方位起算，θh 自水平面起算。不倾时即天线坐标 (φ, θ)。
 */
function makeSectoral(opts) {
  const o = opts || {};
  let band = o.band;
  if (band == null) {
    if (o.fGHz == null) return fail('须给 band（low / high）或 fGHz');
    const f = Number(o.fGHz);
    if (!(f > 0) || !Number.isFinite(f)) return fail('fGHz 须为正数');
    band = f < 6 ? 'low' : 'high';
  } else if (band !== 'low' && band !== 'high') {
    return fail("band 只认 'low'（0.4–6 GHz）/ 'high'（6–70 GHz）");
  }
  const P = band === 'low' ? sectoralLowParams(o) : sectoralHighParams(o);
  if (P.error) return P;

  const mech = optNum(o.mechTiltDeg, 0);
  const elec = optNum(o.elecTiltDeg, 0);
  if (!(Math.abs(mech) < 90)) return fail('机械下倾须在 (−90°, 90°)');
  if (!(Math.abs(elec) < 90)) return fail('电下倾须在 (−90°, 90°)');
  const cb = Math.cos(mech * D2R), sb = Math.sin(mech * D2R);
  const core = band === 'low' ? sectoralLowCore : sectoralHighCore;

  P.mechTiltDeg = mech;
  P.elecTiltDeg = elec;
  P.gain = function (phiHDeg, thetaHDeg) {
    let ph = wrapAz(Number(phiHDeg));
    let th = normElev(Number(thetaHDeg));
    if (Number.isNaN(ph)) return fail('方位须为有限数');
    if (Number.isNaN(th)) return fail('仰角须在 −90°…90°');
    if (mech !== 0) {
      // recommends 3.4：站址水平坐标 → 机械倾斜后的天线坐标（式 (40)(41)(42)，与 tiltToAntennaFrame 同式）
      const t = th * D2R, p = ph * D2R;
      const zh = Math.sin(t), ct = Math.cos(t);
      const xh = ct * Math.cos(p), y = ct * Math.sin(p);
      const z = zh * cb + xh * sb, x = -zh * sb + xh * cb;
      th = Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D;
      ph = Math.atan2(y, x) * R2D;
    }
    if (elec !== 0) {
      // recommends 3.5：用式 (1e) 的 θe 代替 θ
      const s = th + elec;
      th = s >= 0 ? 90 * s / (90 + elec) : 90 * s / (90 - elec);
    }
    return core(ph, th, P);
  };
  return P;
}

/**
 * 扇区天线单点增益（dBi）。opts 同 makeSectoral，另加 phiDeg（φh）、thetaDeg（θh）。
 * 热路径请用 makeSectoral 预解析。
 */
function sectoral(opts) {
  const m = makeSectoral(opts);
  if (m.error) return m;
  const o = opts || {};
  return m.gain(o.phiDeg, o.thetaDeg);
}

// ---------------------------------------------------------------------------
// recommends 4.1 · 低增益定向天线（1–3 GHz，圆对称，主瓣增益 ≲ 20 dBi）
// ---------------------------------------------------------------------------

/**
 * 式 (4) 的三个角度（度）：φ3 = √(27000 × 10^(−0.1·G0))，φ1 = 1.9φ3，φ2 = φ1 × 10^((G0 − 6)/32)。
 * @returns {{phi3, phi1, phi2}|{error}}
 */
function lowGainBeamwidths(G0) {
  const g = Number(G0);
  if (!Number.isFinite(g)) return fail('G0 须为有限数（dBi）');
  const phi3 = Math.sqrt(27000 * Math.pow(10, -0.1 * g));
  const phi1 = 1.9 * phi3;
  return { phi3, phi1, phi2: phi1 * Math.pow(10, (g - 6) / 32) };
}

// 式 (4) 本体：a 为离轴角（0…180°），b 为 lowGainBeamwidths 的结果
function lowGainCore(G0, a, b) {
  if (a < 1.08 * b.phi3) { const r = a / b.phi3; return G0 - 12 * r * r; }  // 0 ≤ θ < 1.08φ3
  if (a < b.phi1) return G0 - 14;                                          // 1.08φ3 ≤ θ < φ1
  if (a < b.phi2) return G0 - 14 - 32 * LOG10(a / b.phi1);                 // φ1 ≤ θ < φ2
  return -8;                                                               // φ2 ≤ θ ≤ 180°
}

/**
 * 低增益天线预解析版。G0 < 6 dBi 时 φ2 < φ1、分段失序，返回 { error }（头注 ⑤）；G0 > 20 dBi 记 warning
 * （recommends 4 / Note 7：主要适用 ≤ 20 dBi，更高增益用 F.699）。
 * @returns {{pattern, G0, phi3, phi1, phi2, warnings, gain:(offAxisDeg:number)=>number|{error}}|{error}}
 */
function makeLowGain(opts) {
  const o = opts || {};
  const G0 = Number(o.G0);
  if (!Number.isFinite(G0)) return fail('G0 须为有限数（dBi）');
  if (G0 < 6) return fail(`G0 = ${G0} dBi < 6 dBi：式 (4) 的 φ2 < φ1，分段失序`);
  const b = lowGainBeamwidths(G0);
  const warnings = [];
  if (G0 > 20) warnings.push(`G0 = ${G0} dBi > 20 dBi：超出 recommends 4 适用范围`);
  return {
    pattern: 'F.1336-5 recommends 4.1', G0, phi3: b.phi3, phi1: b.phi1, phi2: b.phi2, warnings,
    gain(offAxisDeg) {
      const v = Number(offAxisDeg);
      if (!Number.isFinite(v)) return fail('离轴角须为有限数');
      let a = Math.abs(v);                       // 离轴角本无符号；负值按绝对值处理
      if (a > 180) {
        if (a > 180 + ANG_TOL) return fail('离轴角须在 0°…180°');
        a = 180;
      }
      return lowGainCore(G0, a, b);
    }
  };
}

/** 低增益天线单点增益（dBi）。opts = { G0, offAxisDeg }。 */
function lowGain(opts) {
  const m = makeLowGain(opts);
  if (m.error) return m;
  return m.gain((opts || {}).offAxisDeg);
}

module.exports = {
  // 全向（recommends 2）
  omniTheta3, omniTheta4, omniTheta5, omniK, omni, makeOmni,
  // 倾角（recommends 2.5 / 3.4 / 3.5，附件 5）
  electricalTiltElevation, tiltToAntennaFrame,
  // 扇区公共（recommends 3.3、附件 7 表 4）
  sectoralTheta3, SECTORAL_K, sectoralK, sectoral, makeSectoral,
  // 扇区 0.4–6 GHz 积木（recommends 3.1）
  G180, sectoralLowParams, Ghr, Gvr, compressionRatio,
  // 扇区 6–70 GHz 积木（recommends 3.2、附件 6）
  phi3At180FromFbr, sectoralHighParams, phi3m, theta3m, sectoralHighX, Gref,
  // 低增益（recommends 4.1）
  lowGainBeamwidths, lowGain, makeLowGain
};
