// 宇宙空间效果（地图设置 · 宇宙空间）：星空 / 大气辉光 / 太阳 三件 + 一个地球遮挡球。
// 普通球面视图与跟随卫星视图同一套（前身 followFx.js 只在跟随时画；2026-09-24 用户改成地图设置里的开关，跟随只改视角）。
//
// ── 拆开实现 ──
// 三件各有自己的几何 / 着色器 / 材质，各自 create / dispose、彼此不引用：关掉哪件就只放掉哪件的 GPU 资源，
// 一件都不开时 createSpaceFx 根本不会被建（scene.js 里总开关关 = spaceFx 为 null = 地球那一趟之后什么都不画）。
// createSpaceFx 只是编排器：按开关懒建三件、把星空 / 太阳的网格挂进同一个场景、一次 render 按 renderOrder 画完；
// 大气的网格挂进【地球场景】、在地球那一趟里画（见 ③ 节头注）。
//
// ── 画在哪 ──
// 全用地球相机、场景单位 = 地球半径。①②③ 在 scene.js 的【第二趟】（地球那一趟之后、叠加层之前），④ 在地球那一趟里：
//   ① 地球遮挡球：写深度不写颜色。半径 0.997 恒在地表之下 —— 地球那一趟写过深度的像素它必然测试不过，一个值都不改；
//      只在地球材质没写深度的像素上补一层。只在星空 / 太阳要画时画（大气在地球那一趟里，用不着它）。
//   ② 星空：银河带（开机烘一次的纹理，贴在银纬 ±24° 的带状网格上）+ 恒星（点精灵）。都钉在远平面、做深度测试 ——
//      地球、遮挡球、任何写了深度的东西（轨道线…）后面的星自然被挡掉，不必逐像素判「在不在地球背后」。
//   ③ 太阳：日面 + 紧贴的日冕（远平面上的一小片，深度测试：沉到地球背后就被挡掉）。
//   ④ 大气辉光：按视线与地球的几何逐像素解析求光学厚度（Chapman 近似，不步进 —— 无分层条纹、与分辨率无关），加法混合。
//      网格只取临边一圈（盘面 0.8R → 大气外沿；盘心那一大块不画 —— 全屏画一遍在集显 2× 渲染倍率下就吃掉 0.3 ms 的预算）。
//      挂在【地球那一趟】的不透明队列、底图之后与一切透明数据层之前：数据层叠在它上面，颜色不被染；片元深度解析地写、测深度。
//      星空 / 日面在第二趟里照样叠在它上面（它不写深度）。详见 ③ 节头注。
//   ⑤ 眩光（叠加层之后、最后画，见 renderGlare）：屏幕空间、只罩太阳周围一块，
//      强度 × 太阳在不在画面里 × 地球挡了多少 × 调用方给的外部系数（跟随视图里主星模型挡太阳）。
//
// ── 坐标 ──
// 场景轴 = ECEF (X, Z, −Y)。恒星 / 银河在惯性系（ICRS 赤经赤纬），每拍由 setTime 给 GMST：ECI → 地固 → 场景。
// 于是惯性视角下星空相对屏幕不动、地球在转 —— 与轨道圈同一口径。岁差（J2000 与历元之差 ~0.3°）画面上看不出，不做。
// 太阳方向由调用方按 terminator.solarGeometry 的日下点给（场景轴单位矢量）—— 与晨昏效果、晨昏线同一个太阳。
//
// ── 星表 ──
// 约 110 颗亮于 ~3 等的恒星（赤经 h / 赤纬 ° / V 星等 / B−V 色指数），取自公开星表常用值、精度到 0.01 h / 0.01°，
// 画面用途足够。更暗的星（3–6.8 等）按真实星等计数律 N(<m) ∝ 10^(0.46 m) 程序化生成、向银道面集中，
// 种子固定 —— 每次打开位置相同、绝不闪烁。
import * as THREE from 'three'

/** 软件光栅（SwiftShader / llvmpipe / 微软基本显示驱动…）：逐像素解析的大气与眩光太贵，只留星空与日面 */
export function isSoftwareRenderer(name) { return /swiftshader|llvmpipe|softpipe|basic render|software|warp/i.test(String(name || '')) }

