// 链路预算「直接导入方向图」的存储与合并自测（GSO 窗口）+ NGSO/再生式的卫星树与手动几何换算。
// 被测文件是渲染端 ESM（src/shared/lbGrdImport.js / src/linkbudget/grdParam.js / src/ngso/satTree.js /
// src/shared/slantRange.js），故本测试也是 .mjs。
//
// 关键不变式：
//   ① 本模块导入的天线单独存在 lb/grdSats —— 「星座3D」页整体覆盖式保存 globe3d/settings 时不能把它冲掉
//      （这正是不写进那棵树的原因，写进去就会静默丢数据）；
//   ② GSO 的 loadSatTree 把两边合并：3D 页导入的与本模块导入的（local:true）都能选；
//      NGSO/再生式的 satTree 只出【轨道来源】——v1.4.5 起这两个体制不再挂方向图（口径问题，见 ngso/satTree.js）；
//   ③ local 节点的星名/星位由卫星库条目单向同步（syncLocalNode），不反向回写条目；
//   ④ 没有 file 的天线记录不进树（采样靠 file 定位原始 GRD，没有它取不到值）。

// —— localStorage 桩（渲染端 API，Node 里没有）——
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)) },
  removeItem: (k) => { mem.delete(k) },
  clear: () => mem.clear()
}
// 动态 import：桩必须先于模块求值装好
const { localFolderFor, isLocalFolder, localTreeNodes, syncLocalNode,
  antKeyOf, folderOfKey, antNameOfKey, antennaGroups, staleAntOption } = await import('../../../src/shared/lbGrdImport.js')
