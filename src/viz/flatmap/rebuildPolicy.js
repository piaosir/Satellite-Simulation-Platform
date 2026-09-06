// 2D 平面图静态快照的【调度口径】：一次手势里到底重不重建、什么时候补建、盖不住时垫哪一张。
// 从 flatCoverage.js 里拆出来的纯函数（不碰 DOM、不读模块状态），一为可测，二为这几条判据
// 本身就是整块改造的要害 —— 判错一次就是手势里插一次 100 ms 的整份重建。
//
// 背景（《2D 手势期重建治理》§1）：Chromium 把 canvas 光栅甩到别的线程，「重建耗时」的主线程读数
// （renderStaticLayers 末尾那个）在所有档上都是 1.5～6 ms，而真实代价（10m 全图）是 100 多毫秒，
// 落在后面那两三个【真正绘制】的帧的等待里。故一切「便宜就直接重建」的判据必须走 costEst，
// 不能走主线程读数。

export const REBUILD_FAST_MS = 8      // 「便宜」的门槛：低于它才允许在手势里同步重建
export const PROBE_FRAMES = 3         // 光栅顶住落在重建之后第几帧不定（实测 1～3 帧都出现过）
export const IDLE_MIN_MS = 110        // 静止补建的下限（便宜的视角这么快就清晰）
export const IDLE_MAX_MS = 350        // 上限（贵的视角多等一点，避开滚轮格间隔 100～300 ms）
export const ZOOM_RUN_MS = 350        // 贵视角的滚轮热窗口：整串滚完之前一次都不补建
export const NOMINAL_MIN = 4          // 「一帧本来就要等多久」的下限（验证台无 vsync，实测 ≈ 0）
export const NOMINAL_MAX = 20         // 上限（60 Hz 是 16.7，144 Hz 是 6.9）
export const UNKNOWN_COST = 200       // 没量过的视角类一律当作贵

// 视角类：底图档 + 影像开关 + 投影 + 屏上分辨率（半倍频程一档）。
// 代价按类记 —— 同一档同一投影下，重建代价主要随「屏上画多少度」变（宽视角顶点多）。
export function viewCls(detail, imgOn, projKind, kDev) {
  const z = kDev > 0 ? Math.round(Math.log2(kDev) * 2) : 0
  return detail + '|' + (imgOn ? 'img' : '') + '|' + projKind + '|' + z
}

// 代价表 + 迟滞。★ 两头刻意不对称：判错成「贵」只是多走一次缩位图（本来就是缺省路），
// 判错成「便宜」就是手势里插一次整份重建。而探针本身会漏（顶住落在第几帧不定，偶尔只读到
// 主线程那 1.3 ms），故单次读数不足以翻档：要连续三次 < 8 ms 且【衰减最大值】也降下来。
export function makeCostTable(fastMs = REBUILD_FAST_MS, decay = 0.6, need = 3) {
  const m = new Map()
  return {
    note(cls, cost) {
      if (!cls) return
      const e = m.get(cls) || { cost: Infinity, cheap: false, streak: 0 }
      e.cost = Number.isFinite(e.cost) ? Math.max(cost, e.cost * decay) : cost
      if (cost < fastMs) { e.streak++; if (e.streak >= need && e.cost < fastMs) e.cheap = true }
      else { e.streak = 0; e.cheap = false }
      m.set(cls, e)
      return e
    },
    cheap(cls) { const e = m.get(cls); return !!(e && e.cheap) },
    cost(cls) { const e = m.get(cls); return e ? e.cost : UNKNOWN_COST },
    clear() { m.clear() },
    size() { return m.size }
  }
}

// 平移量落到整设备像素（§4.2）。不取整则 snapPlace 的 exact 恒为假 → 拖动中每停一下补一次建，
// 再拖的第一帧要等它的光栅（DPR 1.25 实测 38～42 ms，1.5 + 10m 约 100 ms）。
// 每次按【当前绝对值】就近取整，误差不累积。
export const quantPan = (v, dpr) => Math.round(v * dpr) / dpr
// 带残差的平移量化：把这一次的量化残差留到下一次一起补上。
// ★ 直接就近取整会把「每次只动零点几个设备像素」的连续小位移整段吃掉 —— 高 DPI 触控板给的
//   clientX 是小数，光标走了图却一动不动。残差 |r| < 1 个设备像素，故位移永远跟得住光标。
export function makePanQuant() {
  let rx = 0, ry = 0
  return {
    step(tx, ty, dx, dy, dpr) {
      const nx = tx + rx + dx, ny = ty + ry + dy
      const qx = quantPan(nx, dpr), qy = quantPan(ny, dpr)
      rx = nx - qx; ry = ny - qy
      return [qx, qy]
    },
    reset() { rx = 0; ry = 0 }
  }
}

