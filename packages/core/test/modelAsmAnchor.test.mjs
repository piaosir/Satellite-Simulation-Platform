// 带锚安装（偏移 / 倾角）、安装端候选、取锚与保位姿命令、候选净化（2026-10 设计页交互重构任务书 §3.3.1）单测。
//
// ① 基线对拍：12 个整星模板（specToAssembly 归一件 + satSpecToComps 原始件）与 23 个实体模板（归一件 + 原始记录）的 solvePose
//    位姿按 Float64Array 字节（含 −0）与「改前解算式」的独立参考实现逐位相同——参考实现照写加 off / tilt 之前的 solvePrimary /
//    solveDerived（锚 · Rz(roll) · mount⁻¹，同样的乘法次序、90° 整数倍精确值、派生件抹 −0），测试里现算，不靠夹具：模板 / 组件几何
//    正常改动不会让它变红，只有解算的缺省路径被改动才红。归一件带缺省 off / tilt、原始件不带，两条路各自对上，也就覆盖了「缺省走
//    原路径、不多乘」。另查 compactAssembly = 归一件剥掉缺省 off / tilt（旧形状、schema 1）、asmHash = 它的规范 JSON 的 FNV-1a。
// ② 精确反解往返（性质测试，确定性随机）：接口锚 / 平面锚 / 整圆柱面锚 / 局部弧（机身蒙皮）/ 带锚自由；本件安装端取插座、'@面'、
//    '@bbox'；t0 贴近 ±90°（万向锁）——往返误差 ≤ 1e-9，角度落在约定区间，万向锁时 t1 = 0。
// ③ 先偏移后改滚转 / 倾角：安装点世界位置不变；面安装只认法向偏移（归一清零面内分量、解算与 mountedFrame 对未归一文档同口径）。
// ④ 驱动装配件：三方合并保留用户设的 off / tilt；原样文档 driveMarks.attach 全为 false（存档形状 compact 传进来同样）；原地反解重放
//    文档逐字节不变。
// ⑤ 占用计入对称派生件（default-sat：bus 的 −Y 被镜像太阳翼占着）；freeSocketChoices 与编辑器同一口径。
// ⑥ setMode / reparent / splitSym 保位姿、保锚、不瞬移（default-sat rcs1 / refl1 / hinge1 / wing1 / refl3）；拆分机翼的副本与主件
//    共用机身中线的翼根接口（镜像锚），改机身参数后两翼仍对称。
// ⑦ compact / schema：旧文档 compact 与原文档 JSON 相同；非缺省 off / tilt → schema 2；validate 认 1 / 2、拒 3、查 off / tilt / '@' 安装端。
// ⑧ 安装端候选：g.mounts（插座 ∪ '@面' ∪ '@bbox'）、mountChoices 按位置 + 法向去重（当前安装端恒在）、'@面' 与同位插座解算逐位相同；
//    安装端 / 面的中文名。
// ⑨ 候选净化：ownMountKey（自由件也算、'@' 安装端连同位插座）、折叠接口、面可安装（纯外观件不收）、纯外观薄贴片穿透、
//    accepts 收紧（喇叭口 / 杆端 / 阵面 / 地面馈源口）；default-sat 拖星敏候选里没有杆尖（§5-9）。
// ⑩ 柱面整圆判定与局部弧夹紧、自动网格 1-2-5 档、推断半径随屏上短边自适应、MOVE_STEP_OPTS。
// ⑪ 取锚的绝对上限：嵌进父件 > 0.5 m 不取面、离接口 > 0.5 m 不取接口（大件）；朝外离面照常。
// 不联网。

import assert from 'node:assert/strict'
import * as A from '../models/assembly.mjs'
import * as S from '../models/asmSnap.mjs'
import * as D from '../models/drive.mjs'
import { getComponent, fillParams, socketAccepts, faceAccepts, passThroughOf, PLANES } from '../models/components/index.mjs'
import { satSpecToComps } from '../models/components/sat.mjs'
import { normalizeSpec, canon, fnv1a64Hex } from '../models/paramBus.mjs'
import { templateSpec, TEMPLATE_IDS, DEFAULT_TEMPLATE_ID } from '../models/paramTemplates.mjs'
import { ENTITY_TEMPLATE_IDS, entityTemplateDoc, getEntityTemplate } from '../models/entityTemplates.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`)
const maxErr = (a, b) => { let e = 0; for (let i = 0; i < 16; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e }
const nearM = (a, b, tol, msg) => { const e = maxErr(a, b); assert.ok(e <= tol, `${msg}：最大误差 ${e}（容差 ${tol}）`) }
const xf = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]]
const D2R = Math.PI / 180
const docOf = (comps, domain = 'spacecraft') => A.normalizeAssembly({ domain, comps })
const pose = (doc, id) => A.solvePose(doc).get(id).m
const BUS = { id: 'bus', type: 'sat.bus.box', parent: null, params: { xM: 2.3, yM: 1.9, zM: 2.7 } }
const sat0 = () => A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID).spec)
/** 确定性随机（mulberry32）。 */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296 } }

// ═════════════════════════ ① 基线对拍（改前解算式的独立参考实现） ═════════════════════════

