// 2D 平面图的投影层 —— 「世界平面」的定义就在这里。
//
// ── 为什么能插得进来 ────────────────────────────────────────────────────────
// flatCoverage 的一切矢量层都烘成【世界平面坐标】的 Path2D，逐帧只用 setTransform 做平移缩放。
// 于是任何【固定中心】的投影都能沿用这套设计：换投影时按新平面重烘一次（setLon0 早就是这条通路
// —— 换切口就整份重烘），之后平移缩放仍是仿射。本模块只负责「经纬 ⇄ 世界平面」这一层。
//
// ── 平面约定（与换投影前逐字一致）──────────────────────────────────────────
//   x ∈ [0, W]，x=0 在切口 lon0（画面左边缘）；y ∈ [0, H]，y 向南增大。
//   W 恒为 360 —— 与等距圆柱同单位，故线宽 / 虚线周期 / 字号那一整套按 k() 折算的常数不用动。
//   H 随投影变（等距圆柱 180、Mercator 358.9、Equal Earth 175.2、Robinson 182.6、Albers 221.4）。
//
// ── 等距圆柱【不走 d3】────────────────────────────────────────────────────
// 它就是 (lon − lon0, 90 − lat)，是全平台的出厂档，也是 mapGeometry.test.mjs ① 段钉死的那一套。
// 这里给它一条原生实现、与换投影前逐位相同，四个新投影才走 d3 —— 默认档一个字节都不许变。
//
// ── 为什么投影数学用 d3-geo 而不是手搓 ─────────────────────────────────────
// 正算好写，【逆算】才是出错的地方（Equal Earth 与 Robinson 的反解都要迭代），而 2D 的点选、
// 悬停读数、拖标记全靠逆算。d3-geo（MIT）是这一档的通用实现，且 geoPath 顺带给出
// 日界线切割与自适应加密 —— 那两件手搓的代价远高于引一个 35 KB 的包。
//   d3-geo：Mercator / Equal Earth / Albers(圆锥等积) / 方位等距   d3-geo-projection：Robinson
import { geoPath, geoMercator, geoEqualEarth, geoConicEqualArea, geoAzimuthalEquidistant, geoGraticule } from 'd3-geo'
import { geoRobinson } from 'd3-geo-projection'

// 下拉里的顺序与名字。出厂第一档＝等距圆柱（换投影前的那一套）。
// ★ zh / en 两栏都要是【本语言的】名字，不能中英混杂 —— 界面按平台语言档取其一（byLang）。
//   中文用测绘学通行译名；英文用投影的通用英文名。
export const PROJECTIONS = [
  { k: 'equirect', zh: '等距圆柱', en: 'Equirectangular' },
  { k: 'mercator', zh: '墨卡托', en: 'Mercator' },
  { k: 'equalEarth', zh: '等积地球', en: 'Equal Earth' },
  { k: 'robinson', zh: '罗宾逊', en: 'Robinson' },
  { k: 'albers', zh: '阿尔伯斯', en: 'Albers' },
  { k: 'azeq', zh: '方位等距', en: 'Azimuthal Equidistant' }
]
export const DEFAULT_PROJECTION = 'equirect'
export const isProjection = (k) => PROJECTIONS.some((p) => p.k === k)
export const projZh = (k) => (PROJECTIONS.find((p) => p.k === k) || PROJECTIONS[0]).zh

// Albers 是【区域】投影，标准纬线定了才有意义。取中国全图的惯用值（25°N / 47°N）；
// 中央经线跟随「画面中心」，故把画面中心设成 105°E 即得报告里那张常规中国全图。
export const ALBERS_PARALLELS = [25, 47]

// ── 逐投影【可调参数】：面板据此决定摆哪几个控件 ─────────────────────────────
//   lat0 = 投影中心纬度（与「画面中心」经度合成一个中心点）。只有方位投影认它 ——
//     圆柱 / 伪圆柱 / 圆锥档给非零中心纬度就成了斜轴投影，那不是这几档的常规用法，
//     故在 makeProjection 里按档过滤掉，UI 也不摆这个控件。
//   par1 / par2 = 圆锥的两条标准纬线。这是 Albers 里【唯一改得动形状】的参数。
// ★ Albers 的第四个参数「原点纬度」不在此列，不是漏了：本模块把整个地球的包围盒归一到
//   W=360 的平面，原点纬度只是整体上下平移、被归一化整个吃掉 —— 实测改成 35°N 后各点
//   落点位移 2.8e-14 平面单位（纯浮点噪声）。摆一个动了看不出效果的控件不如不摆；
//   「把某块摆到画面正中」用拖动平移即可。
export const PROJ_PARAMS = { azeq: ['lat0'], albers: ['par1', 'par2'] }
export const projParams = (k) => PROJ_PARAMS[k] || []

