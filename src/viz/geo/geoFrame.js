// 2D 平面图的经纬图框（SATSOFT 平面图同一种样子）：图框外留白，四边向内的主 / 次刻度，
// 左、下两边标度数与轴标题，框内按主刻度画点线网格。两个调用方走同一支 drawGeoFrame：
//   视频导出（viz/video/useVideoExport.js）：每一帧与屏上取景预览，画面 = 成片；
//   平面图本身（viz/flatmap/flatCoverage.js，地图设置 → 2D 投影）：屏上每帧与 PNG / PDF 导出，画面 = 画布。
//
// 坐标一律是画面像素（W × H）。地理换算由调用方给的视图出：
//   view = { pj, k, tx, ty, crop }
//     pj         平面图此刻的投影（geo/projection.js：inv / identity / W / H / path / graticule）
//     k, tx, ty  平面图屏上变换：世界平面 (px, py) → 画布 CSS px = (px·k + tx, py·k + ty)
//     crop       取景框（画布 CSS px）；画面像素 = (CSS px − crop 原点) · W / crop.w —— 与 exportRender 的 viewport 档同一换算
//                （平面图自己画时 crop 就是整块画布，画面像素即 CSS px）
// 图框 = 「画面扣掉四边留白」与「世界矩形」的交：整幅世界都在画面里时框贴着地图外沿收拢，不在地图外的空白上画刻度。
// 刻度位置：沿图框四边取样 → 逆算经纬 → 找次步长整倍数的穿越点。等距圆柱沿边是线性的，插值即精确；
// 其余投影（经线 / 纬线是曲线）再二分加密到亚像素。上下两边只标经线、左右两边只标纬线。
const SANS = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif'
const SERIF = '"Times New Roman", "SimSun", "宋体", serif'

export const GEO_STEPS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90]
const NICE = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90]
const MINUS = '−'

/** 自动间隔：每轴约 4～7 个标注，且相邻两个标注之间至少 minPx 像素 */
export function autoGeoStep(spanDeg, pxPerDeg, minPx) {
  const want = Math.max(Math.abs(spanDeg) / 7, pxPerDeg > 0 ? minPx / pxPerDeg : 0)
  for (const s of NICE) if (s >= want * (1 - 1e-9)) return s
  return 90
}
/** 次刻度步长：1-2-5 系的主刻度五 / 四等分，15 / 30 / 45 / 90 三等分，60 四等分 */
export function minorGeoStep(step) {
  const p = Math.pow(10, Math.floor(Math.log10(step) + 1e-9))
  const lead = Math.round(step / p * 10) / 10
  const div = { 1: 5, 2: 4, 5: 5, 1.5: 3, 3: 3, 4.5: 3, 6: 4, 9: 3 }[lead] || 5
  return step / div
}
/** 刻度标注：fmt 'num' = 带符号两位小数（SATSOFT：−50.00 / 0.00 / 50.00）；'hemi' = 半球字母（50°W / 0° / 50°E） */
export function fmtGeoTick(v, axis, fmt, step) {
  const r = Math.round(Number(v) * 1e6) / 1e6
  if (fmt === 'hemi') {
    const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
    let w = r
    if (axis === 'lon') { w = ((r + 180) % 360 + 360) % 360 - 180; if (w <= -180 + 1e-9) w = 180 }
    if (Math.abs(w) < 1e-9) return '0°'
    if (axis === 'lon' && Math.abs(Math.abs(w) - 180) < 1e-9) return '180°'
    return Math.abs(w).toFixed(d) + '°' + (axis === 'lon' ? (w > 0 ? 'E' : 'W') : (w > 0 ? 'N' : 'S'))
  }
  if (Math.abs(r) < 1e-9) return '0.00'
  return (r < 0 ? MINUS : '') + Math.abs(r).toFixed(2)
}

// 沿边读第 comp 分量（0 经度 / 1 纬度）：at(t) → [fx, fy]，inv(fx, fy) → [lon, lat] | null；经度就 ref 解缠，图外给 NaN
const edgeReader = (at, inv, comp) => (t, ref) => {
  const p = at(t), q = inv(p[0], p[1])
  if (!q || !Number.isFinite(q[comp])) return NaN
  let v = q[comp]
  if (comp === 0 && Number.isFinite(ref)) { while (v - ref > 180) v -= 360; while (v - ref < -180) v += 360 }
  return v
}

