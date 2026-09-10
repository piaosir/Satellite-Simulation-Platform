// 2D 投影层的不变量（src/viz/geo/projection.js）。运行：npm test
//
// 六档：等距圆柱（出厂）/ Mercator / Equal Earth / Robinson / Albers / 方位等距。
// 这一层错了的症状都不是「报错」，而是「图看着有点怪」——地物挪了半个像素、点选读数偏了一点、
// 海陆颜色反了。故判据一律是能算的量：平面归一、正逆算往返、绕向、切口、以及接线检查。
//
// ★ 出厂档【不走 d3】：它是全平台的默认，也是 mapGeometry.test.mjs ① 段钉死的那一套坐标。
//   这里逐点验它与 (lon−lon0, 90−lat) 逐位相同 —— 只要这条绿着，换投影这件事就动不到默认档。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { feature } from 'topojson-client'
import { geoArea, geoPath } from 'd3-geo'
import { makeProjection, PROJECTIONS, DEFAULT_PROJECTION, isProjection, MERCATOR_LAT, ALBERS_PARALLELS, lonBreaks, lonPeriod, planCells, cellError, blockError, planCellsInv, planBlockInv, cellErrorInv, cellDrawableInv, cellCornersInv, projParams, PATH_PRECISION, OUTLINE_PRECISION } from '../../../src/viz/geo/projection.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let pass = 0, fail = 0
// ★ 源码扫描用的正则一律走行尾归一后的副本：工作区在 Windows 上是 CRLF（git 的 autocrlf），
//   而判据里的 /…\n/ 假定的是 LF —— 不归一的话这几条会无缘无故地红，跟代码对不对没关系。
const lf = (t) => t.replace(/\r\n/g, '\n')

const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const LON0 = -30   // 出厂切口（画面中心 150°E）

// ---------- ① 档位表 ----------
ok('① 六档齐全且出厂档在最前', PROJECTIONS.length === 6 && PROJECTIONS[0].k === DEFAULT_PROJECTION && DEFAULT_PROJECTION === 'equirect',
  PROJECTIONS.map((p) => p.k).join(' / '))
ok('① 每档都有中英名', PROJECTIONS.every((p) => p.k && p.zh && p.en))
ok('① isProjection 认识全部档、拒掉别的', PROJECTIONS.every((p) => isProjection(p.k)) && !isProjection('mollweide') && !isProjection('') && !isProjection(null))
ok('① 不认识的档回落到出厂档', makeProjection('mollweide', LON0).kind === 'equirect' && makeProjection(undefined, LON0).kind === 'equirect')

// ---------- ② 等距圆柱与换投影前逐位相同 ----------
// 这一条是整件事的安全绳：默认档必须一个比特都不变。
{
  const P = makeProjection('equirect', LON0)
  let bad = 0, worst = ''
  const o = [0, 0]
  for (let lat = -90; lat <= 90; lat += 1.5) {
    for (let lon = -180; lon < 180; lon += 1.5) {
      P.fwd(lon, lat, o)
      const ex = (((lon - LON0) % 360) + 360) % 360, ey = 90 - lat
      if (o[0] !== ex || o[1] !== ey) { bad++; if (!worst) worst = `(${lon},${lat}) 得 ${o[0]},${o[1]} 期望 ${ex},${ey}` }
    }
  }
  ok('② 等距圆柱 fwd 就是 (WXN(lon), 90−lat)，逐位相同', bad === 0, worst || '29 161 个点全等')
  ok('② 等距圆柱是 identity 档、平面 360×180、横向周期 360',
    P.identity === true && P.W === 360 && P.H === 180 && P.periodX === 360)
  ok('② 等距圆柱不带 d3（默认档不进 d3 那条路）', P.d3 === null && P.path === null)
  // 逆算与换投影前的 screenToLonLat 逐字一致：世界矩形之外返回 null
  ok('② 世界矩形之外逆算返回 null（信箱留白里点一下不该读出座标）',
    P.inv(-0.5, 90) === null && P.inv(360.5, 90) === null && P.inv(180, -0.5) === null && P.inv(180, 180.5) === null)
  ok('② 世界矩形之内逆算给值', !!P.inv(0, 0) && !!P.inv(360, 180) && !!P.inv(180, 90))
}

// ---------- ③ 平面归一 ----------
// 宽恒 360（与等距圆柱同单位）→ 全平台按 k() 折算的线宽 / 虚线周期 / 字号常数一个都不用动。
for (const { k, zh } of PROJECTIONS) {
  const P = makeProjection(k, LON0)
  const latLim = k === 'mercator' ? MERCATOR_LAT : 90
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, nan = 0
  const o = [0, 0]
  for (let lat = -latLim; lat <= latLim; lat += 1) for (let lon = -180; lon <= 180; lon += 1) {
    P.fwd(lon, lat, o)
    if (!Number.isFinite(o[0]) || !Number.isFinite(o[1])) { nan++; continue }
    if (o[0] < x0) x0 = o[0]; if (o[0] > x1) x1 = o[0]
    if (o[1] < y0) y0 = o[1]; if (o[1] > y1) y1 = o[1]
  }
  ok('③ ' + zh + ' 平面宽恒 360、整个球都落在 [0,W]×[0,H] 内',
    P.W === 360 && x0 >= -1e-6 && x1 <= P.W + 1e-6 && y0 >= -1e-6 && y1 <= P.H + 1e-6 && nan === 0,
    `x[${x0.toFixed(2)},${x1.toFixed(2)}] y[${y0.toFixed(2)},${y1.toFixed(2)}] H=${P.H.toFixed(2)} NaN=${nan}`)
}

// ---------- ④ 正逆算往返 ----------
// 2D 的点选 / 悬停读数 / 拖标记全靠逆算 —— 这几个投影的反解都要迭代，是最容易出错的一处。
for (const { k, zh } of PROJECTIONS) {
  const P = makeProjection(k, LON0)
  const latLim = k === 'mercator' ? MERCATOR_LAT - 0.5 : 89.5
  let maxErr = 0, nulls = 0, n = 0, worst = ''
  const o = [0, 0]
  for (let lat = -latLim; lat <= latLim; lat += 2.5) for (let lon = -179; lon < 180; lon += 3.5) {
    P.fwd(lon, lat, o); if (!Number.isFinite(o[0])) continue
    n++
    const b = P.inv(o[0], o[1])
    if (!b) { nulls++; continue }
    let dl = b[0] - lon; while (dl > 180) dl -= 360; while (dl < -180) dl += 360
    // 极点附近经度本就退化（所有经线交于一点），只比纬度
    const e = Math.abs(lat) > 89 ? Math.abs(b[1] - lat) : Math.max(Math.abs(dl), Math.abs(b[1] - lat))
    if (e > maxErr) { maxErr = e; worst = `(${lon},${lat})→(${b[0].toFixed(4)},${b[1].toFixed(4)})` }
  }
  ok('④ ' + zh + ' 正逆算往返 < 1e-4°（约 1 cm）', maxErr < 1e-4 && nulls === 0,
    `${n} 点 · 最大 ${maxErr.toExponential(1)}° · 逆算失败 ${nulls} · 最差 ${worst}`)
}

