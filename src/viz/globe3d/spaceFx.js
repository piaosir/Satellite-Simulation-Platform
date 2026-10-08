// 宇宙空间效果（地图设置 · 宇宙空间）：星空 / 大气辉光 / 太阳 / 月球 四件 + 一个地球遮挡球。
// 普通球面视图与跟随卫星视图同一套（前身 followFx.js 只在跟随时画；2026-09-24 用户改成地图设置里的开关，跟随只改视角）。
//
// ── 拆开实现 ──
// 四件各有自己的几何 / 着色器 / 材质，各自 create / dispose、彼此不引用：关掉哪件就只放掉哪件的 GPU 资源，
// 一件都不开时 createSpaceFx 根本不会被建（scene.js 里总开关关 = spaceFx 为 null = 地球那一趟之后什么都不画）。
// createSpaceFx 只是编排器：按开关懒建各件、把星空 / 太阳的网格挂进同一个场景、一次 render 按 renderOrder 画完；
// 大气与月球的网格挂进【地球场景】、在地球那一趟里画（见 ③ / ⑤ 节头注）。
//
// ── 画在哪 ──
// 全用地球相机、场景单位 = 地球半径。①②③ 在 scene.js 的【第二趟】（地球那一趟之后、叠加层之前），④ 在地球那一趟里：
//   ① 地球遮挡球：写深度不写颜色。半径 0.997 恒在地表之下 —— 地球那一趟写过深度的像素它必然测试不过，一个值都不改；
//      只在地球材质没写深度的像素上补一层。只在星空 / 太阳要画时画（大气在地球那一趟里，用不着它）。
//   ② 星空：银河底图（NASA 星图，等经纬贴满整个天球网格）+ 亮星（耶鲁亮星表 9096 颗，点精灵）。都钉在远平面、做深度测试 ——
//      地球、遮挡球、任何写了深度的东西（轨道线…）后面的星自然被挡掉，不必逐像素判「在不在地球背后」。
//   ③ 太阳：日面 + 紧贴的日冕（远平面上的一小片，深度测试：沉到地球背后就被挡掉）。
//   ④ 大气辉光：按视线与地球的几何逐像素解析求光学厚度（Chapman 近似，不步进 —— 无分层条纹、与分辨率无关），加法混合。
//      网格只取临边一圈（盘面 0.8R → 大气外沿；盘心那一大块不画 —— 全屏画一遍在集显 2× 渲染倍率下就吃掉 0.3 ms 的预算）。
//      挂在【地球那一趟】的不透明队列、底图之后与一切透明数据层之前：数据层叠在它上面，颜色不被染；片元深度解析地写、测深度。
//      星空 / 日面在第二趟里照样叠在它上面（它不写深度）。详见 ③ 节头注。
//   ⑤ 月球：真球、真位置（约 60 个地球半径处，在 far 之内）、写深度，挂在【地球那一趟】的不透明队列（底图之后、大气之前）。
//      第二趟的星空 / 日面钉在远平面，测深度测不过它 → 月掩星、日面被月面挡住（日食）自然成立。详见 ⑤ 节头注。
//   ⑥ 眩光（叠加层之后、最后画，见 renderGlare）：屏幕空间、只罩太阳周围一块，
//      强度 × 太阳在不在画面里 × 地球挡了多少 × 月面挡了多少 × 调用方给的外部系数（跟随视图里主星模型挡太阳）。
//
// ── 坐标 ──
// 场景轴 = ECEF (X, Z, −Y)。恒星 / 银河在 ICRF（J2000 赤经赤纬），每拍由 setTime 给时刻：ICRF → 地固（IAU 1976 岁差 + 章动 + GAST，
// lunar.js icrfToEcef，与月球同一条链）→ 场景。于是惯性视角下星空相对屏幕不动、地球在转 —— 与轨道圈同一口径；
// 岁差也得做：2026 年整天球已偏 0.36°，不做的话月掩星（月掩昴星团 / 毕宿五 / 轩辕十四）会错开大半个月面。
// 太阳方向由调用方按 terminator.solarGeometry 的日下点给（场景轴单位矢量）—— 与晨昏效果、晨昏线同一个太阳。
// 月球的月心位置与月面姿态由调用方按 lunar.js 给（场景坐标 + 场景←月面固连系旋转），同一时刻、同一个 GMST。
//
// ── 星表与银河 ──
// 全是真实数据：亮星 = 耶鲁亮星表 BSC5（V ≤ 约 6.5，逐颗真位置 / 星等 / 颜色），其余 17 亿颗星与银河 = NASA SVS 星图（Gaia DR2 等）。
// 由 scripts/build-star-textures.mjs 生成，画法见 ② 节头注，来源与授权见 docs/地图数据来源台账.md #17。
import * as THREE from 'three'
import { MOON_R_KM, EARTH_SHADOW_KM, SUN_R_KM, AU_KM, discOverlap, icrfToEcef } from '../lunar.js'
import { PLANETS, planetEphemeris, decodePlanetSeries } from '../planets.js'

/** 软件光栅（SwiftShader / llvmpipe / 微软基本显示驱动…）：逐像素解析的大气与眩光太贵，只留星空与日面 */
export function isSoftwareRenderer(name) { return /swiftshader|llvmpipe|softpipe|basic render|software|warp/i.test(String(name || '')) }

const D2R = Math.PI / 180

/** 惯性系 → 场景轴（行主序 3×3），只转 GMST：先绕 Z 转 −gmst 到地固（xe = c·x + s·y，ye = −s·x + c·y），再 (X,Y,Z) → (X, Z, −Y)。
 *  星空现走 icrfToSceneRows（多了岁差与章动）；这一版留作没给时刻时的退路，也是单测里「与卫星 eciToEcf 同一个转动」的基准 */
export function inertialToSceneRows(gmst) {
  const c = Math.cos(gmst), s = Math.sin(gmst)
  return [c, s, 0, 0, 0, 1, s, -c, 0]
}
/** ICRF → 场景轴（行主序 3×3）：lunar.icrfToEcef（IAU 1976 岁差 + 章动 + GAST，与月球同一条链）再换轴 (X, Y, Z) → (X, Z, −Y)。
 *  gmst：同一时刻的 sat.gstime（调用方已算过就传，不重算） */