/**
 * 沿边 n 等分取样，切成【图内段】：[[{ t, v }, …], …]，段内经度连续解缠。
 * 段从两次取样之间进出地图时，二分逼近图廓与这条边的交点补作段的端点（边的两头不补）：
 * 曲线投影的图廓斜穿图框边，不补的话「图廓 → 第一个图内取样」那一截上的穿越点随取样相位时有时无。
 * 短于 minRun（沿边参数）的段丢掉：图廓与框边相切时只擦过一丝，取样踩不踩得到看相位，平移时那几根刻度忽有忽无。
 * 门槛不低于一个取样间距 → 长过门槛的段必有取样落在里面、端点必被逼近出来，短的找到了也丢，有没有只由几何定。
 * 图廓处的端点再往里让 rimGap：恰好落在图廓上的那根线（切口经线在极线两头）取不取全看浮点 —— 一律不取，同框角
 */
function edgeRuns(read, n, minRun, rimGap) {
  const rim = (tIn, vIn, tOut) => {
    let a = tIn, va = vIn, b = tOut
    for (let it = 0; it < 20; it++) {
      const m = (a + b) / 2, vm = read(m, va)
      if (Number.isFinite(vm)) { a = m; va = vm } else b = m
    }
    return { t: a, v: va }
  }
  const runs = []
  let cur = null, tPrev = NaN
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const last = cur && cur.pts[cur.pts.length - 1]
    const v = read(t, last ? last.v : NaN)
    if (!Number.isFinite(v)) {
      if (cur) { cur.pts.push(rim(last.t, last.v, t)); cur.tail = true; runs.push(cur); cur = null }
      tPrev = t
      continue
    }
    if (!cur) cur = { pts: i > 0 ? [rim(t, v, tPrev)] : [], head: i > 0, tail: false }
    cur.pts.push({ t, v })
    tPrev = t
  }
  if (cur) runs.push(cur)
  const out = []
  for (const r of runs) {
    let p = r.pts
    if ((r.head || r.tail) && p[p.length - 1].t - p[0].t < (minRun || 0)) continue
    if (rimGap > 0 && r.head) {
      const ts = p[0].t + rimGap, i = p.findIndex((q) => q.t > ts)
      if (i < 0) continue
      const v = read(ts, p[i].v)
      p = Number.isFinite(v) ? [{ t: ts, v }, ...p.slice(i)] : p.slice(i)
    }
    if (rimGap > 0 && r.tail) {
      const te = p[p.length - 1].t - rimGap
      let i = p.length - 1
      while (i >= 0 && p[i].t >= te) i--
      if (i < 0) continue
      const v = read(te, p[i].v)
      p = Number.isFinite(v) ? [...p.slice(0, i + 1), { t: te, v }] : p.slice(0, i + 1)
    }
    out.push(p)
  }
  return out
}

/**
 * 一条边上第 comp 分量（0 经度 / 1 纬度）穿过 step 整倍数的位置：[{ t, v, j }]（t ∈ [0, 1] 沿边参数，v = j·step）。
 * at(t) → [fx, fy]；inv(fx, fy) → [lon, lat] | null。经度沿边解缠（跨切口 / 日界线时 ±360 接上），落在地图外的取样段跳过。
 * refine：曲线投影二分加密（等距圆柱沿边线性，不必）；minRun / rimGap：短段不出刻度、图廓处让开（沿边参数，见 edgeRuns）
 */
export function edgeCrossings(at, inv, comp, step, n, refine, minRun = 0, rimGap = 0) {
  const out = []
  const read = edgeReader(at, inv, comp)
  const eps = step * 1e-7
  for (const pts of edgeRuns(read, n, minRun, rimGap)) {
    const p0 = pts[0], j0 = Math.round(p0.v / step)
    if (Math.abs(p0.v - j0 * step) < eps) out.push({ t: p0.t, v: j0 * step, j: j0 })
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i]
      if (q.v === p.v) continue
      const lo = Math.min(p.v, q.v), hi = Math.max(p.v, q.v)
      for (let j = Math.floor(lo / step) + 1; j * step <= hi + eps; j++) {
        const target = j * step
        if (target <= lo + eps) continue
        let tl = p.t, tr = q.t, vl = p.v, vr = q.v
        if (refine) {
          for (let it = 0; it < 14; it++) {
            const tm = (tl + tr) / 2, vm = read(tm, vl)
            if (!Number.isFinite(vm)) break
            if ((vm - target) * (vl - target) <= 0) { tr = tm; vr = vm } else { tl = tm; vl = vm }
          }
        }
        out.push({ t: vr !== vl ? tl + (tr - tl) * (target - vl) / (vr - vl) : (tl + tr) / 2, v: target, j })
      }
    }
  }
  // 去重：取样恰好落在整倍数上、或走向反折时，同一根线会被记两次
  out.sort((a, b) => a.t - b.t)
  return out.filter((c, i) => !i || c.j !== out[i - 1].j || Math.abs(c.t - out[i - 1].t) > 1e-6)
}

