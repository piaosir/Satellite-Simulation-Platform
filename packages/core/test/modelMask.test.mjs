// 本体遮挡掩模（packages/core/models/mask.mjs）：D2 角坐标、编解码、统计、签名，以及「长方体 + 一个挂点」解析遮挡逐格比对。
//
//   真值有两套、互不依赖：
//     boxMask（slab 法射线-长方体求交，模块自带，也是 Worker BVH 版的对拍参照）
//     faceMask（本测试里按「射线与盒面平面求交 + 面内判定」逐面写的解析式）
//   两者逐格比 blocked（65160 格全等）与 clearance（Float32 相对误差 < 1e-6）。
//   另用「盒顶面对远处挂点的立体角」闭式验证 maskStats 的立体角加权（1° 离散误差报数）。

import assert from 'node:assert/strict'
import {
  MASK_W, MASK_H, MASK_N, MASK_BYTES, MASK_HEADER_BYTES, MASK_RAY_OFFSET_M, SUN_SCAN_BINS,
  maskIndex, maskAzEl, maskCell, maskDir, cellSolidAngle, createMask, maskLookup, maskClearance,
  encodeMask, decodeMask, maskStats, maskSignature, maskRayOrigin, buildMask, rayAabb, boxMask,
  sunScanBin, sunScanAngleDeg, maskToCsv
} from '../models/mask.mjs'
import { DEFAULT_Q_MODEL2BODY as Q0 } from '../models/bodyFrame.mjs'   // 签名用例里的 frame 取出厂映射（不写死数字）

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const D2R = Math.PI / 180
let seed = 424242
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

t('常量：360 × 181、文件 325816 B、头 16 B、射线偏移 1 cm、对日扫描 12 档', () => {
  assert.equal(MASK_W, 360); assert.equal(MASK_H, 181); assert.equal(MASK_N, 65160)
  assert.equal(MASK_BYTES, 325816); assert.equal(MASK_HEADER_BYTES, 16); assert.equal(MASK_RAY_OFFSET_M, 0.01)
  assert.equal((MASK_HEADER_BYTES + MASK_N) % 4, 0, 'Float32 段对齐')
  assert.equal(SUN_SCAN_BINS, 12)
})

t('D2 方向：+X → (0,0)、+Y → az 90、−X → 180、−Y → 270、+Z（天底）→ el +90 行、−Z → el −90 行', () => {
  const idx = (az, el) => (el + 90) * 360 + az
  assert.equal(maskIndex([1, 0, 0]), idx(0, 0))
  assert.equal(maskIndex([0, 1, 0]), idx(90, 0))
  assert.equal(maskIndex([-1, 0, 0]), idx(180, 0))
  assert.equal(maskIndex([0, -1, 0]), idx(270, 0))
  assert.equal(Math.floor(maskIndex([0, 0, 1]) / 360), 180)
  assert.equal(Math.floor(maskIndex([0, 0, -1]) / 360), 0)
  assert.equal(maskIndex([0, 0, 0]), -1, '零向量')
  assert.equal(maskIndex([NaN, 0, 1]), -1, 'NaN')
  assert.equal(maskIndex({ x: 0, y: 5, z: 0 }), idx(90, 0), '{x,y,z} 与未归一')
  const ae = maskAzEl([0, -1, 1]); near(ae.az, 270, 1e-12, 'az'); near(ae.el, 45, 1e-12, 'el')
})

t('整度格心的舍入边界：az 359.6 → 0、0.49 → 0、0.51 → 1；el 89.4 → 179 行、89.6 → 极点行', () => {
  const dir = (az, el) => [Math.cos(el * D2R) * Math.cos(az * D2R), Math.cos(el * D2R) * Math.sin(az * D2R), Math.sin(el * D2R)]
  assert.equal(maskIndex(dir(359.6, 10)) % 360, 0)
  assert.equal(maskIndex(dir(0.49, 10)) % 360, 0)
  assert.equal(maskIndex(dir(0.51, 10)) % 360, 1)
  assert.equal(Math.floor(maskIndex(dir(33, 89.4)) / 360), 179)
  assert.equal(Math.floor(maskIndex(dir(33, 89.6)) / 360), 180)
  assert.equal(Math.floor(maskIndex(dir(33, -89.6)) / 360), 0)
})

