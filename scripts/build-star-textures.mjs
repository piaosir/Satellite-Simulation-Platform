// 星空（地图设置 · 宇宙空间 · 星空）：把三份 NASA 原件转成随包分发的两张图 + 一个亮星表模块 ——
//   ① 银河底图 stars_mw_4k.jpg（4096×2048，灰度 JPEG q90）：NASA SVS「Deep Star Maps 2020」（svs.gsfc.nasa.gov/4851）的
//      milkyway_2020_8k.exr（Gaia DR2 暗星 + 弥漫光，已去掉 Hipparcos / Tycho 星）+ hiptyc_2020_8k.exr（Hipparcos / Tycho 星），
//      做成【只有弥漫光、没有点源】的一张图 —— 人眼看银河的样子：亮于 6.5 等的星由渲染端按耶鲁亮星表 BSC5 画成点精灵（见 ③），
//      更暗的星单颗看不见、只汇成银河的光：
//        · hiptyc 层先把 BSC 星的光斑抹掉，剩下的（V 6.5–11.5）块平均到 1K 再高斯模糊 σ ≈ 0.5°，当「看不清的星光」加回去；
//        · milkyway 层 8K 上 3×3 中值滤掉 Gaia 暗星的颗粒（一两个像元大），弥漫光与尘埃带的边留着，再 2×2 平均到 4K。
//      2026-10-07 先做过一版 8K、把这些暗星当颗粒原样留在图里（长曝光照片的样子）：满屏细碎星点抢戏，用户要「真实且不抢戏」，改成这样。
//      像素值是辐亮度（逐纬度核过：星斑总和 × cos δ 与纬度无关），存亮度 Y 的 1/2.2 次幂编码：v = (Y / LMAX)^(1/2.2)，LMAX 按分位数定。
//   ② 银河色度 stars_mw_color_1k.png（1024×512，无损 PNG）：同一底图按 8×8 块平均后的归一化颜色 rgb / max(r,g,b)，
//      渲染端按亮度归一后乘 ① 的亮度。人眼对色度的分辨率远低于亮度（JPEG / 视频都把色度降采样），银河的颜色又是大片慢变的
//      （核球偏暖、尘埃带偏红褐、麦云偏蓝白）；2K 试过，块里单颗蓝星把一小片染蓝的噪点更多、PNG 还大到 4.3 MB。
//      亮度单独存单通道 —— GPU 上 R8 4K（8 MB）+ RGBA 1K（2 MB）。
//   ③ 亮星表 src/viz/globe3d/starfield.data.js：BSC5（9096 颗，V ≤ 约 6.5）的星位（J2000 赤道 + 自行推到 STAR_EPOCH）、V 星等、B−V、HR 号，
//      以及 ①② 的编码常数与亮度标定 STAR_BG_KSR（底图单位下，一颗 0 等星的辐亮度对立体角的积分；hiptyc 层上拿孤立星标定），
//      渲染端据它把银河的曝光锚在星的曝光上（再按「人眼看弥漫光」的比例收一截，见 spaceFx.js ② 节）。
//
// ★ 授权（为什么亮星用 BSC5、不用 Hipparcos 星表）：CDS 上的 Hipparcos 原始星表（I/239）标注 CC-BY-NC 3.0 IGO（禁商用），
//   本平台是商用软件，不随包分发它。BSC5 是 NASA 天文数据中心（NSSDC/ADC）出品，HEASARC 标 table_security = public。
//   SVS 星图是 NASA 素材（NASA Media Usage Guidelines，不受版权保护），署名按 SVS 页面要求：
//   NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.
//   （CDS 的下载入口另有 Anubis 反爬验证，脚本拿不到原件 —— 这也是 BSC5 改从 HEASARC 取的原因）
//
// ── 原件里实测出来的事实（脚本逐条自检，不符就报错不落盘）──
//   · SVS 星图：等经纬、中线 = 赤经 0h、赤经向左增大、上边 = +90°；EXR 半浮点、线性、ZIP 压缩；three 的 EXRLoader 解出来行序自下而上。
//   · hiptyc 层的亮星核心削顶在 1.0（V < 约 5 的星），故它不是测光量 —— 我们本来就要把这些星抹掉，不影响；
//     V ≥ 5 的星不削顶、峰值 ∝ 流量（V = 5 峰值约 0.96），星斑核心 σ ≈ 0.5 像元，亮星另有 r^−4 的宽翼（天狼星翼到 ~11 像元仍有 0.001）。
//   · 两层同一把亮度尺（SVS 原意 starmap = milkyway + hiptyc）：中位天空 0.003 ≈ 23 mag/arcsec²，银河亮处 0.06 ≈ 20，与积分星光量级相符。
//
// 用法（走 Electron 的 nativeImage 编码 JPEG / PNG —— 与 build-moon-textures.mjs 同一理由，不为构建引入 sharp 之类依赖）：
//     npm run stars:textures      # 缺原件时自动下载约 190 MB 到 .stars-src/（已进 .gitignore），再生成三份产物
import { app, nativeImage, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, '.stars-src')
const OUT_TEX = path.join(ROOT, 'src', 'viz', 'globe3d', 'textures')
const OUT_DATA = path.join(ROOT, 'src', 'viz', 'globe3d', 'starfield.data.js')
const SVS = 'https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/'
const MW_SRC = 'milkyway_2020_8k.exr'
const HT_SRC = 'hiptyc_2020_8k.exr'
const BSC_URL = 'https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz'
const BSC_SRC = 'heasarc_bsc5p.tdat.gz'
const LUM_OUT = 'stars_mw_4k.jpg'
const COL_OUT = 'stars_mw_color_1k.png'
const W = 8192, H = 4096, N = W * H
const LW = 4096, LH = 2048, LN = LW * LH   // 亮度图
const CW = 1024, CH = 512, CB = W / CW   // 色度图：8×8 块平均
const UNRESOLVED_SIGMA = 1.5              // hiptyc 残余星光的模糊 σ（1K 像元 ≈ 0.53°）
// 亮度编码：v = (Y / LMAX)^(1/GAMMA)。LMAX 取 99.9995% 分位（构建时算，写进 starfield.data.js）；GAMMA 2.2 让中位天空落在第 30 级上下，
// 8 位量化步长折到显示上不到半级
const GAMMA = 2.2
const JPEG_Q = 90
const STAR_EPOCH = 2026.0   // 自行推到的历元（儒略年）：几十年内最快的 BSC 星（Groombridge 1830，7″/年）也只挪几角分，画面上看不出
const D2R = Math.PI / 180