// 沿边取样的经度 / 纬度跨度（段内解缠）：自动间隔用。相切擦过的一丝不算（同 edgeCrossings 的 minRun）
function edgeSpan(at, inv, comp, n, minRun) {
  let lo = Infinity, hi = -Infinity
  for (const pts of edgeRuns(edgeReader(at, inv, comp), n, minRun, 0)) {
    for (const p of pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v }
  }
  return hi > lo ? hi - lo : 0
}

// 标注模板的宽度按字宽表估（em，Arial 的字宽），不按实际字体量：留白只要「够」，而平面图的 fit() 要按留白收进图框 ——
// 屏上、PNG、PDF（西文换 TNR）三条路的 fit() 必须逐位相同，否则 PDF 里预合成的影像底图与矢量层错位
const EM = { 0: 0.556, '.': 0.278, '°': 0.4, [MINUS]: 0.584, N: 0.722, S: 0.667, E: 0.667, W: 0.944 }
const emW = (s) => [...s].reduce((a, c) => a + (EM[c] || 0.6), 0)

/**
 * 图框四边留白（px）：左 = 外距 + 竖排轴标题 + 间距 + 纬度标注最宽 + 间距；下 = 外距 + 轴标题 + 间距 + 标注高 + 间距；
 * 上留半行；右边留半个经度标注（最右那个标注居中压在框角上）。dec = 半球字母档的小数位（1° 以下的间隔带小数，模板随之加宽）
 */
export function geoFrameMargins(fsA, fmt, dec = 0) {
  const gap = fsA * 0.5, line = fsA * 1.2, gT = fsA * 0.6, pad = fsA * 0.7
  const d = dec ? '.' + '0'.repeat(dec) : ''
  const latW = emW(fmt === 'hemi' ? '00' + d + '°N' : MINUS + '00.00') * fsA
  const lonW = emW(fmt === 'hemi' ? '000' + d + '°W' : MINUS + '000.00') * fsA
  return {
    l: Math.ceil(pad + line + gT + latW + gap), b: Math.ceil(pad + line + gT + line + gap),
    t: Math.ceil(fsA * 1.0), r: Math.ceil(Math.max(fsA * 1.0, lonW / 2 + fsA * 0.3)),
    latW, lonW, gap, line, gT
  }
}

/**
 * 量出图框（纯计算，不画）：{ plot, ticks: { b, t, l, r }, labels: { b, l }, step, gap, line, latW, planeTf } 或 null（取景里没有地图）。
 * o = { step（0 = 自动）, fmt }；fsA = 刻度字号（px）
 */
