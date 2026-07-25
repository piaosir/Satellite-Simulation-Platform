// 链路场景描述子（三窗归一的「谁在哪儿、谁连谁」）自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/lbLinkScene.js），故本测试自身也是 .mjs。
//
// 重点在 satForSide：地理图的覆盖门靠它取「被扫那一端连的是哪颗星」，取错就画错半个球。
//   ① 必须按【腿】找，不能笼统取第一颗星——闭式球面会摆出上/下行两颗；
//   ② 方位是示意的场景（schematicSat）一律不给星位：拿一个编出来的方位去画覆盖圈，
//      比不画更误导；
//   ③ GEO / NGSO 有真星下点时，给出的就是详细预算所依的那一颗、那一瞬间。
import { buildGeoScene, buildNgsoScene, satForSide } from '../../../src/shared/lbLinkScene.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

console.log('=== 链路场景描述子（覆盖门取星位）测试 ===\n')

const LP = { longitude: '116.4', latitude: '39.9', rxLongitude: '121.5', rxLatitude: '31.2', orbitAltitude: '1200' }
const DATA = { elevationResult: '30.0', rxElevationResult: '35.0', slantRangeResult: '38000', rxSlantRangeResult: '37800', azimuthResult: '200', rxAzimuthResult: '210' }

// ① GEO：定点轨位一枚，两端都连它
{
  const scene = buildGeoScene({ error: null, data: DATA, txName: '发', rxName: '收' },
    { linkParams: LP, satParams: { satelliteName: 'X', orbitPosition: '110.5' } })
  ok('GEO 场景建得出', !!scene && scene.nodes.length === 3)
  const tx = satForSide(scene, 'tx'), rx = satForSide(scene, 'rx')
  ok('GEO 发端取到定点星', !!tx && tx.lon === 110.5 && tx.lat === 0 && tx.alt === 35786, JSON.stringify(tx))
  ok('GEO 收端取到同一颗星', !!rx && rx.lon === tx.lon && rx.alt === tx.alt)
}

// ② NGSO 有真星下点（选星 → t*）：两端取的是同一颗、同一瞬间，与详细预算一致
{
  const geom = {
    feasible: true, method: 'SGP4', subSat: { lonDeg: 118.2, latDeg: 35.6, altKm: 1200 },
    worst: { up: { elevDeg: 12, slantKm: 2600, altKm: 1200 }, dn: { elevDeg: 18, slantKm: 2200, altKm: 1200 } }
  }
  const scene = buildNgsoScene({ error: null, data: DATA, txName: '发', rxName: '收', geom },
    { linkParams: LP, satParams: { satelliteName: 'L' } })
  const tx = satForSide(scene, 'tx')
  ok('NGSO t* 星下点即覆盖门的星位', !!tx && tx.lon === 118.2 && tx.lat === 35.6 && tx.alt === 1200, JSON.stringify(tx))
  ok('NGSO 两端同一颗星', JSON.stringify(tx) === JSON.stringify(satForSide(scene, 'rx')))
}

// ③ NGSO 手动圆轨道（闭式球面）：星位方位是示意的 → 不给覆盖门用
{
  const geom = {
    feasible: true, method: '闭式球面',
    worst: { up: { elevDeg: 10, slantKm: 3000, altKm: 1200 }, dn: { elevDeg: 25, slantKm: 2000, altKm: 1200 } }
  }
  const scene = buildNgsoScene({ error: null, data: DATA, txName: '发', rxName: '收', geom },
    { linkParams: LP, satParams: { satelliteName: 'L' } })
  ok('闭式球面场景仍然画得出（链路视图要用）', !!scene && scene.nodes.length >= 3)
  ok('闭式球面标了 schematicSat', !!scene && scene.schematicSat === true)
  ok('示意星位不喂给覆盖门（发端）', satForSide(scene, 'tx') === null)
  ok('示意星位不喂给覆盖门（收端）', satForSide(scene, 'rx') === null)
}