// 照写加 off / tilt 之前（HEAD 2341574）assembly.mjs 的矩阵小工具与 solvePrimary / solveDerived：乘法次序、90° 整数倍取精确值、
// 派生件抹 −0 都与原式相同，结果须与 solvePose 逐字节相同。缺省推断按 solvePose 收未归一文档的口径（attachModeOf / sym 缺省）。
const R = {
  mul(o, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[4 * c], b1 = b[4 * c + 1], b2 = b[4 * c + 2], b3 = b[4 * c + 3]
      o[4 * c] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
      o[4 * c + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
      o[4 * c + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
      o[4 * c + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
    }
    return o
  },
  ident(o) { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o },
  tail(o) { o[3] = 0; o[7] = 0; o[11] = 0; o[15] = 1 },
  inv(o, a) {
    o[0] = a[0]; o[1] = a[4]; o[2] = a[8]; o[4] = a[1]; o[5] = a[5]; o[6] = a[9]; o[8] = a[2]; o[9] = a[6]; o[10] = a[10]
    o[12] = -(o[0] * a[12] + o[4] * a[13] + o[8] * a[14]); o[13] = -(o[1] * a[12] + o[5] * a[13] + o[9] * a[14]); o[14] = -(o[2] * a[12] + o[6] * a[13] + o[10] * a[14])
    R.tail(o); return o
  },
  rot(o, axis, deg) {
    const r = ((deg % 360) + 360) % 360
    let c, s0
    if (r === 0) { c = 1; s0 = 0 } else if (r === 90) { c = 0; s0 = 1 } else if (r === 180) { c = -1; s0 = 0 } else if (r === 270) { c = 0; s0 = -1 } else { const th = deg * Math.PI / 180; c = Math.cos(th); s0 = Math.sin(th) }
    const s = axis[0] === '-' ? -s0 : s0
    o.fill(0); o[15] = 1
    if (axis[1] === 'X') { o[0] = 1; o[5] = c; o[6] = s; o[9] = -s; o[10] = c } else if (axis[1] === 'Y') { o[0] = c; o[2] = -s; o[5] = 1; o[8] = s; o[10] = c } else { o[0] = c; o[1] = s; o[4] = -s; o[5] = c; o[10] = 1 }
    return o
  },
  fromQT(o, q, tt) {
    const nn = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]), x = q[0] / nn, y = q[1] / nn, z = q[2] / nn, w = q[3] / nn
    o[0] = 1 - 2 * (y * y + z * z); o[1] = 2 * (x * y + w * z); o[2] = 2 * (x * z - w * y)
    o[4] = 2 * (x * y - w * z); o[5] = 1 - 2 * (x * x + z * z); o[6] = 2 * (y * z + w * x)
    o[8] = 2 * (x * z + w * y); o[9] = 2 * (y * z - w * x); o[10] = 1 - 2 * (x * x + y * y)
    o[12] = tt[0]; o[13] = tt[1]; o[14] = tt[2]
    R.tail(o); return o
  },
  frameZX(o, p, nv, up, sz) {
    let zx = nv[0] * sz, zy = nv[1] * sz, zz = nv[2] * sz
    const zl = Math.sqrt(zx * zx + zy * zy + zz * zz)
    if (!(zl > 0)) return false
    zx /= zl; zy /= zl; zz /= zl
    let k = up[0] * zx + up[1] * zy + up[2] * zz
    let xx = up[0] - k * zx, xy = up[1] - k * zy, xz = up[2] - k * zz, xl = Math.sqrt(xx * xx + xy * xy + xz * xz)
    if (!(xl > 1e-9)) { const ax = Math.abs(zx) < 0.9 ? 1 : 0, ay = 1 - ax; k = ax * zx + ay * zy; xx = ax - k * zx; xy = ay - k * zy; xz = -k * zz; xl = Math.sqrt(xx * xx + xy * xy + xz * xz) }
    xx /= xl; xy /= xl; xz /= xl
    o[0] = xx; o[1] = xy; o[2] = xz; o[4] = zy * xz - zz * xy; o[5] = zz * xx - zx * xz; o[6] = zx * xy - zy * xx; o[8] = zx; o[9] = zy; o[10] = zz
    o[12] = p[0]; o[13] = p[1]; o[14] = p[2]
    R.tail(o); return true
  },
  face(o, f, uv) {
    const fin = (v) => typeof v === 'number' && Number.isFinite(v)
    const u0 = uv && fin(uv[0]) ? uv[0] : 0, u1 = uv && fin(uv[1]) ? uv[1] : 0, g = f.origin
    if (f.kind === 'cyl') {
      const a = f.axis, rf = f.ref, r = f.radius, ph = -u1 / r, c = Math.cos(ph), s = Math.sin(ph)
      const wx = a[1] * rf[2] - a[2] * rf[1], wy = a[2] * rf[0] - a[0] * rf[2], wz = a[0] * rf[1] - a[1] * rf[0]
      const rx = c * rf[0] + s * wx, ry = c * rf[1] + s * wy, rz = c * rf[2] + s * wz
      o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[4] = ry * a[2] - rz * a[1]; o[5] = rz * a[0] - rx * a[2]; o[6] = rx * a[1] - ry * a[0]; o[8] = rx; o[9] = ry; o[10] = rz
      o[12] = g[0] + a[0] * u0 + rx * r; o[13] = g[1] + a[1] * u0 + ry * r; o[14] = g[2] + a[2] * u0 + rz * r
    } else {
      const u = f.u, v = f.v, nv = f.n
      o[0] = u[0]; o[1] = u[1]; o[2] = u[2]; o[4] = v[0]; o[5] = v[1]; o[6] = v[2]; o[8] = nv[0]; o[9] = nv[1]; o[10] = nv[2]
      o[12] = g[0] + u[0] * u0 + v[0] * u1; o[13] = g[1] + u[1] * u0 + v[1] * u1; o[14] = g[2] + u[2] * u0 + v[2] * u1
    }
    R.tail(o); return o
  }
}
const PLANE_AXIS = { yz: 0, xz: 1, xy: 2 }
function refBestPlane(M, na, list) {
  let best = null, bs = -1
  for (const pl of list) { const j = PLANE_AXIS[pl]; if (j === undefined) continue; const sc = Math.abs(M[na + 4 * j]); if (sc > bs + 1e-12) { bs = sc; best = pl } }
  return best
}
/** 改前解算式：文档（归一或未归一）→ Map(id → {m, mode})，含对称派生件。 */
function refSolve(doc) {
  const comps = doc.comps, domain = ['ground', 'aircraft', 'ship', 'vehicle'].includes(doc.domain) ? doc.domain : 'spacecraft'
  const isO = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const fin = (v) => typeof v === 'number' && Number.isFinite(v)
  const byId = new Map(comps.map((c) => [c.id, c]))
  const parentOf = (c) => (typeof c.parent === 'string' && c.parent ? c.parent : null)
  const geo = (c) => { const def = getComponent(c.type), p = fillParams(def, c.params); return { def, p, sockets: def.sockets(p), faces: def.faces(p) } }
  const out = new Map()
  const solve = (c) => {
    if (out.has(c.id)) return out.get(c.id).m
    const m = new Float64Array(16), pid = parentOf(c)
    if (pid === null) { R.ident(m); out.set(c.id, { m, mode: 'root' }); return m }
    const Mp = solve(byId.get(pid)), pg = geo(byId.get(pid)), a = isO(c.attach) ? c.attach : {}
    const mode = ['socket', 'surface', 'free'].includes(a.mode) ? a.mode : typeof a.socket === 'string' ? 'socket' : typeof a.face === 'string' ? 'surface' : 'free'
    const S0 = new Float64Array(16), S1 = new Float64Array(16), S2 = new Float64Array(16), S3 = new Float64Array(16)
    if (typeof a.socket === 'string' && a.socket && mode !== 'surface') { const s = pg.sockets.find((x) => x.id === a.socket); R.frameZX(S0, s.pos, s.n, s.up, 1) }
    else if (typeof a.face === 'string' && a.face && mode !== 'socket') R.face(S0, pg.faces.find((f) => f.id === a.face), a.uv)
    else R.ident(S0)
    if (mode === 'free') { R.fromQT(S1, c.q === undefined ? [0, 0, 0, 1] : c.q, c.t === undefined ? [0, 0, 0] : c.t); R.mul(S2, S0, S1) }
    else {
      R.mul(S1, S0, R.rot(S2, '+Z', fin(a.roll) ? a.roll : 0))
      const g = geo(c), mid = typeof a.mount === 'string' && a.mount ? a.mount : g.def.mountSocket, ms = g.sockets.find((x) => x.id === mid)
      R.frameZX(S3, ms.pos, ms.n, ms.up, -1)
      R.mul(S2, S1, R.inv(S0, S3))
    }
    R.mul(m, Mp, S2)
    out.set(c.id, { m, mode })
    return m
  }
  for (const c of comps) solve(c)
  // 生效对称：继承最近带对称的祖先（嵌套以祖先为准），否则自带
  const effSym = (c) => {
    const pid = parentOf(c)
    const inh = pid === null ? null : effSym(byId.get(pid))
    if (inh) return inh
    const s = isO(c.sym) ? c.sym : null
    if (!s || pid === null || !['mirrorXZ', 'mirrorYZ', 'radial'].includes(s.op)) return null
    const sn = s.n === undefined ? 2 : s.n, sa = s.axis === undefined ? (domain === 'aircraft' ? '+X' : '+Z') : s.axis
    return { op: s.op, n: s.op === 'radial' ? (Number.isInteger(sn) && sn >= 2 && sn <= 8 ? sn : 2) : 2, axis: s.op === 'radial' && ['+X', '-X', '+Y', '-Y', '+Z', '-Z'].includes(sa) ? sa : (domain === 'aircraft' ? '+X' : '+Z') }
  }
  for (const c of comps) {
    const sy = effSym(c)
    if (!sy) continue
    const M = out.get(c.id).m, g = geo(c)
    for (let k = 1; k < sy.n; k++) {
      const m = new Float64Array(16)
      if (sy.op === 'radial') { R.mul(m, R.rot(new Float64Array(16), sy.axis, (360 * k) / sy.n), M); out.set(`${c.id}~${k}`, { m, mode: 'radial' }); continue }
      const na = sy.op === 'mirrorXZ' ? 1 : 0
      const sp = typeof g.def.symmetricPlanes === 'function' ? g.def.symmetricPlanes(g.p) : (g.def.symmetricPlanes || [])
      let mode = 'bake', pl = null
      if (g.def.mirror) { pl = refBestPlane(M, na, g.def.mirrorPlanes); mode = 'hook' }
      if (!pl && sp.length) { pl = refBestPlane(M, na, sp); mode = 'plane' }
      if (!pl) { pl = refBestPlane(M, na, PLANES); mode = 'bake' }
      m.set(M)
      for (let j = 0; j < 4; j++) m[na + 4 * j] = -m[na + 4 * j]
      const ax = PLANE_AXIS[pl]
      for (let r = 0; r < 3; r++) m[r + 4 * ax] = -m[r + 4 * ax]
      for (let i = 0; i < 16; i++) if (m[i] === 0) m[i] = 0
      out.set(`${c.id}~${k}`, { m, mode })
    }
  }
  return out
}
const bytesOf = (m) => Buffer.from(m.buffer, m.byteOffset, 128).toString('hex')
/** [键, 文档, 是否归一件]：整星归一件 / 原始件、实体归一件 / 原始记录。 */
function baselineDocs() {
  const out = []
  for (const id of TEMPLATE_IDS) {
    const spec = templateSpec(id).spec
    out.push([`sat:${id}`, A.specToAssembly(spec), true])
    out.push([`rawsat:${id}`, { kind: 'assembly', domain: 'spacecraft', comps: satSpecToComps(normalizeSpec(spec)).comps }, false])
  }
  for (const id of ENTITY_TEMPLATE_IDS) {
    out.push([`ent:${id}`, entityTemplateDoc(id).doc, true])
    out.push([`raw:${id}`, getEntityTemplate(id).doc, false])
  }
  return out
}
const STRIP = (d) => { const x = JSON.parse(JSON.stringify(d)); for (const c of x.comps) { delete c.attach.off; delete c.attach.tilt } return x }