export function geoFrameLayout(W, H, view, o, fsA) {
  const { pj, k, tx, ty, crop } = view || {}
  if (!pj || !(k > 0) || !crop || !(crop.w > 0) || typeof pj.inv !== 'function') return null
  const sc = W / crop.w
  // 画面像素 → 经纬。曲线投影不走 pj.inv（回代容差 1e-3 平面单位，点选口径），改按【画面 1 px】回代：
  // 罗宾逊的反解在极线 0.12 平面单位以内发散（d3 的迭代冲出 ±90°，回代差的正是到极线的距离），
  // 整幅世界的 4K 成片里那是一个多像素 —— 贴着两极的上下两边一根刻度都量不出、经度标注全丢。
  // 纬度钳回 ±90° 再正算，落点离取样点不到 1 px 就认；图外的点反解出来经度绕到另一侧，正算回去差半幅，照样不认
  const tolU = 1 / (k * sc)
  const toPlane = (fx, fy) => [((crop.x + fx / sc) - tx) / k, ((crop.y + fy / sc) - ty) / k]
  const inv = pj.identity || typeof pj.invRaw !== 'function' || typeof pj.fwd !== 'function'
    ? (fx, fy) => { const [x, y] = toPlane(fx, fy); return pj.inv(x, y) }
    : (fx, fy) => {
      const [x, y] = toPlane(fx, fy)
      const b = pj.invRaw(x, y)
      if (!b) return null
      const lat = Math.max(-90, Math.min(90, b[1]))
      const q = pj.fwd(b[0], lat)
      if (!(Math.abs(q[0] - x) <= tolU && Math.abs(q[1] - y) <= tolU)) return null
      return [((b[0] + 180) % 360 + 360) % 360 - 180, lat]
    }
  const fmt = o && o.fmt === 'hemi' ? 'hemi' : 'num'
  const want = Number(o && o.step) > 0 ? Number(o.step) : 0
  const wr = { x: (tx - crop.x) * sc, y: (ty - crop.y) * sc, w: pj.W * k * sc, h: pj.H * k * sc }
  // 左右两边的纬度：等距圆柱 / 墨卡托 / 伪圆柱（罗宾逊、等积地球）的纬线是水平直线、y 只由纬度定，就在中央经线上读 ——
  // 伪圆柱的图廓在左右框边只擦过赤道一点，按框边逆算只剩相切的一丝（有没有看亚像素相位）；纬度按纬线平齐标到框边是这类图的通行标法
  const cxW = wr.x + wr.w / 2
  const invLat = pj.identity || pj.rowAffine ? (fx, fy) => inv(cxW, fy) : inv
  const plan = (dec) => {
    const M = geoFrameMargins(fsA, fmt, dec)
    const x0 = Math.max(M.l, wr.x), y0 = Math.max(M.t, wr.y), x1 = Math.min(W - M.r, wr.x + wr.w), y1 = Math.min(H - M.b, wr.y + wr.h)
    if (!(x1 - x0 > fsA * 4 && y1 - y0 > fsA * 4)) return null
    const X0 = Math.round(x0), Y0 = Math.round(y0)
    return { M, plot: { x: X0, y: Y0, w: Math.round(x1) - X0, h: Math.round(y1) - Y0 }, raw: { x0, y0, x1, y1 } }
  }
  // 沿边取样线：取【取整之前】的图框（留白内区 ∩ 世界矩形）、四边内缩半个像素（1 px 框线的中线）。
  // ★ 不能拿取整后的 plot 取样：框边贴着世界矩形时（整幅世界、拖到地图边上），四舍五入会把框边推到地图外至多半个像素，
  //   逆算在那里一律给 null（等距圆柱的 inv 卡 [0, W]×[0, H]）—— 那条边一根刻度都不出、标注全丢；
  //   推出去还是收进来随平移缩放的亚像素相位变，屏上拖动、视频跟随时刻度就一闪一闪。
  //   取整前的框边随视图连续变，贴边时恒在地图内半个像素
  const edgesOf = (R) => {
    const e = 0.5
    const x0 = R.x0 + e, x1 = R.x1 - e, y0 = R.y0 + e, y1 = R.y1 - e
    return {
      b: (t) => [x0 + (x1 - x0) * t, y1],
      t: (t) => [x0 + (x1 - x0) * t, y0],
      l: (t) => [x0, y0 + (y1 - y0) * t],
      r: (t) => [x1, y0 + (y1 - y0) * t]
    }
  }
  // 取样数：等距圆柱沿边线性，几十个点就精确（只要相邻两点跨不过 180° 好解缠）；曲线投影的落点靠二分加密，
  // 取样只管别漏穿越 —— 平面图拖动时每帧都要现量，罗宾逊 / 等积地球的逆算是迭代的，点数直接就是帧耗时
  const refine = !pj.identity
  const nOf = (P) => (refine ? Math.max(48, Math.min(240, Math.round(Math.max(P.w, P.h) / 6))) : 64)
  // 沿边参数的两道门槛（见 edgeRuns）：碰到图廓的图内段至少 1.5 个取样间距、且至少 4 个字高 —— 再短就是图廓与框边相切擦过的一丝，
  // 两个标注都放不下（方位等距 / 阿尔伯斯整幅时四边全是这种，拿它定自动间隔会定出 0.1°）；图廓处让开半个像素
  const lenOf = (R, side) => Math.max(1, side === 'b' || side === 't' ? R.x1 - R.x0 - 1 : R.y1 - R.y0 - 1)
  const minRunOf = (R, side, n) => Math.max(1.5 / n, fsA * 4 / lenOf(R, side))
  // 方位等距 / 阿尔伯斯（经纬线既不横平也不竖直的两档）：自动间隔按【视图比例】定，不看沿边跨度。
  // ★ 这两档的图廓是奇异边缘（方位等距整条圆周是对跖点一个点，阿尔伯斯的两极是圆弧）：框边擦过图廓的那一小截，
  //   对跖点附近一丝就是一两度经纬，却按整幅框宽折算像素密度 —— 整幅视图下滚轮一格塌到 2°、跟随起手 0.5°、拖 3 px 0.1°，
  //   整盘密网；框边过极点附近时经度跨度又陡增到 360°，放大一格间隔反倒变粗。
  // 视图比例 pxv = 每度多少画面像素：方位等距径向处处真长度（1 平面单位 = 1° 地心角），阿尔伯斯取标准纬线上的真长度 ——
  // 两者都是 d3 投影的 scale（每弧度多少平面单位）折成每度。每轴跨度 = 图框边长 / pxv、封顶 180°：圆盘直径是 360° 地心角，
  // 但经线是辐射的、纬度只有 180°，按 360° 算整幅给 60°（一盘只剩三条纬线）；线距下限取纬度标注的行距（经度标注挤了有抽稀兜着）。
  // 只由缩放与图框尺寸定 → 平移不换档、滚轮单调
  const curved = !pj.identity && !pj.rowAffine
  const uPerDeg = curved ? (pj.d3 && typeof pj.d3.scale === 'function' ? pj.d3.scale() * Math.PI / 180 : pj.H / 180) : 0
  const stepFor = (P, R) => {
    if (want) return want
    if (curved) {
      const pxv = k * sc * uPerDeg, minPx = fsA * 1.2 * 2.2
      if (pxv > 0) return Math.max(autoGeoStep(Math.min(180, P.w / pxv), pxv, minPx), autoGeoStep(Math.min(180, P.h / pxv), pxv, minPx))
    }
    const E = edgesOf(R), n = refine ? 96 : 32
    const lonSpan = edgeSpan(E.b, inv, 0, n, minRunOf(R, 'b', n)) || edgeSpan(E.t, inv, 0, n, minRunOf(R, 't', n))
    const latSpan = edgeSpan(E.l, invLat, 1, n, minRunOf(R, 'l', n)) || edgeSpan(E.r, invLat, 1, n, minRunOf(R, 'r', n))
    const s1 = lonSpan > 0 ? autoGeoStep(lonSpan, P.w / lonSpan, emW(fmt === 'hemi' ? '000°W' : MINUS + '000.00') * fsA * 1.6) : 0
    const s2 = latSpan > 0 ? autoGeoStep(latSpan, P.h / latSpan, fsA * 1.2 * 2.2) : 0
    return Math.max(s1, s2) || 30
  }
  let pl = plan(0)
  if (!pl) return null
  let step = stepFor(pl.plot, pl.raw)
  if (fmt === 'hemi' && step < 1) { const p2 = plan(step >= 0.1 ? 1 : 2); if (!p2) return null; pl = p2; step = want || stepFor(pl.plot, pl.raw) }
  const P = pl.plot, R = pl.raw, E = edgesOf(R)
  const minor = minorGeoStep(step), div = Math.max(1, Math.round(step / minor))
  const n = nOf(P)
  const ticks = {}
  for (const side of ['b', 't', 'l', 'r']) {
    const comp = side === 'b' || side === 't' ? 0 : 1
    ticks[side] = edgeCrossings(E[side], comp ? invLat : inv, comp, minor, n, refine, minRunOf(R, side, n), 0.5 / lenOf(R, side)).map((c) => {
      const p = E[side](c.t)
      return { x: p[0], y: p[1], v: c.v, major: ((c.j % div) + div) % div === 0 }
    })
  }
  // 经度标注连续：标注（主刻度）整段能平移进 [−180°, 180°] 就平移（平移量是 360° 的整数倍，主刻度不变）；
  // 平移不进去照原样连续标（太平洋居中出 240.00），但连续标只到 [−180°, 360°]，再出界就逐个折回 (−180°, 180°] ——
  // 轴名是「东经」，标出 420.00 这种数就自相矛盾了。
  // ★ 只按主刻度判：次刻度在两头各比标注多出去一截，拿它判的话中心在西半球（切口落在东半球）时整段平移不进 ±180，
  //   一路连续标到 480.00（中心 30°W 时标 180.00 … 480.00）
  let shift = 0, wrapEach = false
  const bv = ticks.b.filter((q) => q.major).map((q) => q.v)
  if (bv.length) {
    const lo = Math.min(...bv), hi = Math.max(...bv)
    if (hi > 180 + 1e-9 && lo - 360 >= -180 - 1e-9) shift = -360
    else if (lo < -180 - 1e-9 && hi + 360 <= 180 + 1e-9) shift = 360
    wrapEach = lo + shift < -180 - 1e-9 || hi + shift > 360 + 1e-9
  }
  const lonOf = (v) => {
    if (!wrapEach) return v + shift
    const w = ((v + 180) % 360 + 360) % 360 - 180
    return w <= -180 + 1e-9 ? 180 : w
  }
  const labels = {
    b: ticks.b.filter((q) => q.major).map((q) => { const v = lonOf(q.v); return { x: q.x, v, text: fmtGeoTick(v, 'lon', fmt, step) } }),
    l: ticks.l.filter((q) => q.major).map((q) => ({ y: q.y, v: q.v, text: fmtGeoTick(q.v, 'lat', fmt, step) }))
  }
  // 经度标注最宽的模板（抽稀量间距用）：与留白同一套模板，只是按实际字体量
  const dec = fmt === 'hemi' && step < 1 ? (step >= 0.1 ? 1 : 2) : 0
  const lonTpl = fmt === 'hemi' ? '000' + (dec ? '.' + '0'.repeat(dec) : '') + '°W' : MINUS + '000.00'
  const M = pl.M
  return { plot: P, ticks, labels, step, minor, fmt, lonTpl, gap: M.gap, line: M.line, gT: M.gT, latW: M.latW, planeTf: [k * sc, (tx - crop.x) * sc, (ty - crop.y) * sc] }
}