// ---------- ⑤ 切口 = 画面左边缘 ----------
// 换切口即换中央经线；圆柱/伪圆柱下切口那条经线必落在 x=0 与 x=W 两端。
for (const { k, zh } of PROJECTIONS) {
  if (k === 'albers') continue   // 圆锥的扇面不是矩形，切口不在包围盒的边上（见下一条单独守）
  // ★ 方位等距：中心纬度默认 0，此时切口那条经线正过对跖点 → 落在圆的最左点 x=0，这一条仍守得住。
  //   中心纬度非 0 时「切口」对它本就不成立（图幅边界是对跖【点】而不是一条经线）。
  for (const l0 of [-30, 0, 75, -180]) {
    const P = makeProjection(k, l0)
    const o = [0, 0]
    P.fwd(l0, 0, o); const atCut = o[0]
    P.fwd(l0 + 180, 0, o); const atMid = o[0]
    ok('⑤ ' + zh + ' 切口 ' + l0 + '° 落在 x=0、画面中心落在 x=W/2',
      Math.abs(atCut) < 1e-6 && Math.abs(atMid - 180) < 1e-6, `切口 x=${atCut.toFixed(6)} 中心 x=${atMid.toFixed(4)}`)
  }
}
{
  // Albers：中央经线仍要落在平面正中（扇面对称轴），只是切口不在包围盒边上
  const P = makeProjection('albers', LON0)
  const o = [0, 0]
  P.fwd(LON0 + 180, 0, o)
  ok('⑤ Albers 中央经线落在扇面对称轴 x=W/2', Math.abs(o[0] - 180) < 1e-6, 'x=' + o[0].toFixed(6))
  ok('⑤ Albers 标准纬线是中国全图惯用的 25°N / 47°N', ALBERS_PARALLELS[0] === 25 && ALBERS_PARALLELS[1] === 47)
}

// ---------- ⑥ Mercator 的纬度钳位 ----------
{
  const P = makeProjection('mercator', LON0)
  const o = [0, 0]
  P.fwd(0, MERCATOR_LAT, o); const yTop = o[1]
  P.fwd(0, 89.9, o); const y90 = o[1]
  P.fwd(0, 1e9, o); const yInf = o[1]
  ok('⑥ Mercator 超过 ±85.05° 一律钳住（否则 ln(tan) 发散、y 冲到无穷）',
    Math.abs(y90 - yTop) < 1e-9 && Math.abs(yInf - yTop) < 1e-9 && Number.isFinite(yTop),
    `85.05°→${yTop.toFixed(4)} 89.9°→${y90.toFixed(4)} 1e9→${yInf.toFixed(4)}`)
  ok('⑥ Mercator 钳位后平面近似正方（等角投影的固有形状）', Math.abs(P.H / P.W - 1) < 0.01, 'H/W=' + (P.H / P.W).toFixed(4))
  ok('⑥ Mercator 的 latLim 就是钳位值', Math.abs(P.latLim - MERCATOR_LAT) < 1e-12)
}

// ---------- ⑦ 非圆柱平面不横向重复 ----------
// ±360 环绕副本只对周期平面成立；四个投影档的内容恒在平面盒子里（d3 已在日界线切开），
// 再画副本就是把整张地图平移一份叠上去。
for (const { k, zh } of PROJECTIONS) {
  const P = makeProjection(k, LON0)
  ok('⑦ ' + zh + ' periodX ' + (k === 'equirect' ? '= 360（有 ±360 副本）' : '= 0（不画副本）'),
    P.periodX === (k === 'equirect' ? 360 : 0))
}

// ---------- ⑧ 绕向：底图里确实有绕反的环 ----------
// ★ 这一条守的是「海陆颜色反了」那个坑的【前提】：d3 按球面口径判内外，绕向反了填的是补集。
//   底图里实测有 4 个小岛环是反的，d3 把它们算成 area = 4π —— 一张世界地图被这几个小岛整个涂满。
//   flatCoverage 的 orientRings 按 area > 2π 翻环；这里钉住「问题真实存在」+「判据能抓到它」。
{
  const topo = JSON.parse(readFileSync(join(ROOT, 'src/viz/globe3d/data/basemap-10m.json'), 'utf8'))
  const units = feature(topo, topo.objects.units).features
  const bad = []
  let total = 0
  for (const f of units) {
    const g = f.geometry
    if (!g) continue
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polys) {
      total++
      if (geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI) bad.push(f.properties.u)
    }
  }
  ok('⑧ 底图里确有绕向反的环（绕向归正不是白加的）', bad.length > 0, bad.length + ' / ' + total + ' 个多边形：' + [...new Set(bad)].join(' '))
  // 翻过来之后必须全部落回半球以内
  const stillBad = []
  for (const f of units) {
    const g = f.geometry
    if (!g) continue
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polys) {
      const a0 = geoArea({ type: 'Polygon', coordinates: rings })
      const co = a0 > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings
      if (geoArea({ type: 'Polygon', coordinates: co }) > 2 * Math.PI) stillBad.push(f.properties.u)
    }
  }
  ok('⑧ 按 area > 2π 翻环之后全部落回半球以内', stillBad.length === 0, stillBad.join(' ') || total + ' 个多边形全过')
  // 陆地总面积回到常识值（约占地球 0.29）—— 绕向没归正时这个数会大出一整个球
  let area = 0
  for (const f of units) {
    const g = f.geometry
    if (!g) continue
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polys) {
      const a0 = geoArea({ type: 'Polygon', coordinates: rings })
      area += a0 > 2 * Math.PI ? geoArea({ type: 'Polygon', coordinates: rings.map((r) => r.slice().reverse()) }) : a0
    }
  }
  const frac = area / (4 * Math.PI)
  ok('⑧ 归正后陆地占比落在常识区间（含南极与内陆水体，0.25~0.35）', frac > 0.25 && frac < 0.35, '占比 ' + frac.toFixed(4))
}

// ---------- ⑨ geoPath 目标只需 moveTo/lineTo/closePath ----------
// flatCoverage 直接把 Path2D 递给 PJ.path —— 成立的前提就是 d3 只用这三个方法。
// 这里拿一个只实现这三个的录制对象跑一遍真底图，接口一变当场红。
{
  const topo = JSON.parse(readFileSync(join(ROOT, 'src/viz/globe3d/data/basemap-50m.json'), 'utf8'))
  const units = feature(topo, topo.objects.units)
  for (const { k, zh } of PROJECTIONS) {
    if (k === 'equirect') continue
    const P = makeProjection(k, LON0)
    let n = 0, subs = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    const rec = {
      moveTo(x, y) { subs++; n++; pt(x, y) },
      lineTo(x, y) { n++; pt(x, y) },
      closePath() {}
    }
    function pt(x, y) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    P.path(units, rec)
    ok('⑨ ' + zh + ' geoPath 只用 moveTo/lineTo/closePath，且出的点都在平面内',
      n > 1000 && subs > 100 && x0 >= -1e-6 && x1 <= P.W + 1e-6 && y0 >= -1e-6 && y1 <= P.H + 1e-6,
      `${n} 点 / ${subs} 子路径 · x[${x0.toFixed(1)},${x1.toFixed(1)}] y[${y0.toFixed(1)},${y1.toFixed(1)}]`)
  }
}

