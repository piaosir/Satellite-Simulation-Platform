// 本体系矩阵 / 四元数工具自测（packages/core/models/bodyFrame.mjs）。运行：node packages/core/test/modelBodyFrame.test.mjs
//
// 为什么测：本体系是挂点、姿态律、质心、视轴的公共基准，错一个符号，所有天线指向都跟着错，而画面上往往看不出来。
// 这里钉死：① 出厂映射 = STK 映射（2026-09-24 定案；三根轴的物理含义、根矩阵 = 其逆）、附录 B 留作对照；② 矩阵 ↔ 四元数互转在四个
// Shepperd 分支上都对，镜像矩阵拒收；③ 90° 步进只会落在 24 个轴对齐朝向上、不累积浮点漂移；④ roll/pitch/yaw 微调的顺序（3-2-1）
// 与欧拉角反解互逆；⑤ 点的换算互逆；⑥ 挂点缺省上向量（二期 D1）；⑦ 坏输入返回 null 不抛；
// ⑧ STK tdrs.glb 口径的合成 glb：挂点节点在 glTF +Y、视轴局部 +Y → 出厂映射下视轴 = 本体 +Z（天底）。
import assert from 'node:assert/strict'
import * as B from '../models/bodyFrame.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const near = (a, b, tol, msg) => {
  const A = [a].flat(2), Bv = [b].flat(2)
  assert.equal(A.length, Bv.length, msg + '（长度）')
  for (let i = 0; i < A.length; i++) assert.ok(Math.abs(A[i] - Bv[i]) <= tol, `${msg}：第 ${i} 个 ${A[i]} vs ${Bv[i]}`)
  pass++
}
// 可复现的伪随机（不依赖 Math.random，失败能重放）
let seed = 20260923
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const randQuat = () => {
  // Shoemake 均匀采样
  const u1 = rnd(), u2 = rnd() * 2 * Math.PI, u3 = rnd() * 2 * Math.PI
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1)
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)]
}
const matMul = (A, Bm) => A.map((r, i) => [0, 1, 2].map((j) => r[0] * Bm[0][j] + r[1] * Bm[1][j] + r[2] * Bm[2][j]))
const Rx = (d) => { const c = Math.cos(d * Math.PI / 180), s = Math.sin(d * Math.PI / 180); return [[1, 0, 0], [0, c, -s], [0, s, c]] }
const Ry = (d) => { const c = Math.cos(d * Math.PI / 180), s = Math.sin(d * Math.PI / 180); return [[c, 0, s], [0, 1, 0], [-s, 0, c]] }
const Rz = (d) => { const c = Math.cos(d * Math.PI / 180), s = Math.sin(d * Math.PI / 180); return [[c, -s, 0], [s, c, 0], [0, 0, 1]] }