// 抽稀候选：标注间隔的整倍数里取「整」的那些（自动间隔那张表，外加 120 / 180；都整除 360，经度平移 360° 不改抽中哪些）
const THIN = [...NICE, 120, 180]
/**
 * 标注挤不下时抽稀：按【绝对值】取间隔 S 的整倍数（每 10°、15°、30°…），S 取相邻两个都放得下的最小一档。
 * ★ 不能「从第一个看得见的起，放不下就跳过」贪心地抽：那个起点随平移变，拖动 / 视频跟随时整排标注来回跳
 *   （0 15 30 ↔ 5 20 35），还会把 0° 抽掉。list = [{ [axis]: 位置, v: 度数 }]，need = 相邻两个中心至少隔多少像素
 */
export function thinGeoLabels(list, step, axis, need) {
  const s = list.slice().sort((a, b) => a[axis] - b[axis])
  if (s.length < 2) return s
  let pick = s
  for (const S of THIN) {
    const m = S / step
    if (m < 1 - 1e-9 || Math.abs(m - Math.round(m)) > 1e-6) continue
    pick = s.filter((q) => { const r = q.v / S; return Math.abs(r - Math.round(r)) < 1e-6 })
    if (pick.every((q, i) => !i || q[axis] - pick[i - 1][axis] >= need)) return pick
  }
  return pick
}