// [赤经 h, 赤纬 °, V, B−V]
const BRIGHT = [
  [6.752, -16.716, -1.46, 0.00], [6.399, -52.696, -0.74, 0.15], [14.660, -60.834, -0.27, 0.71], [14.261, 19.182, -0.05, 1.23],
  [18.616, 38.784, 0.03, 0.00], [5.278, 45.998, 0.08, 0.80], [5.242, -8.202, 0.13, -0.03], [7.655, 5.225, 0.34, 0.42],
  [1.629, -57.237, 0.46, -0.16], [5.919, 7.407, 0.50, 1.85], [14.064, -60.373, 0.61, -0.23], [19.846, 8.868, 0.77, 0.22],
  [12.443, -63.099, 0.76, -0.24], [4.599, 16.509, 0.86, 1.54], [16.490, -26.432, 0.96, 1.83], [13.420, -11.161, 0.97, -0.23],
  [7.755, 28.026, 1.14, 1.00], [22.961, -29.622, 1.16, 0.09], [20.690, 45.280, 1.25, 0.09], [12.795, -59.689, 1.25, -0.24],
  [10.140, 11.967, 1.40, -0.11], [6.977, -28.972, 1.50, -0.21], [7.577, 31.888, 1.58, 0.03], [17.560, -37.104, 1.62, -0.22],
  [12.519, -57.113, 1.63, 1.59], [5.419, 6.350, 1.64, -0.21], [5.438, 28.608, 1.65, -0.13], [9.220, -69.717, 1.67, 0.00],
  [5.603, -1.202, 1.69, -0.18], [22.137, -46.961, 1.73, -0.13], [5.679, -1.943, 1.77, -0.21], [12.900, 55.960, 1.77, -0.02],
  [11.062, 61.751, 1.79, 1.07], [3.405, 49.861, 1.79, 0.48], [7.140, -26.393, 1.83, 0.68], [8.159, -47.337, 1.83, -0.22],
  [17.622, -42.998, 1.86, 0.40], [18.403, -34.385, 1.85, -0.03], [8.375, -59.510, 1.86, 1.28], [13.792, 49.313, 1.86, -0.19],
  [5.992, 44.948, 1.90, 0.08], [16.811, -69.028, 1.91, 1.44], [6.629, 16.399, 1.92, 0.00], [20.427, -56.735, 1.94, -0.20],
  [8.745, -54.709, 1.96, 0.04], [6.378, -17.956, 1.98, -0.23], [9.460, -8.659, 1.98, 1.44], [2.530, 89.264, 1.98, 0.60],
  [2.120, 23.463, 2.00, 1.15], [10.333, 19.842, 2.01, 1.13], [0.727, -17.987, 2.04, 1.02], [18.921, -26.297, 2.05, -0.13],
  [14.111, -36.370, 2.06, 1.01], [1.162, 35.621, 2.05, 1.58], [0.140, 29.091, 2.06, -0.11], [5.796, -9.670, 2.07, -0.18],
  [14.845, 74.156, 2.08, 1.47], [17.582, 12.560, 2.08, 0.15], [3.136, 40.956, 2.09, -0.05], [2.065, 42.330, 2.10, 1.37],
  [11.818, 14.572, 2.14, 0.09], [22.711, -46.885, 2.10, 1.60], [8.060, -40.003, 2.21, -0.27], [9.285, -59.275, 2.21, 0.18],
  [9.133, -43.433, 2.21, 1.66], [15.578, 26.715, 2.22, -0.02], [13.399, 54.925, 2.23, 0.02], [20.370, 40.257, 2.23, 0.67],
  [0.675, 56.537, 2.24, 1.17], [17.943, 51.489, 2.24, 1.52], [5.533, -0.299, 2.25, -0.22], [0.153, 59.150, 2.28, 0.34],
  [16.006, -22.622, 2.29, -0.12], [16.836, -34.293, 2.29, 1.15], [14.699, -47.388, 2.30, -0.15], [14.592, -42.158, 2.31, -0.19],
  [11.031, 56.382, 2.34, -0.02], [14.750, 27.074, 2.35, 0.97], [21.736, 9.875, 2.38, 1.52], [17.708, -39.030, 2.39, -0.22],
  [0.438, -42.306, 2.40, 1.09], [11.897, 53.695, 2.41, 0.04], [17.173, -15.725, 2.43, 0.06], [23.063, 28.083, 2.42, 1.67],
  [21.310, 62.586, 2.45, 0.22], [7.402, -29.303, 2.45, -0.08], [9.368, -55.011, 2.47, -0.14], [12.263, -17.542, 2.59, -0.11],
  [23.079, 15.205, 2.48, -0.04], [3.038, 4.090, 2.53, 1.64], [11.235, 20.524, 2.56, 0.12], [16.091, -19.806, 2.56, -0.07],
  [5.546, -17.822, 2.58, 0.21], [15.283, -9.383, 2.61, -0.11], [15.738, 6.426, 2.63, 1.17], [1.911, 20.808, 2.64, 0.13],
  [1.430, 60.235, 2.66, 0.13], [13.911, 18.398, 2.68, 0.58], [17.513, -37.296, 2.70, -0.22], [13.036, 10.959, 2.83, 0.94],
  [14.848, -16.042, 2.75, 0.15], [0.221, 15.184, 2.83, -0.23], [19.044, -29.880, 2.60, 0.08], [18.350, -29.828, 2.70, 1.38],
  [18.466, -25.422, 2.81, 1.02], [21.784, -16.127, 2.85, 0.29], [19.771, 10.613, 2.72, 1.52], [19.512, 27.960, 3.05, 1.13],
  [0.945, 60.717, 2.47, -0.15], [1.907, 63.670, 3.37, -0.15], [14.073, 64.376, 3.65, -0.05], [12.252, -58.749, 2.79, -0.23],
  // 昴星团（肉眼能认出的一小撮）
  [3.791, 24.105, 2.87, -0.09], [3.819, 24.053, 3.62, -0.08], [3.747, 24.113, 3.70, -0.11], [3.763, 24.368, 3.87, -0.07],
  [3.772, 23.948, 4.18, -0.06], [3.754, 24.467, 4.30, -0.11]
]

// 银河坐标轴（ICRS 单位矢量）：北银极 α=192.8595°、δ=+27.1283°；银心 α=266.405°、δ=−28.936°
const NGP = [-0.86767, -0.19808, 0.45598]
const GCN = [-0.05487, -0.87344, -0.48384]
// 第三轴 Y = Z × X（l = 90° 指向天鹅座，α ≈ 21.2 h、δ ≈ +48°）
const GY = [NGP[1] * GCN[2] - NGP[2] * GCN[1], NGP[2] * GCN[0] - NGP[0] * GCN[2], NGP[0] * GCN[1] - NGP[1] * GCN[0]]

const D2R = Math.PI / 180
function radec(raH, decDeg, out, o) {
  const a = raH * 15 * D2R, d = decDeg * D2R
  out[o] = Math.cos(d) * Math.cos(a); out[o + 1] = Math.cos(d) * Math.sin(a); out[o + 2] = Math.sin(d)
}
// B−V → 线性 RGB（按黑体色温的近似，够画面用）
function bvColor(bv, out, o) {
  const t = Math.max(-0.4, Math.min(2.0, bv))
  let r, g, b
  if (t < 0.4) { r = 0.72 + 0.7 * (t + 0.4); g = 0.82 + 0.35 * (t + 0.4); b = 1.0 }
  else if (t < 1.0) { r = 1.0; g = 1.0 - 0.28 * (t - 0.4); b = 1.0 - 0.75 * (t - 0.4) }
  else { r = 1.0; g = 0.83 - 0.18 * (t - 1.0); b = 0.55 - 0.25 * (t - 1.0) }
  out[o] = Math.min(1, r); out[o + 1] = Math.min(1, g); out[o + 2] = Math.max(0.2, Math.min(1, b))
}

// 固定种子的伪随机（mulberry32）：星场每次一样、不闪
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const FAINT_N = 6000
/** 恒星几何（ICRS 单位矢量 + 颜色 + 星等）。导出给单测：亮星表逐颗、暗星数、种子不变 */
export function buildStarArrays() {
  const n = BRIGHT.length + FAINT_N
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), mag = new Float32Array(n)
  let k = 0
  for (const s of BRIGHT) { radec(s[0], s[1], pos, k * 3); bvColor(s[3], col, k * 3); mag[k] = s[2]; k++ }
  const R = rng(0x5a7e11)
  // 星等：在 [3.0, 6.8] 上按累计计数律 N(<m) ∝ 10^(0.46 m) 反演抽样
  const m0 = 3.0, m1 = 6.8, span = Math.pow(10, 0.46 * (m1 - m0)) - 1
  while (k < n) {
    const u = R(), v = R()
    const z = 2 * u - 1, ph = 2 * Math.PI * v, rr = Math.sqrt(1 - z * z)
    const x = rr * Math.cos(ph), y = rr * Math.sin(ph)
    // 向银道面集中：银纬 |b| 越小接受率越高（暗星在银河带上约是两极的 3 倍）
    const sb = x * NGP[0] + y * NGP[1] + z * NGP[2]
    const bDeg = Math.asin(Math.max(-1, Math.min(1, sb))) / D2R
    if (R() > 0.34 + 0.66 * Math.exp(-(bDeg * bDeg) / (18 * 18))) continue
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z
    mag[k] = m0 + Math.log10(1 + R() * span) / 0.46
    bvColor(-0.2 + R() * 1.6, col, k * 3)
    k++
  }
  return { pos, col, mag, nBright: BRIGHT.length }
}
/** 惯性系 → 场景轴（行主序 3×3）：先绕 Z 转 −gmst 到地固（xe = c·x + s·y，ye = −s·x + c·y），再 (X,Y,Z) → (X, Z, −Y) */
export function inertialToSceneRows(gmst) {
  const c = Math.cos(gmst), s = Math.sin(gmst)
  return [c, s, 0, 0, 0, 1, s, -c, 0]
}