t('基线对拍：整星 / 实体模板（归一件带缺省 off / tilt、原始件不带）solvePose 与改前解算式逐字节相同；compact = 旧形状、asmHash 同口径', () => {
  const docs = baselineDocs()
  assert.ok(docs.length >= 70, `${docs.length} 份文档`)
  let cnt = 0
  for (const [k, doc, normed] of docs) {
    const P = A.solvePose(doc), ref = refSolve(doc)
    assert.equal(P.size, ref.size, `${k} 条目数`)
    for (const [id, r] of ref) {
      const p = P.get(id)
      assert.ok(p && !p.bad, `${k} ${id} 解算`)
      assert.equal(p.mode, r.mode, `${k} ${id} mode`)
      assert.equal(bytesOf(p.m), bytesOf(r.m), `${k} ${id} 位姿字节`)
      cnt++
    }
    if (!normed) continue
    // 存档形状：归一件剥掉缺省 off / tilt = 旧版 normalizeAssembly 的形状（attach 六键、schema 1）；哈希就是它的规范 JSON
    const c = A.compactAssembly(doc), nd = A.normalizeAssembly(doc)
    assert.equal(c.schema, 1, `${k} schema`)
    assert.ok(c.comps.every((x) => Object.keys(x.attach).join() === 'mode,socket,face,uv,roll,mount'), `${k} attach 旧形状`)
    assert.deepEqual(c, STRIP(nd), `${k} compact = 归一件剥缺省`)
    assert.equal(A.asmHash(doc), fnv1a64Hex(canon(c)), `${k} asmHash`)
  }
  assert.ok(cnt >= 600, `${cnt} 条位姿`)
  // 两条路：off / tilt 显式写成 −0（JSON 外的内存文档）与剥掉字段 → 同样逐字节等于参考（−0 也走原路径，不乘单位阵）
  const d = sat0(), ref = refSolve(d)
  const neg = JSON.parse(JSON.stringify(d))
  for (const c of neg.comps) { c.attach.off = [-0, -0, -0]; c.attach.tilt = [-0, -0] }
  for (const doc of [neg, STRIP(d)]) for (const [id, p] of A.solvePose(doc)) assert.equal(bytesOf(p.m), bytesOf(ref.get(id).m), id)
})

// ═════════════════════════ ② 精确反解往返 ═════════════════════════

/** 子件换 attach（及 t / q）后的文档。 */
function withAttach(doc, id, r) {
  const d = JSON.parse(JSON.stringify(doc))
  const c = d.comps.find((x) => x.id === id)
  c.attach = r.attach
  if (r.attach.mode === 'free') { c.t = r.t; c.q = r.q } else { delete c.t; delete c.q }
  return A.normalizeAssembly(d)
}
/** 约定：roll ∈ (−180, 180]、t0 ∈ [−90, 90]、t1 ∈ (−180, 180]；万向锁（|cos t0| < 1e-9）且无原值时 t1 = 0。 */
function checkConv(a, msg) {
  assert.ok(a.roll > -180 && a.roll <= 180, `${msg} roll ${a.roll}`)
  assert.ok(a.tilt[0] >= -90 && a.tilt[0] <= 90, `${msg} t0 ${a.tilt[0]}`)
  assert.ok(a.tilt[1] > -180 && a.tilt[1] <= 180, `${msg} t1 ${a.tilt[1]}`)
  if (Math.abs(Math.cos(a.tilt[0] * D2R)) < 1e-9) assert.equal(a.tilt[1], 0, `${msg} 万向锁 t1 = 0`)
}
const randQ = (r) => { const u = [r(), r(), r()], s1 = Math.sqrt(1 - u[0]), s2 = Math.sqrt(u[0]); return [s1 * Math.sin(2 * Math.PI * u[1]), s1 * Math.cos(2 * Math.PI * u[1]), s2 * Math.sin(2 * Math.PI * u[2]), s2 * Math.cos(2 * Math.PI * u[2])] }

t('反解往返（性质）：接口 / 平面 / 整圆柱 / 局部弧 / 带锚自由 × 安装端 插座 / @面 / @bbox × 万向锁附近：误差 ≤ 1e-9、角度落在约定区间', () => {
  const r = rng(20261006)
  const T0S = [90, -90, 90 - 1e-10, -90 + 1e-12, 89.9999999, -89.99999, 0, 45]
  const MOUNTS = [null, '+X', '@+Y', '@+Z', '@bbox-X', '@bbox+Z']
  // 父件：星体（接口 / 平面）、立柱（整圆柱面 + 顶接口）、机身（局部弧蒙皮）
  const bases = [
    { domain: 'spacecraft', parent: BUS, anchors: [['socket', '+X'], ['socket', '-Z'], ['surface', '+Y'], ['surface', '+Z']] },
    { domain: 'spacecraft', parent: { id: 'bus', type: 'prim.cyl', parent: null, params: { dM: 0.8, hM: 1.2 } }, anchors: [['surface', 'side'], ['socket', '+Z']] },
    { domain: 'aircraft', parent: { id: 'fus', type: 'air.fuselage', parent: null }, anchors: [['surface', 'skin'], ['surface', 'sideR']] }
  ]
  let cnt = 0, worst = 0
  for (const b of bases) {
    const pg = S.compGeo(b.parent)
    for (const [mode, aid] of b.anchors) {
      const target = mode === 'socket' ? pg.sockets.find((s) => s.id === aid) : pg.faces.find((f) => f.id === aid)
      assert.ok(target, aid)
      for (let k = 0; k < 24; k++) {
        const mount = MOUNTS[k % MOUNTS.length]
        const t0 = k < T0S.length ? T0S[k] : (r() - 0.5) * 180
        const hv = target.kind === 'cyl' && !S.isFullCyl(target) ? target.halfV : (target.halfV || 0.3)
        const a0 = {
          mode, roll: (r() - 0.5) * 360, mount, tilt: [t0, (r() - 0.5) * 360],
          ...(mode === 'socket' ? { socket: aid, off: [(r() - 0.5), (r() - 0.5), (r() - 0.5) * 0.4] } : { face: aid, uv: [(r() - 0.5) * 1.6 * (target.halfU || 0.3), (r() - 0.5) * 1.6 * hv], off: [0, 0, (r() - 0.5) * 0.4] })
        }
        const doc = docOf([b.parent, { id: 'k', type: 'prim.box', parent: b.parent.id, attach: a0, params: { xM: 0.3, yM: 0.2, zM: 0.4 } }], b.domain)
        assert.ok(A.validateAssembly(doc).ok, A.validateAssembly(doc).errors.join('；'))
        const P = A.solvePose(doc), W = P.get('k').m, Mp = P.get(b.parent.id).m
        const c = S.compById(doc, 'k')
        // (a) 同锚反解（无原值）：复现 W，角度落在约定区间
        const res = S.attachFromWorldExact(c, Mp, W, mode, target, null, {})
        checkConv(res.attach, `${aid}#${k}`)
        const e1 = maxErr(pose(withAttach(doc, 'k', res), 'k'), W)
        // (b) 任意位姿（不是由该锚生成的）：随机旋转 + 锚附近的位置
        const W2 = S.m4FromQT(new Float64Array(16), randQ(r), [Mp[12] + (r() - 0.5) * 3, Mp[13] + (r() - 0.5) * 3, Mp[14] + (r() - 0.5) * 3])
        const res2 = S.attachFromWorldExact(c, Mp, W2, mode, target, null, {})
        checkConv(res2.attach, `${aid}#${k} 任意`)
        const e2 = maxErr(pose(withAttach(doc, 'k', res2), 'k'), W2)
        // (c) 带锚自由：t / q 相对锚系
        const res3 = S.attachFromWorldExact(c, Mp, W2, 'free', target, mode === 'surface' ? a0.uv : null, {})
        assert.equal(res3.attach.mode, 'free'); assert.equal(res3.attach[mode === 'socket' ? 'socket' : 'face'], aid, '保锚')
        const e3 = maxErr(pose(withAttach(doc, 'k', res3), 'k'), W2)
        worst = Math.max(worst, e1, e2, e3)
        assert.ok(e1 <= 1e-9 && e2 <= 1e-9 && e3 <= 1e-9, `${b.parent.type}.${aid} mount ${mount} t0 ${t0}：误差 ${e1} / ${e2} / ${e3}`)
        cnt++
      }
    }
  }
  assert.ok(cnt >= 190, `${cnt} 组`)
  assert.ok(worst <= 1e-9)
  // 无锚自由（相对父件）
  const doc = docOf([BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: [0.4, -0.3, 1.9], q: [0.1, 0.2, 0.3, 0.9] }])
  const P = A.solvePose(doc), res = S.attachFromWorldExact(S.compById(doc, 'k'), P.get('bus').m, P.get('k').m, 'free', null)
  nearM(pose(withAttach(doc, 'k', res), 'k'), P.get('k').m, 1e-12, '无锚自由')
  // 万向锁有原值：t1 取原值（多解取最接近原值），roll 吸收
  const dg = docOf([BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'socket', socket: '+X', roll: 20, tilt: [90, 35] } }])
  const Pg = A.solvePose(dg), rg = S.attachFromWorldExact(S.compById(dg, 'k'), Pg.get('bus').m, Pg.get('k').m, 'socket', S.compGeo(BUS).sockets.find((s) => s.id === '+X'))
  assert.deepEqual([rg.attach.roll, rg.attach.tilt], [20, [90, 35]], '原地重放：万向锁也逐位取原值')
})

