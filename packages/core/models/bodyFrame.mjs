// 模型轴 → 本体系的矩阵与四元数工具（任务书附录 B 的职责；设计契约 §3.2 frame 字段、T3）。
//
// 为什么单独成模块：本体系（+X 沿速度、+Z 指地心、+Y 补全右手系）是挂点、姿态律、质心、装配偏置、
// 视轴的公共基准，工作台（渲染端）、主进程、离线管线、单测都要用同一套数；放 packages/core/models 的
// ESM 纯函数里，任何一端直接 import，不依赖 three（主进程与 worker 不能 require three，见 deps 报告）。
//
// ★ 出厂映射的唯一真值源（2026-09-24 编排者定案：切到 STK 映射）：DEFAULT_Q_MODEL2BODY / R_GLTF_TO_BODY 只在本文件定义。
//   其余各处（schema 兜底、paramBus 根节点、渲染端 view.js 显示系、exporter 烘焙目标、离线管线写进 meta 的 q、单测）
//   一律 import 这里的常量（渲染端经 view.js 转出），不许再写死数字——将来若再换映射，只动本文件。
//
// 约定（全文件统一，改之前先想清楚所有调用方）：
//   · 四元数 [x, y, z, w]，Hamilton 乘法，主动旋转 v' = q v q*——与 THREE.Quaternion 完全同一口径，
//     可直接 new THREE.Quaternion(...q)。复合「先 a 后 b」= quatMul(b, a)（与 three 的 qb.multiply(qa) 同）。
//   · 3×3 矩阵用嵌套数组、行主序（数学写法 R[行][列]），v' = R · v。与 three 交换时用 mat4FromQuatT（列主序 16 元）。
//   · frame 的含义：v_body = R(q_model2body) · v_model + t_model2body。t 让质心（或几何中心）落到本体原点，
//     所以 t = −R · com_model。
//   · 四元数符号规范化：w ≥ 0（w = 0 时第一个非零分量取正）。q 与 −q 是同一个旋转，规范化只为让
//     存盘、比较、哈希结果确定，不影响几何。
//
// 导出：
//   R_GLTF_TO_BODY, DEFAULT_Q_MODEL2BODY（出厂映射 = STK 映射）
//   R_GLTF_TO_BODY_STK, Q_MODEL2BODY_STK（按本机 STK 12 自带模型核定的映射，出厂值即它）
//   R_GLTF_TO_BODY_APPENDIXB, Q_MODEL2BODY_APPENDIXB（任务书附录 B 原值：不再是出厂值，但数值即下面的 +Y 天顶映射）
//   Q_STK（= Q_MODEL2BODY_STK）、R_GLTF_TO_BODY_YUP_ZENITH / Q_YUP_ZENITH（= 附录 B：glTF +Y 天顶）、defaultImportQ（导入缺省：类别优先、再按来源）、
//   ENTITY_KINDS（飞机 / 船 / 车 / 地球站：导入缺省恒为 +Y 天顶的四类，DESIGN3 E5）、
//   axisVec, quatFromBodyAxes（「天底 / 速度在模型系哪个轴」→ q，逐件标定用）
//   ROOT_MATRIX_BODY2MODEL（出厂映射的逆，列主序 4×4：本体系坐标挂在它下面即得模型轴坐标）
//   det3, isRotationMatrix, matToQuat, quatToMat, mat4FromQuatT
//   quatNormalize, quatCanonical, quatMul, quatConj, quatRotate, quatFromAxisAngle, quatAngleDeg, quatIsUnit
//   axisStep, fineRotate, quatToEulerZYX, relativeEulerZYX, snapQuat
//   modelToBody, bodyToModel
//   defaultUpBody(dir), isUpDegenerate(dir, up)（挂点上向量的二期 D1 规则）
//
// 坏输入一律返回 null（不抛），调用方判空即可；数学函数不往外扔异常，避免一处 NaN 让整个面板白屏。

const DEG = Math.PI / 180

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isVec3 = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2])
const isQuatLike = (q) => (Array.isArray(q) || ArrayBuffer.isView(q)) && q.length === 4 && isNum(q[0]) && isNum(q[1]) && isNum(q[2]) && isNum(q[3])
const isMat3 = (m) => Array.isArray(m) && m.length === 3 && m.every((r) => Array.isArray(r) && r.length === 3 && r.every(isNum))

// ─────────────────────────────── 附录 B（已废，留作对照） ───────────────────────────────

