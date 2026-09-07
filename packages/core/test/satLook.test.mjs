// 光标的「相对参考卫星」视角读数（src/viz/grd/coverage.js 的 satLookAt）。运行：npm test
//
// 这一项是 2D 地图状态栏里紧挨经纬度的那一格：az/el 与 u/v 两档可选。
// ★ 两档不是两套几何，是同一个方向的两种写法 —— 天线系（boresight = 星下天底）里
//   az/el 走 GRD 说明的 igrid 6，u/v 走 igrid 1。本段就是钉这一条：两者必须能互相换算回去。
// 口径错了的症状不是报错，是「读数看着挺像那么回事，其实差着一个符号或一个轴」，故判据一律是能算的量。
import { satLookAt, dirToAzEl, gridDir, groundLookAngles, antennaBasis } from '../../../src/viz/grd/coverage.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

const GEO = 35786.0                     // GEO 高度（km，与平台其它几何同口径）
const SUB = 110.5                       // 星下点经度：拿中星 6D 那个定点位当算例

// ---------- ① 星下点本身：一切读数归零 ----------
{
  const k = satLookAt(SUB, 0, GEO, SUB, 0)
  // γ 的容差比别项松：acos 在自变量贴近 1 时精度掉一半（acos(1−ε) ≈ √(2ε)），赤道上量出来是 1e-6°
  ok('① 星下点上 az/el/u/v/γ 全为 0',
    near(k.az, 0, 1e-9) && near(k.el, 0, 1e-9) && near(k.u, 0, 1e-9) && near(k.v, 0, 1e-9) && near(k.gamma, 0, 1e-4),
    `az=${k.az.toFixed(6)} el=${k.el.toFixed(6)} u=${k.u.toExponential(1)} v=${k.v.toExponential(1)} γ=${k.gamma.toExponential(1)}`)
  ok('① 星下点的斜距 = 轨道高度', near(k.range, GEO, 1.0), `${k.range.toFixed(1)} km（应 ≈ ${GEO}）`)
  ok('① 星下点可见', k.vis === true)
}

// ---------- ② 两档必须能互换：gridDir(6, az, el) 就是 (u, v, w) ----------
// 这是全段的核心。差一个符号或一个轴的错在图上看不出来，只有回代才逮得住。
{
  let worst = 0, at = ''
  for (const lon of [SUB - 60, SUB - 20, SUB, SUB + 20, SUB + 60]) {
    for (const lat of [-60, -30, 0, 30, 60]) {
      const k = satLookAt(SUB, 0, GEO, lon, lat)
      const d = gridDir(6, k.az, k.el)                 // az/el → 天线系单位矢量
      const e = Math.max(Math.abs(d[0] - k.u), Math.abs(d[1] - k.v), Math.abs(d[2] - k.w))
      if (e > worst) { worst = e; at = `(${lon}, ${lat})` }
    }
  }
  ok('② az/el 与 u/v 是同一个方向的两种写法（gridDir(6,az,el) 回代 = u,v,w）',
    worst < 1e-12, `最大偏差 ${worst.toExponential(1)} @${at}`)
  // 单位矢量：u²+v²+w² 必须是 1
  let unit = 0
  for (const lat of [-70, -35, 0, 35, 70]) {
    const k = satLookAt(SUB, 0, GEO, SUB + 40, lat)
    unit = Math.max(unit, Math.abs(k.u * k.u + k.v * k.v + k.w * k.w - 1))
  }
  ok('② (u,v,w) 是单位矢量', unit < 1e-12, `|模²−1| ≤ ${unit.toExponential(1)}`)
}

// ---------- ③ 与既有的 dirToAzEl 逐位一致（不许另起一套公式）----------
{
  let worst = 0
  for (const lon of [0, 60, SUB, 180, -120]) for (const lat of [-45, 0, 45]) {
    const k = satLookAt(SUB, 0, GEO, lon, lat)
    const r = dirToAzEl(SUB, 0, GEO, lon, lat)
    worst = Math.max(worst, Math.abs(k.az - r.az), Math.abs(k.el - r.el))
  }
  ok('③ az/el 与既有的 dirToAzEl 逐位相同（同一条公式，没有第二份）', worst < 1e-12, `最大差 ${worst.toExponential(1)}°`)
}