// ======================================================================================
// GLSL 共用片段
// ======================================================================================
// 抖动：全屏的柔和渐变（日冕、眩光、银河、大气）在 8 位帧缓冲里会断成一圈圈色阶，加 ±0.5 LSB 的像素噪声打散
const DITHER_GLSL = `
float dither8(vec2 p) { return (fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0; }`
// 远平面钉法：只用方向（w=0 走视图变换的旋转部分）→ 当作视空间里距离 1 的点投影，z 钉到远平面前一丝
const FAR_GLSL = `
vec4 farClip(vec3 d) {
  vec4 v = viewMatrix * vec4(d, 0.0);
  vec4 p = projectionMatrix * vec4(v.xyz, 1.0);
  p.z = p.w * 0.99999;
  return p;
}`
const NOISE_GLSL = `
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }`
const v3 = (a) => `vec3(${a.map((x) => x.toFixed(6)).join(', ')})`

// ======================================================================================
// ① 地球遮挡球
// ======================================================================================
export const OCCLUDER_R = 0.997
function createOccluder() {
  const geo = new THREE.SphereGeometry(OCCLUDER_R, 96, 48)
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = -100
  mesh.frustumCulled = false
  return { objects: [mesh], dispose() { geo.dispose(); mat.dispose() } }
}

// ======================================================================================
// ② 星空：银河带 + 恒星
// ======================================================================================
const MW_BAND = 24 * D2R        // 银河带网格半宽（银纬）：带内亮度 exp(−(sin b / 0.15)²) 在 24° 处 < 2e-3
const MW_W = 2048, MW_H = 192   // 烘焙纹理（银经 × 银纬）：~5.7 px/° × 4.4 px/°，比 fbm 的最细一档（~2.5°）密一倍以上
const MW_SCALE = 1.25           // 烘焙时除以它（mw 峰值 ~1.15），显示时乘回
const MW_GAIN = 0.1             // 银河整体亮度（与跟随视图时代的 uMilky 同值）
const MW_BAKE_FRAG = `
uniform float uBand;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  float l = vUv.x * 6.28318530718;
  float b = (vUv.y * 2.0 - 1.0) * uBand;
  vec3 di = ${v3(GCN)} * (cos(b) * cos(l)) + ${v3(GY)} * (cos(b) * sin(l)) + ${v3(NGP)} * sin(b);
  float sb = sin(b), gc = cos(b) * cos(l);
  float band = exp(-(sb * sb) / (0.15 * 0.15));
  float core = smoothstep(-0.2, 1.0, gc);
  float cloud = fbm(di * 7.0) * 0.8 + fbm(di * 23.0) * 0.35;
  float dust = smoothstep(0.35, 0.75, fbm(di * 11.0 + 3.1));   // 暗带：银河中线附近的尘埃裂缝
  float mw = band * (0.35 + 0.65 * core) * cloud * (1.0 - 0.55 * dust * exp(-(sb * sb) / (0.05 * 0.05)));
  // 银心方向偏暖（老年恒星）、盘面外侧偏冷：肉眼看银河是灰白里带一点黄
  vec3 col = mix(vec3(0.70, 0.78, 0.98), vec3(1.0, 0.90, 0.74), core * core) * mw;
  gl_FragColor = vec4(col / ${MW_SCALE.toFixed(2)}, 1.0);
}`
const MW_VERT = `
uniform mat3 uI2S;
varying vec2 vUv;
${FAR_GLSL}
void main() { vUv = uv; gl_Position = farClip(uI2S * position); }`
const MW_FRAG = `
uniform sampler2D uTex;
uniform float uGain;
varying vec2 vUv;
${DITHER_GLSL}
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * (${(MW_SCALE * MW_GAIN).toFixed(4)} * uGain);
  gl_FragColor = vec4(max(vec3(0.0), c + dither8(gl_FragCoord.xy) * step(0.0015, c.g)), 1.0);
}`
// 恒星：只用方向、钉在远平面
const STAR_VERT = `
attribute float mag;
uniform mat3 uI2S;
uniform float uPx;
uniform float uGain;
varying vec3 vCol;
${FAR_GLSL}
void main() {
  gl_Position = farClip(uI2S * position);
  float flux = pow(10.0, -0.4 * (mag - 1.0));                // 以 1 等星为 1
  // 亮度按流量的 0.35 次方压缩（人眼对星等近似对数响应；线性映射下 5 等以下全看不见，天空只剩几十颗）
  gl_PointSize = clamp(1.5 + 1.2 * sqrt(flux), 1.5, 5.5) * uPx;
  vCol = color * clamp(0.42 + 0.62 * pow(flux, 0.35), 0.36, 1.4) * uGain;
}`
const STAR_FRAG = `
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vCol * exp(-r2 * 2.5), 1.0);
}`
const FS_VERT = 'varying vec2 vNdc;\nvoid main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }'