/**
 * 任务书附录 B 原写的映射（2026-09-24 起不再是出厂值）：glTF（+Y 上、+Z 前）→ 本体系：
 *   body.x = gltf.z，body.y = −gltf.x，body.z = −gltf.y。det = +1。四元数 [−0.5, 0.5, −0.5, 0.5]。
 * 附录 B 自己要求「用带反射面的 STK 模型验证，不对就改矩阵」——验证结果是不对（STK 天线全朝天顶），见下方 STK 映射的证据。
 * 留着它三件事：单测对照（STK = 它再绕本体 X 转 180°）；认出 2026-09-24 以前写出的 meta / 导出件里的旧 q；
 * 轴映射终案 ②（同日）起它以 Q_YUP_ZENITH 的名字复活——NASA 语料与普通导入件的缺省（见下方 defaultImportQ）。
 * ★ 带这个 q 的旧数据不能自动改写成新出厂值：当时的导出件是按它把几何烘进 glTF 的，q 与几何自洽，改了反而翻倒；
 *   只有「几何没动、q 只是旧缺省」的条目才该换——两种情况从数据上分不出来，交给用户在工作台点一次「X 180°」。
 */
export const R_GLTF_TO_BODY_APPENDIXB = Object.freeze([
  Object.freeze([0, 0, 1]),
  Object.freeze([-1, 0, 0]),
  Object.freeze([0, -1, 0])
])

// ─────────────────────────────── 矩阵 ───────────────────────────────

/** 3×3 行列式；输入不合法返回 null。 */
export function det3(m) {
  if (!isMat3(m)) return null
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
       - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
       + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/**
 * 是否为真旋转矩阵：正交（RᵀR = I，逐元误差 ≤ tol）且 det = +1。
 * 为什么要查 det：det = −1 是镜像，套到模型上会把左右翻过来、法线全反，肉眼常看不出，但挂点方向会错。
 * @returns {{ok:boolean, det:number|null, orthoErr:number|null}}
 */
export function isRotationMatrix(m, tol = 1e-9) {
  if (!isMat3(m)) return { ok: false, det: null, orthoErr: null }
  let err = 0
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0
      for (let k = 0; k < 3; k++) s += m[k][i] * m[k][j]
      err = Math.max(err, Math.abs(s - (i === j ? 1 : 0)))
    }
  }
  const d = det3(m)
  return { ok: err <= tol && Math.abs(d - 1) <= Math.max(tol, 1e-12) * 3, det: d, orthoErr: err }
}

/** 四元数 → 3×3 行主序旋转矩阵。q 不必单位长，先归一；非法返回 null。 */
export function quatToMat(q) {
  const u = quatNormalize(q)
  if (!u) return null
  const [x, y, z, w] = u
  const xx = x * x, yy = y * y, zz = z * z
  const xy = x * y, xz = x * z, yz = y * z
  const wx = w * x, wy = w * y, wz = w * z
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)]
  ]
}

/**
 * 旋转矩阵 → 四元数（Shepperd 分支法，与 THREE.Quaternion.setFromRotationMatrix 同式），结果符号规范化。
 * 不是旋转矩阵（含 det = −1 的镜像）返回 null：镜像没有对应的四元数，硬转只会得到一个错的旋转。
 */
export function matToQuat(m, tol = 1e-6) {
  if (!isRotationMatrix(m, tol).ok) return null
  const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2]
  const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2]
  const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2]
  const tr = m00 + m11 + m22
  let x, y, z, w
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1)
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s
  }
  return quatCanonical([x, y, z, w])
}

/**
 * q + t → 4×4 列主序（three Matrix4.fromArray / glTF node.matrix 口径）：v' = R·v + t。
 * t 缺省为 0。非法返回 null。
 */
export function mat4FromQuatT(q, t = [0, 0, 0]) {
  const R = quatToMat(q)
  if (!R || !isVec3(t)) return null
  return [
    R[0][0], R[1][0], R[2][0], 0,
    R[0][1], R[1][1], R[2][1], 0,
    R[0][2], R[1][2], R[2][2], 0,
    t[0], t[1], t[2], 1
  ]
}

// ─────────────────────────────── 四元数 ───────────────────────────────