export const idleMsFor = (cost) => Math.max(IDLE_MIN_MS, Math.min(IDLE_MAX_MS, 2.5 * cost))
export const hotMsFor = (cheap, idle) => (cheap ? idle : Math.max(idle, ZOOM_RUN_MS))
// 「一帧本来就要等多久」：只能从【连排的空 rAF】的时间戳差估，取中位数后钳位。
// ★ 曾用「任意两次 draw 的间隔取滚动最小值」，在真机上是错的：resizeNow（ResizeObserver、切侧栏、
//   换画质档）走同步 draw()，与同一拍里挂着的 rAF draw 间隔 0～3 ms → nominal 一次就钉死在下限 4，
//   于是 60 Hz 上便宜的重建也被算出 rasterExtra ≈ 12.7 ≥ 8 →【所有类永远判贵】，§4.1 的
//   「放大同步重建、清晰优先」在应用里根本不会启用。验证台无 vsync 本来就是 4，看不出这件事。
export function nominalFromGaps(gaps, fallback = NOMINAL_MIN) {
  const g = gaps.filter((v) => v > 0).sort((a, b) => a - b)
  if (!g.length) return fallback
  const med = g.length % 2 ? g[(g.length - 1) >> 1] : (g[g.length / 2 - 1] + g[g.length / 2]) / 2
  return Math.max(NOMINAL_MIN, Math.min(NOMINAL_MAX, med))
}

// 快照 rec = { k, tx, ty, mx, my, w, h }（mx/my/w/h 是设备像素，tx/ty 是 CSS）
// 视图 view = { k, tx, ty, dpr, cwDev, chDev, W, H }
// 返回 { dx, dy, w, h, scaled, exact, covers, moved }：covers=false 只说明盖不住，几何照给 ——
// 盖不住时也要把它缩着贴上去（另垫回退快照 / 海色），而不是整块空着。
// ★ moved ＝【这张位图有没有搬过位置】，与 dx/dy 分家：dx 是贴图坐标（dx = rx − mx），快照带余量时
//   一动没动也有 dx = −mx ≠ 0。拿 dx 当「搬过位置」判据 → 任何放大视角静止后每一帧 blit 都排一次
//   补建 → 补建又催出探针帧 → 再排补建，以 idleMs 为周期【无限循环整份重建】（实测 3～8 次/秒）。
export function placeSnapshot(rec, view) {
  const kk = view.k, dpr = view.dpr
  const bw = rec.w, bh = rec.h
  const wx0 = view.tx * dpr, wx1 = (view.tx + view.W * kk) * dpr
  const wy0 = view.ty * dpr, wy1 = (view.ty + view.H * kk) * dpr
  const nx0 = Math.max(0, wx0), nx1 = Math.min(view.cwDev, wx1)
  const ny0 = Math.max(0, wy0), ny1 = Math.min(view.chDev, wy1)
  let dx, dy, w, h, scaled, exact, moved
  if (kk === rec.k) {
    const ex = (view.tx - rec.tx) * dpr, ey = (view.ty - rec.ty) * dpr
    const rx = Math.round(ex), ry = Math.round(ey)
    dx = rx - rec.mx; dy = ry - rec.my; w = bw; h = bh; scaled = false
    moved = rx !== 0 || ry !== 0
    exact = Math.abs(ex - rx) < 1e-9 && Math.abs(ey - ry) < 1e-9
  } else {
    const r = kk / rec.k
    const px0 = (-rec.mx / dpr - rec.tx) / rec.k, py0 = (-rec.my / dpr - rec.ty) / rec.k
    dx = (px0 * kk + view.tx) * dpr; dy = (py0 * kk + view.ty) * dpr; w = bw * r; h = bh * r
    scaled = true; exact = false; moved = true
  }
  let covers = true
  if (nx1 > nx0 && (dx > nx0 + 0.5 || dx + w < nx1 - 0.5)) covers = false
  if (ny1 > ny0 && (dy > ny0 + 0.5 || dy + h < ny1 - 0.5)) covers = false
  return { dx, dy, w, h, scaled, exact, covers, moved }
}

