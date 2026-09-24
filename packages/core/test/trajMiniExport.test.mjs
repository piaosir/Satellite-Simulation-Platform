// 航迹 → 小程序「卫星覆盖 · 航迹」的打包自测（src/shared/trajMiniExport.js + miniPack 的 traj 件）。
//
// 守的不变式：
//   ① 样式口径与页面 markerTrs 一致：整层按航行 / 飞行两档，逐条 t.color 一设就线 / 圆点 / 图标三样一起跟它走；
//      非法色 / 缺键退回出厂值（与 markStyle 出厂值逐项相同）；尺寸按平台范围夹紧；线型只认四档；
//   ② 航点：坐标不全 / 非有限 / 纬度越界的不送；经度归一到 [-180, 180]（±180 保持原样）；六位小数；
//      一个有效航点都没有的航迹不成件；不改入参；
//   ③ 件的身份：tid 收紧到 [A-Za-z0-9_-]、幂等键 'tj:<tid>'、清单类型列按航行 / 飞行分、行尾读数是原点数；
//      巡航高度只随飞行航迹、且只在有值时带；
//   ④ 抽稀：没超上限一个点都不动；超了恰好抽到上限、首末点恒在、结果是原序列的子序列、
//      被丢掉的每个点离抽稀后折线的球面距离 ≤ 报出的容差（DP 的定义）；跨 ±180° 与大点数照常；
//   ⑤ 载荷可 JSON 往返（没有 NaN / Infinity 混进去），5000 点一件远在单件上限之内。
import { TRAJ_TYPE, TRAJ_KIND_LABEL, TRAJ_MAX_PTS, trajKind, trajStyleOf, simplifyTrack, makeTrajItem, trajItemsOf } from '../../../src/shared/trajMiniExport.js'
import { makePack, unitsOfPack, syncOf, estimateBytes, ITEM_LABEL, SIZE_MAX } from '../../../src/shared/miniPack.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}
const J = (x) => JSON.stringify(x)
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e

console.log('航迹 → 小程序：样式 / 航点 / 件 / 抽稀')

// 页面 markStyle 的出厂值（ConstellationMap3D.vue 里 tj* 那一节，逐项照抄）
const MS = {
  tjSea: '#ff6a4a', tjFlight: '#5ad1ff', tjWidth: 2.2, tjOpacity: 0.95, tjDash: 'solid',
  tjDot: 4, tjDotSea: '#ff9a5a', tjDotFlight: '#5ad1ff',
  tjIconOn: true, tjIconPx: 26, tjIconSea: '#ff6a4a', tjIconFlight: '#5ad1ff',
  tjNameOn: false, tjNameFont: 13, tjNameColor: '#ffffff', tjNameBold: false
}

// ① 样式
{
  const sea = trajStyleOf({ kind: 'sea' }, MS)
  const fl = trajStyleOf({ kind: 'flight' }, MS)
  ok('航行三色取整层航行档', sea.line === '#ff6a4a' && sea.dot === '#ff9a5a' && sea.icon === '#ff6a4a', J(sea))
  ok('飞行三色取整层飞行档', fl.line === '#5ad1ff' && fl.dot === '#5ad1ff' && fl.icon === '#5ad1ff', J(fl))
  const own = trajStyleOf({ kind: 'flight', color: '#12AB34' }, MS)
  ok('逐条色一设，线 / 圆点 / 图标三样一起跟它走（小写化）', own.line === '#12ab34' && own.dot === '#12ab34' && own.icon === '#12ab34', J(own))
  const bad = trajStyleOf({ kind: 'sea', color: 'red' }, MS)
  ok('非法逐条色不生效（回到整层）', bad.line === '#ff6a4a')
  const def = trajStyleOf({ kind: 'flight' }, {})
  const DEF_OK = def.line === '#5ad1ff' && def.w === 2.2 && def.op === 0.95 && def.dash === 'solid' && def.dotPx === 4 &&
    def.iconOn === true && def.iconPx === 26 && def.nameOn === false && def.nameFont === 13 && def.nameColor === '#ffffff'
  ok('缺键全部退回出厂值（与 markStyle 出厂值一致）', DEF_OK, J(def))
  const cl = trajStyleOf({}, { tjWidth: 99, tjOpacity: -1, tjDot: 'x', tjIconPx: 0, tjDash: 'wavy', tjIconOn: false, tjNameOn: 1 })
  ok('尺寸按平台范围夹紧、非数退回出厂', cl.w === 8 && cl.op === 0.05 && cl.dotPx === 4 && cl.iconPx === 1, J(cl))
  ok('线型只认四档，其余当实线', cl.dash === 'solid' && trajStyleOf({}, { tjDash: 'dashdot' }).dash === 'dashdot')
  ok('图标 / 航迹名开关照读', cl.iconOn === false && cl.nameOn === true)
  ok('kind 归一：flight 以外一律航行', trajKind('flight') === 'flight' && trajKind('sea') === 'sea' && trajKind(undefined) === 'sea' && trajKind('ship') === 'sea')
}

