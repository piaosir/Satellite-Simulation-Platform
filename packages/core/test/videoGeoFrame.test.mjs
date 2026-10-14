// 2D 经纬图框（src/viz/geo/geoFrame.js；视频导出与平面图共用）：间隔 / 次刻度 / 标注格式、沿边穿越点、图框收拢到地图、
// 刻度落点与投影逐点对得上（等距圆柱精确、罗宾逊二分加密到亚像素）、取景里没有地图时不画、
// 框边贴图时刻度不随亚像素相位忽有忽无、两极反解发散处照出刻度、标注按绝对值抽稀；
// 方位等距 / 阿尔伯斯的自动间隔按视图比例定、经纬网按平面缓存且只描图框里那几段、经度标注不出 [−180°, 360°]（2026-10-08 深度排查 #23 / #45）。
// 运行：npm test -- videoGeoFrame
import { autoGeoStep, minorGeoStep, fmtGeoTick, edgeCrossings, geoFrameLayout, geoFrameMargins, drawGeoFrame, thinGeoLabels, graticuleOf, traceGraticule } from '../../../src/viz/geo/geoFrame.js'
import { makeProjection } from '../../../src/viz/geo/projection.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const fakeCtx = () => ({
  font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', lineCap: '',
  texts: [],
  save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {}, rect() {}, clip() {}, stroke() {}, setLineDash() {},
  fillRect() {}, strokeRect() {}, fill() {}, translate() {}, rotate() {}, transform() {},
  fillText(s) { this.texts.push(s) },
  measureText(s) { const px = Number((/([\d.]+)px/.exec(this.font) || [0, 12])[1]); return { width: String(s).length * px * 0.55 } }
})
// 屏上视图：平面图在 stage（CSS px）里 fit 整幅世界（同 flatCoverage.fit），取景框 = 16:9 居中最大矩形
function viewOf(pj, stageW, stageH, W, H, zoom = 1, panX = 0, panY = 0) {
  const base = Math.min(stageW / pj.W, stageH / pj.H), k = base * zoom
  const tx = (stageW - pj.W * k) / 2 + panX, ty = (stageH - pj.H * k) / 2 + panY
  const A = W / H
  let cw = stageW, ch = stageW / A
  if (ch > stageH) { ch = stageH; cw = stageH * A }
  return { pj, k, tx, ty, crop: { x: (stageW - cw) / 2, y: (stageH - ch) / 2, w: cw, h: ch } }
}