if (process.env.HTTPS_PROXY || process.env.https_proxy) app.commandLine.appendSwitch('proxy-server', process.env.HTTPS_PROXY || process.env.https_proxy)

// ------------------------------------------------------------------ 下载
async function ensureSource(name, url, minBytes, check) {
  fs.mkdirSync(SRC, { recursive: true })
  const f = path.join(SRC, name)
  if (fs.existsSync(f) && fs.statSync(f).size >= minBytes && check(fs.readFileSync(f))) { console.log(`  ${name} 已有`); return f }
  process.stdout.write(`  ${name} 下载… `)
  const r = await net.fetch(url)
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < minBytes || !check(buf)) throw new Error(`${name} 下载不完整或格式不对（${buf.length} 字节）`)
  fs.writeFileSync(f, buf)
  console.log((buf.length / 1048576).toFixed(1) + ' MB')
  return f
}
const isExr = (b) => b.length > 8 && b.readUInt32LE(0) === 20000630
const isGz = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b

// ------------------------------------------------------------------ EXR（three 的 EXRLoader，半浮点原样取出、查表转 float）
const HALF = (() => {
  const t = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15)
  }
  return t
})()
function readExr(file) {
  const b = fs.readFileSync(file)
  const L = new EXRLoader()
  L.setDataType(THREE.HalfFloatType)
  const r = L.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  if (r.width !== W || r.height !== H) throw new Error(`${path.basename(file)} 尺寸 ${r.width}×${r.height}，应为 ${W}×${H}`)
  const ch = r.data.length / N
  if (ch !== 4) throw new Error(`${path.basename(file)} 解出 ${ch} 通道，应为 RGBA`)
  return r.data   // Uint16Array（半浮点）RGBA，行 0 = 最南（−90°）
}