// ① 出厂映射 = STK 映射（2026-09-24 定案）；附录 B 留作对照。
//    出厂值的「物理含义」在这里钉：glTF +Y ↦ 本体 +Z（天底）、+Z ↦ +X（速度）、+X ↦ +Y——期望值由 STK 常量 R_GLTF_TO_BODY_STK
//    的列给出，不写死数字；再加 STK tdrs 口径的挂点合成用例（见 modelAgi / 本文件末尾）从几何上把「天线朝天底」钉死。
const R = B.R_GLTF_TO_BODY
const col = (M, j) => [M[0][j], M[1][j], M[2][j]]
eq(B.det3(R), 1, 'det R = +1')
ok(B.isRotationMatrix(R).ok, 'R 是真旋转')
eq(B.DEFAULT_Q_MODEL2BODY, B.Q_MODEL2BODY_STK, '出厂 q = STK 映射（编排者 2026-09-24 定案）')
ok(R === B.R_GLTF_TO_BODY_STK, '出厂 R 与 STK 映射是同一个常量（唯一真值源，不是抄的数）')
eq(B.matToQuat(R), B.DEFAULT_Q_MODEL2BODY, '出厂 R ↔ 出厂 q 一致（符号规范化 w ≥ 0）')
ok(B.quatIsUnit(B.DEFAULT_Q_MODEL2BODY), '出厂 q 单位长')
near(B.quatToMat(B.DEFAULT_Q_MODEL2BODY), R.map((r) => r.slice()), 1e-15, '出厂 q → R')
near(B.modelToBody([0, 1, 0], B.DEFAULT_Q_MODEL2BODY), [0, 0, 1], 1e-15, '出厂：glTF +Y → 本体 +Z（天底：STK 模型的天线面朝地）')
near(B.modelToBody([0, 0, 1], B.DEFAULT_Q_MODEL2BODY), [1, 0, 0], 1e-15, '出厂：glTF +Z（前）→ 本体 +X（速度）')
near(B.modelToBody([1, 0, 0], B.DEFAULT_Q_MODEL2BODY), [0, 1, 0], 1e-15, '出厂：glTF +X → 本体 +Y')
for (let j = 0; j < 3; j++) { const e = [0, 0, 0]; e[j] = 1; near(B.modelToBody(e, B.DEFAULT_Q_MODEL2BODY), col(B.R_GLTF_TO_BODY_STK, j), 1e-15, `出厂 q 作用于 glTF 第 ${j} 轴 = STK 矩阵第 ${j} 列`) }
near(B.quatAngleDeg(B.DEFAULT_Q_MODEL2BODY, B.quatFromAxisAngle([1, 1, 1], 120)), 0, 1e-9, '即绕 (1,1,1)/√3 转 120°')
ok(Object.isFrozen(B.DEFAULT_Q_MODEL2BODY) && Object.isFrozen(R) && Object.isFrozen(R[0]) && Object.isFrozen(B.ROOT_MATRIX_BODY2MODEL), '常量冻结，防调用方就地改')
// 根矩阵 = 出厂映射的逆（列主序）：本体点经它得模型轴点，再经出厂 q 回到原本体点
const RM = B.ROOT_MATRIX_BODY2MODEL
const xf4 = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
eq(RM.length, 16, '根矩阵 16 元')
eq(RM.slice(12), [0, 0, 0, 1], '根矩阵无平移')
ok(RM.every((x) => !Object.is(x, -0)), '根矩阵无 −0')
near(B.modelToBody(xf4(RM, [1, 2, 3]), B.DEFAULT_Q_MODEL2BODY), [1, 2, 3], 1e-15, '出厂 q ∘ 根矩阵 = 恒等')
near(xf4(RM, [1, 2, 3]), B.bodyToModel([1, 2, 3], B.DEFAULT_Q_MODEL2BODY), 1e-15, '根矩阵 = bodyToModel（出厂 q）')
// 附录 B（已废，对照）：body = (gltf.z, −gltf.x, −gltf.y)
const RB = B.R_GLTF_TO_BODY_APPENDIXB, QB = B.Q_MODEL2BODY_APPENDIXB
ok(B.isRotationMatrix(RB).ok, '附录 B 是真旋转')
eq(B.matToQuat(RB), QB, '附录 B R ↔ q')
near(B.modelToBody([0, 1, 0], QB), [0, 0, -1], 1e-15, '附录 B：glTF +Y → 本体 −Z（天顶；这正是它被废的原因）')
near(B.modelToBody([0, 0, 1], QB), [1, 0, 0], 1e-15, '附录 B：glTF +Z → 本体 +X（前向与 STK 相同）')
ok(B.quatAngleDeg(QB, B.DEFAULT_Q_MODEL2BODY) > 179.999, '附录 B 与出厂值差 180°')
near(B.quatAngleDeg(B.DEFAULT_Q_MODEL2BODY, B.quatMul(B.quatFromAxisAngle([1, 0, 0], 180), QB)), 0, 1e-9, 'STK 映射 = 附录 B 再绕本体 X 转 180°（工作台一次「X 180°」即可互换）')
eq(B.axisStep(B.axisStep(QB, 'x', 90), 'x', 90), B.DEFAULT_Q_MODEL2BODY, '两次 X +90° 从附录 B 精确到出厂值（旧数据迁移）')

// ② 互转
for (let k = 0; k < 300; k++) {
  const qv = randQuat()
  const M = B.quatToMat(qv)
  assert.ok(B.isRotationMatrix(M, 1e-12).ok, '随机四元数 → 旋转矩阵')
  const q2 = B.matToQuat(M)
  assert.ok(B.quatAngleDeg(qv, q2) < 1e-6, '矩阵 → 四元数回到同一旋转')
  assert.ok(q2[3] >= 0, '符号规范化 w ≥ 0')
}
pass++
// 四个分支各来一个（迹 > 0；m00 最大；m11 最大；m22 最大）
for (const [axis, deg] of [[[1, 1, 1], 30], [[1, 0, 0], 179], [[0, 1, 0], 179], [[0, 0, 1], 179], [[1, -2, 0.5], 180]]) {
  const qv = B.quatFromAxisAngle(axis, deg)
  near(B.quatAngleDeg(B.matToQuat(B.quatToMat(qv)), qv), 0, 1e-6, `Shepperd 分支 axis=${axis} ${deg}°`)
}
eq(B.matToQuat([[1, 0, 0], [0, 1, 0], [0, 0, -1]]), null, '镜像矩阵（det −1）拒收')
eq(B.matToQuat([[2, 0, 0], [0, 1, 0], [0, 0, 1]]), null, '非正交拒收')
eq(B.quatCanonical([0, 0, 0, -1]), [0, 0, 0, 1], '−I 规范化为 +I')
eq(B.quatCanonical([0, -1, 0, 0]), [0, 1, 0, 0], 'w = 0 时第一个非零分量取正')
ok(!Object.is(B.quatCanonical([-0, 0, 0, 1])[0], -0), '−0 抹成 0（存盘字节确定）')
const m4 = B.mat4FromQuatT(B.DEFAULT_Q_MODEL2BODY, [1, 2, 3])
eq(m4.slice(12, 16), [1, 2, 3, 1], 'mat4 列主序：平移在 12–14')
const v = [0.3, -0.7, 2]
near([m4[0] * v[0] + m4[4] * v[1] + m4[8] * v[2] + m4[12], m4[1] * v[0] + m4[5] * v[1] + m4[9] * v[2] + m4[13], m4[2] * v[0] + m4[6] * v[1] + m4[10] * v[2] + m4[14]],
  B.modelToBody(v, B.DEFAULT_Q_MODEL2BODY, [1, 2, 3]), 1e-15, 'mat4 与 modelToBody 一致')