// ---------- ④ 轴向：哪个方向对应哪个符号 ----------
// 天线系 x 轴 = crs(z_地轴, boresight) 归一 → 对赤道上的 GEO 星，boresight 指天底，x 指向【西】。
// az = atan2(−u, …) 于是「东边的点 az 为正」。这一条钉死符号，免得整张图左右镜像。
{
  const east = satLookAt(SUB, 0, GEO, SUB + 5, 0)      // 星下点以东 5°
  const west = satLookAt(SUB, 0, GEO, SUB - 5, 0)
  const north = satLookAt(SUB, 0, GEO, SUB, 5)         // 星下点以北 5°
  const south = satLookAt(SUB, 0, GEO, SUB, -5)
  ok('④ 星下点以东 az>0、以西 az<0（赤道上 el 恒 0）',
    east.az > 0 && west.az < 0 && near(east.az, -west.az, 1e-9) && near(east.el, 0, 1e-9),
    `东 az=${east.az.toFixed(4)}° 西 az=${west.az.toFixed(4)}°`)
  ok('④ 星下点以北 el>0、以南 el<0（同一条经线上 az 恒 0）',
    north.el > 0 && south.el < 0 && near(north.el, -south.el, 1e-9) && near(north.az, 0, 1e-9),
    `北 el=${north.el.toFixed(4)}° 南 el=${south.el.toFixed(4)}°`)
  // ★ u 与 az 【反号】—— 不是写反了：天线系 x 轴对赤道 GEO 星指【西】，而 igrid 6 让 az 东为正。
  //   v 与 el 则同号。这一条钉死符号，免得整张图左右镜像。
  ok('④ u 与 az 反号、v 与 el 同号', east.u < 0 && west.u > 0 && north.v > 0 && south.v < 0,
    `东 az=${east.az.toFixed(4)}°/u=${east.u.toFixed(5)} · 北 el=${north.el.toFixed(4)}°/v=${north.v.toFixed(5)}`)
}

// ---------- ⑤ 地心角 γ：与球面几何的独立算法对得上 ----------
// γ 是方位等距图上「到圆心的距离」，读数错了整张图的尺子就错了。
// 独立口径：球面余弦定理（星下点与目标点的大圆夹角）。椭球与球差着扁率，容差按 0.2° 给。
{
  const D2R = Math.PI / 180
  const sph = (lon1, lat1, lon2, lat2) => Math.acos(Math.max(-1, Math.min(1,
    Math.sin(lat1 * D2R) * Math.sin(lat2 * D2R) + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lon2 - lon1) * D2R)))) / D2R
  let worst = 0, at = ''
  for (const [lon, lat] of [[SUB + 10, 0], [SUB + 40, 20], [SUB - 30, -35], [0, 60], [SUB, 80]]) {
    const k = satLookAt(SUB, 0, GEO, lon, lat)
    const e = Math.abs(k.gamma - sph(SUB, 0, lon, lat))
    if (e > worst) { worst = e; at = `(${lon}, ${lat})` }
  }
  ok('⑤ 地心角与球面余弦定理一致（差的是椭球扁率那一点）', worst < 0.2, `最大差 ${worst.toFixed(3)}° @${at}`)
}

// ---------- ⑥ 可见性：与「地球站看卫星的仰角」互为对偶 ----------
// vis 判的是「该点在卫星的地平线内」，等价于「从该点看卫星的仰角 ≥ 0」。两条独立算法必须同进同退。
{
  let bad = 0, edge = ''
  for (let lon = SUB - 100; lon <= SUB + 100; lon += 5) for (const lat of [-70, -40, 0, 40, 70]) {
    const k = satLookAt(SUB, 0, GEO, lon, lat)
    const g = groundLookAngles(SUB, 0, GEO, lon, lat)
    if (Math.abs(g.el) < 0.05) continue                 // 正好压在地平线上：两条算法差个浮点位，不算
    if (k.vis !== (g.el > 0)) { bad++; edge = `(${lon}, ${lat}) vis=${k.vis} 站仰角=${g.el.toFixed(2)}°` }
  }
  ok('⑥ 可见性 = 该点看卫星的仰角为正（两条独立算法同进同退）', bad === 0, bad ? edge : '全部一致')
  // GEO 的可见半径 ≈ 81.3° 地心角，越过它就该判不可见
  const inCap = satLookAt(SUB, 0, GEO, SUB + 70, 0), outCap = satLookAt(SUB, 0, GEO, SUB + 88, 0)
  ok('⑥ GEO 的可见地心角上限 ≈ 81.3°', inCap.vis && !outCap.vis,
    `γ=70° vis=${inCap.vis} · γ=88° vis=${outCap.vis}`)
}