const THEME = {
  light: { bg: '#FFFFFF', frame: '#3F3F3F', label: '#1C1C1C', title: '#1C1C1C', grid: 'rgba(92,92,92,0.72)' },
  dark: { bg: '#0F1216', frame: 'rgba(226,231,238,0.8)', label: 'rgba(238,242,246,0.9)', title: 'rgba(238,242,246,0.76)', grid: 'rgba(214,220,228,0.55)' }
}
const CJK = /[\u2e80-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/
let _cache = { key: '', pj: null, L: null }

// 非等距圆柱档的经纬网：按「平面 + 间隔」缓存成【世界平面坐标】的折线（d3 graticule 经投影、切口裁剪、自适应加密的原样输出），
// 逐帧只把落进图框的那几段换到画面像素落笔。
// ★ 原来每次重画都现算一张全球经纬网：方位等距 0.5° 档 11 万点 32 ms、0.1° 档 87 万点 200 ms，平移 / 播放每一拍都付，
//   而它只随投影平面与间隔变。键里的几项就是 projection.js 里决定平面形状的全部参数（换了就是另一个不可变的 pj）。
// 屏上、视频、PNG / PDF 导出回放的是同一份点列，只用 moveTo / lineTo（svgcanvas 录得下来，不递 Path2D）。
const GRAT_KEEP = 3
const _grats = []
export function graticuleOf(pj, step) {
  const key = [pj.kind, pj.lon0, pj.lat0, pj.par && pj.par.join(), pj.W, pj.H, step].join('|')
  for (let i = 0; i < _grats.length; i++) {
    if (_grats[i].key !== key) continue
    const g = _grats[i]
    if (i) { _grats.splice(i, 1); _grats.unshift(g) }
    return g
  }
  const lines = []
  let cur = null
  const end = () => { if (cur && cur.length >= 4) lines.push(packGratLine(cur)); cur = null }
  pj.path(pj.graticule(step)(), {
    moveTo: (x, y) => { end(); cur = [x, y] },
    lineTo: (x, y) => { if (cur) cur.push(x, y); else cur = [x, y] },
    closePath: () => { if (cur && cur.length >= 4) cur.push(cur[0], cur[1]) },
    arc: () => {}
  })
  end()
  const g = { key, lines }
  _grats.unshift(g)
  if (_grats.length > GRAT_KEEP) _grats.length = GRAT_KEEP
  return g
}
// 一条子路径：点列 + 包围盒 + 沿线累计长度（平面单位，截取时对齐虚线相位用）
function packGratLine(a) {
  const n = a.length / 2, xy = Float64Array.from(a), cum = new Float64Array(n)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    if (i) cum[i] = cum[i - 1] + Math.hypot(x - xy[i * 2 - 2], y - xy[i * 2 - 1])
  }
  return { xy, cum, n, x0, y0, x1, y1 }
}
/**
 * 把缓存的经纬网里落进图框的段描进当前路径（调用方已 beginPath、设好虚线，这里只 moveTo / lineTo）。
 * a, b, c：世界平面 → 画面像素 = (a·x + b, a·y + c)；P：图框（画面像素）；per：虚线一个周期（画面像素）；pad：图框外扩（线宽）。
 * ★ 只描图框里那几段：放大后全球网在屏上总长几亿像素 —— 虚线按整条路径长度切划，Skia 超过一百万划直接放弃虚线改画实线，
 *   画不着的部分照样要描边。
 * ★ 截下来的段起点往回退到「从原子路径起点量、整周期」处：canvas 的虚线在每个子路径起点从相位 0 起算，从中间截就整段错相
 *   （平移时点子沿线爬）。退到整周期处后与整条画逐点同相。不用 lineDashOffset：svgcanvas 不认它，且一次 stroke 只有一个值。
 * 返回落笔的点数
 */