// ═════════════════════════ ③ 先偏移后改滚转 ═════════════════════════

t('先偏移后改滚转 / 倾角：安装点世界位置不变（接口件、面安装件、@bbox 安装端）', () => {
  for (const [a, mount] of [[{ mode: 'socket', socket: '+X', off: [0.3, -0.2, 0.15] }, null], [{ mode: 'surface', face: '+Z', uv: [0.4, -0.3], off: [0, 0, 0.2] }, null], [{ mode: 'socket', socket: '-Y', off: [0.1, 0.05, 0.3] }, '@bbox+X']]) {
    const mk = (roll, tilt) => docOf([BUS, { id: 'k', type: 'sat.sensor.star', parent: 'bus', attach: { ...a, mount, roll, tilt } }])
    const ms = S.mountSocketOf(S.compById(mk(0, [0, 0]), 'k'))
    const p0 = xf(pose(mk(0, [0, 0]), 'k'), ms.pos)
    for (const [roll, tilt] of [[73, [0, 0]], [-120, [15, 0]], [33.3, [12, -40]]]) {
      const d = mk(roll, tilt), p1 = xf(pose(d, 'k'), ms.pos)
      for (let i = 0; i < 3; i++) near(p1[i], p0[i], 1e-12, `${a.mode} ${mount} roll ${roll} 安装点[${i}]`)
    }
    // 偏移确实生效：法向偏移 = 安装点沿锚法向挪出
    const d0 = docOf([BUS, { id: 'k', type: 'sat.sensor.star', parent: 'bus', attach: { ...a, mount, off: [0, 0, 0] } }])
    const q0 = xf(pose(d0, 'k'), ms.pos)
    assert.ok(Math.hypot(p0[0] - q0[0], p0[1] - q0[1], p0[2] - q0[2]) > 0.1, '偏移量生效')
  }
})

t('面安装只认法向偏移：归一清零 off[0] / off[1]；未归一文档的解算与 mountedFrame 同样忽略面内分量；setAttach 换成面安装清掉接口系的面内偏移', () => {
  const raw = (off) => ({ domain: 'spacecraft', comps: [BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [0.3, -0.2], roll: 25, tilt: [10, -5], off } }] })
  assert.deepEqual(A.normalizeAssembly(raw([0.5, -0.4, 0.2])).comps[1].attach.off, [0, 0, 0.2], '归一清零面内分量')
  const noTilt = raw([0.5, 0, 0]); delete noTilt.comps[1].attach.tilt
  assert.equal(A.normalizeAssembly(noTilt).schema, 1, '只有面内分量 = 缺省，不升版本')
  // 未归一文档直接喂解算：面内分量不参与（与归一件逐位相同）
  assert.equal(bytesOf(A.solvePose(raw([0.5, -0.4, 0.2])).get('k').m), bytesOf(A.solvePose(raw([0, 0, 0.2])).get('k').m))
  assert.equal(bytesOf(A.solvePose(raw([0.5, -0.4, 0])).get('k').m), bytesOf(A.solvePose(raw(undefined)).get('k').m), '只剩面内分量 → 走原路径')
  // mountedFrame 同口径：安装端在父件局部的位姿 = inv(M_父) · W · mount 系
  const rd = raw([0.5, -0.4, 0.2]), c = rd.comps[1], P = A.solvePose(rd)
  const mf = S.mountedFrame(new Float64Array(16), c, S.compGeo(BUS))
  const exp = S.m4Mul(new Float64Array(16), S.m4Mul(new Float64Array(16), S.m4InvRigid(new Float64Array(16), P.get('bus').m), P.get('k').m), S.mountFrame(new Float64Array(16), S.mountSocketOf(c)))
  nearM(mf, exp, 1e-12, 'mountedFrame')
  // setAttach：带面内偏移的接口件改成面安装 → 只留法向分量
  const ds = docOf([BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'socket', socket: '+X', off: [0.2, -0.1, 0.3] } }])
  const r = S.applyCmd(ds, { type: 'setAttach', id: 'k', attach: { mode: 'surface', face: '+Y' } })
  assert.ok(r.ok)
  assert.deepEqual(S.compById(r.doc, 'k').attach.off, [0, 0, 0.3])
})

// ═════════════════════════ ④ 驱动装配件 ═════════════════════════

t('驱动装配件：三方合并保留 off / tilt；原样文档 driveMarks.attach 全 false；原地反解重放文档逐字节不变', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const mk0 = D.driveMarks(doc)
  for (const [id, m] of Object.entries(mk0)) assert.equal(m.attach, false, `${id} 原样不算改写`)
  // 存档 / 草稿形状（compact 剥掉了缺省 off / tilt）直接传进来：先归一再比，标记相同
  assert.deepEqual(D.driveMarks(A.compactAssembly(doc)), mk0, 'compact 形状不误判改写')
  assert.deepEqual(D.driveMarks(JSON.parse(JSON.stringify(A.compactAssembly(doc)))), mk0)
  // 原地重放：每件按现锚精确反解，结果逐字节等于原文档（驱动标记不会被浮点尘误判）
  const P = A.solvePose(doc), rep = JSON.parse(JSON.stringify(doc))
  for (const c of rep.comps) {
    if (c.parent == null) continue
    const pg = S.compGeo(rep.comps.find((x) => x.id === c.parent)), a = c.attach
    const tgt = a.socket && a.mode !== 'surface' ? pg.sockets.find((s) => s.id === a.socket) : a.face && a.mode !== 'socket' ? pg.faces.find((f) => f.id === a.face) : null
    const r = S.attachFromWorldExact(c, P.get(c.parent).m, P.get(c.id).m, a.mode, tgt, a.uv)
    c.attach = r.attach
    if (r.attach.mode === 'free') { c.t = r.t; c.q = r.q }
  }
  assert.equal(JSON.stringify(A.normalizeAssembly(rep)), JSON.stringify(doc), '原地重放逐字节不变')
  for (const m of Object.values(D.driveMarks(A.normalizeAssembly(rep)))) assert.equal(m.attach, false)
  // 用户给 horn2 加法向偏移与倾角，再改驱动参数（平台加宽）：偏移 / 倾角保留，其余件跟新基线
  const h = doc.comps.find((c) => c.id === 'horn2')
  h.attach.off = [0, 0, 0.2]; h.attach.tilt = [15, 0]
  doc = A.normalizeAssembly(doc)
  assert.equal(doc.schema, 2)
  assert.equal(D.driveMarks(doc).horn2.attach, true, '改写标记')
  const s1 = JSON.parse(JSON.stringify(doc.drive.spec)); s1.bus.xM = 2.8
  const r = D.rebaseDrive(doc, s1)
  assert.ok(r.ok, r.error)
  const h2 = r.doc.comps.find((c) => c.id === 'horn2')
  assert.deepEqual([h2.attach.off, h2.attach.tilt], [[0, 0, 0.2], [15, 0]], '三方合并保留')
  assert.equal(r.doc.comps.find((c) => c.id === 'bus').params.xM, 2.8)
  const mk1 = D.driveMarks(r.doc)
  assert.equal(mk1.horn2.attach, true)
  assert.equal(mk1.horn1.attach, false, '别的件不受影响')
  // 恢复驱动值：off / tilt 一并回到缺省
  const back = D.resetToBase(r.doc, 'horn2', 'pose')
  assert.deepEqual([back.comps.find((c) => c.id === 'horn2').attach.off, back.comps.find((c) => c.id === 'horn2').attach.tilt], [[0, 0, 0], [0, 0]])
})

// ═════════════════════════ ⑤ 占用计入派生件 ═════════════════════════

