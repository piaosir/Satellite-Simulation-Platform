// 链路预算地理图的世界地图底图（50m 分辨率，海陆面 / 岸线 / 国界三层分开）。
//
// 用途与星座 3D / 覆盖平面图不同：那两处地图是主角，这里地图是**参照系**——主角是叠在
// 上面的场（余量、雨衰、降雨率……）。但参照系失真等于结论失真：读者要判断的是「这条链路
// 搬到哪儿还成立」，答案必须落到具体的海岸、具体的国境上。故底图从简，但不从粗：
//
//   · 取 50m（Natural Earth 中比例尺，241 个国家/地区）。曾用 110m，那份数据的岸线在
//     半岛与岛链上已经是几条折线（日本列岛糊成一团、地中海东岸缺一块），链路预算
//     常看的窗口只有几十度宽，糊在哪儿一眼就看得出。50m 的点数是 110m 的 9 倍，
//     代价由下面的「按视图抽稀 + 小要素剔除」抵掉：抽稀后的点数只跟**屏幕上画多长**
//     有关，与数据源的精细度无关，缩到整幅世界地图时的开销与 110m 同量级；
//   · 岸线与国界分成两层、分别配色。合在一起时国界与岸线一样粗一样色，读者分不清
//     一条线是「这里是海」还是「这里换了个国家」——而这两件事在链路预算里的分量
//     完全不同（前者关落址，后者关频率协调与准入）；
//   · 陆地用统一浅色而非莫兰迪杂色——杂色会与场的色标抢注意力，读者分不清一块颜色
//     是「这里雨大」还是「这里是巴西」。
//
// 岸线不另取 topojson.mesh(land)：陆地面的环本身就是岸线（含内环，故里海、五大湖的
// 轮廓自然带上），同一份投影结果填一次、描一次即可，省掉一整份等量的点。
//
// 投影：等经纬（Plate Carrée），即 x=经度、y=纬度线性映射——与扫描网格的两根轴天然同构，
// 不需要任何投影变换，经纬度自然对得上格点。故本模块不收投影函数，只收「视图经纬范围 +
// 目标像素矩形」，映射在内部按两次乘加做完：逐点调一个返回新数组的闭包，十万个点就是
// 十万次分配，那才是 50m 真正贵的地方。
//
// 配色取自地图设置的同一套色板（见 viz/landPalette.js 与星座 3D 的「大海颜色」）：
// 海 #a3ccff、陆 #e4eccf，与主界面地图是一个视觉家族。

import { LAND_UNIFORMS } from '../viz/landPalette.js'