t('maskDir ↔ maskIndex 逐格回环（65160 格；极点行整行落在同一行）；maskCell', () => {
  const d = [0, 0, 0], c = {}
  for (let e = 0; e < MASK_H; e++) {
    for (let a = 0; a < MASK_W; a++) {
      maskDir(a, e, d)
      near(Math.hypot(...d), 1, 1e-15, '单位长')
      const i = maskIndex(d)
      if (e === 0 || e === MASK_H - 1) { assert.equal(Math.floor(i / 360), e); assert.deepEqual(d, [0, 0, e === 0 ? -1 : 1]) }
      else assert.equal(i, e * 360 + a, `(${a},${e})`)
      maskCell(e * 360 + a, c)
      assert.equal(c.azIdx, a); assert.equal(c.elIdx, e); assert.equal(c.el, e - 90)
    }
  }
})

t('格立体角：全表 Σ = 4π（1e-12）；极点行格 = Δaz·(1 − sin 89.5°)', () => {
  let s = 0
  for (let e = 0; e < MASK_H; e++) s += cellSolidAngle(e) * MASK_W
  near(s, 4 * Math.PI, 1e-12, 'Σ')
  near(cellSolidAngle(0), D2R * (1 - Math.sin(89.5 * D2R)), 1e-18, '极点格')
  near(cellSolidAngle(90), D2R * 2 * Math.sin(0.5 * D2R), 1e-18, '赤道格')
})

t('encode / decode 逐字节回环；头 = SMSK / 1 / 360 / 181（小端）；坏头 / 截断 → null', () => {
  const m = createMask()
  for (let i = 0; i < MASK_N; i++) { if (rnd() < 0.3) { m.blocked[i] = 1; m.clearance[i] = Math.fround(rnd() * 20) } }
  const b = encodeMask(m)
  assert.equal(b.byteLength, MASK_BYTES)
  assert.equal(String.fromCharCode(b[0], b[1], b[2], b[3]), 'SMSK')
  const dv = new DataView(b.buffer)
  assert.equal(dv.getUint32(4, true), 1); assert.equal(dv.getUint32(8, true), 360); assert.equal(dv.getUint32(12, true), 181)
  const m2 = decodeMask(b)
  assert.deepEqual(Array.from(m2.blocked), Array.from(m.blocked))
  for (let i = 0; i < MASK_N; i++) assert.ok(Object.is(m2.clearance[i], m.clearance[i]), `clearance[${i}]`)
  assert.deepEqual(encodeMask(m2), b, '二次编码逐字节相同')
  assert.ok(decodeMask(b.buffer), 'ArrayBuffer')
  assert.ok(decodeMask(new DataView(b.buffer)), 'DataView')
  const bad = b.slice(); bad[0] = 0x58
  assert.equal(decodeMask(bad), null, '魔数')
  const bad2 = b.slice(); new DataView(bad2.buffer).setUint32(4, 2, true)
  assert.equal(decodeMask(bad2), null, '版本')
  assert.equal(decodeMask(b.subarray(0, MASK_BYTES - 1)), null, '截断')
  assert.equal(decodeMask(null), null)
})

t('maskStats：全遮挡 = 4π / 比例 1；半空间 el < 0 = (1 − sin 0.5°)/2；空掩模比例 0、最小净空 null', () => {
  const full = createMask(); full.blocked.fill(1); full.clearance.fill(2.5)
  const s = maskStats(full); near(s.blockedFrac, 1, 1e-14, 'full'); near(s.blockedSr, 4 * Math.PI, 1e-12, 'sr'); assert.equal(s.minClearanceM, 2.5)
  const half = buildMask((d) => (d[2] < -1e-12 ? 1 : Infinity))
  near(maskStats(half).blockedFrac, (1 - Math.sin(0.5 * D2R)) / 2, 1e-14, 'half')
  const s0 = maskStats(createMask()); assert.equal(s0.blockedFrac, 0); assert.equal(s0.minClearanceM, null)
})