/** 归一化；零长或非法返回 null。 */
export function quatNormalize(q) {
  if (!isQuatLike(q)) return null
  const n = Math.hypot(q[0], q[1], q[2], q[3])
  if (!(n > 1e-12)) return null
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** 归一 + 符号规范化（w ≥ 0；w = 0 时第一个非零分量取正），让同一旋转只有一种写法。 */
export function quatCanonical(q) {
  const u = quatNormalize(q)
  if (!u) return null
  let flip = u[3] < 0
  if (u[3] === 0) {
    for (let i = 0; i < 3; i++) { if (u[i] !== 0) { flip = u[i] < 0; break } }
  }
  // 把 −0 也抹成 0：JSON 里 −0 与 0 写法不同，会让「同一个旋转两次存盘字节不同」
  return (flip ? u.map((v) => -v) : u).map((v) => (v === 0 ? 0 : v))
}

/** 是否单位四元数（|‖q‖ − 1| ≤ tol）。校验器用；tol 默认 1e-6，够 JSON 往返的 15 位有效数字。 */
export function quatIsUnit(q, tol = 1e-6) {
  if (!isQuatLike(q)) return false
  return Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) <= tol
}

/** Hamilton 积 a ⊗ b（先 b 后 a）。非法返回 null。 */
export function quatMul(a, b) {
  if (!isQuatLike(a) || !isQuatLike(b)) return null
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ]
}

/** 共轭（单位四元数即逆）。 */
export function quatConj(q) {
  if (!isQuatLike(q)) return null
  return [-q[0], -q[1], -q[2], q[3]]
}

/** 用 q 旋转向量 v（q 先归一）。非法返回 null。 */
export function quatRotate(q, v) {
  const R = quatToMat(q)
  if (!R || !isVec3(v)) return null
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]
  ]
}

/** 轴角 → 四元数（角度制，右手、逆时针为正）。轴不必单位长；零轴返回 null。 */
export function quatFromAxisAngle(axis, deg) {
  if (!isVec3(axis) || !isNum(deg)) return null
  const n = Math.hypot(axis[0], axis[1], axis[2])
  if (!(n > 1e-12)) return null
  const h = deg * DEG / 2
  const s = Math.sin(h) / n
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]
}

/** 两个旋转之间的夹角（度，0..180），用于判「是否相等」而不受 q/−q 符号影响。 */
export function quatAngleDeg(a, b) {
  const ua = quatNormalize(a), ub = quatNormalize(b)
  if (!ua || !ub) return null
  // 用 atan2(|虚部|, |实部|) 而不是 acos(点积)：小角度时 acos 在 1 附近丢精度（1e-16 的点积误差就是 1e-6° 的角度误差）
  const r = quatMul(ua, quatConj(ub))
  return 2 * Math.atan2(Math.hypot(r[0], r[1], r[2]), Math.abs(r[3])) / DEG
}

/** 附录 B 的四元数 = [−0.5, 0.5, −0.5, 0.5]（绕 (−1,1,−1)/√3 转 120°）。已废，只作对照。 */
export const Q_MODEL2BODY_APPENDIXB = Object.freeze(matToQuat(R_GLTF_TO_BODY_APPENDIXB))

// ─────────────────────────────── STK 映射（出厂值） ───────────────────────────────

/**
 * ★ 按本机 STK 12 自带 glb 核定的 STK 实际映射：body.x = gltf.z，body.y = gltf.x，body.z = gltf.y（= 附录 B 再绕本体 X 转 180°）。
 *   即 glTF +Y ↦ 本体 +Z（天底），glTF +Z ↦ 本体 +X（速度），glTF +X ↦ 本体 +Y。
 * 2026-09-23 核验，审查员用 STK 12.8 帮助 + tdrs.glb 几何独立复核，结论相同；2026-09-24 编排者定案切为出厂值。证据：
 *   · STK 帮助 referenceframesvehicle.htm：飞机 / 地面载具的缺省姿态把本体 +Z 约束到径向（朝上），卫星把 +Z 对准天底；
 *     vo/glTFmodel.htm：「+Y is up, per the glTF specification」，pointingVector 的例子是「太阳翼朝上 → [0,1,0]」；
 *   · STK 的 aircraft / c-130 / f16 / ship glb：+Y 朝上（垂尾、桅杆在 +Y），+Z 朝前（导弹、火箭尾焰挂点在 −Z）→ glTF +Y ↦ 本体 +Z；
 *   · 同一映射下 tdrs.glb 的 MA 相控阵、两副 SA 反射面（pointingVector 在世界系为 +Y）、SGL 天线全在 glTF +Y 面、主发动机羽流在 −Y，
 *     全部天线挂点节点的视轴（节点局部 +Y，见 agi.mjs「挂点节点的轴向口径」）也是 glTF +Y；gps2.glb 的导航天线阵也在 +Y——
 *     它们朝天底才对，与「glTF +Y ↦ 本体 +Z」一致；按附录 B 则全朝天顶；
 *   · tdrs.glb 的太阳翼沿 glTF ±X ↦ 本体 ±Y（GEO 南北向）、SA_E / SA_W 沿 glTF ±Z ↦ 本体 ±X（东西向，E 在 +X 即速度向）。
 * 后果（为什么必须全仓同一个数）：导入的 STK 模型不用手调就是对的；我们导出的 glb（exporter 把轴向烘成出厂映射）在 STK 里
 *   天线朝地；参数化模型（paramBus 根节点 = 出厂映射的逆）与二者同口径。NASA 美术模型与普通导入件【不】按它解释：
 *   导入缺省按来源走 defaultImportQ（+Y 天顶），逐件核过的 NASA 条目再由 frame-overrides.json 覆盖；工作台里用「X/Y/Z ±90°」改。
 */