export function icrfToSceneRows(date, gmst) {
  const R = icrfToEcef(date, gmst)
  return [R[0], R[1], R[2], R[6], R[7], R[8], -R[3], -R[4], -R[5]]
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
// ② 星空：银河底图 + 亮星
// ======================================================================================
// ── 定调：人眼在轨看到的天空（2026-10-07 用户：「真实且没那么抢戏」）──
//   亮于 6.5 等的星是一个个清楚的点、银河是一道淡淡的光，更暗的星单颗看不见、只汇进银河 —— 不是长曝光照片那种满屏细碎星点
//  （先做过那一版：8K 底图把 6.5–11.5 等的星当颗粒原样留着，满天沙粒压过了地球与数据层）。外加两条眼睛 / 相机本来就有的适应：
//   太阳在画面里时整体压暗（dim）、受光的地球（和月球）占画面越多曝光越低（adapt，见编排器 adaptFactor）。
// ── 数据（scripts/build-star-textures.mjs 生成；来源、授权与署名见 docs/地图数据来源台账.md #17）──
//   · 底图 stars_mw_4k.jpg + stars_mw_color_1k.png：NASA SVS「Deep Star Maps 2020」的 milkyway（Gaia DR2）+ hiptyc（Tycho / Hipparcos）
//     两层做成的【弥漫光】—— 亮星表里的星抹掉、其余暗星滤成「看不清的星光」。尘埃带、煤袋、大小麦哲伦云、ω Cen 都是星表数据画出来的。
//     4K 单通道亮度（texel = (Y / LMAX)^(1/GAMMA)，Y 是辐亮度）+ 1K 归一化颜色；等经纬、中线 = 赤经 0h、赤经向左增大、上 = +90°。
//   · 亮星 starfield.data.js：耶鲁亮星表 BSC5 的 9096 颗（V ≤ 约 6.5），星位推到 STAR_EPOCH，B−V 定颜色；画成点精灵。
// ── 曝光与显示曲线 ──
//   显示线性值 x：星 = E0 · 10^(−0.4V) · PSF(r)（E0 = 一颗 0 等星在 CSS 像素面积上的总能量）；
//   银河 = X · Y，X = STAR_MW_VIS · E0 · Ω_ref / KSR（Ω_ref = 42° 视场、900 CSS 像素高时一个像素的立体角；KSR = 底图单位下一颗 0 等星的
//   辐亮度对立体角的积分，构建时拿三千多颗孤立星标定）。STAR_MW_VIS = 1 时银河与星是同一把物理尺（长曝光照片的比例）；
//   人眼对低面亮度的弥漫光远不如对点源敏感，银河在肉眼里比照片淡得多 —— 取 0.5。X 不随窗口尺寸变：拉大窗口，银河的面亮度不变。
//   显示曲线 tone(x) = sRGB(肩部(x))：0.6 以下线性，以上指数收向 1 —— 亮星核心渐渐变白，不是一刀削平。
//   ★ 精灵用加法叠在底图上，曲线却不是线性的：精灵输出 tone(xb + x) − tone(xb)（xb = 顶点着色器在该星方向取的底图），
//     叠完正好等于 tone(底图 + 星)。直接输出 tone(x) 的话，银河亮处的星会被凭空加亮一截（sRGB 在暗端斜率 12.92）。
// ── PSF（能量按 CSS 像素面积记，核心宽度按物理像素记）──
//   核心高斯 σ = 0.6 物理像素（按屏幕像素密度折成 CSS 像素：高分屏上星点照样锐；渲染像素不足 0.6 时放宽 ——
//   采样太稀时亚像素位置一变亮度就跳，转动时星会闪）占 93% 能量，
//   余 7% 进 Moffat 宽晕（β = 2、a = 3.5）：暗星就是一个点，越亮的星晕越显 —— 天狼星、金星一眼比 2 等星亮得多
//   （镜头与人眼的散射本来如此），靠的不是把核心画大。晕给多了满天亮星个个顶着一团光（先给过 12%），收到 7%。
//   精灵半径逐星算到「贡献降到 sRGB 半级」，晕到边上 smoothstep 收到 0，方框不露边。
// ── 颜色 ── B−V → 有效温度（Ballesteros 2012）→ 黑体谱 → CIE 1931（Wyman–Sloan–Shirley 2013 解析拟合）→ 线性 sRGB（D65）→ 亮度归一，
//   与 SVS 星图同一口径（Mitchell Charity 的黑体色）；饱和度收到 0.75（人眼看星色本就淡）。
// ── 载入 ── 星表动态 import（勾上星空才拉，167 KB）；两张贴图异步载入，到手前精灵照画（身后底图当 0），底图不画。
const STAR_LUM_URL = new URL('./textures/stars_mw_4k.jpg', import.meta.url).href
const STAR_COL_URL = new URL('./textures/stars_mw_color_1k.png', import.meta.url).href
/** 一颗 0 等星的总能量（显示线性值 × CSS 像素²），星空亮度 1、未压暗时 */
export const STAR_E0 = 60
/** 银河相对「与星同一把物理尺」的比例（见上） */
export const STAR_MW_VIS = 0.5
const STAR_SIG_PHYS = 0.6, STAR_SIG_RPX = 0.6  // 核心 σ（物理像素）与它在渲染像素上的下限
const STAR_HALO = 0.07, STAR_HALO_A = 3.5, STAR_HALO_B = 2
const STAR_HALO_N = (STAR_HALO_B - 1) / (Math.PI * STAR_HALO_A * STAR_HALO_A)   // Moffat 归一化系数
const STAR_THR = 1.5e-4                          // 精灵半径算到的门限：sRGB 暗端半级（0.5 / 255 / 12.92）
const STAR_SAT = 0.75
// 底图色度饱和度：SVS 按 Gaia BP/RP「凭目测」配的色偏红褐（盘面星被尘埃消光染红），照搬时整条银河像一片褐色星云；
// 收到 0.6 后核球偏暖白、尘埃带暗褐、麦云蓝白 —— 与按日光白平衡定标的银河全景照片（Mellinger、ESO / Brunier）观感一致
const STAR_BG_SAT = 0.6
const STAR_SOFT_R = 6                            // 软件光栅：精灵半径封顶（CSS 像素），晕只留个意思
const OMEGA_REF = (2 * Math.tan(21 * D2R) / 900) ** 2
const SKY_NU = 256, SKY_NV = 128                 // 天球网格：1.4° 一格，网格内 uv 线性插值与等经纬映射之差 < 0.25′（4K 像元 5.3′）

/** starfield.data.js 的 STAR_DATA（base64，每颗 14 字节小端）→ 定长数组。导出给单测 */
export function decodeStarData(mod) {
  const s = atob(mod.STAR_DATA), n = mod.STAR_COUNT
  if (s.length !== n * 14) throw new Error('starfield.data.js 长度不对：' + s.length + ' ≠ ' + n + ' × 14')
  const bin = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i)
  const dv = new DataView(bin.buffer)
  const ra = new Float64Array(n), dec = new Float64Array(n), mag = new Float32Array(n), bv = new Float32Array(n), hr = new Uint16Array(n)
  for (let k = 0; k < n; k++) {
    const o = k * 14
    ra[k] = dv.getFloat32(o, true); dec[k] = dv.getFloat32(o + 4, true)
    mag[k] = dv.getInt16(o + 8, true) / 100; bv[k] = dv.getInt16(o + 10, true) / 1000; hr[k] = dv.getUint16(o + 12, true)
  }
  return { n, ra, dec, mag, bv, hr }
}

// CIE 1931 2° 配色函数的分段高斯解析拟合（Wyman, Sloan & Shirley 2013，JCGT 2(2)），380–780 nm 上与表值差 < 1%
const cmf = (l, mu, s1, s2) => { const t = (l - mu) / (l < mu ? s1 : s2); return Math.exp(-0.5 * t * t) }
function blackbodyRgb(T) {
  let X = 0, Y = 0, Z = 0
  for (let l = 380; l <= 780; l += 5) {
    const B = Math.pow(l, -5) / Math.expm1(1.4387769e7 / (l * T))   // 普朗克（常数因子约掉）：c2 = hc/k = 1.4387769e7 nm·K
    X += B * (1.056 * cmf(l, 599.8, 37.9, 31.0) + 0.362 * cmf(l, 442.0, 16.0, 26.7) - 0.065 * cmf(l, 501.1, 20.4, 26.2))
    Y += B * (0.821 * cmf(l, 568.8, 46.9, 40.5) + 0.286 * cmf(l, 530.9, 16.3, 31.1))
    Z += B * (1.217 * cmf(l, 437.0, 11.8, 36.0) + 0.681 * cmf(l, 459.0, 26.0, 13.8))
  }
  // XYZ → 线性 sRGB（D65）；色域外（极冷星的蓝通道）夹到 0
  const r = Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z)
  const g = Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z)
  const b = Math.max(0, 0.0557 * X - 0.2040 * Y + 1.0570 * Z)
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [r / L, g / L, b / L]
}
const BV_LO = -0.4, BV_HI = 2.4, BV_N = 225     // B−V 查表：0.0125 一档（Ballesteros 式在这个范围外不可信，夹到两端）
let bvLut = null
/** B−V → 线性 sRGB，亮度归一（0.2126 r + 0.7152 g + 0.0722 b = 1）。sat：0 = 白、1 = 黑体本色 */
export function starColorBV(bv, sat = STAR_SAT) {
  if (!bvLut) {
    bvLut = new Float64Array(BV_N * 3)
    for (let i = 0; i < BV_N; i++) {
      const b = BV_LO + (BV_HI - BV_LO) * i / (BV_N - 1)
      const c = blackbodyRgb(4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62)))   // Ballesteros 2012：B−V → T_eff
      bvLut[i * 3] = c[0]; bvLut[i * 3 + 1] = c[1]; bvLut[i * 3 + 2] = c[2]
    }
  }
  const f = (Math.max(BV_LO, Math.min(BV_HI, Number.isFinite(bv) ? bv : 0.6)) - BV_LO) / (BV_HI - BV_LO) * (BV_N - 1)
  const i = Math.min(BV_N - 2, Math.floor(f)), t = f - i
  const out = [0, 0, 0]
  for (let c = 0; c < 3; c++) out[c] = 1 + ((bvLut[i * 3 + c] * (1 - t) + bvLut[(i + 1) * 3 + c] * t) - 1) * sat
  return out
}