// 海 = 星座3D「大海颜色」色板的最后一格（当前默认）；陆 = 「大地颜色」统一色首格
export const OCEAN = '#a3ccff'
export const LAND = LAND_UNIFORMS[0]      // '#e4eccf'
// ——— 地物线：两套，按「线压在什么底上」分，不是按图分 ———
//
// 两处的底完全不同，最优可读色必然也不同，硬统一成一个色值只会有一处看不见。
// 统一的是**设计意图**：地物线一律细、一律退后、一律中性灰，谁都不与该图的主角抢。
//
// ① 压在 Turbo 场上（地理场图）：**纯色细线，不带任何衬底**，色按主题分两套。
//    衬底（casing）走过一整轮：先是浅线芯 + 暗衬底，再是等值线深墨 + 白衬底去压过它——
//    每条线都镶着一圈相反色的边，三四百像素宽的图上就是「信息全堆在一起」（用户原话）。
//    结论：线要退后，靠的是**少给墨**，不是靠再加一层边去撑。
//    早先取中段明度的中性灰（92,100,108 / 半透明）：那是「满饱和 Turbo 铺满全图」时唯一
//    站得住的折中——但折中也救不了。半透明的线，其上屏明度是「线色与底色按 α 的插值」，
//    底色的明度一路从深紫 0.29 走到亮黄绿 0.86，途中**必然**有一档正好等于插值后的线色：
//    那一档上线与底同明度，整条线在那一段凭空消失。实测最难压的那一段，明度差岸线 0.001、
//    国界 0.000——不是「淡」，是真没有（用户原话「现在国界看不清」）。
//    这条教训是「单一中间色压不住宽明度域的底」，它管着后来两代取色：
//      · 第一代（满饱和 Turbo + 主次分配，见 lbColorScale 的 FOCUS）取**近白**：占大多数
//        面积的主区被收进一档安静的中明度带、只有热点区仍是浓色，底色的明度不再从深紫一路
//        窜到亮黄绿，近白于是不再有交叉点（实测最难压的那段明度差岸线 0.174 / 国界 0.143）；
//      · 第二代（场整层再软化一道，见 lbColorScale 的 SOFT）反过来取**深墨**：亮底上场的
//        明度被抬到 0.49~0.87，白线到这儿只剩 0.107 的落差，等于又回到「淡到看不清」；
//        深墨（38,44,51）与它的落差反倒有 0.150 的下限，而主区（占大半幅图）上高达 0.45。
//        暗底不跟着换：暗底的软化是**沉下去**（场落到 0.24~0.61），白线在那儿落差 0.28~0.35，
//        原样最好。两处的底不同，最优可读色必然不同，硬统一成一个色值必有一处看不见。
//        深墨还捡回了第一代唯一弱的那处：「算不出的格」露出浅色的海陆底图，白线在上面发飘，
//        深墨在浅底上照旧读得清。
//      · ★第三代（2026-07-26，用户仍报「地图可读性还是低 · 地理参照太淡」）落到**不透明 +
//        设备像素下限**。前两代都在挑「什么色值压得住」，可实测下来真正的病根不在色值，
//        在**上屏那几个像素的覆盖率**：dpr=1 时 0.6~0.75 CSS px 的线宽不足一个设备像素，
//        抗锯齿把它摊到相邻两行，再乘上 0.62~0.80 的 α——线层像素的平均合成 α 只有 0.30
//        （实测 9980 个线像素：91% 不足 0.6，只有 1% 到得了 0.8）。也就是说前两代按色值
//        算出来的那些「明度差 0.150」，读者实际看到的还要再打三折。**α 与线宽是同一笔账里
//        的两个因子，只调色值调不动它。** 改法两条，一分墨也不多给、衬底照旧没有：
//          ① α 拉到不透明一档（岸线 1.0 / 国界 0.85）——半透明本是为了「退后」，可退后
//             该由「细」和「无彩」承担，靠 α 退后等于把可读性也一起退掉；
//          ② 线宽给一个**设备像素下限**（见 MAP_LW 的 min），dpr=1 补到 1.2/1.0 设备像素，
//             dpr≥2 那一项本就够宽、原样不动。**CSS 宽度一个字没改**，故 3D 球那边按 CSS
//             宽反推的 texel 数不必跟着算（见下 ② 段）。
//        实测（dpr=1，同一幅偏态余量场）：线像素的平均合成 α 0.30 → 0.50、上得了线芯的
//        像素（α≥0.55）860 → 6378 个、线芯与底的明度差均值 0.355 → 0.433。
//        **下次再听到「太淡」，先量这两个数（平均合成 α + 线芯像素数），别再换色值。**
//    地理参照与数据的分野仍由**颜色语言**承担：地物线一律无彩（这一支近黑的中性冷灰 /
//    暗底的白），等值线一律取它那一档的色相（见 lbColorScale 的 shiftInk）。无彩的都是
//    地图，带颜色的都是数据——亮底上两者于是都偏深，分野靠有彩无彩，不靠明暗。
export const MAP_COAST = { light: 'rgba(38,44,51,1)', dark: 'rgba(255,255,255,1)' }      // 岸线：海陆交界，最要紧的一条地物
export const MAP_BORDER = { light: 'rgba(38,44,51,0.85)', dark: 'rgba(255,255,255,0.8)' } // 国界：同一支墨淡一档，退到岸线之后
// 线宽两个数：w = CSS 像素宽（图在屏上/纸上「有多粗」由它定，与 3D 球共用的就是这个数），
// min = 设备像素下限（只在 dpr=1 这种一个 CSS 像素只有一个设备像素的机器上才咬得住，
// 把抗锯齿摊掉的那一半覆盖率补回来）。取 max(min, w·k·dpr)：出图 4 倍时后者远大于前者，
// 下限自动让位，不会把报告里的线撑粗。
export const MAP_LW = {
  coast: { w: 0.75, min: 1.2 },
  border: { w: 0.6, min: 1.0 }
}
// 地物线的浓淡档（界面上的「地图」一项）：只缩放 α 与线宽，**不换色相**——无彩这条分野
// 不能因为浓淡而动摇。α 乘完夹在 [0.35, 1]：再淡下去就回到「看不清」，那正是这一档要治的病。
export function scaleInk(css, k) {
  if (!(k > 0) || Math.abs(k - 1) < 1e-9) return css
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(String(css).trim())
  if (!m) return css
  const a = m[4] === undefined ? 1 : parseFloat(m[4])
  return `rgba(${m[1]},${m[2]},${m[3]},${Math.max(0.35, Math.min(1, a * k)).toFixed(3)})`
}
//
// ② 压在球面舞台上（3D 链路视图）：底是浅海蓝 + 浅陆黄绿，**浅线在那里等于没画**，
//    故线仍是深一档的灰（球面底色统一，不像 Turbo 那样从深紫走到亮黄，一个色值就够）。
//    与 ① 统一的不是色值——底不同，最优可读色必然不同，硬统一必有一处看不见——
//    统一的是取色家族（同一族中性冷灰）、层级（岸线深于国界，两者都退后）与上屏线宽
//    （见 linkGlobe 的 earthTexture：texel 数按「落到屏幕上有多粗」反推，与这边同值）。
export const COAST = '#5c646c'
export const BORDER = '#8b939b'
// 底图整体洗淡一道（场铺上去之前）：满饱和的海陆会与场的色标抢注意力。
// 底图只在「算不出的格」那里露脸（场层不透底，见 LbSurfacePlot.paintField），故这一道洗
// 实际调的是**留白区**的分量。刻度由场定：场软化之后彩度只剩 0.03~0.09（见 lbColorScale
// 的 SOFT），原先只洗 0.15 的海蓝彩度 0.071 就与场的热点齐平了——没有数据的那片反倒和
// 数据一样响。洗到 0.30（海 0.058 / 陆 0.028）刚好退到场之后，又还认得出海陆。
// 洗过头则是另一头的坑：留白区会看着像一块脏斑，而那里恰恰要读者看清「这是哪儿」。
export const WASH = { light: 'rgba(255,255,255,0.30)', dark: 'rgba(0,0,0,0.34)' }