// ── d3 自适应加密的弦高上限（平面单位；本平面 1 单位 ≈ 1°）──────────────────────
// d3 出厂 √0.5 ≈ 0.707 是按「输出即屏幕像素」设的；而本平面归一到 W=360，屏上一单位是 k 个像素
// （全图 2~3、常用 20~50、放到头 741）。0.707 单位的折角一放大就是好几个像素 —— 2026-09-10 用户截图：
// 等积地球的图廓在 6 px/° 下弦高 3 px，整圈明显是多边形（那一圈只由 8 个控制点起算，33 段折线画完）。
// 两档分开给，别合成一个：
//  · PATH_PRECISION（地物 / 经纬网 / 覆盖带 / 被切口截断的陆地边）——d3 只对比 2×精度 长的段做中点检验，
//    10m 海岸线绝大多数段比 0.1 单位短，故 0.05 实测 10m 整份一趟 +0~8%、50m +4 ms（一次 / 换平面，
//    不是每帧），出点 +0.01%。再往细就成了「每段都检」：10m 一趟 +30~50%（+70~100 ms），星下点跟随会顿。
//  · OUTLINE_PRECISION（只画图廓，spherePath 单独一份投影实例）——0.001 单位：真实弦高 ≤ 0.002
//    （d3 只在弦中点检验，罗宾逊的样条上有中点恰好落回弦上的段，再细也停在 0.002），放到头 741 px/°
//    也不到 2 px、常用 50 px/° 下 0.1 px；点数 0.8~1.5k、生成 0.1~0.5 ms，且只在换平面时算一次。
// 判据与数字见 packages/core/test/mapProjection.test.mjs ⑬。
export const PATH_PRECISION = 0.05
export const OUTLINE_PRECISION = 0.001
// Mercator 的纬度上限：ln(tan(π/4+φ/2)) 在极点发散，Web 口径一律钳到 ±85.051129°（正好使平面成正方形）。
export const MERCATOR_LAT = 85.05112877980659

// 各投影在 scale=1 / translate=[0,0] 下的原始范围。绕极旋转（换中央经线）不改变范围，
// 故每种只需量一次、与 lon0 无关。缓存住：每次换切口都重量一遍是几十万次投影。
// ★ 方位等距的中心纬度也不改变范围（它恒是半径 180° 的圆，怎么转都是那个圆），
//   故 lat0 同样不进缓存键；而 Albers 的标准纬线改一下扇面就变了，那个必须进键。
const rawCache = new Map()
function d3Raw(kind, o) {
  if (kind === 'mercator') return geoMercator()
  if (kind === 'equalEarth') return geoEqualEarth()
  if (kind === 'robinson') return geoRobinson()
  if (kind === 'albers') return geoConicEqualArea().parallels(conicPar(o))
  // clipAngle：不裁的话 γ>180° 那一圈会绕回来在圆外画出一层镜像的地球。
  // 留 1e-3° 是 d3 自己的惯用值 —— 正好裁在对跖点上、又不至于让边界退化成一个点。
  if (kind === 'azeq') return geoAzimuthalEquidistant().clipAngle(180 - 1e-3)
  return null
}
// 两条标准纬线：给全了按给的（顺序无关，d3 只用来定圆锥常数），缺项回落中国全图那一对。
// 钳在 ±89.5°：贴到极点圆锥就退化成方位投影，d3 会给出 ±Infinity 的范围。
function conicPar(o) {
  const c = (v, d) => (Number.isFinite(v) ? Math.max(-89.5, Math.min(89.5, v)) : d)
  return [c(o && o.par1, ALBERS_PARALLELS[0]), c(o && o.par2, ALBERS_PARALLELS[1])]
}
function rawExtent(kind, o) {
  const key = kind === 'albers' ? kind + '/' + conicPar(o).join(',') : kind
  const hit = rawCache.get(key)
  if (hit) return hit
  // ★ 方位等距【不】靠采样量：对跖点是个奇异点（整条圆周对应同一个点），0.5° 的格点
  //   永远踩不到圆周上，量出来的高比宽矮 0.5 单位 —— 圆就被压成了椭圆（实测 359.50 vs 360）。
  //   它的范围是解析已知的：半径恒 = 裁切角（弧度），直接写死。
  if (kind === 'azeq') {
    // ★ 半径取 π（整整 180°）而不是 clipAngle 的 180−1e-3：clipAngle 只管【路径流】的裁剪，
    //   而 fwd 是点投影、不过流，对跖点照样给出 π。按裁切角归一的话对跖点会落到 x=−0.001，
    //   刚好探出平面盒子一点点（测试 ③ 的 x[−0.00, …] 就是它）。
    const R = Math.PI
    const r0 = { x0: -R, x1: R, y0: -R, y1: R, w: 2 * R, h: 2 * R }
    rawCache.set(key, r0)
    return r0
  }
  const p = d3Raw(kind, o).scale(1).translate([0, 0]).rotate([0, 0, 0])
  const latLim = kind === 'mercator' ? MERCATOR_LAT : 90
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  // 0.5° 的网格足够定包围盒（这几种的边界都是解析光滑曲线，没有尖刺）
  for (let lat = -latLim; lat <= latLim; lat += 0.5) {
    for (let lon = -180; lon <= 180; lon += 0.5) {
      const q = p([lon, lat])
      if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue
      if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]
      if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]
    }
  }
  const r = { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 }
  if (rawCache.size > 32) rawCache.clear()   // 标准纬线可调 → 键不再是固定的五个，攒多了整份丢掉重量（一次几十毫秒，换档才发生）
  rawCache.set(key, r)
  return r
}

