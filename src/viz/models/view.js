// 模型系 → 本体系 → 显示系 的矩阵，与视角 / 取景（viewport 与 thumbs 共用，保证缩略图与预览同一个「等轴」）。
//
// 三个坐标系：
//   模型系  glb 文件里的坐标（glTF：+Y 上、+Z 前），单位按 meta.units.scaleToMeters 折米。
//   本体系  +X 速度、+Z 天底、+Y 补全右手系（STK 默认 Nadir 姿态同口径）。模型系 → 本体系 = meta.frame（q、t）× 缩放。
//           q 缺省按来源（packages/core/models/bodyFrame.mjs 的 defaultImportQ，轴映射终案 ②，唯一真值源，这里转出不抄数）：
//             · STK 本机件 / 参数化 / 带 AGI 扩展或 extras.satsim.frame 的件 → Q_STK（glTF +Y ↦ 本体 +Z 天底，对地面建在 +Y）；
//             · NASA 语料与用户导入的普通 glb / OBJ / STL / FBX / STEP → Q_YUP_ZENITH（glTF +Y ↦ 本体 −Z 天顶）。
//           元数据缺 frame 时本文件的 modelToBodyMatrix 取出厂值 DEFAULT_Q_MODEL2BODY（= Q_STK；导出件一律烘到它）。
//   显示系  three 的世界系，+Y 朝上（OrbitControls、地面网格、影棚灯位都按 Y 上摆）。
//           取「天顶朝上、地球在下」（轴映射终案 ③，编排者 2026-09-24）：display = (body.x, −body.z, body.y)，det = +1，纯旋转
//           （绕 X 转 +90°）。本体 −Z（天顶）→ 显示 +Y（屏幕上方），本体 +Z（天底 / 地球）→ 显示 −Y（下方）；
//           固定等轴（方位 35°、俯仰 25°，从显示 +Y 一侧斜看）下本体 +X（速度）朝右前、+Y 朝左前。
//           后果：
//             · NASA 美术件（+Y 天顶）保持作者摆的正姿态：glTF +Y ↦ 本体 −Z ↦ 显示 +Y，与任何 glTF 查看器、NASA 画廊同向；
//             · STK / 参数化星（对地面在 glTF +Y ↦ 本体 +Z）天线朝下、太阳翼电池面（静止位朝天顶）朝上——这就是卫星在轨的样子；
//             · 工作台预览、缩略图、报告三视图、3D 页跟随视图四处一律这一个显示系（跟随视图由 modelLayer 按同一口径取）。
//           2026-09-24 之前是「本体 +Z 朝上」（display = (x, z, −y)），参数化星在预览里倒立、需「自动」视角从下方看才看得见电池面。
//           ★ 按模型来源不同，切换前后画面的变化：NASA 件同一视角下画面逐像素不变（它们在切换前按附录 B 也是天顶朝上）；
//             STK / 参数化件整体翻 180°（天线从朝上变成朝下）。显示系 ↔ 本体系的就地换算（包围盒区间、'−y' 下标写法）
//             一律按 BODY_TO_DISPLAY / DISPLAY_TO_BODY 取，别写死分量——这个显示系已经换过两次。
//           消费端须知：
//             · 太阳档（studio 'sun'）的「上」= setUp(ZENITH_DISPLAY)（其反向即地球方向，地球反照从下方来）；
//             · 影棚三灯（studio.js 的 KEY / FILL / RIM）在显示 +Y 半球 = 天顶一侧；换视角时灯组随相机转（rigOrientFor），
//               顶 / 底 / 等轴三种视角都是同一套正面布光；
//             · 报告三视图用 BODY_VIEWS（按本体轴、天顶朝上），不要用显示系常量；
//             · 第一眼视角用 autoViewFor（thumbs.js），不用 VIEW_DIRS.iso。
//
// 依赖：只有 three 与相对路径的 packages/core/models/bodyFrame.mjs（纯函数、零依赖）。故意不用 '@core/' 别名：
//   thumbs.js 与本文件要能在 nasa3d:sheets 的离屏页（importmap 只映射 three）里直接加载，相对路径 Vite 与纯 ESM 页都认。
import * as THREE from 'three'
import { DEFAULT_Q_MODEL2BODY } from '../../../packages/core/models/bodyFrame.mjs'

/** 出厂四元数 [x,y,z,w]（= bodyFrame.DEFAULT_Q_MODEL2BODY，STK 映射）。渲染端各处（exporter / viewport / thumbs / modelLayer）从这里取。 */
export { DEFAULT_Q_MODEL2BODY }

/** 本体系 → 显示系（纯旋转）：display = (body.x, −body.z, body.y)，本体 −Z（天顶）朝上、+Z（天底 / 地球）朝下 */
export const BODY_TO_DISPLAY = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1)
export const DISPLAY_TO_BODY = BODY_TO_DISPLAY.clone().invert()
export const BODY_TO_DISPLAY_Q = new THREE.Quaternion().setFromRotationMatrix(BODY_TO_DISPLAY)
/** 本体天顶（−Z）在显示系的方向（单位向量，只读约定：别就地改）= 屏幕上方。太阳档的「上」、地球反照半球朝它的反方向。 */
export const ZENITH_DISPLAY = Object.freeze([0, 1, 0])
/** 本体天底（+Z）在显示系的方向 = 屏幕下方（地球）。 */
export const NADIR_DISPLAY = Object.freeze([0, -1, 0])