let _map = null
let _loading = null

/**
 * 懒加载 50m 世界地图（首次调用才拉数据，图表区没打开就不占内存）。
 * @returns Promise<{ land: Array<Path>, borders: Array<Path> }>
 *   land    陆地面的环（闭合）：填海陆色 + 描岸线，两用
 *   borders 国界（开口折线）：只取国与国之间真正共享的那些弧，不含海岸段——
 *           直接描每个国家的整圈轮廓会把沿海国的岸线又描一遍，粗一倍且色不对
 */
export function loadBasemap() {
  if (_map) return Promise.resolve(_map)
  if (_loading) return _loading
  _loading = Promise.all([
    import('topojson-client'),
    import('../viz/globe3d/data/countries-50m.json')
  ]).then(([tj, mod]) => {
    const topo = mod.default || mod
    _map = {
      land: preparePaths(tj.feature(topo, topo.objects.land)),
      borders: preparePaths(tj.mesh(topo, topo.objects.countries, (a, b) => a !== b))
    }
    return _map
  }).catch(() => {
    _map = { land: [], borders: [] }      // 拿不到就不画底图，图照出（场才是主角）
    return _map
  })
  return _loading
}

// —— 载入期的一次性预处理 ——
// 解缠与包围盒与视图无关，逐帧重算纯属浪费；点也一并压进 Float64Array，
// 逐帧遍历十万个点时 [lon,lat] 数组的指针跳转就是纯开销。

/**
 * 一条环/折线 → { buf, lo, hi, la, ha }
 * 经度解缠：相邻点跨过 ±180 时整体加减 360，否则横贯太平洋的国家（俄罗斯、斐济）
 * 会被画成一条横贯全图的假色带。
 */
function prepPath(pts) {
  const n = pts && pts.length
  if (!(n >= 2)) return null
  const buf = new Float64Array(n * 2)
  let prev = pts[0][0]
  let lo = prev, hi = prev, la = pts[0][1], ha = la
  buf[0] = prev; buf[1] = pts[0][1]
  for (let i = 1; i < n; i++) {
    let lon = pts[i][0]
    while (lon - prev > 180) lon -= 360
    while (prev - lon > 180) lon += 360
    const lat = pts[i][1]
    buf[i * 2] = lon; buf[i * 2 + 1] = lat
    if (lon < lo) lo = lon; else if (lon > hi) hi = lon
    if (lat < la) la = lat; else if (lat > ha) ha = lat
    prev = lon
  }
  return { buf, lo, hi, la, ha }
}