// ① 间隔 / 次刻度 / 标注
{
  ok('① 自动间隔：180° → 30°、360° → 60°、90° → 15°、20° → 5°', autoGeoStep(180, 10, 0) === 30 && autoGeoStep(360, 5, 0) === 60 && autoGeoStep(90, 10, 0) === 15 && autoGeoStep(20, 50, 0) === 5)
  ok('① 自动间隔照顾像素密度：标注宽 120 px、每度 2 px → 至少 60°', autoGeoStep(40, 2, 120) === 60)
  ok('① 次刻度：10→2、15→5、30→10、45→15、60→15、90→30、0.5→0.1、20→5', [[10, 2], [15, 5], [30, 10], [45, 15], [60, 15], [90, 30], [0.5, 0.1], [20, 5]].every(([a, b]) => Math.abs(minorGeoStep(a) - b) < 1e-12))
  ok('① SATSOFT 档：−50.00 / 0.00 / 50.00（真减号）', fmtGeoTick(-50, 'lon', 'num', 50) === '−50.00' && fmtGeoTick(-1e-12, 'lat', 'num', 10) === '0.00' && fmtGeoTick(50, 'lat', 'num', 10) === '50.00')
  ok('① 半球档：50°W / 0° / 160°W（200° 折回）/ 180° / 30°S / 0.5°E', fmtGeoTick(-50, 'lon', 'hemi', 10) === '50°W' && fmtGeoTick(0, 'lon', 'hemi', 10) === '0°' && fmtGeoTick(200, 'lon', 'hemi', 10) === '160°W' && fmtGeoTick(-180, 'lon', 'hemi', 10) === '180°' && fmtGeoTick(-30, 'lat', 'hemi', 10) === '30°S' && fmtGeoTick(0.5, 'lon', 'hemi', 0.5) === '0.5°E')
}
// ② 沿边穿越：线性边上落点精确；跨日界线解缠、不重不漏
{
  const at = (t) => [t * 100, 0]
  const inv = (x) => { const lon = 150 + x * 0.6; return [((lon + 180) % 360 + 360) % 360 - 180, 0] }   // 150°E → 210°（= 150°W），中间跨日界线
  const cr = edgeCrossings(at, inv, 0, 10, 37, false)
  ok('② 跨日界线：150、160 … 210 共 7 根、按顺序', cr.length === 7 && cr.map((c) => Math.round(c.v)).join(',') === '150,160,170,180,190,200,210', cr.map((c) => c.v).join(','))
  ok('② 落点精确（线性插值）', cr.every((c) => Math.abs(c.t * 100 - (c.v - 150) / 0.6) < 1e-9))
  const gap = edgeCrossings((t) => [t, 0], (x) => (x > 0.4 && x < 0.6 ? null : [x * 100, 0]), 0, 10, 50, false)
  ok('② 中段落在地图外：那一段不出刻度、两侧照常', gap.map((c) => c.v).join(',') === '0,10,20,30,40,60,70,80,90,100', gap.map((c) => c.v).join(','))
}
// ③ 等距圆柱整幅世界（16:9 取景、出厂切口 −180°）：图框贴着地图上下沿收拢；刻度落点与投影逐点一致；标注 / 自动间隔
{
  const pj = makeProjection('equirect', -180)
  const W = 1920, H = 1080
  const v = viewOf(pj, 1600, 900, W, H)
  const L = geoFrameLayout(W, H, v, { step: 0, fmt: 'num' }, 16.8)
  const sc = W / v.crop.w, wy0 = (v.ty - v.crop.y) * sc, wy1 = wy0 + 180 * v.k * sc
  // 世界矩形上沿（北极）在上留白之下 → 框上沿贴北极；下沿（南极）落进下留白 → 框下沿让给刻度标注，不越出南极
  ok('③ 图框 = 留白内区 ∩ 世界矩形：上沿贴北极、下沿不越出南极', L && Math.abs(L.plot.y - Math.round(wy0)) <= 1 && L.plot.y + L.plot.h <= Math.round(wy1) && H - (L.plot.y + L.plot.h) > 16.8 * 3, L && JSON.stringify(L.plot))
  ok('③ 自动间隔 60°（整幅 360° 经度）', L.step === 60 && Math.abs(L.minor - 15) < 1e-12)
  const xOf = (lon) => ((lon + 180) * v.k + v.tx - v.crop.x) * sc
  const yOf = (lat) => ((90 - lat) * v.k + v.ty - v.crop.y) * sc
  ok('③ 下边刻度：x 与经度逐点吻合（< 1e-6 px）', L.ticks.b.length > 0 && L.ticks.b.every((q) => Math.abs(q.x - xOf(q.v)) < 1e-6))
  ok('③ 左边刻度：y 与纬度逐点吻合', L.ticks.l.length > 0 && L.ticks.l.every((q) => Math.abs(q.y - yOf(q.v)) < 1e-6))
  ok('③ 上 / 下两边刻度一一对应（经线是竖直线）', L.ticks.t.length === L.ticks.b.length && L.ticks.t.every((q, i) => Math.abs(q.x - L.ticks.b[i].x) < 1e-6))
  ok('③ 标注：经度 −120.00 … 120.00，纬度含 0.00 与 ±60', L.labels.b.map((q) => q.text).join(' ') === '−120.00 −60.00 0.00 60.00 120.00' && L.labels.l.some((q) => q.text === '0.00' && Math.abs(q.y - yOf(0)) < 1e-6), L.labels.b.map((q) => q.text).join(' '))
  ok('③ 主刻度 = 间隔整倍数，其余是次刻度', L.ticks.b.every((q) => q.major === (Math.abs(q.v / 60 - Math.round(q.v / 60)) < 1e-9)))
}
// ④ 太平洋居中（切口 0°，取景 100°E–260°E）：经度标注连续（240.00 不折回）；半球档折回 120°W
{
  const pj = makeProjection('equirect', 0)
  const W = 1920, H = 1080, stageW = 1600, stageH = 900
  // 放大 2 倍并把 180° 移到画面中间：平面 x = 180 处于 stage 中心
  const z = 2, base = Math.min(stageW / 360, stageH / 180), k = base * z
  const v0 = viewOf(pj, stageW, stageH, W, H, z)
  const v = { ...v0, tx: stageW / 2 - 180 * k, ty: stageH / 2 - 90 * k }
  const L = geoFrameLayout(W, H, v, { step: 60, fmt: 'num' }, 16.8)
  ok('④ 连续东经标注：120.00 180.00 240.00', L && L.labels.b.map((q) => q.text).join(' ') === '120.00 180.00 240.00', L && L.labels.b.map((q) => q.text).join(' '))
  const Lh = geoFrameLayout(W, H, v, { step: 60, fmt: 'hemi' }, 16.8)
  ok('④ 半球档：120°E 180° 120°W', Lh && Lh.labels.b.map((q) => q.text).join(' ') === '120°E 180° 120°W', Lh && Lh.labels.b.map((q) => q.text).join(' '))
}
// ⑤ 曲线投影（罗宾逊）：下边沿穿越点二分加密 → 回代逆算的经度与刻度值相差 < 0.01°
{
  const pj = makeProjection('robinson', -180)
  const W = 1920, H = 1080
  const v = viewOf(pj, 1600, 900, W, H, 1.6)
  const L = geoFrameLayout(W, H, v, { step: 15, fmt: 'num' }, 16.8)
  const sc = W / v.crop.w
  const lonAt = (fx, fy) => { const q = pj.inv(((v.crop.x + fx / sc) - v.tx) / v.k, ((v.crop.y + fy / sc) - v.ty) / v.k); return q ? q[0] : NaN }
  const errs = L ? L.ticks.b.map((q) => Math.abs(((lonAt(q.x, q.y) - q.v + 540) % 360) - 180)) : [1]
  ok('⑤ 罗宾逊：下边刻度回代误差 < 0.01°', L && L.ticks.b.length > 3 && Math.max(...errs) < 0.01, 'max ' + Math.max(...errs).toExponential(2))
}
// ⑥ 绘制：返回图框内区、标注与轴标题都落笔；取景里没有地图时什么都不画、返回 null
{
  const pj = makeProjection('equirect', -180)
  const W = 1920, H = 1080
  const ctx = fakeCtx()
  const area = drawGeoFrame(ctx, W, H, viewOf(pj, 1600, 900, W, H), { step: 0, fmt: 'num', theme: 'light', lines: true }, { size: 1 }, (zh) => zh)
  ok('⑥ 返回图框内区且在画面内', area && area.x > 0 && area.y >= 0 && area.x + area.w < W && area.y + area.h < H)
  ok('⑥ 轴标题：东经（°）/ 北纬（°）', ctx.texts.includes('东经（°）') && ctx.texts.includes('北纬（°）'))
  ok('⑥ 标注落笔（含 0.00）', ctx.texts.includes('0.00'))
  const ctx2 = fakeCtx()
  const far = viewOf(pj, 1600, 900, W, H, 1, 5000, 0)
  ok('⑥ 地图整个拖出取景：返回 null、不落一笔', drawGeoFrame(ctx2, W, H, far, { step: 0 }, { size: 1 }) === null && ctx2.texts.length === 0)
  const ctx3 = fakeCtx()
  drawGeoFrame(ctx3, W, H, viewOf(pj, 1600, 900, W, H), { step: 30, fmt: 'hemi' }, { size: 1 }, (zh, en) => en)
  ok('⑥ 半球档英文轴标题：Longitude / Latitude', ctx3.texts.includes('Longitude') && ctx3.texts.includes('Latitude'))
}