// ---------- ⑩ 栅格重投影的网格：没有哪一格横跨整幅 ----------
// ★ 这一条守的是「影像底图左右错位、半幅被拉成横条」那个 BUG。
//   根因：切口 lon0 那条经线在平面上同时是 x=0 与 x=W，投影只能给出其中一个
//   （实测 fwd(lon0)=0 而 fwd(lon0−ε)=W）。网格若从 −180 起排，就必然有一格【跨过切口】，
//   它两端一个在 x≈W、一个在 x=0 —— 那一格的仿射把 15° 的源图横拉满整幅。
//   lonBreaks 从切口起排并让开两端，本条逐格量平面跨度把它钉死。
{
  const COARSE = 15
  for (const { k, zh } of PROJECTIONS) {
    // 反向网格那一档（方位等距）的网格建在平面上、根本不过 lonBreaks —— 它的不变量另立一段（⑩ᵇ）
    if (makeProjection(k, -30).invGrid) continue
    let worst = 0, worstAt = '', gaps = 0, seamBad = 0
    for (const l0 of [-30, -75, 0, 45, 123.4, -180, 179]) {
      const P = makeProjection(k, l0)
      const brk = lonBreaks(P.lon0, COARSE)
      // ① 断点必须单调、首末恰好覆盖一整圈
      if (!(Math.abs(brk[brk.length - 1] - brk[0] - 360) < 1e-3)) gaps++
      for (let i = 1; i < brk.length; i++) if (!(brk[i] > brk[i - 1])) gaps++
      // ② 每一块折回源图周期后必须整块落在 [−180,180]（否则取源矩形要断成两截）
      for (let i = 0; i + 1 < brk.length; i++) {
        const a = brk[i], b = brk[i + 1], kp = lonPeriod(a, b)
        if (a - 360 * kp < -180.001 || b - 360 * kp > 180.001) seamBad++
      }
      // ③ 逐格量平面跨度：任一格超过半幅宽即是跨了切口
      const o = [0, 0]
      for (let i = 0; i + 1 < brk.length; i++) {
        for (let lat = 90; lat > -90 + 1e-9; lat -= 6) {
          const la = Math.max(-90, lat), la1 = Math.max(-90, lat - 6)
          let x0 = Infinity, x1 = -Infinity
          for (const [lo, lt] of [[brk[i], la], [brk[i + 1], la], [brk[i], la1], [brk[i + 1], la1]]) {
            P.fwd(lo, lt, o)
            if (!Number.isFinite(o[0])) continue
            if (o[0] < x0) x0 = o[0]; if (o[0] > x1) x1 = o[0]
          }
          if (x1 > x0 && x1 - x0 > worst) { worst = x1 - x0; worstAt = `lon0=${l0} 块[${brk[i].toFixed(2)},${brk[i + 1].toFixed(2)}] 纬${la.toFixed(0)}` }
        }
      }
    }
    ok('⑩ ' + zh + ' 没有哪一格横跨整幅（跨切口的格会把源图拉成横条）',
      worst < 180 && gaps === 0 && seamBad === 0,
      `最宽一格 ${worst.toFixed(2)} / ${360}（阈 180） · ${worstAt} · 断点异常 ${gaps} · 跨源缝 ${seamBad}`)
  }
  // 反证：从 −180 起排（换成对齐切口之前的写法）在 lon0 不是 COARSE 整数倍时必然出跨切口的格
  {
    const P = makeProjection('robinson', -75)
    const o = [0, 0]
    let bad = 0
    for (let lon = -180; lon < 180 - 1e-9; lon += COARSE) {
      const a = P.fwd(lon, 0, o)[0], b = P.fwd(Math.min(180, lon + COARSE), 0, [0, 0])[0]
      if (Math.abs(b - a) > 180) bad++
    }
    ok('⑩ 反证：不对齐切口就一定有跨整幅的格（这条红了说明反证本身失效）', bad > 0, '从 −180 起排时有 ' + bad + ' 格跨整幅')
  }
}

