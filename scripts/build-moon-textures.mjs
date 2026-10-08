// 月球贴图：把 NASA SVS「CGI Moon Kit」（svs.gsfc.nasa.gov/4720）的两份原件转成随包分发的两张图 ——
//   ① 彩色图 moon_lroc_4k.jpg（4096×2048，JPEG q90，约 1.8 MB）：2025-12 版 LROC WAC 彩色镶嵌 lroc_color_16bit_srgb_4k.tif
//      （16 位 sRGB、LZW、无预测器）→ 8 位四舍五入。NASA 已按人眼调过曝光与白平衡，这里不再动颜色。
//   ② 坡度图 moon_relief_1k.png（1024×512，无损 PNG，约 0.7 MB）：LOLA 高程 ldem_16_uint.tif（5760×2880，16 像素/度，
//      uint16 半米、相对 1727.4 km 球）→ 东向 / 北向坡度 dh/ds → 面积平均缩到 1024×512 → R = 东向、G = 北向（B 恒 128 不用），
//      编码 v = 127.5 + s / SLOPE_SCALE × 127.5（渲染端 s = (2·texel − 1) × SLOPE_SCALE）。
//
// ★ 坡度图为什么是无损 PNG、不是 JPEG：坡度是高程的导数，全是高频，JPEG 吃不住 ——
//   2048 宽 RGB 法线图 q95 回读坡度误差 RMS 2.7°、最大 26°（色度下采样让 R / G 两路互相串）；灰度上下拼 q95 仍有 RMS 0.8°。
//   而全月坡度的中位数才 3°（atan 0.055），近晨昏线时 1° 的法线误差就是成片的颗粒。1024 宽无损 PNG 只 0.7 MB、误差只剩 8 位量化（±0.18°）。
//   分辨率 10.6 km/px：放到最大、4 倍出图时月盘约 470 px，可见半球横跨约 326 个纹素，地形起伏够用（细节由 4K 彩色图出）。
//
// 用法（走 Electron 的 nativeImage 编码 —— 本机没有 sharp / ImageMagick / PIL，也刻意不为此引入构建期依赖）：
//     npm run moon:textures           # 缺原件时自动下载（约 95 MB）到 .moon-src/（已进 .gitignore），再生成两张图
//
// 署名：NASA's Scientific Visualization Studio（Ernie Wright, USRA；Noah Petro, NASA/GSFC）；数据 LRO LROC / LOLA。
// NASA 素材不受版权保护（NASA Media Usage Guidelines），可随软件分发，不得暗示 NASA 背书。
//
// ── 两张图共同的取向约定（与地球影像同一套，见 src/viz/imagery.js 文件头）──
// 图左边缘 = 180°W、中线 = 0°（平均正对地球的方向）、上边缘 = 90°N，等经纬、宽高比 2:1。
// 月面经度按 IAU 东经为正：东经 59° 的危海（Mare Crisium）在图中线右侧 —— 地球上北半球看满月时它在右上沿。
// 生成时用已知地物自检（危海 / 风暴洋暗、第谷亮，且第谷比它的东西 / 南北镜像位置都亮），取向或通道错了脚本直接报错不落盘。
import { app, nativeImage, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, '.moon-src')
const OUT = path.join(ROOT, 'src', 'viz', 'globe3d', 'textures')
const BASE_URL = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/'
const COLOR_SRC = 'lroc_color_16bit_srgb_4k.tif'
const DEM_SRC = 'ldem_16_uint.tif'
const COLOR_OUT = 'moon_lroc_4k.jpg'
const RELIEF_OUT = 'moon_relief_1k.png'
const COLOR_Q = 90
const RELIEF_W = 1024, RELIEF_H = 512
const R_MOON_M = 1737400   // LRO 全部数据的参考球半径
// 坡度编码满量程：1024 宽面积平均后实测最大坡度 0.65（2048 宽时 0.77），0.8 留余量不削顶（越界脚本报错）。
// ★ 与 src/viz/globe3d/spaceFx.js 的 MOON_SLOPE_SCALE 必须同值
const SLOPE_SCALE = 0.8

