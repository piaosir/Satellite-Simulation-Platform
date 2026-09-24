// 航迹 →「发送到小程序 · 卫星覆盖」的载荷（渲染端 ESM；星座3D 页用，零依赖 DOM，Node 测试直接 import）。
//
// 标记层的一条航迹（航行 / 飞行）打成一件 type='traj'，与卫星集同一个信封、同一条通道
// （kind:'satsim-pack'：密钥路的 kind 白名单本就有它、绑定路原样转存信封，云函数零改动）。
// 一条一件是故意的：
//   · 发送弹窗的「内容清单」逐件可勾 —— 航迹要能挑着发，逐件就是挑选的粒度；
//   · 幂等键挂在航迹上（'tj:<航迹 id>'，见 miniPack.syncOf）—— 平台改了哪条重发哪条，手机上就覆盖哪条。
//
// ★ 送的是【航点 + 解析好的样式】，不送加密后的折线。航点之间怎么连（大圆）、跨 ±180° 怎么切段、
//   WGS-84 → GCJ-02 怎么偏，都是小程序那张底图（腾讯地图：Web 墨卡托 + GCJ-02）自己的事；
//   平台这边只把「这条航迹是什么、画成什么样」说清楚。
//   样式在这里解析成颜色串：整层按航行 / 飞行两档、某条航迹自带 t.color 就线 / 圆点 / 图标三样一起跟它走
//   —— 与页面 markerTrs 同一个口径，小程序照着画，不必再懂「整层 / 逐条」那套规则。
//
// ★★ 航点上限 TRAJ_MAX_PTS。手绘 / 表格录入的航迹几十上百个点，原样送；导入的航行日志（AIS / ADS-B
//    一天上万点）会顶到云函数 1 MB 的返回上限，手机上也没法逐点画 —— 超限才抽稀（Douglas–Peucker，
//    球面横距），首末点恒保留（航迹头的图标与朝向靠它们），n0 记原点数。没超限的一个点都不动。
import { byLang } from './i18n/lang.js'

export const TRAJ_TYPE = 'traj'
/** 发送弹窗清单的类型列（航行 / 飞行两种，清单上一眼分得开） */
export const TRAJ_KIND_LABEL = { sea: '航行航迹', flight: '飞行航迹' }
/** 单条航迹送出的航点上限（约 110 KB / 条，离单件 900 KB 很远；再多手机上也画不动） */
export const TRAJ_MAX_PTS = 5000

const S = (v) => String(v == null ? '' : v)
const HEX6 = /^#[0-9a-f]{6}$/i
const hexOr = (c, def) => (HEX6.test(S(c)) ? S(c).toLowerCase() : def)
const numIn = (v, def, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def }
const r6 = (v) => Math.round(v * 1e6) / 1e6                       // 1e-6° ≈ 0.11 m，够航迹用，体积减半
const normLon = (x) => { const v = ((x + 180) % 360 + 360) % 360 - 180; return v === -180 && x > 0 ? 180 : v }
// 航迹 id 是幂等键的一部分，小程序拿它当 wx storage 的键名后缀 —— 收紧到 [A-Za-z0-9_-]。
// 平台 newId() 只出字母数字，这里是防线不是转换。
const safeId = (s) => S(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)

/** 航迹只有两种：flight 以外一律按航行（与 useMarkerTable.trajKindOf、vehicleSymbol 同口径） */
export const trajKind = (k) => (k === 'flight' ? 'flight' : 'sea')

/**
 * 某条航迹的绘制样式：整层设置（markStyle 的 tj* 那一节）+ 逐条覆盖色 → 颜色串与尺寸。
 * 尺寸口径同平台：屏幕 px @100% 缩放（圆点那个数按一半作直径，见 flatCoverage.drawTrajLayer）。
 * 出厂值与 ConstellationMap3D 的 markStyle 出厂值一致 —— 存档缺键时两边画出来一样。
 */