// ------------------------------------------------------------------ BSC5（HEASARC tdat：竖线分隔、字段顺序见 line[1]）
function readBsc(file) {
  const txt = zlib.gunzipSync(fs.readFileSync(file)).toString('latin1')
  const m = txt.match(/^line\[1\] = (.*)$/m)
  if (!m) throw new Error('BSC5 tdat 没有字段说明行')
  const fields = m[1].trim().split(/\s+/)
  const col = (n) => { const i = fields.indexOf(n); if (i < 0) throw new Error('BSC5 缺字段 ' + n); return i }
  const iHr = col('hr'), iRa = col('ra'), iDe = col('dec'), iV = col('vmag'), iBv = col('bv_color'), iPa = col('pmra'), iPd = col('pmdec'), iSp = col('spect_type')
  const body = txt.split('<DATA>')[1]
  if (!body) throw new Error('BSC5 tdat 没有 <DATA> 段')
  const out = []
  for (const line of body.split('<END>')[0].split('\n')) {
    if (!line.trim()) continue
    const c = line.split('|')
    const s = { hr: +c[iHr], ra: parseFloat(c[iRa]), dec: parseFloat(c[iDe]), v: parseFloat(c[iV]), bv: parseFloat(c[iBv]), pa: parseFloat(c[iPa]) || 0, pd: parseFloat(c[iPd]) || 0, sp: (c[iSp] || '').trim() }
    // 14 个非恒星条目（新星 / 星系，1908 年原表遗留的编号）没有位置或星等，跳过
    if (Number.isFinite(s.hr) && Number.isFinite(s.ra) && Number.isFinite(s.dec) && Number.isFinite(s.v)) out.push(s)
  }
  return out
}
// 缺 B−V 的少数星按光谱型首字母给一个典型值（O/B 蓝、M 红；只影响颜色）
const BV_BY_SP = { O: -0.3, B: -0.15, A: 0.1, F: 0.4, G: 0.7, K: 1.15, M: 1.6, C: 2.5, S: 1.6, N: 2.5, R: 1.7, W: -0.3 }
function bvOf(s) { return Number.isFinite(s.bv) ? s.bv : (BV_BY_SP[s.sp.charAt(0)] ?? 0.6) }

// J2000 位置 + 自行（pmRA = cos δ · dα/dt，″/年）→ STAR_EPOCH 的单位矢量（切平面上线性推，再归一）
function epochDir(s) {
  const a = s.ra * D2R, d = s.dec * D2R, dt = STAR_EPOCH - 2000
  const p = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]
  const ea = [-Math.sin(a), Math.cos(a), 0], ed = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)]
  const ka = s.pa * dt / 206264.806, kd = s.pd * dt / 206264.806
  const q = p.map((x, i) => x + ka * ea[i] + kd * ed[i])
  const L = Math.hypot(q[0], q[1], q[2])
  return q.map((x) => x / L)
}

// 图上取位：赤经赤纬（°）→ 解码数组（行 0 = 最南）里的像元坐标（像元中心在 +0.5）
const mapX = (raDeg) => ((((0.5 - raDeg / 360) % 1) + 1) % 1) * W - 0.5
const mapY = (decDeg) => (0.5 + decDeg / 180) * H - 0.5

// 抹除半径（赤道像元，按 cos δ 在横向放宽）：按 SVS 星斑实测，取「该星贡献降到 0.002 以下」的半径再留余量
const ERASE = [[-1.5, 12.5], [0, 10], [1.6, 6.3], [3.5, 4.3], [5.3, 3.0], [6.5, 2.5], [9, 2.5]]
function eraseRadius(v) {
  for (let k = 1; k < ERASE.length; k++) {
    if (v <= ERASE[k][0]) { const [a, ra] = ERASE[k - 1], [b, rb] = ERASE[k]; const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return ra + (rb - ra) * t }
  }
  return 2.5
}
// 逐像元走一颗星的椭圆窗（横向 1/cos δ 放宽），回调 (像元下标, 到星心的赤道像元距离²)
function forDisc(s, r, fn) {
  const x = mapX(s.ra), y = mapY(s.dec), cd = Math.max(0.02, Math.cos(s.dec * D2R)), rx = r / cd
  for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++) {
    if (j < 0 || j >= H) continue
    for (let i = Math.floor(x - rx); i <= Math.ceil(x + rx); i++) {
      const dx = (i - x) * cd, dy = j - y, d2 = dx * dx + dy * dy
      if (d2 <= r * r) fn(j * W + (((i % W) + W) % W), d2)
    }
  }
}
const lumAt = (d, p) => 0.2126 * HALF[d[p * 4]] + 0.7152 * HALF[d[p * 4 + 1]] + 0.0722 * HALF[d[p * 4 + 2]]