if (process.env.HTTPS_PROXY || process.env.https_proxy) app.commandLine.appendSwitch('proxy-server', process.env.HTTPS_PROXY || process.env.https_proxy)

// ------------------------------------------------------------------ 下载
async function ensureSource(name, minBytes) {
  fs.mkdirSync(SRC, { recursive: true })
  const f = path.join(SRC, name)
  if (fs.existsSync(f) && fs.statSync(f).size >= minBytes && tiffComplete(fs.readFileSync(f))) { console.log(`  ${name} 已有`); return f }
  process.stdout.write(`  ${name} 下载… `)
  const r = await net.fetch(BASE_URL + name)
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (!tiffComplete(buf)) throw new Error(`${name} 下载不完整（条带越出文件尾）`)
  fs.writeFileSync(f, buf)
  console.log((buf.length / 1048576).toFixed(1) + ' MB')
  return f
}

// ------------------------------------------------------------------ TIFF（只认这两份原件用到的子集：单 IFD、条带、无压缩 / LZW、无预测器）
function readTiff(b) {
  const le = b.toString('latin1', 0, 2) === 'II'
  if (!le && b.toString('latin1', 0, 2) !== 'MM') throw new Error('不是 TIFF')
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  if (u16(2) !== 42) throw new Error('不是经典 TIFF（BigTIFF 不支持）')
  const ifd = u32(4), n = u16(ifd), tags = {}
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4)
    const sz = type === 3 ? 2 : (type === 4 ? 4 : 1)
    const off = sz * cnt <= 4 ? e + 8 : u32(e + 8)
    if (type === 3 || type === 4) tags[tag] = Array.from({ length: cnt }, (_, k) => (type === 3 ? u16(off + k * 2) : u32(off + k * 4)))
  }
  const one = (t, d) => (tags[t] ? tags[t][0] : d)
  const t = {
    le, w: one(256), h: one(257), bps: tags[258] || [1], spp: one(277, 1), comp: one(259, 1), pred: one(317, 1),
    planar: one(284, 1), rps: one(278, one(257)), offs: tags[273], lens: tags[279]
  }
  if (!t.offs || !t.lens) throw new Error('只支持条带式 TIFF')
  if (t.planar !== 1) throw new Error('只支持交错存放（PlanarConfiguration=1）')
  if (t.pred !== 1) throw new Error('预测器 ' + t.pred + ' 未实现')
  if (t.comp !== 1 && t.comp !== 5) throw new Error('压缩方式 ' + t.comp + ' 未实现')
  return t
}
function tiffComplete(b) {
  try { const t = readTiff(b); return t.offs.every((o, i) => o + t.lens[i] <= b.length) } catch { return false }
}
// TIFF 的 LZW：高位在前、9→12 位变长码、256 清表 / 257 结束，「提前一码」换宽（libtiff 同一判据：下一个空位 ≥ 2^位宽 − 1）
function lzwDecode(src, out) {
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), len = new Int32Array(4096), first = new Uint8Array(4096)
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; len[i] = 1; first[i] = i }
  let bit = 0, width = 9, next = 258, prev = -1, op = 0
  const nbits = src.length * 8
  const emit = (code) => {
    const L = len[code]
    if (op + L > out.length) throw new Error('LZW 解出的字节多于条带应有长度')
    for (let k = L - 1, c = code; k >= 0; k--, c = prefix[c]) out[op + k] = suffix[c]
    op += L
  }
  for (;;) {
    if (bit + width > nbits) break
    let code = 0
    for (let k = 0; k < width; k++, bit++) code = (code << 1) | ((src[bit >> 3] >> (7 - (bit & 7))) & 1)
    if (code === 257) break
    if (code === 256) { width = 9; next = 258; prev = -1; continue }
    if (prev < 0) { if (code > 255) throw new Error('LZW 首码越界'); emit(code); prev = code; continue }
    let k
    if (code < next) { emit(code); k = first[code] } else if (code === next) {
      k = first[prev]; emit(prev); if (op >= out.length) throw new Error('LZW 越界'); out[op++] = k
    } else throw new Error('LZW 码 ' + code + ' 超出字典（' + next + '）')
    if (next < 4096) { prefix[next] = prev; suffix[next] = k; len[next] = len[prev] + 1; first[next] = first[prev]; next++ }
    if (next >= (1 << width) - 1 && width < 12) width++
    prev = code
  }
  return op
}
/** 整幅原始样本字节（行优先、按条带拼起来） */
function tiffSamples(b, t) {
  const bpp = t.bps.reduce((a, x) => a + x, 0) / 8   // 每像素字节
  const row = t.w * bpp
  const out = new Uint8Array(row * t.h)
  for (let s = 0; s < t.offs.length; s++) {
    const y0 = s * t.rps, rows = Math.min(t.rps, t.h - y0)
    const dst = out.subarray(y0 * row, (y0 + rows) * row)
    const src = b.subarray(t.offs[s], t.offs[s] + t.lens[s])
    if (t.comp === 1) dst.set(src.subarray(0, dst.length))
    else {
      const got = lzwDecode(src, dst)
      if (got !== dst.length) throw new Error(`条带 ${s} 解出 ${got} 字节，应为 ${dst.length}`)
    }
  }
  return out
}