const wrap180 = (v) => ((v + 180) % 360 + 360) % 360 - 180
const PLANE_W = 360   // 与等距圆柱同宽 —— 全平台按 k() 折算的常数由此不用动

/**
 * 造一个投影。kind ∈ PROJECTIONS 的 k；lon0 = 切口经度（画面左边缘），中央经线 = lon0 + 180。
 * opts = { lat0, par1, par2 }，按 PROJ_PARAMS 逐档取用（给了本档不认的项就当没给）。
 * 返回的对象是【不可变】的，换投影 / 换切口 / 换参数就重造一个。
 */
export function makeProjection(kind, lon0, opts) {
  const k = isProjection(kind) ? kind : DEFAULT_PROJECTION
  const L0 = wrap180(Number(lon0) || 0)
  const o = opts || {}
  // 中心纬度只有方位档认（见 PROJ_PARAMS 的说明）。钳在 ±90。
  const B0 = (k === 'azeq' && Number.isFinite(o.lat0)) ? Math.max(-90, Math.min(90, o.lat0)) : 0

  // ---------- 等距圆柱：原生实现，与换投影前逐位相同 ----------
  if (k === 'equirect') {
    const fwd = (lon, lat, out) => {
      const o = out || [0, 0]
      o[0] = (((lon - L0) % 360) + 360) % 360
      o[1] = 90 - lat
      return o
    }
    return {
      kind: k, lon0: L0, W: PLANE_W, H: 180,
      identity: true,          // ★ 调用方据此走「换投影前那条一行没改的老路」
      periodX: 360,            // 平面横向周期：±360 环绕副本成立
      latLim: 90,
      d3: null,
      fwd,
      fwdRaw: (lon, lat, out) => { const o = out || [0, 0]; o[0] = lon - L0; o[1] = 90 - lat; return o },   // 不折回，供已就近解缠的点列用
      // ★ x 也要卡在 [0, W]：世界矩形之外（信箱留白 / 拖出去那一截）没有经纬度，
      //   与换投影前的 screenToLonLat 逐字一致。漏掉这一条就成了「在留白里点一下也读出一个座标」。
      inv: (x, y) => {
        if (!(y >= 0 && y <= 180) || !(x >= 0 && x <= 360)) return null
        return [wrap180(x + L0), 90 - y]
      },
      path: null, spherePath: null, graticule: null
    }
  }

  // ---------- 其余投影档：d3 出数学，平面归一到 W=360 ----------
  const raw = rawExtent(k, o)
  const s = PLANE_W / raw.w
  const lam0 = L0 + 180                       // 中央经线
  // rotate 的前两项把中心点 (lam0, B0) 转到原点。B0 恒 0 的那几档退化成原来的纯绕极旋转，
  // 与加中心纬度之前逐位相同。
  // translate 让 x∈[0,W]、y∈[0,H]：raw 是 translate=[0,0] 下量的，乘 s 后整体平移。
  // ★ Mercator 的 translate 必须在 scale 之后设 —— d3 的 geoMercator 会在这两个 setter 里
  //   按当前 scale/translate 重算 clipExtent（那是它「钳到 ±85.05」的实现方式），顺序反了就钳不住。
  // 两份实例只差加密精度（见 PATH_PRECISION / OUTLINE_PRECISION 的说明）：
  // 图廓要细到放大也不见折角，地物那份细了就是每段多一次中点检验、换平面一趟慢三到五成。
  const build = (precision) => d3Raw(k, o).scale(s).rotate([-lam0, -B0, 0]).translate([-raw.x0 * s, -raw.y0 * s]).precision(precision)
  const d3p = build(PATH_PRECISION)
  const d3s = build(OUTLINE_PRECISION)
  const H = raw.h * s
  const latLim = k === 'mercator' ? MERCATOR_LAT : 90

  // 平面点钳回图幅内。方位等距是解析的圆（半径恒 W/2）；别的档没有解析边界，恒等返回。
  const clampPlane = k === 'azeq'
    ? (x, y) => {
      const cx = PLANE_W / 2, cy = H / 2, R = PLANE_W / 2
      const ux = x - cx, uy = y - cy, r = Math.hypot(ux, uy)
      if (!(r > R) || r === 0) return [x, y]
      const t = R * (1 - 1e-9) / r
      return [cx + ux * t, cy + uy * t]
    }
    : (x, y) => [x, y]

  const fwd = (lon, lat, out) => {
    const o = out || [0, 0]
    const la = lat > latLim ? latLim : (lat < -latLim ? -latLim : lat)
    const q = d3p([lon, la])
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) { o[0] = NaN; o[1] = NaN; return o }
    o[0] = q[0]; o[1] = q[1]
    // ★ 方位等距在【对跖点】上是解析奇点：d3 的 k = c/sin(c) 在 c→π 时爆到 1e16 —— 不是 NaN，
    //   是个天文数字，拿它当平面坐标会把这个图元甩到天边（实测把格心偏差算成 92 亿平面单位）。
    //   钳回圆周上：那正是它的极限位置，且此后一切按平面算的东西都有界。
    if (k === 'azeq' && (o[0] - PLANE_W / 2) ** 2 + (o[1] - H / 2) ** 2 > (PLANE_W / 2) ** 2) {
      const c = clampPlane(o[0], o[1]); o[0] = c[0]; o[1] = c[1]
    }
    return o
  }
  // 逆算：d3 的 invert 对平面外的点也会给一个值，故回代校验（越界处点选该返回 null，
  // 否则在信箱留白里点一下也会读出一个经纬度）。容差按【一个平面单位】给 —— 平面宽 360 单位，
  // 屏上一个像素远小于 1 单位，故这个容差挡不住任何真实点选。
  const inv = (x, y) => {
    if (!d3p.invert) return null
    const b = d3p.invert([x, y])
    if (!b || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) return null
    if (!(b[1] >= -90.0001 && b[1] <= 90.0001)) return null
    const q = d3p([b[0], b[1]])
    if (!q || Math.abs(q[0] - x) > 1e-3 || Math.abs(q[1] - y) > 1e-3) return null
    return [wrap180(b[0]), Math.max(-90, Math.min(90, b[1]))]
  }

  return {
    kind: k, lon0: L0, W: PLANE_W, H,
    lat0: B0, par: conicPar(o),   // 回读用：调用方拿它拼缓存键（形状变了缓存就该作废）
    identity: false,
    periodX: 0,               // ★ 非圆柱平面不横向重复：±360 副本不成立，跨日界线要【切】不是【接】
    latLim,
    d3: d3p,
    fwd,
    fwdRaw: fwd,
    inv,
    // 不校验的逆算：栅格重投影的节点会落在球面之外（图廓那一圈），
    // 那里需要的是一个【平滑外推值】而不是 null —— 否则边缘格算不出仿射、图廓成锯齿。
    // 真正的边界由「裁到 Sphere 轮廓」保证，不靠这里。
    invRaw: (x, y) => {
      if (!d3p.invert) return null
      const b = d3p.invert([x, y])
      return (b && Number.isFinite(b[0]) && Number.isFinite(b[1])) ? b : null
    },
    // 每条纬线是否「x 关于经度仿射、y 只由纬度定」—— 圆柱与伪圆柱都是（x = A(φ)·λ），
    // 于是栅格重投影可以按【整行】一次仿射拉伸；圆锥（Albers）的纬线是圆弧、方位等距的
    // 纬线在斜轴下连闭合曲线都不是，两者都不成立。
    rowAffine: k !== 'albers' && k !== 'azeq',
    // 栅格重投影的网格建在【平面】那一侧、靠逆算求经纬（见 planCellsInv），而不是常规的
    // 「经纬网格 + 正算」。只有方位等距要这一条，理由是它的对跖点是个奇点：
    //   正算方向 —— 切向尺度因子 = γ/sin γ，γ=179° 处一格被拉长 137 倍，切到上限还差着
    //   十万个像素（测试 ⑫ 逮到的就是这个）；
    //   反算方向 —— 圆周附近所有平面点的球面位置都挤在对跖点周围一小片，反倒是最温和的一带。
    invGrid: k === 'azeq',
    // 平面点在不在图幅内。方位等距是解析的圆（半径恒 W/2），别的档用不到这一条（恒真）：
    // 它们的图幅边界不是解析式，那一档由「裁到 Sphere 轮廓」保证。
    inPlane: k === 'azeq'
      ? (x, y) => ((x - PLANE_W / 2) ** 2 + (y - H / 2) ** 2) <= (PLANE_W / 2) ** 2
      : () => true,
    // 把一个平面点【钳到图幅内】（圆外的沿径向拉回圆周内侧一丝）。
    // 反向网格靠它处理跨边界的格：整格丢掉的话沿圆周一圈会各缺一格 —— 实测吃掉 12.5% 的面积，
    // 而钳过之后那一格只是变了形，四角与其源坐标仍一一对应，仿射照样成立。
    clampPlane,
    // GeoJSON → 目标（Path2D 或任何有 moveTo/lineTo/closePath 的录制对象）。
    // d3 的 geoPath 顺带做了两件手搓代价很高的事：日界线切割（多边形被正确切成两半而不是横扫全图）
    // 与自适应加密（长段按投影曲率补点，不必先 densifyLonLat）。
    path: (geo, target) => { geoPath(d3p, target)(geo); return target },
    // 图廓（地球在这张平面上的外轮廓）单独一条出口，走细精度那份实例。
    // ★ 别拿 path({type:'Sphere'}) 画图廓：那份实例的精度是按地物的代价定的，图廓在它那里只有几十段折线。
    spherePath: (target) => { geoPath(d3s, target)({ type: 'Sphere' }); return target },
    graticule: (step) => geoGraticule().step([step, step]).stepMinor([step, step])
  }
}

