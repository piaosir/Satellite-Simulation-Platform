// 2D 投影层的不变量（src/viz/geo/projection.js）。运行：npm test
//
// 五档：等距圆柱（出厂）/ Mercator / Equal Earth / Robinson / Albers。
// 这一层错了的症状都不是「报错」，而是「图看着有点怪」——地物挪了半个像素、点选读数偏了一点、
// 海陆颜色反了。故判据一律是能算的量：平面归一、正逆算往返、绕向、切口、以及接线检查。
//
// ★ 出厂档【不走 d3】：它是全平台的默认，也是 mapGeometry.test.mjs ① 段钉死的那一套坐标。
//   这里逐点验它与 (lon−lon0, 90−lat) 逐位相同 —— 只要这条绿着，换投影这件事就动不到默认档。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { feature } from 'topojson-client'
import { geoArea } from 'd3-geo'
import { makeProjection, PROJECTIONS, DEFAULT_PROJECTION, isProjection, MERCATOR_LAT, ALBERS_PARALLELS, lonBreaks, lonPeriod } from '../../../src/viz/geo/projection.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const LON0 = -30   // 出厂切口（画面中心 150°E）

// ---------- ① 档位表 ----------
ok('① 五档齐全且出厂档在最前', PROJECTIONS.length === 5 && PROJECTIONS[0].k === DEFAULT_PROJECTION && DEFAULT_PROJECTION === 'equirect',
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

// ---------- ⑪ 接线检查（源码级）----------
// 纯函数算得对不等于接上了。这五档的错都藏在「某一层忘了分叉」里：忘了就是那一层
// 在投影档下画在错的地方（或者干脆按等距圆柱的坐标画在图外）。
{
  const FLAT = readFileSync(join(ROOT, 'src/viz/flatmap/flatCoverage.js'), 'utf8')
  const VUE = readFileSync(join(ROOT, 'src/pages/ConstellationMap3D.vue'), 'utf8')
  const CRS = readFileSync(join(ROOT, 'src/stores/mapCrs.js'), 'utf8')
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
    !/\bPX\([^,()]*\)/.test(FLAT.replace(/const PX = \(lon, lat\)[^\n]*\n/, '')))
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
  ok('⑪ 海只填球面轮廓、另画图廓（否则铺满矩形，图廓当场没）',
    /PJ\.path\(\{ type: 'Sphere' \}/.test(FLAT) && /function drawSphereOutline/.test(FLAT) && /drawSphereOutline\(\)\n/.test(FLAT))
  ok('⑪ 栅格（影像 / 环境场）在投影档走逐像素重投影',
    /function reprojectRaster/.test(FLAT) && /reprojectRaster\(/.test(seg(FLAT, 'function drawImagery', 'function imageryPlan')) &&
    /reprojectRaster\(/.test(seg(FLAT, 'function drawEnvRaster', 'function drawFieldOverlays')))
  ok('⑪ 栅格网格走 lonBreaks（对齐切口 + 插源缝），且有「一格不许横跨半幅」的防呆',
    /lonBreaks\(L0, COARSE\)/.test(FLAT) && /while \(midLon \+ shift < S\.lonMin/.test(FLAT) && /gx1 - gx0 > PJ\.W \* 0\.5/.test(FLAT))
  ok('⑪ 瓦片档在投影档按【可见块 + 当前分辨率】现拼（固定拼整幅 L3 会比 16K / 8K 还糊）',
    /function tileRegionImage/.test(FLAT) && /function meshWindow/.test(FLAT) &&
    /reprojectRaster\(imgEl, null, true, imgSet \|\| null\)/.test(FLAT) && /function releaseTileRegion/.test(FLAT) &&
    /Math\.log2\(0\.5625 \* Math\.max\(1e-6, pxPerDeg\)\)/.test(FLAT))
  ok('⑪ 换投影与换切口都作废同一批缓存并整份重烘',
    (FLAT.match(/gridPath = null; gridKey = ''; sphPath = null; sphKey = ''/g) || []).length === 2 &&
    /setProjection\(kind\)/.test(FLAT) && /PJ = makeProjection\(PJ\.kind, LON0\)/.test(FLAT))
  ok('⑪ 档位存在 mapCrs 里（跟着存档走）', /proj: DEFAULT_PROJECTION/.test(CRS) && /isProjection\(patch\.proj\)/.test(CRS))
  ok('⑪ 侧栏有「2D 投影」一节且挂在影像底图之后',
    VUE.indexOf("isSecOpen('geo-img'") < VUE.indexOf("isSecOpen('geo-proj'") &&
    VUE.indexOf("isSecOpen('geo-proj'") < VUE.indexOf("isSecOpen('geo-ocean'") &&
    /setMapProj\(\$event\.target\.value\)/.test(VUE))
  ok('⑪ 挂载时把档位推给 2D（否则存档恢复后按出厂档画）',
    /flat\.setProjection\(mapCrs\.proj\)/.test(VUE) && (VUE.match(/flat\.setProjection\(/g) || []).length >= 3)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