t('占用计入对称派生件：default-sat bus 的 −Y 被镜像太阳翼占着（键按主件 id）；去掉对称 / 排除主件后空出；freeSocketChoices 同口径', () => {
  const doc = sat0(), P = A.solvePose(doc)
  assert.ok(doc.comps.find((c) => c.id === 'wing1').sym, '模板 wing1 带镜像')
  assert.ok(!S.usedSocketKeys(doc).has('bus|-Y'), '没有件显式指着 −Y')
  assert.ok(S.occupiedSocketKeys(doc, P).has('bus|-Y'), '派生件 wing1~1 占 −Y')
  assert.ok(S.occupiedSocketKeys(doc, A.solvePose(doc)).has('bus|-Y'))
  const ws = new Map([...P].map(([k, v]) => [k, Float64Array.from(v.m)]))
  assert.ok(S.occupiedSocketKeys(doc, ws).has('bus|-Y'), 'Float64Array 位姿表同口径')
  assert.ok(!S.occupiedSocketKeys(doc, P, new Set(['wing1'])).has('bus|-Y'), '排除主件连派生副本一起排除')
  const d2 = S.applyCmd(doc, { type: 'setSym', id: 'wing1', sym: null }).doc
  assert.ok(!S.occupiedSocketKeys(d2, A.solvePose(d2)).has('bus|-Y'), '去掉对称后空出')
  assert.deepEqual(S.freeSocketsOf(doc, 'bus', 'sat.sensor.star', null, P).map((s) => s.id), [], 'default-sat 星体六个面心接口全被占')
  assert.deepEqual(S.freeSocketChoices(doc, 'horn1', 'bus', P), [])
  const ch = S.freeSocketChoices(d2, 'horn1', 'bus')
  assert.deepEqual(ch.map((c) => c.id), ['-Y'])
  assert.deepEqual([ch[0].label, ch[0].folded, ch[0].dedicated], ['接口 -Y', true, false])
  // 径向派生副本同样算：+Z 面偏心件径向 4 份，副本落在别的位置的接口上
  const SQ = { id: 'bus', type: 'sat.bus.box', parent: null, params: { xM: 2, yM: 2, zM: 2.7 } }
  const dr = docOf([SQ, { id: 'tw', type: 'sat.tower', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [0, 0] } },
    { id: 'th', type: 'sat.thruster', parent: 'bus', attach: { mode: 'surface', face: '+X', uv: [0, 0] }, sym: { op: 'radial', n: 4, axis: '+Z' } }])
  const occ = S.occupiedSocketKeys(dr, A.solvePose(dr))
  assert.ok(occ.has('bus|+X') && occ.has('bus|+Y') && occ.has('bus|-X') && occ.has('bus|-Y'), '径向 4 份占四个侧面心')
  // 非父子的几何占用：塔馈反射面的支撑杆，内缘到背面中心那一节（arm3c）接在对地板撑杆（arm3a）端部
  assert.ok(S.occupiedSocketKeys(doc, P).has('arm3a|tip'), '下一节杆的根部压着上一节的端部')
})

// ═════════════════════════ ⑥ 保位姿命令 ═════════════════════════

t('setMode / reparent / splitSym：保位姿（≤ 1e-9）、保锚、不瞬移（default-sat rcs1 / refl1 / hinge1 / wing1 / refl3）', () => {
  const doc = sat0(), P0 = A.solvePose(doc)
  const ok = (r, msg) => { assert.ok(r.ok, `${msg}：${r.error}`); return r.doc }
  const same = (d, id, msg) => nearM(pose(d, id), P0.get(id).m, 1e-9, msg)
  // rcs1：模板为带面锚自由件（−Z 面 + 26° 外倾）
  const rcs = S.compById(doc, 'rcs1')
  assert.deepEqual([rcs.attach.mode, rcs.attach.face], ['free', '-Z'])
  let d = ok(S.applyCmd(doc, { type: 'setMode', id: 'rcs1', mode: 'surface' }), 'rcs1 → surface')
  let a = S.compById(d, 'rcs1').attach
  assert.equal(a.face, '-Z', '保锚：面不换')
  same(d, 'rcs1', 'rcs1 → surface')
  const nz = (m) => [m[8], m[9], m[10]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const tiltDeg = Math.acos(Math.min(1, Math.abs(dot(nz(pose(d, 'rcs1')), [0, 0, 1])))) / D2R
  assert.ok(tiltDeg > 20 && tiltDeg < 30, `倾角保留 ${tiltDeg.toFixed(2)}°`)
  assert.ok(a.tilt[0] !== 0 || a.tilt[1] !== 0, 'tilt 非零')
  d = ok(S.applyCmd(d, { type: 'setMode', id: 'rcs1', mode: 'free' }), 'rcs1 → free')
  assert.deepEqual([S.compById(d, 'rcs1').attach.mode, S.compById(d, 'rcs1').attach.face], ['free', '-Z'], '带锚自由：保留面锚')
  same(d, 'rcs1', 'rcs1 → surface → free')
  assert.equal(S.applyCmd(doc, { type: 'setMode', id: 'rcs1', mode: 'socket' }).error, '无可用接口。', '阈值内没有空闲接口：拒收，不跳到远处')
  // refl1：带接口锚的自由件（+X 接口 + 展开偏置）
  d = ok(S.applyCmd(doc, { type: 'setMode', id: 'refl1', mode: 'socket' }), 'refl1 → socket')
  a = S.compById(d, 'refl1').attach
  assert.equal(a.socket, '+X', '保锚：接口不换')
  assert.ok(Math.hypot(...a.off) > 1, '展开偏置进 off')
  same(d, 'refl1', 'refl1 → socket')
  d = ok(S.applyCmd(d, { type: 'setMode', id: 'refl1', mode: 'free' }), 'refl1 → socket → free')
  assert.deepEqual([S.compById(d, 'refl1').attach.mode, S.compById(d, 'refl1').attach.socket], ['free', '+X'])
  same(d, 'refl1', 'refl1 往返')
  for (const id of ['sup1', 'sup1b', 'sup1c', 'arm1a']) same(d, id, `${id} 不受影响`)
  // hinge1：无锚自由件，离 +X 面心 5.4 cm（阈值 5 cm）→ 接口拒收；面安装取 +X 面（安装点贴着面）
  assert.equal(S.applyCmd(doc, { type: 'setMode', id: 'hinge1', mode: 'socket' }).error, '无可用接口。')
  d = ok(S.applyCmd(doc, { type: 'setMode', id: 'hinge1', mode: 'surface' }), 'hinge1 → surface')
  assert.equal(S.compById(d, 'hinge1').attach.face, '+X')
  same(d, 'hinge1', 'hinge1 → surface')
  // wing1：面安装 ↔ 接口（面心折叠接口）↔ 自由，全程逐位不动
  for (const m of ['socket', 'free', 'surface']) { d = ok(S.applyCmd(doc, { type: 'setMode', id: 'wing1', mode: m }), `wing1 → ${m}`); nearM(pose(d, 'wing1'), P0.get('wing1').m, 0, `wing1 → ${m} 逐位`) }
  // reparent：refl3（塔顶接口锚）改挂星体 → 星体 +Z 面锚、仍是自由件
  d = ok(S.applyCmd(doc, { type: 'reparent', id: 'refl3', parent: 'bus' }), 'refl3 → bus')
  a = S.compById(d, 'refl3').attach
  assert.deepEqual([a.mode, a.face], ['free', '+Z'], '新父件上就近取面锚')
  same(d, 'refl3', 'refl3 改父件')
  // reparent：接口件改挂到塔上——阈值（5 cm）内有空闲接口（塔顶）→ 仍按接口写；离开阈值、仍在塔顶面内 → 面安装
  for (const [dx, want] of [[0.04, ['socket', 'top']], [0.15, ['surface', '+Z']]]) {
    const dt = docOf([BUS, { id: 'tw', type: 'sat.tower', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [0, 0] }, params: { wM: 0.5, hM: 1 } },
      { id: 'st', type: 'sat.sensor.star', parent: 'bus', attach: { mode: 'socket', socket: '+Z', off: [dx, 0, 1.0], tilt: [0, 0] } }])
    const Pt = A.solvePose(dt)
    const rt = ok(S.applyCmd(dt, { type: 'reparent', id: 'st', parent: 'tw' }), 'st → tower')
    const at = S.compById(rt, 'st').attach
    assert.deepEqual([at.mode, at.socket || at.face, S.compById(rt, 'st').parent], [...want, 'tw'], `偏 ${dx} m`)
    nearM(pose(rt, 'st'), Pt.get('st').m, 1e-9, 'st 改父件')
  }
  // splitSym：镜像太阳翼拆出的副本落回 −Y 面（方式随原件），位姿 = 原派生件
  d = ok(S.applyCmd(doc, { type: 'splitSym', id: 'wing1' }), 'wing1 拆分')
  const w2 = d.comps.find((c) => c.type === 'sat.wing' && c.id !== 'wing1')
  assert.deepEqual([w2.attach.mode, w2.attach.face], ['surface', '-Y'], '副本保锚')
  nearM(pose(d, w2.id), P0.get('wing1~1').m, 1e-12, '副本位姿 = 原派生件')
  same(d, 'wing1', '原件不动')
  assert.ok(A.validateAssembly(d).ok)
})