/** 赤经 / 赤纬（rad）→ 底图 uv（u 向右、v 向上；three 的 flipY 贴图里 v = 1 是图的上边 = +90°） */
export function starMapUv(ra, dec) {
  return [(((0.5 - ra / (2 * Math.PI)) % 1) + 1) % 1, 0.5 + dec / Math.PI]
}
/** 天球网格：等经纬 nu × nv 格，顶点 = ICRF 单位矢量，uv 与底图同一套（u = 0.5 − α/2π，v = 0.5 + δ/π）。
 *  u = 0 与 u = 1 两列顶点重合但分开存 —— 三角形内部永远不跨接缝，mipmap 选级不会在接缝上算出一条竖线。导出给单测 */
export function skySphereArrays(nu = SKY_NU, nv = SKY_NV) {
  const pos = new Float32Array((nu + 1) * (nv + 1) * 3), uv = new Float32Array((nu + 1) * (nv + 1) * 2)
  let k = 0
  for (let j = 0; j <= nv; j++) {
    const v = j / nv, de = (v - 0.5) * Math.PI, cd = Math.cos(de), sd = Math.sin(de)
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, ra = (0.5 - u) * 2 * Math.PI
      pos[k * 3] = cd * Math.cos(ra); pos[k * 3 + 1] = cd * Math.sin(ra); pos[k * 3 + 2] = sd
      uv[k * 2] = u; uv[k * 2 + 1] = v
      k++
    }
  }
  const idx = new Uint32Array(nu * nv * 6)
  let q = 0
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1
      idx[q++] = a; idx[q++] = b; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = c
    }
  }
  return { pos, uv, idx }
}

// 显示曲线：0.6 以下线性、以上指数肩部收向 1，再 sRGB 编码（底图与精灵同一条）
const TONE_GLSL = `
vec3 shoulder(vec3 x) {
  return mix(x, 0.6 + 0.4 * (1.0 - exp(-(x - 0.6) / 0.4)), step(vec3(0.6), x));
}
vec3 srgbEnc(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 tone(vec3 x) { return srgbEnc(shoulder(max(x, vec3(0.0)))); }`
// 底图解码：亮度 texel（(Y / LMAX)^(1/GAMMA)）× 归一化颜色（max 通道 = 1，这里按亮度归一）→ 线性辐亮度（SVS 星图单位）
const SKY_GLSL = `
uniform sampler2D uLum;
uniform sampler2D uCol;
uniform vec2 uEnc;
vec3 skyLin(float t, vec3 n) {
  vec3 c = n / max(dot(n, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  return uEnc.x * pow(t, uEnc.y) * mix(vec3(1.0), c, ${STAR_BG_SAT.toFixed(2)});
}`
const SKY_VERT = `
uniform mat3 uI2S;
varying vec2 vUv;
${FAR_GLSL}
void main() { vUv = uv; gl_Position = farClip(uI2S * position); }`
const SKY_FRAG = `
uniform float uX;
varying vec2 vUv;
${SKY_GLSL}
${TONE_GLSL}
${DITHER_GLSL}
void main() {
  vec3 v = tone(uX * skyLin(texture2D(uLum, vUv).r, texture2D(uCol, vUv).rgb));
  gl_FragColor = vec4(max(vec3(0.0), v + dither8(gl_FragCoord.xy) * step(0.002, v.g)), 1.0);
}`
// 亮星：只用方向、钉在远平面。精灵尺寸、核心 σ 都在顶点里按星等定，片元只求值。
// 行星（PLANET）共用这一份：position 是场景系里的真位置（地球半径为单位），按「相机 → 行星」取方向（视差，见 ②b 节头注）
const STAR_VERT = `
attribute float mag;
uniform mat3 uI2S;
uniform float uPx;
uniform float uE0;
uniform float uX;
uniform float uBg;
uniform float uMaxR;
uniform float uSig;
varying vec3 vE;
varying vec3 vXb;
varying float vR;
varying float vSig;
${FAR_GLSL}
${SKY_GLSL}
void main() {
#ifdef PLANET
  gl_Position = farClip(normalize(position - cameraPosition));
#else
  gl_Position = farClip(uI2S * position);
#endif
  float E = uE0 * exp2(-1.32877124 * mag);                                   // 10^(−0.4 m)
  float sig = max(uSig, ${STAR_SIG_RPX.toFixed(2)} / uPx);                  // CSS 像素
  float pk = E * ${(1 - STAR_HALO).toFixed(4)} / (6.28318531 * sig * sig);  // 核心峰值
  float hk = E * ${(STAR_HALO * STAR_HALO_N).toExponential(8)};             // 晕峰值
  float rg = sig * sqrt(2.0 * log(max(pk / ${STAR_THR.toExponential(3)}, 1.0)));
  float rh = ${STAR_HALO_A.toFixed(2)} * sqrt(max(pow(hk / ${STAR_THR.toExponential(3)}, ${(1 / STAR_HALO_B).toFixed(4)}) - 1.0, 0.0));
  vR = min(max(max(rg, rh) + 0.5, 2.0 * sig), uMaxR);
  vSig = sig;
  vE = E * color;
  gl_PointSize = 2.0 * vR * uPx;
#ifdef PLANET
  vXb = vec3(0.0);   // 行星都亮（天王星 5.7 等以外全亮于 1 等），身后银河那点底子不必计
#else
  // 这颗星身后的底图：LOD 2（4×4 像元 ≈ 21′ 的平均）—— 星本身已从底图抹掉，取到的是它背后的银河
  vec2 st = vec2(0.5 - atan(position.y, position.x) * 0.159154943, 0.5 + asin(clamp(position.z, -1.0, 1.0)) * 0.318309886);
  vXb = uBg * uX * skyLin(textureLod(uLum, st, 2.0).r, textureLod(uCol, st, 0.0).rgb);
#endif
}`
const STAR_FRAG = `
varying vec3 vE;
varying vec3 vXb;
varying float vR;
varying float vSig;
${TONE_GLSL}
void main() {
  vec2 d = (gl_PointCoord - 0.5) * (2.0 * vR);                               // 到星心（CSS 像素）
  float r2 = dot(d, d);
  if (r2 > vR * vR) discard;
  float core = ${(1 - STAR_HALO).toFixed(4)} / (6.28318531 * vSig * vSig) * exp(-0.5 * r2 / (vSig * vSig));
  float halo = ${(STAR_HALO * STAR_HALO_N).toExponential(8)} * pow(1.0 + r2 / ${(STAR_HALO_A * STAR_HALO_A).toFixed(2)}, ${(-STAR_HALO_B).toFixed(2)})
             * (1.0 - smoothstep(0.7 * vR, vR, sqrt(r2)));
  gl_FragColor = vec4(tone(vXb + vE * (core + halo)) - tone(vXb), 1.0);
}`
const FS_VERT = 'varying vec2 vNdc;\nvoid main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }'