// ③ 90° 步进
near(B.modelToBody([1, 0, 0], B.axisStep([0, 0, 0, 1], 'z', 90)), [0, 1, 0], 1e-15, '绕本体 Z +90°：+X → +Y（右手）')
near(B.modelToBody([0, 0, 1], B.axisStep(B.DEFAULT_Q_MODEL2BODY, 'x', 90)), [1, 0, 0], 1e-15, '在出厂映射上绕本体 X 转：前向仍是 +X')
near(B.modelToBody([0, 1, 0], B.axisStep(B.DEFAULT_Q_MODEL2BODY, 'x', 90)), [0, -1, 0], 1e-15, '绕本体 X +90°：原来朝 +Z 的 glTF 上方转到 −Y（右手：Z → −Y）')
eq(B.axisStep(B.axisStep(B.DEFAULT_Q_MODEL2BODY, 'y', 90), 'y', -90), B.DEFAULT_Q_MODEL2BODY, '+90 再 −90 精确回原值')
let qq = B.DEFAULT_Q_MODEL2BODY
for (let k = 0; k < 4; k++) qq = B.axisStep(qq, 'z', 90)
eq(qq, B.DEFAULT_Q_MODEL2BODY, '同轴四次 +90° 精确回原值')
// 从单位四元数出发 BFS：六个按钮能到达的朝向恰好 24 个，且都是带符号置换矩阵
const key = (x) => JSON.stringify(x)
const seen = new Map([[key(B.quatCanonical([0, 0, 0, 1])), B.quatCanonical([0, 0, 0, 1])]])
const queue = [...seen.values()]
while (queue.length) {
  const cur = queue.shift()
  for (const ax of ['x', 'y', 'z']) for (const d of [90, -90]) {
    const nx = B.axisStep(cur, ax, d)
    if (!seen.has(key(nx))) { seen.set(key(nx), nx); queue.push(nx) }
  }
}
eq(seen.size, 24, '90° 步进可达朝向 = 24（立方体旋转群）')
ok([...seen.values()].every((x) => B.quatToMat(x).flat().every((e) => Math.abs(e - Math.round(e)) < 1e-15)), '全部是带符号置换矩阵')
// 随机点 1000 次按钮，结果仍精确落在这 24 个里（不漂）
qq = B.DEFAULT_Q_MODEL2BODY
for (let k = 0; k < 1000; k++) qq = B.axisStep(qq, 'xyz'[Math.floor(rnd() * 3)], rnd() < 0.5 ? 90 : -90)
ok(seen.has(key(B.axisStep(B.axisStep(qq, 'x', 90), 'x', -90))), '1000 次随机步进后仍精确在 24 个朝向之一（无浮点漂移）')
eq(B.axisStep(qq, 'X', 180), B.axisStep(B.axisStep(qq, 'x', 90), 'x', 90), '180° = 两次 90°，轴名大小写不敏感')

// ④ 微调
near(B.quatToMat(B.fineRotate([0, 0, 0, 1], 10, 20, 30)), matMul(Rz(30), matMul(Ry(20), Rx(10))), 1e-12, '微调 = Rz(yaw)·Ry(pitch)·Rx(roll)')
near(B.quatToMat(B.fineRotate(B.DEFAULT_Q_MODEL2BODY, 5, -7, 11)), matMul(matMul(Rz(11), matMul(Ry(-7), Rx(5))), R), 1e-12, '微调施加在映射之后（本体系里转）')
for (let k = 0; k < 200; k++) {
  const r = rnd() * 358 - 179, p = rnd() * 178 - 89, y = rnd() * 358 - 179
  const e = B.quatToEulerZYX(B.fineRotate([0, 0, 0, 1], r, p, y))
  assert.ok(Math.abs(e.rollDeg - r) < 1e-7 && Math.abs(e.pitchDeg - p) < 1e-7 && Math.abs(e.yawDeg - y) < 1e-7, `欧拉反解 ${r},${p},${y}`)
  const base = randQuat()
  const e2 = B.relativeEulerZYX(B.fineRotate(base, r, p, y), base)
  assert.ok(Math.abs(e2.rollDeg - r) < 1e-6 && Math.abs(e2.pitchDeg - p) < 1e-6 && Math.abs(e2.yawDeg - y) < 1e-6, '相对 base 的微调量反解')
}
pass++
const gl = B.quatToEulerZYX(B.fineRotate([0, 0, 0, 1], 25, 90, 40))
near([gl.rollDeg, gl.pitchDeg], [0, 90], 1e-6, '万向锁：roll 记 0、pitch = 90')
near(B.quatToMat(B.fineRotate([0, 0, 0, 1], gl.rollDeg, gl.pitchDeg, gl.yawDeg)), B.quatToMat(B.fineRotate([0, 0, 0, 1], 25, 90, 40)), 1e-6, '万向锁下反解的角度仍复原同一朝向')
eq(B.quatToEulerZYX([0, 0, 0, 1]), { rollDeg: 0, pitchDeg: 0, yawDeg: 0 }, '单位旋转 → 全零（无 −0）')

