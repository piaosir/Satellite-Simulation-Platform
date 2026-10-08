// 装配落点判定 v3（2026-10-07「指到哪装到哪」）：asmSnap.socketTwoSided —— 哪些接口没有「背面」（拖入 / 拾起时两面都可选、标记两面都画）。
//
// ① 没有安装面的件（机翼、垂尾、短舱、太阳翼、反射面、馈源…）：全部接口两面——翼下发动机挂点从上方指机翼也选得上（用户 10-07 报
//    「机翼装不上发动机」的根因：挂点法向朝下、俯视时一律按背面剔掉，机翼又没有安装面，只剩「无可用安装位」）；
// ② 有安装面的件：只有落在本件对称面上、法向沿该对称面法向的横向对齐接口（机身中线上的翼根 / 平尾根）两面；
//    其余（尾吊挂点、背部 / 颔部 / 垂尾根 / 腹鳍根、星体各面心、基本体各面）仍按朝向取舍（垂尾不进腹鳍根）。
// 不联网。

import assert from 'node:assert/strict'
import * as S from '../models/asmSnap.mjs'
import { getComponent, fillParams } from '../models/components/index.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const geoOf = (type, params = {}) => S.compGeo({ type, params })
const two = (type, params = {}) => {
  const g = geoOf(type, params)
  return Object.fromEntries(g.sockets.map((s) => [s.id, S.socketTwoSided(g, s)]))
}

t('无安装面的件：全部接口两面（机翼挂点 / 翼尖、垂尾 T 尾与顶部、反射面焦点、馈源口面、太阳翼根）', () => {
  for (const [type, params] of [['air.wing', {}], ['air.wing', { engines: 2 }], ['air.wing', { side: 'left', engines: 2 }], ['air.vtail', {}], ['air.nacelle', {}],
    ['sat.reflector', { feed: 'none' }], ['sat.feed.horn', {}], ['sat.wing', {}], ['sat.thruster', {}], ['sat.array.phased', {}]]) {
    const g = geoOf(type, params)
    assert.equal(g.faces.length, 0, `${type} 没有安装面`)
    assert.ok(g.sockets.length > 0, `${type} 有接口`)
    for (const s of g.sockets) assert.equal(S.socketTwoSided(g, s), true, `${type}.${s.id}`)
  }
  const w = two('air.wing', { engines: 2 })
  assert.deepEqual(Object.keys(w).sort(), ['eng1', 'eng2', 'root', 'tip'])
})

t('机身：中线上的翼根 / 平尾根两面；尾吊挂点、背部、颔部、垂尾根、腹鳍根、尾锥、根部单面', () => {
  const f = two('air.fuselage')
  assert.equal(f.wing, true)
  assert.equal(f.htail, true)
  for (const id of ['aftEng', 'crown', 'chin', 'vtail', 'ventral', 'tail', 'root']) assert.equal(f[id], false, id)
})

t('有安装面的卫星件 / 基本体：面心接口一律单面（星体、塔、基本体盒）', () => {
  for (const type of ['sat.bus.box', 'sat.bus.cyl', 'sat.bus.hex', 'sat.tower', 'prim.box', 'prim.cyl']) {
    const g = geoOf(type)
    assert.ok(g.faces.length > 0, `${type} 有安装面`)
    for (const s of g.sockets) assert.equal(S.socketTwoSided(g, s), false, `${type}.${s.id}`)
  }
})

t('判据只看几何：对称面上但法向不沿对称面法向的接口单面；不带对称面声明的件单面；空输入 false', () => {
  const g = geoOf('sat.bus.box')
  // 盒的 +Z 面心在两个对称面上（x = y = 0），法向 +Z 不沿任一对称面法向
  const z = g.sockets.find((s) => s.id === '+Z')
  assert.ok(z && Math.abs(z.pos[0]) < 1e-12 && Math.abs(z.pos[1]) < 1e-12)
  assert.equal(S.socketTwoSided(g, z), false)
  // 同一个接口挪到 xz 对称面上、法向改沿 ±Y = 横向对齐接口
  assert.equal(S.socketTwoSided(g, { ...z, n: [0, 1, 0] }), true)
  assert.equal(S.socketTwoSided(g, { ...z, n: [0, -1, 0] }), true)
  // 离开对称面一点就不算
  assert.equal(S.socketTwoSided(g, { ...z, pos: [0, 1e-3, z.pos[2]], n: [0, 1, 0] }), false)
  // 没有对称面声明（只给面、不给 symmetricPlanes）
  const bare = { def: { ...getComponent('sat.bus.box'), symmetricPlanes: undefined }, params: fillParams(getComponent('sat.bus.box'), {}), sockets: g.sockets, faces: g.faces }
  assert.equal(S.socketTwoSided(bare, { ...z, n: [0, 1, 0] }), false)
  assert.equal(S.socketTwoSided(null, z), false)
  assert.equal(S.socketTwoSided(g, null), false)
})

console.log(`modelAsmTwoSided: ${n} 项通过`)