/** 星（与行星）的曝光 E0：星空亮度 × 太阳压暗（最多压到 40%）× 适应系数 */
export function starExposure(gain, dim, adapt) {
  const a = Number.isFinite(adapt) ? Math.max(0, Math.min(1, adapt)) : 1
  return STAR_E0 * gain * (1 - 0.6 * Math.max(0, Math.min(1, dim || 0))) * a
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {boolean} [soft] 软件光栅：精灵半径封顶 STAR_SOFT_R（晕只留个意思）
 */
export function createStarfield(renderer, soft) {
  const I2S = { value: new THREE.Matrix3() }
  const U = { uI2S: I2S, uLum: { value: null }, uCol: { value: null }, uEnc: { value: new THREE.Vector2(0.5, 2.2) }, uX: { value: 0 } }
  // —— 底图：整个天球一张网格，两张贴图都到手才画 ——
  const A = skySphereArrays()
  const skyGeo = new THREE.BufferGeometry()
  skyGeo.setAttribute('position', new THREE.BufferAttribute(A.pos, 3))
  skyGeo.setAttribute('uv', new THREE.BufferAttribute(A.uv, 2))
  skyGeo.setIndex(new THREE.BufferAttribute(A.idx, 1))
  const skyMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.DoubleSide,
    depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false })
  const sky = new THREE.Mesh(skyGeo, skyMat)
  sky.frustumCulled = false
  sky.renderOrder = 1
  sky.visible = false
  // —— 亮星：星表到手才画 ——
  const starU = { ...U, uPx: { value: 1 }, uE0: { value: STAR_E0 }, uBg: { value: 0 }, uMaxR: { value: 64 }, uSig: { value: STAR_SIG_PHYS } }
  const starGeo = new THREE.BufferGeometry()
  const starMat = new THREE.ShaderMaterial({ uniforms: starU, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, vertexColors: true,
    depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false })
  const stars = new THREE.Points(starGeo, starMat)
  stars.frustumCulled = false
  stars.renderOrder = 2
  stars.visible = false
  let gain = 1, nStars = 0, ksr = 0, haveLum = false, haveCol = false, disposed = false
  // 点精灵尺寸上限（渲染像素）：桌面 GPU 一般 ≥ 256（ANGLE / D3D11 是 1024），取不到按 64
  let maxPt = 64
  try { const r = renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE); if (r && r[1] > 0) maxPt = r[1] } catch { /* 无 GL 的环境 */ }
  const syncBg = () => { sky.visible = haveLum && haveCol && ksr > 0; starU.uBg.value = sky.visible ? 1 : 0 }
  import('./starfield.data.js').then((mod) => {
    if (disposed) return
    const S = decodeStarData(mod)
    const pos = new Float32Array(S.n * 3), col = new Float32Array(S.n * 3), mag = new Float32Array(S.n)
    for (let k = 0; k < S.n; k++) {
      const cd = Math.cos(S.dec[k])
      pos[k * 3] = cd * Math.cos(S.ra[k]); pos[k * 3 + 1] = cd * Math.sin(S.ra[k]); pos[k * 3 + 2] = Math.sin(S.dec[k])
      const c = starColorBV(S.bv[k])
      col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2]
      mag[k] = S.mag[k]
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    starGeo.setAttribute('mag', new THREE.BufferAttribute(mag, 1))
    U.uEnc.value.set(mod.STAR_BG.LMAX, mod.STAR_BG.GAMMA)
    ksr = mod.STAR_BG_KSR
    nStars = S.n
    stars.visible = true
    syncBg()
  }).catch(() => { /* 星表模块缺失（漏打包）：不画亮星，底图照画不了（缺标定），星空整件不出 */ })
  // —— 底图贴图：亮度单通道 R8（WebGL2 允许 DOM 图像源直传 R8，浏览器取红通道）、色度 RGBA；都是编码过的数据，不做 sRGB 解码 / 色彩管理 ——
  // 亮度图先 img.decode() 在后台线程解完再交给 three，免得第一次上传时主线程卡一下；超出显卡上限时 three 自己缩
  const aniso = Math.max(1, Math.min(8, renderer.capabilities && renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1))
  const prep = (t, red) => {
    if (red) t.format = THREE.RedFormat
    t.colorSpace = THREE.NoColorSpace
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.anisotropy = aniso
    t.needsUpdate = true
    return t
  }
  const ready = (t, red, done) => {
    if (disposed) { t.dispose(); return }
    const go = () => { if (disposed) { t.dispose(); return } done(prep(t, red)); syncBg() }
    if (t.image && typeof t.image.decode === 'function') t.image.decode().then(go, go)
    else go()
  }
  try {
    const loader = new THREE.TextureLoader()
    loader.load(STAR_LUM_URL, (t) => ready(t, true, (x) => { U.uLum.value = x; haveLum = true }), undefined, () => {})
    loader.load(STAR_COL_URL, (t) => ready(t, false, (x) => { U.uCol.value = x; haveCol = true }), undefined, () => {})
  } catch { /* 没有 DOM 的环境（单测）：只有精灵 */ }
  I2S.value.set(...inertialToSceneRows(0))
  return {
    objects: [sky, stars],
    setStyle(o) { if (o && Number.isFinite(Number(o.gain))) gain = Math.max(0, Math.min(4, Number(o.gain))) },
    /** rows：ICRF → 场景（行主序 3×3，icrfToSceneRows / inertialToSceneRows） */
    setFrame(rows) { if (rows && rows.length === 9) I2S.value.set(...rows) },
    /** dim：太阳在画面里时人眼被晃，恒星与银河整体压暗（0..1，NASA Eyes 同样如此）；adapt：受光天体占画面带来的曝光系数（0..1，见编排器）。
     *  压的都是曝光，底图与精灵一起压 */
    update(r, dim, adapt) {
      const px = r.getPixelRatio(), dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
      starU.uPx.value = px
      starU.uSig.value = STAR_SIG_PHYS / dpr
      starU.uMaxR.value = Math.min(soft ? STAR_SOFT_R : Infinity, maxPt / (2 * px))
      const E0 = starExposure(gain, dim, adapt)
      starU.uE0.value = E0
      U.uX.value = ksr > 0 ? STAR_MW_VIS * E0 * OMEGA_REF / ksr : 0
    },
    stats: () => ({ stars: nStars, bg: sky.visible, gain, x: U.uX.value }),
    dispose() {
      disposed = true
      skyGeo.dispose(); skyMat.dispose(); starGeo.dispose(); starMat.dispose()
      if (U.uLum.value) U.uLum.value.dispose()
      if (U.uCol.value) U.uCol.value.dispose()
    }
  }
}