// ⑤ 点的换算
for (let k = 0; k < 50; k++) {
  const qv = randQuat(), t = [rnd() * 10 - 5, rnd() * 10 - 5, rnd() * 10 - 5], p = [rnd() * 4, rnd() * 4, rnd() * 4]
  const b = B.modelToBody(p, qv, t)
  assert.ok(Math.hypot(...B.bodyToModel(b, qv, t).map((x, i) => x - p[i])) < 1e-12, 'bodyToModel ∘ modelToBody = 恒等')
}
pass++
near(B.modelToBody([0, 0, 0], B.DEFAULT_Q_MODEL2BODY, [1, 2, 3]), [1, 2, 3], 0, 't 是模型原点在本体系的位置')
// 先绕 X 转 90°：+Y → +Z；再绕 Z 转 90°：+Z 不动 → 结果 +Z。若顺序反了会得到 −X
near(B.quatRotate(B.quatMul(B.quatFromAxisAngle([0, 0, 1], 90), B.quatFromAxisAngle([1, 0, 0], 90)), [0, 1, 0]), [0, 0, 1], 1e-15, 'quatMul(b, a) = 先 a 后 b')

// ⑥ 挂点缺省上向量（二期契约 D1）：本体 −Y 在视轴法平面的投影，退化取 +X；结果单位长、与视轴正交
eq(B.defaultUpBody([0, 0, 1]), [0, -1, 0], '对地挂点：上向 = 本体 −Y')
eq(B.defaultUpBody([0, 0, -3]), [0, -1, 0], '对天挂点（非单位长也行）：上向 = −Y')
eq(B.defaultUpBody([0, 1, 0]), [1, 0, 0], '视轴 +Y：−Y 投影退化 → +X')
eq(B.defaultUpBody([0, -2, 0]), [1, 0, 0], '视轴 −Y：同上')
eq(B.defaultUpBody([1, 0, 0]), [0, -1, 0], '视轴 +X：上向 −Y')
for (let k = 0; k < 200; k++) {
  const d = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]
  const u = B.defaultUpBody(d)
  const dl = Math.hypot(...d)
  assert.ok(Math.abs(Math.hypot(...u) - 1) < 1e-12 && Math.abs(u[0] * d[0] + u[1] * d[1] + u[2] * d[2]) / dl < 1e-12, '随机视轴：上向单位长且 ⊥ 视轴')
  assert.ok(u[1] <= 1e-12, '上向总在 −Y 半空间（取的是 −Y 的投影）')
}
pass++
eq([B.defaultUpBody([0, 0, 0]), B.defaultUpBody('x'), B.defaultUpBody([1, NaN, 0])], [null, null, null], '坏视轴 → null')
ok(B.isUpDegenerate([0, 0, 1], [0, 0, -2]) && B.isUpDegenerate([0, 0, 1], [0, 0, 0]) && B.isUpDegenerate([0, 0, 1], null), '平行（含反向）/ 零长 / 非法 → 退化')
ok(!B.isUpDegenerate([0, 0, 1], [1e-3, 0, 1]) && !B.isUpDegenerate([0, 0, 1], [1, 0, 0.3]), '有明确横向分量的上向不算退化（手填安装滚转原样保留）')

// ⑦ 坏输入
eq(B.quatNormalize([0, 0, 0, 0]), null, '零四元数 → null')
eq(B.quatNormalize([1, 2, 3]), null, '长度不对 → null')
eq(B.quatNormalize([NaN, 0, 0, 1]), null, 'NaN → null')
eq(B.quatToMat('x'), null, '非数组 → null')
eq(B.det3([[1, 2], [3, 4]]), null, '非 3×3 → null')
eq(B.isRotationMatrix(null).ok, false, 'null 不是旋转矩阵')
eq(B.axisStep(B.DEFAULT_Q_MODEL2BODY, 'w', 90), null, '未知轴 → null')
eq(B.axisStep(B.DEFAULT_Q_MODEL2BODY, 'x', 45), null, '非 90° 倍数 → null')
eq(B.axisStep(null, 'x', 90), null, '坏 q → null')
eq(B.fineRotate(B.DEFAULT_Q_MODEL2BODY, 1, NaN, 0), null, '微调角 NaN → null')
eq(B.modelToBody([1, 2], B.DEFAULT_Q_MODEL2BODY), null, '二维点 → null')
eq(B.modelToBody([1, 2, 3], B.DEFAULT_Q_MODEL2BODY, [0, 0]), null, '坏平移 → null')
eq(B.bodyToModel([1, 2, 3], [0, 0, 0, 0]), null, '零四元数逆变换 → null')
eq(B.quatFromAxisAngle([0, 0, 0], 30), null, '零轴 → null')
eq(B.mat4FromQuatT(B.DEFAULT_Q_MODEL2BODY, 'x'), null, 'mat4 坏平移 → null')
eq(B.relativeEulerZYX([0, 0, 0, 1], [0, 0, 0, 0]), null, '相对欧拉坏 base → null')
eq(B.quatAngleDeg([0, 0, 0, 1], null), null, '夹角坏输入 → null')
ok(!B.quatIsUnit([0, 0, 0, 1.01]) && B.quatIsUnit([0, 0, 0, 1 + 5e-7]), 'quatIsUnit 容差 1e-6')