/**
 * 栅格重投影用的【经度断点】。栅格网格必须按这些断点分块，否则会出两类错：
 *
 *  ① 跨【切口 lon0】的那一格 —— 切口那条经线在平面上同时是 x=0 与 x=W，投影只能给出其中一个
 *    （实测 fwd(lon0)=0 而 fwd(lon0−ε)=W）。于是那一格两端一个在 x≈W、一个在 x=0，
 *    它的仿射把一小段源图【横拉满整幅】—— 症状是影像左右错位、一半被拉成横条。
 *    故断点从 lon0 起排，两端各让开 eps，没有哪一格跨得到它。
 *  ② 跨【源图接缝 ±180】的那一格 —— 源是未滚的等经纬位图，一格跨过 ±180 时取源矩形就断了。
 *    故把 180 在 [lon0, lon0+360) 里的位置也插成断点。
 *
 * 返回升序的断点数组，首项 lon0+eps、末项 lon0+360−eps；相邻两项即一块。
 */
export function lonBreaks(lon0, coarse = 15, eps = 1e-6) {
  const L0 = wrap180(Number(lon0) || 0)
  const out = []
  for (let l = L0; l < L0 + 360 - 1e-9; l += coarse) out.push(l)
  out.push(L0 + 360)
  const seam = L0 + ((((180 - L0) % 360) + 360) % 360)
  // ★ 接缝可能正好就是一个网格点（lon0 是 coarse 的整数倍时就是），插重了会出一个零宽的块。
  if (seam > L0 + 1e-6 && seam < L0 + 360 - 1e-6 && !out.some((v) => Math.abs(v - seam) < 1e-6)) {
    out.push(seam); out.sort((a, b) => a - b)
  }
  out[0] = L0 + eps
  out[out.length - 1] = L0 + 360 - eps
  return out
}
// ── 栅格重投影的网格密度：一块（经纬矩形）要切成几行几列 ───────────────────────────
// 判据是【几何】而不是像素数：一格拆成两个三角形做仿射拉伸，把弧当直线用的最大偏差要 ≤ tol
// （调用方按「多少个烘图像素」折算成平面单位递进来）。定在这里而不是画布那一侧，是因为它
// 只跟投影的曲率有关，与 canvas 无关 —— 也才好在 node 里直接量（见 mapProjection.test.mjs 段 ⑦）。
//
// ★ 别再改回「固定像素步长」那一档：那样圆锥（Albers）一屏要三万多个三角形，每个都是
//   save + clip + setTransform + drawImage + restore —— 「阿尔伯斯开了影像很卡」就是它；
//   而伪圆柱在深放大处反倒欠采样（实测 Robinson / Equal Earth 的格心偏差到 2.1–2.7 px）。
const CELL_MAXN = 128         // 一块最多切多少段（兜底）。只有 Mercator 贴着极点那一块会顶到