// 银河带网格：银经 2° × 银纬 4° 一格，顶点 = ICRS 单位矢量，uv 与烘焙纹理同一套（u = l / 2π，v = (b / 半宽 + 1) / 2）
function mwBandGeometry() {
  const NU = 180, NV = 12
  const pos = new Float32Array((NU + 1) * (NV + 1) * 3), uv = new Float32Array((NU + 1) * (NV + 1) * 2)
  let k = 0
  for (let j = 0; j <= NV; j++) {
    const b = (j / NV * 2 - 1) * MW_BAND, cb = Math.cos(b), sb = Math.sin(b)
    for (let i = 0; i <= NU; i++) {
      const l = i / NU * 2 * Math.PI, cl = Math.cos(l), sl = Math.sin(l)
      for (let a = 0; a < 3; a++) pos[k * 3 + a] = GCN[a] * cb * cl + GY[a] * cb * sl + NGP[a] * sb
      uv[k * 2] = i / NU; uv[k * 2 + 1] = j / NV
      k++
    }
  }
  const idx = []
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1
    idx.push(a, b, d, a, d, c)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

export function createStarfield(renderer) {
  const I2S = { value: new THREE.Matrix3() }
  // —— 银河：开机烘一次（GPU 上跑那段 fbm，~1 ms），之后每帧只是一次纹理采样 ——
  const rt = new THREE.WebGLRenderTarget(MW_W, MW_H, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  rt.texture.wrapS = THREE.RepeatWrapping
  rt.texture.wrapT = THREE.ClampToEdgeWrapping
  {
    const q = new THREE.PlaneGeometry(2, 2)
    const m = new THREE.ShaderMaterial({ uniforms: { uBand: { value: MW_BAND } }, vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: MW_BAKE_FRAG, depthTest: false, depthWrite: false })
    const sc = new THREE.Scene(), o = new THREE.Mesh(q, m)
    o.frustumCulled = false; sc.add(o)
    const prev = renderer.getRenderTarget(), ac = renderer.autoClear
    try {
      renderer.setRenderTarget(rt)
      renderer.autoClear = true
      renderer.render(sc, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1))
    } finally { renderer.setRenderTarget(prev); renderer.autoClear = ac }
    q.dispose(); m.dispose()
  }
  const mwGeo = mwBandGeometry()
  const mwU = { uI2S: I2S, uTex: { value: rt.texture }, uGain: { value: 1 } }
  const mwMat = new THREE.ShaderMaterial({ uniforms: mwU, vertexShader: MW_VERT, fragmentShader: MW_FRAG, side: THREE.DoubleSide,
    depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false })
  const mw = new THREE.Mesh(mwGeo, mwMat)
  mw.frustumCulled = false
  mw.renderOrder = 1
  // —— 恒星 ——
  const S = buildStarArrays()
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(S.pos, 3))
  starGeo.setAttribute('color', new THREE.BufferAttribute(S.col, 3))
  starGeo.setAttribute('mag', new THREE.BufferAttribute(S.mag, 1))
  const starU = { uI2S: I2S, uPx: { value: 1 }, uGain: { value: 1 } }
  const starMat = new THREE.ShaderMaterial({ uniforms: starU, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, vertexColors: true,
    depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false })
  const stars = new THREE.Points(starGeo, starMat)
  stars.frustumCulled = false
  stars.renderOrder = 2
  let gain = 1, gmst = NaN
  function setGmst(g) {
    if (!Number.isFinite(g) || g === gmst) return
    gmst = g
    I2S.value.set(...inertialToSceneRows(g))
  }
  setGmst(0)
  return {
    objects: [mw, stars],
    setStyle(o) { if (o && Number.isFinite(Number(o.gain))) gain = Math.max(0, Math.min(4, Number(o.gain))) },
    setGmst,
    /** dim：太阳在画面里时人眼被晃，恒星与银河整体压暗（0..1，NASA Eyes 同样如此） */
    update(r, dim) {
      starU.uPx.value = r.getPixelRatio()
      const g = gain * (1 - 0.6 * Math.max(0, Math.min(1, dim || 0)))
      starU.uGain.value = g
      mwU.uGain.value = g
    },
    stats: () => ({ stars: S.pos.length / 3, bright: S.nBright, gain }),
    dispose() { rt.dispose(); mwGeo.dispose(); mwMat.dispose(); starGeo.dispose(); starMat.dispose() }
  }
}