// ⑦ 平面图的 fit：按留白收进图框后，图框正好贴着世界矩形（四边各差不过 1 px）；留白与字体无关、整数像素
{
  const M = geoFrameMargins(12, 'num'), Mh = geoFrameMargins(12, 'hemi')
  ok('⑦ 留白是整数像素、左 > 下 > 右 > 0，半球档左边更窄（50°W 比 −50.00 短）', [M.l, M.b, M.t, M.r].every((v) => Number.isInteger(v) && v > 0) && M.l > M.b && M.b > M.r && Mh.l < M.l)
  ok('⑦ 同参数两次结果逐位相同（不量字体：屏上 / PNG / PDF 的 fit 必须一致）', JSON.stringify(geoFrameMargins(12, 'num')) === JSON.stringify(M))
  for (const kind of ['equirect', 'robinson']) {
    const pj = makeProjection(kind, -30)
    for (const [cw, ch] of [[1600, 900], [900, 900], [1280, 520]]) {
      const iw = cw - M.l - M.r, ih = ch - M.t - M.b, b = Math.min(iw / pj.W, ih / pj.H)
      const v = { pj, k: b, tx: M.l + (iw - pj.W * b) / 2, ty: M.t + (ih - pj.H * b) / 2, crop: { x: 0, y: 0, w: cw, h: ch } }
      const L = geoFrameLayout(cw, ch, v, { step: 0, fmt: 'num' }, 12)
      const P = L && L.plot
      const hug = P && Math.abs(P.x - v.tx) <= 1 && Math.abs(P.y - v.ty) <= 1 && Math.abs(P.x + P.w - (v.tx + pj.W * b)) <= 1 && Math.abs(P.y + P.h - (v.ty + pj.H * b)) <= 1
      ok(`⑦ ${kind} ${cw}×${ch}：fit 进留白后图框贴合世界矩形`, hug, P && JSON.stringify(P))
    }
  }
}
// ⑧ 档位存储（stores/mapCrs）：出厂开、逐项合并、认不得的值留原值、出厂表不被改到；读回旧存档按 MAP_CRS_REV 迁
{
  const { mapCrs, setMapCrs, restoreMapCrs, MAP_CRS_DEF, MAP_CRS_REV, frameThemeOf } = await import('../../../src/stores/mapCrs.js')
  ok('⑧ 出厂：开、自动间隔、SATSOFT 标注、跟随外观、带网格线', JSON.stringify(mapCrs.frame) === JSON.stringify({ on: true, step: 0, fmt: 'num', theme: 'auto', lines: true }))
  ok('⑧ 跟随外观按当前外观解析；手选的浅 / 深色不跟', frameThemeOf('auto', 'dark') === 'dark' && frameThemeOf('auto', 'light') === 'light' && frameThemeOf('light', 'dark') === 'light' && frameThemeOf('dark', 'light') === 'dark')
  setMapCrs({ frame: { on: false, fmt: 'hemi' } })
  ok('⑧ 只给两项：其余保持', mapCrs.frame.on === false && mapCrs.frame.fmt === 'hemi' && mapCrs.frame.step === 0 && mapCrs.frame.theme === 'auto' && mapCrs.frame.lines === true)
  setMapCrs({ frame: { step: 'x', fmt: 'deg', theme: 'red', lines: 'no', on: 1 } })
  ok('⑧ 坏值一律留原值', mapCrs.frame.on === false && mapCrs.frame.step === 0 && mapCrs.frame.fmt === 'hemi' && mapCrs.frame.theme === 'auto' && mapCrs.frame.lines === true)
  setMapCrs({ frame: { step: 30, theme: 'dark', lines: false } })
  ok('⑧ 合法值收下', mapCrs.frame.step === 30 && mapCrs.frame.theme === 'dark' && mapCrs.frame.lines === false)
  setMapCrs({ datum: 'wgs84' })
  ok('⑧ 存档里没有 frame 键（旧档）：图框档不动', mapCrs.frame.step === 30 && mapCrs.frame.on === false)
  setMapCrs(MAP_CRS_DEF)
  ok('⑧ 恢复出厂：回到开；出厂表本身没被改', mapCrs.frame.on === true && mapCrs.frame.step === 0 && MAP_CRS_DEF.frame.on === true && mapCrs.frame !== MAP_CRS_DEF.frame)
  // 读回视图快照：出厂改开之前存的（无 rev）里那个 on 是旧出厂值顺手存下来的 → 不认、留新出厂值，其余项照收；带 rev 的照存档
  restoreMapCrs({ datum: 'wgs84', frame: { on: false, step: 15, fmt: 'hemi', theme: 'dark', lines: false } })
  ok('⑧ 旧存档（无 rev）：开关与底色按新出厂值，其余项照收', mapCrs.frame.on === true && mapCrs.frame.step === 15 && mapCrs.frame.fmt === 'hemi' && mapCrs.frame.theme === 'auto' && mapCrs.frame.lines === false)
  restoreMapCrs({ rev: 1, frame: { on: false, theme: 'light' } })
  ok('⑧ rev 1 存档：开关照收，底色（旧出厂浅色）按新出厂「跟随外观」', mapCrs.frame.on === false && mapCrs.frame.theme === 'auto')
  restoreMapCrs({ rev: MAP_CRS_REV, frame: { on: true, theme: 'light' } })
  ok('⑧ 新存档：手选的浅色照收', mapCrs.frame.theme === 'light')
  restoreMapCrs({ rev: MAP_CRS_REV, frame: { on: false } })
  ok('⑧ 新存档（带 rev）：用户关掉的照关', mapCrs.frame.on === false && mapCrs.frame.step === 15)
  restoreMapCrs({ lon0: -30 })
  ok('⑧ 更早的存档（没有 frame 键）：图框档不动', mapCrs.frame.on === false && mapCrs.frame.step === 15)
  setMapCrs(MAP_CRS_DEF)
}

