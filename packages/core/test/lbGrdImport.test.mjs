// 链路预算「直接导入方向图」的存储与合并自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/lbGrdImport.js + src/{linkbudget,ngso}/grdParam.js），故本测试也是 .mjs。
//
// 关键不变式：
//   ① 本模块导入的天线单独存在 lb/grdSats —— 「星座3D」页整体覆盖式保存 globe3d/settings 时不能把它冲掉
//      （这正是不写进那棵树的原因，写进去就会静默丢数据）；
//   ② loadSatTree 把两边合并：3D 页导入的（可作轨道来源）与本模块导入的（local:true，只有方向图）都能选；
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
const { localFolderFor, isLocalFolder, localTreeNodes, syncLocalNode } = await import('../../../src/shared/lbGrdImport.js')
const geo = await import('../../../src/linkbudget/grdParam.js')
const ngso = await import('../../../src/ngso/grdParam.js')

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
ok('NGSO 树 = 3D 页 + 本模块', tNgso.sats.length === 2 && tNgso.sats.some((s) => s.folder === 'lb:sat1'))
ok('NGSO 里 local 节点仍标 local（选中时只改方向图、不动轨道来源）',
  tNgso.sats.find((s) => s.folder === 'lb:sat1').local === true)

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

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