const _q = new THREE.Quaternion(), _t = new THREE.Vector3(), _s = new THREE.Vector3()
/**
 * meta → 模型系到本体系的 4×4：v_body = R(q)·(s·v_model) + t
 * meta 缺字段时取出厂值（q = DEFAULT_Q_MODEL2BODY、t 0、s 1）。
 */
export function modelToBodyMatrix(meta, out = new THREE.Matrix4()) {
  const f = (meta && meta.frame) || {}
  const q = Array.isArray(f.q_model2body) && f.q_model2body.length === 4 ? f.q_model2body : DEFAULT_Q_MODEL2BODY
  const t = Array.isArray(f.t_model2body) && f.t_model2body.length === 3 ? f.t_model2body : [0, 0, 0]
  const s0 = meta && meta.units && Number.isFinite(meta.units.scaleToMeters) && meta.units.scaleToMeters > 0 ? meta.units.scaleToMeters : 1
  _q.set(q[0], q[1], q[2], q[3]).normalize()
  return out.compose(_t.set(t[0], t[1], t[2]), _q, _s.set(s0, s0, s0))
}

/** 本体系向量 → 显示系（就地改写 Vector3）：(x, y, z) → (x, −z, y) */
export function bodyToDisplayVec(v) { const y = v.y; v.y = -v.z; v.z = y; return v }
/** 显示系向量 → 本体系（就地改写 Vector3）：(x, y, z) → (x, z, −y) */
export function displayToBodyVec(v) { const y = v.y; v.y = v.z; v.z = -y; return v }

// 各视角的相机方向（显示系，从目标指向相机）。
//   iso：按显示系定（方位 35°、俯仰 25°，从天顶一侧斜看；本体 +X 朝右前）——第一眼视角走 autoViewFor，iso 只作「点名等轴」与
//        自动取景的兜底。
//   其余六个【按本体轴定】再换到显示系：名字即「相机在本体哪一侧」，与工作台视角按钮「前（+X）… 顶（−Z）/ 底（+Z）」、
//   viewport 轴球点击（posZ → bottom、negZ → top …）逐一对应。显示系换过两次（附录 B × 天顶朝上 → 本体 +Z 朝上 → 天顶朝上），
//   写显示系常量的话每换一次就有视角错位——所以这里由 BODY_TO_DISPLAY 算，显示系再换也不用改。
//   沿显示竖直轴看（顶 / 底）时 OrbitControls 的上向（显示 +Y）与视线平行：在显示 X 上偏一丝，符号取「屏幕上方 = 本体 +X（速度朝上）」。
const EPS = 1e-4
const ISO_AZ = 35 * Math.PI / 180, ISO_EL = 25 * Math.PI / 180
function axisView(b) {
  const d = new THREE.Vector3(b[0], b[1], b[2]).applyMatrix4(BODY_TO_DISPLAY).toArray().map((v) => (Math.abs(v) < 1e-12 ? 0 : v))
  // 相机在 (e, s, 0)（s = ±1）看原点、上向 +Y：屏幕上方 ∝ −s·e 的 X 方向 → 取 e = −s·EPS 得屏幕上方 = 显示 +X = 本体 +X
  if (Math.abs(d[1]) > 0.5) d[0] = -Math.sign(d[1]) * EPS
  return Object.freeze(d)
}
export const VIEW_DIRS = Object.freeze({
  iso: Object.freeze([Math.cos(ISO_EL) * Math.cos(ISO_AZ), Math.sin(ISO_EL), Math.cos(ISO_EL) * Math.sin(ISO_AZ)]),
  front: axisView([1, 0, 0]),     // 相机在本体 +X（迎着速度方向）
  back: axisView([-1, 0, 0]),
  right: axisView([0, 1, 0]),     // 相机在本体 +Y
  side: axisView([0, 1, 0]),
  left: axisView([0, -1, 0]),     // 相机在本体 −Y
  top: axisView([0, 0, -1]),      // 相机在天顶（本体 −Z）往天底看
  bottom: axisView([0, 0, 1])     // 相机在天底（本体 +Z）往天顶看
})
export function viewDir(name, out = new THREE.Vector3()) {
  const d = VIEW_DIRS[name] || VIEW_DIRS.iso
  return out.set(d[0], d[1], d[2]).normalize()
}