export function trajStyleOf(t, ms = {}) {
  const fl = trajKind(t && t.kind) === 'flight'
  const own = hexOr(t && t.color, '')
  return {
    line: own || hexOr(fl ? ms.tjFlight : ms.tjSea, fl ? '#5ad1ff' : '#ff6a4a'),
    dot: own || hexOr(fl ? ms.tjDotFlight : ms.tjDotSea, fl ? '#5ad1ff' : '#ff9a5a'),
    icon: own || hexOr(fl ? ms.tjIconFlight : ms.tjIconSea, fl ? '#5ad1ff' : '#ff6a4a'),
    w: numIn(ms.tjWidth, 2.2, 0.1, 8),
    op: numIn(ms.tjOpacity, 0.95, 0.05, 1),
    dash: ['solid', 'dash', 'dot', 'dashdot'].includes(ms.tjDash) ? ms.tjDash : 'solid',
    dotPx: numIn(ms.tjDot, 4, 0, 60),
    iconOn: ms.tjIconOn !== false,
    iconPx: numIn(ms.tjIconPx, 26, 1, 60),
    nameOn: !!ms.tjNameOn,
    nameFont: numIn(ms.tjNameFont, 13, 1, 32),
    nameColor: hexOr(ms.tjNameColor, '#ffffff'),
    nameBold: !!ms.tjNameBold
  }
}

// ---------------------------------------------------------------------------
// 抽稀：Douglas–Peucker，距离取【球面横距】（点到两端点所定大圆弧的最短距离）。
// 用单位矢量算而不是经纬度平面：跨 ±180° 的航迹不必先展开经度，高纬也不会因经度收缩而量错。
// 一遍 DP 给每个点记「在多大容差下它会被留下」（子区间的值不超过父区间 → 单调，按阈值截取即
// 恰为该容差下的 DP 结果），再按这个值从大到小取够 max 个 —— 不必二分容差反复跑 DP。
// ---------------------------------------------------------------------------
const D2R = Math.PI / 180
const R_M = 6371008.8                                              // 平均地球半径（只用于排序与报数，不参与画图）
const PRE_MAX = 50000                                             // 抽稀前的等步长预取上限（DP 最坏 O(n²)：5 万点的等幅锯齿约 2 s）
function unit(lon, lat) {
  const p = lat * D2R, l = lon * D2R, c = Math.cos(p)
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)]
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const ang = (a, b) => { const c = cross3(a, b); return Math.atan2(Math.sqrt(dot3(c, c)), dot3(a, b)) }

/** 点 P 到大圆弧 AB 的球面距离（弧度）。垂足落在弧外时取到较近端点的距离。 */
function arcDist(P, A, B) {
  const n = cross3(A, B)
  const nl = Math.sqrt(dot3(n, n))
  if (nl < 1e-12) return ang(P, A)                                 // A、B 重合（或对跖，航迹里不会有）
  const nh = [n[0] / nl, n[1] / nl, n[2] / nl]
  // 垂足在弧内 ⇔ P 在 A 侧的法平面与 B 侧的法平面之间
  if (dot3(cross3(A, P), nh) >= 0 && dot3(cross3(P, B), nh) >= 0) return Math.abs(Math.asin(Math.max(-1, Math.min(1, dot3(P, nh)))))
  return Math.min(ang(P, A), ang(P, B))
}

/**
 * 抽稀到至多 max 个点（首末恒保留）。pts = [[lon, lat], ...]；返回新数组（元素原样引用）。
 * tolM 报的是截取处的容差（米），调用方可据此判断抽得狠不狠。
 */