// ------------------------------------------------------------------ 自检用：图上某经纬附近的平均亮度
function meanLum(bgra, w, h, lonDeg, latDeg, radDeg) {
  let s = 0, n = 0
  const x0 = Math.floor((lonDeg - radDeg + 180) / 360 * w), x1 = Math.ceil((lonDeg + radDeg + 180) / 360 * w)
  const y0 = Math.floor((90 - latDeg - radDeg) / 180 * h), y1 = Math.ceil((90 - latDeg + radDeg) / 180 * h)
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = x0; x < x1; x++) {
    const i = ((y * w) + ((x % w) + w) % w) * 4
    s += 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2]; n++
  }
  return s / n
}

// ------------------------------------------------------------------ ① 彩色图
function buildColor(file) {
  const b = fs.readFileSync(file)
  const t = readTiff(b)
  if (t.spp !== 3 || t.bps.some((x) => x !== 16)) throw new Error('彩色原件应为 3 × 16 位')
  const t0 = Date.now()
  const raw = tiffSamples(b, t)
  const n = t.w * t.h
  const bgra = Buffer.alloc(n * 4)
  const rd = t.le ? (o) => raw[o] | (raw[o + 1] << 8) : (o) => (raw[o] << 8) | raw[o + 1]
  for (let i = 0; i < n; i++) {
    const o = i * 6
    bgra[i * 4 + 2] = Math.round(rd(o) / 257)       // R
    bgra[i * 4 + 1] = Math.round(rd(o + 2) / 257)   // G
    bgra[i * 4] = Math.round(rd(o + 4) / 257)       // B
    bgra[i * 4 + 3] = 255
  }
  console.log(`  彩色原件解码 ${t.w}×${t.h}，${Date.now() - t0} ms`)
  // 取向自检：危海（59.1°E 17.0°N）与风暴洋（57°W 18°N）是月海、暗；第谷（11.4°W 43.3°S）是年轻亮环形山；对照取高地（40°E 30°S）
  const crisium = meanLum(bgra, t.w, t.h, 59.1, 17.0, 3), procellarum = meanLum(bgra, t.w, t.h, -57, 18, 4)
  const tycho = meanLum(bgra, t.w, t.h, -11.36, -43.31, 0.6), high = meanLum(bgra, t.w, t.h, 40, -30, 4)
  console.log(`  自检亮度：危海 ${crisium.toFixed(1)}  风暴洋 ${procellarum.toFixed(1)}  第谷 ${tycho.toFixed(1)}  南部高地 ${high.toFixed(1)}`)
  if (!(crisium < high * 0.8 && procellarum < high * 0.8 && tycho > high)) throw new Error('取向自检不过：月海不暗或第谷不亮（经度方向 / 上下颠倒？）')
  // 反向证伪：第谷的东西镜像（11.4°E 43.3°S，普通高地）与南北镜像（11.4°W 43.3°N，雨海北沿）都必须明显暗于第谷本身 ——
  // 判据若对镜像图同样成立，就说明它分辨不出取向。（危海不能拿来做东西镜像：59°W 17°N 恰好也在风暴洋里）
  const mirEW = meanLum(bgra, t.w, t.h, 11.36, -43.31, 0.6), mirNS = meanLum(bgra, t.w, t.h, -11.36, 43.31, 0.6)
  console.log(`  镜像对照：第谷东西镜像 ${mirEW.toFixed(1)}  南北镜像 ${mirNS.toFixed(1)}`)
  if (!(tycho > mirEW * 1.15 && tycho > mirNS * 1.15)) throw new Error('取向自检不过：第谷与它的镜像位置一样亮，判据失效')
  const jpg = nativeImage.createFromBitmap(bgra, { width: t.w, height: t.h }).toJPEG(COLOR_Q)
  return { jpg, w: t.w, h: t.h, ref: bgra }
}