// ───────────────────────── 长方体 + 一个挂点：解析逐格比对 ─────────────────────────
const BOX = { min: [-1, -0.8, -0.6], max: [1, 0.8, 0.6] }        // 2 × 1.6 × 1.2 m 的平台
// 逐面写的解析真值：射线 o + t·d 与六个面所在平面求交，交点落在面内（含边）取最小 t。与 slab 法完全不同的写法。
function faceHit(o, d, box) {
  let best = Infinity
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) continue
    for (const plane of [box.min[k], box.max[k]]) {
      const tt = (plane - o[k]) / d[k]
      if (!(tt >= 0)) continue
      let inside = true
      for (let j = 0; j < 3; j++) {
        if (j === k) continue
        const p = o[j] + tt * d[j]
        if (p < box.min[j] || p > box.max[j]) { inside = false; break }
      }
      if (inside && tt < best) best = tt
    }
  }
  return best
}
function faceMask(o, box) { return buildMask((d) => faceHit(o, d, box)) }
function edgeMargin(o, d, box) {                          // 离「擦边」多远：命中点到所在面边界的最小距离（判定对歧义格）
  let m = Infinity
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) continue
    for (const plane of [box.min[k], box.max[k]]) {
      const tt = (plane - o[k]) / d[k]
      if (!(tt >= 0)) continue
      for (let j = 0; j < 3; j++) { if (j === k) continue; const p = o[j] + tt * d[j]; m = Math.min(m, Math.abs(p - box.min[j]), Math.abs(p - box.max[j])) }
    }
  }
  return m
}

function compareMasks(a, b, o, box, label) {
  let mism = 0, amb = 0, worstRel = 0
  const d = [0, 0, 0]
  for (let i = 0; i < MASK_N; i++) {
    if (a.blocked[i] !== b.blocked[i]) {
      maskDir(i % 360, Math.floor(i / 360), d)
      if (edgeMargin(o, d, box) < 1e-9) amb++; else mism++
      continue
    }
    if (a.blocked[i]) worstRel = Math.max(worstRel, Math.abs(a.clearance[i] - b.clearance[i]) / Math.max(1e-9, b.clearance[i]))
  }
  assert.equal(mism, 0, `${label}：${mism} 格不一致`)
  assert.ok(worstRel < 1e-6, `${label}：净空相对误差 ${worstRel}`)
  return { amb, worstRel }
}

t('长方体 + 顶面（+Z 天底板）挂点：slab 真值与逐面解析逐格全等；朝盒面必遮挡、背离必通畅', () => {
  const pos = [0.3, -0.2, 0.6], o = maskRayOrigin(pos, [0, 0, 1])
  assert.deepEqual(o, [0.3, -0.2, 0.61])
  const a = boxMask(BOX, o), b = faceMask(o, BOX)
  const r = compareMasks(a, b, o, BOX, '顶面')
  const d = [0, 0, 0]
  let upBlocked = 0, downMiss = 0
  for (let i = 0; i < MASK_N; i++) {
    maskDir(i % 360, Math.floor(i / 360), d)
    if (d[2] >= 0 && a.blocked[i]) upBlocked++                          // 背离盒面（el ≥ 0）必通畅
    // 朝盒面：落点在顶面内（离边 > 1 mm）必遮挡，且净空 = 0.01 / |d_z|
    if (d[2] < 0) {
      const tt = 0.01 / -d[2], x = o[0] + tt * d[0], y = o[1] + tt * d[1]
      if (Math.abs(x) < 0.999 && Math.abs(y) < 0.799) {
        if (!a.blocked[i]) downMiss++
        else near(a.clearance[i], tt, tt * 1e-6, `净空 ${i}`)
      }
    }
  }
  assert.equal(upBlocked, 0, '上半球有遮挡'); assert.equal(downMiss, 0, '朝盒面漏判')
  assert.equal(maskLookup(a, [0, 0, -1]), 1, '正下方（天顶方向）遮挡')
  assert.equal(maskLookup(a, [0, 0, 1]), 0, '视轴方向通畅')
  near(maskClearance(a, [0, 0, -1]), 0.01, 1e-9, '正下方净空 1 cm')
  const st = maskStats(a)
  near(st.minClearanceM, 0.01, 1e-9, '最小净空 = 射线偏移')
  console.log(`  顶面挂点：遮挡立体角比例 ${st.blockedFrac.toFixed(5)}（半球 = ${((1 - Math.sin(0.5 * D2R)) / 2).toFixed(5)}），擦边歧义格 ${r.amb}，净空相对误差 ${r.worstRel.toExponential(2)}`)
})