// ---------- ⑩ᵇ 反向网格（方位等距）：奇点被挡住、图还铺得满 ----------
// 这一档的网格建在【平面】上、四角逆算成经纬（见 projection.js 的 invGrid），故 ⑩ 那套
// 「经纬块 + lonBreaks」的判据整条不适用，换成它自己的两条不变量：
//   ① 画出来的每一格，四角经度跨度都不许接近半幅 —— 跨极那一格的四角经度能差满 180°
//     （极点处经度本就不定），取源矩形会横扫半张源图。实现里以「跨度 > 90° 就不画」挡下。
//   ② 圆内要铺得满。★ 这一条是拿品红色顶替垫底海色、一眼看出来的三个坑的回归闸：
//     「四角全在内才画」吃掉 12.5% 的面积；跨边界的块走自适应会被判成一格就够 → 整块不画，
//     圆周上一圈块那么大的三角形缺口；放宽判据却不细分 → 圆边上一圈白色的碎三角。
//     密度口径全在 planBlockInv 里，这里就按它逐格铺一遍量覆盖率。
{
  const COARSE = 15
  for (const { k, zh } of PROJECTIONS) {
    const P = makeProjection(k, -30, { lat0: 25 })
    if (!P.invGrid) continue
    const un = (v, r) => { let t = v; while (t - r > 180) t -= 360; while (t - r < -180) t += 360; return t }
    let worstSpan = 0, worstGap = 0, worstAt = '', crossSeam = 0
    for (const res of [1, 3, 6]) {
      const tol = 0.6 / res, ovP = 1.5 / res
      let drawn = 0, inside = 0
      for (let x = 0; x < P.W; x += COARSE) for (let y = 0; y < P.H; y += COARSE) {
        const nx = Math.max(x, Math.min(P.W / 2, x + COARSE)), ny = Math.max(y, Math.min(P.H / 2, y + COARSE))
        if (!P.inPlane(nx, ny)) continue
        const n = planBlockInv(P, x, x + COARSE, y, y + COARSE, tol, res)
        const d = COARSE / n
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          const ax = x + i * d, ay = y + j * d
          const bx = Math.min(x + COARSE, ax + d + ovP), by = Math.min(y + COARSE, ay + d + ovP)
          // 「该有影像的面积」按格心在圆内算 —— 圆内每一小块都该被某个格盖到
          if (P.inPlane(ax + d / 2, ay + d / 2)) inside += d * d
          if (!cellDrawableInv(P, ax, bx, ay, by)) continue
          const q = cellCornersInv(P, ax, bx, ay, by)
          if (!q) continue
          const l = q.map((v) => un(v.lon, q[0].lon))
          const span = Math.max(...l) - Math.min(...l)
          if (span > 90) continue                                       // 实现里的防呆：这一格不画
          if (span > worstSpan) worstSpan = span
          // 这一格跨没跨源图接缝（源图是等经纬位图，经度 −180..180）
          const lmin = Math.min(...l), lmax = Math.max(...l)
          let sft = 0
          const mid = (lmin + lmax) / 2
          while (mid + sft < -180 - 1e-9) sft += 360
          while (mid + sft > 180 + 1e-9) sft -= 360
          if (lmin + sft < -180 - 1e-9 || lmax + sft > 180 + 1e-9) crossSeam++
          drawn += d * d
        }
      }
      const gap = 1 - Math.min(1, drawn / inside)
      if (gap > worstGap) { worstGap = gap; worstAt = 'res=' + res }
    }
    ok('⑩ᵇ ' + zh + ' 反向网格：画出来的格没有一个横跨半张源图（跨极那一格被挡下）',
      worstSpan <= 90, `最宽一格的源经度跨度 ${worstSpan.toFixed(1)}°（阈 90）`)
    ok('⑩ᵇ ' + zh + ' 反向网格：圆内铺得满（缺口只剩圆周与极点处的半格）',
      worstGap <= 0.01, `最坏缺口 ${(worstGap * 100).toFixed(2)}%（阈 1%） · ${worstAt}`)
    // ★ 网格建在平面上，就没法像正向那样拿 lonBreaks 把源图接缝插成断点（那是经纬网格才有的
    //   自由度）—— 必然有一列格骑在 ±180 上。骑着的格源矩形有一半在源图外、drawImage 画不出来，
    //   症状是沿接缝一条锯齿状的白带。实现里靠「跨接缝的格画两遍、源坐标差一个周期」补齐。
    ok('⑩ᵇ ' + zh + ' 反向网格：确实存在跨源图接缝的格（正向躲得开，这一档躲不开）',
      crossSeam > 0, `跨 ±180 的格 ${crossSeam} 个 —— 它们必须画两遍，否则接缝上一条白带`)
  }
  // 反证：跨边界的块若照走自适应，圆周上必然出现整块的缺口 —— planBlockInv 里那条特例正是为它设的
  {
    const P = makeProjection('azeq', -30, { lat0: 0 }), res = 2, tol = 0.6 / res
    let rimBlocks = 0, wouldVanish = 0
    for (let x = 0; x < P.W; x += 15) for (let y = 0; y < P.H; y += 15) {
      const c = [[x, y], [x + 15, y], [x, y + 15], [x + 15, y + 15]].map(([a, b]) => P.inPlane(a, b))
      if (!(c.some((v) => v) && c.some((v) => !v))) continue
      rimBlocks++
      // 自适应给的密度下，这一块的格心有没有一个在圆内（没有＝整块不画＝一个块那么大的洞）
      const n = planCellsInv(P, x, x + 15, y, y + 15, tol, 2 / res), d = 15 / n
      let any = false
      for (let i = 0; i < n && !any; i++) for (let j = 0; j < n && !any; j++) if (P.inPlane(x + i * d + d / 2, y + j * d + d / 2)) any = true
      if (!any) wouldVanish++
    }
    ok('⑩ᵇ 反证：跨边界的块照走自适应会整块消失（这条红了说明那条特例已无必要）',
      wouldVanish > 0, `圆周上的块 ${rimBlocks} 个，其中 ${wouldVanish} 个会整块不画`)
  }
}