export const R_GLTF_TO_BODY_STK = Object.freeze([
  Object.freeze([0, 0, 1]),
  Object.freeze([1, 0, 0]),
  Object.freeze([0, 1, 0])
])
/** R_GLTF_TO_BODY_STK 的四元数 = [0.5, 0.5, 0.5, 0.5]（绕 (1,1,1)/√3 转 120°）。 */
export const Q_MODEL2BODY_STK = Object.freeze(matToQuat(R_GLTF_TO_BODY_STK))

/** 出厂映射矩阵（v_body = R · v_gltf）。= STK 映射；各处要「出厂 R」一律取它，不要自己抄数。 */
export const R_GLTF_TO_BODY = R_GLTF_TO_BODY_STK
/** 出厂 q_model2body（[x,y,z,w]，w ≥ 0 规范化）。= Q_MODEL2BODY_STK = [0.5, 0.5, 0.5, 0.5]。 */
export const DEFAULT_Q_MODEL2BODY = Q_MODEL2BODY_STK

/**
 * 出厂映射的逆（本体 → 模型轴）写成列主序 4×4（glTF node.matrix / THREE.Matrix4.fromArray 口径）。
 * 用法：一个节点带这个矩阵、其子节点按本体系坐标摆，整棵树在模型轴下就是「按出厂映射摆回本体系恰好是本体坐标」的 glTF
 * （paramBus 的根节点就是它）。列 = 本体 X / Y / Z 在模型轴下的像。−0 抹成 0（存盘字节确定）。
 */
export const ROOT_MATRIX_BODY2MODEL = Object.freeze(mat4FromQuatT(quatConj(DEFAULT_Q_MODEL2BODY)).map((v) => (v === 0 ? 0 : v)))

// ─────────────────────────────── 导入缺省按来源（轴映射终案 ②，编排者 2026-09-24） ───────────────────────────────

/** STK 映射的语义化别名（= Q_MODEL2BODY_STK = DEFAULT_Q_MODEL2BODY = [0.5,0.5,0.5,0.5]）：STK / AGI / 我们自己导出的件。 */
export const Q_STK = Q_MODEL2BODY_STK
/**
 * 「glTF +Y 朝上 = 天顶」映射（数值即任务书附录 B 那一版，给它语义化别名）：
 *   glTF +Y ↦ 本体 −Z（天顶），glTF +Z ↦ 本体 +X（速度），glTF +X ↦ 本体 −Y。四元数 [−0.5, 0.5, −0.5, 0.5]。
 * 为什么 NASA 语料与普通导入件取它：美术 / CAD 件按 glTF 规范「+Y 朝上」建模，作者摆的「上」是天顶——按 STK 映射解释，
 *   ISS、GOES 这类整件朝向就翻了 180°（对地载荷朝天）。STK 件不同：STK 的约定是把对地面建在 +Y（见上方 STK 映射的证据）。
 * 它只是「没人核过时」的缺省；逐件核过的 NASA 条目由 scripts/nasa3d/frame-overrides.json 覆盖（frame.verified=true）。
 */
export const R_GLTF_TO_BODY_YUP_ZENITH = R_GLTF_TO_BODY_APPENDIXB
export const Q_YUP_ZENITH = Q_MODEL2BODY_APPENDIXB