/**
 * 按【本体轴】定义的工程视角（报告三视图用；与显示系怎么摆无关，标题「前视（+X）/ 侧视（+Y）/ 顶视（−Z）」恒成立）：
 *   from = 相机所在的本体方向（从它看向原点），up = 屏幕上方的本体方向（前视 / 侧视取天顶 −Z，顶视取速度 +X）。
 * 值是换到显示系后的 {dir, up}（three 相机直接用：position = target + dir·d，camera.up = up）。
 * 为什么要单独给：显示系换过口径，写显示系常量的三视图在换口径那一刻就会拍错方向（2026-09-23 实测过「侧视（+Y）」从 −Y 拍）。
 * 按本体轴取，显示系再怎么摆都不用改。
 */
function bodyViewToDisplay(from, up) {
  const d = new THREE.Vector3(...from).applyMatrix4(BODY_TO_DISPLAY)
  const u = new THREE.Vector3(...up).applyMatrix4(BODY_TO_DISPLAY)
  return Object.freeze({ dir: Object.freeze(d.toArray().map((v) => (v === 0 ? 0 : v))), up: Object.freeze(u.toArray().map((v) => (v === 0 ? 0 : v))), fromBody: Object.freeze(from.slice()), upBody: Object.freeze(up.slice()) })
}
export const BODY_VIEWS = Object.freeze({
  front: bodyViewToDisplay([1, 0, 0], [0, 0, -1]),    // 前视：从 +X（迎着速度）看，天顶朝上
  side: bodyViewToDisplay([0, 1, 0], [0, 0, -1]),     // 侧视：从 +Y 看，天顶朝上
  top: bodyViewToDisplay([0, 0, -1], [1, 0, 0])       // 顶视：从天顶（−Z）往天底看，速度 +X 朝上
})

/**
 * 采样模型顶点的世界坐标（取景与包围用；上限 maxN 个，均匀跨网格抽）。
 * 调用前 root.updateMatrixWorld(true)。
 */
export function sampleWorldPoints(root, maxN = 20000) {
  const meshes = []
  let total = 0
  root.traverseVisible((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) { meshes.push(o); total += o.geometry.attributes.position.count } })
  const step = Math.max(1, Math.ceil(total / maxN))
  const out = new Float32Array(Math.ceil(total / step) * 3 + 3 * meshes.length)
  const v = new THREE.Vector3()
  let k = 0
  for (const m of meshes) {
    const p = m.geometry.attributes.position
    for (let i = 0; i < p.count; i += step) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)
      out[k++] = v.x; out[k++] = v.y; out[k++] = v.z
    }
  }
  return out.subarray(0, k)
}

/**
 * 透视相机取景：让所有采样点落进画面、四周留 margin（占画面比例，0.08 = 每边 8%）。
 * 先按视平面投影把取景中心挪到点集中点（长太阳翼的星不会偏在一边），再按最近点的深度解出距离。
 * @returns {{target:THREE.Vector3, dist:number, radius:number}}
 */
export function fitPerspective(points, dir, fovDeg, aspect, margin = 0.08, up = new THREE.Vector3(0, 1, 0)) {
  const n = points.length / 3
  const target = new THREE.Vector3()
  if (!n) return { target, dist: 10, radius: 1 }
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < n; i++) { cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2] }
  cx /= n; cy /= n; cz /= n
  const f = dir.clone().normalize()
  const right = new THREE.Vector3().crossVectors(up, f)
  if (right.lengthSq() < 1e-10) right.set(0, 0, 1).cross(f)
  right.normalize()
  const upv = new THREE.Vector3().crossVectors(f, right).normalize()
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, r2 = 0
  for (let i = 0; i < n; i++) {
    const px = points[i * 3] - cx, py = points[i * 3 + 1] - cy, pz = points[i * 3 + 2] - cz
    const x = px * right.x + py * right.y + pz * right.z
    const y = px * upv.x + py * upv.y + pz * upv.z
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    const d2 = px * px + py * py + pz * pz; if (d2 > r2) r2 = d2
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
  target.set(cx, cy, cz).addScaledVector(right, mx).addScaledVector(upv, my)
  const k = 1 - 2 * margin
  const tanV = Math.tan(fovDeg * Math.PI / 360) * k, tanH = tanV * aspect
  let D = 0
  for (let i = 0; i < n; i++) {
    const px = points[i * 3] - target.x, py = points[i * 3 + 1] - target.y, pz = points[i * 3 + 2] - target.z
    const x = px * right.x + py * right.y + pz * right.z
    const y = px * upv.x + py * upv.y + pz * upv.z
    const z = px * f.x + py * f.y + pz * f.z
    const d = Math.max(z + Math.abs(x) / tanH, z + Math.abs(y) / tanV)
    if (d > D) D = d
  }
  return { target, dist: Math.max(D, 1e-3), radius: Math.sqrt(r2) }
}

/** 包围半径（本体原点 → 最远采样点），用于 near/far、叠加层尺度 */
export function boundingRadius(points, cx = 0, cy = 0, cz = 0) {
  let r2 = 0
  for (let i = 0; i < points.length; i += 3) {
    const dx = points[i] - cx, dy = points[i + 1] - cy, dz = points[i + 2] - cz
    const d2 = dx * dx + dy * dy + dz * dz; if (d2 > r2) r2 = d2
  }
  return Math.sqrt(r2)
}