t('长方体 + 侧面（+X）挂点：朝 −X 的方向（d_x < −0.05）全遮挡、d_x > 0 全通畅；与逐面解析全等', () => {
  const pos = [1, 0.1, -0.2], o = maskRayOrigin(pos, [1, 0, 0])
  const a = boxMask(BOX, o), b = faceMask(o, BOX)
  compareMasks(a, b, o, BOX, '侧面')
  const d = [0, 0, 0]
  for (let i = 0; i < MASK_N; i++) {
    maskDir(i % 360, Math.floor(i / 360), d)
    if (d[0] > 0) assert.equal(a.blocked[i], 0, `背离 ${i}`)
    if (d[0] < -0.05) assert.equal(a.blocked[i], 1, `朝向 ${i}`)
  }
})

t('长方体 + 远处挂点（顶面上方 2.4 m，杆装）：遮挡立体角 = 顶面矩形立体角闭式（1° 离散误差 < 3%，报数）', () => {
  const rows = []
  for (const h of [1.2, 2.4, 6]) {
    const pos = [0, 0, 0.6 + h], o = maskRayOrigin(pos, [0, 0, 1])
    const a = boxMask(BOX, o), b = faceMask(o, BOX)
    compareMasks(a, b, o, BOX, `h=${h}`)
    const dist = o[2] - 0.6, A = 2, B = 1.6
    const omega = 4 * Math.asin((A * B) / Math.sqrt((A * A + 4 * dist * dist) * (B * B + 4 * dist * dist)))
    const st = maskStats(a)
    const rel = (st.blockedSr - omega) / omega
    assert.ok(Math.abs(rel) < 0.03, `h=${h}：${st.blockedSr} vs ${omega}`)
    near(st.minClearanceM, dist, 1e-6, '最小净空 = 到顶面距离')
    rows.push(`h=${h} m：掩模 ${st.blockedSr.toFixed(4)} sr / 闭式 ${omega.toFixed(4)} sr（${(rel * 100).toFixed(2)}%）`)
  }
  console.log('  ' + rows.join('；'))
})

t('多盒（平台 + 一块反射面板）：取最近命中；buildMask 极点行整行同值', () => {
  const panel = { min: [1.2, -0.05, -1.5], max: [2.4, 0.05, 1.5] }
  const o = maskRayOrigin([1, 0, 0], [1, 0, 0])
  const a = boxMask([BOX, panel], o)
  assert.equal(maskLookup(a, [1, 0, 0]), 1, '正前方被反射面板挡住')
  near(maskClearance(a, [1, 0, 0]), 1.2 - 1.01, 1e-6, '到面板距离')
  for (const e of [0, 180]) for (let az = 1; az < 360; az++) {
    assert.equal(a.blocked[e * 360 + az], a.blocked[e * 360]); assert.ok(Object.is(a.clearance[e * 360 + az], a.clearance[e * 360]))
  }
})