// ---------- ⑦ 非 GEO：星下点跟着纬度走 ----------
// 参考卫星不限于 GEO（LEO 的星下点每拍都在动），故基底必须按【真实星下点】建，不能拿赤道顶替。
{
  const k = satLookAt(120, 45, 800, 120, 45)            // 800 km 的星，星下点 (120, 45)
  // ★ γ 在这里不是 0 而是 0.021°：大地坐标 (lon,lat,h) 的【地心】方向随 h 变（z 分量加 h、
  //   x/y 分量加 N+h），故大地星下点与卫星的地心方向差着扁率那一点。赤道与极点上才恰好为 0。
  ok('⑦ 非零纬度的星：其星下点上 az/el 仍为 0（基底按真星下点建，不是赤道）',
    near(k.az, 0, 1e-9) && near(k.el, 0, 1e-9) && near(k.range, 800, 1.0),
    `az=${k.az.toExponential(1)} el=${k.el.toExponential(1)} 斜距=${k.range.toFixed(1)} km`)
  ok('⑦ 大地星下点处的地心角＝椭球扁率那一点（不是 0，也不该大到看得出来）',
    k.gamma > 1e-3 && k.gamma < 0.05, `γ=${k.gamma.toFixed(4)}°（45°N，理论 ≈0.021°）`)
  const n = satLookAt(120, 45, 800, 120, 48)
  ok('⑦ 该星以北的点 el>0', n.el > 0 && near(n.az, 0, 1e-9), `el=${n.el.toFixed(3)}°`)
}