// 弓高：一段的中点，真实位置与两端连线中点之差（平面单位）。
// ★ 分三段量、取最坏的一段，不能只量整段：块内曲率并不均匀（Mercator 高纬那一头比另一头弯
//   十倍），量整块等于按平均值定步长、弯的那一头就欠采样；三段还顺带兜住奇对称项 —— y 关于
//   块心近似奇函数时（Mercator 在赤道两侧就是），整段中点的偏差恰好为零，量整段等于没量。
function sagWorst(proj, a, b, other, alongLon) {
  const p0 = [0, 0], p1 = [0, 0], pm = [0, 0]
  let worst = 0
  for (let i = 0; i < 3; i++) {
    const t0 = a + (b - a) * i / 3, t1 = a + (b - a) * (i + 1) / 3, tm = (t0 + t1) / 2
    if (alongLon) { proj.fwd(t0, other, p0); proj.fwd(t1, other, p1); proj.fwd(tm, other, pm) }
    else { proj.fwd(other, t0, p0); proj.fwd(other, t1, p1); proj.fwd(other, tm, pm) }
    if (!Number.isFinite(p0[0]) || !Number.isFinite(p1[0]) || !Number.isFinite(pm[0])) return Infinity
    const d = Math.hypot(pm[0] - (p0[0] + p1[0]) / 2, pm[1] - (p0[1] + p1[1]) / 2)
    if (d > worst) worst = d
  }
  return worst
}
// 三分之一段的弓高 → 整块切几段。弓高 ∝ 跨度² ⇒ n = 3·√(sag / tol)。
const segCount = (sag, tol) => (sag > 1e-12 ? Math.max(1, Math.min(CELL_MAXN, Math.ceil(3 * Math.sqrt(sag / tol)))) : 1)

/**
 * 一格的真实偏差（平面单位）。★ 量的是【格心】：一格拆成两个三角形、公共边是那条反对角线，
 * 格心正落在它上面 —— 那里的插值结果就是反对角线两端的中点，故这一个数就是这一对三角形的
 * 实际偏差。非做不可的理由：x = A(φ)·λ 这一族（伪圆柱）里 A 随纬度变，纯经向 / 纬向的弓高
 * 都量不到这个交叉项，只有格心量得到。
 */