// 亮度标定 K：孤立、不削顶（V 5–6.5）、低纬（|δ| < 40°）的 BSC 星，星斑 r ≤ 4 像元内求和减去 5–7 像元环带的本底，乘 cos δ、除以 10^(−0.4V) 取中位数
function calibrate(ht, stars) {
  const sel = stars.filter((s) => s.v >= 5 && s.v <= 6.5 && Math.abs(s.dec) < 40)
  const isolated = (s) => !stars.some((o) => o !== s && Math.abs(o.dec - s.dec) < 0.4 && Math.abs(((o.ra - s.ra + 540) % 360) - 180) * Math.cos(s.dec * D2R) < 0.4)
  const ks = []
  for (const s of sel) {
    if (!isolated(s)) continue
    let sum = 0, n = 0, bg = 0, nb = 0
    forDisc(s, 7, (p, d2) => { const v = lumAt(ht, p); if (d2 <= 16) { sum += v; n++ } else if (d2 >= 25) { bg += v; nb++ } })
    if (!nb) continue
    ks.push((sum - (bg / nb) * n) * Math.cos(s.dec * D2R) / Math.pow(10, -0.4 * s.v))
  }
  ks.sort((a, b) => a - b)
  return { K: ks[Math.floor(ks.length / 2)], n: ks.length, p25: ks[Math.floor(ks.length / 4)], p75: ks[Math.floor(ks.length * 3 / 4)] }
}

// ------------------------------------------------------------------ 滤波
// 3×3 中值（Devillard 的 9 元排序网络；横向绕回、纵向夹边）
function median3x3(src) {
  const out = new Float32Array(N)
  for (let j = 0; j < H; j++) {
    const jm = Math.max(0, j - 1) * W, j0 = j * W, jp = Math.min(H - 1, j + 1) * W
    for (let i = 0; i < W; i++) {
      const im = i ? i - 1 : W - 1, ip = i === W - 1 ? 0 : i + 1
      let p0 = src[jm + im], p1 = src[jm + i], p2 = src[jm + ip], p3 = src[j0 + im], p4 = src[j0 + i], p5 = src[j0 + ip], p6 = src[jp + im], p7 = src[jp + i], p8 = src[jp + ip], t
      if (p1 > p2) { t = p1; p1 = p2; p2 = t } if (p4 > p5) { t = p4; p4 = p5; p5 = t } if (p7 > p8) { t = p7; p7 = p8; p8 = t }
      if (p0 > p1) { t = p0; p0 = p1; p1 = t } if (p3 > p4) { t = p3; p3 = p4; p4 = t } if (p6 > p7) { t = p6; p6 = p7; p7 = t }
      if (p1 > p2) { t = p1; p1 = p2; p2 = t } if (p4 > p5) { t = p4; p4 = p5; p5 = t } if (p7 > p8) { t = p7; p7 = p8; p8 = t }
      if (p0 > p3) { t = p0; p0 = p3; p3 = t } if (p5 > p8) { t = p5; p5 = p8; p8 = t } if (p4 > p7) { t = p4; p4 = p7; p7 = t }
      if (p3 > p6) { t = p3; p3 = p6; p6 = t } if (p1 > p4) { t = p1; p1 = p4; p4 = t } if (p2 > p5) { t = p2; p2 = p5; p5 = t }
      if (p4 > p7) { t = p4; p4 = p7; p7 = t } if (p4 > p2) { t = p4; p4 = p2; p2 = t } if (p6 > p4) { t = p6; p6 = p4; p4 = t }
      if (p4 > p2) { t = p4; p4 = p2; p2 = t }
      out[j0 + i] = p4
    }
  }
  return out
}
// 球面上的高斯模糊（等经纬网格，行 0 = 最北）：纵向 σ 像元；横向按纬度放宽到 σ / cos φ（同一角距离），横向绕回
function blurSphere(src, w, h, sig) {
  const tmp = new Float64Array(w * h), out = new Float64Array(w * h)
  for (let j = 0; j < h; j++) {
    const lat = (90 - (j + 0.5) * 180 / h) * D2R
    const sx = Math.min(w / 6, sig / Math.max(0.02, Math.cos(lat))), R = Math.ceil(3 * sx)
    const k = new Float64Array(2 * R + 1)
    let ks = 0
    for (let d = -R; d <= R; d++) { k[d + R] = Math.exp(-0.5 * (d / sx) ** 2); ks += k[d + R] }
    for (let i = 0; i < w; i++) {
      let s = 0
      for (let d = -R; d <= R; d++) s += k[d + R] * src[j * w + (((i + d) % w) + w) % w]
      tmp[j * w + i] = s / ks
    }
  }
  const R = Math.ceil(3 * sig), k = new Float64Array(2 * R + 1)
  for (let d = -R; d <= R; d++) k[d + R] = Math.exp(-0.5 * (d / sig) ** 2)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0, ks = 0
      for (let d = -R; d <= R; d++) { const jj = j + d; if (jj < 0 || jj >= h) continue; s += k[d + R] * tmp[jj * w + i]; ks += k[d + R] }
      out[j * w + i] = s / ks
    }
  }
  return out
}