t('rayAabb：盒内起点 → 0；背后的盒 → ∞；分量为 0 的方向不出 NaN；恰擦边算命中', () => {
  assert.equal(rayAabb([0, 0, 0], [1, 0, 0], BOX.min, BOX.max), 0)
  assert.equal(rayAabb([3, 0, 0], [1, 0, 0], BOX.min, BOX.max), Infinity)
  assert.equal(rayAabb([3, 0, 0], [-1, 0, 0], BOX.min, BOX.max), 2)
  assert.equal(rayAabb([3, 0.8, 0], [-1, 0, 0], BOX.min, BOX.max), 2, '擦边（y 恰在面上）')
  assert.equal(rayAabb([3, 0.81, 0], [-1, 0, 0], BOX.min, BOX.max), Infinity)
})

t('maskSignature：确定、键序 / 排除节点次序无关；关节值差 1e-3 变、差 1e-9 不变；q 与 −q 同签名；位置变就变', () => {
  const base = { modelSha: 'ab'.repeat(32), lod: 'lod1', frame: { q_model2body: Q0, t_model2body: [0, 0, 0.1] }, articulations: { 'wing_+Y': { rotate: 30 } }, mountPos: [1, 0, 1.6], excludeNodes: ['b', 'a'] }
  const s = maskSignature(base)
  assert.match(s, /^[0-9a-f]{16}$/)
  assert.equal(maskSignature({ ...base }), s)
  assert.equal(maskSignature({ excludeNodes: ['a', 'b', 'a'], mountPos: [1, 0, 1.6], articulations: { 'wing_+Y': { rotate: 30 } }, frame: { t_model2body: [0, 0, 0.1], q_model2body: Q0 }, lod: 'lod1', modelSha: 'ab'.repeat(32) }), s, '键序')
  assert.equal(maskSignature({ ...base, frame: { ...base.frame, q_model2body: Q0.map((x) => -x) } }), s, 'q 与 −q')
  assert.equal(maskSignature({ ...base, articulations: { 'wing_+Y': { rotate: 30 + 1e-9 } } }), s, '1e-9 抖动')
  assert.notEqual(maskSignature({ ...base, articulations: { 'wing_+Y': { rotate: 30.001 } } }), s, '关节值')
  assert.notEqual(maskSignature({ ...base, mountPos: [1, 0, 1.61] }), s, '位置')
  assert.notEqual(maskSignature({ ...base, lod: 'lod2' }), s, 'LOD')
  assert.notEqual(maskSignature({ ...base, sunBin: 3 }), s, '对日扫描档')
  assert.notEqual(maskSignature({ ...base, noObscurationNodes: ['x'] }), s, '不遮挡节点')
  assert.match(maskSignature(), /^[0-9a-f]{16}$/, '空入参不抛')
})