// ② / ③ 件
{
  const t = {
    id: 'm1abc!@#', name: '  渤海航线 ', kind: 'sea', color: '',
    pts: [
      { id: 'w1', lat: 38.123456789, lon: 117.987654321 },
      { id: 'w2', lat: null, lon: 118 },                     // 坐标不全：不送
      { id: 'w3', lat: 39, lon: NaN },                        // 非有限：不送
      { id: 'w4', lat: 95, lon: 120 },                        // 纬度越界：不送
      { id: 'w5', lat: 38.5, lon: 190 },                      // 经度归一 → -170
      { id: 'w6', lat: '39.25', lon: '-180' },                // 字符串数字照认；-180 保持
      { id: 'w7', lat: 40, lon: 180 }                         // 180 保持
    ]
  }
  const before = J(t)
  const it = makeTrajItem(t, trajStyleOf(t, MS))
  ok('不改入参', J(t) === before)
  ok('件类型 traj', it.type === TRAJ_TYPE && TRAJ_TYPE === 'traj')
  ok('坏航点逐个丢、次序保留', J(it.pts) === J([[117.987654, 38.123457], [-170, 38.5], [-180, 39.25], [180, 40]]), J(it.pts))
  ok('n = 送出的航点数', it.n === 4 && !('n0' in it))
  ok('名字去首尾空白', it.name === '渤海航线')
  ok('tid 收紧到 [A-Za-z0-9_-]', it.tid === 'm1abc')
  ok('清单类型列按航行 / 飞行分', it.label === TRAJ_KIND_LABEL.sea && TRAJ_KIND_LABEL.flight === '飞行航迹')
  ok('行尾读数是有效航点数', it.tag === '4 点', it.tag)
  ok('航行航迹不带巡航高度', !('cruiseAltM' in it))
  ok('幂等键 tj:<tid>', syncOf(it) === 'tj:m1abc')
  ok('ITEM_LABEL 认 traj', ITEM_LABEL.traj === '航迹')
  ok('样式随件', it.style && it.style.line === '#ff6a4a' && it.style.dot === '#ff9a5a')

  const f = makeTrajItem({ id: 'f1', name: '', kind: 'flight', cruiseAltM: 10668.4, pts: [{ lat: 31, lon: 121 }, { lat: 40, lon: 116 }] }, null)
  ok('空名兜底为类型名', f.name === '飞行航迹', f.name)
  ok('飞行航迹带巡航高度（取整米）', f.cruiseAltM === 10668)
  ok('没给样式时按出厂样式', f.style && f.style.line === '#5ad1ff')
  const f0 = makeTrajItem({ id: 'f2', kind: 'flight', cruiseAltM: 0, pts: [{ lat: 1, lon: 1 }] }, null)
  ok('巡航高度非正不带', !('cruiseAltM' in f0))
  ok('单航点也成件（手机上画航点与图标）', f0 && f0.n === 1)
  ok('没有有效航点不成件', makeTrajItem({ id: 'e', kind: 'sea', pts: [{ lat: null, lon: null }] }, null) === null && makeTrajItem({ id: 'e2', pts: [] }, null) === null && makeTrajItem(null) === null)
  ok('没有 id 时幂等键为空（主进程退化为内容哈希）', syncOf(makeTrajItem({ kind: 'sea', pts: [{ lat: 1, lon: 1 }] }, null)) === '')

  const items = trajItemsOf([t, { id: 'empty', kind: 'sea', pts: [] }, { id: 'x2', kind: 'flight', pts: [{ lat: 0, lon: 0 }] }], MS)
  ok('trajItemsOf：空航迹不成件、次序照侧栏', items.length === 2 && items[0].tid === 'm1abc' && items[1].tid === 'x2')
  const units = unitsOfPack(makePack({ name: '航迹数据', from: 'PID', items }))
  ok('投递单元：类型列取件的 label、行尾取 tag', units[0].label === '航行航迹' && units[1].label === '飞行航迹' && units[0].tag === '4 点' && units[1].tag === '1 点', J(units.map((u) => [u.label, u.tag])))
  ok('投递单元的幂等键逐件', units[0].sync === 'tj:m1abc' && units[1].sync === 'tj:x2')
  const lb = unitsOfPack(makePack({ items: [{ type: 'lb-config', name: 'a', mod: 'NGSO' }] }))
  ok('链路配置行尾仍是体制（mod 兜底）', lb[0].tag === 'NGSO')
  const rt = JSON.parse(JSON.stringify(units[0].payload))
  ok('载荷可 JSON 往返', J(rt) === J(units[0].payload))
}

