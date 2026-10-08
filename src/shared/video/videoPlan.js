// 视频导出的纯计算：节奏（帧数 / 时长 / 倍速 / 步长）、分辨率预设、取景框、H.264 编码档与码率、体积估算；外加导出入口的单飞闸。
// 不碰 Vue / DOM / WebCodecs —— node 直接测（packages/core/test/videoPlan.test.mjs）。
//
// 节奏的三种填法（STK Movie Timeline 向导「Time and Length」同一个三角关系）：
//   speed     倍速 X     = 每秒视频走多少仿真秒            → 视频时长 D = S / X
//   duration  视频时长 D                                   → 倍速 X = S / D
//   step      每帧步长 s = 相邻两帧之间的仿真秒             → 帧数 N = ⌊S / s⌋ + 1
// 三者都折成帧数 N（含首尾两帧），第 k 帧的时刻 = t0 + (t1 − t0) · k / (N − 1)：首尾两帧恰好落在起止时刻上。
// N = 1 是单帧（单张图像）：起止重合（S = 0）、或填的数连一个帧间隔都撑不满（步长 > 时段 等），唯一一帧落在起始时刻。
import { fmtSpanSec } from '../tlPeriod.js'

export const FPS_LIST = [24, 25, 30, 50, 60]
export const MAX_DIM = 4096            // H.264 Level 5.2 的单边上限（OpenH264 / MF 都按它）；3D 帧缓冲 ~32 MPix 也由此兜住
export const MIN_DIM = 64
export const MAX_FRAMES = 360000       // 60 fps × 100 min：再多就不是一段演示视频了

export const RES_PRESETS = [
  { key: '720p', w: 1280, h: 720 },
  { key: '1080p', w: 1920, h: 1080 },
  { key: '1440p', w: 2560, h: 1440 },
  { key: '2160p', w: 3840, h: 2160 },
  { key: 'square', w: 1080, h: 1080 },
  { key: 'portrait', w: 1080, h: 1920 }
]

// 码率档：每像素每帧多少比特（bpp）。按「屏幕内容」取：细彩线 + 小字比自然影像难压，
// 档位取 YouTube 上传推荐（1080p30 约 8 Mbps）的 1～2.7 倍。1080p30：标准 7.5 / 高 12.4 / 极高 21.8 Mbps
export const QUALITY_BPP = { std: 0.12, high: 0.2, max: 0.35 }
export const BITRATE_MIN = 1e6
export const BITRATE_MAX = 240e6

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/** 宽高规整：取偶数（4:2:0 的硬要求）、夹在 [MIN_DIM, MAX_DIM] */
export function evenDims(w, h) {
  const f = (v) => clamp(Math.round((Number(v) || 0) / 2) * 2, MIN_DIM, MAX_DIM)
  return { w: f(w), h: f(h) }
}

/**
 * 节奏 → 帧数与派生量。spanSec = 仿真时段长（秒，≥ 0；0 = 起止重合）。
 * p = { mode: 'speed'|'duration'|'step', speed, durationSec, stepSec }
 * 返回 { frames, durationSec, speed, stepSec, ok, tooMany }。ok=false 表示时段或填的数无效；
 * frames = 1（单帧）时没有帧间隔，durationSec / speed / stepSec 记 0
 */
export function computePace(spanSec, fps, p) {
  const S = Number(spanSec), F = Number(fps)
  const out = { frames: 0, durationSec: 0, speed: 0, stepSec: 0, ok: false, tooMany: false }
  if (!(S >= 0) || !Number.isFinite(S) || !(F > 0) || !p) return out
  let N = 1                          // 起止重合：只有一个时刻可画，与节奏怎么填无关
  if (S > 0) {
    if (p.mode === 'step') {
      const s = Number(p.stepSec)
      if (!(s > 0)) return out
      N = Math.floor(S / s + 1e-9) + 1
    } else {
      const D = p.mode === 'duration' ? Number(p.durationSec) : S / Number(p.speed)
      if (!(D > 0) || !Number.isFinite(D)) return out
      N = Math.round(D * F) + 1
    }
  }
  if (!(N >= 1)) return out
  if (N > MAX_FRAMES) { out.tooMany = true; N = MAX_FRAMES }
  out.frames = N
  if (N > 1) {
    out.durationSec = (N - 1) / F
    out.stepSec = S / (N - 1)
    out.speed = out.stepSec * F
  }
  out.ok = true
  return out
}