export function cellError(proj, lo0, lo1, la0, la1) {
  const p1 = [0, 0], p2 = [0, 0], pm = [0, 0]
  proj.fwd(lo1, la0, p1); proj.fwd(lo0, la1, p2); proj.fwd((lo0 + lo1) / 2, (la0 + la1) / 2, pm)
  if (!Number.isFinite(p1[0]) || !Number.isFinite(p2[0]) || !Number.isFinite(pm[0])) return 0
  return Math.hypot(pm[0] - (p1[0] + p2[0]) / 2, pm[1] - (p2[1] + p1[1]) / 2)
}
// 块内取四角四格校核、取最坏的：误差在块内不均匀，只看中间那一格会漏掉最弯的角。
export function blockError(proj, lo0, lo1, la0, la1, nLon, nLat) {
  const dLo = (lo1 - lo0) / nLon, dLa = (la0 - la1) / nLat
  let e = 0
  for (const a of [lo0, lo1 - dLo]) for (const b of [la0, la1 + dLa]) {
    const v = cellError(proj, a, a + dLo, b, b - dLa)
    if (v > e) e = v
  }
  return e
}

/**
 * 一块切几行几列：先按经 / 纬两向的弓高定初值，再按格心的实际偏差加密。
 * ★ 加密只加【弓高大的那一向】，不是两向一起翻倍。两个理由：
 *   · 剩下的那点偏差是【交叉项】（x = A(φ)·λ 这一族里 A 随纬度变），它 ∝ Δλ·Δφ ——
 *     切哪一向都同样有效、格数也都是同比例涨，故挑一向切没有代价；
 *   · 而两向一起切就有代价：Mercator 的纬线是直线，往经向切一刀一点误差都不减，
 *     纯粹把格数翻倍（实测两向一起翻会切出 8×64 这种格局，格数比固定档还多）。
 */
export function planCells(proj, lo0, lo1, la0, la1, tol) {
  const sLon = sagWorst(proj, lo0, lo1, (la0 + la1) / 2, true)
  const sLat = sagWorst(proj, la0, la1, (lo0 + lo1) / 2, false)
  let nLon = segCount(sLon, tol), nLat = segCount(sLat, tol)
  for (let i = 0; i < 6; i++) {
    const e = blockError(proj, lo0, lo1, la0, la1, nLon, nLat)
    if (!(e > tol)) break
    // 切哪一向【量出来】，不靠猜：把两向各翻一倍分别算一次，取减得多的那一个。
    // 猜错的代价是实打实的 —— 交叉项只在一向上减得动，往另一向切一刀一点误差都不减、
    // 格数却翻倍（曾经按弓高大小猜，Robinson 深放大处五轮全花在纬向上、经向一格没切，超差 0.97 px）。
    const eLon = nLon < CELL_MAXN ? blockError(proj, lo0, lo1, la0, la1, nLon * 2, nLat) : Infinity
    const eLat = nLat < CELL_MAXN ? blockError(proj, lo0, lo1, la0, la1, nLon, nLat * 2) : Infinity
    if (!(Math.min(eLon, eLat) < e * 0.95)) break     // 两向都减不下去（顶到 CELL_MAXN）：认了，别白切
    if (eLon <= eLat) nLon = Math.min(CELL_MAXN, nLon * 2)
    else nLat = Math.min(CELL_MAXN, nLat * 2)
  }
  return { nLon, nLat }
}