export function traceGraticule(ctx, G, a, b, c, P, per, pad) {
  const X0 = (P.x - pad - b) / a, X1 = (P.x + P.w + pad - b) / a, Y0 = (P.y - pad - c) / a, Y1 = (P.y + P.h + pad - c) / a
  const perU = per > 0 ? per / a : 0
  let ops = 0
  for (const ln of G.lines) {
    if (ln.x1 < X0 || ln.x0 > X1 || ln.y1 < Y0 || ln.y0 > Y1) continue
    const xy = ln.xy, cum = ln.cum, n = ln.n
    let open = false
    for (let i = 0; i + 1 < n; i++) {
      const xa = xy[i * 2], ya = xy[i * 2 + 1], xb = xy[i * 2 + 2], yb = xy[i * 2 + 3]
      if ((xa < X0 && xb < X0) || (xa > X1 && xb > X1) || (ya < Y0 && yb < Y0) || (ya > Y1 && yb > Y1)) { open = false; continue }
      if (!open) {
        const s = perU > 0 ? Math.floor(cum[i] / perU) * perU : cum[i]
        let j = i
        while (j > 0 && cum[j] > s) j--
        const seg = cum[j + 1] - cum[j], f = j < i && seg > 0 ? Math.min(1, Math.max(0, (s - cum[j]) / seg)) : 0
        const x = xy[j * 2] + (xy[j * 2 + 2] - xy[j * 2]) * f, y = xy[j * 2 + 1] + (xy[j * 2 + 3] - xy[j * 2 + 1]) * f
        ctx.moveTo(a * x + b, a * y + c); ops++
        for (let q = j + 1; q <= i; q++) { ctx.lineTo(a * xy[q * 2] + b, a * xy[q * 2 + 1] + c); ops++ }
        open = true
      }
      ctx.lineTo(a * xb + b, a * yb + c); ops++
    }
  }
  return ops
}

/**
 * 画经纬图框（坐标 = 画面像素 W × H，调用方已置好变换）。o = { step, fmt, theme: 'light'|'dark', lines }；
 * st = 字号与字体：fsA（刻度字号，缺省按画面高的 1.56%）/ lw（线宽，缺省按画面高）/ font 'doc' 衬线 / fontStack /
 *   fontLatin（PDF 的西文面：数字走它，汉字走 fontStack）/ cache（各调用方自己一份版式缓存，免得两处交替作废）。
 * T(zh, en) 出轴标题。返回图框内区 { x, y, w, h }；取景里没有地图时返回 null 且什么都不画。
 * ★ 只用 svgcanvas 录得下来的调用（矩形 / 文字 / 平移旋转 / 虚线 / 裁剪），文字基线一律 middle —— 平面图的 PDF 导出也走这一支
 */