export function simplifyTrack(pts, max) {
  const n0 = Array.isArray(pts) ? pts.length : 0
  const cap = Math.max(2, Math.floor(max) || 2)
  if (n0 <= cap) return { pts: n0 ? pts.slice() : [], tolM: 0 }
  // DP 最坏是 O(n²)（折返型的点列每层只剥掉一个点）。几十万点的日志先等步长取到 PRE_MAX 再抽，
  // 首末点照留 —— 那种密度下步长取样丢掉的细节远小于随后抽稀的容差。
  if (n0 > PRE_MAX) {
    const step = (n0 - 1) / (PRE_MAX - 1)
    pts = Array.from({ length: PRE_MAX }, (_, i) => pts[Math.round(i * step)])
  }
  const n = pts.length
  const U = pts.map((p) => unit(p[0], p[1]))
  const sig = new Float64Array(n)                                  // 该点被留下时的容差（弧度）
  const depth = new Int32Array(n)
  sig[0] = sig[n - 1] = Infinity
  const stack = [[0, n - 1, Infinity, 0]]
  while (stack.length) {
    const [a, b, cap0, dp] = stack.pop()
    if (b - a < 2) continue
    let km = -1, dm = -1
    for (let k = a + 1; k < b; k++) {
      const d = arcDist(U[k], U[a], U[b])
      if (d > dm) { dm = d; km = k }
    }
    const s = Math.min(dm, cap0)                                   // 子不超过父：阈值截取才等于 DP(ε)
    sig[km] = s; depth[km] = dp + 1
    stack.push([a, km, s, dp + 1], [km, b, s, dp + 1])
  }
  // 容差大的先留；并列时父（浅）先于子（深），保证取出来的集合在层级上是闭的
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((i, j) => (sig[j] - sig[i]) || (depth[i] - depth[j]) || (i - j))
  const keep = order.slice(0, cap).sort((i, j) => i - j)
  const cut = sig[order[cap - 1]]
  return { pts: keep.map((i) => pts[i]), tolM: Number.isFinite(cut) ? cut * R_M : 0 }
}

/**
 * 造一件「航迹」。没有一个有效航点就返回 null（调用方 filter(Boolean) 掉）。
 * @param {object} t      页面里的航迹 { id, name, kind, pts:[{lat,lon}], color?, cruiseAltM? }
 * @param {object} style  trajStyleOf(t, markStyle) 的结果
 * @param {object} [o]    { maxPts } 测试用
 */
export function makeTrajItem(t, style, o = {}) {
  if (!t) return null
  const kind = trajKind(t.kind)
  // 坐标齐全才算航点（与 markerTrs 的 finLL 同口径）；纬度越界的点画不出来，直接不送
  const all = []
  for (const p of (Array.isArray(t.pts) ? t.pts : [])) {
    const lat = Number(p && p.lat), lon = Number(p && p.lon)
    if (p == null || p.lat == null || p.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) continue
    all.push([r6(normLon(lon)), r6(lat)])
  }
  if (!all.length) return null
  const max = o.maxPts || TRAJ_MAX_PTS
  const simp = all.length > max ? simplifyTrack(all, max) : null
  const pts = simp ? simp.pts : all
  const label = TRAJ_KIND_LABEL[kind]
  const item = {
    type: TRAJ_TYPE,
    label,                                                         // 发送弹窗清单的类型列（见 miniPack.unitsOfPack）
    // 名字是数据（要发到手机上），空名兜底按当前语言现出字 —— 呈现层翻不到打了 skip 的名字位
    name: S(t.name).trim() || byLang(label, kind === 'flight' ? 'Flight Track' : 'Sailing Track'),
    tid: safeId(t.id),
    kind,
    n: pts.length,
    pts,
    style: style || trajStyleOf(t, {}),
    // 清单行尾的读数（发送弹窗用；小程序不读）。抽稀过的报原点数 —— 那才是这条航迹的真实规模
    tag: byLang(`${all.length} 点`, `${all.length} pts`)
  }
  if (simp) { item.n0 = all.length; item.tolM = Math.round(simp.tolM * 10) / 10 }
  const alt = Number(t.cruiseAltM)
  if (kind === 'flight' && Number.isFinite(alt) && alt > 0) item.cruiseAltM = Math.round(alt)
  return item
}

/** 整层航迹 → 件（次序＝侧栏从上到下；没有航点的航迹不成件） */
export function trajItemsOf(trajectories, markStyle) {
  return (Array.isArray(trajectories) ? trajectories : [])
    .map((t) => makeTrajItem(t, trajStyleOf(t, markStyle || {})))
    .filter(Boolean)
}