// ------------------------------------------------------------------ ② 坡度图
function buildRelief(file) {
  const b = fs.readFileSync(file)
  const t = readTiff(b)
  if (t.spp !== 1 || t.bps[0] !== 16) throw new Error('高程原件应为单通道 16 位')
  const W = t.w, H = t.h
  const raw = tiffSamples(b, t)
  const hgt = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const v = t.le ? raw[i * 2] | (raw[i * 2 + 1] << 8) : (raw[i * 2] << 8) | raw[i * 2 + 1]
    hgt[i] = v * 0.5 - 10000   // 半米、相对 1727.4 km → 米、相对 1737.4 km
  }
  let hmin = Infinity, hmax = -Infinity
  for (let i = 0; i < hgt.length; i++) { if (hgt[i] < hmin) hmin = hgt[i]; if (hgt[i] > hmax) hmax = hgt[i] }
  console.log(`  高程 ${W}×${H}：${(hmin / 1000).toFixed(2)} … ${(hmax / 1000).toFixed(2)} km`)
  const dLam = 2 * Math.PI / W, dPhi = Math.PI / H
  // 原分辨率上的东向 / 北向坡度（无量纲 dh/ds）。东向差分的步长随纬度放宽（k ≈ 1/cos φ）：高纬一圈像素挤在很短的弧上，
  // 逐像素差分等于拿噪声除以一个很小的距离；放宽到与赤道同一地面间距，坡度就是真实地形的坡度
  const sx = new Float32Array(W * H), sy = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    const lat = (90 - (y + 0.5) * 180 / H) * Math.PI / 180
    const c = Math.cos(lat)
    const k = Math.max(1, Math.min(256, Math.round(1 / c)))
    const dx = 2 * k * R_MOON_M * c * dLam
    const yn = Math.max(0, y - 1), ys = Math.min(H - 1, y + 1)
    const dy = (ys - yn) * R_MOON_M * dPhi
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      sx[i] = (hgt[y * W + (x + k) % W] - hgt[y * W + (x - k + W) % W]) / dx
      sy[i] = (hgt[yn * W + x] - hgt[ys * W + x]) / dy   // 上一行更北
    }
  }
  // 面积平均缩到 RELIEF_W × RELIEF_H（坡度取平均 = 该块地面的平均梯度；渲染端的 mipmap 同理，故坡度图可以放心开 mipmap）
  const fx = W / RELIEF_W, fy = H / RELIEF_H
  const ax = new Float32Array(RELIEF_W * RELIEF_H), ay = new Float32Array(RELIEF_W * RELIEF_H)
  for (let Y = 0; Y < RELIEF_H; Y++) {
    const y0 = Y * fy, y1 = y0 + fy
    for (let X = 0; X < RELIEF_W; X++) {
      const x0 = X * fx, x1 = x0 + fx
      let s1 = 0, s2 = 0, wsum = 0
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0))
          const i = y * W + x
          s1 += sx[i] * wgt; s2 += sy[i] * wgt; wsum += wgt
        }
      }
      ax[Y * RELIEF_W + X] = s1 / wsum; ay[Y * RELIEF_W + X] = s2 / wsum
    }
  }
  const mags = Float32Array.from(ax, (v, i) => Math.hypot(v, ay[i])).sort()
  const pct = (p) => mags[Math.min(mags.length - 1, Math.floor(p * mags.length))]
  console.log(`  坡度（${RELIEF_W} 宽）：中位 ${pct(0.5).toFixed(3)}  p99 ${pct(0.99).toFixed(3)}  p99.9 ${pct(0.999).toFixed(3)}  最大 ${pct(1).toFixed(3)}`)
  let clipped = 0
  const enc = (s) => { const v = Math.round(127.5 + s / SLOPE_SCALE * 127.5); if (v < 0 || v > 255) clipped++; return Math.max(0, Math.min(255, v)) }
  const bgra = Buffer.alloc(RELIEF_W * RELIEF_H * 4)
  for (let i = 0; i < ax.length; i++) {
    bgra[i * 4 + 2] = enc(ax[i]); bgra[i * 4 + 1] = enc(ay[i]); bgra[i * 4] = 128; bgra[i * 4 + 3] = 255
  }
  if (clipped) throw new Error(`坡度超出满量程 ±${SLOPE_SCALE} 的有 ${clipped} 个，调大 SLOPE_SCALE（两处同改）`)
  const png = nativeImage.createFromBitmap(bgra, { width: RELIEF_W, height: RELIEF_H }).toPNG()
  // 无损回读核对：PNG 解出来必须逐字节等于源位图（编码器若擅自做了色彩管理 / 预乘，这里当场抓出来）
  const back = nativeImage.createFromBuffer(png).toBitmap()
  for (let i = 0; i < back.length; i++) if (back[i] !== bgra[i]) throw new Error('坡度图 PNG 回读与源位图不一致（第 ' + i + ' 字节）')
  return { png }
}