export function drawGeoFrame(ctx, W, H, view, opt, st, T) {
  const o = opt || {}, s = st || {}
  const fsA = s.fsA > 0 ? s.fsA : Math.max(8, H * 0.02) * 0.78
  const famC = s.fontStack || (s.font === 'doc' ? SERIF : SANS), famL = s.fontLatin || famC
  const fontOf = (t) => `${fsA.toFixed(2)}px ${CJK.test(t) ? famC : famL}`
  const pj = view && view.pj, c = view && view.crop
  const C = s.cache || _cache
  const key = pj && c ? [pj.kind, pj.lon0, pj.lat0, pj.par && pj.par.join(), view.k, view.tx, view.ty, c.x, c.y, c.w, c.h, W, H, o.step, o.fmt, fsA].join('|') : ''
  let L
  if (key && C.key === key && C.pj === pj) L = C.L
  else { L = geoFrameLayout(W, H, view, o, fsA); C.key = key; C.pj = pj; C.L = L }
  if (!L) return null
  const th = THEME[o.theme === 'dark' ? 'dark' : 'light']
  const lw = s.lw > 0 ? s.lw : Math.max(1, Math.round(H / 1080))
  const P = L.plot
  const snap = (v) => Math.round(v) + (lw % 2 ? 0.5 : 0)
  ctx.save()
  const skip0 = ctx.__i18nSkip
  ctx.__i18nSkip = true
  // ① 网格线：点线，裁到图框内（等距圆柱直接画两族直线；其余投影走缓存的 d3 经纬网曲线（graticuleOf）—— 世界平面点逐个换到
  //    画面像素再落笔，不靠 ctx.transform：画面像素那套变换之外再叠一层，线宽与虚线周期就跟着缩了）
  if (o.lines !== false) {
    ctx.save()
    ctx.beginPath(); ctx.rect(P.x, P.y, P.w, P.h); ctx.clip()
    ctx.strokeStyle = th.grid; ctx.lineWidth = lw; ctx.lineCap = 'butt'
    ctx.setLineDash([lw * 1.2, lw * 2.8])
    ctx.beginPath()
    if (pj.identity || typeof pj.path !== 'function') {
      for (const q of L.ticks.b) if (q.major) { const x = snap(q.x); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h) }
      for (const q of L.ticks.l) if (q.major) { const y = snap(q.y); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y) }
    } else {
      const [a, b, cc] = L.planeTf
      traceGraticule(ctx, graticuleOf(pj, L.step), a, b, cc, P, lw * 4, lw)
    }
    ctx.stroke()
    ctx.restore()
  }
  // ② 留白：图框外四条，不透明
  ctx.fillStyle = th.bg
  ctx.fillRect(0, 0, W, P.y); ctx.fillRect(0, P.y + P.h, W, H - P.y - P.h)
  ctx.fillRect(0, P.y, P.x, P.h); ctx.fillRect(P.x + P.w, P.y, W - P.x - P.w, P.h)
  // ③ 图框 + 四边内向刻度（主刻度长、次刻度短；实心矩形画，像素对齐）
  ctx.setLineDash([])
  ctx.strokeStyle = th.frame; ctx.lineWidth = lw
  ctx.strokeRect(P.x + lw / 2, P.y + lw / 2, P.w - lw, P.h - lw)
  ctx.fillStyle = th.frame
  const lenMaj = Math.max(3, Math.round(fsA * 0.6)), lenMin = Math.max(2, Math.round(fsA * 0.32))
  for (const q of L.ticks.b) { const len = q.major ? lenMaj : lenMin; ctx.fillRect(Math.round(q.x - lw / 2), P.y + P.h - len, lw, len) }
  for (const q of L.ticks.t) { const len = q.major ? lenMaj : lenMin; ctx.fillRect(Math.round(q.x - lw / 2), P.y, lw, len) }
  for (const q of L.ticks.l) { const len = q.major ? lenMaj : lenMin; ctx.fillRect(P.x, Math.round(q.y - lw / 2), len, lw) }
  for (const q of L.ticks.r) { const len = q.major ? lenMaj : lenMin; ctx.fillRect(P.x + P.w - len, Math.round(q.y - lw / 2), len, lw) }
  // ④ 标注：下边居中、左边右齐；挤不下的按绝对值抽稀（刻度照画，见 thinGeoLabels），出画面的不画
  ctx.fillStyle = th.label; ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  const yB = P.y + P.h + L.gap + L.line / 2
  ctx.font = fontOf(L.lonTpl)
  for (const q of thinGeoLabels(L.labels.b, L.step, 'x', ctx.measureText(L.lonTpl).width + fsA * 0.6)) {
    ctx.font = fontOf(q.text)
    const w = ctx.measureText(q.text).width
    if (q.x - w / 2 < 0 || q.x + w / 2 > W) continue
    ctx.fillText(q.text, q.x, yB)
  }
  ctx.textAlign = 'right'
  for (const q of thinGeoLabels(L.labels.l, L.step, 'y', L.line * 1.15)) {
    if (q.y - fsA * 0.6 < 0 || q.y + fsA * 0.6 > H) continue
    ctx.font = fontOf(q.text)
    ctx.fillText(q.text, P.x - L.gap, q.y)
  }
  // ⑤ 轴标题：紧挨标注外侧（图框随地图收拢时跟着走）
  const tt = (zh, en) => (typeof T === 'function' ? T(zh, en) : zh)
  const hemi = L.fmt === 'hemi'
  const tLon = hemi ? tt('经度', 'Longitude') : tt('东经（°）', 'East Longitude (Degrees)')
  const tLat = hemi ? tt('纬度', 'Latitude') : tt('北纬（°）', 'North Latitude (Degrees)')
  ctx.fillStyle = th.title; ctx.textAlign = 'center'
  ctx.font = fontOf(tLon)
  ctx.fillText(tLon, P.x + P.w / 2, P.y + P.h + L.gap + L.line + L.gT + L.line / 2)
  ctx.save()
  ctx.translate(P.x - L.gap - L.latW - L.gT - L.line / 2, P.y + P.h / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.font = fontOf(tLat)
  ctx.fillText(tLat, 0, 0)
  ctx.restore()
  ctx.__i18nSkip = skip0
  ctx.restore()
  return { x: P.x, y: P.y, w: P.w, h: P.h }
}