// ④ 一站一星的场景（再生式上行/下行只有一端在地面）：另一端问不出星位，不能瞎给
{
  const scene = {
    nodes: [{ id: 'tx', kind: 'station', role: 'tx', lonDeg: 116, latDeg: 40, altKm: 0 },
      { id: 'sat', kind: 'sat', role: 'sat', lonDeg: 118, latDeg: 35, altKm: 700 }],
    legs: [{ from: 'tx', to: 'sat', dir: 'up' }]
  }
  ok('单站场景取得到本端星位', JSON.stringify(satForSide(scene, 'tx')) === JSON.stringify({ lon: 118, lat: 35, alt: 700 }))
  ok('场景里没有的那一端返回 null', satForSide(scene, 'rx') === null)
}

// ⑤ 两颗星并存时必须按腿分辨（本不变式护的是「取错星就画错半个球」）
{
  const scene = {
    nodes: [{ id: 'tx', kind: 'station', role: 'tx', lonDeg: 116, latDeg: 40, altKm: 0 },
      { id: 'rx', kind: 'station', role: 'rx', lonDeg: 121, latDeg: 31, altKm: 0 },
      { id: 'satU', kind: 'sat', role: 'sat', lonDeg: 100, latDeg: 20, altKm: 800 },
      { id: 'satD', kind: 'sat', role: 'sat', lonDeg: 140, latDeg: -20, altKm: 900 }],
    legs: [{ from: 'tx', to: 'satU', dir: 'up' }, { from: 'satD', to: 'rx', dir: 'down' }]
  }
  ok('发端连的是上行那颗', satForSide(scene, 'tx').lon === 100)
  ok('收端连的是下行那颗', satForSide(scene, 'rx').lon === 140)
}

// ⑥ 空/残缺输入不抛错（图表区在未计算时也会问一次）
{
  ok('无场景返回 null', satForSide(null, 'tx') === null)
  ok('缺 legs 返回 null', satForSide({ nodes: [] }, 'tx') === null)
}

// ⑦ 几何取的是**引擎回填的结果**，入参只作兜底。
// 引擎对空入参有自己的兜底（轨位空 → 110.5°E、站址空 → 北京）并把实际用的值回填进结果；
// 若这里照着入参重解一遍，就会出现「表里算出了整份预算、图上却一片空白」。
{
  const D = {
    ...DATA,
    earthLongitudeResult: '121.4737', earthLatitudeResult: '31.2304',
    rxLongitudeResult: '113.2644', rxLatitudeResult: '23.1291',
    orbitPositionResult: 92.2
  }
  // 入参里轨位与站址全是空串（用户清空了「定点轨道经度」等，引擎照默认值算完了）
  const scene = buildGeoScene({ error: null, data: D, txName: '发', rxName: '收' },
    { linkParams: { longitude: '', latitude: '', rxLongitude: '', rxLatitude: '' }, satParams: { satelliteName: 'X', orbitPosition: '' } })
  ok('入参为空但结果有回填 → 场景照样建得出', !!scene && Array.isArray(scene.nodes) && scene.nodes.length === 3)
  const sat = satForSide(scene, 'tx')
  ok('轨位取引擎实际用的那个值', !!sat && sat.lon === 92.2, JSON.stringify(sat))
  const tx = scene.nodes.find((n) => n.id === 'tx')
  ok('站址取引擎回填的经纬度', !!tx && tx.lonDeg === 121.4737 && tx.latDeg === 31.2304, JSON.stringify(tx))
}

// ⑧ 几何真缺料时不是「没算」，而是「算了但画不出」——要说得出缺的是哪一项
{
  const s = buildGeoScene({ error: null, data: { ...DATA }, txName: '发', rxName: '收' },
    { linkParams: { longitude: '116.4', latitude: '39.9', rxLongitude: '121.5', rxLatitude: '31.2' }, satParams: {} })
  ok('缺轨位 → 给出原因而不是 null', !!s && s.blocked === '取不到卫星定点轨道经度', JSON.stringify(s))
  ok('缺料场景不喂给覆盖门', satForSide(s, 'tx') === null)
  ok('没算过仍然返回 null', buildGeoScene(null, null) === null)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