// ------------------------------------------------------------------ 主流程
function build(htFile, mwFile, bscFile) {
  const stars = readBsc(bscFile)
  if (stars.length < 9000) throw new Error('BSC5 只读到 ' + stars.length + ' 颗')
  const sirius = stars.find((s) => s.hr === 2491)
  if (!sirius || Math.abs(sirius.v + 1.46) > 0.02 || Math.abs(sirius.ra - 101.2875) > 0.01) throw new Error('BSC5 字段错位：HR 2491 应是天狼星')
  console.log(`  BSC5：${stars.length} 颗（V ${Math.min(...stars.map((s) => s.v)).toFixed(2)} … ${Math.max(...stars.map((s) => s.v)).toFixed(2)}），缺 B−V 的 ${stars.filter((s) => !Number.isFinite(s.bv)).length} 颗按光谱型补`)

  let t0 = Date.now()
  const ht = readExr(htFile)
  console.log(`  hiptyc 解码 ${Date.now() - t0} ms`)
  // 取向自检：天狼星、老人星、织女星在图上的位置要有星斑（削顶到 1.0），且南北镜像处没有
  for (const hr of [2491, 2326, 7001]) {
    const s = stars.find((o) => o.hr === hr)
    let pk = 0, pm = 0
    forDisc(s, 2, (p) => { pk = Math.max(pk, lumAt(ht, p)) })
    forDisc({ ...s, dec: -s.dec }, 2, (p) => { pm = Math.max(pm, lumAt(ht, p)) })
    if (!(pk > 0.9 && pm < 0.5)) throw new Error(`取向自检不过：HR ${hr} 处峰值 ${pk.toFixed(3)}、南北镜像处 ${pm.toFixed(3)}（赤经方向 / 行序反了？）`)
  }
  const cal = calibrate(ht, stars)
  console.log(`  亮度标定 K = ${cal.K.toFixed(1)}（${cal.n} 颗孤立星，四分位 ${cal.p25.toFixed(1)} … ${cal.p75.toFixed(1)}）`)
  if (!(cal.K > 120 && cal.K < 260 && cal.n > 300)) throw new Error('亮度标定异常')
  // 抹掉 BSC 星的光斑（这些星由渲染端画点精灵）
  let erased = 0
  for (const s of stars) forDisc(s, eraseRadius(s.v), (p) => { ht[p * 4] = 0; ht[p * 4 + 1] = 0; ht[p * 4 + 2] = 0; erased++ })
  // 抹干净没有：天狼星抹除圈外 2 像元宽的一环，平均亮度只比 20–26 像元处的本底高一点点（剩的是 r^−4 宽翼的尾巴）
  const re = eraseRadius(sirius.v)
  let ra = 0, na = 0, rb = 0, nb = 0
  forDisc(sirius, 26, (p, d2) => {
    const v = lumAt(ht, p)
    if (d2 > re * re && d2 <= (re + 2) ** 2) { ra += v; na++ } else if (d2 >= 400) { rb += v; nb++ }
  })
  const wing = ra / na - rb / nb
  console.log(`  抹除 ${erased} 个像元；天狼星抹除圈外一环比本底高 ${wing.toFixed(4)}`)
  if (!(wing < 0.004)) throw new Error('天狼星没抹干净')

  t0 = Date.now()
  const mw = readExr(mwFile)
  console.log(`  milkyway 解码 ${Date.now() - t0} ms`)
  // —— 色度块和（1K，8×8 块，行 0 = 最北）：两层的光全算上 —— 看不清的暗星本来就决定银河的颜色 ——
  const cr = new Float64Array(CW * CH), cg = new Float64Array(CW * CH), cb = new Float64Array(CW * CH)
  const yMw = new Float32Array(N), yHt = new Float32Array(N)   // 两层各自的亮度（解码行序：行 0 = 最南）
  for (let j = 0; j < H; j++) {
    const rowC = Math.floor((H - 1 - j) / CB) * CW
    for (let i = 0; i < W; i++) {
      const p = j * W + i, q = p * 4
      const mr = HALF[mw[q]], mg = HALF[mw[q + 1]], mb = HALF[mw[q + 2]], hr = HALF[ht[q]], hg = HALF[ht[q + 1]], hb = HALF[ht[q + 2]]
      yMw[p] = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb
      yHt[p] = 0.2126 * hr + 0.7152 * hg + 0.0722 * hb
      const c = rowC + Math.floor(i / CB)
      cr[c] += mr + hr; cg[c] += mg + hg; cb[c] += mb + hb
    }
  }
  // —— 亮度 ①：milkyway 层 3×3 中值（Gaia 暗星在 8K 上只占一两个像元，中值把它们滤掉、弥漫光与尘埃带的边留着），再 2×2 平均到 4K ——
  t0 = Date.now()
  const med = median3x3(yMw)
  const Y = new Float32Array(LN)   // 4K，行 0 = 最北
  for (let J = 0; J < LH; J++) {
    const j0 = H - 1 - 2 * J, j1 = j0 - 1
    for (let I = 0; I < LW; I++) {
      const i0 = 2 * I
      Y[J * LW + I] = 0.25 * (med[j0 * W + i0] + med[j0 * W + i0 + 1] + med[j1 * W + i0] + med[j1 * W + i0 + 1])
    }
  }
  // —— 亮度 ②：hiptyc 残余（BSC 之外的 Hipparcos / Tycho 星，V 6.5–11.5）块平均到 1K、高斯模糊 σ ≈ 0.5°，当「看不清的星光」加回去 ——
  // 一颗 7 等星摊到 0.5° 上，峰值只有中位天空的十分之一，单颗已看不出；成团的地方（银河里）照样汇成光
  const h1 = new Float64Array(CW * CH)
  for (let j = 0; j < H; j++) {
    const rowC = Math.floor((H - 1 - j) / CB) * CW
    for (let i = 0; i < W; i++) h1[rowC + Math.floor(i / CB)] += yHt[j * W + i]
  }
  for (let c = 0; c < CW * CH; c++) h1[c] /= CB * CB
  const hb = blurSphere(h1, CW, CH, UNRESOLVED_SIGMA)
  for (let J = 0; J < LH; J++) {
    const y1 = (J + 0.5) / (LH / CH) - 0.5, ja = Math.max(0, Math.min(CH - 1, Math.floor(y1))), jb = Math.min(CH - 1, ja + 1), fy = Math.max(0, Math.min(1, y1 - ja))
    for (let I = 0; I < LW; I++) {
      const x1 = (I + 0.5) / (LW / CW) - 0.5, ia = Math.floor(x1), fx = x1 - ia
      const a = ((ia % CW) + CW) % CW, b = (a + 1) % CW
      Y[J * LW + I] += (hb[ja * CW + a] * (1 - fx) + hb[ja * CW + b] * fx) * (1 - fy) + (hb[jb * CW + a] * (1 - fx) + hb[jb * CW + b] * fx) * fy
    }
  }
  console.log(`  弥漫光（中值 + 未分辨星光）${Date.now() - t0} ms`)
  // 削顶上限：99.9995% 分位往上取两位有效数字（球状星团核心之类）
  const sortedY = Float32Array.from(Y).sort()
  const pTop = sortedY[Math.floor(LN * 0.999995)]
  const LMAX = Number((pTop * 1.05).toPrecision(2))
  let clip = 0
  for (let i = 0; i < LN; i++) if (Y[i] > LMAX) clip++
  console.log(`  亮度上限 LMAX = ${LMAX}（99.9995% 分位 ${pTop.toFixed(4)}），削顶 ${clip} 个像元；中位 ${sortedY[LN >> 1].toFixed(5)}`)
  // 点源清干净没有：比 5×5 中值亮一倍、且高出 0.01（中位天空的三倍多）的像元占比 —— 只比倍数会把暗处的统计起伏也算进去（那是 1.8%），
  // 加上绝对门限后剩下的是球状星团（M22、ω Cen…）这类本来就是一团雾的天体（约 0.04%）
  let spots = 0
  const win = new Float32Array(25)
  for (let J = 2; J < LH - 2; J += 2) {
    for (let I = 0; I < LW; I += 2) {
      let k = 0
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) win[k++] = Y[(J + dj) * LW + (((I + di) % LW) + LW) % LW]
      win.sort()
      const v = Y[J * LW + I]
      if (v > 2 * win[12] && v - win[12] > 0.01) spots++
    }
  }
  const spotFrac = spots / ((LH / 2) * (LW / 2))
  console.log(`  残留点源（亮于 5×5 中值两倍）占 ${(spotFrac * 100).toFixed(3)}%`)
  if (spotFrac > 0.001) throw new Error('底图里还有成片的点源没滤掉')
  // 取向自检（4K，行 0 = 最北）：大麦哲伦云亮过它的东西 / 南北镜像，银心方向亮过它的镜像，煤袋暗于两侧银河
  const meanY = (raDeg, decDeg, rDeg) => {
    let s = 0, n = 0
    const y0 = Math.floor((90 - decDeg - rDeg) / 180 * LH), y1 = Math.ceil((90 - decDeg + rDeg) / 180 * LH)
    const rx = rDeg / Math.max(0.05, Math.cos(decDeg * D2R))
    const x0 = Math.floor((0.5 - (raDeg + rx) / 360) * LW), x1 = Math.ceil((0.5 - (raDeg - rx) / 360) * LW)
    for (let y = Math.max(0, y0); y < Math.min(LH, y1); y++) for (let x = x0; x < x1; x++) { s += Y[y * LW + (((x % LW) + LW) % LW)]; n++ }
    return s / n
  }
  const lmc = meanY(80.9, -69.75, 1.5), lmcEW = meanY(360 - 80.9, -69.75, 1.5), lmcNS = meanY(80.9, 69.75, 1.5)
  const gc = meanY(266.4, -29.0, 2), gcEW = meanY(360 - 266.4, -29.0, 2), gcNS = meanY(266.4, 29.0, 2)
  const sack = meanY(193.0, -62.8, 1.2), sackSide = (meanY(181.0, -62.5, 1.2) + meanY(206.0, -61.5, 1.2)) / 2
  console.log(`  自检：大麦云 ${lmc.toFixed(4)}（东西镜像 ${lmcEW.toFixed(4)}、南北镜像 ${lmcNS.toFixed(4)}）；银心 ${gc.toFixed(4)}（${gcEW.toFixed(4)} / ${gcNS.toFixed(4)}）；煤袋 ${sack.toFixed(4)}、两侧 ${sackSide.toFixed(4)}`)
  if (!(lmc > 3 * lmcEW && lmc > 3 * lmcNS && gc > 3 * gcEW && gc > 3 * gcNS && sack < 0.7 * sackSide)) throw new Error('合成底图取向自检不过')

  // ① 亮度图
  const lum = Buffer.alloc(LN * 4)
  for (let i = 0; i < LN; i++) {
    const v = Math.round(255 * Math.pow(Math.min(1, Math.max(0, Y[i] / LMAX)), 1 / GAMMA))
    lum[i * 4] = v; lum[i * 4 + 1] = v; lum[i * 4 + 2] = v; lum[i * 4 + 3] = 255
  }
  const jpg = nativeImage.createFromBitmap(lum, { width: LW, height: LH }).toJPEG(JPEG_Q)
  const back = nativeImage.createFromBuffer(jpg).toBitmap()
  if (back.length !== LN * 4) throw new Error('亮度图 JPEG 回读尺寸不对')
  let es = 0, em = 0
  for (let i = 0; i < LN; i++) { const d = Math.abs(back[i * 4 + 1] - lum[i * 4 + 1]); es += d; if (d > em) em = d }
  if (es / LN > 2) throw new Error('亮度图 JPEG 回读平均误差过大：' + (es / LN).toFixed(2))

  // ② 色度图：块平均 → 归一化颜色 rgb / max。暗块（中位天空的 1/5 以下）颜色只剩噪声，按亮度往中性白收
  const col = Buffer.alloc(CW * CH * 4)
  const blk = CB * CB, ref = 0.003 / 5
  for (let c = 0; c < CW * CH; c++) {
    const r = cr[c] / blk, g = cg[c] / blk, b = cb[c] / blk
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const w = Math.min(1, y / ref)
    let nr = 1, ng = 1, nb = 1
    if (y > 0) { const m = Math.max(r, g, b); nr = r / m; ng = g / m; nb = b / m }
    nr = 1 + (nr - 1) * w; ng = 1 + (ng - 1) * w; nb = 1 + (nb - 1) * w
    const m2 = Math.max(nr, ng, nb)
    col[c * 4 + 2] = Math.round(255 * nr / m2); col[c * 4 + 1] = Math.round(255 * ng / m2); col[c * 4] = Math.round(255 * nb / m2); col[c * 4 + 3] = 255
  }
  const png = nativeImage.createFromBitmap(col, { width: CW, height: CH }).toPNG()
  const pb = nativeImage.createFromBuffer(png).toBitmap()
  for (let i = 0; i < pb.length; i++) if (pb[i] !== col[i]) throw new Error('色度图 PNG 回读与源位图不一致（第 ' + i + ' 字节）')

  // ③ 亮星表：每颗 14 字节小端 —— float32 赤经（rad）、float32 赤纬（rad）、int16 V×100、int16 (B−V)×1000、uint16 HR
  const rec = Buffer.alloc(stars.length * 14)
  stars.forEach((s, k) => {
    const d = epochDir(s)
    const ra = Math.atan2(d[1], d[0]), de = Math.asin(Math.max(-1, Math.min(1, d[2])))
    rec.writeFloatLE(ra < 0 ? ra + 2 * Math.PI : ra, k * 14)
    rec.writeFloatLE(de, k * 14 + 4)
    rec.writeInt16LE(Math.round(s.v * 100), k * 14 + 8)
    rec.writeInt16LE(Math.round(Math.max(-0.5, Math.min(3.2, bvOf(s))) * 1000), k * 14 + 10)
    rec.writeUInt16LE(s.hr, k * 14 + 12)
  })
  const mod = [
    '// 由 scripts/build-star-textures.mjs 生成，勿手改（npm run stars:textures 重新生成）。',
    '// 亮星：耶鲁亮星表 BSC5（Hoffleit & Warren 1991，NASA NSSDC/ADC；取自 HEASARC heasarc_bsc5p，public），' + stars.length + ' 颗，',
    '//   J2000 赤道坐标 + 自行推到 STAR_EPOCH。银河底图：NASA SVS Deep Star Maps 2020（ID 4851）milkyway + hiptyc 两层做成的弥漫光（点源已滤掉）。',
    '//   署名：NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.',
    '// STAR_DATA：base64，每颗 14 字节小端 —— float32 赤经（rad）、float32 赤纬（rad）、int16 V×100、int16 (B−V)×1000、uint16 HR。',
    `export const STAR_EPOCH = ${STAR_EPOCH.toFixed(1)}`,
    `export const STAR_COUNT = ${stars.length}`,
    '/** 底图（只有弥漫光）：texel = (Y / LMAX)^(1/GAMMA)；亮度图与色度图的宽高 */',
    `export const STAR_BG = Object.freeze({ LMAX: ${LMAX}, GAMMA: ${GAMMA}, W: ${LW}, H: ${LH}, CW: ${CW}, CH: ${CH} })`,
    '/** 亮度标定：一颗 V 等星在底图单位下的辐亮度对立体角的积分 = STAR_BG_KSR · 10^(−0.4V)（sr；hiptyc 层上 ' + cal.n + ' 颗孤立星的中位数） */',
    `export const STAR_BG_KSR = ${(cal.K * (2 * Math.PI / W) * (Math.PI / H)).toExponential(5)}`,
    `export const STAR_DATA = '${rec.toString('base64')}'`,
    ''
  ].join('\n')
  return { jpg, png, mod, jpgErr: { mean: es / LN, max: em } }
}