// STK 口径的来源：本机 STK 件、我们的参数化模型（paramBus 根矩阵 = STK 映射之逆）
const STK_SOURCE_KINDS = new Set(['stk-local', 'param'])

/**
 * 实体类别（ModelMeta.kind）：飞机 / 船 / 车 / 地球站。它们的 glb 一律按「+Y 朝上 = 天顶、+Z 朝前」建模——
 * STK 本机 Air / Sea / Land / facility 件实测如此（与 STK 卫星件把对地面建在 +Y 的约定不同），装配页这四个领域的根矩阵
 * 也是 Q_YUP_ZENITH（assembly.mjs DOMAIN_FRAMES）。所以导入缺省按类别先判（DESIGN3 E5），来源 / AGI 扩展不再左右它们。
 * 地球站沿用 'ground'（A3 SPEC §12-2）。
 */
export const ENTITY_KINDS = Object.freeze(['aircraft', 'ship', 'vehicle', 'ground'])

/**
 * 元数据 / 文件里没有 q_model2body 时，按类别与来源给缺省 q（[x,y,z,w]，新数组，w ≥ 0 规范化）。
 * 优先级（先命中先用）：
 *   ① satsimFrame 带合法 q（extras.satsim.frame 的 q_model2body，或简写 q；近单位长即可）→ 用它（我们导出件自带的标定）；
 *   ② kind ∈ ENTITY_KINDS（飞机 / 船 / 车 / 地球站）→ Q_YUP_ZENITH（类别优先于来源 / AGI，DESIGN3 E5）；
 *   ③ satsimFrame 为真（有 extras.satsim.frame 但没给能用的 q）、sourceKind 为 stk-local / param、hasAgi 为真 → Q_STK；
 *   ④ 其余（nasa、user、community、builtin、空 / 未知）→ Q_YUP_ZENITH。
 * 不传 kind（或 kind 不是实体类别）时与加类别规则之前逐位相同。
 * builtin 只说「随包」，不说是谁建的：调用方按 id 前缀换成 nasa / param 再传（schema.normalizeMeta 就这么做）；直接传 builtin 按 ④。
 * 主进程导入（models.js）、渲染端导入、离线管线、schema.normalizeMeta 兜底都调它——同一件东西四处同一个缺省。
 * 入参不是对象（null / undefined / 数字…）按空对象（→ ④），不抛——调用方常写 defaultImportQ(meta && meta.src)。
 * @param {{sourceKind?:string, hasAgi?:boolean, satsimFrame?:object|boolean|null, kind?:string}} [o]
 * @returns {number[]}
 */
export function defaultImportQ(o) {
  const { sourceKind, hasAgi, satsimFrame, kind } = o && typeof o === 'object' ? o : {}
  if (satsimFrame && typeof satsimFrame === 'object') {
    const q = isQuatLike(satsimFrame.q_model2body) ? satsimFrame.q_model2body : (isQuatLike(satsimFrame.q) ? satsimFrame.q : null)
    if (q) {
      const n = Math.hypot(q[0], q[1], q[2], q[3])
      if (n > 0.9 && n < 1.1) { const c = quatCanonical(q); if (c) return c }
    }
  }
  if (typeof kind === 'string' && ENTITY_KINDS.includes(kind)) return Q_YUP_ZENITH.slice()
  if (satsimFrame || hasAgi === true || STK_SOURCE_KINDS.has(sourceKind)) return Q_STK.slice()
  return Q_YUP_ZENITH.slice()
}

const AXIS_WORDS = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] }
/** '+X' / '−y' / 'x' 之类的轴名 → 单位向量；也收三元数组。认不出返回 null。 */
export function axisVec(a) {
  if (isVec3(a)) return unit3(a)
  if (typeof a !== 'string') return null
  const s = a.trim().replace('−', '-').toUpperCase()
  return AXIS_WORDS[s] ? AXIS_WORDS[s].slice() : (AXIS_WORDS['+' + s] ? AXIS_WORDS['+' + s].slice() : null)
}