// ======================================================================================
// ②b 行星：水、金、火、木、土、天王六颗 —— 与亮星同一套点精灵、曝光与显示曲线
// ======================================================================================
// 位置：src/viz/planets.js（VSOP87B，对 JPL Horizons / DE441 实测 ≤ 0.6″、天王星 ≤ 1.5″）给地心 ICRF 位置（AU），
// 这里乘 ICRF → 场景的转动、换成地球半径，作为场景系里的真位置；着色器按「相机 → 行星」取方向 —— 视差是真的：
// 相机最远离地心 50 个地球半径，金星下合时只有约 6600 个地球半径远，不按相机取方向，机位一动它就和恒星错开最多 0.4°。
// 亮度：视星等（Mallama & Hilton 2018，含相位、土星环倾角、天王星亚纬度；水金木对 Horizons 逐位一致到 0.001 等）
// → 与恒星同一条 E0 · 10^(−0.4V)；颜色：各行星（反射太阳光后的）B−V，走恒星同一条映射。
// 星历缓存：模拟时间变化不到 20 s 不重算（水星地心角速度最快约 0.06″/s，20 s 才 1.2″）；ICRF → 场景的转动每拍都换（地球在转）。
const RE_PER_AU = AU_KM / 6371
const PLANET_CACHE_MS = 20000
/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {boolean} [soft] 软件光栅：精灵半径封顶
 */
export function createPlanets(renderer, soft) {
  const n = PLANETS.length
  const U = {
    uI2S: { value: new THREE.Matrix3() }, uLum: { value: null }, uCol: { value: null }, uEnc: { value: new THREE.Vector2(1, 1) }, uX: { value: 0 },
    uPx: { value: 1 }, uE0: { value: STAR_E0 }, uBg: { value: 0 }, uMaxR: { value: 64 }, uSig: { value: STAR_SIG_PHYS }
  }
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3)
  PLANETS.forEach((P, k) => { const c = starColorBV(P.bv); col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2] })
  const geo = new THREE.BufferGeometry()
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)
  const magAttr = new THREE.BufferAttribute(mag, 1).setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', posAttr)
  geo.setAttribute('mag', magAttr)
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const mat = new THREE.ShaderMaterial({ defines: { PLANET: '' }, uniforms: U, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, vertexColors: true,
    depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false })
  const pts = new THREE.Points(geo, mat)
  pts.frustumCulled = false
  pts.renderOrder = 2.5      // 亮星之后、日面之前
  pts.visible = false
  let series = null, eph = null, ephMs = NaN, pendDate = null, rows = inertialToSceneRows(0), gain = 1, disposed = false
  let maxPt = 64
  try { const r = renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE); if (r && r[1] > 0) maxPt = r[1] } catch { /* 无 GL 的环境 */ }
  function place() {
    if (!eph) return
    for (let k = 0; k < n; k++) {
      const v = eph[k].icrf
      for (let r = 0; r < 3; r++) pos[k * 3 + r] = (rows[r * 3] * v[0] + rows[r * 3 + 1] * v[1] + rows[r * 3 + 2] * v[2]) * RE_PER_AU
      mag[k] = eph[k].mag
    }
    posAttr.needsUpdate = true
    magAttr.needsUpdate = true
    pts.visible = true
  }
  function setTime(date, frame) {
    if (frame && frame.length === 9) rows = frame
    if (date == null) { place(); return }
    const ms = date instanceof Date ? date.getTime() : Number(date)
    if (!series) { pendDate = ms; return }
    if (!eph || !(Math.abs(ms - ephMs) < PLANET_CACHE_MS)) { eph = planetEphemeris(ms, series); ephMs = ms }
    place()
  }
  import('../planets.data.js').then((mod) => {
    if (disposed) return
    series = decodePlanetSeries(mod)
    if (pendDate != null) setTime(pendDate)
  }).catch(() => { /* 级数模块缺失（漏打包）：不画行星 */ })
  return {
    objects: [pts],
    setStyle(o) { if (o && Number.isFinite(Number(o.gain))) gain = Math.max(0, Math.min(4, Number(o.gain))) },
    /** date：时刻（Date / 毫秒）；frame：ICRF → 场景（行主序 3×3，与星空同一个） */
    setTime,
    update(r, dim, adapt) {
      const px = r.getPixelRatio(), dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
      U.uPx.value = px
      U.uSig.value = STAR_SIG_PHYS / dpr
      U.uMaxR.value = Math.min(soft ? STAR_SOFT_R : Infinity, maxPt / (2 * px))
      U.uE0.value = starExposure(gain, dim, adapt)
    },
    /** 验证台 / 单测读数：各行星的视星等、地距（AU）与场景系方向 */
    stats: () => ({ ready: pts.visible, planets: eph ? eph.map((e, k) => ({ key: e.key, mag: +e.mag.toFixed(2), delta: +e.delta.toFixed(4), scene: [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]] })) : null }),
    dispose() { disposed = true; geo.dispose(); mat.dispose() }
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
// ⑤ 月球：NASA LRO 月面贴图（LROC 彩色 + LOLA 坡度）的真球 —— 真实地心位置、月相、天平动，含地照与月食地影
// ======================================================================================
// 位置与姿态由 scene.js 每拍按 lunar.js 算好喂进来（setState：月心场景坐标 + 场景←月面固连系旋转），本层只管画。
//
// ── 为什么挂在【地球那一趟】、按真实深度画 ──
//   月球在 56–64 个地球半径处，相机 far = 120 ≥ maxDistance 50 + 64 → 它恒在视锥里，可以画成真球、写真深度，不必像日面那样钉远平面：
//   · 进地球场景的不透明队列（MOON_EARTH_ORDER 0.4：底图 0 之后、大气辉光 0.5 之前）：地球、轨道线、数据层照常压在它前面 ——
//     轨道线 / 覆盖线 depthWrite=false，月球若放第二趟画，GEO 圈从月面前经过时会被月面盖掉；
//     第二趟的星空 / 日面钉在远平面，测深度测不过它 → 月掩星、月面挡住日面（日食）自然成立；
//     临边大气辉光（加法、不写深度）排在它之后，月出月落贴着地球临边时辉光照样叠在月面上。
//   · 视差是真的：相机在 50 个地球半径内任意处，看到的月球方向与大小都按真实几何（与地心看可差数度）。
//   · 「大小」只放大显示半径、不挪月心；光照与地影一律取【真实半径】上的点（放大后月食的本影位置、日月几何都不变）。
//   · 跟随远地点在月球外侧的高椭圆轨道星时月球可能超出 far：顶点着色器把深度夹在远平面内一丝（仍在星空之前），不被裁掉。
// ── 光照（线性空间算、最后编码回 sRGB；彩色贴图按 sRGB 纹理硬件解码成线性）──
//   · 月面反射：lunar-Lambert（McEwen 1996）—— 满月整盘不压暗边（月球特有的「平」），弦月朝晨昏线渐暗。
//   · 地形：LOLA 坡度图扰动法线（坡面朝日更亮）。不做自阴影，故【几何】晨昏线以外一律不受光（smoothstep 收边），
//     免得夜侧朝阳的坡面凭空发亮。
//   · 地照：地球反光照亮月面暗部，强度随「从月球看地球的相位」（新月前后地球是满地）—— 蛾眉月时暗部隐约可见。
//   · 地影：月面上每一点看日面被地球挡住多少（Danjon 地影，与 lunar.js earthShadowFraction 同一个式子的 GLSL 版，改动两边同步）；
//     本影里只剩地球大气折射的暗红光（越往本影中心越暗）。
// ── 晨昏效果关（地球与卫星全亮）时月球照样有月相：月相是日月几何本身，不是画面「打光」，关掉它等于把月球画错。
export const MOON_EARTH_ORDER = 0.4
/** 坡度图编码满量程（★ 与 scripts/build-moon-textures.mjs 的 SLOPE_SCALE 同值） */
export const MOON_SLOPE_SCALE = 0.8
/** 显示放大倍数的出厂值：与日面的放大口径一致（SUN_R_VIS / SUN_R_TRUE ≈ 1.72）—— 日月在天上本就一样大，放大也该一样 */
export const MOON_SCALE_DEF = 1.7
const RE_KM = 6371   // 场景单位（scene.js / focusLanes.RE）
const MOON_SEG_W = 128, MOON_SEG_H = 64
// 地照强度：地球满相时暗部亮度相对满月受光处的比例。物理上约 1e-4，画面上看不见 —— 取 0.02：蛾眉月的暗部刚好浮出轮廓（照片长曝光的观感）；
// 验证台试过 0.035，残月暗部连月海轮廓都清清楚楚，弦月的明暗对比被冲淡
const MOON_EARTHSHINE = 0.02
const MOON_MAP_URL = new URL('./textures/moon_lroc_4k.jpg', import.meta.url).href
const MOON_RELIEF_URL = new URL('./textures/moon_relief_1k.png', import.meta.url).href
// 网格局部 → 月面固连系（ME）：SphereGeometry 的 u = (lon + 180°)/360°、局部 +Y 是北极 → body = (x, −z, y)（行主序）。
// 贴图那头的取向（图中线 = 0°、东经在右、北在上）由 scripts/build-moon-textures.mjs 用已知地物自检，这头由单测按网格 uv 逐顶点钉住
export const MOON_LOCAL = Object.freeze([1, 0, 0, 0, 0, -1, 0, 1, 0])
/**
 * lunar.js 的结果 → createMoonFx.setState 要的场景量：月心（ECEF km → 场景轴 (X, Z, −Y)、单位地球半径）、
 * 场景←月面固连旋转（ECEF←月面固连阵左乘同一个换轴阵：行 x ← x、y ← z、z ← −y）。
 * @param {{ecef:number[]}} pos moonPosition 的结果
 * @param {number[]} M moonBodyToEcef 的结果（行主序 3×3）
 * @param {number} [sunKm] 日地距离
 */