// ⑧ STK tdrs.glb 口径（合成件，不含任何 STK 文件）：真 glb 二进制走「打包 → 解包 → 读 AGI → 挂点位姿（缺省 frame = 出厂映射）」。
//    tdrs.glb 实测：天线挂点节点挂在 glTF +Y 面、节点局部 +Y = glTF +Y（口面朝向）、对称的两副绕口面法向差 180°；
//    节点有的用 matrix、有的用 TRS，且挂在带平移的父节点下。出厂映射下视轴必须全是本体 +Z（天底）。
const { buildGlb, parseGlb } = await import('../models/glb.mjs')
const A = await import('../models/agi.mjs')
const S2 = Math.SQRT1_2
const tdrsJson = {
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
  extensionsUsed: ['AGI_articulations'],
  nodes: [
    { name: 'TDRS', children: [1, 2, 3, 4], translation: [0, 0.4, 0] },
    // 矩阵写法：局部 x=(0,0,−1)、y=(0,1,0)、z=(1,0,0)（绕 glTF Y 转 +90°），位置在 +Y 面
    { name: 'SA_E_Attachpoint', matrix: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2.0, 5.2, 1], extensions: { AGI_articulations: { isAttachPoint: true } } },
    // TRS 写法：绕 glTF Y 转 −90°（与 E 对称：局部 +X、+Z 都反向，+Y 相同）
    { name: 'SA_W_Attachpoint', translation: [0, 2.0, -3.3], rotation: [0, -S2, 0, S2], extensions: { AGI_articulations: { isAttachPoint: true } } },
    // 多址阵：无旋转，挂点在 +Y 面中心
    { name: 'MA_Attachpoint', translation: [0.1, 1.6, 0], extensions: { AGI_articulations: { isAttachPoint: true } } },
    // 主发动机羽流挂点在 −Y：局部 +Y 朝 glTF −Y（绕 X 转 180°）→ 本体 −Z（天顶）
    { name: 'Engine_Attachpoint', translation: [0, -1.5, 0], rotation: [1, 0, 0, 0], extensions: { AGI_articulations: { isAttachPoint: true } } }
  ]
}
const tdrsGlb = buildGlb(tdrsJson, null)
const tdrsParsed = parseGlb(tdrsGlb)
ok(tdrsParsed.ok, '合成 tdrs glb 解包成功')
const tdrsAgi = A.readAgiFromGltfJson(tdrsParsed.json)
eq(tdrsAgi.attachPoints.map((p) => p.name), ['SA_E_Attachpoint', 'SA_W_Attachpoint', 'MA_Attachpoint', 'Engine_Attachpoint'], '四个挂点都读到')
const tdrsPoses = Object.fromEntries(A.attachPointPoses(tdrsParsed.json, tdrsAgi.attachPoints).map((p) => [p.name, p]))
for (const nm of ['SA_E_Attachpoint', 'SA_W_Attachpoint', 'MA_Attachpoint']) {
  near(tdrsPoses[nm].dirBody, [0, 0, 1], 1e-12, `${nm}：局部 +Y 在 glTF +Y → 出厂映射下视轴 = 本体 +Z（天底）`)
  near(tdrsPoses[nm].upBody.reduce((s, u, k) => s + u * tdrsPoses[nm].dirBody[k], 0), 0, 1e-12, `${nm}：上向 ⊥ 视轴`)
}
near(tdrsPoses.Engine_Attachpoint.dirBody, [0, 0, -1], 1e-12, '发动机挂点（局部 +Y 朝 glTF −Y）→ 本体 −Z（天顶）')
// 位置：父平移 (0,0.4,0) + 子平移；glTF (x,y,z) ↦ 本体 (z,x,y)（出厂 R 的列）
near(tdrsPoses.SA_E_Attachpoint.posBody, B.modelToBody([0, 2.4, 5.2], B.DEFAULT_Q_MODEL2BODY), 1e-12, 'SA_E 位置（含父平移）按出厂映射')
near(tdrsPoses.SA_E_Attachpoint.posBody, [5.2, 0, 2.4], 1e-12, 'SA_E 在本体 +X（东 / 速度向）、+Z 面（天底面）')
near(tdrsPoses.SA_W_Attachpoint.posBody, [-3.3, 0, 2.4], 1e-12, 'SA_W 在本体 −X')
// 对称两副的上向（节点局部 +X）相反，但视轴相同——若按 +Z 当视轴会指向相反的横向（agi.mjs 口径注释）
near(tdrsPoses.SA_E_Attachpoint.upBody, tdrsPoses.SA_W_Attachpoint.upBody.map((v) => -v), 1e-12, '对称安装：上向相反、视轴相同')
// 同一 glb 按附录 B 解释会把天线翻到天顶（这就是换映射的原因）
const posesB = A.attachPointPoses(tdrsParsed.json, tdrsAgi.attachPoints, { q_model2body: B.Q_MODEL2BODY_APPENDIXB })
near(posesB.find((p) => p.name === 'MA_Attachpoint').dirBody, [0, 0, -1], 1e-12, '对照：附录 B 下多址阵视轴 = 本体 −Z（天顶，错）')
// 写回端：attachNodeMatrix 造的节点按出厂映射读回同一视轴（参数化模型 / 导出件走这条路）
const Mroot = B.ROOT_MATRIX_BODY2MODEL
const apNode = A.attachNodeMatrix([1, 2, 3], [0, 0, 1], null)
const jj = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'root', matrix: [...Mroot], children: [1] }, { name: 'ap', matrix: apNode, extensions: { AGI_articulations: { isAttachPoint: true } } }] }
const back = A.attachPointPoses(parseGlb(buildGlb(jj, null)).json, [{ name: 'ap' }])[0]
near(back.posBody, [1, 2, 3], 1e-12, '根矩阵 + attachNodeMatrix → 读回位置')
near(back.dirBody, [0, 0, 1], 1e-12, '根矩阵 + attachNodeMatrix → 读回视轴 +Z')
near(back.upBody, B.defaultUpBody([0, 0, 1]), 1e-12, '上向缺省按 D1（本体 −Y）')