// ⑨ 框边贴着世界矩形时的亚像素相位（2026-10-08）：框边取整后曾被推到地图外至多半个像素，逆算全给 null —— 整条边刻度、标注全丢，
//    推出去还是收进来随平移缩放的亚像素相位变，屏上拖动、视频跟随时一闪一闪。整幅世界 fit 后做亚像素平移 + 微缩放：
//    四边逐帧都有刻度、经纬值集合逐帧相同（太平洋居中，同用户截图；伪圆柱左右两边的纬度按纬线平齐读，不再只剩赤道相切的一丝）
{
  const M = geoFrameMargins(12, 'hemi')
  for (const kind of ['equirect', 'mercator', 'robinson', 'equalEarth']) {
    const pj = makeProjection(kind, 150)
    const sides = ['b', 't', 'l', 'r']
    for (const [cw, ch] of [[1600, 900], [1366, 700], [1100, 800]]) {
      const iw = cw - M.l - M.r, ih = ch - M.t - M.b, b0 = Math.min(iw / pj.W, ih / pj.H)
      const sig = new Set()
      let empty = 0, noLabel = 0
      for (let i = 0; i < 40; i++) {
        const k = b0 * (1 + (i % 5) * 1e-4)
        const v = { pj, k, tx: M.l + (iw - pj.W * k) / 2 + (i * 0.137) % 1 - 0.5, ty: M.t + (ih - pj.H * k) / 2 + (i * 0.291) % 1 - 0.5, crop: { x: 0, y: 0, w: cw, h: ch } }
        const L = geoFrameLayout(cw, ch, v, { step: 0, fmt: 'hemi' }, 12)
        if (sides.some((s) => !L.ticks[s].length)) empty++
        if (!L.labels.b.length) noLabel++
        sig.add(['b', 't', 'l', 'r'].map((s) => L.ticks[s].map((q) => q.v.toFixed(6)).join(',')).join('|'))
      }
      ok(`⑨ ${kind} ${cw}×${ch}：40 个亚像素相位，${sides.join('')} 边逐帧有刻度、经度标注逐帧都在、刻度集合逐帧相同`, !empty && !noLabel && sig.size === 1, `空边 ${empty} 帧、无经度标注 ${noLabel} 帧、${sig.size} 种刻度集合`)
    }
  }
  // 极线两头恰是切口经线（150°E）落在图廓上：一律不出（同框角），不随浮点忽有忽无
  const pj = makeProjection('robinson', 150)
  const iw = 1600 - M.l - M.r, ih = 900 - M.t - M.b, b0 = Math.min(iw / pj.W, ih / pj.H)
  const L = geoFrameLayout(1600, 900, { pj, k: b0, tx: M.l + (iw - pj.W * b0) / 2, ty: M.t + (ih - pj.H * b0) / 2, crop: { x: 0, y: 0, w: 1600, h: 900 } }, { step: 0, fmt: 'hemi' }, 12)
  ok('⑨ 罗宾逊极线：切口经线 150° / 510° 不出刻度，其余 15° 一根', L.ticks.b.length > 0 && L.ticks.b.every((q) => Math.abs(((q.v - 150) % 360 + 360) % 360) > 1e-6) && L.ticks.b.every((q, i) => !i || Math.abs(q.v - L.ticks.b[i - 1].v - 15) < 1e-9), L.ticks.b.map((q) => q.v).join(','))
}
// ⑩ 罗宾逊整幅世界的 4K 成片：d3 的反解在极线 0.12 平面单位以内发散（纬度冲出 ±90°），4K 下那是一个多像素 ——
//    曾经上下两边一根刻度都量不出、经度标注全丢；图框按画面 1 px 回代后两边照常出
{
  for (const kind of ['robinson', 'equalEarth']) {
    const pj = makeProjection(kind, -180)
    for (const [W, H, fs] of [[1920, 1080, 16.8], [3840, 2160, 33.7]]) {
      const L = geoFrameLayout(W, H, viewOf(pj, 1600, 900, W, H), { step: 0, fmt: 'hemi' }, fs)
      ok(`⑩ ${kind} ${W}×${H}：上下两边有刻度、经度标注 ≥ 3 个`, L && L.ticks.t.length > 0 && L.ticks.b.length > 0 && L.labels.b.length >= 3, L && `上 ${L.ticks.t.length} / 下 ${L.ticks.b.length} / 标注 ${L.labels.b.length}`)
    }
  }
}
// ⑪ 标注抽稀按绝对值取整倍数：挤不下时每 10°、15°…取，不从第一个看得见的起贪心地隔几个 ——
//    后者随平移换相位（视频跟随时整排标注来回跳），还会把 0° 抽掉（截图里纬度标成 85°N、75°N…5°N、5°S）
{
  const lat = []
  for (let v = 85; v >= -85; v -= 5) lat.push({ y: 100 + (85 - v) * 3.24, v })
  const pick = thinGeoLabels(lat, 5, 'y', 12 * 1.2 * 1.15)
  ok('⑪ 纬度每 5° 挤不下：改取 10° 整倍数（含 0°、不含 85°）', pick.every((q) => q.v % 10 === 0) && pick.some((q) => q.v === 0) && !pick.some((q) => q.v === 85), pick.map((q) => q.v).join(' '))
  ok('⑪ 放得下就全取（间隔 = 标注间隔）', thinGeoLabels(lat, 5, 'y', 10).length === lat.length)
  const lon = (dx) => { const a = []; for (let v = -15; v <= 345; v += 5) a.push({ x: 80 + (v + 15) * 3.24 + dx, v }); return a }
  const p0 = thinGeoLabels(lon(0), 5, 'x', 43), p1 = thinGeoLabels(lon(-7.3).filter((q) => q.x > 75), 5, 'x', 43)
  ok('⑪ 经度每 5° 挤不下：取 15° 整倍数；平移、最左那个出画面后取中的仍是同一批值', p0.every((q) => q.v % 15 === 0) && p1.every((q) => q.v % 15 === 0) && p1[0].v === 0 && p1.length === p0.length - 1 && p1.every((q) => p0.some((r) => r.v === q.v)), p0.map((q) => q.v).join(' ') + ' / ' + p1.map((q) => q.v).join(' '))
}

