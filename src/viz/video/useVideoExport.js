// 视频导出（H.264 MP4 / PNG · JPEG 图片序列）：设置、屏上取景预览、逐帧离线渲染与编码。
//
// ★ 逐帧离线，不录屏：第 k 帧把全局仿真时钟设到 t_k，等这一拍【全部】订阅者落定（星位 / 覆盖 / 壳层 / 可见性 /
//   晨昏线 / Worker 几何，见 simClock.setTime 的返回值），再按目标分辨率出一帧。帧与帧之间没有真实时间，
//   再慢的场景也不丢帧、不会出现「星在 t、场在 t−Δ」的半拍画面；跟不上只是导出得慢一点。
//   STK 的 Record Movie「Record every Animation Time Step」同一个口径；但这里分辨率与窗口无关（STK 是窗口多大录多大）。
// ★ 取景即预览：取景框 = 在屏上地图区里按成片宽高比取的矩形（videoPlan.cropRect：出厂最大居中，可拖动 / 缩放，见 S.frame），面板开着时屏上把框外压暗、
//   叠加信息按成片比例画上 —— 屏上看到的框就是成片的画面。渲染按整个舞台出（3D 视锥 / 2D 地图变换都与屏上相同），
//   再从中裁出取景框；「标注缩放」把按 CSS px 定尺的线宽 / 字号 / 图标相对画面放大（细彩线经 4:2:0 色度下采样会褪色，加粗是对策）。
// ★ 编码走 WebCodecs（Chromium 自带：硬件经 Media Foundation，软件为 OpenH264），封装是自己写的 MP4（shared/video/mp4Mux.js），
//   边编边按位置写盘（electron/services/videoFile.js）—— 不打包 ffmpeg、内存只占一个写批次。
// ★ 变速（shared/video/videoRamp.js）：成片时间轴 = 节奏 + 变速 + 起止停留（planTimeline），第 k 帧的仿真时刻由它给。
// ★ 宿主（3D 页）只给能力，不给状态：见 host 的各个函数（舞台、视图、场景、平面图、时区、取数）。
import { ref, reactive, computed, watch, shallowRef } from 'vue'
import { clock, setTime as clockSetTime, goLive, play as clockPlay } from '../../stores/simClock.js'
import { frameTsUs, cropRect, renderGeom, normFrame, frameOfRect, FRAME_DEFAULT, h264Codec, bitrateOf, gopFrames, estimateBytes, evenDims, singleFlight, RES_PRESETS, FPS_LIST } from '../../shared/video/videoPlan.js'
import { planTimeline, normRamp, defaultRamp } from '../../shared/video/videoRamp.js'
import { createMp4Muxer } from '../../shared/video/mp4Mux.js'
import { buildHudBlocks, drawHud, drawProgress, satFieldDefaults, hudFontPx } from './hud.js'
import { drawGeoFrame } from '../geo/geoFrame.js'
import { tzParts } from '../../shared/tz.js'
// dictT：主进程回来的报错是中文（主进程不知道界面语言），进度卡挂了 data-i18n-skip，DOM 呈现层碰不到 —— 显示前显式过一遍词典
import { getLang, onLangChange, t as dictT } from '../../shared/i18n/runtime.js'
import appLogoUrl from '../../assets/linklab-avatar-dark.png'

const STORE_KEY = 'video-export-v1'
const SETTINGS_VER = 4              // 2：底板出厂改关（旧存档迁一次）、聚焦卫星改字段勾选、加 2D 经纬图框；3：经纬图框出厂改开（旧存档迁一次）；4：加变速、取景框摆位
const CANCEL = Symbol('cancel')

