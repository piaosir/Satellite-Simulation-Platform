// 折线的两件公共几何：经纬面加密 densifyLonLat + 2D 接缝断点 seamCrossing。
// 2D 平面图（flatmap/flatCoverage.js）与 3D 球体（globe3d/scene.js）共用这一份。
//
// ── densifyLonLat：为什么加密要在【经纬度平面】里做 ─────────────────────────
// 2D 是等距圆柱下的直线，即经纬线性插值；3D 连的是大圆。同一对端点在两个视图里长成两个样子：
// 沿纬线定义的行政边界最明显 —— 加拿大 60°N 从 −139.06° 到 −120° 那一段（19°），3D 的大圆
// 会在中间北凸 38 km，而 2D 是笔直贴着纬线。顶点一疏，两个视图对不上。
// 故口径是：先在经纬度平面加密到 ≤ maxDeg，两个视图的走向就一致了；3D 那边再补一次
// densifyArc（对 ≤1° 的段是 no-op）只为长弦不沉进球面。islandChains.js 早已按这个口径做，
// 这里把它抽出来共用。
//
// 直弦沉球的门槛（抬高 1.0005 R 时）：1 − cos(d/2) > 5e−4 → d > 3.62°。加拿大 60°N 那一段 19°，
// 中点沉到陆地面之下 84.7 km，3D 上看就是「省界中间断掉」。加密到 ≤ 1° 后弦垂 0.24 km，
// 只有抬高量 3.19 km 的十分之一 —— 线稳稳浮在陆地面之上，不必再补大圆。
//
// ── seamCrossing：2D 的接缝 ────────────────────────────────────────────────
// 平面图的世界度坐标 x = WXN(lon) ∈ [0, 360)，接缝在 x=0 / x=360 两条边上。跨缝的那一段
// 原先整段丢掉（stroke + beginPath，两端都不画到边），留一个缺口 —— 聚焦星覆盖圈 72 点、
// 5° 一段就缺 5°，航迹稀疏航点能缺几十度。本函数给出「出边点 + 入边点」，让调用方把一段
// 拆成缝两侧的两段接上。3D 没有接缝，不用。
//
// ★ 这两个都是热路径上的纯函数：静态层每次重建要走一遍 CHN adm2 的 4.5 万段，
//   故 seamCrossing 复用一个模块级对象、不分配（调用方当场读完即可）。

// 就近解缠 + 线性插值到相邻间距 ≤ maxDeg + 末尾折回 [−180, 180)。
// 入参 pts = [[lon, lat], …]（≥1 点）。端点原样保留，只在中间插值。
// 纬度不折回：本平台的折线不过极点，lat 恒在 [−90, 90]。
//
// ★ 已经够密的原样返回（不复制）—— 五类边界线每次重建要走 10m 档的 48 万个点，而那份数据
//   本来就密（basemap 三档沿纬线超 2° 的段：10m 0 条、50m 6 条、110m 42 条），逐点新建
//   [lon,lat] 等于凭空多出几十万个临时对象。真需要加密的是行政区包（AUS 单段 16.8°、
//   CAN 11.0°、USA 5.9°），那几份小得多。返回的数组调用方不许改。
export function densifyLonLat(pts, maxDeg = 1) {
  if (!pts || pts.length < 2) return pts
  const step = maxDeg > 0 ? maxDeg : 1
  let need = false
  for (let i = 1, px = pts[0][0]; i < pts.length; i++) {
    let x1 = pts[i][0]
    while (x1 - px > 180) x1 -= 360
    while (x1 - px < -180) x1 += 360
    if (Math.hypot(x1 - px, pts[i][1] - pts[i - 1][1]) > step) { need = true; break }
    px = x1
  }
  if (!need) return pts
  const wrap = (lo) => ((lo + 180) % 360 + 360) % 360 - 180
  const out = [[wrap(pts[0][0]), pts[0][1]]]
  let prev = pts[0][0]
  for (let i = 1; i < pts.length; i++) {
    // 解缠到与前一点相邻的那个窗口，否则跨 ±180 的一段会被插成横贯全图的假线
    let x1 = pts[i][0]
    while (x1 - prev > 180) x1 -= 360
    while (x1 - prev < -180) x1 += 360
    const y0 = pts[i - 1][1], y1 = pts[i][1]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - prev, y1 - y0) / step))
    for (let j = 1; j <= n; j++) out.push([wrap(prev + (x1 - prev) * j / n), y0 + (y1 - y0) * j / n])
    prev = x1
  }
  return out
}

// 2D 世界度坐标下的接缝断点。(pwx, pwy) → (wx, wy)，wx/pwx ∈ [0, 360)，
// 调用方已判定 |wx − pwx| > 180（即这一段跨缝）。
// 返回 { xOut, xIn, y }：从 xOut 出图、在 xIn 进图，两处纵坐标同为 y（缝上的插值纬度）。
//   · wx 比 pwx 大 180 以上 → 实际是往西走出了左边缘：xOut = 0、xIn = 360
//   · wx 比 pwx 小 180 以上 → 往东走出了右边缘：xOut = 360、xIn = 0
// ★ 复用同一个对象，调用方必须当场用掉（热路径，见文件头）。
const _seam = { xOut: 0, xIn: 0, y: 0 }
export function seamCrossing(pwx, pwy, wx, wy) {
  // 解缠到 |wx′ − pwx| ≤ 180 的那个窗口；xOut 必落在 pwx 与 wx′ 之间，故 t ∈ [0, 1]
  const wxu = wx > pwx ? wx - 360 : wx + 360
  const xOut = wxu < 0 ? 0 : 360
  const t = (xOut - pwx) / (wxu - pwx)
  _seam.xOut = xOut
  _seam.xIn = 360 - xOut
  _seam.y = pwy + t * (wy - pwy)
  return _seam
}