/**
 * 由「模型轴里哪个方向是天底、哪个方向是速度」定 q_model2body（逐件标定 NASA 件用：人看图说的是轴向，不是四元数）。
 *   nadir    模型系里应落到本体 +Z（天底）的方向，'+X'…'-Z' 或三元向量；
 *   velocity 模型系里应落到本体 +X（速度 / 冲压面）的方向；须与 nadir 正交（向量写法时先去掉沿 nadir 的分量）；
 *   yawDeg   可选，再绕本体 Z 转（右手，度；fineRotate 的 yaw 同口径），给非轴对齐的件留余地。
 * 本体 +Y = Z × X（右手）。返回 w ≥ 0 规范化的 q；轴对齐时吸附成精确值。输入不合法（零长、平行）返回 null。
 * 例：Q_YUP_ZENITH = quatFromBodyAxes('-Y', '+Z')，Q_STK = quatFromBodyAxes('+Y', '+Z')。
 */
export function quatFromBodyAxes(nadir, velocity, yawDeg = 0) {
  const z = axisVec(nadir), x0 = axisVec(velocity)
  if (!z || !x0 || !isNum(yawDeg)) return null
  const xr = reject3(x0, z)
  if (Math.hypot(xr[0], xr[1], xr[2]) < 1e-6) return null
  const x = unit3(xr)
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  // v_body = R·v_model：R 的第 i 行 = 本体第 i 轴在模型系里的方向
  const q = matToQuat([x, y, z])
  if (!q) return null
  const s = snapQuat(q)
  return yawDeg ? snapQuat(fineRotate(s, 0, 0, yawDeg)) : s
}

// ─────────────────────────────── 工作台的轴向编辑 ───────────────────────────────

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }

/**
 * 若 q 对应的矩阵离「带符号置换矩阵」（各元素 ∈ {−1,0,1}）不到 tol，就吸附成精确值。
 * 为什么：90° 步进反复点几十次后浮点会漂（0.7071067811865476² 不严格等于 0.5），存盘出现
 * 0.49999999999999994 这种值，看着像用户微调过；吸附后同一朝向永远是同一组数。
 */
export function snapQuat(q, tol = 1e-9) {
  const R = quatToMat(q)
  if (!R) return null
  let snapped = true
  const S = R.map((row) => row.map((v) => {
    const r = Math.round(v)
    if (Math.abs(v - r) > tol) snapped = false
    return r
  }))
  if (!snapped) return quatCanonical(q)
  return matToQuat(S) || quatCanonical(q)
}

/**
 * 绕本体轴步进（工作台「X/Y/Z ±90°」六个按钮）。
 * 语义：模型在本体系里绕本体轴 axis 转 deg 度 → q' = r(axis, deg) ⊗ q（r 施加在 q 之后，即本体系里转）。
 * deg 须为 90 的整数倍（±90、180…）；结果吸附到精确的带符号置换（若 q 本身已是）。
 * @param {number[]} q  当前 q_model2body
 * @param {'x'|'y'|'z'} axis 本体轴
 * @param {number} deg  90 的整数倍
 * @returns {number[]|null}
 */
export function axisStep(q, axis, deg) {
  const u = quatNormalize(q)
  const a = AXES[typeof axis === 'string' ? axis.toLowerCase() : '']
  if (!u || !a || !isNum(deg) || Math.abs(deg / 90 - Math.round(deg / 90)) > 1e-9) return null
  return snapQuat(quatMul(quatFromAxisAngle(a, deg), u))
}

/**
 * 在 q 之上叠加 roll / pitch / yaw 微调（度）。
 * 顺序（航天惯例 3-2-1，内旋 Z-Y′-X″）：先绕本体 Z 转 yaw，再绕新 Y 转 pitch，最后绕新 X 转 roll；
 * 等价的外旋矩阵写法 R_fine = Rz(yaw) · Ry(pitch) · Rx(roll)。
 * 结果 q' = q_fine ⊗ q，即微调施加在 q 的映射之后（本体系里转）。
 * 工作台的用法：保存一个 base（由 axisStep 得到），每次微调都从 base 重算 fineRotate(base, r, p, y)，
 * 不要在上一次的结果上累加——累加会让同一组滑杆值对应不同朝向。
 */
export function fineRotate(q, rollDeg, pitchDeg, yawDeg) {
  const u = quatNormalize(q)
  if (!u || !isNum(rollDeg) || !isNum(pitchDeg) || !isNum(yawDeg)) return null
  const qz = quatFromAxisAngle(AXES.z, yawDeg)
  const qy = quatFromAxisAngle(AXES.y, pitchDeg)
  const qx = quatFromAxisAngle(AXES.x, rollDeg)
  const fine = quatMul(qz, quatMul(qy, qx))
  return quatCanonical(quatMul(fine, u))
}

