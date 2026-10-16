// 同网格多波束共用投影（src/viz/grd/coverage.js projectGridShared）与逐波束各自 projectGrid 逐位对拍：
//  ① 同一指向下，几个波束各按自己的热区盒取投影（盒互相重叠 / 不重叠 / 整网格 / 空盒），四个数组整份逐位相同
//     （盒外照旧不写：同一 out 反复复用时盒外留的陈值也一致）
//  ② 指向变了（key 变）共享表作废重算，结果仍与现算逐位相同
//  ③ 网格参数相同、对象不同的两张网格（多波束文件里每个波束一份 grid 对象）共用一张表，结果逐位相同
//  ④ igrid 换了（key 带 igrid）不串表
import { projectGrid, projectGridShared, projShare, antennaBasis } from '../../../src/viz/grd/coverage.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }
const same = (a, b) => {
  if (a.lon.length !== b.lon.length) return false
  for (const k of ['lon', 'lat', 'slant', 'vis']) {
    const x = new Uint32Array(a[k].buffer, a[k].byteOffset, a[k].length), y = new Uint32Array(b[k].buffer, b[k].byteOffset, b[k].length)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  }
  return a.NX === b.NX && a.NY === b.NY && JSON.stringify(a.box) === JSON.stringify(b.box)
}
const mkSet = () => ({ XS: -0.16, YS: -0.15, XE: 0.17, YE: 0.155, NX: 181, NY: 171 })
const boxes = [
  { r0: 10, r1: 80, c0: 20, c1: 90 },
  { r0: 50, r1: 120, c0: 60, c1: 170 },     // 与上一个部分重叠
  { r0: 140, r1: 170, c0: 0, c1: 30 },      // 不重叠、贴边
  null,                                      // 整网格（路损档不裁剪）
  { r0: 0, r1: -1, c0: 0, c1: -1 },          // 空盒（无覆盖）
  { r0: 30, r1: 60, c0: 40, c1: 70 }         // 完全落在已算区域里
]

for (const igrid of [1, 6]) {
  const share = projShare()
  const sets = boxes.map(() => mkSet())               // ③ 每个波束一份网格对象，参数相同
  const basisA = antennaBasis(110.5, 112, 18, 5, 0.03, 35786)
  const basisB = antennaBasis(110.5, 108, 25, -3, 0.03, 35786)
  for (const [tag, basis, key] of [['指向 A', basisA, 'A|' + igrid], ['指向 B', basisB, 'B|' + igrid], ['回到指向 A', basisA, 'A|' + igrid]]) {
    let allSame = true
    const outsD = [], outsS = []
    for (let i = 0; i < boxes.length; i++) {
      // 同一 out 复用两轮（模拟拖拽中逐帧原地重投影）：盒外的陈值两边也必须一致
      outsD[i] = projectGrid(sets[i], igrid, basis, boxes[i], outsD[i] || null, true)
      outsS[i] = projectGridShared(share, key, sets[i], igrid, basis, boxes[i], outsS[i] || null, true)
      if (!same(outsD[i], outsS[i])) allSame = false
    }
    ok(allSame, `igrid ${igrid} · ${tag}：6 个波束的共享投影与各自 projectGrid 逐位相同`)
  }
}

// ④ 同一张表、换 igrid：key 不同即重算，不拿 igrid=1 的值答 igrid=6
{
  const share = projShare(), set = mkSet(), basis = antennaBasis(87.5, 90, 20, 0, 0, 35786)
  projectGridShared(share, 'K|1', set, 1, basis, null, null, true)
  const s6 = projectGridShared(share, 'K|6', set, 6, basis, null, null, true)
  const d6 = projectGrid(set, 6, basis, null, null, true)
  ok(same(s6, d6), '④ 换 igrid 后与现算逐位相同（不串表）')
}

if (fails) { console.log(`\n${fails} 项失败`); process.exit(1) } else console.log('\n全部通过')