// ---------- ⑧ 接线：星下点与读数是否真的挂上了 ----------
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const lf = (t) => t.replace(/\r\n/g, '\n')
  const VUE = lf(readFileSync(join(ROOT, 'src', 'pages', 'ConstellationMap3D.vue'), 'utf8'))
  const APP = lf(readFileSync(join(ROOT, 'src', 'App.vue'), 'utf8'))
  const CRS = lf(readFileSync(join(ROOT, 'src', 'stores', 'mapCrs.js'), 'utf8'))
  const CUR = lf(readFileSync(join(ROOT, 'src', 'stores', 'cursor.js'), 'utf8'))
  const FLAT = lf(readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'flatCoverage.js'), 'utf8'))

  ok('⑧ 星下点三种来源都在（手动 / 搜索卫星 / 卫星树）',
    /src === 'manual'/.test(VUE) && /src === 'tree'/.test(VUE) && /satEntryById\(sp\.id\)/.test(VUE) &&
    /satLivePos\(n\)/.test(VUE) && /SUB_SRCS/.test(VUE))
  // ★ 位置绝不存快照：存了的话时间轴一走，标记与读数就都是错的
  ok('⑧ 卫星来源只存身份、位置每拍按时钟解算',
    /subPt: null/.test(CRS) && /const subPtPos = computed/.test(VUE) && /void clock\.tMs/.test(VUE))
  ok('⑧ 手动来源必须带高度（az/el 是从卫星看的角，只给经纬度算不出来）',
    /GEO_ALT_KM/.test(CRS) && /alt > 0 \? alt : GEO_ALT_KM/.test(CRS) && /label>高度<\/label>/.test(VUE))
  ok('⑧ 光标读数接在 onHoverLL 上，且没设星下点就没有这一项',
    /cursor\.look = ll \? lookReadout\(ll\) : null/.test(VUE) &&
    /if \(mapCrs\.lookMode === 'off' \|\| !mapCrs\.subPt\) return null/.test(VUE))
  ok('⑧ 两个量各带自己的名字（az：xx  el：xx），不是光甩两个数',
    /'az' \+ sep \+/.test(VUE) && /el' \+ sep \+/.test(VUE) && /'u' \+ sep \+/.test(VUE) && /v' \+ sep \+/.test(VUE))
  ok('⑧ 状态栏摆在经纬度那一格旁边', /cursor\.look\.text/.test(APP) && /look: null/.test(CUR))
  // ★ 跟随必须节流：改投影中心＝整份重烘，LEO 每拍都改会直接卡死
  ok('⑧ 画面跟随有位移阈值 + 时间闸，且手动动过画面就自动关掉',
    /const FOLLOW_DEG = /.test(VUE) && /FOLLOW_MS/.test(VUE) && /function dropFollow/.test(VUE) &&
    (VUE.match(/dropFollow\(\)/g) || []).length >= 4 && /subFollow: false/.test(VUE))
  ok('⑧ 手动来源不跟随（那个点本来就不动）', /mapCrs\.subPt\.src === 'manual'\) return/.test(VUE))
  // ★ 跟随时【不许动缩放】：换平面的默认路子会 fit() 一次，时间轴每跳一下就把用户放大看的
  //   那一块打回全图。投影中心在平面上的位置是固定的，故视图原样留着即可。
  // ★ 2026-09-07：切口与投影参数（lat0）一起递给 setLon0 的第三参，一次 rebuildPlane —— 原来 setLon0 + setProjParams
  //   连调两次，跟随 LEO 时每拍两次整份重建
  ok('⑧ 跟随不改缩放（setLon0 走 keepView，rebuildPlane 不 fit），且切口与投影参数一次重建',
    /setLon0\(v, keepView, opts\)/.test(FLAT) && /refit: !keepView/.test(FLAT) &&
    /centerOnSubPt\(p, true\)/.test(VUE) && /flat\.setLon0\(mapCrs\.lon0, keepView !== false, projOpts\(\)\)/.test(VUE) &&
    !/flat\.setLon0\(mapCrs\.lon0, keepView !== false\); flat\.setProjParams/.test(VUE))
  ok('⑧ 三行设置不常驻，点「星下点」才展开',
    /const subOpen = ref\(false\)/.test(VUE) && /subOpen\.value = !subOpen\.value/.test(VUE) &&
    /v-if="subOpen"/.test(VUE))
  // 图上那枚准星同样只在那一节展开着的时候画；收起来就当没这回事（数据不动，再点开还在）
  ok('⑧ 标记跟着那一节的开关走，且推送收敛到一处',
    /function pushSubMark/.test(VUE) && /subOpen\.value \? subPtPos\.value : null/.test(VUE) &&
    /watch\(subOpen, pushSubMark\)/.test(VUE) &&
    (VUE.match(/flat\.setSubPoint\(/g) || []).length === 1)
  // ★ subOpen 必须声明在那个 watch 之前：它带 immediate，注册当场就要读这个值，晚声明会撞 TDZ
  ok('⑧ subOpen 声明在 watch(subPtPos) 之前（immediate 会当场读它）',
    VUE.indexOf('const subOpen = ref(false)') < VUE.indexOf('watch(subPtPos,'),
    `subOpen @${VUE.indexOf('const subOpen = ref(false)')} · watch @${VUE.indexOf('watch(subPtPos,')}`)
  const nDraw = (FLAT.match(/drawSubPoint\(\)/g) || []).length
  const nCall = (VUE.match(/pushSubMark\(\)/g) || []).length
  ok('⑧ 2D 有星下点标记，切回 2D 或导出时也推得上',
    /function drawSubPoint/.test(FLAT) && /setSubPoint\(v\)/.test(FLAT) && nDraw >= 3 && nCall >= 5,
    `flatCoverage 里画 ${nDraw} 处 · 页面推 ${nCall} 处`)
  ok('⑧ 选星复用地图搜索那一套池子（没有第二份索引）',
    /await ensureSearchPool\(\)/.test(VUE) && /const src = searchSource\(\)/.test(VUE) &&
    (VUE.match(/searchSource\(\)/g) || []).length >= 2)
  // ★ 2026-09-07 用户报的两条：
  //   ①「拖动调整」与「星下点」是互斥的两种投影中心口径，最多开一个 —— 开一个就得关掉另一个；
  //   ② 关掉「星下点」之后时间轴一走画面中心照样跟着卫星跑 —— 跟随只看 subFollow 不看 subOpen。
  //      收起那一节＝关掉：准星不画、画面不跟、相对它的光标读数也不出。
  const spinFn = (VUE.match(/function toggleProjSpin\(\) \{[\s\S]*?\n\}/) || [''])[0]
  const satFn = (VUE.match(/function projCenterToSat\(\) \{[\s\S]*?\n\}/) || [''])[0]
  ok('⑧ 「拖动调整」与「星下点」互斥：开一个就关掉另一个',
    /subOpen\.value = false/.test(spinFn) && /dropFollow\(\)/.test(spinFn) &&
    /projSpin\.value = false/.test(satFn) && /flat\.setRotateMode\(false\)/.test(satFn))
  const followWatch = (VUE.match(/watch\(subPtPos, \(p\) => \{[\s\S]*?\}, \{ immediate: true \}\)/) || [''])[0]
  ok('⑧ 跟随只在「星下点」展开着时生效（收起即停，时间轴再走画面也不跟）',
    /if \(!subOpen\.value \|\| !p \|\| !mapCrs\.subFollow/.test(followWatch) &&
    /if \(!subOpen\.value\) \{ dropFollow\(\); return \}/.test(satFn))
  const lookFn = (VUE.match(/function lookReadout\(ll\) \{[\s\S]*?\n\}/) || [''])[0]
  ok('⑧ 光标读数同样跟着那一节的开关走（收起不出，开关一变当场重算）',
    /if \(!subOpen\.value\) return null/.test(lookFn) && /watch\(subOpen, refreshLook\)/.test(VUE))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