export function moonSceneState(pos, M, sunKm) {
  const e = pos.ecef
  return {
    center: [e[0] / RE_KM, e[2] / RE_KM, -e[1] / RE_KM],
    rot: [M[0], M[1], M[2], M[6], M[7], M[8], -M[3], -M[4], -M[5]],
    sunKm
  }
}
const MOON_VERT = `
varying vec2 vUv;
varying vec3 vL;
varying vec3 vW;
void main() {
  vUv = uv;
  vL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vec4 p = projectionMatrix * viewMatrix * wp;
  if (p.w > 0.0) p.z = min(p.z, p.w * 0.99998);   // 超出 far 的极端机位：夹在远平面内一丝（仍在星空 0.99999 之前）
  gl_Position = p;
}`
const MOON_FRAG = `
uniform sampler2D uMap;
uniform sampler2D uRelief;
uniform float uReliefK;
uniform mat3 uRot;
uniform vec3 uCenter;
uniform vec3 uSun;
uniform float uRtrue;
uniform float uRsh;
uniform float uSunAng;
uniform float uEs;
varying vec2 vUv;
varying vec3 vL;
varying vec3 vW;
${DITHER_GLSL}
// 两个小圆（角半径 r1、r2，圆心角距 d）的重叠面积 —— lunar.js discOverlap 的 GLSL 版
float discOverlap(float r1, float r2, float d) {
  if (d >= r1 + r2) return 0.0;
  float rmin = min(r1, r2);
  if (d <= abs(r1 - r2)) return 3.14159265 * rmin * rmin;
  float a1 = acos(clamp((d * d + r1 * r1 - r2 * r2) / (2.0 * d * r1), -1.0, 1.0));
  float a2 = acos(clamp((d * d + r2 * r2 - r1 * r1) / (2.0 * d * r2), -1.0, 1.0));
  float k = max(0.0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return r1 * r1 * a1 + r2 * r2 * a2 - 0.5 * sqrt(k);
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec3 nl = normalize(vL);
  vec3 n0 = normalize(uRot * nl);                       // 几何法线（场景系）
  vec3 n = n0;
  // 地形：局部 +Y = 月面北极 → 东向 = Y × n、北向 = n × 东（极点附近东向退化，不扰动）
  vec3 el = vec3(nl.z, 0.0, -nl.x);
  float le = length(el);
  if (uReliefK > 0.0 && le > 0.02) {
    el /= le;
    vec3 nr = cross(nl, el);
    vec2 s = (texture2D(uRelief, vUv).rg * 2.0 - 1.0) * (${MOON_SLOPE_SCALE.toFixed(3)} * uReliefK);
    n = normalize(n0 - uRot * (el * s.x + nr * s.y));
  }
  vec3 v = normalize(cameraPosition - vW);
  float mu0g = dot(n0, uSun);
  float mu0 = max(dot(n, uSun), 0.0);
  float mu = max(dot(n, v), 0.0);
  float a = degrees(acos(clamp(dot(uSun, v), -1.0, 1.0)));                     // 相位角（此点看日与相机）
  float Lp = clamp(1.0 - 0.019 * a + 2.42e-4 * a * a - 1.46e-6 * a * a * a, 0.0, 1.0);
  float lit = (2.0 * Lp * mu0 / max(mu0 + mu, 1e-3) + (1.0 - Lp) * mu0) * smoothstep(-0.015, 0.02, mu0g);
  // 地影：真实半径上的这一点看日面被地球挡住多少（小角度用 atan2(|s×e|, s·e)，float 下比 acos 稳）
  vec3 P = uCenter + n0 * uRtrue;
  float dd = length(P);
  vec3 e = -P / dd;
  float rE = asin(min(1.0, uRsh / dd));
  float gam = atan(length(cross(uSun, e)), dot(uSun, e));
  float sh = 1.0 - discOverlap(uSunAng, rE, gam) / (3.14159265 * uSunAng * uSunAng);
  float um = clamp((rE - uSunAng - gam) / max(rE - uSunAng, 1e-6), 0.0, 1.0);   // 进本影的深度：边缘 0 → 地影轴 1
  vec3 red = vec3(1.0, 0.36, 0.13) * mix(0.07, 0.018, um) * (1.0 - sh);
  vec3 alb = texture2D(uMap, vUv).rgb;
  vec3 col = alb * ((vec3(sh) + red) * lit + vec3(0.78, 0.86, 1.0) * (uEs * max(dot(n, e), 0.0)));
  gl_FragColor = vec4(toSrgb(col) + dither8(gl_FragCoord.xy), 1.0);
}`

/**
 * @param {THREE.WebGLRenderer} renderer
 * setStyle({ scale })：显示放大倍数；setSun(v)：太阳方向（场景系单位矢量）；
 * setState({ center:[x,y,z] 场景单位, rot:[9] 场景←月面固连系（行主序）, sunKm? 日地距离 })：每拍一次。贴图到手前不画（不闪一个灰球）。
 */