/**
 * GeoJSON（Feature / FeatureCollection / 裸几何）→ 绘制用的路径清单（解缠 + 包围盒 + 压平）。
 * @returns Array<{ buf, lo, hi, la, ha }>
 */
export function preparePaths(g, out) {
  const acc = out || []
  if (!g) return acc
  if (g.type === 'FeatureCollection') { for (const f of g.features) preparePaths(f, acc); return acc }
  if (g.type === 'Feature') return preparePaths(g.geometry, acc)
  const push = (pts) => { const p = prepPath(pts); if (p) acc.push(p) }
  switch (g.type) {
    case 'Polygon': for (const r of g.coordinates) push(r); break
    case 'MultiPolygon': for (const poly of g.coordinates) for (const r of poly) push(r); break
    case 'LineString': push(g.coordinates); break
    case 'MultiLineString': for (const l of g.coordinates) push(l); break
    case 'GeometryCollection': for (const s of g.geometries) preparePaths(s, acc); break
  }
  return acc
}

/**
 * 生成绘制用的路径（像素坐标）。
 *
 * 只吐落进视图的路径，并按 ±360 的整周偏移各补一份——视图跨 ±180 时对岸的陆地才不会缺一块。
 * 两道**按视图**的简化（这是 50m 用得起的原因，也是它比 110m 好看的原因：
 * 简化程度跟着缩放走，缩到整幅时抽得狠，放大到一国时一点不抽）：
 *   minPx   相邻点在屏幕上不足这么多像素就并掉。剩下的点数只与「屏幕上这条线有多长」
 *           有关，与数据源精细度无关；
 *   minSize 整条路径的包围盒不足这么大就整条丢掉。50m 里近千个环是礁与小岛，
 *           缩到整幅世界地图时它们各自不足一个像素，画出来只是沿岸一圈噪点。
 *
 * @param {Array} items  loadBasemap() 结果里的 land 或 borders
 * @param {object} view  { lon0, lon1, lat0, lat1 } 视图经纬度范围（lon0<lon1, lat0<lat1）
 * @param {object} size  { w, h } 目标像素矩形（视图铺满它）
 * @param {object} [opt] { minPx, minSize } 单位同 size
 * @returns Array<Float64Array>  每条一串 [x0,y0,x1,y1,...]
 */
export function basemapPaths(items, view, size, opt) {
  const out = []
  if (!items || !items.length) return out
  const { lon0, lon1, lat0, lat1 } = view
  const W = size.w, H = size.h
  const dLon = lon1 - lon0, dLat = lat1 - lat0
  if (!(dLon > 0) || !(dLat > 0) || !(W > 0) || !(H > 0)) return out
  // 像素 = 经纬的两次乘加（等经纬投影就是线性的，没有别的花样）
  const kx = W / dLon, ky = H / dLat
  const ox = -lon0 * kx, oy = H + lat0 * ky
  const minPx = (opt && opt.minPx) || 0
  const minSize = (opt && opt.minSize) || 0
  // 视图跨了几个整周就补几份（常规视图只需 0；跨 ±180 时需要 −360 那一份）
  const shifts = []
  for (let s = Math.floor((lon0 + 180) / 360) * 360 - 360; s <= lon1 + 180; s += 360) shifts.push(s)
  if (!shifts.length) shifts.push(0)

  for (const it of items) {
    if (it.ha < lat0 || it.la > lat1) continue                 // 纬度上完全在视图外
    // 小要素剔除只看尺寸，与在不在视图内无关，故提到 shift 循环外算一次
    if (minSize > 0 && (it.hi - it.lo) * kx < minSize && (it.ha - it.la) * ky < minSize) continue
    for (const s of shifts) {
      if (it.hi + s < lon0 || it.lo + s > lon1) continue        // 该周期的经度不在视图内
      const src = it.buf, n = src.length >> 1
      const dst = new Float64Array(src.length)
      let m = 0, px = 0, py = 0
      for (let i = 0; i < n; i++) {
        const x = (src[i * 2] + s) * kx + ox
        const y = oy - src[i * 2 + 1] * ky
        // 末点必须保留：闭合环靠它接回起点，开口线靠它顶到边界
        if (m && i < n - 1 && Math.abs(x - px) + Math.abs(y - py) < minPx) continue
        dst[m * 2] = x; dst[m * 2 + 1] = y
        px = x; py = y; m++
      }
      if (m < 2) continue
      out.push(m * 2 === dst.length ? dst : dst.subarray(0, m * 2))
    }
  }
  return out
}