t('splitSym 镜像锚：机身中线翼根接口镜像回自己 → 副本与主件共锚（不挂到机腹 / 机身安装接口上）；改机身参数两翼仍对称；属性面板照列当前接口', () => {
  for (const id of ['ent:a320neo', 'ent:g650er', 'ent:mq9']) {
    const doc = A.normalizeAssembly(entityTemplateDoc(id).doc), P0 = A.solvePose(doc)
    const r = S.applyCmd(doc, { type: 'splitSym', id: 'wing' })
    assert.ok(r.ok, `${id}：${r.error}`)
    const w2 = r.doc.comps.find((c) => c.type === 'air.wing' && c.id !== 'wing')
    assert.deepEqual([w2.attach.mode, w2.attach.socket, w2.parent], ['socket', 'wing', 'fus'], `${id} 副本共用翼根`)
    nearM(pose(r.doc, w2.id), P0.get('wing~1').m, 1e-12, `${id} 副本位姿 = 原派生件`)
    assert.ok(A.validateAssembly(r.doc).ok)
    // 翼根随机身参数移动：两翼一起走、仍关于 XZ 面对称
    const r2 = S.applyCmd(r.doc, { type: 'setParams', id: 'fus', params: { wingZFrac: 0.1, wingXFrac: 0.42 } })
    const P2 = A.solvePose(r2.doc), a = P2.get('wing').m, b = P2.get(w2.id).m
    for (const [i, sg] of [[12, 1], [13, -1], [14, 1]]) near(b[i], sg * a[i], 1e-12, `${id} 改参数后对称[${i}]`)
    assert.ok(Math.abs(a[12] - pose(r.doc, 'wing')[12]) > 0.1, `${id} 翼根确实挪了`)
    // 属性面板：副本当前接口与主件共用、被主件占着，也照列
    assert.ok(S.freeSocketChoices(r.doc, w2.id).some((c) => c.id === 'wing'), `${id} 下拉有当前接口`)
  }
})

// ═════════════════════════ ⑦ compact / schema / validate ═════════════════════════

t('compact / schema / validate：旧文档 compact 与原文档 JSON 相同；非缺省 off / tilt → schema 2；validate 认 1 / 2、拒 3，查 off / tilt / @ 安装端', () => {
  const d = sat0()
  const c = A.compactAssembly(d)
  assert.equal(c.schema, 1)
  assert.ok(c.comps.every((x) => !('off' in x.attach) && !('tilt' in x.attach)), '缺省剥掉')
  assert.equal(JSON.stringify(A.compactAssembly(JSON.parse(JSON.stringify(c)))), JSON.stringify(c), 'compact 幂等：存档读回再存逐字节相同')
  assert.equal(A.asmHash(c), A.asmHash(d), '哈希与归一形无关')
  assert.deepEqual(A.normalizeAssembly(c), d, '读回补缺省')
  assert.ok(Object.keys(d.comps[1].attach).join() === 'mode,socket,face,uv,roll,mount,off,tilt', '归一形状恒同')
  assert.ok(Object.keys(d.comps[0].attach).join() === 'mode,socket,face,uv,roll,mount,off,tilt', '根件同形')
  // 非缺省：schema 2，compact 留非缺省的那一个
  const d2 = JSON.parse(JSON.stringify(d)); d2.comps.find((x) => x.id === 'horn1').attach.off = [0, 0, 0.1]
  const n2 = A.normalizeAssembly(d2), c2 = A.compactAssembly(d2)
  assert.equal(n2.schema, 2); assert.equal(c2.schema, 2)
  const h = c2.comps.find((x) => x.id === 'horn1').attach
  assert.deepEqual([h.off, 'tilt' in h], [[0, 0, 0.1], false])
  assert.notEqual(A.asmHash(d2), A.asmHash(d))
  assert.ok(A.validateAssembly(n2).ok)
  // 自由件的 off / tilt 不适用：归一回缺省
  const f = A.normalizeAssembly({ domain: 'spacecraft', comps: [BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'free', off: [1, 2, 3], tilt: [4, 5] } }] })
  assert.deepEqual([f.comps[1].attach.off, f.comps[1].attach.tilt, f.schema], [[0, 0, 0], [0, 0], 1])
  // validate
  const errs = (doc) => A.validateAssembly(doc).errors.join('；')
  const one = (attach) => ({ kind: 'assembly', domain: 'spacecraft', comps: [BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach }] })
  assert.ok(A.validateAssembly({ ...one({ socket: '+X' }), schema: 2 }).ok, 'schema 2 照收')
  assert.match(errs({ ...one({ socket: '+X' }), schema: 3 }), /schema：不支持 3/)
  assert.match(errs(one({ socket: '+X', tilt: [95, 0] })), /tilt：t0 须在/)
  assert.match(errs(one({ socket: '+X', off: [1, 2] })), /attach\.off：须为/)
  assert.match(errs(one({ socket: '+X', off: [1, NaN, 0] })), /attach\.off：须为/)
  assert.match(errs(one({ socket: '+X', tilt: [0, Infinity] })), /attach\.tilt：须为/)
  assert.ok(A.validateAssembly(one({ socket: '+X', mount: '@+Y' })).ok, '@面 安装端')
  assert.ok(A.validateAssembly(one({ socket: '+X', mount: '@bbox-Z' })).ok, '@bbox 安装端')
  assert.match(errs(one({ socket: '+X', mount: '@nope' })), /本件无接口 "@nope"/)
  assert.match(errs(one({ socket: '+X', mount: '@bbox+W' })), /本件无接口/)
})

// ═════════════════════════ ⑧ 安装端候选 ═════════════════════════