export function createMoonFx(renderer) {
  const U = {
    uMap: { value: null }, uRelief: { value: null }, uReliefK: { value: 0 },
    uRot: { value: new THREE.Matrix3() }, uCenter: { value: new THREE.Vector3(60, 0, 0) }, uSun: { value: new THREE.Vector3(1, 0, 0) },
    uRtrue: { value: MOON_R_KM / RE_KM }, uRsh: { value: EARTH_SHADOW_KM / RE_KM }, uSunAng: { value: Math.asin(SUN_R_KM / AU_KM) }, uEs: { value: 0 }
  }
  const geo = new THREE.SphereGeometry(1, MOON_SEG_W, MOON_SEG_H)
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG,
    depthTest: true, depthWrite: true, transparent: false, toneMapped: false })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = MOON_EARTH_ORDER
  mesh.frustumCulled = false   // 超出 far 的极端机位靠顶点着色器夹深度，包围球剔除会抢先把它整个丢掉
  mesh.visible = false
  let scale = MOON_SCALE_DEF, ready = false, haveState = false, disposed = false
  const _m = new THREE.Matrix4(), _c = new THREE.Vector3(), _q = new THREE.Quaternion()
  const caps = renderer.capabilities || {}
  const maxTex = caps.maxTextureSize || 4096
  const aniso = Math.max(1, Math.min(8, caps.getMaxAnisotropy ? caps.getMaxAnisotropy() : 1))
  function prep(t, srgb) {
    // 纹理上限不到 4096 的机器（WebGL2 下限是 2048）：缩到 2048 宽再上，超限时 WebGL 不报错、只出一个黑球
    if (t.image && t.image.width > maxTex) {
      const w = Math.min(maxTex, 2048), h = w / 2, cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      cv.getContext('2d').drawImage(t.image, 0, 0, w, h)
      t.image = cv
    }
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.anisotropy = aniso
    t.needsUpdate = true
    return t
  }
  const show = () => { mesh.visible = ready && haveState }
  // 贴图缺失（漏打包）/ 没有 DOM 的环境（单测）：不画月球、别的照常；坡度图缺失：退回光滑球，彩色照画
  try {
    const loader = new THREE.TextureLoader()
    loader.load(MOON_MAP_URL, (t) => {
      if (disposed) { t.dispose(); return }
      U.uMap.value = prep(t, true); ready = true; show()
    }, undefined, () => {})
    loader.load(MOON_RELIEF_URL, (t) => {
      if (disposed) { t.dispose(); return }
      U.uRelief.value = prep(t, false); U.uReliefK.value = 1
    }, undefined, () => {})
  } catch { /* 同上 */ }
  // 地照 ∝ 从月球看地球的相位：地球相位角 = 日—地—月夹角 ψ，照亮比例 (1 + cos ψ) / 2（新月时 ψ≈0、地球满相）
  function syncEarthshine() {
    const L = U.uCenter.value.length()
    const cpsi = L > 0 ? U.uSun.value.dot(U.uCenter.value) / L : 0
    U.uEs.value = MOON_EARTHSHINE * (1 + cpsi) / 2
  }
  function syncScale() { mesh.scale.setScalar(U.uRtrue.value * scale) }
  syncScale()
  return {
    objects: [],               // 第二趟里没有它的东西
    earthObjects: [mesh],      // 地球那一趟（由编排器挂进地球场景）
    mesh,
    setStyle(o) {
      if (o && Number.isFinite(Number(o.scale))) { scale = Math.max(1, Math.min(10, Number(o.scale))); syncScale() }
    },
    setSun(v) { U.uSun.value.copy(v); syncEarthshine() },
    setState(st) {
      if (!st || !st.center || !st.rot) return
      if (Number.isFinite(st.sunKm) && st.sunKm > 0) U.uSunAng.value = Math.asin(SUN_R_KM / st.sunKm)   // 日面角半径随日地距离 ±1.7%
      U.uCenter.value.set(st.center[0], st.center[1], st.center[2])
      mesh.position.copy(U.uCenter.value)
      // 场景←网格局部 = 场景←月面固连 · 月面固连←网格局部
      const r = st.rot, l = MOON_LOCAL, m = new Array(9)
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = r[i * 3] * l[j] + r[i * 3 + 1] * l[3 + j] + r[i * 3 + 2] * l[6 + j]
      U.uRot.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])
      _m.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
      mesh.quaternion.copy(_q.setFromRotationMatrix(_m))
      haveState = true; syncEarthshine(); show()
    },
    /** 日面（显示角半径 sunR）还露出多少：相机看显示大小的月盘挡住它的比例（眩光 / 星空压暗按它乘，日食时眩光随之收掉） */
    sunVisibility(camera, sunDir, sunR) {
      if (!mesh.visible) return 1
      _c.copy(U.uCenter.value).sub(camera.position)
      const d = _c.length()
      if (!(d > 0)) return 1
      const rho = Math.asin(Math.min(1, U.uRtrue.value * scale / d))
      const sep = Math.acos(Math.max(-1, Math.min(1, _c.dot(sunDir) / d)))
      return 1 - discOverlap(sunR, rho, sep) / (Math.PI * sunR * sunR)
    },
    stats: () => ({ ready, visible: mesh.visible, scale, relief: U.uReliefK.value, center: U.uCenter.value.toArray(), earthshine: U.uEs.value }),
    dispose() {
      disposed = true
      geo.dispose(); mat.dispose()
      if (U.uMap.value) U.uMap.value.dispose()
      if (U.uRelief.value) U.uRelief.value.dispose()
    }
  }
}

// ======================================================================================
// 自动曝光（人眼 / 相机的适应）
// ======================================================================================
// 画面里受光的地球占得越多，星空（亮星、行星、银河）曝光越低：白天的地球占满屏时只剩约 1/3（−1.2 等），
// 远眺（地球只占一小点）或对着夜半球时满曝光 —— 在轨照片里亮地球与星空很少同时拍得清，就是这个道理；
// 用在这里正合适：拉近看地球、看数据时天空自己退下去，远眺时它才出来。
// 估法：屏幕上 32 × 18 个点各打一条视线（格距约 1.3°：拉近拉远时一个点进出地球只改 0.35%，看不出跳），撞上地球（单位球）的按受光程度记亮度 —— 昼半球 1、夜半球 1 − 夜区压暗程度
//（晨昏效果关时地球全亮，夜半球同样记 1），中间用晨昏带的软边接上；没撞上的记 0。系数 = 1 / (1 + ADAPT_K · 平均亮度)。
// 每帧 576 条射线求交，几十微秒；随相机连续变，不另做时间平滑。
const ADAPT_K = 2
const AD_NX = 32, AD_NY = 18
const _adP = new THREE.Vector3(), _adD = new THREE.Vector3()
/** @param {THREE.Camera} camera 已 updateMatrixWorld；@param {THREE.Vector3} sunS 太阳方向（场景轴单位矢量）；@param {number} night 夜区压暗程度 0..1 */
export function adaptFactor(camera, sunS, night) {
  const C = camera.position, cc = C.lengthSq() - 1
  const nd = Math.max(0, Math.min(1, Number(night) || 0))
  let sum = 0
  for (let iy = 0; iy < AD_NY; iy++) {
    for (let ix = 0; ix < AD_NX; ix++) {
      _adD.set((ix + 0.5) / AD_NX * 2 - 1, (iy + 0.5) / AD_NY * 2 - 1, 0.5).unproject(camera).sub(C).normalize()
      const b = C.dot(_adD), disc = b * b - cc
      if (disc < 0) continue
      const t = -b - Math.sqrt(disc)
      if (t < 0) continue
      _adP.copy(C).addScaledVector(_adD, t)
      const mu = _adP.dot(sunS)
      const lit = Math.max(0, Math.min(1, (mu + 0.08) / 0.2))   // 晨昏带软边：太阳高度 −4.6° … +6.9°
      sum += lit + (1 - lit) * (1 - nd)
    }
  }
  return 1 / (1 + ADAPT_K * sum / (AD_NX * AD_NY))
}

// ======================================================================================
// 编排器
// ======================================================================================
/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} [earthScene] 地球场景：大气挂进去、在地球那一趟里画（不给就不画大气）
 * @param {() => number} [nightDark] 夜半球压得多暗（0 = 晨昏效果关、地球全亮 … 1 = 全黑），自动曝光按它估画面里的亮度
 * 用法（scene.js）：setStars / setPlanets / setAtmosphere / setSun / setMoon 传 null = 关（放掉该件的 GPU 资源），传 {…} = 开 + 样式；
 * setTime(太阳场景轴单位矢量, GMST, 月球状态, 时刻) 每拍一次；每帧 prepare 在地球那一趟之前、renderMain 在它之后、renderGlare 在叠加层之后。
 */