// ======================================================================================
// ③ 大气辉光
// ======================================================================================
// 画在【地球那一趟】里（2026-09-24 审查后从第二趟挪过来）：
//   第二趟在一切之后加法叠上去时，盘面临边那一圈会把地球那一趟里的数据层 —— GRD 填充 / 等值线、聚焦足迹、国界、地名、标记 ——
//   一起染蓝（临边一条红色 GEO 覆盖线直接变紫），与夜区壳「打光不是数据，不该把覆盖场和等值线一起蒙」同一条口径不合。
//   现在它挂进地球场景、排在【不透明队列】里底图（海洋球 / 陆地 / 影像 renderOrder 0；影像瓦片组序 −2 / −1）之后：
//   先于一切透明数据层（多边形填充 4 / 夜区 4.5 / 覆盖 5 / 线 6 / 标签…）画上，数据层叠在它上面、颜色一个值都不被改。
//   ★ 整圈（盘面薄雾 + 临边外沿）是【同一块网格、同一个连续函数】，不拆成两截分两趟画：拆开的话接缝 p = 1 那一圈像素
//     在 MSAA 下只在像素中心求一次值 —— 中心落在哪一截，另一截盖住的那几个采样就拿到 0，实测接缝一圈掉一半亮度（一条暗线）。
//   深度：测深度、不写深度，片元深度【解析地写】（gl_FragDepth）—— 视线撞地（或擦过壳）的取它与半径 ATMO_DEPTH_R 的壳的交点
//   （比陆地面 / 岸线国界都高，恒在底图之前）、擦过地球的取视线进入大气外沿（1 + 8H）的那一点（临边那一像素里的地面采样
//   都比它远，不会在临边啃出一圈暗缝）、背向地球的（相机就在大气里）钉最近。于是挡在它前面的不透明物（卫星点）挡得住它，
//   壳格子与底图互穿的老问题（夜区壳那段注）在这里根本不存在（不是网格，是逐像素求交）。
//
// 可见标高：真实 7.6 km 标高（0.0012 个地球半径）在全球视角下只剩亚像素的一根细线 ——
// 按「临边处 ATMO_PX 个屏幕像素」兜底：远看是一圈柔光，近看（跟随低轨星）退回真实标高、贴边一条薄蓝线。
export const ATMO_PX = 4
export const ATMO_H_MIN = 0.0012
export const ATMO_H_MAX = 0.05
export const ATMO_P_IN = 0.8     // 盘面上的薄雾只留临边一圈：视线的撞击参数（到地心的最近距离）≥ 0.8R 起渐入
/** 深度壳半径：与夜区壳同值（比陆地面 1.0003–1.0004、岸线国界 1.0004–1.0005 都高） */
export const ATMO_DEPTH_R = 1.0008
/** 不透明队列里的次序：底图（renderOrder 0）之后、其余不透明物之前；透明数据层（最低 4）一律在它之后 */
export const ATMO_EARTH_ORDER = 0.5
/** 临边处的可见标高（地球半径）：D = 相机到地心距离，fovDeg 竖直视场，hPx 视口高（CSS 像素） */
export function atmoScaleHeight(D, fovDeg, hPx) {
  const dLimb = Math.sqrt(Math.max(1e-9, D * D - 1))
  const pxAng = 2 * Math.tan(fovDeg * Math.PI / 360) / Math.max(1, hPx)
  return Math.max(ATMO_H_MIN, Math.min(ATMO_H_MAX, ATMO_PX * pxAng * dLimb))
}
/** 大气外沿（光学厚度降到 1/255 以下的半径）：切向整条路径 τ ∝ e^(−x/H)，τ₀ 取 3 → x ≈ 6.6 H，留到 8 H */
export const atmoOuterR = (H) => 1 + 8 * H
/** 临边环带在「过地心、垂直于视轴的平面」上的内外半径：该平面上半径 ρ 的点对相机张角 atan(ρ/D)，撞击参数 p ↔ 张角 asin(p/D) */
export function atmoRingRadii(D, H) {
  const Ro = Math.min(atmoOuterR(H), 0.9995 * D)
  const t = (p) => p / Math.sqrt(1 - (p * p) / (D * D))
  return { rin: t(ATMO_P_IN), rout: t(Ro), inside: D <= atmoOuterR(H) * 1.002 }
}
const ATMO_GLSL = `
uniform vec3 uCam;
uniform vec3 uSun;
uniform float uH;
uniform float uK;
uniform float uGain;
uniform mat4 projectionMatrix;   // three 的片元前缀只给 viewMatrix；声明了它就会照常灌（程序级 uniform）
${DITHER_GLSL}
vec3 atmoShade(vec3 n, vec3 d, float tau, float w) {
  float s = dot(n, uSun);
  float day = smoothstep(-0.20, 0.16, s);                          // 昼夜不对称：夜侧几乎没有
  vec3 col = mix(vec3(1.0, 0.46, 0.20), vec3(0.28, 0.55, 1.0), smoothstep(-0.06, 0.32, s));   // 晨昏线附近偏暖
  float ph = 1.0 + 1.1 * pow(max(dot(d, uSun), 0.0), 6.0);          // 朝太阳的前向散射增亮
  float a = 1.0 - exp(-uK * tau);
  return col * (a * w * (0.03 + 0.97 * day) * ph * uGain);
}
float depthOf(vec3 p) {
  vec4 c = projectionMatrix * (viewMatrix * vec4(p, 1.0));
  return clamp(0.5 + 0.5 * c.z / c.w, 0.0, 0.99999);
}
// 一个片元：颜色 + 解析深度（见节头注）
void atmoFrag(vec3 d) {
  vec3 o = uCam;
  float b = dot(o, d), c2 = dot(o, o);
  float p2 = max(0.0, c2 - b * b);
  const float RB2 = ${(ATMO_DEPTH_R * ATMO_DEPTH_R).toFixed(8)};
  vec3 g = vec3(0.0);
  float z = 0.0;
  if (b < 0.0 && p2 < 1.0) {
    // 视线撞到地面：斜穿大气，掠射极限 ≈ 半条切向路径
    float th = -b - sqrt(1.0 - p2);
    vec3 n = normalize(o + d * th);
    float mu = max(0.0, -dot(d, n));
    // 盘面薄雾只留临边一圈（撞击参数 ${ATMO_P_IN} → 1 渐入）：按放大后的可见标高算，盘心会蒙上一层 ~9% 的蓝，压在工程底图上就是一层纱
    g = atmoShade(n, d, uH / (mu + sqrt(uH * 0.5 / 3.14159265)), smoothstep(${ATMO_P_IN.toFixed(3)}, 1.0, sqrt(p2)));
    z = depthOf(o + d * max(0.0, -b - sqrt(RB2 - p2)));
  } else if (b < 0.0) {
    // 擦过地球：整条切向路径（p → 1 时与上一支同值 √(2πH)，连续）
    float pc = sqrt(p2);
    g = atmoShade((o + d * (-b)) / pc, d, sqrt(6.28318531 * pc * uH) * exp(-(pc - 1.0) / uH), 1.0);
    // 深度取视线进入大气外沿（1 + 8H）的那一点：临边一像素里同时有地面采样（撞地、比切点近）时，这里仍比它们近、
    // 不会被地面采样挡掉而在临边留一圈暗缝；在外沿之外（更近）的不透明物照样挡得住它。相机已在外沿之内 → 钉最近。
    float ro = 1.0 + 8.0 * uH;
    float te = -b - sqrt(max(0.0, ro * ro - p2));
    z = te > 0.0 ? depthOf(o + d * te) : 0.0;
  } else {
    // 背向地球往外看（相机在大气里 / 贴着大气）：相机上方残余的一点点 —— 就在相机周围，深度钉最近
    vec3 n = normalize(o);
    float h = sqrt(c2) - 1.0;
    g = atmoShade(n, d, uH * exp(-h / uH) / (max(dot(d, n), 0.0) + 0.03), 1.0);
    z = 0.0;
  }
  gl_FragColor = vec4(max(vec3(0.0), g + dither8(gl_FragCoord.xy) * step(0.002, g.b)), 1.0);
  gl_FragDepth = z;
}`
// 环带：顶点只带 (θ, t)，位置在着色器里按每帧的轴与半径现算（几何恒不变、不重传）
const ATMO_RING_VERT = `
attribute vec2 aRing;
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uRin;
uniform float uRout;
varying vec3 vW;
void main() {
  vec3 p = (uE1 * cos(aRing.x) + uE2 * sin(aRing.x)) * mix(uRin, uRout, aRing.y);
  vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_Position.z = 0.0;   // 深度由片元解析地写；这里 z 钉 0 只为环带所在的平面（过地心）不被远 / 近裁剪面切掉
}`
const ATMO_RING_FRAG = `
varying vec3 vW;
${ATMO_GLSL}
void main() { atmoFrag(normalize(vW - uCam)); }`
// 相机进了大气外沿之内（极贴地的机位）：环带不成立，退回全屏一片
const ATMO_FS_FRAG = `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec2 vNdc;
${ATMO_GLSL}
void main() {
  vec4 p = uInvProj * vec4(vNdc, 1.0, 1.0);
  p /= p.w;
  atmoFrag(normalize((uCamWorld * vec4(p.xyz, 0.0)).xyz));
}`
const RING_SEG = 256