/**
 * 四元数 → 3-2-1 欧拉角（与 fineRotate 同一顺序，R = Rz(yaw)·Ry(pitch)·Rx(roll)）。
 * pitch ∈ [−90, 90]；万向锁（|pitch| ≈ 90°）时 roll 记 0、全部转角并入 yaw。
 * @returns {{rollDeg:number, pitchDeg:number, yawDeg:number}|null}
 */
export function quatToEulerZYX(q) {
  const R = quatToMat(q)
  if (!R) return null
  const s = Math.max(-1, Math.min(1, -R[2][0]))
  const pitch = Math.asin(s)
  let roll, yaw
  if (Math.abs(s) > 1 - 1e-12) {
    roll = 0
    yaw = Math.atan2(-R[0][1], R[1][1])
  } else {
    roll = Math.atan2(R[2][1], R[2][2])
    yaw = Math.atan2(R[1][0], R[0][0])
  }
  const clean = (v) => { const d = v / DEG; return Math.abs(d) < 1e-12 ? 0 : d }
  return { rollDeg: clean(roll), pitchDeg: clean(pitch), yawDeg: clean(yaw) }
}

/** q 相对 base 的微调量（fineRotate 的逆）：fine = q ⊗ base⁻¹ → 3-2-1 欧拉角。 */
export function relativeEulerZYX(q, base) {
  const u = quatNormalize(q), b = quatNormalize(base)
  if (!u || !b) return null
  return quatToEulerZYX(quatMul(u, quatConj(b)))
}

// ─────────────────────────────── 点的换算 ───────────────────────────────

/** v_body = R(q)·v_model + t（t 缺省 0）。非法返回 null。 */
export function modelToBody(v, q, t = [0, 0, 0]) {
  if (!isVec3(t)) return null
  const r = quatRotate(q, v)
  if (!r) return null
  return [r[0] + t[0], r[1] + t[1], r[2] + t[2]]
}

/** modelToBody 的逆：v_model = Rᵀ·(v_body − t)。 */
export function bodyToModel(v, q, t = [0, 0, 0]) {
  if (!isVec3(v) || !isVec3(t)) return null
  const u = quatNormalize(q)
  if (!u) return null
  return quatRotate(quatConj(u), [v[0] - t[0], v[1] - t[1], v[2] - t[2]])
}

// ─────────────────────────────── 挂点上向量（二期契约 D1） ───────────────────────────────

// 视轴与上向量「平行」的判据：|d̂ × û| 小于它就认为上向量不能定出滚转。取 1e-6（≈ 0.2″）而不是更大的门限：
// 用户手填的上向量离视轴几度也是有意为之（安装滚转），只有真退化（数值上平行）才替换。
const UP_DEGENERATE = 1e-6

const unit3 = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null }
// a 去掉沿单位向量 d 的分量
const reject3 = (a, d) => { const k = a[0] * d[0] + a[1] * d[1] + a[2] * d[2]; return [a[0] - k * d[0], a[1] - k * d[1], a[2] - k * d[2]] }

/**
 * 挂点缺省上向量（本体系，单位长）：本体 −Y 在视轴法平面上的投影；视轴与 ±Y 平行（投影退化）时改取 +X 的投影。
 * 为什么是 −Y（二期契约 D1「up ↔ 天线 +y」）：对地挂点（视轴 +Z）得 up = −Y，GEO 顺行时即正北，
 * 「姿态 + 挂点」指向与手动天底档逐位相等，赋形 GRD 的足迹方向不转 90°。
 * dir 非法或零长返回 null。
 */
export function defaultUpBody(dir) {
  if (!isVec3(dir)) return null
  const d = unit3(dir)
  if (!d) return null
  const u1 = reject3([0, -1, 0], d)
  if (Math.hypot(u1[0], u1[1], u1[2]) > UP_DEGENERATE) return unit3(u1).map((v) => (v === 0 ? 0 : v))
  return unit3(reject3([1, 0, 0], d)).map((v) => (v === 0 ? 0 : v))
}

/** 上向量是否退化（零长、与视轴平行，或任一参数非法）——退化的上向量定不出挂点系的滚转。 */
export function isUpDegenerate(dir, up) {
  if (!isVec3(dir) || !isVec3(up)) return true
  const d = unit3(dir), u = unit3(up)
  if (!d || !u) return true
  return Math.hypot(d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]) <= UP_DEGENERATE
}