// JPEG 回读：与源位图的平均 / 最大逐通道误差（编码器或通道顺序出错时一眼可见）
function roundTrip(jpg, ref, w, h) {
  const back = nativeImage.createFromBuffer(jpg).toBitmap()
  if (back.length !== w * h * 4) throw new Error('JPEG 回读尺寸不对')
  let s = 0, mx = 0
  for (let i = 0; i < back.length; i++) { if ((i & 3) === 3) continue; const d = Math.abs(back[i] - ref[i]); s += d; if (d > mx) mx = d }
  return { mean: s / (w * h * 3), max: mx }
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true })
    console.log('原件（.moon-src/）：')
    const colorFile = await ensureSource(COLOR_SRC, 60e6)
    const demFile = await ensureSource(DEM_SRC, 33e6)
    console.log('彩色图：')
    const c = buildColor(colorFile)
    const rc = roundTrip(c.jpg, c.ref, c.w, c.h)
    if (rc.mean > 4) throw new Error('彩色图 JPEG 回读平均误差过大：' + rc.mean.toFixed(2))
    fs.writeFileSync(path.join(OUT, COLOR_OUT), c.jpg)
    console.log(`  → ${COLOR_OUT}  ${c.w}×${c.h}  q${COLOR_Q}  ${(c.jpg.length / 1048576).toFixed(2)} MB  回读误差 均 ${rc.mean.toFixed(2)} / 最大 ${rc.max}`)
    console.log('坡度图：')
    const r = buildRelief(demFile)
    fs.writeFileSync(path.join(OUT, RELIEF_OUT), r.png)
    console.log(`  → ${RELIEF_OUT}  ${RELIEF_W}×${RELIEF_H}  无损  ${(r.png.length / 1048576).toFixed(2)} MB`)
    app.exit(0)
  } catch (e) {
    console.error('失败：' + ((e && e.stack) || e))
    app.exit(1)
  }
})