export function createSpaceFx(renderer, earthScene, nightDark) {
  const scene = new THREE.Scene()
  let occ = null, stars = null, planets = null, atmo = null, sun = null, moon = null, soft = null
  const sunS = new THREE.Vector3(1, 0, 0)
  let lastGlare = 0, moonState = null, starFrame = inertialToSceneRows(0), lastDate = null, lastAdapt = 1
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
  // 日面被（显示大小的）月盘挡掉的比例 → 1 = 没挡。月球关着 / 太阳关着都是 1
  const moonSunVis = (camera) => (moon && sun ? moon.sunVisibility(camera, sunS, SUN_R_VIS) : 1)
  function syncOcc() {
    const want = !!(stars || sun || planets)
    if (want && !occ) occ = attach(createOccluder())
    else if (!want && occ) occ = detach(occ)
  }
  return {
    setStars(o) {
      if (!o) stars = detach(stars)
      else { if (!stars) { stars = attach(createStarfield(renderer, weak())); stars.setFrame(starFrame) } stars.setStyle(o) }
      syncOcc()
    },
    /** 行星：null = 关，{ gain } = 开（亮度跟星空同一个滑块） */
    setPlanets(o) {
      if (!o) planets = detach(planets)
      else {
        if (!planets) { planets = attach(createPlanets(renderer, weak())); planets.setTime(lastDate, starFrame) }
        planets.setStyle(o)
      }
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
    /** 月球：null = 关（放掉网格与两张贴图），{ scale } = 开 + 显示放大倍数。挂在地球场景里，不需要遮挡球 */
    setMoon(o) {
      if (!o) moon = detach(moon)
      else {
        if (!moon) { moon = attach(createMoonFx(renderer)); moon.setSun(sunS); if (moonState) moon.setState(moonState) }
        moon.setStyle(o)
      }
    },
    /** dir：太阳（场景轴单位矢量，THREE.Vector3 或 [x,y,z]）；g：GMST（rad）；ms：月球状态（见 createMoonFx.setState，可缺）；
     *  date：同一时刻（给了星空走 ICRF → 场景的整条链：岁差 + 章动 + GAST；不给只转 GMST） */
    setTime(dir, g, ms, date) {
      if (dir) {
        if (dir.isVector3) sunS.copy(dir); else sunS.set(dir[0], dir[1], dir[2])
        sunS.normalize()
        if (atmo) atmo.setSun(sunS)
        if (sun) sun.setSun(sunS)
        if (moon) moon.setSun(sunS)
      }
      if (Number.isFinite(g)) {
        starFrame = date != null ? icrfToSceneRows(date, g) : inertialToSceneRows(g)
        if (stars) stars.setFrame(starFrame)
      }
      if (date != null) lastDate = date
      if (planets) planets.setTime(date != null ? date : null, starFrame)
      if (ms) { moonState = ms; if (moon) moon.setState(ms) }
    },
    any: () => !!(stars || planets || atmo || sun || moon),
    /** 地球那一趟【之前】：大气在那一趟里画，它的标高 / 视轴 / 环带半径要先按本帧相机摆好 */
    prepare(camera, w, h) { if (atmo) atmo.update(camera, w, h) },
    renderMain(r, camera, w, h) {
      if (!stars && !planets && !sun) return   // 大气在地球那一趟里画（prepare 摆好），这一趟只有星空 / 行星 / 日面
      camera.updateMatrixWorld()
      if (stars || planets) {
        const dim = sun ? sun.dimFactor(camera) * moonSunVis(camera) : 0
        lastAdapt = adaptFactor(camera, sunS, nightDark ? nightDark() : 0)
        if (stars) stars.update(r, dim, lastAdapt)
        if (planets) planets.update(r, dim, lastAdapt)
      }
      const ac = r.autoClear
      r.autoClear = false
      try { r.render(scene, camera) } finally { r.autoClear = ac }
    },
    renderGlare(r, camera, w, h, extVis) {
      // 月面挡住日面多少（日食）：日面本身由深度测试挡掉，屏幕空间的眩光得在这里一并收
      const ev = (extVis == null ? 1 : extVis) * moonSunVis(camera)
      lastGlare = sun && !weak() ? sun.renderGlare(r, camera, w, h, ev) : 0
      return lastGlare
    },
    /** 验证台 / 调试读数 */
    stats: () => ({ stars: stars ? stars.stats() : null, planets: planets ? planets.stats() : null, atmo: atmo ? atmo.stats() : null, sun: sun ? sun.stats() : null, moon: moon ? moon.stats() : null, occluder: !!occ, glare: lastGlare, adapt: lastAdapt, soft: weak() }),
    sunDir: () => [sunS.x, sunS.y, sunS.z],
    /** 验证台量帧时用：大气的两块网格（环带 ring / 贴进大气时的全屏 fs，都在地球场景里） */
    _atmoMeshes: () => (atmo ? atmo.meshes : null),
    /** 验证台用：月球网格（地球场景里） */
    _moonMesh: () => (moon ? moon.mesh : null),
    /** 验证台用：当前 ICRF → 场景的转动（行主序 3×3） */
    _starFrame: () => starFrame.slice(),
    dispose() { occ = detach(occ); stars = detach(stars); planets = detach(planets); atmo = detach(atmo); sun = detach(sun); moon = detach(moon) }
  }
}

// ======================================================================================
// 设置口径（地图设置 · 宇宙空间）：出厂值、取值范围与存档迁移 —— 页面与单测共用这一份
// ======================================================================================
/** 出厂值：总开关另存（出厂关）；打开总开关即得完整效果（晨昏线以外各项都勾）。
 *  地球影像 = 原「影像底图」并进来（2026-09-24 用户定）：档位 / 亮度仍存在页面的 imagery.k / bright，这里只管勾不勾。
 *  shadeColor / shadeOpacity：晨昏线自带的夜区阴影（硬边、整个夜半球一个不透明度，v1.4.13「夜区遮罩」的出厂值）——
 *  只在晨昏效果【不勾】时画；晨昏效果勾着时夜区由它接管（柔和过渡带），不叠两层。强度 0 = 只剩线 */
export const SPACE_DEF = Object.freeze({
  stars: true, starGain: 1, planets: true, atmo: true, atmoGain: 1, sun: true, sunGlare: 1, moon: true, moonScale: MOON_SCALE_DEF, img: true,
  night: true, nightColor: '#030814', nightOpacity: 0.72, line: false, lineColor: '#ffd27a', lineWidth: 1.2, lineOpacity: 0.75,
  shadeColor: '#0a1120', shadeOpacity: 0.42
})
/** 数值项的取值范围（= 侧栏滑块的 min / max）：存档里越界的值夹回来，而不是原样喂给着色器 */
export const SPACE_RANGE = Object.freeze({
  starGain: [0.2, 2], atmoGain: [0.2, 2], sunGlare: [0, 2], moonScale: [1, 10], nightOpacity: [0, 0.95], lineWidth: [0.1, 4], lineOpacity: [0, 1], shadeOpacity: [0, 0.95]
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
 *     termOn=true 或 imagery.on=true → 总开关开，星空 / 行星 / 大气辉光 / 太阳 / 月球 / 晨昏效果【不勾】，地球影像 = 旧 imagery.on；
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
    Object.assign(out, { stars: false, planets: false, atmo: false, sun: false, moon: false, img, night: false, line: shade || line })
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