t('安装端候选：插座 ∪ @平面面心 ∪ @bbox 六面；mountChoices 去重（同一个系只留插座）；@面 与同位插座解算逐位相同', () => {
  const box = { type: 'prim.box', params: { xM: 0.4, yM: 0.3, zM: 0.2 } }
  const ms = A.componentMounts(box.type, box.params).map((m) => m.id)
  assert.deepEqual(ms, ['root', '+X', '-X', '+Y', '-Y', '+Z', '@+X', '@-X', '@+Y', '@-Y', '@+Z', ...A.MOUNT_BBOX_IDS])
  // prim.box：五个面心接口 = 五个 @面 = 包围盒五面；包围盒 −Z 面心 = root（同一个系）→ 只留插座
  assert.deepEqual(S.mountChoices(box).map((c) => c.id), ['root', '+X', '-X', '+Y', '-Y', '+Z'])
  const thr = S.mountChoices({ type: 'sat.thruster', params: {} })
  assert.ok(thr.length >= 2, '推力器至少两档安装端（B 键循环）')
  assert.deepEqual(thr.map((c) => c.kind), ['socket', 'bbox', 'bbox', 'bbox', 'bbox', 'bbox'])
  assert.equal(S.mountLabel('@+X'), '面心 +X'); assert.equal(S.mountLabel('@bbox-Y'), '包围盒 -Y'); assert.equal(S.mountLabel('aperture'), '口面')
  // @面 与同位插座：同一个系，位姿逐位相同
  const mk = (mount) => docOf([BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [0.2, -0.1], roll: 30, mount }, params: box.params }])
  assert.deepEqual(pose(mk('+X'), 'k'), pose(mk('@+X'), 'k'))
  // @bbox：安装点 = 组件局部包围盒对应面心；mountSocketOf 给出同一个点
  const st = { id: 'k', type: 'sat.sensor.star', parent: 'bus', attach: { mode: 'socket', socket: '+Z', mount: '@bbox+Z' } }
  const ds = docOf([BUS, st])
  const bb = A.componentBox('sat.sensor.star', {}), m = S.mountSocketOf(S.compById(ds, 'k'))
  assert.deepEqual(m.pos, [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, bb[5]].map((v) => (v === 0 ? 0 : v)))
  const busTop = S.compGeo(S.compById(ds, 'bus')).sockets.find((s) => s.id === '+Z').pos
  const p = xf(pose(ds, 'k'), m.pos)
  for (let i = 0; i < 3; i++) near(p[i], busTop[i], 1e-12, `@bbox+Z 安装点贴在 +Z 接口[${i}]`)
  assert.equal(A.componentMount('prim.box', {}, '@nope'), null)
  assert.equal(A.componentMount('prim.box', {}, '+X').id, '+X')
  // 去重只比位置 + 法向（滚转零位不比）：全部组件的候选两两不同位同向（es.subrefl root 与 @bbox-X、es.feed aperture 与 @bbox+X 曾并存）
  const posN = (type, id) => A.componentMount(type, {}, id)
  for (const def of ['es.subrefl', 'es.feed', 'sat.thruster', 'prim.box', 'prim.cyl', 'sat.bus.hex', 'sea.hull', 'air.fuselage']) {
    const ch = S.mountChoices({ type: def, params: {} }).map((c) => posN(def, c.id))
    for (let i = 0; i < ch.length; i++) for (let j = i + 1; j < ch.length; j++) {
      const a = ch[i], b = ch[j]
      const sp = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < 1e-9, sn = a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2] > 1 - 1e-9
      assert.ok(!(sp && sn), `${def}：${a.id} 与 ${b.id} 同位同向`)
    }
  }
  assert.deepEqual(S.mountChoices({ type: 'es.subrefl', params: {} }).filter((c) => c.id === 'root' || c.id === '@bbox-X').map((c) => c.id), ['root'])
  // 件现在用着的安装端落在某组里：由它顶替该组代表（下拉里恒有当前值）
  const cur = S.mountChoices({ type: 'es.subrefl', params: {}, attach: { mount: '@bbox-X' } }).map((c) => c.id)
  assert.ok(cur.includes('@bbox-X') && !cur.includes('root'), cur.join())
  // 中文名：面心按面名、编号面按前缀；六棱柱侧面接口
  assert.equal(S.mountLabel('@deckFwd1'), '面心 前甲板 1'); assert.equal(S.mountLabel('@deckAft2'), '面心 后甲板 2'); assert.equal(S.mountLabel('@bowdeck'), '面心 艏楼甲板')
  assert.equal(S.mountLabel('@side0'), '面心 侧面 1'); assert.equal(S.mountLabel('@top'), '面心 顶面'); assert.equal(S.mountLabel('@+Z'), '面心 +Z')
  assert.equal(S.socketLabel('side5'), '侧面 6'); assert.equal(S.socketLabel('bed'), '货箱'); assert.equal(S.faceLabel('skin'), '蒙皮'); assert.equal(S.faceLabel('bowdeck2'), '艏楼甲板 2')
  for (const ty of ['sea.hull', 'sat.bus.hex', 'veh.body', 'es.shelter']) for (const c of S.mountChoices({ type: ty, params: {} })) assert.ok(!/[a-z]{3,}/.test(c.label), `${ty} ${c.id} → ${c.label}`)
})

// ═════════════════════════ ⑨ 候选净化 ═════════════════════════

t('候选净化：ownMountKey（自由件也算、根件 null、@ 安装端连同位插座）、折叠接口、纯外观件的面不收件、薄贴片穿透、accepts 收紧、§5-9 无杆尖', () => {
  const doc = sat0(), P = A.solvePose(doc), by = (id) => S.compById(doc, id)
  assert.equal(S.ownMountKey(doc, by('rcs1')), 'rcs1|root', '带锚自由件的安装接口')
  assert.equal(S.ownMountKey(doc, by('refl1')), 'refl1|back')
  assert.equal(S.ownMountKey(doc, by('bus')), null, '根件的安装接口（对接环）照常可接')
  assert.deepEqual(S.ownMountKeys(doc, by('bus')), [])
  // '@面' 安装端与本件插座同位同向：那个插座同样压在父件上，不作落点
  const dk = docOf([BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'socket', socket: '+X', mount: '@+Z' }, params: { xM: 0.4, yM: 0.3, zM: 0.2 } }])
  assert.equal(S.ownMountKey(dk, S.compById(dk, 'k')), 'k|+Z')
  assert.deepEqual(S.ownMountKeys(dk, S.compById(dk, 'k')), ['k|+Z', 'k|@+Z'])
  assert.ok(!S.freeSocketsOf(dk, 'k', 'prim.box', null, A.solvePose(dk)).some((s) => s.id === '+Z'), '同位插座不在候选里')
  const dkb = docOf([BUS, { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'socket', socket: '+X', mount: '@bbox+X' } }])
  assert.deepEqual(S.ownMountKeys(dkb, S.compById(dkb, 'k')), ['k|+X', 'k|@bbox+X'], '@bbox 安装端同理')
  const bus = S.compGeo(by('bus')), tower = S.compGeo(by('tower')), refl = S.compGeo(by('refl1'))
  assert.ok(['+X', '-X', '+Y', '-Y', '+Z', '-Z'].every((id) => S.isFoldedSocket(bus, id)), '星体面心接口全是折叠接口')
  assert.equal(S.foldedSocketOf(bus, '+Z').id, '+Z')
  assert.equal(S.foldedSocketOf(tower, '+Z').id, 'top', '塔顶接口折叠进顶面')
  assert.ok(!S.isFoldedSocket(refl, 'focus') && S.foldedSocketOf(refl, 'x') === null)
  // 纯外观件（hasMass 关：展开机构铰座）的面不收件，面心接口一并不收；地球敏感器是敏感器组件，只有自身安装接口、没有面
  for (const id of ['hinge1']) {
    assert.equal(S.faceMountable(by(id), '+X', 'sat.sensor.star'), false, `${id} 面`)
    assert.equal(S.socketUsable(by(id), S.compGeo(by(id)).sockets.find((s) => s.id === '+X'), 'sat.sensor.star'), false, `${id} 面心接口`)
  }
  assert.equal(by('esensor').type, 'sat.sensor.earth')
  assert.deepEqual(S.compGeo(by('esensor')).sockets.map((s) => s.id), ['root'], '地球敏感器只有安装接口')
  assert.equal(S.faceMountable({ type: 'prim.box', params: {} }, '+X', 'sat.sensor.star'), true, '计质量的基本体照常可装')
  assert.equal(S.faceMountable(by('bus'), '+Z', 'sat.sensor.star'), true)
  assert.equal(faceAccepts(getComponent('prim.box'), fillParams(getComponent('prim.box'), { hasMass: false }), { id: 'x' }, 'x.y'), false)
  // accepts 收紧
  const sockOf = (type, id, params = {}) => getComponent(type).sockets(fillParams(getComponent(type), params)).find((s) => s.id === id)
  const ap = sockOf('sat.feed.horn', 'aperture'), tip = sockOf('sat.boom', 'tip'), front = sockOf('sat.array.phased', 'front'), eap = sockOf('es.feed', 'aperture')
  assert.deepEqual(['sat.feed.horn', 'prim.box', 'sat.sensor.star', 'sat.thruster'].map((ty) => socketAccepts(ap, ty)), [true, true, false, false], '喇叭口：馈源链 + 基本体')
  assert.deepEqual(['sat.sensor.star', 'sat.sensor.sun', 'sat.reflector', 'sat.feed.horn', 'sat.array.phased', 'prim.cyl', 'sat.thruster', 'sat.wing', 'sat.boom'].map((ty) => socketAccepts(tip, ty)), [false, false, true, true, true, true, false, false, false], '杆端：天线 / 基本体（星敏 / 太敏是体装件）')
  assert.deepEqual(['prim.box', 'sat.sensor.star'].map((ty) => socketAccepts(front, ty)), [true, false], '阵面：只收基本体')
  assert.deepEqual(['es.feed', 'es.subrefl', 'prim.box', 'es.refl.prime', 'es.radome'].map((ty) => socketAccepts(eap, ty)), [true, true, true, false, false], '地面馈源口')
  // default-sat 拖星敏（编辑器口径：非自身安装接口、未占、可用、非折叠）：候选里没有喇叭口 / rcs 根部 / 反射面背面 / 方块面心
  const used = S.occupiedSocketKeys(doc, P), cand = []
  for (const c of doc.comps) {
    const g = S.compGeo(c), own = S.ownMountKey(doc, c)
    for (const s of g.sockets) {
      const key = `${c.id}|${s.id}`
      if (key === own || used.has(key) || !S.socketUsable(c, s, 'sat.sensor.star', g) || S.isFoldedSocket(g, s.id)) continue
      cand.push(key)
    }
  }
  assert.ok(!cand.some((k) => /\|aperture$/.test(k)), '喇叭口')
  assert.ok(!cand.some((k) => /^rcs\d+\|root$/.test(k)), 'rcs 根部')
  assert.ok(!cand.some((k) => /^refl\d+\|back$/.test(k)), '反射面背面')
  assert.ok(!cand.some((k) => /^(hinge\d+|esensor)\|/.test(k)), '铰座 / 地球敏感器')
  assert.ok(!cand.some((k) => /^bus\|/.test(k)), '星体接口（被占 / 折叠）')
  assert.ok(!cand.some((k) => /\|tip$/.test(k)), '杆尖（§5-9）')
  for (const c of doc.comps) assert.ok(!S.freeSocketsOf(doc, c.id, 'sat.sensor.star', null, P).some((s) => s.id === 'tip'), `${c.id} 的空闲接口里没有杆尖`)
  // 纯外观薄贴片（立方星对地贴片 3 mm）：面不收件、射线穿过它装到后面的星体面上；铰座 / 地敏 / 导轨（厚）不穿；散热面整类薄件照旧
  const cub = A.specToAssembly(templateSpec('cubesat-3u').spec), pbox = getComponent('prim.box')
  const pt = (c) => passThroughOf(getComponent(c.type), fillParams(getComponent(c.type), c.params))
  const patch = S.compById(cub, 'patch')
  assert.ok(patch && pt(patch), '对地贴片穿透')
  assert.equal(S.faceMountable(patch, '+Z', 'sat.sensor.star'), false)
  assert.ok(!pt(S.compById(cub, 'rail1')) && !pt(by('hinge1')) && !pt(by('esensor')) && !pt(by('bus')), '厚的纯外观件 / 星体不穿')
  assert.equal(passThroughOf(pbox, fillParams(pbox, { zM: 0.003 })), false, '计质量的薄板不穿（面照常可装）')
  assert.equal(passThroughOf(getComponent('prim.cyl'), fillParams(getComponent('prim.cyl'), { hM: 0.002, hasMass: false })), true, '纯外观薄圆片')
  assert.equal(passThroughOf(getComponent('sat.radiator'), fillParams(getComponent('sat.radiator'), {})), true, '散热面')
  assert.equal(S.passThroughOf, passThroughOf, 'asmSnap 再出口')
})

