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
//   d3-geo：Mercator / Equal Earth / Albers(圆锥等积)   d3-geo-projection：Robinson
import { geoPath, geoMercator, geoEqualEarth, geoConicEqualArea, geoGraticule } from 'd3-geo'
import { geoRobinson } from 'd3-geo-projection'

// 下拉里的顺序与名字。出厂第一档＝等距圆柱（换投影前的那一套）。
export const PROJECTIONS = [
  { k: 'equirect', zh: '等距圆柱', en: 'Equirectangular' },
  { k: 'mercator', zh: 'Mercator', en: 'Mercator' },
  { k: 'equalEarth', zh: 'Equal Earth', en: 'Equal Earth' },
  { k: 'robinson', zh: 'Robinson', en: 'Robinson' },
  { k: 'albers', zh: 'Albers', en: 'Albers' }
]
export const DEFAULT_PROJECTION = 'equirect'
export const isProjection = (k) => PROJECTIONS.some((p) => p.k === k)
export const projZh = (k) => (PROJECTIONS.find((p) => p.k === k) || PROJECTIONS[0]).zh

// Albers 是【区域】投影，标准纬线定了才有意义。取中国全图的惯用值（25°N / 47°N）；
// 中央经线跟随「画面中心」，故把画面中心设成 105°E 即得报告里那张常规中国全图。
export const ALBERS_PARALLELS = [25, 47]
// Mercator 的纬度上限：ln(tan(π/4+φ/2)) 在极点发散，Web 口径一律钳到 ±85.051129°（正好使平面成正方形）。
export const MERCATOR_LAT = 85.05112877980659

// 各投影在 scale=1 / translate=[0,0] 下的原始范围。绕极旋转（换中央经线）不改变范围，
// 故每种只需量一次、与 lon0 无关。缓存住：每次换切口都重量一遍是几十万次投影。
const rawCache = new Map()
function d3Raw(kind) {
  if (kind === 'mercator') return geoMercator()
  if (kind === 'equalEarth') return geoEqualEarth()
  if (kind === 'robinson') return geoRobinson()
  if (kind === 'albers') return geoConicEqualArea().parallels(ALBERS_PARALLELS)
  return null
}
function rawExtent(kind) {
  const hit = rawCache.get(kind)
  if (hit) return hit
  const p = d3Raw(kind).scale(1).translate([0, 0]).rotate([0, 0, 0])
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
  rawCache.set(kind, r)
  return r
}

const wrap180 = (v) => ((v + 180) % 360 + 360) % 360 - 180
const PLANE_W = 360   // 与等距圆柱同宽 —— 全平台按 k() 折算的常数由此不用动

/**
 * 造一个投影。kind ∈ PROJECTIONS 的 k；lon0 = 切口经度（画面左边缘），中央经线 = lon0 + 180。
 * 返回的对象是【不可变】的，换投影或换切口就重造一个。
 */
export function makeProjection(kind, lon0) {
  const k = isProjection(kind) ? kind : DEFAULT_PROJECTION
  const L0 = wrap180(Number(lon0) || 0)

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
      path: null, graticule: null
    }
  }

  // ---------- 四个投影档：d3 出数学，平面归一到 W=360 ----------
  const raw = rawExtent(k)
  const s = PLANE_W / raw.w
  const lam0 = L0 + 180                       // 中央经线
  const d3p = d3Raw(k).scale(s).rotate([-lam0, 0, 0])
  // translate 让 x∈[0,W]、y∈[0,H]：raw 是 translate=[0,0] 下量的，乘 s 后整体平移。
  // ★ Mercator 的 translate 必须在 scale 之后设 —— d3 的 geoMercator 会在这两个 setter 里
  //   按当前 scale/translate 重算 clipExtent（那是它「钳到 ±85.05」的实现方式），顺序反了就钳不住。
  d3p.translate([-raw.x0 * s, -raw.y0 * s])
  const H = raw.h * s
  const latLim = k === 'mercator' ? MERCATOR_LAT : 90

  const fwd = (lon, lat, out) => {
    const o = out || [0, 0]
    const la = lat > latLim ? latLim : (lat < -latLim ? -latLim : lat)
    const q = d3p([lon, la])
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) { o[0] = NaN; o[1] = NaN; return o }
    o[0] = q[0]; o[1] = q[1]
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
    // 于是栅格重投影可以按【整行】一次仿射拉伸；圆锥（Albers）的纬线是圆弧，不成立。
    rowAffine: k !== 'albers',
    // GeoJSON → 目标（Path2D 或任何有 moveTo/lineTo/closePath 的录制对象）。
    // d3 的 geoPath 顺带做了两件手搓代价很高的事：日界线切割（多边形被正确切成两半而不是横扫全图）
    // 与自适应加密（长段按投影曲率补点，不必先 densifyLonLat）。
    path: (geo, target) => { geoPath(d3p, target)(geo); return target },
    graticule: (step) => geoGraticule().step([step, step]).stepMinor([step, step])
  }
}

// 平面尺寸（fit 用）。等距圆柱恒 360×180。
export const planeSize = (proj) => ({ w: proj.W, h: proj.H })