// ---------- ⑪ 接线检查（源码级）----------
// 纯函数算得对不等于接上了。这五档的错都藏在「某一层忘了分叉」里：忘了就是那一层
// 在投影档下画在错的地方（或者干脆按等距圆柱的坐标画在图外）。
{
  const FLAT = readFileSync(join(ROOT, 'src/viz/flatmap/flatCoverage.js'), 'utf8')
  const VUE = readFileSync(join(ROOT, 'src/pages/ConstellationMap3D.vue'), 'utf8')
  const CRS = readFileSync(join(ROOT, 'src/stores/mapCrs.js'), 'utf8')
  const IMG = readFileSync(join(ROOT, 'src/viz/imagery.js'), 'utf8')
  // 2026-09-06：影像重投影的两个网格循环从 flatCoverage 搬进了这一份共用的规划器
  // （CPU 的 warpTri 与 GPU 的 glRaster 都从它取网格）。下面几条的判据没变，只是换了扫描对象。
  const RMESH = readFileSync(join(ROOT, 'src/viz/geo/rasterMesh.js'), 'utf8')
  const GRAS = readFileSync(join(ROOT, 'src/viz/flatmap/glRaster.js'), 'utf8')
  const seg = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to))

  ok('⑪ flatCoverage 用的是投影模块，不是自己再算一份', /from '\.\.\/geo\/projection\.js'/.test(FLAT) && /makeProjection\(/.test(FLAT))
  ok('⑪ fit / worldRect 按投影的平面尺寸算（不再写死 360×180）',
    /base = Math\.min\(cw \/ W, ch \/ H\)/.test(FLAT) && /w: PJ\.W \* kk, h: PJ\.H \* kk/.test(FLAT))
  ok('⑪ 环绕副本改走 wraps()（非周期平面只画一份）',
    /const wraps = \(\) => \(PJ\.periodX \? WRAP3 : WRAP1\)/.test(FLAT) &&
    (FLAT.match(/of wraps\(\)/g) || []).length >= 9 &&
    !/for \(const (off|s) of \[-360, 0, 360\]\)/.test(FLAT))
  ok('⑪ 点层正算收在 PX / PY 两个口上，且都吃经纬两个参数',
    /const PX = \(lon, lat\) => PJ\.fwd\(/.test(FLAT) && /const PY = \(lat, lon\) => PJ\.fwd\(/.test(FLAT) &&
    !/\bPX\([^,()]*\)/.test(lf(FLAT).replace(/const PX = \(lon, lat\)[^\n]*\n/, '')))
  ok('⑪ 逆算走 PJ.inv（点选 / 悬停 / 拖标记同一条）', /const q = PJ\.inv\(wx, wy\)/.test(seg(FLAT, 'function screenToLonLat', 'let onRightClick')))
  for (const [nm, from, to] of [
    ['陆地', 'function buildBaseGeo', 'buildBaseGeo(resolvedFeatures('],
    ['五类边界线', 'function bakeBorders', 'function drawBorders'],
    ['覆盖场填充', 'function buildFillPaths', 'function buildSegPaths'],
    ['等值线', 'function buildSegPaths', 'function traceFillBand'],
    ['经纬网', 'function drawGrid', 'function drawSphereOutline'],
    ['折线（省界/航迹/足迹线）', 'function drawPolyline', 'function drawPolylineProj'],
    ['夜区与晨昏线', 'function drawTerminator', 'function drawField']
  ]) ok('⑪ ' + nm + ' 有投影分叉', /PJ\.identity/.test(seg(FLAT, from, to)), from)
  ok('⑪ 绕向归正接在陆地 / 覆盖场 / 足迹三处', (FLAT.match(/asPoly\(|orientRings\(/g) || []).length >= 5)
  ok('⑪ 海只填球面轮廓、另画图廓（否则铺满矩形，图廓当场没）；图廓走 spherePath（2026-09-10 起）',
    /PJ\.spherePath\(/.test(FLAT) && /function drawSphereOutline/.test(FLAT) && /drawSphereOutline\(\)\n/.test(lf(FLAT)))
  ok('⑪ 栅格（影像 / 环境场）在投影档走逐像素重投影',
    /function reprojectRaster/.test(FLAT) && /reprojectRaster\(/.test(seg(FLAT, 'function drawImagery', 'function imageryPlan')) &&
    /reprojectRaster\(/.test(seg(FLAT, 'function drawEnvRaster', 'function drawFieldOverlays')))
  ok('⑪ 栅格网格走 lonBreaks（对齐切口 + 插源缝），且有「一格不许横跨半幅」的防呆',
    /lonBreaks\(L0, COARSE\)/.test(RMESH) && /while \(midLon \+ shift < S\.lonMin/.test(RMESH) && /gx1 - gx0 > PJ\.W \* 0\.5/.test(RMESH))
  // 2026-09-06《2D 投影档高精影像》：投影档下瓦片档【真画瓦片】—— 同一份三角网按片分桶（tileBins），
  // 不再拼成整幅（065c321 的拼图画布那一套仍不许回来），也不再由调用方换成 16K 整幅。
  // 整幅档（16K / 8K）那两行一行不动：它们的出图要与改前逐像素 / 逐字节相同。
  ok('⑪ 投影档吃瓦片：drawImagery 的投影分叉认 imgSet（GPU 分桶路 → CPU 分桶路），整幅两行不动',
    !/tileRegionImage|releaseTileRegion|meshWindow/.test(FLAT) &&
    /if \(imgSet\) \{\s*if \(drawImageryTilesGL\(\)\) return true\s*return blitReprojected\(reprojectRasterTiles\(\), 1, imgBright, true\)/.test(lf(seg(FLAT, 'function drawImagery()', 'function imageryPlan'))) &&
    /reprojectRaster\(imgEl, null, true\)/.test(FLAT) &&
    /if \(!imgEl\) return false/.test(seg(FLAT, 'function drawImagery()', 'function imageryPlan')) &&
    /from '\.\.\/geo\/tileBins\.js'/.test(FLAT))
  ok('⑪ 调用方不再换档：imagery.js 没有 imageryForFlat，2D 与 3D 同一档；换投影仍重推影像',
    !/imageryForFlat|PROJ_IMAGERY/.test(IMG) && !/imageryForFlat/.test(VUE) &&
    /function setMapProj\(k\) \{[^\n]*applyImagery\(\)/.test(lf(VUE)))
  ok('⑪ 瓦片路只有一份分桶几何：CPU 与 GPU 都从 binByTiles 取，选级与等距圆柱同式，导出前把片等到位',
    (FLAT.match(/binByTiles\(/g) || []).length >= 1 && (FLAT.match(/planTileBins\(/g) || []).length >= 3 &&
    /const tileZ = \(kk\) => pickZoom\(1 \/ \(kk \* dpr\), imgMaxZ\)/.test(FLAT) &&
    /if \(tilesT && tilesT\.length\) await loadTiles\(imgSet, zT, tilesT\)/.test(FLAT) &&
    /if \(exporting \|\| compat\) return false/.test(seg(FLAT, 'function drawImageryTilesGL', 'function drawImagery()')))
  ok('⑪ 网格密度走 planCells（固定像素步长那一档是「阿尔伯斯开影像很卡」的成因）',
    /planCells\(PJ, bLo0, bLo1, bLa0, bLa1, tolPlane\)/.test(RMESH) && !/RP_CELL|RP_ROWS/.test(FLAT + RMESH) && /export const RP_TOL = /.test(RMESH))
  // 换档 / 换切口 / 换参数（中心纬度、标准纬线）必须走【同一条】重烘通路 —— 三处各写一遍
  // 迟早漏掉其中一样，漏了就是拿旧平面的缓存去画新平面。现在三个入口都收敛到 rebuildPlane。
  ok('⑪ 换投影 / 换切口 / 换参数收敛到同一条重烘通路',
    /function rebuildPlane\(kind, opts, o\)/.test(FLAT) &&
    (FLAT.match(/rebuildPlane\(/g) || []).length >= 5 &&
    /gridPath = null; gridKey = ''; sphPath = null; sphKey = ''/.test(seg(FLAT, 'function rebuildPlane', 'const offPov')) &&
    /setProjection\(kind, opts\)/.test(FLAT) && /setProjParams\(opts, fast\)/.test(FLAT))
  // 按平面缓存的三样（图廓 / 经纬网 / 栅格重投影）的键都得带上完整的平面指纹，
  // 否则「只改了中心纬度」时键没变、缓存不作废，画出来的还是上一张平面。
  ok('⑪ 图廓 / 经纬网 / 栅格重投影的缓存键都带平面指纹（含中心纬度与标准纬线）',
    /const planeKey = \(\) => PJ\.kind \+ '\/' \+ PJ\.lon0 \+ '\/' \+ PJ\.lat0/.test(FLAT) &&
    (FLAT.match(/planeKey\(\)/g) || []).length >= 4)
  // 反向网格档的两处，都是用户实测报回来的
  ok('⑪ 反向网格：跨源图接缝的格画两遍（源坐标差一个周期），否则接缝上一条锯齿白带',
    /const shifts = \[shift\]/.test(RMESH) && /shifts\.push\(shift \+ 360\)/.test(RMESH) &&
    /shifts\.push\(shift - 360\)/.test(RMESH) && /for \(const sh of shifts\)/.test(RMESH))
  // 2026-09-06 起投影档影像屏上走 GPU 纹理网格。这一层最容易出的错是「两条路各写一份网格」
  // 与「导出悄悄换成 GPU 出的那一张」——前者迟早走偏、后者直接违反 PNG/PDF 逐字节一致。
  ok('⑪ 影像三角网只有一份：CPU 的 warpTri 与 GPU 的 glRaster 都从 planRasterMesh 取',
    /from '\.\.\/geo\/rasterMesh\.js'/.test(FLAT) && (FLAT.match(/planRasterMesh\(PJ, \{/g) || []).length >= 2 &&
    !/document\.|Path2D|getContext/.test(RMESH))   // 纯几何：碰了 DOM 就没法在 Node 里测
  ok('⑪ 导出恒走 CPU 路（GPU 那条只在屏上）',
    /if \(exporting \|\| compat\) return false/.test(seg(FLAT, 'function drawImageryGL', 'function drawImagery()')) &&
    /exporting = true/.test(seg(FLAT, 'async bakeImagery', 'getMapDetail')))
  ok('⑪ GPU 整幅程序不动：S 向 REPEAT 补接缝、T 向 CLAMP，且有边长上限（16K 不许上到显存）',
    /TEXTURE_WRAP_S, gl\.REPEAT/.test(GRAS) && /TEXTURE_WRAP_T, gl\.CLAMP_TO_EDGE/.test(GRAS) &&
    /export const GL_TEX_MAX = 8192/.test(GRAS) && /tw > GL_TEX_MAX/.test(FLAT))
  ok('⑪ GPU 瓦片程序：片外 discard、有效窗 uWin、gutter 按 (G + t·512)/N 取样、片纹理两向 CLAMP + LRU',
    /discard/.test(GRAS) && /uWin/.test(GRAS) && /\(vec2\(uG\) \+ t \* 512\.0\) \/ uN/.test(GRAS) &&
    /export const TILE_TEX_LIMIT = /.test(GRAS) && /renderBins\(/.test(GRAS) &&
    (GRAS.match(/TEXTURE_WRAP_S, gl\.CLAMP_TO_EDGE/g) || []).length >= 1)
  // warpTri 每个三角形都 drawImage 整张源图（靠 clip 裁），耗时几乎正比于源图面积；
  // 而方位等距的三角形数是别的档的十倍，这一项被放大十倍 —— 实测 936 ms → 113 ms。
  ok('⑪ 反向网格：源图按屏上分辨率先降一档再贴（16K 整张贴一万个三角形是 936 ms）',
    /function srcThumb\(img, sw, sh, res\)/.test(FLAT) && /360 \* res/.test(FLAT) &&
    /const TH = srcThumb\(S\.img, sw, sh, res\)/.test(FLAT) &&
    /thumbCv\.width >= want/.test(FLAT))
  ok('⑪ 档位存在 mapCrs 里（跟着存档走）', /proj: DEFAULT_PROJECTION/.test(CRS) && /isProjection\(patch\.proj\)/.test(CRS))
  ok('⑪ 侧栏有「2D 投影」一节且挂在影像底图之后',
    VUE.indexOf("isSecOpen('geo-img'") < VUE.indexOf("isSecOpen('geo-proj'") &&
    VUE.indexOf("isSecOpen('geo-proj'") < VUE.indexOf("isSecOpen('geo-ocean'") &&
    /setMapProj\(\$event\.target\.value\)/.test(VUE))
  ok('⑪ 挂载时把档位【连同参数】推给 2D（否则存档恢复后按出厂档 / 出厂参数画）',
    /flat\.setProjection\(mapCrs\.proj, projOpts\(\)\)/.test(VUE) && (VUE.match(/flat\.setProjection\(/g) || []).length >= 3)
}

// ---------- ⑫ 网格密度：几何误差有界，且不做白工 ----------
// 网格仿射拉伸是「把弧当直线用」，误差就是格心那一下的偏差（一格拆两个三角形，格心正落在
// 公共边上，故 cellError 量的就是实际用到的那个插值）。planCells 保证它 ≤ tol。
// ★ 这一段替掉的是「固定像素步长」那一档，它两头都不对：
//   · 圆锥（Albers）远远过采样 —— 一屏三万多个三角形，每个都是 save+clip+drawImage+restore，
//     那就是「阿尔伯斯开了影像很卡」；
//   · 伪圆柱（Robinson / Equal Earth）在深放大处反而欠采样 —— 格心偏差到 2 px 以上。
{
  const OLD_ROWS = 14, OLD_CELL = 22, COARSE = 15      // 固定档的两个常数，只在本段作反证用
  for (const { k, zh } of PROJECTIONS) {
    if (k === 'equirect') continue                      // 出厂档不走重投影（PJ.identity 直接铺）
    if (makeProjection(k, -75).invGrid) continue        // 反向网格档另立一段（⑫ᵇ）：网格建在平面上，这套经纬块的判据不适用
    let worstNew = 0, worstOld = 0, cellsNew = 0, cellsOld = 0, atNew = ''
    for (const res of [6, 25, 60, 160, 400]) {          // 每平面单位多少烘图像素（＝屏上分辨率）
      const P = makeProjection(k, -75)
      const tol = 0.6 / res
      const oldLat = Math.max(0.25, Math.min(6, OLD_ROWS / res))
      const oldLon = Math.min(COARSE, P.rowAffine ? 360 : Math.max(0.5, Math.min(12, OLD_CELL / res)))
      const oLon = Math.ceil(COARSE / oldLon), oLat = Math.ceil(COARSE / oldLat)
      for (let lon = -75; lon < 285 - 1e-9; lon += COARSE) {
        for (let lat = 90; lat > -90 + 1e-9; lat -= COARSE) {
          const lo0 = lon, lo1 = lon + COARSE, la0 = lat, la1 = lat - COARSE
          const { nLon, nLat } = planCells(P, lo0, lo1, la0, la1, tol)
          const eNew = blockError(P, lo0, lo1, la0, la1, nLon, nLat) * res
          if (eNew > worstNew) { worstNew = eNew; atNew = `res=${res} 块[${lo0},${la0}] ${nLon}×${nLat}` }
          cellsNew += nLon * nLat
          worstOld = Math.max(worstOld, blockError(P, lo0, lo1, la0, la1, oLon, oLat) * res)
          cellsOld += oLon * oLat
        }
      }
    }
    ok('⑫ ' + zh + ' 格心偏差 ≤ 0.6 烘图像素（亚像素，看不出来）', worstNew <= 0.61,
      `最坏 ${worstNew.toFixed(2)} px · ${atNew} · 固定档同口径 ${worstOld.toFixed(2)} px · 格数 ${cellsOld} → ${cellsNew}`)
  }
  // ---------- ⑫ᵇ 反向网格（方位等距）的格心偏差 ----------
  // 判据翻过来但尺子不变：格心的【插值经纬】正算回平面，与真实格心比，仍是平面单位 × res。
  // ★ 两处豁免，都是「奇点本身那一格」，不是给算法开的后门：
  //   · 极点那一格 —— 经度在极点上不定，等经纬源图那一圈是同一片冰盖，贴错经度看不出来；
  //   · 贴着圆周那一格 —— 对跖点是真奇点，整条圆周对应同一个球面点，「贴得准不准」无从谈起。
  //   除这两处之外，圆内每一格都必须守住 0.6 px。
  for (const { k, zh } of PROJECTIONS) {
    if (!makeProjection(k, -75).invGrid) continue
    for (const lat0 of [0, 40]) {
      const P = makeProjection(k, -75, { lat0 })
      let worst = 0, at = '', cells = 0, capped = 0
      for (const res of [1, 6, 60]) {
        const tol = 0.6 / res
        for (let x = 0; x < P.W; x += COARSE) for (let y = 0; y < P.H; y += COARSE) {
          const nx = Math.max(x, Math.min(P.W / 2, x + COARSE)), ny = Math.max(y, Math.min(P.H / 2, y + COARSE))
          if (!P.inPlane(nx, ny)) continue
          // 密度走渲染端那一份（planBlockInv）：自适应 + 三条特例
          const n = planBlockInv(P, x, x + COARSE, y, y + COARSE, tol, res), d = COARSE / n
          // 同一块【纯自适应】（不设任何下限）会切到几段 —— 用来分辨这一块的密度是谁定的
          const nAdapt = planCellsInv(P, x, x + COARSE, y, y + COARSE, tol, 0)
          cells += n * n
          // ★ 密度被那几条特例【压住】的块不参与精度校核：圆周一圈按缺口定密度、极点与拉伸带
          //   按地面分辨率定格边 —— 它们管的都是「铺不铺得满 / 划不划算」，不是精度。
          //   放进来等于拿精度的尺子去量另一件事。压住与否直接比得出来：n < 纯自适应的段数。
          if (n < nAdapt) { capped++; continue }
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const ax = x + i * d, ay = y + j * d
            if (!cellDrawableInv(P, ax, ax + d, ay, ay + d)) continue
            // ★ 两类格豁免，都是「奇点本身那一格」，不是给算法开的后门：
            //   · 跨图幅边界的格 —— 它靠 clampPlane 把角压回圆内才画得出来，量到的是那点形变，
            //     不是投影的曲率；圆周（对跖点）本就是奇点，整条圆周对应同一个球面点，
            //     「贴得准不准」无从谈起。
            //   · 含极点的格 —— 极点处经度不定，等经纬源图那一圈是同一片冰盖，贴错经度看不出来。
            if (!(P.inPlane(ax, ay) && P.inPlane(ax + d, ay) && P.inPlane(ax, ay + d) && P.inPlane(ax + d, ay + d))) continue
            const q = P.invRaw(ax + d / 2, ay + d / 2)
            if (!q || Math.abs(q[1]) > 89) continue
            const e = cellErrorInv(P, ax, ax + d, ay, ay + d) * res
            if (e > worst) { worst = e; at = `res=${res} 格[${ax.toFixed(1)},${ay.toFixed(1)}] 块切 ${n}×${n}` }
          }
        }
      }
      ok('⑫ᵇ ' + zh + ' 中心纬度 ' + lat0 + '° 格心偏差 ≤ 0.6 烘图像素', worst <= 0.61,
        `最坏 ${worst.toFixed(2)} px · ${at} · 格数 ${cells} · 顶到上限的块 ${capped}`)
    }
  }
  // 反证：反向网格若不细分（一块一格），对跖点那一带必然超差 —— 这条红了说明 ⑫ᵇ 白守
  {
    const P = makeProjection('azeq', -75, { lat0: 0 })
    const e = cellErrorInv(P, 15, 30, 165, 180) * 6
    ok('⑫ᵇ 反证：反向网格一块一格必然超差（圆周那一带的经纬插值不是线性的）', e > 0.6, `一块一格偏差 ${e.toFixed(2)} px`)
  }
  // 反证：同一带走【正算】切到上限也救不回来 —— 这就是方位等距非走反向网格不可的理由。
  // 对跖点的切向尺度因子是 γ/sin γ：γ=179° 处一格被拉长 137 倍，经纬网格再密也追不上。
  {
    const P = makeProjection('azeq', -75, { lat0: 0 }), res = 6
    const lo0 = P.lon0 + 0.001, lo1 = P.lon0 + COARSE      // 紧贴对跖点所在经线的那一块
    const one = cellError(P, lo0, lo1, 15, 0) * res
    const { nLon, nLat } = planCells(P, lo0, lo1, 15, 0, 0.6 / res)
    const after = blockError(P, lo0, lo1, 15, 0, nLon, nLat) * res
    ok('⑫ᵇ 反证：同一带走正算，切到上限仍差两个数量级（对跖点的 γ/sinγ 发散）',
      one > 100 && after > 100, `一块一格 ${one.toFixed(0)} px → 切 ${nLon}×${nLat}（上限 128）后仍 ${after.toFixed(0)} px；反向同带 ≤ 0.6 px`)
  }
  // 反证一：固定档在深放大的伪圆柱上确实越界（这条红了说明反证失效、⑫ 的意义也就没了）
  {
    const P = makeProjection('robinson', -75), res = 400
    const oldLat = Math.max(0.25, Math.min(6, OLD_ROWS / res))
    let worst = 0
    for (let lat = 90; lat > -90 + 1e-9; lat -= COARSE)
      worst = Math.max(worst, blockError(P, 0, COARSE, lat, lat - COARSE, 1, Math.ceil(COARSE / oldLat)) * res)
    ok('⑫ 反证：固定像素步长在 Robinson 深放大处超差', worst > 0.6, `固定档最坏 ${worst.toFixed(2)} px（阈 0.6）`)
  }
  // 反证二：圆锥的纬线是圆弧，一块一格必然超差 —— 也就是「不能照搬圆柱那套一块一仿射」
  {
    const e = cellError(makeProjection('albers', -75), 60, 75, 45, 30) * 60
    ok('⑫ 反证：Albers 一块一格必然超差（纬线是圆弧，不是直线）', e > 0.6, `一块一格偏差 ${e.toFixed(2)} px`)
  }
  // 经向切几刀：Mercator 的 x = s·λ 与纬度无关 → 恒一块一格（与固定档的 lonStep = 15° 同一个结论）；
  // 伪圆柱是 x = A(φ)·λ，A 随纬度变 → 有个交叉项，经向要切那么一两刀，但也就一两刀。
  {
    let merc = true, pseudo = 0
    for (const lat of [0, 30, 60, 80]) if (planCells(makeProjection('mercator', -75), 0, 15, lat, lat - 15, 0.6 / 200).nLon !== 1) merc = false
    for (const k of ['equalEarth', 'robinson']) {
      const P = makeProjection(k, -75)
      for (const lat of [0, 30, 60, 80]) pseudo = Math.max(pseudo, planCells(P, 0, 15, lat, lat - 15, 0.6 / 200).nLon)
    }
    ok('⑫ Mercator 经向恒一块一格（x 与纬度无关，切它一刀一点误差都不减）', merc)
    let cone = 99
    for (const lat of [0, 30, 60, 80]) cone = Math.min(cone, planCells(makeProjection('albers', -75), 0, 15, lat, lat - 15, 0.6 / 200).nLon)
    ok('⑫ 伪圆柱经向切得远比圆锥少（前者只为 A(φ) 的交叉项切，后者的纬线本身就是圆弧）',
      pseudo < cone, `伪圆柱最多 ${pseudo} 段 · 圆锥最少 ${cone} 段`)
  }
}

// ---------- ⑬ 图廓与加密精度（2026-09-10 用户截图：等积地球 / 罗宾逊的图廓「不圆」） ----------
// d3 出厂精度 √0.5 是按「输出即屏幕像素」设的；本平面 1 单位 ≈ 1°、屏上是 k 个像素（放到头 741）。
// 图廓只由 8 个控制点起算、全靠加密撑形 → 出厂精度下 Equal Earth 只有 33 段折线、弦高 0.41 单位，
// 6 px/° 下就是 3 px 的折角。判据：弦高按【真实最大偏差】量（参考轮廓按 1e-4 精度生成，点到折线的最大距离），
// 不信 d3 自己报的精度。
{
  // mv[i] = 第 i 点是 moveTo（子路径起点）：跨子路径的相邻两点不是一段，配成对会量出一条横跨整幅的假弦
  const rec = () => { const pts = [], mv = []; return { pts, mv, moveTo(x, y) { pts.push([x, y]); mv.push(true) }, lineTo(x, y) { pts.push([x, y]); mv.push(false) }, closePath() {} } }
  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
    t = t < 0 ? 0 : (t > 1 ? 1 : t)
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }
  // 点集到折线的最大距离（真实弦高）
  const maxDev = (pts, poly) => {
    let worst = 0
    for (const [px, py] of pts) {
      let best = Infinity
      for (let i = 1; i < poly.length; i++) { const d = segDist(px, py, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]); if (d < best) best = d }
      if (best > worst) worst = best
    }
    return worst
  }
  const sphereAt = (kind, opts, precision) => { const P = makeProjection(kind, LON0, opts); P.d3.precision(precision); const r = rec(); geoPath(P.d3, r)({ type: 'Sphere' }); return r.pts }
  // ★ 真实弦高会比 d3 的精度值大一点：它只在【弦中点】量一次垂距，中点恰好落回弦上的奇对称段就不再切
  //   （罗宾逊的表格样条上有这样的段，0.001 / 0.0005 / 0.0003 三档实测都停在 0.00201）。故判据按真实弦高
  //   ≤ 0.0025 单位给：放到头（741 px/°）1.9 px、常用 50 px/° 下 0.13 px、全图视角 0.006 px。
  const OUTLINE_REAL = 0.0025
  for (const kind of ['equalEarth', 'robinson', 'albers', 'azeq']) {
    const opts = kind === 'azeq' ? { lat0: 35 } : undefined
    const ref = sphereAt(kind, opts, 1e-4)
    const P = makeProjection(kind, LON0, opts)
    const fine = rec(); P.spherePath(fine)
    const coarse = rec(); P.path({ type: 'Sphere' }, coarse)     // 地物那份实例画出来的图廓
    const dFine = maxDev(ref, fine.pts), dCoarse = maxDev(ref, coarse.pts)
    ok('⑬ ' + kind + ' spherePath 图廓真实弦高 ≤ 0.0025 单位（放到头 741 px/° 也 < 2 px、50 px/° 下 0.13 px）',
      dFine <= OUTLINE_REAL && fine.pts.length >= 200 && fine.pts.length < 4000, fine.pts.length + ' 点 · 弦高 ' + dFine.toFixed(5))
    ok('⑬ ' + kind + ' 地物那份 path 的 Sphere 弦高 ≤ PATH_PRECISION（它比图廓粗，图廓必须另走 spherePath）',
      dCoarse <= PATH_PRECISION * 1.05, coarse.pts.length + ' 点 · 弦高 ' + dCoarse.toFixed(4))
  }
  // 反证：d3 出厂精度下图廓真的只有几十段折线（这条红了说明 d3 换了默认值，上两条的意义要重新审）
  {
    const pts = sphereAt('equalEarth', undefined, Math.SQRT1_2)
    const d = maxDev(sphereAt('equalEarth', undefined, 1e-4), pts)
    ok('⑬ 反证：出厂精度 √0.5 下 Equal Earth 图廓 < 60 点、弦高 > 0.3 单位', pts.length < 60 && d > 0.3, pts.length + ' 点 · 弦高 ' + d.toFixed(3))
  }
  ok('⑬ 两档常数：PATH_PRECISION 0.05（10m 一趟 +0~8%）· OUTLINE_PRECISION 0.001；d3p 用的是前者',
    PATH_PRECISION === 0.05 && OUTLINE_PRECISION === 0.001 && Math.abs(makeProjection('robinson', LON0).d3.precision() - PATH_PRECISION) < 1e-12)
  ok('⑬ 等距圆柱不走 d3：spherePath 为 null（与 path 同款）', makeProjection('equirect', LON0).spherePath === null)
  // 被切口截断的陆地边：格陵兰（12°W~73°W）在出厂切口 30°W 上被切成两半，人工边沿图廓走。
  // 它是地物那份实例画的，弦高按 PATH_PRECISION；出厂精度下这条边与细图廓之间会露出 ≤ 0.4 单位的海色月牙。
  {
    const topo = JSON.parse(readFileSync(join(ROOT, 'src/viz/globe3d/data/basemap-50m.json'), 'utf8'))
    const grl = feature(topo, topo.objects.units).features.find((f) => f.properties && f.properties.u === 'GRL')
    const wrapd = (v) => ((v + 180) % 360 + 360) % 360 - 180
    const cutDev = (precision) => {
      const P = makeProjection('equalEarth', LON0)
      if (precision != null) P.d3.precision(precision)
      const r = rec(); P.path(grl, r)
      const ref = sphereAt('equalEarth', undefined, 1e-4)
      const onCut = (p) => { const b = P.invRaw(p[0], p[1]); return !!b && Math.abs(wrapd(b[0] - LON0)) < 1e-3 }
      let worst = 0, n = 0
      for (let i = 1; i < r.pts.length; i++) {
        if (r.mv[i]) continue                      // b 是下一条子路径的起点：与 a 不成段
        const a = r.pts[i - 1], b = r.pts[i]
        if (!onCut(a) || !onCut(b)) continue
        n++; worst = Math.max(worst, maxDev([[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]], ref))
      }
      return { n, worst }
    }
    const now = cutDev(null), old = cutDev(Math.SQRT1_2)
    ok('⑬ 格陵兰被切口截断的边：弦中点离图廓 ≤ PATH_PRECISION', !!grl && now.n > 0 && now.worst <= PATH_PRECISION * 1.05, now.n + ' 段 · 最坏 ' + now.worst.toFixed(4))
    ok('⑬ 反证：同一条边在出厂精度下弦高 > 0.15 单位（6 px/° 下 ≥ 1 px 的月牙）', old.n > 0 && old.worst > 0.15, old.n + ' 段 · 最坏 ' + old.worst.toFixed(3))
  }
  // 接线：flatCoverage 的图廓（描边 / 海色填充 / 影像 clip / 垫底）一律走 spherePath，不再拿地物那份 path 画 Sphere
  {
    const src = lf(readFileSync(join(ROOT, 'src/viz/flatmap/flatCoverage.js'), 'utf8'))
    const n = (src.match(/PJ\.spherePath\(/g) || []).length
    ok('⑬ 接线：flatCoverage 图廓四处都是 PJ.spherePath、无 PJ.path(Sphere)', n >= 4 && !/PJ\.path\(\{ type: 'Sphere' \}/.test(src), n + ' 处')
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