export function createAtmosphere() {
  const U = {
    uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(1, 0, 0) },
    uH: { value: ATMO_H_MIN }, uK: { value: 30 }, uGain: { value: 1 },
    uE1: { value: new THREE.Vector3(1, 0, 0) }, uE2: { value: new THREE.Vector3(0, 1, 0) }, uRin: { value: 0.5 }, uRout: { value: 1.2 },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }
  }
  const ringGeo = new THREE.BufferGeometry()
  {
    const a = new Float32Array((RING_SEG + 1) * 2 * 2), idx = []
    for (let i = 0; i <= RING_SEG; i++) {
      const th = i / RING_SEG * 2 * Math.PI
      a[i * 4] = th; a[i * 4 + 1] = 0; a[i * 4 + 2] = th; a[i * 4 + 3] = 1
      if (i < RING_SEG) { const p = i * 2; idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3) }
    }
    ringGeo.setAttribute('aRing', new THREE.BufferAttribute(a, 2))
    ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_SEG + 1) * 2 * 3), 3))   // three 要求有 position；不参与计算
    ringGeo.setIndex(idx)
  }
  // transparent=false：进不透明队列（排在底图之后、全部透明数据层之前）。非 NormalBlending 的材质 three 照样开混合
  //（WebGLState.setMaterial 只在「Normal + 不透明」时关混合），加法照旧。测深度、不写深度，深度值由片元自己给。
  const mk = (vert, frag) => new THREE.ShaderMaterial({ uniforms: U, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide,
    depthTest: true, depthWrite: false, transparent: false, blending: THREE.AdditiveBlending, toneMapped: false })
  const ringMat = mk(ATMO_RING_VERT, ATMO_RING_FRAG)
  const fsMat = mk(FS_VERT, ATMO_FS_FRAG)
  const quad = new THREE.PlaneGeometry(2, 2)
  const ring = new THREE.Mesh(ringGeo, ringMat), fs = new THREE.Mesh(quad, fsMat)
  ring.frustumCulled = false; fs.frustumCulled = false
  ring.renderOrder = ATMO_EARTH_ORDER; fs.renderOrder = ATMO_EARTH_ORDER
  let gain = 1, lastH = ATMO_H_MIN, lastInside = false
  const _a = new THREE.Vector3(), _t = new THREE.Vector3()
  return {
    objects: [],               // 第二趟里没有它的东西
    earthObjects: [ring, fs],  // 地球那一趟（由编排器挂进地球场景）
    meshes: { ring, fs },
    setStyle(o) { if (o && Number.isFinite(Number(o.gain))) gain = Math.max(0, Math.min(4, Number(o.gain))) },
    setSun(v) { U.uSun.value.copy(v) },
    /** 每帧在地球那一趟【之前】调：标高、视轴、环带半径 */
    update(camera, w, h) {
      camera.updateMatrixWorld()
      const D = camera.position.length()
      const H = atmoScaleHeight(D, camera.fov, h)
      U.uH.value = H
      U.uK.value = 3.0 / Math.sqrt(2 * Math.PI * H)       // 切向整条路径的 1 − e^(−3) ≈ 0.95
      U.uGain.value = gain
      U.uCam.value.copy(camera.position)
      const R = atmoRingRadii(D, H)
      lastH = H; lastInside = R.inside
      ring.visible = !R.inside
      fs.visible = R.inside
      if (R.inside) {
        U.uInvProj.value.copy(camera.projectionMatrixInverse)
        U.uCamWorld.value.copy(camera.matrixWorld)
      } else {
        // 视轴（相机 → 地心）与它的两根垂轴：环带铺在过地心、垂直于视轴的平面上
        _a.copy(camera.position).multiplyScalar(-1 / D)
        _t.set(Math.abs(_a.x) < 0.9 ? 1 : 0, Math.abs(_a.x) < 0.9 ? 0 : 1, 0)
        U.uE1.value.crossVectors(_a, _t).normalize()
        U.uE2.value.crossVectors(_a, U.uE1.value).normalize()
        U.uRin.value = R.rin; U.uRout.value = R.rout
      }
    },
    stats: () => ({ H: lastH, inside: lastInside, gain }),
    dispose() { ringGeo.dispose(); quad.dispose(); ringMat.dispose(); fsMat.dispose() }
  }
}

// ======================================================================================
// ④ 太阳：日面 + 眩光
// ======================================================================================
const SUN_R_VIS = 0.008         // 日面画面角半径（rad）：真实 0.27° 在 42° 视场里只有 7 px，放大到 ~0.46°
const SUN_R_TRUE = 0.00465      // 真实角半径（rad），算地球遮挡的平滑带用
const SUN_QUAD = 0.07           // 日面那一片的半宽（切平面上，= tan 角）：日冕在它边上已衰到 ~2%，再窗函数收到 0
const GLARE_R = 0.9             // 眩光那一片的半径（屏幕，NDC 纵向单位）：宽晕 0.05·e^(−r/0.55) 在它边上只剩 ~1%
const SUN_DISC_VERT = `
uniform vec3 uSun;
uniform vec3 uE1;
uniform vec3 uE2;
varying vec2 vT;
${FAR_GLSL}
void main() {
  vT = position.xy * ${SUN_QUAD.toFixed(4)};
  gl_Position = farClip(uSun + uE1 * vT.x + uE2 * vT.y);   // 太阳方向处的切平面上一小片（平面 → 透视插值精确）
}`
const SUN_DISC_FRAG = `
varying vec2 vT;
${DITHER_GLSL}
void main() {
  float th = atan(length(vT));
  float disc = 1.0 - smoothstep(${(SUN_R_VIS * 0.92).toFixed(5)}, ${(SUN_R_VIS * 1.06).toFixed(5)}, th);
  float limb = sqrt(max(0.0, 1.0 - (th * th) / ${(SUN_R_VIS * SUN_R_VIS).toExponential(6)}));   // 临边昏暗
  vec3 col = vec3(1.0, 0.97, 0.92) * disc * (2.2 + 1.8 * limb);
  col += vec3(1.0, 0.93, 0.80) * (0.9 * exp(-th / 0.018)) * smoothstep(${SUN_QUAD.toFixed(3)}, ${(SUN_QUAD * 0.55).toFixed(4)}, th);
  gl_FragColor = vec4(max(vec3(0.0), col + dither8(gl_FragCoord.xy)), 1.0);
}`
const GLARE_VERT = `
uniform vec2 uSunNdc;
uniform float uAspect;
varying vec2 vNdc;
void main() {
  vNdc = uSunNdc + position.xy * vec2(${GLARE_R.toFixed(2)} / uAspect, ${GLARE_R.toFixed(2)});
  gl_Position = vec4(vNdc, 0.0, 1.0);
}`
// 柔光 + 四道细长的衍射芒（相机光阑的样子克制一点：细、短、随距离快速衰减）+ 一圈极淡的彩虹晕；边上窗函数收到 0
const GLARE_FRAG = `
uniform vec2 uSunNdc;
uniform float uAspect;
uniform float uVis;
varying vec2 vNdc;
${DITHER_GLSL}
void main() {
  vec2 dv = (vNdc - uSunNdc) * vec2(uAspect, 1.0);
  float r = length(dv);
  float ang = atan(dv.y, dv.x);
  vec3 c = vec3(1.0, 0.95, 0.86) * (0.55 * exp(-r / 0.028) + 0.16 * exp(-r / 0.16) + 0.05 * exp(-r / 0.55));
  c += vec3(1.0, 0.96, 0.88) * pow(abs(cos(2.0 * ang + 0.35)), 220.0) * exp(-r / 0.30) * 0.16;
  c += vec3(0.9, 0.95, 1.0) * exp(-pow((r - 0.30) / 0.03, 2.0)) * 0.012;
  vec3 g = c * uVis * smoothstep(${GLARE_R.toFixed(2)}, ${(GLARE_R * 0.6).toFixed(2)}, r);
  gl_FragColor = vec4(max(vec3(0.0), g + dither8(gl_FragCoord.xy) * step(0.002, g.r)), 1.0);
}`