/** 第 k 帧（0 起）的仿真时刻：首尾两帧精确落在 t0 / t1 上 */
export function frameTime(t0, t1, N, k) {
  if (N <= 1) return t0
  if (k <= 0) return t0
  if (k >= N - 1) return t1
  return t0 + (t1 - t0) * k / (N - 1)
}

/** 第 k 帧的展示时间戳（微秒）：严格等间隔，供编码器与封装 */
export const frameTsUs = (k, fps) => Math.round(k * 1e6 / fps)

/**
 * 取景框：在舞台（屏上地图区，CSS px）里按出片宽高比取最大的居中矩形（contain）——取景永远落在看得见的地方，
 * 预览即成片。返回 { x, y, w, h }（CSS px，浮点）
 */
export function cropRect(stageW, stageH, W, H) {
  const sw = Math.max(1, Number(stageW) || 1), sh = Math.max(1, Number(stageH) || 1)
  const A = W / H
  let w = sw, h = sw / A
  if (h > sh) { h = sh; w = sh * A }
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h }
}

/**
 * 出帧的渲染几何。u = 标注缩放（1 = 与屏上同比例；>1 = 标注 / 线宽相对画面放大）。
 * 渲染按【整个舞台】出（3D 不动相机视锥、2D 不动地图变换，与屏上同一个取景），再从中裁出取景框：
 *   渲染 CSS 尺寸 = 舞台 / u，像素倍率 pr = W · u / crop.w，裁切源矩形 = crop / u · pr（设备像素）。
 * ss = 超采样倍数（3D 用：渲染按 pr·ss 出、合成时缩回）
 */
export function renderGeom(stageW, stageH, crop, W, H, u = 1, ss = 1) {
  const uu = clamp(Number(u) || 1, 0.25, 4)
  const pr = W * uu / crop.w
  const k = pr * ss
  return {
    cssW: stageW / uu, cssH: stageH / uu, pr, ss, renderPr: k,
    src: { x: crop.x / uu * k, y: crop.y / uu * k, w: crop.w / uu * k, h: crop.h / uu * k }
  }
}

// —— H.264 Level（ITU-T H.264 表 A-1）：MaxFS（宏块/帧）、MaxMBPS（宏块/秒）、MaxBR（kbit/s，Baseline/Main；High ×1.25）——
const LEVELS = [
  { id: 30, fs: 1620, mbps: 40500, br: 10000 },
  { id: 31, fs: 3600, mbps: 108000, br: 14000 },
  { id: 32, fs: 5120, mbps: 216000, br: 20000 },
  { id: 40, fs: 8192, mbps: 245760, br: 20000 },
  { id: 41, fs: 8192, mbps: 245760, br: 50000 },
  { id: 42, fs: 8704, mbps: 522240, br: 50000 },
  { id: 50, fs: 22080, mbps: 589824, br: 135000 },
  { id: 51, fs: 36864, mbps: 983040, br: 240000 },
  { id: 52, fs: 36864, mbps: 2073600, br: 240000 }
]
/**
 * 选 H.264 High Profile 的最低可行 Level → codec 串 'avc1.64 00 LL'。
 * 判据三条都要过：每帧宏块数 ≤ MaxFS、单边宏块数 ≤ √(8·MaxFS)、宏块速率 ≤ MaxMBPS、码率 ≤ MaxBR×1.25（High）。
 * 都过不了（超出 5.2）返回 null
 */
export function h264Codec(W, H, fps, bitrate) {
  const mbw = Math.ceil(W / 16), mbh = Math.ceil(H / 16), fs = mbw * mbh, mbps = fs * fps
  for (const L of LEVELS) {
    const side = Math.sqrt(8 * L.fs)
    if (fs <= L.fs && mbw <= side && mbh <= side && mbps <= L.mbps && (!bitrate || bitrate <= L.br * 1250)) {
      return { codec: 'avc1.6400' + L.id.toString(16).padStart(2, '0').toUpperCase(), level: L.id / 10 }
    }
  }
  return null
}