const geo = await import('../../../src/linkbudget/grdParam.js')
const ngso = await import('../../../src/ngso/satTree.js')
// 采样器是主进程 CommonJS（星间「对星取值」的空间目标点在这一层）
const { createRequire } = await import('node:module')
const sampler = createRequire(import.meta.url)('../utils/grdSampler.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

console.log('=== 链路预算 GRD 直接导入 ===\n')

ok('folder 前缀', localFolderFor('sat3') === 'lb:sat3' && isLocalFolder('lb:sat3') && !isLocalFolder('BEIDOU'))
ok('空库返回空树', localTreeNodes().length === 0)

// —— 造一份本模块的天线库 ——
localStorage.setItem('lb/grdSats', JSON.stringify({
  sats: [{
    folder: 'lb:sat1', satName: '中星9B', lon: 101.4, lat: 0, altKm: 35786,
    antennas: [
      { name: 'KuTx', file: 'KuTx.grd', beams: 4, satLon: 101.4, satLat: 0, satAlt: 35786 },
      { name: '缺文件', beams: 2 }                                   // ④ 无 file → 不该进树
    ]
  }]
}))
const local = localTreeNodes()
ok('local 节点取回', local.length === 1 && local[0].folder === 'lb:sat1')
ok('local 标记', local[0].local === true && local[0].antennas[0].local === true)
ok('无 file 的天线被剔除', local[0].antennas.length === 1, `实际 ${local[0].antennas.length}`)
ok('波束数/基底位置带出', local[0].antennas[0].beams === 4 && local[0].antennas[0].satLon === 101.4)

// —— ② 与「星座3D」页那棵树合并 ——
localStorage.setItem('globe3d/settings', JSON.stringify({
  grd: { sats: [{ folder: 'APSTAR6D', satName: 'APSTAR-6D', lon: 134, lat: 0, altKm: 35786,
    antennas: [{ name: 'HTS', file: 'hts.grd', beams: 90, imported: true, satLon: 134, satLat: 0, satAlt: 35786 }] }], cfgs: {} }
}))
const tGeo = geo.loadSatTree()
ok('GSO 树 = 3D 页 + 本模块', tGeo.sats.length === 2 && tGeo.sats.some((s) => s.folder === 'APSTAR6D') && tGeo.sats.some((s) => s.folder === 'lb:sat1'))
const tNgso = ngso.loadSatTree()
ok('NGSO/再生式树只出 3D 页那棵（轨道来源）', tNgso.sats.length === 1 && tNgso.sats[0].folder === 'APSTAR6D')
ok('NGSO/再生式树不带天线（方向图已从这两个体制删除）', tNgso.sats[0].antennas === undefined)
ok('轨道来源字段带出', tNgso.sats[0].altKm === 35786 && 'noradId' in tNgso.sats[0] && 'omm' in tNgso.sats[0])

// —— ① 3D 页整体覆盖式保存后，本模块的天线仍在 ——
localStorage.setItem('globe3d/settings', JSON.stringify({ grd: { sats: [], cfgs: {} } }))   // 模拟 3D 页 saveSettings 快照覆盖
const after = geo.loadSatTree()
ok('3D 页快照覆盖后本模块天线不丢', after.sats.length === 1 && after.sats[0].folder === 'lb:sat1')

// —— ③ 条目改名 → 节点跟随（单向）——
ok('syncLocalNode 改名生效', syncLocalNode({ folder: 'lb:sat1', satName: '中星9B-改', lon: 92.2 }) === true)
const renamed = localTreeNodes()[0]
ok('节点名/轨位已更新', renamed.satName === '中星9B-改' && renamed.lon === 92.2)
ok('同值再同步不写盘（无改动返回 false）', syncLocalNode({ folder: 'lb:sat1', satName: '中星9B-改', lon: 92.2 }) === false)
ok('不存在的节点不误建', syncLocalNode({ folder: 'lb:nope', satName: 'X' }) === false && localTreeNodes().length === 1)

// —— 脏数据不炸 ——
localStorage.setItem('lb/grdSats', '{坏 JSON')
ok('坏 JSON 退化为空树', localTreeNodes().length === 0)
localStorage.setItem('lb/grdSats', JSON.stringify({ sats: [{ satName: '无 folder' }, null] }))
ok('缺 folder / null 记录被剔除', localTreeNodes().length === 0)

// —— ⑤ 天线匹配键自带来源：树选星与本条目导入的天线并列可选（「导入方向图」是纯添加）——
console.log('\n=== 天线匹配键与来源分组 ===\n')
ok('键=folder|天线名', antKeyOf('lb:sat1', 'KuTx') === 'lb:sat1|KuTx')
ok('拆键取 folder', folderOfKey('lb:sat1|KuTx') === 'lb:sat1' && folderOfKey('') === '')
ok('拆键取天线名', antNameOfKey('lb:sat1|KuTx') === 'KuTx')
ok('天线名里的竖线不误切（按第一个 | 切）', antNameOfKey('APSTAR6D|Ku|H') === 'Ku|H' && folderOfKey('APSTAR6D|Ku|H') === 'APSTAR6D')

const TREE = [
  { folder: 'APSTAR6D', satName: 'APSTAR-6D', antennas: [{ name: 'HTS', beams: 90 }] },
  { folder: 'lb:sat1', satName: '中星9B', local: true, antennas: [{ name: 'KuTx', beams: 4 }, { name: 'KuRx', beams: 4 }] }
]
const groups = antennaGroups(TREE, 'APSTAR6D', 'lb:sat1')
ok('两个来源并列成组', groups.length === 2 && groups[0].folder === 'APSTAR6D' && groups[1].folder === 'lb:sat1')
ok('组内选项键带各自 folder', groups[0].ants[0].key === 'APSTAR6D|HTS' && groups[1].ants[1].key === 'lb:sat1|KuRx')
ok('本条目那组标「本条目导入」', groups[1].label === '本条目导入')
ok('没取树星时只剩本条目那组', antennaGroups(TREE, '', 'lb:sat1').length === 1)
ok('两个 folder 撞上时只列一次', antennaGroups(TREE, 'lb:sat1', 'lb:sat1').length === 1)
ok('未匹配不算 stale', staleAntOption(groups, '') === null)
ok('可选项里的键不算 stale', staleAntOption(groups, 'lb:sat1|KuTx') === null)
ok('本机没有那份 GRD → 补占位项保住匹配', (staleAntOption(groups, 'GONE|Ka') || {}).name === 'Ka')

// —— ⑥ 对星取值：目标点在【空间】而非地表（再生式星间发射/接收天线）——
// 造一副常值场天线（p1 恒 100 → 20.00 dB），摆在 (0°E, 0°N, 550 km)，boresight 由 az=90° 拨到水平（指向 +Y）。
console.log('\n=== 星间：空间目标点采样 ===\n')
const N = 9, fld = new Float32Array(N * N).fill(10), zero = new Float32Array(N * N)
const LOADED = {
  igrid: 1, icomp: 3, ncomp: 2,
  beams: [{ grid: { XS: -1, YS: -1, XE: 1, YE: 1, NX: N, NY: N }, c1re: fld, c1im: zero, c2re: zero, c2im: zero }]
}
const SAT = { lon: 0, lat: 0, alt: 550 }
const ISL_CFG = { boreType: 'azel', boreAz: 90, boreEl: 0, pol: 'RSS' }
// 同一经纬度：地表点在 550 km 高的地平线之外（中心角 40° > 23°）→ 不可见；同经纬度上 550 km 处的另一颗星 → 可取值
const onGround = sampler.sampleMax(LOADED, SAT, ISL_CFG, 40, 0, 0)
const inSpace = sampler.sampleMax(LOADED, SAT, ISL_CFG, 40, 0, 550)
ok('地表点在地平线外 → 不可见', onGround === null, `实际 ${onGround}`)
ok('同处 550 km 的另一颗星 → 取到值', inSpace !== null && Math.abs(inSpace - 20) < 1e-6, `实际 ${inSpace}`)
// boresight 背面（把天线拨向 -Y，目标仍在 +Y）→ 仍然拒采：空间目标不绕过 invGridDir 的前后半球判据
const behind = sampler.sampleMax(LOADED, SAT, { ...ISL_CFG, boreAz: -90 }, 40, 0, 550)
ok('目标落在 boresight 背面 → 不采', behind === null, `实际 ${behind}`)
// 对地口径分毫不动：天底指向、地表点，传不传 alt 参数结果一致
const nadir = { boreType: 'azel', boreAz: 0, boreEl: 0, pol: 'RSS' }
ok('对地取值不受影响（缺省参数 = 传 0）',
  sampler.sampleMax(LOADED, SAT, nadir, 0, 0) === sampler.sampleMax(LOADED, SAT, nadir, 0, 0, 0))
ok('天底正下方仍取到值', Math.abs(sampler.sampleMax(LOADED, SAT, nadir, 0, 0) - 20) < 1e-6)

// —— ⑦ 手动几何：斜距 ⇄ 轨道高度 ⇄ 仰角（渲染端 shared/slantRange.js）——
// 两套模型都要钉：球模型必须与引擎逐位一致（它是引擎镜像）；WGS-84 椭球必须与暴力扫方位一致
// （「斜距工具」用的就是它，口径＝绕站一圈的最大斜距）。
console.log('\n=== 手动几何：斜距换算 ===\n')
const { slantFromAlt, altFromSlant, nadirAngleDeg, centralAngleDeg, RE_KM,
  wgs84Geometry, slantWgs84Max, altFromSlantWgs84 } = await import('../../../src/shared/slantRange.js')
const engine = createRequire(import.meta.url)('../utils/linkCalculatorNGSO.js')
const D2R = Math.PI / 180

// ① 与引擎 slantRangeFromAltitude 逐位一致——「斜距工具」算出的数与引擎跑出来的必须是同一个
let maxDiff = 0
for (const h of [300, 550, 1200, 8000, 20200, 35786]) for (let e = 0; e <= 90; e += 5) {
  maxDiff = Math.max(maxDiff, Math.abs(slantFromAlt(h, e) - engine.slantRangeFromAltitude(h, e)))
}
ok('与引擎 slantRangeFromAltitude 完全一致', maxDiff === 0, `最大差 ${maxDiff}`)

// ② 正反换算自洽：h → d → h（手动模式回填等效轨道高度靠它）
let maxRt = 0
for (const h of [550, 1200, 8000, 35786]) for (let e = 0; e <= 90; e += 3) {
  maxRt = Math.max(maxRt, Math.abs(altFromSlant(slantFromAlt(h, e), e) - h))
}
ok('h → 斜距 → h 往返自洽', maxRt < 1e-8, `最大偏差 ${maxRt.toExponential(2)} km`)

// ③ 已知刻度：天顶（ε=90°）斜距＝轨道高度；地平（ε=0°）斜距＝√(2Rh+h²)
ok('天顶斜距 = 轨道高度', Math.abs(slantFromAlt(8000, 90) - 8000) < 1e-9)
ok('地平斜距 = √(2Rh+h²)', Math.abs(slantFromAlt(8000, 0) - Math.sqrt(2 * RE_KM * 8000 + 8000 * 8000)) < 1e-9)
ok('斜距随仰角单调减', slantFromAlt(8000, 0) > slantFromAlt(8000, 10) && slantFromAlt(8000, 10) > slantFromAlt(8000, 90))

// ④ 角度：sin η = Re·cos ε /(Re+h)，且 η+γ+ε = 90°（三角形闭合）
let angBad = 0
for (const h of [550, 8000, 35786]) for (const e of [0, 5, 10, 30, 60, 90]) {
  const eta = nadirAngleDeg(h, e), gam = centralAngleDeg(h, e)
  if (Math.abs(Math.sin(eta * D2R) - (RE_KM / (RE_KM + h)) * Math.cos(e * D2R)) > 1e-12) angBad++
  if (Math.abs(eta + gam + e - 90) > 1e-9) angBad++
  if (gam < -1e-9) angBad++
}
ok('离轴角满足正弦定理 · η+γ+ε=90° · 地心角恒 ≥ 0', angBad === 0, `越界 ${angBad} 例`)
// GEO 全球波束半锥角：asin(Re/(Re+h)) = asin(6378.137/42164.137)；用赤道半径故为 8.70°（取平均半径 6371 会得 8.68°）
ok('GEO 天底半角 ≈ 8.70°', Math.abs(nadirAngleDeg(35786, 0) - 8.7005) < 0.005, `${nadirAngleDeg(35786, 0).toFixed(4)}°`)

// ⑤ 退化输入不炸
ok('高度/斜距非正 → null', slantFromAlt(0, 10) === null && slantFromAlt(NaN, 10) === null && altFromSlant(-1, 10) === null)
ok('仰角越界被夹到 [0,90]', slantFromAlt(8000, -5) === slantFromAlt(8000, 0) && slantFromAlt(8000, 120) === slantFromAlt(8000, 90))

// —— ⑧ WGS-84 椭球（斜距工具口径：绕站一圈的最大斜距）——
// 判据：闭式最大值必须与「扫遍方位取最大」逐位一致。扫方位是独立实现（geodeticToEcef + ENU 基），
// 不复用被测代码的任何中间量。
console.log('\n=== 手动几何：WGS-84 椭球（绕站一圈最大斜距）===\n')
const EA = 6378.137, EB = 6356.7523142
const EF = (EA - EB) / EA, EE2 = 2 * EF - EF * EF
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function ecefAt(latDeg, altKm) {
  const la = latDeg * D2R, N = EA / Math.sqrt(1 - EE2 * Math.sin(la) ** 2)
  return [(N + altKm) * Math.cos(la), 0, (N * (1 - EE2) + altKm) * Math.sin(la)]
}
function enuAt(latDeg) {
  const la = latDeg * D2R
  return { e: [0, 1, 0], n: [-Math.sin(la), 0, Math.cos(la)], u: [Math.cos(la), 0, Math.sin(la)] }
}
function bruteMax(latDeg, staAltKm, elevDeg, hKm, step = 0.05) {
  const P = ecefAt(latDeg, staAltKm), b = enuAt(latDeg), E = elevDeg * D2R, r = EA + hKm
  let best = -Infinity, bestAz = null
  for (let az = 0; az < 360; az += step) {
    const Z = az * D2R
    const s = [0, 1, 2].map((i) => Math.cos(E) * (Math.cos(Z) * b.n[i] + Math.sin(Z) * b.e[i]) + Math.sin(E) * b.u[i])
    const pS = dot3(P, s), c = dot3(P, P) - r * r, disc = pS * pS - c
    if (disc < 0) continue
    const d = -pS + Math.sqrt(disc)
    if (d > best) { best = d; bestAz = az }
  }
  return { d: best, az: bestAz }
}
let wErr = 0, wAzErr = 0, wN = 0
for (const lat of [-80, -45, -10, 0, 10, 23.5, 39.9042, 45, 60, 75, 89.9])
  for (const alt of [0, 1.5, 4])
    for (const el of [0, 5, 10, 25, 55])
      for (const h of [340, 550, 1200, 8000, 20200, 35786]) {
        const c = wgs84Geometry(lat, alt, el, h), b = bruteMax(lat, alt, el, h)
        wErr = Math.max(wErr, Math.abs(c.slantKm - b.d))
        wAzErr = Math.max(wAzErr, Math.min(Math.abs(c.azDeg - b.az), 360 - Math.abs(c.azDeg - b.az)))
        wN++
      }
ok('闭式最大值 = 扫遍方位的最大值', wErr < 1e-6, `${wN} 组，最大偏差 ${wErr.toExponential(2)} km`)
ok('最优方位 = 北半球正北 / 南半球正南', wAzErr <= 0.05, `最大方位偏差 ${wAzErr.toFixed(3)}°`)

// 赤道 + 海平面：椭球退化回球模型（工具的球公式正是这个特例）
let eqErr = 0
for (const el of [0, 5, 10, 30, 60, 90]) for (const h of [550, 8000, 35786]) {
  eqErr = Math.max(eqErr, Math.abs(slantWgs84Max(0, 0, el, h) - slantFromAlt(h, el)))
}
ok('赤道 + 海平面退化回球公式', eqErr < 1e-9, `最大偏差 ${eqErr.toExponential(2)} km`)

// 三角形闭合：由 γ 走余弦定理反算斜距、由 γ 走正弦定理反算 η，都必须回到解出来的那个值
let triBad = 0
for (const lat of [0, 30, 45, 60, 80]) for (const el of [0, 10, 30]) for (const h of [550, 8000, 35786]) {
  const g = wgs84Geometry(lat, 0, el, h)
  const R = g.stationRadiusKm, r = RE_KM + h, gam = g.centralDeg * D2R
  if (Math.abs(Math.sqrt(R * R + r * r - 2 * R * r * Math.cos(gam)) - g.slantKm) > 1e-6) triBad++
  if (Math.abs(Math.asin(Math.min(1, R * Math.sin(gam) / g.slantKm)) / D2R - g.nadirDeg) > 1e-6) triBad++
}
ok('三角形闭合（余弦定理反算斜距 · 正弦定理反算 η）', triBad === 0, `越界 ${triBad} 例`)

// 取最大值的意义：不会比球模型乐观（球模型用赤道半径，在高纬 LEO 上会低报几十公里）
let optimistic = 0, maxGain = 0
for (const lat of [0, 15, 30, 45, 60, 75, 89]) for (const el of [0, 5, 10, 30, 60]) for (const h of [550, 1200, 8000, 20200, 35786]) {
  const w = slantWgs84Max(lat, 0, el, h), s = slantFromAlt(h, el)
  if (w < s - 1e-9) optimistic++
  maxGain = Math.max(maxGain, w - s)
}
ok('椭球最大值恒 ≥ 球模型值（不再偏乐观）', optimistic === 0, `最多多报 ${maxGain.toFixed(1)} km`)

// 正反换算自洽：d → h → d
let wRt = 0
for (const lat of [0, 39.9042, 60, -45]) for (const el of [0, 10, 45]) for (const h of [550, 8000, 35786]) {
  const d = slantWgs84Max(lat, 0, el, h)
  wRt = Math.max(wRt, Math.abs(altFromSlantWgs84(lat, 0, el, d) - h))
}
ok('斜距 → 轨道高度 → 斜距 往返自洽', wRt < 1e-8, `最大偏差 ${wRt.toExponential(2)} km`)
ok('椭球入参无效 → null', slantWgs84Max(NaN, 0, 10, 8000) === null && slantWgs84Max(40, 0, 10, 0) === null
  && altFromSlantWgs84(40, 0, 10, -1) === null)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