// ═════════════════════════ ⑩ 柱面 / 网格 / 推断半径 ═════════════════════════

t('柱面整圆判定 + 局部弧夹紧；自动网格 1-2-5 档；推断半径随屏上短边自适应；MOVE_STEP_OPTS', () => {
  const full = { kind: 'cyl', radius: 0.2, halfU: 0.5, halfV: Math.PI * 0.2 }
  const arc = { kind: 'cyl', radius: 1.8, halfU: 4, halfV: 1.5 }
  assert.ok(S.isFullCyl(full) && !S.isFullCyl(arc) && !S.isFullCyl({ kind: 'plane', halfU: 1, halfV: 1 }))
  assert.equal(S.isFullCyl({ ...full, full: false }), false, '显式标记优先')
  const o = { u: 0, v: 0 }
  S.clampToFace(arc, 0, 1.6, o); assert.equal(o.v, 1.5, '局部弧：越过弧端夹紧，不跳到对侧')
  S.clampToFace(arc, 0, -2, o); assert.equal(o.v, -1.5)
  S.clampToFace(full, 0, Math.PI * 0.2 + 0.1, o); near(o.v, -Math.PI * 0.2 + 0.1, 1e-12, '整圆照旧回绕')
  // 组件上的标记：卫星柱面整圆、机身蒙皮局部弧
  assert.ok(S.compGeo({ type: 'sat.bus.cyl', params: {} }).faces.find((f) => f.id === 'side').full === true)
  const fus = S.compGeo({ type: 'air.fuselage', params: {} }).faces
  assert.ok(fus.length === 4 && fus.every((f) => f.full === false && !S.isFullCyl(f)))
  // 自动网格：短边 / 20 向下取 1-2-5，夹 1 mm–1 m
  const pf = (hu, hv) => ({ kind: 'plane', halfU: hu, halfV: hv })
  assert.equal(S.autoGridStep(pf(0.05, 0.05)), 0.005, '1U 面 0.1 m → 5 mm')
  assert.equal(S.autoGridStep(pf(1.18, 1.05)), 0.1, '2.1 m → 0.1 m')
  assert.equal(S.autoGridStep(pf(50, 10)), 1, '大面夹 1 m')
  assert.equal(S.autoGridStep(pf(0.004, 0.004)), 0.001, '小面夹 1 mm')
  assert.equal(S.autoGridStep(0.6), 0.02, '直接给尺度')
  assert.equal(S.autoGridStep(arc), 0.1, '柱面取 min(轴长, 弧长)')
  assert.equal(S.autoGridStep(null), S.SNAP_DEFAULTS.move)
  assert.deepEqual(S.MOVE_STEP_OPTS, ['auto', ...S.MOVE_STEPS])
  assert.ok(S.MOVE_STEPS.every((v) => typeof v === 'number'), 'MOVE_STEPS 保持纯数字（老调用方）')
  assert.equal(S.resolveMoveStep('auto', pf(0.05, 0.05)), 0.005); assert.equal(S.resolveMoveStep(0.1, null), 0.1); assert.equal(S.resolveMoveStep('x', null), 0)
  // 推断半径：短边 50 px → 点 6 px、线 4 px；不给 shortPx 行为不变
  const f = { kind: 'plane', halfU: 1, halfV: 0.5 }, io = { u: 0, v: 0, ppm: 100, kind: -1 }
  const inf = (u, v, sp) => { io.u = u; io.v = v; io.ppm = 100; S.faceInferIO(f, io, S.INFER_PX, 0, S.INFER_LINE_PX, sp); return io.kind }
  assert.equal(inf(0.08, 0.05, undefined), S.INFER.CENTER, '缺省 12 px：面心')
  assert.equal(inf(0.08, 0.05, 50), S.INFER.FREE, '短边 50 px：半径 6 px，0.094 m 外不吸')
  assert.equal(inf(0.05, 0.02, 50), S.INFER.CENTER, '6 px 内照吸')
  assert.equal(inf(0.3, 0.06, undefined), S.INFER.CLINE, '缺省线推断 8 px')
  assert.equal(inf(0.3, 0.06, 50), S.INFER.FREE, '短边 50 px：线推断 4 px')
  assert.equal(inf(0.08, 0.05, 1000), S.INFER.CENTER, '大面不放大（取 min）')
})

// ═════════════════════════ ⑪ 取锚的绝对上限 ═════════════════════════

t('取锚绝对上限（ANCHOR_MAX_M）：大件安装点嵌进父件 > 0.5 m 不取面、离接口 > 0.5 m 不取接口；朝外离面照常取（≤ 件尺寸）', () => {
  assert.equal(S.ANCHOR_MAX_M, 0.5)
  // 4 m 长杆状方块（件尺寸 4 m：按比例的阈值是 法向 ±4 m、接口 1 m）
  const big = { id: 'k', type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, params: { xM: 4, yM: 0.3, zM: 0.3 } }
  const doc = docOf([BUS, big]), P = A.solvePose(doc), k = S.compById(doc, 'k')
  const W = (z) => S.m4FromQT(new Float64Array(16), [0, 0, 0, 1], [0, 0, z])
  const top = 2.7 / 2
  assert.equal(S.pickAnchor(doc, P, k, 'bus', W(top - 0.8)), null, '嵌进 0.8 m：不挂顶面')
  const inside = S.pickAnchor(doc, P, k, 'bus', W(top - 0.3))
  assert.deepEqual([inside.kind, inside.id], ['face', '+Z'], '嵌进 0.3 m 照常')
  const out = S.pickAnchor(doc, P, k, 'bus', W(top + 1.5))
  assert.deepEqual([out.kind, out.id], ['face', '+Z'], '朝外 1.5 m（塔顶一类）照常取顶面')
  assert.equal(S.pickAnchor(doc, P, k, 'bus', W(top + 0.7), { only: 'socket' }), null, '离接口 0.7 m：不取')
  const s = S.pickAnchor(doc, P, k, 'bus', W(top + 0.4), { only: 'socket' })
  assert.deepEqual([s.kind, s.id], ['socket', '+Z'], '0.4 m 内照取')
  // 小件不受影响：阈值仍按件尺寸（0.3 m 方块：法向 ±0.3 m、接口 max(5 cm, 7.5 cm)）
  const sm = docOf([BUS, { ...big, params: { xM: 0.3, yM: 0.3, zM: 0.3 } }]), Ps = A.solvePose(sm), ks = S.compById(sm, 'k')
  assert.equal(S.pickAnchor(sm, Ps, ks, 'bus', W(top + 0.4)), null)
  assert.equal(S.pickAnchor(sm, Ps, ks, 'bus', W(top + 0.07), { only: 'socket' }).id, '+Z')
})

console.log(`modelAsmAnchor: ${n} 项通过`)