/** 太阳盘被地球挡住的程度（0 全挡 … 1 全露）：相机看太阳的方向与看地心方向夹角 γ、地球角半径 ρ（含一点大气） */
export function sunEarthVisibility(camPos, sunS) {
  const D = Math.hypot(camPos.x, camPos.y, camPos.z)
  if (!(D > 1)) return 0
  const rho = Math.asin(Math.min(1, 1.004 / D))
  const cg = -(camPos.x * sunS.x + camPos.y * sunS.y + camPos.z * sunS.z) / D
  const gam = Math.acos(Math.max(-1, Math.min(1, cg)))
  const lo = rho - SUN_R_TRUE, hi = rho + SUN_R_TRUE + 0.004
  const t = Math.max(0, Math.min(1, (gam - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

export function createSunFx() {
  const sunS = new THREE.Vector3(1, 0, 0)
  const discU = { uSun: { value: sunS }, uE1: { value: new THREE.Vector3(0, 1, 0) }, uE2: { value: new THREE.Vector3(0, 0, 1) } }
  const quad = new THREE.PlaneGeometry(2, 2)
  const discMat = new THREE.ShaderMaterial({ uniforms: discU, vertexShader: SUN_DISC_VERT, fragmentShader: SUN_DISC_FRAG, side: THREE.DoubleSide,
    depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false })
  const disc = new THREE.Mesh(quad, discMat)
  disc.frustumCulled = false
  disc.renderOrder = 3
  const glareU = { uSunNdc: { value: new THREE.Vector2() }, uAspect: { value: 1 }, uVis: { value: 0 } }
  const glareMat = new THREE.ShaderMaterial({ uniforms: glareU, vertexShader: GLARE_VERT, fragmentShader: GLARE_FRAG,
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false })
  const glareMesh = new THREE.Mesh(quad, glareMat)
  glareMesh.frustumCulled = false
  const glareScene = new THREE.Scene()
  glareScene.add(glareMesh)
  let glare = 1
  const _v = new THREE.Vector3(), _p = new THREE.Vector4(), _t = new THREE.Vector3()
  // 太阳在不在画面里（出画后按离画框的距离淡出）；顺带把 NDC 写进眩光 uniform
  function screenVis(camera) {
    _v.copy(sunS).multiplyScalar(60).add(camera.position)
    _p.set(_v.x, _v.y, _v.z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix)
    if (_p.w <= 0) return 0
    const x = _p.x / _p.w, y = _p.y / _p.w
    glareU.uSunNdc.value.set(x, y)
    const m = Math.max(Math.abs(x), Math.abs(y))
    const t = Math.max(0, Math.min(1, (m - 1.0) / 0.35))
    return 1 - t * t * (3 - 2 * t)
  }
  return {
    objects: [disc],
    setStyle(o) { if (o && Number.isFinite(Number(o.glare))) glare = Math.max(0, Math.min(3, Number(o.glare))) },
    setSun(v) {
      sunS.copy(v)
      _t.set(Math.abs(v.x) < 0.9 ? 1 : 0, Math.abs(v.x) < 0.9 ? 0 : 1, 0)
      discU.uE1.value.crossVectors(sunS, _t).normalize()
      discU.uE2.value.crossVectors(sunS, discU.uE1.value).normalize()
    },
    /** 恒星压暗系数（0..1）：太阳在画面里、没被地球挡、且开着眩光时才晃眼 */
    dimFactor(camera) { return Math.min(1, glare) * screenVis(camera) * sunEarthVisibility(camera.position, sunS) },
    /** 眩光（叠加层之后）。extVis：外部遮挡系数（跟随视图里主星模型挡太阳）；返回实际强度（验证台读数） */
    renderGlare(r, camera, w, h, extVis) {
      if (!(glare > 0)) return 0
      const v = screenVis(camera) * sunEarthVisibility(camera.position, sunS) * Math.max(0, Math.min(1, extVis == null ? 1 : extVis)) * glare
      if (v < 0.003) return 0
      glareU.uVis.value = v
      glareU.uAspect.value = w / Math.max(1, h)
      const ac = r.autoClear
      r.autoClear = false
      try { r.render(glareScene, camera) } finally { r.autoClear = ac }
      return v
    },
    stats: () => ({ glare }),
    dispose() { quad.dispose(); discMat.dispose(); glareMat.dispose() }
  }
}

// ======================================================================================
// 编排器
// ======================================================================================
/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} [earthScene] 地球场景：大气挂进去、在地球那一趟里画（不给就不画大气）
 * 用法（scene.js）：setStars / setAtmosphere / setSun 传 null = 关（放掉该件的 GPU 资源），传 {…} = 开 + 样式；
 * setTime(太阳场景轴单位矢量, GMST) 每拍一次；每帧 prepare 在地球那一趟之前、renderMain 在它之后、renderGlare 在叠加层之后。
 */
export function createSpaceFx(renderer, earthScene) {
  const scene = new THREE.Scene()
  let occ = null, stars = null, atmo = null, sun = null, soft = null
  const sunS = new THREE.Vector3(1, 0, 0)
  let gmst = 0, lastGlare = 0
  const attach = (fx) => {
    for (const o of fx.objects) scene.add(o)
    if (fx.earthObjects && earthScene) for (const o of fx.earthObjects) earthScene.add(o)
    return fx
  }
  const detach = (fx) => {
    if (fx) {
      for (const o of fx.objects) scene.remove(o)
      if (fx.earthObjects && earthScene) for (const o of fx.earthObjects) earthScene.remove(o)
      fx.dispose()
    }
    return null
  }
  function weak() {
    if (soft !== null) return soft
    try {
      const gl = renderer.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      soft = isSoftwareRenderer(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    } catch { soft = false }
    return soft
  }
  function syncOcc() {
    const want = !!(stars || sun)
    if (want && !occ) occ = attach(createOccluder())
    else if (!want && occ) occ = detach(occ)
  }
  return {
    setStars(o) {
      if (!o) stars = detach(stars)
      else { if (!stars) { stars = attach(createStarfield(renderer)); stars.setGmst(gmst) } stars.setStyle(o) }
      syncOcc()
    },
    setAtmosphere(o) {
      if (!o || weak()) atmo = detach(atmo)    // 软件光栅：逐像素解析的大气太贵，不画
      else { if (!atmo) { atmo = attach(createAtmosphere()); atmo.setSun(sunS) } atmo.setStyle(o) }
    },
    setSun(o) {
      if (!o) sun = detach(sun)
      else { if (!sun) { sun = attach(createSunFx()); sun.setSun(sunS) } sun.setStyle(o) }
      syncOcc()
    },
    /** dir：太阳（场景轴单位矢量，THREE.Vector3 或 [x,y,z]）；g：GMST（rad） */
    setTime(dir, g) {
      if (dir) {
        if (dir.isVector3) sunS.copy(dir); else sunS.set(dir[0], dir[1], dir[2])
        sunS.normalize()
        if (atmo) atmo.setSun(sunS)
        if (sun) sun.setSun(sunS)
      }
      if (Number.isFinite(g)) { gmst = g; if (stars) stars.setGmst(g) }
    },
    any: () => !!(stars || atmo || sun),
    /** 地球那一趟【之前】：大气在那一趟里画，它的标高 / 视轴 / 环带半径要先按本帧相机摆好 */
    prepare(camera, w, h) { if (atmo) atmo.update(camera, w, h) },
    renderMain(r, camera, w, h) {
      if (!stars && !sun) return   // 大气在地球那一趟里画（prepare 摆好），这一趟只有星空 / 日面
      camera.updateMatrixWorld()
      if (stars) stars.update(r, sun ? sun.dimFactor(camera) : 0)
      const ac = r.autoClear
      r.autoClear = false
      try { r.render(scene, camera) } finally { r.autoClear = ac }
    },
    renderGlare(r, camera, w, h, extVis) {
      lastGlare = sun && !weak() ? sun.renderGlare(r, camera, w, h, extVis) : 0
      return lastGlare
    },
    /** 验证台 / 调试读数 */
    stats: () => ({ stars: stars ? stars.stats() : null, atmo: atmo ? atmo.stats() : null, sun: sun ? sun.stats() : null, occluder: !!occ, glare: lastGlare, soft: weak() }),
    sunDir: () => [sunS.x, sunS.y, sunS.z],
    /** 验证台量帧时用：大气的两块网格（环带 ring / 贴进大气时的全屏 fs，都在地球场景里） */
    _atmoMeshes: () => (atmo ? atmo.meshes : null),
    dispose() { occ = detach(occ); stars = detach(stars); atmo = detach(atmo); sun = detach(sun) }
  }
}

// ======================================================================================
// 设置口径（地图设置 · 宇宙空间）：出厂值、取值范围与存档迁移 —— 页面与单测共用这一份
// ======================================================================================
/** 出厂值：总开关另存（出厂关）；打开总开关即得完整效果（前五项勾、晨昏线不勾）。
 *  地球影像 = 原「影像底图」并进来（2026-09-24 用户定）：档位 / 亮度仍存在页面的 imagery.k / bright，这里只管勾不勾。
 *  shadeColor / shadeOpacity：晨昏线自带的夜区阴影（硬边、整个夜半球一个不透明度，v1.4.13「夜区遮罩」的出厂值）——
 *  只在晨昏效果【不勾】时画；晨昏效果勾着时夜区由它接管（柔和过渡带），不叠两层。强度 0 = 只剩线 */
export const SPACE_DEF = Object.freeze({
  stars: true, starGain: 1, atmo: true, atmoGain: 1, sun: true, sunGlare: 1, img: true,
  night: true, nightColor: '#030814', nightOpacity: 0.72, line: false, lineColor: '#ffd27a', lineWidth: 1.2, lineOpacity: 0.75,
  shadeColor: '#0a1120', shadeOpacity: 0.42
})
/** 数值项的取值范围（= 侧栏滑块的 min / max）：存档里越界的值夹回来，而不是原样喂给着色器 */
export const SPACE_RANGE = Object.freeze({
  starGain: [0.2, 2], atmoGain: [0.2, 2], sunGlare: [0, 2], nightOpacity: [0, 0.95], lineWidth: [0.1, 4], lineOpacity: [0, 1], shadeOpacity: [0, 0.95]
})
const HEX6 = /^#[0-9a-fA-F]{6}$/
function pickSpace(out, src, pairs) {
  for (const [k, from] of pairs) {
    const v = src[from], d = SPACE_DEF[k]
    if (typeof d === 'boolean') { if (typeof v === 'boolean') out[k] = v }
    else if (typeof d === 'string') { if (typeof v === 'string' && HEX6.test(v)) out[k] = v.toLowerCase() }
    else if (Number.isFinite(v)) { const r = SPACE_RANGE[k]; out[k] = r ? Math.max(r[0], Math.min(r[1], v)) : v }
  }
  return out
}
/**
 * 存档 → { on, space }；存档里压根没有这一节 → null（调用方保持当前值 = 出厂值）。
 *   新存档：spaceOn + space，逐字段合并（缺的 / 类型不对的保留出厂值，数值夹进滑块范围）。
 *   老存档（v1.4.13 及以前：晨昏线四个字段 termOn / termNight / termLine / termStyle，影像底图 imagery.on 另算）——
 *   原样还原老画面，别让老用户一升级就突变：
 *     termOn=true 或 imagery.on=true → 总开关开，星空 / 大气辉光 / 太阳 / 晨昏效果【不勾】，地球影像 = 旧 imagery.on；
 *       termOn=true 时晨昏线勾上：旧「夜区遮罩」→ 晨昏线的夜区阴影（同是硬边，颜色 / 透明度照搬），旧「分界线」→ 线（颜色 / 线粗 / 透明度照搬）；
 *       旧版只开了其中一样的，另一样的强度 / 透明度置 0（缺省两样都开）；
 *     termOn=false（且影像底图没开）→ 总开关关，子项按新出厂值（打开总开关即得完整效果）。
 */
export function spaceFromSaved(s) {
  if (!s || typeof s !== 'object') return null
  const out = { ...SPACE_DEF }
  if (s.space && typeof s.space === 'object') {
    return { on: s.spaceOn === true, space: pickSpace(out, s.space, Object.keys(SPACE_DEF).map((k) => [k, k])) }
  }
  const term = s.termOn === true
  const img = !!(s.imagery && typeof s.imagery === 'object' && s.imagery.on === true)
  if (term || img) {
    const shade = term && s.termNight !== false, line = term && s.termLine !== false
    Object.assign(out, { stars: false, atmo: false, sun: false, img, night: false, line: shade || line })
    if (term && s.termStyle && typeof s.termStyle === 'object') {
      pickSpace(out, s.termStyle, [['shadeColor', 'nightColor'], ['shadeOpacity', 'nightOpacity'], ['lineColor', 'lineColor'], ['lineWidth', 'lineWidth'], ['lineOpacity', 'lineOpacity']])
    }
    if (term && !shade) out.shadeOpacity = 0
    if (term && !line) out.lineOpacity = 0
    return { on: true, space: out }
  }
  if (s.termOn === false || (s.imagery && typeof s.imagery === 'object')) return { on: false, space: out }
  return null
}