// ⑨ 导入缺省按来源（轴映射终案 ②，2026-09-24）：Q_YUP_ZENITH 的物理含义、defaultImportQ 的优先级、quatFromBodyAxes 的轴语义
ok(B.Q_YUP_ZENITH === B.Q_MODEL2BODY_APPENDIXB, 'Q_YUP_ZENITH 就是附录 B 那一版（同一个常量，不另抄数）')
ok(B.R_GLTF_TO_BODY_YUP_ZENITH === B.R_GLTF_TO_BODY_APPENDIXB, 'R_GLTF_TO_BODY_YUP_ZENITH 同上')
ok(B.Q_STK === B.Q_MODEL2BODY_STK && B.Q_STK === B.DEFAULT_Q_MODEL2BODY, 'Q_STK = STK 映射 = 出厂 q（导出目标不变）')
near(B.Q_YUP_ZENITH, [-0.5, 0.5, -0.5, 0.5], 0, 'Q_YUP_ZENITH 数值')
ok(Object.isFrozen(B.Q_YUP_ZENITH) && Object.isFrozen(B.Q_STK), '两个常量都冻结')
near(B.quatRotate(B.Q_YUP_ZENITH, [0, 1, 0]), [0, 0, -1], 1e-12, 'Q_YUP_ZENITH：glTF +Y ↦ 本体 −Z（天顶）')
near(B.quatRotate(B.Q_YUP_ZENITH, [0, 0, 1]), [1, 0, 0], 1e-12, 'Q_YUP_ZENITH：glTF +Z ↦ 本体 +X（速度）')
near(B.quatRotate(B.Q_YUP_ZENITH, [1, 0, 0]), [0, -1, 0], 1e-12, 'Q_YUP_ZENITH：glTF +X ↦ 本体 −Y')
near(B.quatAngleDeg(B.axisStep(B.Q_YUP_ZENITH, 'x', 180), B.Q_STK), 0, 1e-9, 'STK = +Y 天顶映射再绕本体 X 转 180°（工作台一键互换）')
// defaultImportQ 的三级优先级
const DQ = B.defaultImportQ
for (const k of ['nasa', 'user', 'community', 'builtin', undefined, '', 'weird']) {
  eq(DQ({ sourceKind: k }), [...B.Q_YUP_ZENITH], `sourceKind=${JSON.stringify(k)} → +Y 天顶`)
}
eq(DQ(), [...B.Q_YUP_ZENITH], '不传参数 → +Y 天顶')
// 入参不是对象（调用方常写 DQ(meta && meta.src)）：不抛，按空对象 → +Y 天顶（模块头「坏输入不抛」）
for (const bad of [null, undefined, 0, 1, '', 'nasa', true, NaN]) {
  let r
  try { r = DQ(bad) } catch (e) { r = e }
  eq(r, [...B.Q_YUP_ZENITH], `defaultImportQ(${String(bad)}) → +Y 天顶，不抛`)
}
for (const k of ['stk-local', 'param']) eq(DQ({ sourceKind: k }), [...B.Q_STK], `sourceKind=${k} → STK 映射`)
eq(DQ({ sourceKind: 'nasa', hasAgi: true }), [...B.Q_STK], '带 AGI 扩展 → STK 映射（压过来源）')
eq(DQ({ sourceKind: 'nasa', hasAgi: 1 }), [...B.Q_YUP_ZENITH], 'hasAgi 只认布尔 true')
eq(DQ({ sourceKind: 'user', satsimFrame: true }), [...B.Q_STK], '有 extras.satsim.frame 但没给 q → STK 映射')
eq(DQ({ sourceKind: 'user', satsimFrame: {} }), [...B.Q_STK], 'extras.satsim.frame 为空对象 → STK 映射')
const qSat = B.quatFromAxisAngle([0, 0, 1], 30)
near(DQ({ sourceKind: 'user', satsimFrame: { q_model2body: qSat } }), B.quatCanonical(qSat), 1e-15, 'extras 带 q_model2body → 用它')
near(DQ({ sourceKind: 'stk-local', hasAgi: true, satsimFrame: { q: qSat.map((v) => -v) } }), B.quatCanonical(qSat), 1e-15, 'extras 的简写 q 也认；符号规范化（w ≥ 0）；压过 STK 来源')
near(DQ({ satsimFrame: { q_model2body: qSat.map((v) => v * 1.05) } }), B.quatCanonical(qSat), 1e-12, '近单位长（JSON 截断过位数）重新归一')
eq(DQ({ sourceKind: 'nasa', satsimFrame: { q_model2body: [0, 0, 0, 3] } }), [...B.Q_STK], 'extras 的 q 离单位长太远 → 不用它，按「带 extras」回 STK 映射')
eq(DQ({ sourceKind: 'nasa', satsimFrame: { q_model2body: [0, 0, 1] } }), [...B.Q_STK], 'extras 的 q 长度不对 → 同上')
const dq1 = DQ({ sourceKind: 'nasa' })
dq1[0] = 99
eq(DQ({ sourceKind: 'nasa' }), [...B.Q_YUP_ZENITH], '返回新数组：调用方改它不污染常量')
// quatFromBodyAxes：「天底 / 速度在模型系哪个轴」→ q
eq(B.quatFromBodyAxes('-Y', '+Z'), [...B.Q_YUP_ZENITH], 'quatFromBodyAxes(−Y 天底, +Z 速度) = Q_YUP_ZENITH')
eq(B.quatFromBodyAxes('+Y', '+Z'), [...B.Q_STK], 'quatFromBodyAxes(+Y 天底, +Z 速度) = Q_STK')
eq(B.quatFromBodyAxes('−y', 'z'), [...B.Q_YUP_ZENITH], '轴名大小写 / Unicode 负号 / 省略正号都认')
{
  const names = ['+X', '-X', '+Y', '-Y', '+Z', '-Z']
  const seen = new Set()
  let n = 0
  for (const nd of names) for (const vl of names) {
    const q = B.quatFromBodyAxes(nd, vl)
    if (nd.slice(1) === vl.slice(1)) { assert.equal(q, null, `${nd}/${vl} 平行 → null`); continue }
    const ndv = B.axisVec(nd), vlv = B.axisVec(vl)
    assert.ok(Math.max(...B.quatRotate(q, ndv).map((v, k) => Math.abs(v - [0, 0, 1][k]))) < 1e-12, `${nd}/${vl}：天底轴 ↦ 本体 +Z`)
    assert.ok(Math.max(...B.quatRotate(q, vlv).map((v, k) => Math.abs(v - [1, 0, 0][k]))) < 1e-12, `${nd}/${vl}：速度轴 ↦ 本体 +X`)
    assert.ok(q.every((v) => [0, 0.5, -0.5, 1, -1, Math.SQRT1_2, -Math.SQRT1_2].some((c) => Math.abs(v - c) < 1e-15)), `${nd}/${vl}：分量吸附成精确值`)
    seen.add(JSON.stringify(q)); n++
  }
  eq([n, seen.size], [24, 24], '6×4 种（天底, 速度）组合恰好给出 24 个不同的轴对齐朝向')
}
near(B.quatRotate(B.quatFromBodyAxes('-Y', '+Z', 90), [0, 0, 1]), [0, 1, 0], 1e-12, 'yawDeg=+90：原速度轴绕本体 Z 右手转到 +Y')
near(B.quatRotate(B.quatFromBodyAxes('-Y', '+Z', 90), [0, -1, 0]), [0, 0, 1], 1e-12, 'yaw 不动天底')
near(B.quatRotate(B.quatFromBodyAxes('-Y', '+Z', 30), [0, 0, 1]), [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0], 1e-12, 'yaw 30°（非轴对齐）')
near(B.quatRotate(B.quatFromBodyAxes([0, -2, 0], [0, 0.5, 3]), [0, 0, 1]), [1, 0, 0], 1e-12, '向量写法：速度先去掉沿天底的分量再归一')
eq([B.quatFromBodyAxes('+X', '+X'), B.quatFromBodyAxes([0, 0, 0], '+X'), B.quatFromBodyAxes('up', '+X'), B.quatFromBodyAxes('+X', '+Y', NaN), B.quatFromBodyAxes(null, '+Y')], [null, null, null, null, null], '平行 / 零长 / 认不出 / yaw 非法 → null')