/** 码率（bit/s）：档位按 bpp，custom 按 Mbps；夹在 [1, 240] Mbps */
export function bitrateOf(W, H, fps, q, mbps) {
  const b = q === 'custom' ? Number(mbps) * 1e6 : W * H * fps * (QUALITY_BPP[q] || QUALITY_BPP.high)
  return Math.round(clamp(Number.isFinite(b) && b > 0 ? b : W * H * fps * QUALITY_BPP.high, BITRATE_MIN, BITRATE_MAX))
}

/** 关键帧间隔（帧）：按秒给，至少 1 帧 */
export const gopFrames = (fps, sec) => Math.max(1, Math.round(fps * (Number(sec) > 0 ? Number(sec) : 1)))

/**
 * 体积估算（字节）。MP4 = 码率 × 时长（容器开销 < 0.5%，忽略）；
 * 图片序列按经验每像素字节：PNG ≈ 1.2（带影像底图的地图，实测 1.1–1.3）、JPEG ≈ 0.12 × 质量系数
 */
export function estimateBytes(format, W, H, frames, durationSec, bitrate, jpegQ = 0.9) {
  if (format === 'mp4') return bitrate * durationSec / 8
  const px = W * H * frames
  if (format === 'png') return px * 1.2
  return px * (0.05 + 0.25 * Math.pow(clamp(Number(jpegQ) || 0.9, 0.3, 1), 3))
}

/**
 * 导出入口的单飞闸：fn 还在跑（含等保存框、等覆盖确认这些异步段）时再调，直接返回 undefined，不并发第二路。
 * ★ 闸在【同步】入口落下 —— 第一个 await 之前：「开始导出」双击时，第一下要等保存框关了才进 running，
 *   只看 phase 的话第二下照样进来，弹两个保存框、两路同时出帧。跑完、抛错、中途 return 都在 finally 里抬起。
 * flag = { value }：传 Vue ref 进来，按钮就能据此禁用
 */
export function singleFlight(fn, flag = { value: false }) {
  return async (...args) => {
    if (flag.value) return undefined
    flag.value = true
    try { return await fn(...args) } finally { flag.value = false }
  }
}

// —— 读数格式 ——
const p2 = (n) => String(n).padStart(2, '0')
/** 秒 → 'm:ss' / 'h:mm:ss'（视频时长） */
export function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`
}
/** 字节 → 'KB / MB / GB' */
export function fmtBytes(b) {
  const v = Number(b) || 0
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1048576).toFixed(v < 100 * 1048576 ? 1 : 0) + ' MB'
  return (v / 1073741824).toFixed(2) + ' GB'
}
/** 倍速读数：×1,800 / ×0.5 */
export function fmtSpeed(x) {
  const v = Number(x) || 0
  if (v >= 100) return '×' + Math.round(v).toLocaleString('en-US')
  return '×' + String(Math.round(v * 100) / 100)
}
/**
 * 仿真秒读数（面板的「时长」与「每帧步长」）：共用的 fmtSpanSec 取整到秒，亚秒步长（倍速 ×1 @ 30 fps = 0.033 s/帧）
 * 会读成「0s」。10 s 以下带小数 —— 1 s 起两位小数、1 s 以下两位有效数字；10 s 起照旧 5m30s / 1h 那套。
 * 步长输入框的回填也走它：parseDur 认得「0.5s」「2.5s」
 */
export function fmtSimSec(sec) {
  const v = Number(sec) || 0
  if (!(v > 0) || v >= 10) return fmtSpanSec(v)
  const r = v >= 1 ? Math.round(v * 100) / 100 : Number(v.toPrecision(2))
  if (r >= 10) return fmtSpanSec(r)                                    // 9.996 → 10
  const dp = r >= 1 ? 2 : Math.min(20, 1 - Math.floor(Math.log10(r)))   // toFixed 不用 String：极小步长 String 会出科学计数（2.8e-6）
  return r.toFixed(dp).replace(/\.?0+$/, '') + 's'
}