// ⑫ 方位等距 / 阿尔伯斯的自动间隔按视图比例定（#23）：图廓是奇异边缘，框边擦过它的一小截经纬跨度极小，原来按整幅框宽折算 ——
//    整幅视图下滚轮一格塌到 2°、跟随起手 0.5°、拖 3 px 0.1°（整盘密网、每拍重算 200 ms）；阿尔伯斯整幅直接 2°。
//    现在：整幅附近（平移几像素 / 跟随起手把圆心摆到画布中心 / 滚轮 0–8 格）都是 30°，滚轮放大单调不增，放大到区域照常细
{
  const FS = 12
  const M = geoFrameMargins(FS, 'num')
  const stepAt = (pj, cw, ch, v) => { const L = geoFrameLayout(cw, ch, { pj, k: v.k, tx: v.tx, ty: v.ty, crop: { x: 0, y: 0, w: cw, h: ch } }, { step: 0, fmt: 'num' }, FS); return L ? L.step : null }
  for (const [kind, opts] of [['azeq', { lat0: 0 }], ['azeq', { lat0: 35 }], ['albers', {}]]) {
    const pj = makeProjection(kind, -30, opts)
    for (const [cw, ch] of [[1600, 900], [1366, 700], [1920, 1040]]) {
      const iw = cw - M.l - M.r, ih = ch - M.t - M.b, b = Math.min(iw / pj.W, ih / pj.H)
      const fit = { k: b, tx: M.l + (iw - pj.W * b) / 2, ty: M.t + (ih - pj.H * b) / 2 }
      const near = [fit, { ...fit, ty: fit.ty + 3 }, { ...fit, ty: fit.ty - 2 }, { ...fit, tx: fit.tx + 96, ty: fit.ty + 10 }, { ...fit, ty: fit.ty + 150 },
        { k: b, tx: cw / 2 - pj.W / 2 * b, ty: ch / 2 - pj.H / 2 * b }].map((v) => stepAt(pj, cw, ch, v))
      const wheel = []
      for (let n = 0; n <= 8; n++) {
        const k = b * Math.exp(n * 0.03 * Math.log(60 / 0.9))
        wheel.push(stepAt(pj, cw, ch, { k, tx: cw / 2 - ((cw / 2 - fit.tx) / b) * k, ty: ch / 2 - ((ch / 2 - fit.ty) / b) * k }))
      }
      ok(`⑫ ${kind}${opts.lat0 != null ? ' 中心纬度 ' + opts.lat0 : ''} ${cw}×${ch}：整幅附近 ${near.join('/')}°、滚轮 0–8 格 ${wheel.join('/')}°`,
        near.every((s) => s === 30) && wheel.every((s, i) => s >= 15 && (!i || s <= wheel[i - 1])))
    }
  }
  // 一路放大到头（中国全图一带）：间隔单调变细，到区域尺度是几度
  for (const [kind, opts] of [['azeq', { lat0: 35 }], ['albers', {}]]) {
    const pj = makeProjection(kind, -75, opts)
    const cw = 1600, ch = 900, iw = cw - M.l - M.r, ih = ch - M.t - M.b, b = Math.min(iw / pj.W, ih / pj.H)
    const p = pj.fwd(105, 35, [0, 0])
    const seq = []
    for (let z = 1; z <= 300; z *= 1.25) seq.push(stepAt(pj, cw, ch, { k: b * z, tx: cw / 2 - p[0] * b * z, ty: ch / 2 - p[1] * b * z }))
    ok(`⑫ ${kind} 放大 ×1 → ×300（105°E 35°N 居中）：单调变细、×10 一带 ≤ 10°、到头 ≤ 1°`, seq.every((s, i) => !i || s <= seq[i - 1]) && seq[10] <= 10 && seq[seq.length - 1] <= 1, seq.join(' '))
  }
}