// ── 反向网格（invGrid 那一档）的细分 ─────────────────────────────────────────
// 网格建在平面上、四角逆算成经纬，故误差判据也翻过来：把格心的【插值经纬】正算回平面，
// 与真实格心的平面位置比 —— 与正向的 cellError 同一把尺子（都是平面单位），tol 可以共用。
// ★ 为什么不直接量「经纬差」：极点处经度是不定的（跨极那一格四角的经度能差 180°），
//   量经纬会把那一格判成天文数字；而正算回平面时极点无论配哪个经度都落到同一点，自动无害。
const unwrapLon = (v, ref) => { let t = v; while (t - ref > 180) t -= 360; while (t - ref < -180) t += 360; return t }
export function cellErrorInv(proj, x0, x1, y0, y1) {
  // ★ 四角必须取【钳进图幅之后】的那一份，也就是真正画出去的那四个点。
  //   取未钳的原角是个隐蔽的坑：跨图幅边界的格有角在圆外，逆算在那里给的是镜像解，
  //   误差算出来是个无意义的小数 → 整块被判成「一格就够」→ 那一格钳完变成贴着圆周的一大片，
  //   把 4°×3° 的源图拉满一整块，圆边上就是一圈白色的碎三角。
  const cn = cellCornersInv(proj, x0, x1, y0, y1)
  if (!cn) return 0
  const a = cn[0], b = cn[1], c = cn[2]
  // 一格拆两个三角形、公共边是 b–c 那条反对角线，格心正落在它上面 → 插值结果就是两端的中点
  const lonI = (unwrapLon(b.lon, a.lon) + unwrapLon(c.lon, a.lon)) / 2
  const latI = Math.max(-90, Math.min(90, (b.lat + c.lat) / 2))
  const p = proj.fwd(lonI, latI, [0, 0])
  if (!Number.isFinite(p[0])) return 0
  return Math.hypot(p[0] - (b.x + c.x) / 2, p[1] - (b.y + c.y) / 2)
}
// 一块（平面矩形）切成几行几列。四角各校核一格取最坏，逐次对半加密。
// ★ 上限存在的理由和正向的 CELL_MAXN 一样：对跖点是真奇点，那一圈的误差只随格边线性下降
//   （不是二次），一路加密下去格数会失控。圆周最外那一圈本来就是「整个地球的背面摊在圆边上」，
//   摊得准不准人眼分辨不出，认了这点误差比让它把帧时间吃穿划算。
// 上限存在的理由和正向的 CELL_MAXN 一样：对跖点是真奇点，那一圈的误差只随格边线性下降
// （不是二次），一路加密下去格数会失控。
export const CELL_MAXN_INV = 128
// 这一格画不画：四角或格心【有一个】在图幅内就画，四角另由 clampPlane 压回图幅内。
// ★ 这条判据的松紧调过三轮，两头都掉过坑，都是拿品红色垫底一眼看出来的：
//   · 「四角全在内」→ 沿圆周一圈各缺一格，吃掉 12.5% 的面积；
//   · 「格心在内」→ 跨边界的块整块一格时（自适应会这么判，见 flatCoverage 里 onRim 的说明）
//     那一格的格心在圆外，整块当场空掉 —— 圆周上一圈块那么大的三角形缺口；
//   · 现在这条配上【跨边界的块强制细分】才成立：格小了，钳完的变形就小，圆内也盖得满。
//     单独放宽而不细分，就是圆边上那一圈白色的碎三角（一格把 4°×3° 的源图拉满一整块）。
export function cellDrawableInv(proj, x0, x1, y0, y1) {
  return proj.inPlane(x0, y0) || proj.inPlane(x1, y0) || proj.inPlane(x0, y1) || proj.inPlane(x1, y1) ||
    proj.inPlane((x0 + x1) / 2, (y0 + y1) / 2)
}
// 一格的四角（钳进图幅后）逆算成经纬。返回 null ＝ 这一格画不了。
export function cellCornersInv(proj, x0, x1, y0, y1) {
  const out = []
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const c = proj.clampPlane(x, y)
    const q = proj.invRaw(c[0], c[1])
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null
    out.push({ x: c[0], y: c[1], lon: q[0], lat: q[1] })
  }
  return out
}
/**
 * 一块（平面矩形）切成几行几列（各向同性，n×n）。
 * minCell = 格边下限（平面单位），由调用方按烘图分辨率折算 —— 这是这一档【真正管住格数】的那一条。
 * ★ 判据是「格子已经小到几个烘图像素了，再切下去只是在同一个像素里反复贴图」：
 *   圆周与极点这两圈的误差只随格边线性下降，光靠 tol 会一路切到上限 ——
 *   实测全平面 res=3 时 30 个块贡献了 86% 的格、总共 61 万个三角形、烘一次 28 秒。
 *   加上这条下限之后同样条件降到两万上下，而多出来的那点误差全落在圆的最外缘
 *   （那里是「地球背面被摊到圆周上」，贴得准不准人眼分辨不出）。
 */
export function planCellsInv(proj, x0, x1, y0, y1, tol, minCell) {
  // 极点若落在这一块里，它周围几圈格必须进采样：误差在极点附近是个 ∝1/r 的尖峰，
  // 均匀采样很容易贴着它旁边漏过去（实测漏掉的那一格超差 1.7%）。极点自己那一格照旧豁免。
  const polar = []
  for (const la of [90, -90]) {
    const q = proj.fwd(0, la, [0, 0])
    if (Number.isFinite(q[0]) && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1) polar.push([q[0], q[1]])
  }
  // ★ 铺一层 9×9 的采样，不是只看四角：块内误差对方位等距【不单调】——
  //   径向随 γ 涨是单调的，可极点还能落在块的中间。四角（甚至 3×3）都踩不到那个尖峰：
  //   实测块切到 16×16 时最坏的那一格正落在采样点之间，判出来「一格就够」而实际超差两倍。
  const SAMP = 9, POLE_RING = 4
  const err = (n) => {
    const dx = (x1 - x0) / n, dy = (y1 - y0) / n
    const st = Math.max(1, Math.floor(n / (SAMP - 1)))
    const cells = new Set()
    const ax = []
    for (let i = 0; i < n; i += st) ax.push(i)
    if (ax[ax.length - 1] !== n - 1) ax.push(n - 1)
    for (const i of ax) for (const j of ax) cells.add(i * n + j)
    for (const [px, py] of polar) {
      const ci = Math.min(n - 1, Math.max(0, Math.floor((px - x0) / dx)))
      const cj = Math.min(n - 1, Math.max(0, Math.floor((py - y0) / dy)))
      for (let u = -POLE_RING; u <= POLE_RING; u++) for (let v = -POLE_RING; v <= POLE_RING; v++) {
        const a = ci + u, b = cj + v
        if (a >= 0 && a < n && b >= 0 && b < n) cells.add(a * n + b)
      }
    }
    let e = 0
    for (const idx of cells) {
      const a = x0 + Math.floor(idx / n) * dx, b = y0 + (idx % n) * dy
      // ★ 两类格子不进误差统计，否则整块被它们一路切到上限（实测 484 块里 86 块是这么切爆的）：
      //   · 图幅外的格 —— 逆算在那里给的是镜像解，那个数不是「这一块弯不弯」的信息；
      //   · 含极点的那一格 —— 极点经度不定，四角经度能差 180°，插值出来的位置必然离格心很远。
      //     它照画不误（等经纬源图在极点那一圈是同一片冰盖，贴错经度看不出来），只是不该
      //     拿它去定整块的密度。
      if (!cellDrawableInv(proj, a, a + dx, b, b + dy)) continue
      const q = proj.invRaw(a + dx / 2, b + dy / 2)
      if (q && Math.abs(q[1]) > 89) continue
      const v = cellErrorInv(proj, a, a + dx, b, b + dy)
      if (v > e) e = v
    }
    return e
  }
  const cap = Math.max(1, Math.min(CELL_MAXN_INV,
    Number.isFinite(minCell) && minCell > 0 ? Math.floor((x1 - x0) / minCell) : CELL_MAXN_INV))
  let n = 1
  for (let i = 0; i < 8 && n < cap; i++) {
    if (!(err(n) > tol)) break
    n *= 2
  }
  return Math.min(cap, n)
}