app.whenReady().then(async () => {
  try {
    console.log('原件（.stars-src/）：')
    const htFile = await ensureSource(HT_SRC, SVS + HT_SRC, 45e6, isExr)
    const mwFile = await ensureSource(MW_SRC, SVS + MW_SRC, 120e6, isExr)
    const bscFile = await ensureSource(BSC_SRC, BSC_URL, 5e5, isGz)
    console.log('生成：')
    const r = build(htFile, mwFile, bscFile)
    fs.mkdirSync(OUT_TEX, { recursive: true })
    fs.writeFileSync(path.join(OUT_TEX, LUM_OUT), r.jpg)
    console.log(`  → ${LUM_OUT}  ${LW}×${LH}  q${JPEG_Q}  ${(r.jpg.length / 1048576).toFixed(2)} MB  回读误差 均 ${r.jpgErr.mean.toFixed(2)} / 最大 ${r.jpgErr.max} 级`)
    fs.writeFileSync(path.join(OUT_TEX, COL_OUT), r.png)
    console.log(`  → ${COL_OUT}  ${CW}×${CH}  无损  ${(r.png.length / 1048576).toFixed(2)} MB`)
    fs.writeFileSync(OUT_DATA, r.mod)
    console.log(`  → ${path.relative(ROOT, OUT_DATA)}  ${(r.mod.length / 1024).toFixed(0)} KB`)
    app.exit(0)
  } catch (e) {
    console.error('失败：' + ((e && e.stack) || e))
    app.exit(1)
  }
})