// ⑬ 非等距圆柱档的经纬网按「平面 + 间隔」缓存（#23）：同平面同间隔再画不再现算 d3 经纬网（原来每帧现算，0.1° 档 200 ms）；
//    放大后只落笔图框里那几段，且落进图框的点线与整张全球网逐划相同 —— 截取起点退到整周期处，虚线相位不错（平移时点子不爬）
{
  const base = makeProjection('azeq', 17.25, { lat0: 12 })   // 独有的平面：模块缓存里一定没有它
  let calls = 0
  const pj = { ...base, path: (g, t) => { calls++; return base.path(g, t) } }
  const cw = 1600, ch = 900, b = Math.min(cw / 360, ch / 360) * 40
  const opsCtx = () => { const c = fakeCtx(); c.ops = 0; c.moveTo = () => { c.ops++ }; c.lineTo = () => { c.ops++ }; return c }
  const draws = []
  for (let i = 0; i < 4; i++) {
    const c = opsCtx()
    drawGeoFrame(c, cw, ch, { pj, k: b, tx: cw / 2 - 180 * b + i * 37, ty: ch / 2 - 180 * b - i * 11, crop: { x: 0, y: 0, w: cw, h: ch } }, { step: 2, fmt: 'num', lines: true }, { fsA: 12, lw: 1, cache: { key: '', pj: null, L: null } }, (z) => z)
    draws.push(c.ops)
  }
  const G = graticuleOf(pj, 2)
  const total = G.lines.reduce((s, l) => s + l.n, 0)
  ok('⑬ 同平面同间隔：平移四帧只现算一次经纬网；每帧落笔点数远少于全球网', calls === 1 && draws.every((n) => n > 0 && n < total / 20), `现算 ${calls} 次、落笔 ${draws.join('/')} 点、全球网 ${total} 点`)

  // 逐划比对：每个子路径按 canvas 口径（相位 0 起）切虚线并裁到图框，两种画法落进图框的划完全一样
  const rec = () => { const r = { subs: [], cur: null }; r.moveTo = (x, y) => { r.cur = [[x, y]]; r.subs.push(r.cur) }; r.lineTo = (x, y) => { if (r.cur) r.cur.push([x, y]); else r.moveTo(x, y) }; r.closePath = () => {}; r.arc = () => {}; return r }
  const dashes = (sub, on, per, P, out) => {
    let s0 = 0
    for (let i = 0; i + 1 < sub.length; i++) {
      const [ax, ay] = sub[i], [bx, by] = sub[i + 1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy)
      if (!(L > 0)) continue
      for (let k = Math.floor(s0 / per); k * per < s0 + L; k++) {
        const d0 = Math.max(s0, k * per), d1 = Math.min(s0 + L, k * per + on)
        if (d1 <= d0) continue
        let t0 = (d0 - s0) / L, t1 = (d1 - s0) / L, keep = true
        const pp = [-dx, dx, -dy, dy], qq = [ax - P.x, P.x + P.w - ax, ay - P.y, P.y + P.h - ay]
        for (let m = 0; m < 4 && keep; m++) {
          if (pp[m] === 0) { if (qq[m] < 0) keep = false; continue }
          const r = qq[m] / pp[m]
          if (pp[m] < 0) { if (r > t1) keep = false; else if (r > t0) t0 = r } else { if (r < t0) keep = false; else if (r < t1) t1 = r }
        }
        if (keep && t1 - t0 > 1e-9) out.push([ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1])
      }
      s0 += L
    }
  }
  let worst = 0, missing = 0, cases = 0
  for (const [kind, o] of [['azeq', { lat0: 0 }], ['albers', {}], ['robinson', {}], ['mercator', {}]]) {
    const q = makeProjection(kind, -30, o)
    for (const [zoom, step, fx, fy] of [[1, 30, 0.5, 0.5], [6, 5, 0.3, 0.6], [40, 1, 0.7, 0.3]]) {
      const a = Math.min(cw / q.W, ch / q.H) * zoom, bx = cw / 2 - q.W * fx * a, cy = ch / 2 - q.H * fy * a
      const P = { x: 60, y: 12, w: cw - 90, h: ch - 70 }
      const full = rec()
      q.path(q.graticule(step)(), { moveTo: (x, y) => full.moveTo(a * x + bx, a * y + cy), lineTo: (x, y) => full.lineTo(a * x + bx, a * y + cy), closePath() {}, arc() {} })
      const cut = rec()
      traceGraticule(cut, graticuleOf(q, step), a, bx, cy, P, 4, 1)
      const dF = [], dC = []
      for (const s of full.subs) dashes(s, 1.2, 4, P, dF)
      for (const s of cut.subs) dashes(s, 1.2, 4, P, dC)
      const ink = (l) => l.reduce((s, d) => s + Math.hypot(d[2] - d[0], d[3] - d[1]), 0)
      worst = Math.max(worst, Math.abs(ink(dF) - ink(dC)) / Math.max(1e-9, ink(dF)))
      const starts = new Set(dF.map((d) => d[0].toFixed(4) + ',' + d[1].toFixed(4)))
      missing += dC.filter((d) => !starts.has(d[0].toFixed(4) + ',' + d[1].toFixed(4))).length
      cases++
    }
  }
  ok(`⑬ 截取后落进图框的点线与整张全球网逐划相同（${cases} 种投影 × 缩放 × 平移）`, worst < 1e-9 && missing === 0, `墨量相对差 ${worst.toExponential(1)}、对不上的划 ${missing}`)
}