// ── 反向网格：一块切几行几列的【完整口径】────────────────────────────────────
// 自适应那一档（planCellsInv）之外还有三条特例，全是拿品红色顶替垫底海色、逐个看出来的。
// 渲染端与测试走同一份，免得判据在两处各写一遍、改了一处忘了另一处。
//   res = 每平面单位多少烘图像素（＝屏上分辨率）；tol = 允许的格心偏差（平面单位）。
const INV_MINCELL_PX = 2   // 格边下限（烘图像素）：比这更细就只是在同一个像素里反复贴图
const INV_STRETCH_CAP = 8  // 拉伸放宽的封顶：再松圆的最外缘就整块糊了
const RIM_GAP_PX = 8       // 跨边界的块留多宽的缺口（烘图像素）—— 缺口＝半个格边
const RIM_MIN_N = 4, RIM_MAX_N = 24
export function planBlockInv(proj, x0, x1, y0, y1, tol, res) {
  const CP = x1 - x0
  const cx = proj.W / 2, cy = proj.H / 2
  // ① 跨图幅边界（圆周穿过）的块：【不走自适应】，只按缺口宽度定密度。
  //    自适应在这种块上两头都不对 —— 往粗了说，整块一格时四角钳完都挤在圆周附近、误差看着
  //    很小 → 判 n=1，而这一格的格心在图幅外，整块不画，圆周上就是一圈块那么大的三角形缺口；
  //    往细了说，钳出来的形变本身又会被当成曲率一路切到上限（实测 res=3 时光这一圈就是
  //    五万个三角形、烘图 8.6 秒）。这一圈真正要保证的只有一件事：缺口小到看不出来。
  const corner = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([a, b]) => proj.inPlane(a, b))
  if (corner.some((v) => v) && corner.some((v) => !v)) {
    return Math.max(RIM_MIN_N, Math.min(RIM_MAX_N, Math.ceil(CP * res / RIM_GAP_PX)))
  }
  // ② 含极点的块不放宽：极点那一格必被「四角经度差满 180°」的防呆挡掉，它就是图上的一个洞，
  //    而洞的大小正是格边 —— 放宽了南极中间就是一个方块。
  const q = [0, 0]
  const hasPole = [90, -90].some((la) => {
    proj.fwd(0, la, q)
    return q[0] >= x0 && q[0] < x1 && q[1] >= y0 && q[1] < y1
  })
  // ③ 其余按【地面上多大一块】放宽格边下限：方位等距把切向拉大 γ/sinγ 倍（γ=175° 是 40 倍），
  //    那一带再怎么切也切不出新的地面细节。
  const gDeg = Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy)
  const sg = Math.abs(Math.sin(gDeg * Math.PI / 180))
  const stAz = (gDeg > 1e-6 && sg > 1e-6) ? (gDeg * Math.PI / 180) / sg : INV_STRETCH_CAP
  const stretch = hasPole ? 1 : Math.max(1, Math.min(INV_STRETCH_CAP, stAz))
  return planCellsInv(proj, x0, x1, y0, y1, tol, INV_MINCELL_PX * stretch / res)
}

// 某一块落在源图（等经纬，经度 −180..180）的哪个周期：块内经度减去 360·k 即落回 −180..180
export const lonPeriod = (a, b) => Math.floor(((a + b) / 2 + 180) / 360)

// 平面尺寸（fit 用）。等距圆柱恒 360×180。
export const planeSize = (proj) => ({ w: proj.W, h: proj.H })