// 盖不住当前视图时走哪一支。★ 'ocean'（海色垫底）只留给【缩位图】，即缩小那一支：
//   放大视角的类几乎永远判不成「便宜」（迟滞要连续三次 < 8 ms，而 10m 中等视角一次 30～50 ms），
//   平移也照 cheap 分支走的话，按住拖过余量就露出一条纯海色、没有海陆线的条带跟着光标一直变宽
//   （实测 40 帧里 21 帧），松手还要再等一个 idle。同步重建「顿一下」远好过它（§11.3）。
// ★ 2026-09-07：全图背板（flatCoverage.ensureBackplate）让 hasFallback 几乎恒真 —— 于是手势里
//   再也不同步整份重建；只有【实测便宜】的类才当场重建（那本来就 < 8 ms，比垫背板更清晰）。
export function uncoveredMode(pl, hasFallback, cheap) {
  if (cheap) return 'rebuild'
  if (hasFallback) return 'fallback'
  if (!pl.scaled) return 'rebuild'
  return 'ocean'
}
// 平移之后旧位图搬了 (dx, dy) 设备像素，画布上【露出来】的那一圈是哪几块（设备像素矩形，最多两块：
// 一竖条 + 一横条，允许重叠 —— 只拿来做 clip 与清底，重叠无害）。增量条带重建只重画这一圈。
export function stripRects(dx, dy, w, h) {
  const out = []
  if (dx > 0) out.push([0, 0, Math.min(dx, w), h])
  else if (dx < 0) out.push([Math.max(0, w + dx), 0, Math.min(-dx, w), h])
  if (dy > 0) out.push([0, 0, w, Math.min(dy, h)])
  else if (dy < 0) out.push([0, Math.max(0, h + dy), w, Math.min(-dy, h)])
  return out
}
// 手势停下来之后要不要补一次精确重建。★ 判据是 moved 不是 dx/dy（见 placeSnapshot 的注释）。
export function needsRestRebuild(pl, tilesDirty) {
  return !pl.exact || !pl.covers || pl.moved || !!tilesDirty
}

// 快照在【世界平面坐标】里盖住的那块矩形（等距圆柱下单位就是度）
export function worldCover(rec, dpr) {
  return {
    x0: (-rec.mx / dpr - rec.tx) / rec.k, x1: ((rec.w - rec.mx) / dpr - rec.tx) / rec.k,
    y0: (-rec.my / dpr - rec.ty) / rec.k, y1: ((rec.h - rec.my) / dpr - rec.ty) / rec.k
  }
}
// 外层盖得住内层？盖得住 ＝ 旧的那张留着也没用（新的更大），不必收进 fallbacks。
export function coversSubset(outer, inner, eps = 1e-9) {
  return outer.x0 <= inner.x0 + eps && outer.x1 >= inner.x1 - eps &&
         outer.y0 <= inner.y0 + eps && outer.y1 >= inner.y1 - eps
}
// 回退快照里挑一张盖得住的。盖得住的里面挑【缩放比最接近当前】的那张（缩得最少 ＝ 最清楚）；
// 同样接近时按列表序（列表已按覆盖面积从大到小排好）。返回下标，没有返回 −1。
export function pickFallbackIdx(list, view) {
  let best = -1, bd = Infinity
  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    if (f.w !== f.cw || f.h !== f.ch) continue      // resize 之后画布尺寸对不上：不要
    if (!placeSnapshot(f, view).covers) continue
    const d = Math.abs(Math.log(view.k / f.k))
    if (d < bd - 1e-9) { bd = d; best = i }
  }
  return best
}
// 回退快照的 above 层必须 evenodd 裁到当前快照【之外】那一圈，否则地名 / 边界线在重叠区
// 叠成两层、还略有错位。返回两个矩形（视口 + 当前快照摆放后的矩形），调用方 clip('evenodd')。
export function clipRects(pl, cwDev, chDev) {
  return [[0, 0, cwDev, chDev], [pl.dx, pl.dy, pl.w, pl.h]]
}