// ⑩ 导入缺省加类别（DESIGN3 E5，P3 契约 §2.2）：飞机 / 船 / 车 / 地球站一律 +Y 天顶，类别优先于来源 / AGI；
//    文件自带 q 仍最优先；不传 kind（或 kind 不是实体类别）时与加类别规则之前逐位相同
{
  eq(B.ENTITY_KINDS, ['aircraft', 'ship', 'vehicle', 'ground'], 'ENTITY_KINDS：飞机 / 船 / 车 / 地球站（地球站沿用 ground）')
  ok(Object.isFrozen(B.ENTITY_KINDS), 'ENTITY_KINDS 冻结')
  const YUP = [...B.Q_YUP_ZENITH], STK = [...B.Q_STK]
  // 旧版（加类别之前）defaultImportQ 的逐字副本：对拍「不传 kind 逐位不变」
  const oldDQ = (o) => {
    const { sourceKind, hasAgi, satsimFrame } = o && typeof o === 'object' ? o : {}
    const isQ = (q) => (Array.isArray(q) || ArrayBuffer.isView(q)) && q.length === 4 && [0, 1, 2, 3].every((i) => typeof q[i] === 'number' && Number.isFinite(q[i]))
    if (satsimFrame && typeof satsimFrame === 'object') {
      const q = isQ(satsimFrame.q_model2body) ? satsimFrame.q_model2body : (isQ(satsimFrame.q) ? satsimFrame.q : null)
      if (q) { const n = Math.hypot(q[0], q[1], q[2], q[3]); if (n > 0.9 && n < 1.1) { const c = B.quatCanonical(q); if (c) return c } }
    }
    if (satsimFrame || hasAgi === true || ['stk-local', 'param'].includes(sourceKind)) return STK.slice()
    return YUP.slice()
  }
  const srcs = [undefined, 'nasa', 'user', 'community', 'builtin', 'stk-local', 'param', 'x']
  const agis = [undefined, true, false, 1]
  const frames = [null, undefined, true, {}, { q_model2body: [0, 0, 0, 1] }, { q: [0, 0, 0.6, 0.8] }, { q_model2body: [0, 0, 0, 5] }, { q_model2body: [0, 0, 0, -1] }, { q_model2body: [0.1, 0.2, 0.3, 0.927] }]
  let n = 0
  for (const sourceKind of srcs) for (const hasAgi of agis) for (const satsimFrame of frames) {
    const base = { sourceKind, hasAgi, satsimFrame }
    const want = oldDQ(base)
    for (const kind of [undefined, 'spacecraft', 'station', 'launcher', 'other', 'component', 'Aircraft', 7, null]) {
      const got = DQ(kind === undefined ? base : { ...base, kind })
      assert.deepEqual(got, want, `不传 / 非实体 kind 逐位不变：${JSON.stringify({ ...base, kind })}`)
      assert.ok(got.every((v, i) => Object.is(v, want[i])), `逐位（含 −0）：${JSON.stringify({ ...base, kind })}`)
      n++
    }
  }
  ok(n === srcs.length * agis.length * frames.length * 9, `对拍 ${n} 例`)
  // 四级优先级
  for (const kind of B.ENTITY_KINDS) {
    eq(DQ({ kind, sourceKind: 'stk-local' }), YUP, `${kind}：类别胜过 STK 本机来源`)
    eq(DQ({ kind, sourceKind: 'param' }), YUP, `${kind}：类别胜过参数化来源`)
    eq(DQ({ kind, hasAgi: true }), YUP, `${kind}：类别胜过 AGI 扩展`)
    eq(DQ({ kind, satsimFrame: true }), YUP, `${kind}：类别胜过「有 extras.satsim.frame 但没给 q」`)
    eq(DQ({ kind, satsimFrame: { q_model2body: [0, 0, 0, 5] } }), YUP, `${kind}：文件 q 模长不对 → 按类别`)
    eq(DQ({ kind, satsimFrame: { q_model2body: STK }, sourceKind: 'nasa' }), STK, `${kind}：文件自带 q 仍最优先`)
    eq(DQ({ kind, satsimFrame: { q: [0, 0, 0, -1] } }), [0, 0, 0, 1], `${kind}：文件简写 q 规范化后采用`)
  }
  eq(DQ({ kind: 'spacecraft', sourceKind: 'stk-local' }), STK, '卫星类 STK 件仍是 STK 映射')
  eq(DQ({ kind: 'ground', sourceKind: 'nasa' }), YUP, 'NASA 地面站（ground 组）照旧 +Y 天顶')
  const r = DQ({ kind: 'ship' }); r[0] = 9
  eq(DQ({ kind: 'ship' }), YUP, '返回新数组（改返回值不影响常量）')
}

console.log(`modelBodyFrame: ${pass} 项通过`)