t('maskSignature 含视轴（射线起点 = 位置 + 1 cm·视轴）：视轴翻面签名变；不给视轴与改前逐字相同；起点相同的两组（位置, 视轴）同签名', () => {
  // 改前（只有位置进签名）的值钉在这里：不给视轴的调用方签名不变，已落盘的 .bin 不失效
  const pin = { modelSha: 'cd'.repeat(32), lod: 'lod0', frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0.25, 0, 0] }, articulations: { SADA: 45 }, mountPos: [0.3, -0.2, 0.6], excludeNodes: ['horn'] }
  assert.equal(maskSignature(pin), 'd7ed61184913957e', '不给视轴 = 改前签名')
  assert.equal(maskSignature({ ...pin, mountBoresight: [0, 0, 0] }), 'd7ed61184913957e', '零长视轴按不外推（与 Worker 同）')
  assert.equal(maskSignature({ ...pin, mountBoresight: [NaN, 0, 1] }), 'd7ed61184913957e', '非法视轴按不外推')
  const up = maskSignature({ ...pin, mountBoresight: [0, 0, 1] })
  assert.notEqual(up, maskSignature(pin), '给了视轴，起点外推 1 cm')
  assert.notEqual(maskSignature({ ...pin, mountBoresight: [0, 0, -1] }), up, '视轴翻面')
  assert.equal(maskSignature({ ...pin, mountBoresight: [0, 0, 5] }), up, '视轴长度无关')
  assert.equal(maskSignature({ ...pin, boresightBody: [0, 0, 1] }), up, 'boresightBody 写法')
  assert.equal(maskSignature({ ...pin, dirBody: [0, 0, 1] }), up, 'dirBody 写法')
  assert.equal(maskSignature({ ...pin, mountBoresight: [1e-9, 0, 1] }), up, '视轴 1e-9 抖动（起点差 1e-11 m）')
  assert.equal(maskSignature({ ...pin, mountPos: [0.3, -0.2, 0.61] }), up, '起点相同 → 掩模逐格相同 → 同签名')
  // 审查实测场景：盒顶面挂点，视轴 +Z 与倾到 95°（指进盒面）——起点一个在盒外一个在盒内，掩模完全不同，签名必须不同
  const pos = [0.3, -0.2, 0.6], tilt = [Math.sin(95 * D2R), 0, Math.cos(95 * D2R)]
  const mUp = boxMask(BOX, maskRayOrigin(pos, [0, 0, 1])), mIn = boxMask(BOX, maskRayOrigin(pos, tilt))
  const fu = maskStats(mUp).blockedFrac, fi = maskStats(mIn).blockedFrac
  let flipped = 0
  for (let i = 0; i < MASK_N; i++) if (mUp.blocked[i] !== mIn.blocked[i]) flipped++
  near(fi, 1, 1e-12, '起点进盒 → 全遮挡')
  assert.ok(fu > 0.45 && fu < 0.55 && flipped > 30000, `视轴 +Z 遮挡比例 ${fu}，翻转 ${flipped} 格`)
  assert.notEqual(maskSignature({ ...pin, mountPos: pos, mountBoresight: [0, 0, 1] }), maskSignature({ ...pin, mountPos: pos, mountBoresight: tilt }), '两次签名不同')
  console.log(`  视轴 +Z → 95°：遮挡比例 ${fu.toFixed(4)} → ${fi.toFixed(4)}，翻转 ${flipped} 格，签名随之改变`)
})

t('对日扫描档：0° → 0、29° → 1、−31° → 11、180° → 6；档角 (−180, 180]', () => {
  assert.equal(sunScanBin(0), 0); assert.equal(sunScanBin(29), 1); assert.equal(sunScanBin(-31), 11); assert.equal(sunScanBin(180), 6); assert.equal(sunScanBin(-180), 6)
  assert.equal(sunScanBin(NaN), 0)
  for (let k = 0; k < 12; k++) { const a = sunScanAngleDeg(k); assert.ok(a > -180 && a <= 180); assert.equal(sunScanBin(a), k) }
})

t('maskToCsv：表头 + 65160 行、行序同下标、通畅格净空留空', () => {
  const o = maskRayOrigin([0.3, -0.2, 0.6], [0, 0, 1])
  const a = boxMask(BOX, o)
  const lines = maskToCsv(a).trimEnd().split('\n')
  assert.equal(lines[0], 'az,el,blocked,clearanceM')
  assert.equal(lines.length, MASK_N + 1)
  assert.equal(lines[1].split(',').slice(0, 3).join(','), '0,-90,1')
  assert.equal(lines[MASK_N], '359,90,0,')
})

t('maskLookup / maskClearance：掩模缺失或方向非法 → 通畅', () => {
  assert.equal(maskLookup(null, [1, 0, 0]), 0)
  assert.equal(maskClearance(null, [1, 0, 0]), Infinity)
  const m = createMask(); m.blocked.fill(1)
  assert.equal(maskLookup(m, [0, 0, 0]), 0)
})

console.log(`modelMask: ${n} 项通过`)