export function defaultVideoSettings() {
  return {
    ver: SETTINGS_VER,
    rangeMode: 'timeline',          // 'timeline' 时间轴时段（滚动档 = 当前时间窗）| 'window' 当前时间窗 | 'custom'
    startMs: null, stopMs: null,
    fps: 30,
    paceMode: 'speed',              // 'speed' | 'duration' | 'step'
    speed: 600, durationSec: 30, stepSec: 10,
    // 变速（videoRamp.normRamp）：shape 'none' 匀速 | 'in' 渐快 | 'out' 渐慢 | 'inout' 缓入缓出；ratio 变速比；trans 过渡占比；hold0 / hold1 起止停留（秒）
    ramp: defaultRamp(),
    res: '1080p', cw: 1920, ch: 1080,
    annot: 1,                       // 标注缩放
    ss: 'auto',                     // 3D 超采样：'auto'（≤1440p 用 2×）| 'off'
    format: 'mp4',                  // 'mp4' | 'png' | 'jpg'
    q: 'high', mbps: 12, jpegQ: 0.9, enc: 'auto', gopSec: 1,
    framing: true,
    // 取景框摆位（videoPlan.normFrame）：框心相对舞台的位置 x / y（0…1）+ 大小 s（相对最大可容框，0.2…1）；出厂 = 最大居中
    frame: { x: 0.5, y: 0.5, s: 1 },
    // 2D 经纬图框（SATSOFT 式）：step 0 = 自动；fmt 'num' −50.00 / 'hemi' 50°W；theme 留白底色；lines 框内点线网格
    geo: { on: true, step: 0, fmt: 'num', theme: 'light', lines: true },
    hud: {
      size: 1, panel: false, opacity: 0.62, font: 'ui',
      items: {
        time: { on: true, pos: 'tr', date: true, elapsed: false, speed: false },
        title: { on: false, pos: 'tl', text: '', sub: '' },
        sat: { on: true, pos: 'tl', max: 3, heads: true, f: satFieldDefaults() },   // f：逐字段勾选（hud.js SAT_SECS）
        aer: { on: false, pos: 'bl', ids: [] },
        field: { on: false, pos: 'bl', key: '', ids: [], unit: '' },
        legend: { on: false, pos: 'br', key: '' },
        logo: { on: false, pos: 'br', h: 2.2, src: 'app', dataUrl: '' },
        progress: { on: false }
      }
    }
  }
}
// 存档 → 设置：逐项合并到出厂值上（新版本加的项自动补齐、坏值落回出厂）
function mergeDeep(dst, src) {
  if (!src || typeof src !== 'object') return dst
  for (const k of Object.keys(dst)) {
    const a = dst[k], b = src[k]
    if (b === undefined) continue
    if (a && typeof a === 'object' && !Array.isArray(a)) mergeDeep(a, b)
    else if (Array.isArray(a)) { if (Array.isArray(b)) dst[k] = b.slice() }
    else if (typeof b === typeof a || a === null) dst[k] = b
  }
  return dst
}
function loadSettings() {
  const d = defaultVideoSettings()
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (raw) {
      mergeDeep(d, raw)
      // 旧存档里改过出厂值的项是旧出厂值顺手存下来的，按版本各迁一次（按版本门槛判，升版不把用户后来的选择再冲掉）
      const ver = Number(raw.ver) || 1
      if (ver < 2) d.hud.panel = false   // 底板 → 关
      if (ver < 3) d.geo.on = true       // 经纬图框 → 开
    }
  } catch { /* 坏档：出厂值 */ }
  d.ver = SETTINGS_VER
  if (!FPS_LIST.includes(d.fps)) d.fps = 30
  d.ramp = normRamp(d.ramp)
  d.frame = normFrame(d.frame)
  return d
}

const yieldTask = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0) })
function waitDequeue(enc) {
  return new Promise((r) => {
    const f = () => { enc.removeEventListener('dequeue', f); clearTimeout(t); r() }
    enc.addEventListener('dequeue', f)
    const t = setTimeout(f, 60)
  })
}
function canvasBlob(cv, type, q) { return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('画布取图失败'))), type, q)) }
function loadImage(src) {
  return new Promise((res) => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src })
}
const p2 = (n) => String(n).padStart(2, '0')

/**
 * host = {
 *   api,                               window.api（video / 其余）
 *   stageEl(),                         取景所在的舞台元素（地图区，CSS 尺寸即屏上画面）
 *   isFlat(),                          当前是不是 2D 平面图
 *   scene(), flat(),                   两个渲染器（3D：beginCapture / captureFrame / endCapture；2D：exportRender / ensureImagery）
 *   prepare2D(), finish2D(),           2D 导出前后（填充改走 CPU 分带，同 PNG / PDF 导出）
 *   tzMode(),                          显示时区档位
 *   timeline(),                        { fixed, startMs, stopMs, viewLo, viewHi }
 *   sources(),                         面板里的候选：{ sats, stations, points, antennas, activeAnt }
 *   hudData(tMs, items),               本帧叠加数据：{ sats, aer, field, legend }（只算开着的项）
 *   geoView(),                         2D 平面图此刻的投影与屏上变换 { pj, k, tx, ty }（经纬图框用；3D / 未就绪给 null）
 *   uiFont(), log(msg)
 * }
 */