// ⑭ 经度标注不出 [−180°, 360°]（#45）：中心 30°W（切口 150°E）整幅时曾标 180.00 … 480.00、轴名还是「东经」——
//    平移量只按主刻度（带标注的）判；连续标进不了 [−180°, 360°] 就逐个折回 (−180°, 180°]；出厂中心 150°E 仍是连续的 0.00 … 300.00
{
  const W = 1920, H = 1080
  const lab = (center) => {
    const pj = makeProjection('equirect', ((center - 180 + 180) % 360 + 360) % 360 - 180)
    const b = Math.min((W - 120) / pj.W, (H - 120) / pj.H)
    const L = geoFrameLayout(W, H, { pj, k: b, tx: (W - pj.W * b) / 2, ty: (H - pj.H * b) / 2, crop: { x: 0, y: 0, w: W, h: H } }, { step: 0, fmt: 'num' }, 16)
    return L.labels.b.map((q) => q.text).join(' ')
  }
  ok('⑭ 中心 30°W：整段平移进 ±180（−180.00 … 120.00）', lab(-30) === '−180.00 −120.00 −60.00 0.00 60.00 120.00', lab(-30))
  ok('⑭ 中心 90°W：连续标会到 420，逐个折回', lab(-90) === '120.00 180.00 −120.00 −60.00 0.00 60.00', lab(-90))
  ok('⑭ 出厂中心 150°E：连续 0.00 … 300.00（与修改前相同）', lab(150) === '0.00 60.00 120.00 180.00 240.00 300.00', lab(150))
  let n = 0, out = 0
  const M = geoFrameMargins(12, 'num')
  for (const kind of ['equirect', 'robinson', 'mercator', 'albers', 'azeq']) {
    for (let center = -180; center < 180; center += 7.5) {
      const pj = makeProjection(kind, ((center - 180 + 180) % 360 + 360) % 360 - 180)
      const cw = 1600, ch = 900, iw = cw - M.l - M.r, ih = ch - M.t - M.b, b = Math.min(iw / pj.W, ih / pj.H)
      for (const [z, fx] of [[1, 0.5], [2, 0.3], [2, 0.7], [4, 0.1], [4, 0.95]]) {
        const k = b * z
        const v = z === 1 ? { k, tx: M.l + (iw - pj.W * b) / 2, ty: M.t + (ih - pj.H * b) / 2 } : { k, tx: cw / 2 - pj.W * fx * k, ty: ch / 2 - pj.H * 0.5 * k }
        for (const fmt of ['num', 'hemi']) {
          const L = geoFrameLayout(cw, ch, { pj, ...v, crop: { x: 0, y: 0, w: cw, h: ch } }, { step: 0, fmt }, 12)
          if (!L) continue
          n++
          if (L.labels.b.some((q) => q.v < -180 - 1e-9 || q.v > 360 + 1e-9)) out++
        }
      }
    }
  }
  ok(`⑭ 五种投影 × 一圈画面中心 × 整幅 / 放大平移 × 两种标注：经度标注一个都不出 [−180°, 360°]（${n} 幅）`, n > 1000 && out === 0, `出界 ${out} 幅`)
}

console.log(`\n${fail ? 'FAIL' : 'OK'} ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