// ④ 抽稀
const D2R = Math.PI / 180, R = 6371008.8
const unit = (lon, lat) => { const p = lat * D2R, l = lon * D2R, c = Math.cos(p); return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)] }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const angle = (a, b) => { const c = cross(a, b); return Math.atan2(Math.hypot(...c), dot(a, b)) }
function arcDistM(p, a, b) {       // 与实现独立写一份：点到大圆弧的球面距离（米）
  const P = unit(...p), A = unit(...a), B = unit(...b)
  const n = cross(A, B), nl = Math.hypot(...n)
  if (nl < 1e-12) return angle(P, A) * R
  const nh = n.map((x) => x / nl)
  const inside = dot(cross(A, P), nh) >= 0 && dot(cross(P, B), nh) >= 0
  return (inside ? Math.abs(Math.asin(Math.max(-1, Math.min(1, dot(P, nh))))) : Math.min(angle(P, A), angle(P, B))) * R
}
// DP 的定义式：每个被丢掉的点，离它所在那一段（抽稀后相邻两个保留点）的距离 ≤ 容差
function checkDp(src, res, tolM) {
  let j = 0, worst = 0
  const idx = []
  for (let i = 0; i < src.length && j < res.length; i++) if (src[i] === res[j]) { idx.push(i); j++ }
  if (idx.length !== res.length) return { sub: false }
  for (let s = 0; s + 1 < idx.length; s++) {
    for (let k = idx[s] + 1; k < idx[s + 1]; k++) worst = Math.max(worst, arcDistM(src[k], src[idx[s]], src[idx[s + 1]]))
  }
  return { sub: true, worst, okTol: worst <= tolM * (1 + 1e-9) + 1e-6 }
}
{
  const few = [[1, 1], [2, 2], [3, 3]]
  const r0 = simplifyTrack(few, 10)
  ok('没超上限：原样（新数组、同元素）', r0.pts.length === 3 && r0.pts !== few && r0.pts[1] === few[1] && r0.tolM === 0)

  // 带噪的锯齿：20 个大拐点 + 每段 400 个抖动点
  const src = []
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let c = 0; c < 20; c++) {
    const lon0 = 100 + c * 1.5, lat0 = c % 2 ? 30 : 32
    const lon1 = 100 + (c + 1) * 1.5, lat1 = (c + 1) % 2 ? 30 : 32
    for (let k = 0; k < 400; k++) {
      const f = k / 400
      src.push([lon0 + (lon1 - lon0) * f + (rnd() - 0.5) * 1e-3, lat0 + (lat1 - lat0) * f + (rnd() - 0.5) * 1e-3])
    }
  }
  src.push([130, 30])
  const r = simplifyTrack(src, 60)
  ok('恰好抽到上限', r.pts.length === 60, String(r.pts.length))
  ok('首末点恒在', r.pts[0] === src[0] && r.pts[r.pts.length - 1] === src[src.length - 1])
  const chk = checkDp(src, r.pts, r.tolM)
  ok('结果是原序列的子序列', chk.sub)
  ok('被丢的点离抽稀折线 ≤ 报出的容差（DP 定义）', chk.okTol, `worst ${chk.worst && chk.worst.toFixed(2)} m / tol ${r.tolM.toFixed(2)} m`)
  const corners = Array.from({ length: 20 }, (_, c) => src[c * 400])
  const kept = new Set(r.pts)
  ok('二十个大拐点全部保留（抖动只有百米级，拐角是百公里级）', corners.every((p) => kept.has(p)))

  // 跨 ±180°：赤道上从 170°E 走到 170°W，中间 5000 个点带一个 1° 的鼓包
  const am = []
  for (let k = 0; k <= 5000; k++) {
    let lon = 170 + 20 * k / 5000
    if (lon > 180) lon -= 360
    const bump = Math.abs(k - 2500) < 50 ? 1 : 0
    am.push([lon, bump])
  }
  const ra = simplifyTrack(am, 12)
  const ca = checkDp(am, ra.pts, ra.tolM)
  ok('跨 ±180° 照常抽稀（不因经度跳变量错距离）', ra.pts.length === 12 && ca.sub && ca.okTol, `tol ${ra.tolM.toFixed(1)} m, worst ${ca.worst && ca.worst.toFixed(1)} m`)
  ok('跨 ±180° 的鼓包被保留（最大容差不到 1° 的量级）', ra.tolM < 30000 && ra.pts.some((p) => p[1] === 1), ra.tolM.toFixed(0))

  // 大点数：15 万点也要快（先等步长取到 5 万再抽）
  const big = Array.from({ length: 150000 }, (_, k) => [100 + k * 1e-4, 20 + Math.sin(k / 3000) * 2])
  const t0 = Date.now()
  const rb = simplifyTrack(big, TRAJ_MAX_PTS)
  const ms = Date.now() - t0
  ok('15 万点抽到上限且首末在', rb.pts.length === TRAJ_MAX_PTS && rb.pts[0] === big[0] && rb.pts[rb.pts.length - 1] === big[big.length - 1])
  ok('15 万点抽稀在 3 s 内', ms < 3000, ms + ' ms')

  // 超限的件：n0 记原点数，行尾读数也报原点数
  const tt = { id: 'big', kind: 'flight', pts: big.slice(0, 12000).map(([lon, lat]) => ({ lon, lat })) }
  const it = makeTrajItem(tt, null)
  ok('超上限的件：n = 上限、n0 = 原点数、带容差', it.n === TRAJ_MAX_PTS && it.pts.length === TRAJ_MAX_PTS && it.n0 === 12000 && it.tolM >= 0, J({ n: it.n, n0: it.n0, tolM: it.tolM }))
  ok('超上限的件：行尾读数报原点数', it.tag === '12000 点')
  const small = makeTrajItem(tt, null, { maxPts: 50000 })
  ok('没超上限一个点都不动', small.n === 12000 && !('n0' in small))

  // ⑤ 体积
  const bytes = estimateBytes(makePack({ name: 'x', from: 'P', items: [it] }))
  ok('5000 点一件远在单件上限之内', bytes < 200 * 1024 && bytes < SIZE_MAX, (bytes / 1024).toFixed(0) + ' KB')
  ok('JSON 往返后逐字相同（无 NaN / Infinity）', J(JSON.parse(J(it))) === J(it))
}

console.log(`  ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
if (fail) process.exit(1)