export function useVideoExport(host) {
  const open = ref(false)
  const lang = ref(getLang())
  const offLang = onLangChange((l) => { lang.value = l })
  const T = (zh, en) => (lang.value === 'en' ? en : zh)

  const S = reactive(loadSettings())
  let saveT = 0
  watch(S, () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)) } catch { /* 存不下就算了 */ } }, 400) }, { deep: true })

  const phase = ref('idle')          // 'idle' | 'confirm' | 'running' | 'finishing' | 'done' | 'error' | 'canceled'
  const prog = reactive({ k: 0, N: 0, tMs: 0, elapsedMs: 0, etaMs: 0, fps: 0, bytes: 0, encoder: '', still: false })
  const result = shallowRef(null)
  const errorMsg = ref('')
  const thumbEl = ref(null)          // 进度窗里的实时缩略图（面板组件挂上）
  let cancelFlag = false
  // 「开始导出」单飞闸：从点下到这一路收尾（含保存框、覆盖确认、出帧、时钟复位）一直落着，按钮据此禁用（见 start）
  const starting = ref(false)
  // 图片序列覆盖确认（phase = 'confirm'）：{ path 首帧路径, n 旧帧个数, answered 已点「替换」、等主进程清旧帧 }
  const ask = shallowRef(null)
  let askResolve = null

  // —— 时段 ——
  const tl = () => (host.timeline && host.timeline()) || { fixed: false, startMs: clock.tMs, stopMs: clock.tMs + 3600e3, viewLo: clock.tMs, viewHi: clock.tMs + 3600e3 }
  const range = computed(() => {
    void clock.seq
    const t = tl()
    if (S.rangeMode === 'custom' && Number.isFinite(S.startMs) && Number.isFinite(S.stopMs)) return { startMs: S.startMs, stopMs: S.stopMs }
    if (S.rangeMode === 'timeline' && t.fixed) return { startMs: t.startMs, stopMs: t.stopMs }
    return { startMs: Math.round(t.viewLo), stopMs: Math.round(t.viewHi) }
  })
  const spanSec = computed(() => Math.max(0, (range.value.stopMs - range.value.startMs) / 1000))

  // —— 成片时间轴：节奏 + 变速 + 停留 ——
  const pace = computed(() => planTimeline(spanSec.value, S.fps, { mode: S.paceMode, speed: S.speed, durationSec: S.durationSec, stepSec: S.stepSec }, S.ramp))
  const dims = computed(() => {
    const p = RES_PRESETS.find((r) => r.key === S.res)
    return p ? { w: p.w, h: p.h } : evenDims(S.cw, S.ch)
  })
  const bitrate = computed(() => bitrateOf(dims.value.w, dims.value.h, S.fps, S.q, S.mbps))
  const codec = computed(() => h264Codec(dims.value.w, dims.value.h, S.fps, bitrate.value))
  const estBytes = computed(() => (pace.value.ok ? estimateBytes(S.format, dims.value.w, dims.value.h, pace.value.frames, pace.value.durationSec, bitrate.value, S.jpegQ) : 0))

  // —— 编码器能力（配置一变就问一次 WebCodecs；面板据此出「硬件 / 软件 / 不支持」）——
  const encSupport = ref(null)       // null 未知 | { hw, sw }
  let probeSeq = 0
  async function probe() {
    const my = ++probeSeq
    if (S.format !== 'mp4') { encSupport.value = null; return }
    const c = codec.value
    if (!c || typeof VideoEncoder === 'undefined') { encSupport.value = { hw: false, sw: false }; return }
    const base = { codec: c.codec, width: dims.value.w, height: dims.value.h, bitrate: bitrate.value, framerate: S.fps, latencyMode: 'quality', bitrateMode: 'variable', avc: { format: 'avc' } }
    const ask = async (p) => { try { return !!(await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: p })).supported } catch { return false } }
    const [hw, sw] = await Promise.all([ask('prefer-hardware'), ask('prefer-software')])
    if (my === probeSeq) encSupport.value = { hw, sw }
  }
  watch(() => [open.value, S.format, dims.value.w, dims.value.h, S.fps, bitrate.value], () => { if (open.value) probe() })
  const encPath = computed(() => {
    const e = encSupport.value
    if (!e) return ''
    if (S.enc === 'hw') return e.hw ? 'hw' : ''
    if (S.enc === 'sw') return e.sw ? 'sw' : ''
    return e.hw ? 'hw' : e.sw ? 'sw' : ''
  })

  // —— 校验：能不能开始（返回第一条问题，界面只出状态本身）——
  // 单帧（起止重合 / 步长撑不满一个间隔）只给图片：一帧的 MP4 播放器里一闪而过，多半是填错了
  // 3D「只出取景框一块」时视口按整舞台铺开：舞台 × 成片宽 / 框宽（超采样退到 1× 时的下限）不能超过显卡 MAX_VIEWPORT_DIMS
  let glLim = null
  const vpTooBig = computed(() => {
    const c = cropNow.value
    if (!c || (host.isFlat && host.isFlat())) return false
    if (!glLim) { try { const sc = host.scene && host.scene(); glLim = sc && sc.glLimits ? sc.glLimits() : null } catch { glLim = null } }
    if (!glLim) return false
    const k = dims.value.w / c.w
    return Math.round(stage.w * k) > glLim.maxViewport[0] || Math.round(stage.h * k) > glLim.maxViewport[1]
  })
  const issue = computed(() => {
    if (!(range.value.stopMs >= range.value.startMs)) return T('终止时刻不得早于起始时刻', 'Stop time must not be before start time')
    if (vpTooBig.value) return T('取景框过小：该分辨率下超出显卡视口上限', 'Frame too small for this resolution (exceeds the GPU viewport limit)')
    const rr = normRamp(S.ramp)
    if (S.paceMode === 'duration' && rr.hold0 + rr.hold1 >= Number(S.durationSec)) return T('停留不得超过视频时长', 'Holds must be shorter than the video')
    if (!pace.value.ok) return T('节奏参数无效', 'Invalid pacing')
    if (S.format === 'mp4' && pace.value.frames < 2) return T('MP4 至少两帧', 'MP4 requires at least two frames')
    if (S.format === 'mp4') {
      if (!codec.value) return T('H.264 不支持该分辨率与帧率组合', 'H.264 does not support this resolution and frame rate')
      if (encSupport.value && !encPath.value) return T('本机 H.264 编码器不支持该设置', 'No H.264 encoder available for these settings')
    }
    return ''
  })

  // —— 取景框摆位：舞台尺寸（ResizeObserver 回填）→ 屏上框；拖动 / 缩放由框反推摆位 ——
  const stage = reactive({ w: 0, h: 0 })
  function measureStage() {
    const st = host.stageEl && host.stageEl()
    if (!st) return
    const r = st.getBoundingClientRect()
    if (Math.abs(stage.w - r.width) > 0.01 || Math.abs(stage.h - r.height) > 0.01) { stage.w = r.width; stage.h = r.height }
  }
  const cropNow = computed(() => (stage.w > 1 && stage.h > 1 ? cropRect(stage.w, stage.h, dims.value.w, dims.value.h, S.frame) : null))
  const frameIsDefault = computed(() => Math.abs(S.frame.s - 1) < 1e-6 && Math.abs(S.frame.x - 0.5) < 1e-6 && Math.abs(S.frame.y - 0.5) < 1e-6)
  // 由屏上框（CSS px，舞台坐标）定摆位：框先夹进舞台（拖出界就贴边停住）
  function setFrameRect(r) {
    if (!(stage.w > 1 && stage.h > 1) || !r) return
    const f = frameOfRect(stage.w, stage.h, dims.value.w, dims.value.h, r)
    // 夹进舞台后再记：x / y 记的是夹完的框心，下次舞台变大时框不会「弹」回拖出界之前的位置
    const c = cropRect(stage.w, stage.h, dims.value.w, dims.value.h, f)
    Object.assign(S.frame, frameOfRect(stage.w, stage.h, dims.value.w, dims.value.h, c))
  }
  function resetFrame() { Object.assign(S.frame, FRAME_DEFAULT) }
  // —— 屏上取景预览 ——
  let pvCanvas = null, pvRaf = 0, pvTimer = 0, ro = null
  let logoImg = null, logoSrc = ''
  async function ensureLogo() {
    const it = S.hud.items.logo
    const src = it.src === 'custom' && it.dataUrl ? it.dataUrl : appLogoUrl
    if (src === logoSrc) return logoImg
    logoSrc = src
    logoImg = await loadImage(src)
    schedulePreview()
    return logoImg
  }
  function hudStyle() {
    const h = S.hud
    return { size: h.size, panel: h.panel, opacity: h.opacity, font: h.font, fontStack: h.font === 'ui' && host.uiFont ? host.uiFont() : '' }
  }
  function hudFrameData(tMs, t0, speed) {
    const it = S.hud.items
    let d = {}
    try { d = (host.hudData && host.hudData(tMs, it)) || {} } catch (e) { d = {} }
    return {
      ...d, tMs, t0, tz: host.tzMode ? host.tzMode() : 'local', speed: Number.isFinite(speed) ? speed : pace.value.speed,
      title: it.title.on ? it.title.text : '', subtitle: it.title.on ? it.title.sub : '',
      logo: it.logo.on ? logoImg : null
    }
  }
  // 2D 经纬图框：取景框里的投影与变换（成片像素 ⇄ 经纬）；3D 视图、没开图框、平面图未就绪时为 null
  function geoViewFor(crop) {
    if (!S.geo.on || !(host.isFlat && host.isFlat()) || !host.geoView) return null
    const g = host.geoView()
    return g && g.pj ? { ...g, crop } : null
  }
  // 画经纬图框（开着时），返回叠加信息可用的图框内区；没画返回 null（叠加信息按整幅排）。
  // 刻度字号跟叠加信息的「字号」走（基准字号的 0.78），字体同叠加信息
  function drawGeo(ctx, W, H, crop) {
    const v = geoViewFor(crop)
    return v ? drawGeoFrame(ctx, W, H, v, S.geo, { ...hudStyle(), fsA: hudFontPx(H, S.hud.size, W) * 0.78 }, T) : null
  }
  function attachPreview(cv) {
    pvCanvas = cv || null
    if (ro) { ro.disconnect(); ro = null }
    const st = host.stageEl && host.stageEl()
    if (pvCanvas && st && typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => { measureStage(); schedulePreview() }); ro.observe(st) }
    measureStage()
    schedulePreview()
  }
  function schedulePreview() {
    if (pvRaf || !pvCanvas) return
    pvRaf = requestAnimationFrame(() => { pvRaf = 0; drawPreview() })
  }
  function drawPreview() {
    const cv = pvCanvas, st = host.stageEl && host.stageEl()
    if (!cv || !st) return
    const r = st.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
    const bw = Math.max(1, Math.round(r.width * dpr)), bh = Math.max(1, Math.round(r.height * dpr))
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh }
    const g = cv.getContext('2d')
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, bw, bh)
    if (!open.value || phase.value === 'running') return
    const { w: W, h: H } = dims.value
    const c = cropRect(r.width, r.height, W, H, S.frame)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (S.framing) {
      g.fillStyle = 'rgba(0,0,0,0.5)'
      g.fillRect(0, 0, r.width, c.y); g.fillRect(0, c.y + c.h, r.width, r.height - c.y - c.h)
      g.fillRect(0, c.y, c.x, c.h); g.fillRect(c.x + c.w, c.y, r.width - c.x - c.w, c.h)
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1
      g.strokeRect(Math.round(c.x) + 0.5, Math.round(c.y) + 0.5, Math.round(c.w) - 1, Math.round(c.h) - 1)
    }
    // 叠加信息：坐标系换成「成片像素」再缩到取景框，与导出的每一帧同一支 drawGeo / drawHud
    const k = c.w / W
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * c.x, dpr * c.y)
    g.save(); g.beginPath(); g.rect(0, 0, W, H); g.clip()
    const area = drawGeo(g, W, H, c)
    const range0 = range.value, pl = pace.value, span = range0.stopMs - range0.startMs
    // 变速时倍速读数取时钟此刻在成片里那一帧的瞬时值（时钟在导出时段内时）
    const sp = pl.ok && pl.ramped && span > 0 && clock.tMs >= range0.startMs && clock.tMs <= range0.stopMs
      ? pl.atU(pl.uOfFrac((clock.tMs - range0.startMs) / span)).speed : undefined
    const data = hudFrameData(clock.tMs, range0.startMs, sp)
    drawHud(g, W, H, buildHudBlocks(S.hud, data, T), hudStyle(), area)
    if (S.hud.items.progress.on) drawProgress(g, W, H, span > 0 ? (clock.tMs - range0.startMs) / span : 0, area)
    g.restore()
  }
  watch(S, schedulePreview, { deep: true })
  watch(() => [clock.seq, open.value, phase.value, lang.value], schedulePreview)
  // 经纬图框跟着平面图的平移缩放走：开着时每帧比一下变换，变了就重画预览（只比几个数，不画就不花钱）
  let geoRaf = 0, geoKey = ''
  function geoTick() {
    geoRaf = 0
    if (!open.value || !S.geo.on || !(host.isFlat && host.isFlat()) || !host.geoView) { geoKey = ''; return }
    const v = host.geoView()
    const key = v && v.pj ? [v.pj.kind, v.pj.lon0, v.pj.lat0, v.k, v.tx, v.ty].join('|') : ''
    if (key !== geoKey) { geoKey = key; schedulePreview() }
    geoRaf = requestAnimationFrame(geoTick)
  }
  watch(() => [open.value, S.geo.on, !!(host.isFlat && host.isFlat())], ([o, on, fl]) => {
    if (o && on && fl && !geoRaf) geoRaf = requestAnimationFrame(geoTick)
  }, { immediate: true })
  watch(() => [S.hud.items.logo.on, S.hud.items.logo.src, S.hud.items.logo.dataUrl], () => { if (S.hud.items.logo.on) ensureLogo() }, { immediate: true })
  // 选中卫星 / 站 / 天线这些不经时钟的变化：面板开着时 2 Hz 补画（只画一层 2D 叠加，开销可忽略）
  watch(open, (v) => {
    clearInterval(pvTimer); pvTimer = 0
    if (v) pvTimer = setInterval(schedulePreview, 500)
    schedulePreview()
  })

  function show() {
    if (!open.value) {
      // 头一回打开：倍速跟时间轴当前倍速（「看到什么录什么」），自定义时段从时间轴起算
      const t = tl()
      if (!Number.isFinite(S.startMs) || !Number.isFinite(S.stopMs)) { S.startMs = t.fixed ? t.startMs : Math.round(t.viewLo); S.stopMs = t.fixed ? t.stopMs : Math.round(t.viewHi) }
    }
    open.value = true
  }
  // 一路导出没收尾（等保存框 / 覆盖确认 / 出帧中）不许收面板：进度卡挂在面板里，面板一卸，确认框就没人答、这一路悬住
  function hide() { if (starting.value || phase.value === 'running' || phase.value === 'finishing') return; open.value = false }
  function toggle() { if (open.value) hide(); else show() }
  function useTimelineSpeed() { S.paceMode = 'speed'; S.speed = clock.speed }

  // —— 导出 ——
  // single = 单张图像（图片格式且只有一帧）：落盘就是保存框里选的那个文件，不带帧号；文件名时刻精确到秒。
  // 时刻按平台显示时区（与面板起止框、叠加的时间读数同一档），不按本机时区
  function defaultName(single) {
    const q = tzParts(range.value.startMs, host.tzMode ? host.tzMode() : 'local')
    const stamp = `${q.y}${p2(q.mo)}${p2(q.d)}-${p2(q.h)}${p2(q.mi)}${single ? p2(q.s) : ''}`
    return `${single ? T('仿真画面', 'Frame') : T('仿真视频', 'Simulation')}_${stamp}_${dims.value.w}x${dims.value.h}`
  }
  // 覆盖确认：进度卡切到 confirm 态，等面板上的「替换 / 取消」（或 Esc / Enter）
  function askReplace(path, n) {
    ask.value = { path, n, answered: false }
    phase.value = 'confirm'
    return new Promise((res) => { askResolve = res })
  }
  function answerAsk(yes) {
    const r = askResolve
    if (!r) return
    askResolve = null
    if (yes) ask.value = { ...ask.value, answered: true }   // 主进程清旧帧期间两颗钮置灰，随后进度卡接管
    else { ask.value = null; phase.value = 'idle' }
    r(!!yes)
  }
  function cancel() { if (phase.value === 'running') cancelFlag = true }
  function dismiss() {
    if (phase.value === 'confirm') { answerAsk(false); return }
    if (phase.value !== 'running' && phase.value !== 'finishing') { phase.value = 'idle'; result.value = null; errorMsg.value = '' }
  }
  async function reveal() { const r = result.value; if (r && r.path && host.api && host.api.video) await host.api.video.reveal(r.path) }
  async function openFile() { const r = result.value; if (r && r.path && host.api && host.api.video) await host.api.video.openPath(r.path) }

  // ★ 入口单飞闸：phase 要等保存框关了才变 running，只看 phase 挡不住「开始导出」双击的第二下（两个保存框、两路并发出帧）。
  //   闸在同步入口落下（singleFlight），这一路跑完 / 出错 / 取消 / 保存框点了取消都在 finally 里抬起
  const start = singleFlight(run, starting)
  async function run() {
    if (phase.value === 'running' || phase.value === 'finishing') return
    if (issue.value) return
    const api = host.api && host.api.video
    if (!api) { errorMsg.value = T('需在桌面客户端中运行', 'Requires the desktop client'); phase.value = 'error'; return }
    const fmt = S.format, W = dims.value.w, H = dims.value.h, fps = S.fps
    const plan = pace.value
    const N = plan.frames, t0 = range.value.startMs, t1 = range.value.stopMs
    const br = bitrate.value
    const single = fmt !== 'mp4' && N === 1
    // ① 编码器：自动 = 硬件优先、不行退软件（4K、>30 fps 在本版 Chromium 只有软件）
    let encCfg = null, encLabel = ''
    if (fmt === 'mp4') {
      const base = { codec: codec.value.codec, width: W, height: H, bitrate: br, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable', avc: { format: 'avc' } }
      const prefs = S.enc === 'hw' ? ['prefer-hardware'] : S.enc === 'sw' ? ['prefer-software'] : ['prefer-hardware', 'prefer-software']
      for (const p of prefs) {
        let ok = false
        try { ok = !!(await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: p })).supported } catch { ok = false }
        if (ok) { encCfg = { ...base, hardwareAcceleration: p }; encLabel = p === 'prefer-hardware' ? 'hw' : 'sw'; break }
      }
      if (!encCfg) { errorMsg.value = T('本机 H.264 编码器不支持该设置', 'No H.264 encoder available for these settings'); phase.value = 'error'; return }
    }
    // ② 落盘位置（系统保存框）
    let b
    try { b = await api.begin({ kind: fmt, defaultName: defaultName(single), frames: N, lang: getLang() }) } catch (e) { b = { ok: false, error: (e && e.message) || String(e) } }
    if (b && b.locked) { errorMsg.value = T('未激活：视频导出不可用', 'Not activated: video export unavailable'); phase.value = 'error'; return }
    if (!b || !b.ok) { if (b && b.canceled) return; errorMsg.value = b && b.error ? dictT(b.error) : T('无法创建文件', 'Cannot create the file'); phase.value = 'error'; return }
    // ②b 图片序列：所选位置已有同名同位数的旧帧 → 应用内确认（MP4 / 单帧落盘就是所选文件，保存框自己问过覆盖）。
    //     替换 = 主进程先清旧帧再写（帧数变少时旧尾帧不会留在文件夹里被剪辑软件接上）；取消 = 不导出
    if (b.exists > 0) {
      const tok = b.token
      if (!(await askReplace(b.path, b.exists))) { try { await api.end(tok, false) } catch { /* 会话已不在 */ } return }
      try { b = await api.begin({ confirm: tok }) } catch (e) { b = { ok: false, error: (e && e.message) || String(e) } }
      if (!b || !b.ok) { ask.value = null; errorMsg.value = b && b.error ? dictT(b.error) : T('无法创建文件', 'Cannot create the file'); phase.value = 'error'; return }
    }
    const token = b.token

    phase.value = 'running'; ask.value = null; cancelFlag = false; errorMsg.value = ''; result.value = null
    Object.assign(prog, { k: 0, N, tMs: t0, elapsedMs: 0, etaMs: 0, fps: 0, bytes: 0, encoder: encLabel, still: single })
    const saved = { mode: clock.mode, tMs: clock.tMs, dir: clock.dir }
    const st = host.stageEl().getBoundingClientRect()
    const crop = cropRect(st.width, st.height, W, H, S.frame)
    const flatMode = !!host.isFlat()
    let ss = (!flatMode && S.ss !== 'off' && W * H <= 2560 * 1440) ? 2 : 1
    let geom = renderGeom(st.width, st.height, crop, W, H, S.annot, ss)
    const comp = document.createElement('canvas'); comp.width = W; comp.height = H
    const cx = comp.getContext('2d', { alpha: false })
    let encoder = null, mux = null, encErr = null, captured = false, prepared2D = false
    const vp = { x: crop.x, y: crop.y, w: crop.w, h: crop.h, s: S.annot }
    await ensureLogo()
    const tBegin = performance.now()
    let lastUi = 0, lastThumb = 0, written = 0
    const seqWrites = []
    try {
      // ③ 出帧准备
      if (flatMode) { await host.prepare2D(); prepared2D = true }
      else {
        const sc = host.scene()
        let r = sc.beginCapture({ cssW: geom.cssW, cssH: geom.cssH, pixelRatio: geom.renderPr, view: geom.view })
        captured = true
        if (!r.ok && ss > 1) {   // 超采样撞上帧缓冲上限：退回 1×（宁可少一档抗锯齿，不出被浏览器悄悄拉伸的糊图）
          sc.endCapture(); ss = 1; geom = renderGeom(st.width, st.height, crop, W, H, S.annot, 1)
          r = sc.beginCapture({ cssW: geom.cssW, cssH: geom.cssH, pixelRatio: geom.renderPr, view: geom.view })
        }
        if (!r.ok) throw new Error(T('显存不足以按该分辨率出帧', 'Not enough GPU memory for this resolution'))
      }
      // ④ 编码 + 封装（MP4）
      if (fmt === 'mp4') {
        const sink = { write: async (bytes, pos) => { const r = await api.write(token, pos, bytes); if (!r || !r.ok) throw new Error((r && r.error) || T('写入失败', 'Write failed')) } }
        mux = createMp4Muxer({ width: W, height: H, fps, frameCount: N, bitrate: br, sink })
        encoder = new VideoEncoder({
          output: (chunk, meta) => {
            try {
              const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf)
              mux.addChunk(buf, { key: chunk.type === 'key', ptsUs: chunk.timestamp }, meta && meta.decoderConfig)
            } catch (e) { encErr = encErr || e }
          },
          error: (e) => { encErr = encErr || e }
        })
        encoder.configure(encCfg)
      }
      const gop = gopFrames(fps, S.gopSec)
      const span = t1 - t0
      // ⑤ 逐帧：时刻（成片时间轴：变速 + 停留）→ 时钟这一拍落定 → 出帧
      for (let k = 0; k < N; k++) {
        if (cancelFlag) throw CANCEL
        if (encErr) throw encErr
        const fr = plan.at(k)
        const t = fr.frac <= 0 ? t0 : fr.frac >= 1 ? t1 : t0 + span * fr.frac
        await clockSetTime(t, { keepMode: false })
        if (flatMode) {
          const f = host.flat()
          await f.ensureImagery({ view: true, viewport: vp, pixelScale: geom.pr })
          cx.setTransform(1, 0, 0, 1, 0, 0)
          f.exportRender(cx, { view: true, viewport: vp, pixelScale: geom.pr, raster: true })
        } else {
          await host.scene().captureFrame({
            draw: (glc) => {
              cx.setTransform(1, 0, 0, 1, 0, 0)
              cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high'
              cx.drawImage(glc, 0, 0, glc.width, glc.height, 0, 0, W, H)   // 画布就是取景框（beginCapture 的 view）
            }
          })
        }
        cx.setTransform(1, 0, 0, 1, 0, 0)
        const area = flatMode ? drawGeo(cx, W, H, crop) : null   // 跟随中平面图每帧在挪：图框按这一帧的变换现量
        drawHud(cx, W, H, buildHudBlocks(S.hud, hudFrameData(t, t0, fr.speed), T), hudStyle(), area)
        if (S.hud.items.progress.on) drawProgress(cx, W, H, span > 0 ? (t - t0) / span : 0, area)   // 进度 = 仿真时刻比例（变速 / 停留下与帧序不成比例）
        if (fmt === 'mp4') {
          const vf = new VideoFrame(comp, { timestamp: frameTsUs(k, fps), duration: Math.round(1e6 / fps) })
          encoder.encode(vf, { keyFrame: k % gop === 0 })
          vf.close()
          while (encoder.encodeQueueSize > 3 && !encErr) await waitDequeue(encoder)
          await mux.drain(3)
          written = mux.bytes
        } else {
          const blob = await canvasBlob(comp, fmt === 'png' ? 'image/png' : 'image/jpeg', fmt === 'jpg' ? S.jpegQ : undefined)
          const bytes = new Uint8Array(await blob.arrayBuffer())
          written += bytes.length
          seqWrites.push(api.frame(token, k + 1, bytes).then((r) => { if (!r || !r.ok) throw new Error((r && r.error) || T('写入失败', 'Write failed')) }))
          if (seqWrites.length >= 3) await seqWrites.shift()
        }
        // 进度（≈8 Hz）与缩略图（≈3 Hz）：别让界面更新反过来拖慢出帧
        const now = performance.now()
        if (now - lastUi > 120 || k === N - 1) {
          lastUi = now
          const el = now - tBegin
          Object.assign(prog, { k: k + 1, tMs: t, elapsedMs: el, fps: (k + 1) / (el / 1000), etaMs: (N - k - 1) * el / (k + 1), bytes: written })
        }
        if (thumbEl.value && (now - lastThumb > 330 || k === N - 1)) {
          lastThumb = now
          const tc = thumbEl.value, tg = tc.getContext('2d')
          tg.imageSmoothingEnabled = true; tg.imageSmoothingQuality = 'medium'
          tg.drawImage(comp, 0, 0, tc.width, tc.height)
        }
        if (k % 8 === 7) await yieldTask()   // 让进度窗与取消键有机会响应（MessageChannel：窗口最小化时也不被节流）
      }
      phase.value = 'finishing'
      let durationSec = (N - 1) / fps + 1 / fps
      if (fmt === 'mp4') {
        await encoder.flush()
        if (encErr) throw encErr
        encoder.close(); encoder = null
        const r = await mux.finalize()
        durationSec = r.durationSec
      } else {
        for (const p of seqWrites.splice(0)) await p
      }
      const end = await api.end(token, true)
      result.value = { path: end && end.path, bytes: (end && end.bytes) || written, frames: N, durationSec, fmt, w: W, h: H, fps, encoder: encLabel, ms: performance.now() - tBegin }
      phase.value = 'done'
      if (host.log) host.log((single ? T('图片已导出：', 'Image exported: ') : T('视频已导出：', 'Video exported: ')) + (end && end.path))
    } catch (e) {
      const canceled = e === CANCEL
      try { if (encoder && encoder.state !== 'closed') encoder.close() } catch { /* 已关 */ }
      if (mux) await mux.abort()
      for (const p of seqWrites.splice(0)) { try { await p } catch { /* 已在出错路径上 */ } }
      try { await api.end(token, fmt !== 'mp4' && canceled) } catch { /* 收尾失败不再报第二个错 */ }
      if (canceled) phase.value = 'canceled'
      else { errorMsg.value = dictT((e && e.message) || String(e)); phase.value = 'error' }
    } finally {
      if (captured) { try { host.scene().endCapture() } catch { /* 场景已销毁 */ } }
      if (prepared2D) { try { host.finish2D() } catch { /* 平面图已销毁 */ } }
      // 时钟回到导出前：实时档接回系统钟，其余回到原时刻（播放中则续播）
      try {
        if (saved.mode === 'live') goLive()
        else { await clockSetTime(saved.tMs, { keepMode: false }); if (saved.mode === 'play') clockPlay(saved.dir) }
      } catch { /* 时钟复位失败不影响已写出的文件 */ }
      schedulePreview()
    }
  }

  function dispose() {
    offLang(); clearInterval(pvTimer); if (pvRaf) cancelAnimationFrame(pvRaf); if (geoRaf) cancelAnimationFrame(geoRaf); if (ro) ro.disconnect()
    clearTimeout(saveT)
    cancelFlag = true
    answerAsk(false)   // 覆盖确认还挂着：按取消收掉（主进程那个挂起的会话随之关掉，闸也抬起）
  }

  return {
    open, S, T, lang, phase, prog, result, errorMsg, thumbEl, starting, ask,
    stage, cropNow, frameIsDefault, setFrameRect, resetFrame, measureStage,
    range, spanSec, pace, dims, bitrate, codec, estBytes, encSupport, encPath, issue,
    show, hide, toggle, start, cancel, dismiss, answerAsk, reveal, openFile, attachPreview, schedulePreview, useTimelineSpeed, dispose,
    sources: () => (host.sources ? host.sources() : { sats: [], stations: [], points: [], antennas: [], activeAnt: '' }),
    isFlatView: () => !!(host.isFlat && host.isFlat()),
    setFlatView: (v) => { if (host.setFlat) host.setFlat(!!v) },
    tzMode: () => (host.tzMode ? host.tzMode() : 'local'),
    tlInfo: tl
  }
}
