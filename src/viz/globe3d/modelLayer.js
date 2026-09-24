// 3D 球上的卫星模型层（设计契约 §6.2；任务书 §5.9 / §5.10）：球面图标模式 + 跟随视图。
//
// 两种画法，都挂在 scene.js 的叠加层口子上（setOverlay），地球那一趟一个材质都不碰：
//   ① 球面图标：聚焦星（≤ 32 颗）画成屏幕恒定像素的小模型（lod2），姿态按姿态律（一期 nadir，基底由调用方给）。
//      用【地球相机】在第二趟画、不清深度 —— 地球已写的深度天然把背面的星挡掉；另按「相机→锚点的线段穿不穿单位球」
//      整颗判遮挡（与点精灵的着色器剔除同一判据）。出现 / 消失 300 ms 透明度渐变，同步给点精灵遮罩一个反向系数
//      （scene.setDotMask）：模型淡入、原来那个点淡出 —— 交叉淡入淡出。模型没就绪 / 下载失败 / 太小（半径 < 3 px）时照旧画点。
//   ② 跟随视图：局部场景（米制、原点 = 主星、L 系：x̂ 沿迹 / ŷ 径向向上 / ẑ = x̂ × ŷ）+ 局部相机 + 局部轨道控件。
//      地球相机由局部相机推出：q_E = qL2S · q_camL，p_E = anchor + qL2S·p_camL / 6371000（double 算完再赋给 three）。
//      局部那一趟：清深度 → 模型（太阳档影棚光：硬平行光 + 地球反照 + 太空环境反射、PCF 阴影按画质档）→ 500 km 内其他星 → HUD，
//      临时 ACES 色调映射、画完恢复（地球那一趟的材质程序不串）。
//      星空 / 大气 / 太阳眩光【不归本层】：它们是地图设置 · 宇宙空间的开关（scene.setSpace / spaceFx.js），普通视图与跟随同一套 ——
//      跟随只改视角、不改地图。本层只报「主星模型挡住太阳多少」（overlay.sunVisibility），由 scene 乘进眩光。
//      主星没有模型可画（绑定「无」/ 离线未缓存 / 下载或解码失败 / 还在加载 / 软件光栅 / 逐档降级退到底）：局部原点画回退标记
//      （与球面聚焦星图标同形、屏幕恒定 30 px），HUD 照常以它为原点 —— DESIGN §9-8「静默回退」在跟随里的落法。
//      HUD：本体轴 / LVLH（轨道法向 = +ĥ，见 HUD_L_DIRS）/ 天底 / 速度 / 太阳 / ISL 连线 / 可见地球站方向（任务书 §5.10 七项）。
//
// 坐标三套（别混）：场景轴 = ECEF (X, Z, −Y)、单位地球半径；L 系（米）；本体系（+X 速度、+Z 天底，模型 → 本体 = meta.frame × 缩放，
// 常量与换算一律取 src/viz/models/view.js 的 modelToBodyMatrix —— 出厂映射由那边定，这里不写死任何四元数；
// 绑定表逐星的 model.frameOverride 在挂架时顶替 meta.frame，见 frameMeta）。
//
// 姿态接口：调用方给 qL2S（L → 场景）与 qB2L（本体 → L，缺省 nadir 律 Q_BODY2L_NADIR）；层内部只做 qB2S = qL2S ⊗ qB2L。
// 二期：绑定的姿态律（yawSteer / sun / inertial / target）由页面经 bodyRuntime 解出本体基底、换成 qB2L 传进来（bodyRuntime.qB2LFromBasis）。
// 挂架时先摆关节静止位姿（thumbs.applyRestPose：STK 件初值为 0 的喷焰缩放关节藏掉，不画、不进包围盒）；
// 太阳翼单轴关节按太阳自动转（attitude.articulationSunAngle；带 pointingVector 的按它，否则按电池片法向，见 makeSunTrackers）。
// 跟随 HUD 另有「挂点」一项：各挂点的视轴射线 + 视场锥（跟本体转，state.mounts）。
//
// 元数据：按 id 缓存；工作台存盘 / 清单更新时页面调 refreshModel(id) —— 挂架要用的几项变了才原位重挂。
//
// 性能：逐帧函数零分配（预分配向量 / 四元数；槽位同时放在数组里，逐帧下标循环，不建迭代器）；模型切换即 release
//（loader 引用计数，归零 60 s 后真释放）；共享材质库的 GPU 副本在 dispose 时按 renderer 精确释放（gpuRelease）；
// 进出跟随只建拆轨道控件与少量标签。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { loadModel, disposeObject } from '../models/loader.js'
import { irToThree } from '../models/irToThree.js'
import { createStudio } from '../models/studio.js'
import { setMaterialAnisotropy } from '../models/materials.js'
import { createGpuReleaser } from '../models/gpuRelease.js'
import { modelToBodyMatrix } from '../models/view.js'
import { applyRestPose } from '../models/thumbs.js'
import { bodyBoxToModelBox } from '../../model/wbLogic.js'
import { buildTemplateModel, buildParamModel } from '@core/models/paramBus.mjs'
import { resolveTemplateId } from '@core/models/paramTemplates.mjs'
import { entityTemplateDoc, getEntityTemplate } from '@core/models/entityTemplates.mjs'
import { buildAssembly } from '@core/models/assembly.mjs'
import { Q_BODY2L_NADIR, lvlhQuatScene, sunDirEcef, sceneFromEcef, eclipseFactor, quatRotate, quatMul, articulationSunAngle } from '@core/models/attitude.mjs'
import sat from '../constellation/satellite.js'
import { llaToVec } from './focusLanes.js'
import { solarGeometry } from '../terminator.js'
import { geodeticToEcef, geodeticUp } from '../wgs84.js'
import { tauFor, dampingFor, ZOOM_TAU_MS } from './dragFollow.js'
import { wheelNotches, stepZoomT } from '../../shared/wheelStep.js'
import { byLang, curLang } from '../../shared/i18n/lang.js'
import { isSoftwareRenderer } from './spaceFx.js'

const RE_M = 6371000              // 场景 1 单位 = 6371 km（与 focusLanes.RE 同值）
const MAX_ICONS = 32
const FADE_S = 0.3
const MAX_OTHERS = 16
const FOLLOW_MAX_M = 5000
const TMAX = 1.2                  // 跟随距离进度条与球面缩放同刻度（0 … 1.2）
const ICON_ENV_I = 0.45           // 图标的环境反射强度（全日照时；地影里按因子压）
// 晨昏效果开（按太阳打光）时的相机侧补光（2026-09-24 用户：「晨昏效果开的时候，卫星在暗面太暗了，看不清楚」）：
// 从相机左上后方打（与全亮头灯同向）、不投影子。主光（太阳 3.0 / 3.2）照旧定明暗，补光只把背光面 / 地影里的星托到看得清 ——
// 日照里 ≈ 主光的 1/5（受光面与背光面 5:1，立体感还在）；地影里升到 ≈ 主光的四成多（整星比日照暗一大截，一眼看得出在地影里，
// 结构看得清 —— 1.1 时实测只有全亮的 26%，仍嫌暗）。
const FILL_LIT = 0.6, FILL_ECL = 1.4
const ICON_ECL_FLOOR = 0.5        // 图标本影里的底色（原 0.22：夜半球上整颗压成黑剪影，看不清）
const DEG = Math.PI / 180
const _warmCam = new THREE.PerspectiveCamera(42, 1, 0.01, 1e6)   // warmUp 的占位相机（程序参数与相机无关）
/**
 * 跟随时「邻星」的距离带（km，按真 ECEF 距离）：外沿 500 km（任务书 §5.10）；内沿 1 km ——
 * 对接在空间站上的飞船 / 舱段（ISS 的 POISK、NAUKA、载人龙…）各有一份 TLE，彼此只差 TLE 误差的几百米，
 * 当成邻星会在主星模型上叠一摞名字标签。它们在画面里就是主星的一部分，不单画。
 */
export const NEIGHBOR_KM = Object.freeze({ min: 1, max: 500 })

// ============================================================================================
// 每拍状态（页面与验证台共用这一份算式 —— 别在调用方各抄一遍）
// ============================================================================================
/** 太阳：ECEF 与场景轴单位矢量。日下点取 terminator.solarGeometry（Meeus 低精度，0.01° 级；视差 ≤ 0.016° 忽略） */
export function sunStateAt(date) {
  const sub = solarGeometry(date).sub
  const sunE = sunDirEcef(sub.lat, sub.lon)
  return { sunE, sunS: sceneFromEcef(sunE) }
}
/**
 * 一颗星此刻的模型状态。pv = satPos.posAt 的 TEME 位置 / 速度（km、km/s，double），g = 该星口径的 GMST（rad）。
 *   anchor：场景单位，与点云同一套 llaToVec(大地纬经高) —— 模型才和点、轨道线对得齐（场景 ≠ ECEF/6371，差 7–14 km）
 *   qL2S：L 系 → 场景轴，按【真 ECEF】的 r 与惯性速度（TEME 速度只转到 ECEF 轴向、不减 ω×r —— GEO 的地固速度≈0，定不了沿迹）
 *   ecl：地影因子（attitude.eclipseFactor，圆锥 + 半影；唯一实现）
 */
export function satStateAt(pv, g, sunE) {
  if (!pv || !pv.position || !pv.velocity) return null
  const r = sat.eciToEcf(pv.position, g), v = sat.eciToEcf(pv.velocity, g)
  const gd = sat.eciToGeodetic(pv.position, g)
  const a = llaToVec(sat.degreesLat(gd.latitude), sat.degreesLong(gd.longitude), gd.height)
  const rE = [r.x, r.y, r.z], vE = [v.x, v.y, v.z]
  if (!(Number.isFinite(rE[0]) && Number.isFinite(a.x))) return null
  return { rE, vE, anchor: [a.x, a.y, a.z], qL2S: lvlhQuatScene(rE, vE), altKm: gd.height, ecl: eclipseFactor(rE, sunE) }
}
/** 主星速度方向在它自己 L 系里的单位矢量（HUD「速度」箭头；近圆轨道 ≈ +x̂，偏心轨道带一点径向分量） */
export function velInL(st) {
  const qS2L = [-st.qL2S[0], -st.qL2S[1], -st.qL2S[2], st.qL2S[3]]
  const v = sceneFromEcef(st.vE)
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return quatRotate(qS2L, [v[0] / l, v[1] / l, v[2] / l])
}
/**
 * 邻星 → 主星 L 系：relL（米，真 ECEF 差 —— 两颗星的 llaToVec 误差大体相消，但米级近景得用真差）、
 * qB2L（邻星本体 → 主星 L；邻星姿态基底 qB2Lself 由调用方给，缺省 nadir）、anchorS（它在点云里的那个顶点，给点精灵遮罩）
 */
/**
 * 进入跟随时的机位方向（从主星指向相机的单位矢量，L 系）。纯函数（单测直接验）；层里的 defaultCamDir 就是它，构图口径见那边的注释。
 * @param {number} altKm 主星高度
 * @param {{x,y,z}} sunL 太阳在 L 系的单位方向
 * @param {THREE.Vector3} out
 * @param {boolean} lit 主星在日照里（地影因子 ≥ 0.5）
 */
export function followCamDir(altKm, sunL, out = new THREE.Vector3(), lit = true) {
  const R = RE_M / 1000
  const delta = Math.acos(Math.min(1, R / (R + Math.max(0, altKm))))
  const t = smoothstep(20 * DEG, 80 * DEG, delta)
  let pitch = Math.max(8 * DEG, Math.min(84 * DEG, delta + (4 - 13.5 * t) * DEG))
  const hs = Math.hypot(sunL.x, sunL.z)
  // 太阳远在当地水平面以下、星却还在日照里（高轨星转到地球夜侧：GEO 当地傍晚到清晨、除掉子夜前后的地影）：
  // 受光的是对地那几面，从高处往下拍只剩剪影 —— 相机往下压，仰角跟着太阳走（太阳越低相机越低，−45° … −10°），
  // 但【下限夹在 δ − 15°】：地球必须留在画面里当空间参照（契约「地球在背景」）。42° 视场半高 21°，地心在视线下方
  // 90° − 俯仰处、地球角半径 90° − δ，俯仰 ≥ δ − 15° 时临边进画 6° 以上。GEO 因此落在 66° 左右（侧光 + 地球反照），
  // 低轨落在 5° 左右（几乎平视，受光的侧面朝镜头）。地影里照旧按常规俯拍（本来就没有受光面，留地球与大气亮环作背景）
  if (lit && sunL.y < -0.25) pitch = Math.max(delta - 15 * DEG, Math.max(-45 * DEG, Math.min(-10 * DEG, 0.55 * Math.asin(Math.max(-1, sunL.y)))))
  let az
  if (hs < 0.2) az = Math.atan2(0.6, -0.8)
  else {
    const sa = Math.atan2(sunL.z, sunL.x)
    const a1 = sa + 50 * DEG, a2 = sa - 50 * DEG
    az = Math.cos(a1) <= Math.cos(a2) ? a1 : a2
  }
  return out.set(Math.cos(pitch) * Math.cos(az), Math.sin(pitch), Math.cos(pitch) * Math.sin(az))
}
function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
/**
 * HUD「地球站」（任务书 §5.10「可见地球站方向」）：主星看得见的站 —— 站在自己的大地天顶系里看主星仰角 ≥ elMinDeg ——
 * 换成主星 L 系里的单位方向（主星 → 站），近者优先、最多 max 支。纯函数（单测直接验）。
 * stations：[{lat, lon, name}]（标记层地球站，海拔按 0，WGS-84）；st：satStateAt 的结果（rE 为真 ECEF，km）。
 */
export function stationDirsInL(st, stations, max = 12, elMinDeg = 0) {
  if (!st || !Array.isArray(stations) || !stations.length) return []
  const qS2L = [-st.qL2S[0], -st.qL2S[1], -st.qL2S[2], st.qL2S[3]]
  const out = []
  for (const s of stations) {
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue
    const p = geodeticToEcef(s.lon, s.lat, 0), up = geodeticUp(s.lon, s.lat)
    const d = [p[0] - st.rE[0], p[1] - st.rE[1], p[2] - st.rE[2]]   // 星 → 站
    const R = Math.hypot(d[0], d[1], d[2])
    if (!(R > 0)) continue
    const el = Math.asin(Math.max(-1, Math.min(1, -(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / R))) / DEG
    if (el < elMinDeg) continue
    out.push({ name: String(s.name || ''), dirL: quatRotate(qS2L, sceneFromEcef([d[0] / R, d[1] / R, d[2] / R])), elDeg: el, rangeKm: R })
  }
  out.sort((a, b) => a.rangeKm - b.rangeKm)
  return out.slice(0, max)
}
export function neighborInL(st, nb, qB2Lself = Q_BODY2L_NADIR) {
  const qS2L = [-st.qL2S[0], -st.qL2S[1], -st.qL2S[2], st.qL2S[3]]
  const relS = sceneFromEcef([nb.rE[0] - st.rE[0], nb.rE[1] - st.rE[1], nb.rE[2] - st.rE[2]])
  const relL = quatRotate(qS2L, relS)
  return { relL: [relL[0] * 1000, relL[1] * 1000, relL[2] * 1000], qB2L: quatMul(quatMul(qS2L, nb.qL2S), qB2Lself), anchorS: nb.anchor }
}

// ============================================================================================
// 模型来源：id → 可克隆的模板（参数化现场生成；NASA / 本机 / STK 走主进程 ensure → models:// → loader）
// ============================================================================================
function createModelSource({ api, metaOf }) {
  const models = api && api.models
  const params = new Map()        // 'param:x' → Promise<{root, meta}>（整页生命期内缓存：几何小、材质走共享库）
  const metas = new Map()         // id → Promise<meta|null>
  const readyWaiters = new Map()  // id → Set<fn>：下载完成（或失败）时通知持有降档替身的实例升档
  const readyHooks = new Set()    // 任一模型下载就绪：图标 / 其他星那些「当时没有可用档、只画了点」的槽位重取
  const off = models && models.onChanged ? models.onChanged((e) => {
    if (!e || e.type !== 'download' || !e.id) return
    if (e.phase !== 'ready' && e.phase !== 'error') return
    const set = readyWaiters.get(e.id)
    if (set) { readyWaiters.delete(e.id); for (const fn of set) { try { fn(e) } catch { /* ignore */ } } }
    if (e.phase === 'ready') for (const fn of readyHooks) { try { fn(e.id) } catch { /* ignore */ } }
  }) : null

  function getMeta(id) {
    let p = metas.get(id)
    if (!p) {
      p = (async () => {
        try { const m = models && models.getMeta ? await models.getMeta(id) : null; if (m && !m.locked && m.frame) return m } catch { /* 主进程不可用 */ }
        try { return metaOf ? metaOf(id) : null } catch { return null }
      })()
      metas.set(id, p)
    }
    return p
  }
  function paramTemplate(id) {
    let p = params.get(id)
    if (!p) {
      p = (async () => {
        // 现行模板或旧 id 别名（老存档里的 param:<旧 id> 静默落到现行模板）→ 按模板现生成；否则是用户存的参数化条目
        const tid = resolveTemplateId(id.slice(6))
        let r
        if (tid) r = buildTemplateModel(tid)
        else {
          const m = await getMeta(id)
          if (!m || !m.spec) return null
          r = buildParamModel(m.spec)
        }
        const root = irToThree(r.ir)
        root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
        // geometry.bboxM 按轴映射终案 ④ 给【模型轴、米】（paramBus 的 bboxBody 是本体系，经 frame 逆变换；
        // 与工作台「保存到库」wbStore.paramGeomFields 同一个函数）—— 与库条目 / 主进程元数据同口径，谁读都不会把轴向排错
        const meta = {
          id, frame: r.frame, units: { scaleToMeters: 1, sizeVerified: true },
          geometry: { boundingRadiusM: r.boundingRadiusM, bboxM: bodyBoxToModelBox(r.bboxBody, r.frame) }, massProps: r.massProps,
          articulations: r.articulations, solarPanelGroups: r.solarPanelGroups,   // 太阳翼对日（见 makeSunTrackers）
          attachPoints: r.attachPoints   // 挂点（本体系）：实体层的锚点 / 跟踪要用；卫星图标不读它
        }
        return { root, meta }
      })().catch((e) => { console.warn('[models] 参数化生成失败：' + id + ' ' + ((e && e.message) || e)); return null })
      params.set(id, p)
    }
    return p
  }
  // 实体模板（'ent:<slug>'，地球站 / 飞机 / 船 / 车）：渲染端按模板装配文档现生成（A3 SPEC §12：buildAssembly(entityTemplateDoc(id).doc)），
  // 与参数化同一份缓存与同一形状的 meta（多带 attachPoints：datum / boresight 挂点给实体层定锚点与天线跟踪）。
  // 主进程 ensure 对 ent: 回 {state:'param'}、没有文件地址 —— 不走这条的话卫星绑 ent: 模型一律画不出。
  function entTemplate(id) {
    let p = params.get(id)
    if (!p) {
      p = (async () => {
        const t = entityTemplateDoc(id)
        if (!t) return null
        const r = buildAssembly(t.doc)
        const root = irToThree(r.ir)
        root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
        const tpl = getEntityTemplate(id)
        const meta = {
          id, kind: tpl ? tpl.modelKind : undefined, frame: r.frame, units: { scaleToMeters: 1, sizeVerified: true },
          geometry: { boundingRadiusM: r.boundingRadiusM, bboxM: bodyBoxToModelBox(r.bboxBody, r.frame) }, massProps: r.massProps,
          articulations: r.articulations, solarPanelGroups: r.solarPanelGroups, attachPoints: r.attachPoints
        }
        return { root, meta }
      })().catch((e) => { console.warn('[models] 实体模板生成失败：' + id + ' ' + ((e && e.message) || e)); return null })
      params.set(id, p)
    }
    return p
  }

  /**
   * 取一个可独立摆放的实例。{root, meta, lod, pending, release()} | null（没有模型：调用方画点）。
   * pending = 请求档还在下载、这次先给了已就绪的低档；onUpgrade 在那一档下载完成时回调一次（调用方重取）。
   */
  async function acquire(id, lod, onUpgrade) {
    if (!id) return null
    if (id.startsWith('param:')) {
      const t = await paramTemplate(id)
      if (!t) return null
      return { root: t.root.clone(true), meta: t.meta, lod: 'param', pending: false, release() {} }
    }
    if (id.startsWith('ent:')) {
      const t = await entTemplate(id)
      if (!t) return null
      return { root: t.root.clone(true), meta: t.meta, lod: 'param', pending: false, release() {} }
    }
    if (!models || !models.ensure) return null
    let r = null
    try { r = await models.ensure({ id, lod }) } catch { r = null }
    if (!r || r.locked) return null
    let url = null, got = lod, pending = false
    if (r.state === 'ready' && r.url) { url = r.url; got = r.lod || lod }
    else if (r.state === 'downloading') {
      pending = true
      if (r.fallback && r.fallback.url) { url = r.fallback.url; got = r.fallback.lod }
    }
    if (pending && onUpgrade) {
      let set = readyWaiters.get(id)
      if (!set) readyWaiters.set(id, set = new Set())
      set.add(onUpgrade)
    }
    if (!url) return null
    const meta = await getMeta(id)
    let res
    try { res = await loadModel(url) } catch (e) { console.warn('[models] 加载失败：' + id + ' ' + ((e && e.message) || e)); return null }
    return { root: res.root, meta: meta || { frame: null, units: null }, lod: got, pending, release() { res.handle.release() } }
  }
  function forget(fn) { for (const set of readyWaiters.values()) set.delete(fn) }
  // 参数化模型的元数据是生成出来的（模板 id 固定、用户参数化 id 按参数哈希），不随工作台改动失效
  function invalidateMeta(id) { if (id) metas.delete(id); else metas.clear() }
  /** 缓存里现有的那份（Promise）；没取过为 undefined —— 失效前先拿住它，好与新取回的比 */
  function peekMeta(id) { return metas.get(id) }
  function onReady(fn) { readyHooks.add(fn); return () => readyHooks.delete(fn) }
  async function dispose() {
    if (off) off()
    readyWaiters.clear(); readyHooks.clear()
    for (const p of params.values()) { try { const t = await p; if (t) disposeObject(t.root) } catch { /* ignore */ } }
    params.clear(); metas.clear()
  }
  return { acquire, meta: getMeta, peekMeta, forget, invalidateMeta, onReady, dispose }
}

// 实例 → 挂架：holder（位姿 / 缩放）→ body（模型轴 → 本体系，meta.frame × 缩放）→ root
const _box = new THREE.Box3(), _bv = new THREE.Vector3()
/**
 * 逐星的模型轴覆盖（绑定表 model.frameOverride = {q, t}，DESIGN §3.4）：同一个模型在这颗星上换一套本体轴，
 * 不动模型元数据本身（别的星照旧）。缩放仍取元数据。frameOv 不合法时原样用元数据。
 */
function frameMeta(meta, frameOv) {
  if (!frameOv || !Array.isArray(frameOv.q) || frameOv.q.length !== 4) return meta
  const f = (meta && meta.frame) || {}
  return { ...meta, frame: { ...f, q_model2body: frameOv.q, t_model2body: Array.isArray(frameOv.t) && frameOv.t.length === 3 ? frameOv.t : (f.t_model2body || [0, 0, 0]) } }
}
const frameSig = (f) => (f && Array.isArray(f.q) ? f.q.join(',') + '|' + (Array.isArray(f.t) ? f.t.join(',') : '') : '')
const _vb = new THREE.Box3()
// 只算【可见】网格的外包盒（Box3.setFromObject 不看显隐：静止位姿藏掉的喷焰照样把盒子撑大，tdrs 的 Z 向会被拖到 −25 m）。
// 逐网格取几何包围盒的八角变过去再并（与 setFromObject 非精确口径同），隐藏节点整棵子树跳过
function visibleBox(obj, out) {
  out.makeEmpty()
  obj.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
    _vb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld)
    out.union(_vb)
  })
  return out
}
function mountInstance(inst, frameOv) {
  const holder = new THREE.Group()
  const body = new THREE.Group()
  body.matrixAutoUpdate = false
  modelToBodyMatrix(frameMeta(inst.meta, frameOv), body.matrix)
  // 关节静止位姿（AGI initialValue）：工作台预览 / 缩略图 / 掩模 Worker 同一口径（thumbs.applyRestPose）。
  // inst.root 是本实例自己的克隆（loader / 参数化 acquire 都 clone(true)），摆它不影响别的实例
  try { applyRestPose(inst.root, inst.meta) } catch { /* 关节数据坏：按文件位姿画 */ }
  body.add(inst.root)
  holder.add(body)
  inst.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  // 包围半径（本体原点 → 最远角点，米）：图标按它定像素尺寸、跟随按它定最近距离与光照罩
  holder.updateMatrixWorld(true)
  visibleBox(body, _box)
  let r = 0
  if (!_box.isEmpty()) {
    for (let i = 0; i < 8; i++) {
      _bv.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z)
      r = Math.max(r, _bv.length())
    }
  }
  const g = inst.meta && inst.meta.geometry
  if (!(r > 0) && g && g.boundingRadiusM > 0) r = g.boundingRadiusM
  // box：本体系外包盒（米，按几何包围盒换算的保守值）—— 验证台用它核「部件朝向」（如 ISS 桁架应沿本体 ±Y）
  const box = _box.isEmpty() ? null : { min: _box.min.toArray(), max: _box.max.toArray() }
  return { holder, body, radius: Math.max(0.05, r || 1), box, sun: makeSunTrackers(inst, body) }
}

// ============================================================================================
// 太阳翼对日：单级单轴转动关节（AGI x/y/zRotate）满足下面任一条就按太阳方向自动转：
//   ① 带 pointingVector（STK：关节节点局部系里「转去对准目标」的那个方向）且是太阳翼 —— 关节节点里有太阳翼组的电池片，
//      或关节名像太阳翼（solar / panel / wing / array / 帆板 / 太阳翼）；名字像天线的（antenna / dish / reflector / 天线）
//      即便带 pointingVector 也不动 —— 它要对的是地面 / 目标星，不是太阳；
//   ② 没有 pointingVector、但关节节点里有太阳翼组的电池片：用电池片法向（第一个非退化三角形）代替 pointingVector。
// 转角 = attitude.articulationSunAngle(指向, 转轴, 太阳)（三者都在参考节点自身坐标系：电池片节点在关节里就取它，否则取关节第一个节点），
// 再按 stage 的上下限夹（限位是关节绝对值，静止位姿已含 initialValue，故换算成相对静止位姿的区间；±360 里找落在限位内的等价角，
// 都不在就夹到圆周角差更近的一端 —— 与 power.trackedNormal 同口径）。
// 真星就是这么飞的（GEO 翼绕本体 Y 一天转一圈、LEO 平板翼绕长轴转）—— 不转的话 nadir 姿态下翼板常年侧对太阳，画面是两根黑线。
// 口径与工作台 viewport.setArticulation 同：stage 矩阵右乘在节点静止矩阵上（节点自身坐标系）。
// 太阳只在每拍变（姿态 / 太阳方向都是拍级量）：update 由 follow() / setIcons() 调，不进逐帧循环。
// ============================================================================================
const AXIS_OF = { xRotate: [1, 0, 0], yRotate: [0, 1, 0], zRotate: [0, 0, 1] }
const SOLAR_ART = /solar|panel|wing|array|帆板|太阳翼|太阳帆/i
const ANTENNA_ART = /antenna|dish|reflector|天线|反射面/i
const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _ts = new THREE.Vector3(), _tp = new THREE.Vector3(), _tc = new THREE.Vector3()
const _m3 = new THREE.Matrix3()
const _ta = [0, 0, 0], _tpv = [0, 0, 0], _tsu = [0, 0, 0]
function nameOfNode(o) { return (o.userData && o.userData.name) || o.name }
const wrap180 = (x) => { const v = ((x % 360) + 540) % 360 - 180; return v === -180 ? 180 : v }
function makeSunTrackers(inst, body) {
  const meta = inst.meta || {}
  const arts = Array.isArray(meta.articulations) ? meta.articulations : []
  const groups = Array.isArray(meta.solarPanelGroups) ? meta.solarPanelGroups : []
  if (!arts.length) return null
  const cellNames = new Set()
  for (const g of groups) for (const n of (g.nodes || [])) cellNames.add(n)
  const byName = new Map()
  inst.root.traverse((o) => { const n = nameOfNode(o); if (n && !byName.has(n)) byName.set(n, o) })
  inst.root.updateMatrixWorld(true)
  const list = []
  for (const a of arts) {
    const stages = Array.isArray(a && a.stages) ? a.stages : []
    const st = stages.find((s) => AXIS_OF[s && s.type])
    if (!st || stages.length !== 1) continue                       // 多级关节（展开 + 转动）不自动驱动：静止位姿不猜
    const nodes = (a.nodes || []).map((n) => byName.get(n)).filter(Boolean)
    if (!nodes.length) continue
    const cellNode = (a.nodes || []).find((n) => cellNames.has(n) && byName.get(n))
    const pv = a.pointingVector
    const pvOk = Array.isArray(pv) && pv.length === 3 && pv.every(Number.isFinite) && Math.hypot(pv[0], pv[1], pv[2]) > 1e-9
    const nm = String(a.name || '')
    const solar = !!cellNode || (SOLAR_ART.test(nm) && !ANTENNA_ART.test(nm))
    if (!solar || (pvOk && ANTENNA_ART.test(nm) && !cellNode) || (!pvOk && !cellNode)) continue
    const ref = cellNode ? byName.get(cellNode) : nodes[0]
    let p0 = null
    if (pvOk) p0 = new THREE.Vector3(pv[0], pv[1], pv[2]).normalize()
    else {
      // 电池片法向（参考节点坐标系）：取电池片网格第一个非退化三角形的面法向（电池片是平板，一个三角形就够；双面网格取平均会抵消）
      let mesh = null
      ref.traverse((o) => { if (!mesh && o.isMesh && o.geometry && o.geometry.attributes.position) mesh = o })
      if (!mesh) continue
      p0 = faceNormal(mesh.geometry)
      if (!p0) continue
      // 网格 → 参考节点（网格可能是节点的子件）
      _tm.copy(ref.matrixWorld).invert().multiply(mesh.matrixWorld)
      p0.applyMatrix3(_m3.setFromMatrix4(_tm)).normalize()
    }
    const axis = new THREE.Vector3().fromArray(AXIS_OF[st.type])
    // 节点静止位姿（关节从它起算；已含 applyRestPose 摆上的 initialValue）+ 模型根 → 参考节点的纯旋转（算太阳在节点系里的方向用）
    const rest = nodes.map((o) => { o.updateMatrix(); return o.matrix.clone() })
    const rootToNode = new THREE.Quaternion()
    _tm.copy(inst.root.matrixWorld).invert().multiply(ref.matrixWorld)
    _tm.decompose(_tp, rootToNode, _ts)
    rootToNode.invert()
    const init = Number.isFinite(st.initialValue) ? st.initialValue : 0
    const lo = (Number.isFinite(st.minimumValue) ? st.minimumValue : -180) - init
    const hi = (Number.isFinite(st.maximumValue) ? st.maximumValue : 180) - init
    list.push({ nodes, rest, axis, p0, rootToNode, lo: Math.min(lo, hi), hi: Math.max(lo, hi), deg: NaN, pv: pvOk })
  }
  if (!list.length) return null
  // 本体 → 模型根：body.matrix 的逆（纯旋转 × 统一缩放；方向只要旋转）
  const bodyToModel = new THREE.Quaternion()
  body.matrix.decompose(_tp, bodyToModel, _ts)
  bodyToModel.invert()
  return {
    count: list.length,
    /** 各关节此刻相对静止位姿的转角（度；验证台 / 单测读数） */
    angles: () => list.map((t) => t.deg),
    /** sunBody：太阳方向（本体系单位矢量，THREE.Vector3） */
    update(sunBody) {
      for (const t of list) {
        _tc.copy(sunBody).applyQuaternion(bodyToModel).applyQuaternion(t.rootToNode)
        // 太阳几乎沿转轴（β≈90°）：转到哪都一样，保持上一拍的角度
        const k = _tc.dot(t.axis)
        if (_tc.lengthSq() - k * k < 1e-8) continue
        _ta[0] = t.axis.x; _ta[1] = t.axis.y; _ta[2] = t.axis.z
        _tpv[0] = t.p0.x; _tpv[1] = t.p0.y; _tpv[2] = t.p0.z
        _tsu[0] = _tc.x; _tsu[1] = _tc.y; _tsu[2] = _tc.z
        let deg = articulationSunAngle(_tpv, _ta, _tsu)
        if (deg < t.lo || deg > t.hi) {
          if (deg - 360 >= t.lo && deg - 360 <= t.hi) deg -= 360
          else if (deg + 360 >= t.lo && deg + 360 <= t.hi) deg += 360
          else deg = Math.abs(wrap180(deg - t.lo)) <= Math.abs(wrap180(deg - t.hi)) ? t.lo : t.hi
        }
        if (Math.abs(deg - t.deg) < 0.05) continue
        t.deg = deg
        _tq.setFromAxisAngle(t.axis, deg * Math.PI / 180)
        _tm.makeRotationFromQuaternion(_tq)
        for (let i = 0; i < t.nodes.length; i++) {
          const o = t.nodes[i]
          o.matrix.multiplyMatrices(t.rest[i], _tm)
          o.matrix.decompose(o.position, o.quaternion, o.scale)
        }
      }
    }
  }
}
function faceNormal(geo) {
  const p = geo.attributes.position, idx = geo.index
  const n = idx ? idx.count : p.count
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let i = 0; i + 2 < n && i < 300; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2
    a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2)
    b.sub(a); c.sub(a)
    const f = new THREE.Vector3().crossVectors(b, c)
    if (f.lengthSq() > 1e-12) return f.normalize()
  }
  return null
}

// 单测用（packages/core/test/modelGlobeLayer.test.mjs）：挂架 + 太阳翼对日的几何口径不经 GPU 也能验
// createHud：挂点名屏幕避让（declutter）要个假 document 就能在 Node 里验（modelGlobeLayerP2 ⑤）
export const __test = { mountInstance, faceNormal, createHud }

// 材质克隆（图标要逐颗淡入淡出、逐颗按地影压暗 —— 共享材质改不得）；贴图不克隆（共享，随模板释放）
function cloneMaterials(root) {
  const map = new Map(), list = []
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return
    const one = (m) => {
      let c = map.get(m)
      if (!c) {
        c = m.clone()
        c.userData = { ...c.userData, _base: c.color ? c.color.clone() : null, _baseEm: c.emissive ? c.emissive.clone() : null }
        delete c.userData._shared
        map.set(m, c); list.push(c)
      }
      return c
    }
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material)
  })
  return list
}

// ============================================================================================
// HUD 与标签：屏幕像素定尺（不复用 scene.makeLabelSprite —— 那个按世界单位定尺，米制局部场景里不通）
// ============================================================================================
const HUD_FONT = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'
function makeLabel(text, color, pxH = 14) {
  const fs = 48, pad = 12
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  const font = `600 ${fs}px ${HUD_FONT}`
  ctx.font = font
  const tw = Math.ceil(ctx.measureText(text).width)
  c.width = tw + pad * 2; c.height = fs + pad * 2
  ctx.font = font; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(0,0,0,0.78)'; ctx.lineWidth = fs * 0.17
  ctx.strokeText(text, pad, c.height / 2)
  ctx.fillStyle = color
  ctx.fillText(text, pad, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false })
  const s = new THREE.Sprite(m)
  s.center.set(LABEL_CX, 0.5)
  s.renderOrder = 40
  s.userData.ar = c.width / c.height
  s.userData.pxH = pxH * (c.height / fs)
  return s
}
function disposeSprite(s) { if (!s) return; s.material.map.dispose(); s.material.dispose() }

// 单位长度的箭头（沿 +X）：杆 + 两对 V 形箭头
function arrowPositions(head) {
  const out = [0, 0, 0, 1, 0, 0]
  if (head) {
    const b = 0.9, w = 0.035
    out.push(1, 0, 0, b, w, 0, 1, 0, 0, b, -w, 0, 1, 0, 0, b, 0, w, 1, 0, 0, b, 0, -w)
  }
  return out
}
const _xAxis = new THREE.Vector3(1, 0, 0)
const BODY_KEYS = ['bx', 'by', 'bz'], LVLH_KEYS = ['lx', 'ly', 'lh']   // 逐帧循环用（别在热路径里写数组字面量）
/**
 * HUD 的 LVLH 三支虚线与天底线在 L 系里的方向（单测按真轨道验符号）。
 * ★ 轨道法向画 −ẑ：L 系 ẑ = x̂ × ŷ = v̂⊥ × r̂ = −ĥ（ĥ = r × v 的单位矢量，顺行 GEO 指北）。直接画 +ẑ 再标「轨道法向」
 *   就是把方向标反了 —— 读 β 角、看翼轴朝向的人会按 HUD 读反。nadir 律下本体 +Y 与 ẑ 重合，即 STK 口径的「负轨道法向」，
 *   所以本体轴 +Y（绿）与这支虚线恰好反向，两者一起看正好对上 STK 的 VVLH 约定。
 */
export const HUD_L_DIRS = Object.freeze({
  lx: Object.freeze([1, 0, 0]), ly: Object.freeze([0, 1, 0]), lh: Object.freeze([0, 0, -1]), nadir: Object.freeze([0, -1, 0])
})

function createHud(lineMats) {
  const group = new THREE.Group()
  group.name = 'hud'
  const mkLine = (color, width, dashed, head, opacity = 1) => {
    const g = new LineSegmentsGeometry()
    g.setPositions(arrowPositions(head))
    const m = new LineMaterial({ color, linewidth: width, worldUnits: false, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false, dashed: !!dashed, dashSize: 0.045, gapSize: 0.035 })
    lineMats.add(m)
    const o = new LineSegments2(g, m)
    if (dashed) o.computeLineDistances()
    o.renderOrder = 35
    o.frustumCulled = false
    return o
  }
  const items = {}
  const add = (k, color, css, text, width, dashed, head, op) => {
    const line = mkLine(color, width, dashed, head, op)
    const label = text ? makeLabel(text, css) : null
    const g = new THREE.Group()
    g.add(line); if (label) g.add(label)
    group.add(g)
    items[k] = { g, line, label, dir: new THREE.Vector3(1, 0, 0) }
  }
  // 本体轴（跟本体转）：+X 红 / +Y 绿 / +Z 蓝（STK / NASA Eyes 同一配色）
  add('bx', 0xff5a4e, '#ff7a6e', '+X', 2.2, false, true)
  add('by', 0x5bd66a, '#7be68a', '+Y', 2.2, false, true)
  add('bz', 0x4e8dff, '#7aa8ff', '+Z', 2.2, false, true)
  // LVLH（L 系，虚线）：沿迹 / 径向 / 轨道法向（+ĥ，见 HUD_L_DIRS）
  add('lx', 0xd7b8ff, '#d7b8ff', byLang('沿迹', 'Along-track'), 1.4, true, false, 0.9)
  add('ly', 0xd7b8ff, '#d7b8ff', byLang('径向', 'Radial'), 1.4, true, false, 0.9)
  add('lh', 0xd7b8ff, '#d7b8ff', byLang('轨道法向', 'Orbit normal'), 1.4, true, false, 0.9)
  add('nadir', 0xe8eef6, '#e8eef6', byLang('天底', 'Nadir'), 1.4, true, false, 0.85)
  add('vel', 0x45e0ff, '#6ae8ff', byLang('速度', 'Velocity'), 2, false, true)
  add('sun', 0xffd84a, '#ffe070', byLang('太阳', 'Sun'), 2, false, true)
  const body = new THREE.Group()   // 本体轴三件挂在这里（跟随时它的四元数 = qB2L）
  for (const k of BODY_KEYS) body.add(items[k].g)
  group.add(body)
  items.bx.dir.set(1, 0, 0); items.by.dir.set(0, 1, 0); items.bz.dir.set(0, 0, 1)
  for (const k of LVLH_KEYS) items[k].dir.fromArray(HUD_L_DIRS[k])
  items.nadir.dir.fromArray(HUD_L_DIRS.nadir)
  const itemList = Object.values(items)   // 逐帧循环用（for…in 与 Object.values 都别进热路径）
  // 挂点（二期）：每个挂点一支视轴射线（实线箭头，起点 = posBody）+ 视场锥（半透明，全锥角 = fovDeg；没给视场只画射线）+ 名字。
  // 挂在 body 组里（它的四元数 = qB2L），跟本体一起转；按需建、只增不减，列表签名变了才重摆
  const mountPool = []
  let mountN = 0, mountSig = '', mountRef = null, mountGen = 0
  // 挂点名避让（declutter）的暂存：按需扩容、只增不减，逐帧不分配。
  //   obs = 障碍矩形 [x0, x1, y0, y1] × n（像素）；ma = 挂点名锚点 [px, py, ww, hh] × 挂点下标；ord = 本帧待摆的挂点下标；
  //   sigBuf = 上一帧全部输入（见 declutter），逐元素相同就沿用上一帧的行
  let obs = new Float64Array(4 * 32), ma = new Float64Array(4 * 16), sigBuf = new Float64Array(64), sigN = -1, sigSame = false
  const ord = [], _ap = new Float64Array(4)
  let runs = 0, lastMoved = 0
  const growTo = (a, n) => { if (a.length >= n) return a; const b = new Float64Array(Math.max(n, a.length * 2)); b.set(a); return b }
  const byPy = (a, b) => ma[a * 4 + 1] - ma[b * 4 + 1]
  const putSig = (k, v) => { if (sigSame && sigBuf[k] !== v) sigSame = false; sigBuf[k] = v }
  const labelOn = (s) => !!(s && s.visible && s.parent && s.parent.visible)
  function hitObs(x0, x1, y0, y1, n) {
    for (let i = 0; i < n; i++) { const o = i * 4; if (x0 < obs[o + 1] && obs[o] < x1 && y0 < obs[o + 3] && obs[o + 2] < y1) return true }
    return false
  }
  // 字标锚点投影到屏幕像素：out[o..o+3] = px, py, ww, hh；不在视锥深度范围内返回 false。
  // 世界矩阵只刷「父组 + 字标」两级（父组的父 = body / group，declutter 开头已各刷一次）
  function anchorPx(s, cam, w, h, out, o) {
    s.parent.updateWorldMatrix(false, false)
    s.updateWorldMatrix(false, false)
    _lp.setFromMatrixPosition(s.matrixWorld).project(cam)
    if (!(_lp.z > -1 && _lp.z < 1)) return false
    const hh = s.userData.pxH || 14
    out[o] = (_lp.x + 1) / 2 * w; out[o + 1] = (1 - _lp.y) / 2 * h; out[o + 2] = hh * (s.userData.ar || 1); out[o + 3] = hh
    return true
  }
  function mountItem(i) {
    while (mountPool.length <= i) {
      const line = mkLine(0xff6fd6, 1.8, false, true, 0.95)
      const coneMat = new THREE.MeshBasicMaterial({ color: 0xff6fd6, transparent: true, opacity: 0.16, depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false })
      const cone = new THREE.Mesh(new THREE.BufferGeometry(), coneMat)
      cone.renderOrder = 34; cone.visible = false; cone.frustumCulled = false
      const g = new THREE.Group(); g.add(line); g.add(cone); g.visible = false
      body.add(g)
      mountPool.push({ g, line, cone, label: null, name: '', dir: new THREE.Vector3(0, 0, 1), half: -1 })
    }
    return mountPool[i]
  }
  // 单位视场锥：顶点在原点、沿 +X 张开、斜高方向长 1（底面在 x = 1），半锥角 half（度）
  function coneGeom(half) {
    const g = new THREE.ConeGeometry(Math.tan(half * DEG), 1, 48, 1, true)
    g.rotateZ(Math.PI / 2)              // 顶点 +Y → −X
    g.translate(0.5, 0, 0)              // 顶点落到原点，底面在 x = 1
    return g
  }
  const _qm = new THREE.Quaternion()
  // ISL 连线（主星 → 500 km 内与它通视的邻星，真实长度、实线、会被模型挡）与可见地球站方向（主星 → 站，虚线箭头 + 站名）：
  // 按需建、只增不减（上限 = 邻星上限 / 地球站上限），逐帧只改位姿与显隐
  const islPool = [], esPool = []
  function islItem(i) {
    while (islPool.length <= i) {
      const line = mkLine(0x86f0b4, 1.2, false, false, 0.6)   // 细、半透：十几根连线交叉在画面里时不压过模型
      line.material.depthTest = true   // 从主星体内出发的那一截让模型挡住
      line.renderOrder = 34
      group.add(line)
      islPool.push(line)
    }
    return islPool[i]
  }
  function esItem(i) {
    while (esPool.length <= i) {
      const line = mkLine(0xffa64d, 1.6, true, true, 0.95)
      const g = new THREE.Group(); g.add(line); group.add(g)
      esPool.push({ g, line, label: null, name: '', dir: new THREE.Vector3(1, 0, 0) })
    }
    return esPool[i]
  }
  const _q = new THREE.Quaternion()
  function place(it, len) {
    _q.setFromUnitVectors(_xAxis, it.dir)
    it.line.quaternion.copy(_q)
    it.line.scale.setScalar(len)
    if (it.label) it.label.position.copy(it.dir).multiplyScalar(len * 1.04)
  }
  const sizeLabel = (s, labelK) => { if (s) { const h = s.userData.pxH * labelK; s.scale.set(h * s.userData.ar, h, 1) } }
  return {
    group, body, items,
    lang: curLang(),   // 标签是烘进贴图的：界面语言一换就整份重建（见 ensureHudLang）
    /**
     * 每帧：长度随模型半径 / 相机距离、标签按屏幕像素定尺、开关。
     * 长度口径：以模型半径的 1.5 倍为基准，但不超过相机距离的 0.3 倍（42° 视场半高 ≈ 0.38 倍距离）—— 箭头与字标
     * 始终留在画面里；几组方向指示错开长度（本体轴 < LVLH < 太阳 < 速度 < 地球站），同向时（+X 与沿迹、+Z 与天底）字标不叠在一起
     */
    update(on, r, camDist, labelK) {
      const base = Math.max(1e-3, Math.min(r * 1.5, camDist * 0.3))
      const lb = base, ll = base * 1.22
      for (let i = 0; i < 3; i++) { const it = items[BODY_KEYS[i]]; it.g.visible = !!on.bodyAxes; if (on.bodyAxes) place(it, lb) }
      for (let i = 0; i < 3; i++) { const it = items[LVLH_KEYS[i]]; it.g.visible = !!on.lvlh; if (on.lvlh) place(it, ll) }
      items.nadir.g.visible = !!on.nadir; if (on.nadir) place(items.nadir, base * 1.45)
      items.vel.g.visible = !!on.velocity; if (on.velocity) place(items.vel, base * 1.7)
      items.sun.g.visible = !!on.sun; if (on.sun) place(items.sun, base * 1.55)
      for (let i = 0; i < itemList.length; i++) sizeLabel(itemList[i].label, labelK)
      // 挂点：射线长度从 1.1 倍基准起、逐支错开 0.12 倍（五支一轮）—— 对地天线的视轴大多平行，等长的话名字全叠在末端；
      // 视场锥与射线同长
      for (let i = 0; i < mountN; i++) {
        const it = mountPool[i]
        it.g.visible = !!on.mounts
        if (!on.mounts) continue
        const lm = base * (1.1 + 0.12 * (i % 5))
        _qm.setFromUnitVectors(_xAxis, it.dir)
        it.line.quaternion.copy(_qm); it.line.scale.setScalar(lm)
        it.cone.quaternion.copy(_qm); it.cone.scale.setScalar(lm)
        if (it.label) { it.label.position.copy(it.dir).multiplyScalar(lm * 1.04); sizeLabel(it.label, labelK) }
      }
      return base
    },
    /**
     * 挂点列表（本体系：posBody 米、dir 单位视轴、fovDeg 全锥角、name）。同一个数组引用不重算；内容签名没变不重摆。
     */
    setMounts(list) {
      if (list === mountRef) return
      mountRef = list
      const arr = Array.isArray(list) ? list : []
      const sig = JSON.stringify(arr.map((m) => [m.name || '', m.posBody, m.dir, m.fovDeg || 0]))
      if (sig === mountSig) return
      mountSig = sig
      mountGen++   // 字标可能换了新对象（center 回到默认）：避让不许沿用上一帧的行
      let k = 0
      for (const m of arr) {
        if (!m || !Array.isArray(m.posBody) || !Array.isArray(m.dir)) continue
        const it = mountItem(k++)
        it.g.position.set(m.posBody[0] || 0, m.posBody[1] || 0, m.posBody[2] || 0)
        it.dir.set(m.dir[0], m.dir[1], m.dir[2])
        if (!(it.dir.lengthSq() > 0)) it.dir.set(0, 0, 1)
        it.dir.normalize()
        const nm = String(m.name || '')
        if (nm !== it.name) {
          it.name = nm
          if (it.label) { it.g.remove(it.label); disposeSprite(it.label); it.label = null }
          if (nm) { it.label = makeLabel(nm, '#ff9ae4', 12); it.g.add(it.label) }
        }
        // 视场锥：全锥角 (0, 178°) 才画（再大就是半个天球，锥面画出来只是一块糊住模型的皮）
        const half = Number(m.fovDeg) > 0 && Number(m.fovDeg) < 178 ? Number(m.fovDeg) / 2 : 0
        if (half !== it.half) {
          it.half = half
          it.cone.geometry.dispose()
          it.cone.geometry = half > 0 ? coneGeom(half) : new THREE.BufferGeometry()
        }
        it.cone.visible = half > 0
      }
      mountN = k
      for (let i = k; i < mountPool.length; i++) mountPool[i].g.visible = false
    },
    mountCount: () => mountN,
    /**
     * 挂点名按屏幕避让（每帧，在 update / setEs 之后）：对地天线的视轴几乎平行，沿射线错开长度在斜侧机位下被透视压扁，
     * 名字照样叠。做法：本帧可见的其它 HUD 字标（轴 / LVLH / 太阳 / 速度 / 地球站）当固定障碍，挂点名按屏幕 y 从上到下
     * 逐个放。候选（CAND_ROW / CAND_ALT）= 行偏移 0、+1、−1、+2、−2 … ±ROW_MAX（行高 = 字高 × 1.1）× 锚点左右两侧，
     * 同一行先首选侧再另一侧 —— 一束近乎平行的射线，名字左右交替比一路往上摞离锚点近；原位不撞就回原位，其次先试上一帧
     * 的（行, 侧）（撞了原位时不在两个位置间来回跳）。首选侧 = 右侧，右沿放不下而左侧放得下（出界更少）时换左侧。
     * 视口边界也算障碍：出了画布四沿的候选不要（射线末端贴着 / 刚出下沿时名字拉回画面里）。都撞时取第一个留在视口里的候选
     * （压字总比切掉可读）；视口里一个候选也没有（锚点离画布超过 ROW_MAX 行）就回原位，跟着锚点整个留在画外、不贴边半截。
     * 移动走 sprite.center（锚点在字标内的相对位置），不动世界坐标：射线端点不变，字标像素位置变。
     * 逐帧零分配：矩形与锚点写进预分配的 Float64Array；每字标只投影一次（行偏移是纯算术）；世界矩阵只更新字标那一条链。
     * 输入（视口、障碍矩形、各挂点名锚点、挂点表版本）与上一帧逐元素相同就整段跳过、沿用上一帧的行 —— 画面静止时只剩投影。
     * @returns {number} 本帧挪动过的字标数（读数 / 单测用）
     */
    declutter(cam, w, h) {
      if (!cam || !(w > 0) || !(h > 0)) return 0
      // 世界矩阵：group / body 各一次，其余在 anchorPx 里只更新「字标的父组 + 字标」—— 不整棵刷 HUD（线段 / 视场锥不必）
      group.updateWorldMatrix(true, false)
      body.updateWorldMatrix(false, false)
      cam.updateMatrixWorld()
      // 固定障碍：其它 HUD 字标（中心就是默认锚点）
      let no = 0
      for (let i = 0; i < itemList.length + esPool.length; i++) {
        const it = i < itemList.length ? itemList[i] : esPool[i - itemList.length]
        if (!it.g.visible || !labelOn(it.label)) continue
        obs = growTo(obs, (no + 1) * 4)
        if (!anchorPx(it.label, cam, w, h, _ap, 0)) continue
        const x0 = _ap[0] - it.label.center.x * _ap[2], yc = _ap[1] + (it.label.center.y - 0.5) * _ap[3]
        obs[no * 4] = x0; obs[no * 4 + 1] = x0 + _ap[2]; obs[no * 4 + 2] = yc - _ap[3] / 2; obs[no * 4 + 3] = yc + _ap[3] / 2
        no++
      }
      // 挂点名：默认锚点（行 0、字标在锚点右侧）的屏幕位置
      let nm = 0
      ord.length = 0
      for (let i = 0; i < mountN; i++) {
        const it = mountPool[i]
        if (!it.g.visible || !labelOn(it.label)) continue
        ma = growTo(ma, (i + 1) * 4)
        if (!anchorPx(it.label, cam, w, h, ma, i * 4)) continue
        ord.push(i); nm++
      }
      // 与上一帧逐元素比：视口 2 + 挂点表版本 1 + 障碍 4·no + 挂点 5·nm
      const need = 3 + no * 4 + nm * 5
      sigSame = need === sigN
      sigBuf = growTo(sigBuf, need)
      putSig(0, w); putSig(1, h); putSig(2, mountGen)
      for (let k = 0; k < no * 4; k++) putSig(3 + k, obs[k])
      for (let j = 0, b = 3 + no * 4; j < nm; j++, b += 5) {
        const i = ord[j]
        putSig(b, i); putSig(b + 1, ma[i * 4]); putSig(b + 2, ma[i * 4 + 1]); putSig(b + 3, ma[i * 4 + 2]); putSig(b + 4, ma[i * 4 + 3])
      }
      sigN = need
      if (sigSame) return lastMoved
      runs++
      ord.sort(byPy)
      let moved = 0
      for (let j = 0; j < nm; j++) {
        const it = mountPool[ord[j]], s = it.label, o = ord[j] * 4
        const px = ma[o], py = ma[o + 1], ww = ma[o + 2], hh = ma[o + 3]
        // 首选侧：右侧；右沿放不下、翻到左侧出界更少就左侧
        const xr = px - LABEL_CX * ww, xl = px - LABEL_CX_FLIP * ww
        const outR = Math.max(0, -xr) + Math.max(0, xr + ww - w), outL = Math.max(0, -xl) + Math.max(0, xl + ww - w)
        const cxPref = outL < outR ? LABEL_CX_FLIP : LABEL_CX, cxAlt = cxPref === LABEL_CX ? LABEL_CX_FLIP : LABEL_CX
        const prevRow = it.row || 0, prevAlt = it.cx === cxAlt ? 1 : 0
        let pick = -1, inView = -1
        // 试的顺序：k = 0 原位首选侧 → k = 1 上一帧的（行, 侧）（就是原位首选侧时跳过）→ k ≥ 2 候选表第 1 项起（跳过与上一帧相同的）
        for (let k = 0; k <= CAND_N; k++) {
          let row, alt
          if (k === 0) { row = 0; alt = 0 }
          else if (k === 1) { if (prevRow === 0 && prevAlt === 0) continue; row = prevRow; alt = prevAlt }
          else { row = CAND_ROW[k - 1]; alt = CAND_ALT[k - 1]; if (row === prevRow && alt === prevAlt) continue }
          const x0 = alt ? px - cxAlt * ww : px - cxPref * ww, y0 = py + row * ROW_STEP * hh - hh / 2
          const out = Math.max(0, -x0) + Math.max(0, x0 + ww - w) + Math.max(0, -y0) + Math.max(0, y0 + hh - h)   // 出画布四沿的像素数
          if (out > 0) continue
          if (!hitObs(x0, x0 + ww, y0, y0 + hh, no)) { pick = row * 2 + alt + CAND_OFF; break }
          if (inView < 0) inView = row * 2 + alt + CAND_OFF
        }
        if (pick < 0) pick = inView >= 0 ? inView : CAND_OFF   // 都撞：第一个在视口里的；视口里没有：原位首选侧
        const row = Math.floor((pick - CAND_OFF) / 2), alt = (pick - CAND_OFF) - row * 2
        const cx = alt ? cxAlt : cxPref
        it.row = row; it.cx = cx
        s.center.set(cx, 0.5 + row * ROW_STEP)
        if (row || cx !== LABEL_CX) moved++
        // 本字标占位 → 后面的挂点名当障碍
        obs = growTo(obs, (no + 1) * 4)
        const x0 = px - cx * ww, y0 = py + row * ROW_STEP * hh - hh / 2
        obs[no * 4] = x0; obs[no * 4 + 1] = x0 + ww; obs[no * 4 + 2] = y0; obs[no * 4 + 3] = y0 + hh
        no++
      }
      lastMoved = moved
      return moved
    },
    /** 避让真正重排过几次（静止帧跳过不计；单测验「输入没变不重排」用） */
    declutterRuns: () => runs,
    /** 屏幕上各挂点名的矩形（像素，验证台 / 单测查重叠 / 出界用；px, py = 锚点即射线端点，cx = 左右朝向） */
    mountLabelRects(cam, w, h) {
      const out = []
      if (!cam) return out
      group.updateWorldMatrix(true, true)
      cam.updateMatrixWorld()
      for (let i = 0; i < mountN; i++) {
        const s = mountPool[i].label
        if (!s || !mountPool[i].g.visible) continue
        s.getWorldPosition(_lp).project(cam)
        const px = (_lp.x + 1) / 2 * w, py = (1 - _lp.y) / 2 * h
        const hh = s.userData.pxH || 14, ww = hh * (s.userData.ar || 1)
        const x0 = px - s.center.x * ww, yc = py + (s.center.y - 0.5) * hh
        out.push({ name: mountPool[i].name, x0, x1: x0 + ww, y0: yc - hh / 2, y1: yc + hh / 2, px, py, cx: s.center.x })
      }
      return out
    },
    /** ISL：第 i 条线从局部原点连到 rel（米）；n 之后的全部藏起 */
    setIsl(i, rel) {
      const line = islItem(i)
      _v1.copy(rel)
      const len = _v1.length()
      if (!(len > 0)) { line.visible = false; return }
      line.visible = true
      line.quaternion.setFromUnitVectors(_xAxis, _v1.multiplyScalar(1 / len))
      line.scale.setScalar(len)
    },
    hideIslFrom(n) { for (let i = n; i < islPool.length; i++) islPool[i].visible = false },
    /** 地球站：第 i 支箭头指向 dir（L 系单位矢量），名字变了才重烘标签 */
    setEs(i, dir, name, len, labelK) {
      const it = esItem(i)
      if (name !== it.name) {
        it.name = name
        if (it.label) { it.g.remove(it.label); disposeSprite(it.label); it.label = null }
        if (name) { it.label = makeLabel(name, '#ffbf80', 12); it.g.add(it.label) }
      }
      it.g.visible = true
      it.dir.set(dir[0], dir[1], dir[2])
      place(it, len)
      sizeLabel(it.label, labelK)
    },
    hideEsFrom(n) { for (let i = n; i < esPool.length; i++) esPool[i].g.visible = false },
    dispose() {
      const kill = (line) => { line.geometry.dispose(); lineMats.delete(line.material); line.material.dispose() }
      for (const it of itemList) { kill(it.line); disposeSprite(it.label) }
      for (const line of islPool) kill(line)
      for (const it of esPool) { kill(it.line); disposeSprite(it.label) }
      for (const it of mountPool) { kill(it.line); disposeSprite(it.label); it.cone.geometry.dispose(); it.cone.material.dispose() }
      islPool.length = 0; esPool.length = 0; mountPool.length = 0; mountN = 0
    }
  }
}
const _v1 = new THREE.Vector3()
const _lp = new THREE.Vector3()   // HUD 字标避让：投影暂存
// 挂点名避让：行高 = 字高 × ROW_STEP，上下各最多挪 ROW_MAX 行；字标左右朝向 = sprite.center.x（锚点在字标内的相对位置，
// −0.15 = 字标在锚点右侧、留 0.15 字宽的缝；1.15 = 翻到左侧）。
// 候选表（CAND_ROW 行偏移 / CAND_ALT 0 首选侧 · 1 另一侧）：(0,0) (0,1) (+1,0) (+1,1) (−1,0) (−1,1) (+2,0) … —— 位移由近及远，
// 同一位移先下后上、先首选侧后另一侧。选中的候选编成一个非负整数（row·2 + alt + CAND_OFF）免得逐帧建对象
const ROW_STEP = 1.1, ROW_MAX = 8
const LABEL_CX = -0.15, LABEL_CX_FLIP = 1.15
const CAND_N = 2 * (2 * ROW_MAX + 1)
const CAND_ROW = new Int8Array(CAND_N), CAND_ALT = new Uint8Array(CAND_N)
for (let d = 0, c = 0; d <= ROW_MAX; d++) for (const r of d ? [d, -d] : [0]) for (let a = 0; a < 2; a++) { CAND_ROW[c] = r; CAND_ALT[c] = a; c++ }
const CAND_OFF = 2 * ROW_MAX

// 卫星标记贴图：跟随时主星没有模型可画（绑定「无」/ 离线未缓存 / 下载或解码失败 / 还在加载 / 弱 GPU）的回退 ——
// 与球面上聚焦星图标同一个形状（scene.js FOCUS_SAT_SVG：双侧 3×2 太阳翼 + 中央星体，白填深描边、斜 20°）。
// ★ 现画在 canvas 上（同步），不走 SVG → Image 的异步路：进入跟随的第一帧就要有
let _markTex = null
function satMarkTexture() {
  if (_markTex) return _markTex
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S
  const g = c.getContext('2d')
  g.scale(S / 120, S / 120)
  g.translate(60, 60); g.rotate(-20 * DEG); g.translate(-60, -60)
  const rr = (x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h) }
  const shapes = []
  for (const x0 of [8, 21, 34, 76, 89, 102]) for (const y0 of [41, 63]) shapes.push([x0, y0, 10, 16, 3])
  shapes.push([49, 35, 22, 50, 10])
  g.lineJoin = 'round'; g.lineWidth = 4; g.strokeStyle = 'rgba(8,12,18,0.92)'; g.fillStyle = '#ffffff'
  for (const s of shapes) { rr(...s); g.fill(); g.stroke() }   // SVG 的画序：先填后描
  _markTex = new THREE.CanvasTexture(c)
  _markTex.colorSpace = THREE.SRGBColorSpace
  _markTex.userData._shared = true
  return _markTex
}
const MARK_PX = 30   // 与球面聚焦星图标出厂尺寸同（scene.FOCUS_SAT_PX）

// 圆点贴图（其他星在亚像素距离时的标记）
let _dotTex = null
function dotTexture() {
  if (_dotTex) return _dotTex
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
  _dotTex = new THREE.CanvasTexture(c)
  _dotTex.colorSpace = THREE.SRGBColorSpace
  _dotTex.userData._shared = true
  return _dotTex
}

// 画质档 → 跟随视图的 LOD 与阴影（任务书 §5.9：极致 = lod0 + 阴影，中 = lod1，低 = lod2 无阴影）
// tris：该档三角形预算 —— 档位只是「最细到哪一档」，真正取哪一档还要看模型自己的面数（ISS IGOAL 的 lod1 有 140 万面、
// 29 MB，「高」档照档位取会在进入跟随时卡一秒多；按预算退到 lod2 的 28 万面，画面差别在 5 km 视距内看不出）
function followProfile(tier, q) {
  switch (tier) {
    case 'native': return { lod: 'lod0', shadows: true, tris: 3.5e6 }
    case 'ultra': return { lod: 'lod0', shadows: true, tris: 2e6 }
    case 'high': return { lod: 'lod1', shadows: true, tris: 8e5 }
    case 'mid': return { lod: 'lod1', shadows: false, tris: 4e5 }
    case 'low': return { lod: 'lod2', shadows: false, tris: 1.5e5 }
    default: return (q && q.pixelRatio >= 2) ? { lod: 'lod1', shadows: true, tris: 8e5 } : { lod: 'lod2', shadows: false, tris: 1.5e5 }
  }
}
const LOD_DOWN = { lod0: 'lod1', lod1: 'lod2', lod2: 'lod2' }
const LOD_ORDER = ['lod0', 'lod1', 'lod2']
/** 从 want 往粗里找第一档面数 ≤ 预算的（meta.files 里没面数的档不挡路；都超了取最粗的那档） */
export function lodByBudget(meta, want, budget) {
  const files = meta && meta.files
  if (!files || !(budget > 0)) return want
  let i = Math.max(0, LOD_ORDER.indexOf(want))
  for (; i < LOD_ORDER.length; i++) {
    const f = files[LOD_ORDER[i]]
    if (!f) continue
    if (!(f.tris > 0) || f.tris <= budget) return LOD_ORDER[i]
  }
  for (let k = LOD_ORDER.length - 1; k >= 0; k--) if (files[LOD_ORDER[k]]) return LOD_ORDER[k]
  return want
}

/**
 * 软件光栅（没有可用 GPU：SwiftShader / llvmpipe / 微软基本显示驱动 …）判据。命中时球面图标不画（照旧点精灵）、
 * 跟随不载模型（画回退标记）、不画大气与眩光 —— DESIGN §9-8「弱 GPU → 原图标，静默」。
 * 硬件 GPU 再慢也不走这条：交给跟随里的逐档降级（lod0 → lod1 → lod2 → 标记）按实测帧时自己退。
 */
export { isSoftwareRenderer }   // 判据与宇宙空间（spaceFx.js）同一份

/**
 * @param {{api?:object, getQuality?:()=>({tier:string}&object), metaOf?:(id:string)=>object|null,
 *          onFollowZoom?:(t:number)=>void, onMaskChange?:(on:boolean)=>void}} o
 */
export function createModelLayer(o = {}) {
  const source = createModelSource({ api: o.api, metaOf: o.metaOf })
  const getQuality = o.getQuality || (() => ({ tier: 'high' }))
  // LineMaterial 的分辨率要逐帧跟画布：用数组（逐帧遍历 Set 要建迭代器）
  const lineMats = {
    list: [],
    add(m) { this.list.push(m) },
    delete(m) { const i = this.list.indexOf(m); if (i >= 0) this.list.splice(i, 1) },
    clear() { this.list.length = 0 }
  }
  let renderer = null, gpu = null, disposed = false, gpuWeak = false
  let lastW = 0, lastH = 0

  // ---------------- 球面图标 ----------------
  const iconScene = new THREE.Scene()
  const iconSun = new THREE.DirectionalLight(0xffffff, 3.0)
  const iconAmb = new THREE.AmbientLight(0x9fb4d8, 0.14)
  const iconFill = new THREE.DirectionalLight(0xffffff, 0)   // 相机侧补光（晨昏效果开时，见 FILL_LIT）
  iconScene.add(iconSun, iconSun.target, iconAmb, iconFill, iconFill.target)
  let iconEnv = null
  const icons = new Map()        // key → slot（查找用）
  const iconArr = []             // 同一批槽位（逐帧遍历用：下标循环零分配）
  let iconsOn = true, iconPx = 28
  let maskOn = false
  const sunS = new THREE.Vector3(1, 0, 0)
  // 光照口径跟「地图设置 · 宇宙空间 · 晨昏效果」走（setSunLit；2026-09-24 用户定：没有晨昏效果时地球和卫星都该全亮）：
  //   开 = 按太阳（原画法）：硬平行光沿真实太阳方向、按地影压暗（跟随是 studio 的 sun 档，NASA Eyes 观感）。
  //   关 = 全亮：平行光改成相机头灯（从相机左上后方打来，看得见的一面都受光）、不按地影压暗、地球反照按昼侧给满。
  //        跟随仍用 sun 档、只换光的方向 —— 太空环境反射（上黑下蓝）留着；换影棚档（studio）试过：
  //        太阳翼这类光面整片映成影棚的白墙，一颗深蓝的星变成白塑料，太空里不像样。
  let sunLit = true
  // 相机系（相机朝 −Z）：光从相机左上后方来，离视线约 44°。再贴近视线（试过 31°）正对镜头的大平面（太阳翼、背板）
  // 镜面反射整片发白、看不出电池片；再偏就又有背光面，不算「全亮」
  const HEADLIGHT_C = new THREE.Vector3(-0.5, 0.65, 0.85).normalize()
  const _hl = new THREE.Vector3()

  // ---------------- 跟随 ----------------
  const localScene = new THREE.Scene()
  const camL = new THREE.PerspectiveCamera(42, 1, 0.1, 6e5)
  camL.up.set(0, 1, 0)
  const followRoot = new THREE.Group()       // 主星（L 系，位姿 = qB2L）
  const othersRoot = new THREE.Group()
  const followFill = new THREE.DirectionalLight(0xffffff, 0)   // 相机侧补光（晨昏效果开时，见 FILL_LIT；不进 studio 灯组，不投影子）
  localScene.add(followRoot, othersRoot, followFill, followFill.target)
  let hud = null, mark = null                // mark：主星没有模型可画时的回退标记（见 satMarkTexture）
  let hudMoved = 0, _vpW = 0, _vpH = 0          // 挂点名避让：本帧挪动的字标数 / 最近一帧的视口（stats 读数用）
  let studio = null, studioShadows = null
  let sunVisModel = 1                        // 主星模型挡太阳的系数（0..1，1 = 没挡）：overlay.sunVisibility 报给 scene 的眩光
  let fstate = null                          // 本拍的跟随状态（页面每拍给）
  let fslot = null                           // 主星模型实例
  const others = new Map()                   // key → { inst, mount, req, label, dot, rel:Vector3, q:Quaternion, name }
  const otherArr = []
  let ctl = null, dom = null, domTouch = ''
  let followTau = tauFor(50), wheelPct = 3
  let zoomTarget = 60, dMin = 5, dMax = FOLLOW_MAX_M
  let hudOn = { bodyAxes: false, lvlh: false, nadir: false, velocity: false, sun: false, isl: false, es: false, mounts: false }
  let lod = 'lod1', lodDowngraded = null, lodBudget = 0
  let modelOff = false                       // 本次跟随里逐档降级已退到底（lod2 / 参数化仍跟不上）：只画标记
  const perf = { acc: 0, n: 0, hold: 0, slow: 0, frameMs: 0, lastT: 0 }
  let camMovedL = false, zoomBusy = false, dragging = false
  const ES_MAX = 12                          // HUD 地球站方向最多几支（页面按距离近者优先给）
  const ISL_GRAZE_M = RE_M + 100e3           // ISL 通视判据：连线不擦过 100 km 高度以下（与 regen 星间链路的擦地口径同量级）

  const qL2S = new THREE.Quaternion(), qS2L = new THREE.Quaternion(), qB2L = new THREE.Quaternion()
  const anchor = new THREE.Vector3(), sunL = new THREE.Vector3(1, 0, 0), velL = new THREE.Vector3(1, 0, 0)
  const earthL = new THREE.Vector3()         // 地心在 L 系的位置（米）
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion()

  // ============================== 图标 ==============================
  function newIconSlot(key) {
    return { key, modelId: null, frame: null, frameSig: '', px: iconPx, anchor: new THREE.Vector3(), q: new THREE.Quaternion(), qB2L: new THREE.Quaternion(), altScene: 0.05, eclipse: 1, want: true,
      alpha: 0, inst: null, mount: null, mats: null, req: 0, visible: false, dotW: 1, pxR: 0, lastEcl: -1, envTex: null }
  }
  function releaseIconInst(s) {
    if (s.mount) iconScene.remove(s.mount.holder)
    if (s.mats) for (const m of s.mats) m.dispose()
    if (s.inst) s.inst.release()
    s.inst = null; s.mount = null; s.mats = null; s.lastEcl = -1; s.envTex = null
  }
  function dropIconSlot(s) {
    releaseIconInst(s); s.req++
    icons.delete(s.key)
    const i = iconArr.indexOf(s); if (i >= 0) iconArr.splice(i, 1)
  }
  /** keep：原位换新实例（元数据刷新）时保留当前透明度，不重新淡入 */
  function loadIcon(s, keep) {
    const req = ++s.req
    const id = s.modelId
    if (!id) return
    source.acquire(id, 'lod2', null).then(async (inst) => {
      const stale = () => disposed || req !== s.req || !icons.has(s.key)
      if (stale()) { if (inst) inst.release(); return }
      if (!inst) return   // 没模型：留着点精灵
      await waitRenderer()
      if (stale() || gpuWeak) { inst.release(); return }   // 软件光栅：图标一律不画，留点精灵
      const mount = mountInstance(inst, s.frame)
      const mats = cloneMaterials(inst.root)
      // 恒为 transparent（transparent 是着色器程序的参数之一，逐帧切会来回换程序）；depthWrite 照开 —— 自遮挡靠深度，
      // 不透明度 1 时混合结果与不透明画法相同。环境图此刻就挂上（挂晚了又是一次同步重编）
      ensureIconEnv()
      const envTex = iconEnv ? iconEnv.texture : null
      for (const m of mats) {
        m.transparent = true; m.opacity = 0; m.depthWrite = true
        if ('envMap' in m && envTex) { m.envMap = envTex; m.envMapIntensity = ICON_ENV_I }
      }
      await warmUp(mount.holder, iconScene, true, false)
      if (stale()) { for (const m of mats) m.dispose(); inst.release(); return }
      const a0 = keep && s.inst ? s.alpha : 0
      releaseIconInst(s)
      s.inst = inst; s.mount = mount; s.mats = mats; s.envTex = envTex
      s.alpha = a0
      trackSun(s.mount, s.q, sunS)
      if (gpu) gpu.track(s.mount.holder)
      iconScene.add(s.mount.holder)
    })
  }
  /**
   * 着色器预编译（KHR_parallel_shader_compile，three 的 compileAsync）：新模型的程序在后台编好再挂进场景。
   * ANGLE / D3D 下一个 Physical 材质程序同步编要一两百毫秒，一颗十几种材质的星就是进入跟随后一秒多的整屏卡死。
   * 编译时渲染器的 ACES / 阴影开关要与真正画它的那一趟一致 —— 它们是程序缓存键的一部分，对不上画的时候照样同步重编。
   * 还没拿到 renderer（第一帧之前）或驱动不支持时直接返回：挂上去由正常渲染路径去编。
   */
  // 叠加层第一次出帧才拿到 renderer：参数化模型是微任务里就生成好的，等一帧（最多 0.5 s）
  function waitRenderer() { return renderer ? null : Promise.race([rendererReady, new Promise((res) => setTimeout(res, 500))]) }
  async function warmUp(obj, targetScene, aces, shadows) {
    await waitRenderer()
    const r = renderer
    if (!r || typeof r.compileAsync !== 'function') return
    const tm = r.toneMapping, sm = r.shadowMap.enabled
    let p = null
    try {
      r.toneMapping = aces ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping
      r.shadowMap.enabled = !!shadows
      obj.updateMatrixWorld(true)
      p = r.compileAsync(obj, _warmCam, targetScene)
    } catch { p = null } finally { r.toneMapping = tm; r.shadowMap.enabled = sm }
    if (p) { try { await p } catch { /* 编不过：交给正常渲染路径 */ } }
  }
  // 太阳翼对日：太阳（qB2X 所在的那个系里的方向）→ 本体系，交给该实例的关节驱动
  const _sb = new THREE.Vector3(), _qi = new THREE.Quaternion()
  function trackSun(mount, qB2X, sunX) {
    if (!mount || !mount.sun) return
    _sb.copy(sunX).applyQuaternion(_qi.copy(qB2X).invert())
    mount.sun.update(_sb)
  }
  /**
   * 每拍：聚焦星的图标状态。list 项：{ key, modelId, px?, anchor:[x,y,z]（场景单位，llaToVec 大地版）, qL2S:[x,y,z,w],
   *   qB2L?:[x,y,z,w]（本体 → L；缺省 nadir）, frame?:{q,t}（绑定表逐星的模型轴覆盖）, altKm, eclipse:0..1 }。不在表里的淡出后移除。
   */
  function setIcons(list) {
    const seen = new Set()
    const arr = Array.isArray(list) ? list.slice(0, MAX_ICONS) : []
    for (const it of arr) {
      if (!it || !it.key) continue
      seen.add(it.key)
      let s = icons.get(it.key)
      if (!s) { s = newIconSlot(it.key); icons.set(it.key, s); iconArr.push(s) }
      s.want = true
      s.px = Number(it.px) > 0 ? Number(it.px) : iconPx
      s.anchor.set(it.anchor[0], it.anchor[1], it.anchor[2])
      const qb = it.qB2L || Q_BODY2L_NADIR
      s.qB2L.set(qb[0], qb[1], qb[2], qb[3])
      s.q.set(it.qL2S[0], it.qL2S[1], it.qL2S[2], it.qL2S[3]).multiply(s.qB2L)
      s.altScene = Math.max(1e-4, (Number(it.altKm) || 300) / 6371)
      s.eclipse = Number.isFinite(it.eclipse) ? it.eclipse : 1
      trackSun(s.mount, s.q, sunS)
      const fsig = frameSig(it.frame)
      if ((it.modelId || null) !== s.modelId || fsig !== s.frameSig) {
        const sameModel = (it.modelId || null) === s.modelId
        s.modelId = it.modelId || null
        s.frame = it.frame || null; s.frameSig = fsig
        if (s.inst && !sameModel) { releaseIconInst(s); s.alpha = 0 }
        s.req++
        if (s.modelId) loadIcon(s, sameModel)
      }
    }
    for (let i = 0; i < iconArr.length; i++) if (!seen.has(iconArr[i].key)) iconArr[i].want = false
  }

  // 相机 → P 的线段是否先穿过单位球（与 scene.occludedByGlobe / 点精灵着色器剔除同一判据）
  function occluded(C, P) {
    const dx = P.x - C.x, dy = P.y - C.y, dz = P.z - C.z
    const a = dx * dx + dy * dy + dz * dz
    const b = 2 * (C.x * dx + C.y * dy + C.z * dz)
    const c = C.x * C.x + C.y * C.y + C.z * C.z - 1
    const disc = b * b - 4 * a * c
    if (disc <= 0) return false
    const sq = Math.sqrt(disc), EPS = 1e-4
    const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a)
    return (t1 > EPS && t1 < 1 - EPS) || (t2 > EPS && t2 < 1 - EPS)
  }

  function updateIcons(dt, camera, h) {
    let busy = false
    const tanH = Math.tan(camera.fov * Math.PI / 360)
    const C = camera.position
    for (let i = iconArr.length - 1; i >= 0; i--) {   // 倒序：循环里可能摘掉当前槽位
      const s = iconArr[i]
      const ready = !!(s.mount && s.mats)
      const target = (s.want && iconsOn && ready && !fstate && !gpuWeak) ? 1 : 0
      if (s.alpha !== target) {
        const st = dt > 0 ? dt / FADE_S : 0
        s.alpha = target > s.alpha ? Math.min(target, s.alpha + st) : Math.max(target, s.alpha - st)
        busy = true
      }
      if (!s.want && s.alpha <= 0) { dropIconSlot(s); continue }
      if (!ready) { s.visible = false; s.dotW = 1; continue }
      const occ = occluded(C, s.anchor)
      const D = C.distanceTo(s.anchor)
      const wpp = 2 * D * tanH / Math.max(1, h)                 // 此处 1 CSS 像素 = 多少场景单位
      // 半径 = 用户给的屏幕像素（不再按「0.4 × 轨道高度」封顶：那道顶让低轨星在全球视角下最多约 34 px，图标大小滑杆拉到头也不变大；
      // 图标这一趟先清深度（见 render），大图标整个画在球面之上、不被地球裁掉；锚点在地球背面的照旧按 occluded 整个藏起）
      const R = (s.px / 2) * wpp
      s.pxR = R / wpp
      const k0 = R / s.mount.radius
      const sizeF = smooth(2.5, 5, s.pxR)                       // 太小的图标让位给点：半径 < 2.5 px 全画点
      s.visible = !occ && s.alpha > 0.002 && s.pxR > 1.2
      const hold = s.mount.holder
      hold.visible = s.visible
      if (s.visible) {
        hold.position.copy(s.anchor)
        hold.quaternion.copy(s.q)
        hold.scale.setScalar(k0)
        const a = s.alpha * sizeF
        const mats = s.mats
        for (let j = 0; j < mats.length; j++) mats[j].opacity = a
        // 地影：逐颗压暗（本影里只剩一点地球反照 / 环境光）。一颗一份材质，改色不串到别的星。
        // 环境反射也要跟着暗：scene.environment 的强度是全场一个值（会盖掉材质自己的 envMapIntensity），
        // 故环境图逐材质挂（envMap 由空变有只重编一次程序），强度按地影逐颗给
        const envTex = iconEnv ? iconEnv.texture : null
        const e = sunLit ? Math.round(s.eclipse * 50) / 50 : 1   // 全亮（晨昏效果关）：不按地影压暗
        if (e !== s.lastEcl || s.envTex !== envTex) {
          // 本影里留五成底色：图标是分析读图用的，比日照暗一截看得出在地影里，但结构要看得清（原两成在夜半球上成黑剪影）
          const kk = ICON_ECL_FLOOR + (1 - ICON_ECL_FLOOR) * e
          for (let j = 0; j < mats.length; j++) {
            const m = mats[j]
            if (m.userData._base) m.color.copy(m.userData._base).multiplyScalar(kk)
            if ('envMap' in m && m.envMap !== envTex) { m.envMap = envTex; m.needsUpdate = true }
            if ('envMapIntensity' in m) m.envMapIntensity = ICON_ENV_I * (0.6 + 0.4 * e)
          }
          s.lastEcl = e; s.envTex = envTex
        }
      }
      s.dotW = occ ? 1 : 1 - s.alpha * sizeF
    }
    return busy
  }
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

  function iconsVisible() { for (let i = 0; i < iconArr.length; i++) if (iconArr[i].visible) return true; return false }

  // ============================== 跟随 ==============================
  function releaseFollowInst() {
    if (fslot) {
      source.forget(fslot.onUp)
      if (fslot.mount) followRoot.remove(fslot.mount.holder)
      if (fslot.inst) fslot.inst.release()
      fslot = null
    }
  }
  /**
   * 跟随主星的模型：先按三角形预算定档（lodByBudget），再「渐进」—— 目标档比 lod2 细时先挂 lod2（几百 KB，几十毫秒见模型），
   * 目标档在后台解析好再原位换上（LOD 流式；大件的贴图解码 / 上传停顿不再是进入跟随后的一段空白）。
   * 没有模型 / 软件光栅 / 逐档降级已退到底：不建槽位（或建了不载），局部原点画回退标记（见 updateFollow）。
   * hintR：库条目里的包围半径（米）—— 模型还没到时就按它定取景距离与缩放上下限，模型到了不再跳一下。
   */
  function loadFollow(modelId, wantLod, budget, frame) {
    releaseFollowInst()
    if (!modelId || gpuWeak || modelOff) return
    let hintR = 0
    try { const m = o.metaOf ? o.metaOf(modelId) : null; const g = m && m.geometry; if (g && g.boundingRadiusM > 0) hintR = g.boundingRadiusM } catch { hintR = 0 }
    const slot = { modelId, lod: wantLod, inst: null, mount: null, req: 0, onUp: null, go: null, budget: budget || 0, frame: frame || null, frameSig: frameSig(frame), hintR }
    fslot = slot
    const live = (req) => !disposed && fslot === slot && req === slot.req
    // 新实例先在场景外编好着色器（warmUp）再原位换上；换上之前旧的一档照画
    const mountInto = async (inst, req) => {
      const mount = mountInstance(inst, slot.frame)
      trackSun(mount, qB2L, sunL)
      await warmUp(mount.holder, localScene, true, !!studioShadows)
      if (!live(req)) { inst.release(); return false }
      if (slot.mount) followRoot.remove(slot.mount.holder)
      if (slot.inst) slot.inst.release()
      slot.inst = inst
      slot.mount = mount
      if (gpu) gpu.track(slot.mount.holder)
      followRoot.add(slot.mount.holder)
      fitFollow()
      return true
    }
    const go = async () => {
      const req = ++slot.req
      slot.onUp = () => { if (fslot === slot) go() }
      let lodT = wantLod
      if (!modelId.startsWith('param:') && slot.budget > 0) {
        try { lodT = lodByBudget(await source.meta(modelId), wantLod, slot.budget) } catch { lodT = wantLod }
        if (!live(req)) return
      }
      slot.lod = modelId.startsWith('param:') ? 'param' : lodT   // 参数化是现场生成的一份，没有档可降
      if (lodT !== 'lod2' && !slot.inst && !modelId.startsWith('param:')) {
        const small = await source.acquire(modelId, 'lod2', null)
        if (!live(req)) { if (small) small.release(); return }
        if (small && !(await mountInto(small, req))) return
      }
      const inst = await source.acquire(modelId, lodT, slot.onUp)
      if (!live(req)) { if (inst) inst.release(); return }
      if (inst) await mountInto(inst, req)
    }
    slot.go = go
    go()
  }
  function followRadius() {
    if (fslot && fslot.mount) return fslot.mount.radius
    return fslot && fslot.hintR > 0 ? fslot.hintR : 8
  }
  // 缩放上下限：最近 1.2 × 包围半径、最远 5 km（任务书 §5.10）。进入跟随时就按当前半径（含库条目的预估）定下来 ——
  // 不定的话局部控件会带着上一次跟随留下的 minDistance，模型迟迟不到时每帧把距离夹回旧下限、缩放缓动又往回拉，
  // 「缩放还在动」永远为真，帧率上限就此失效
  function setFollowLimits(r) {
    dMin = Math.max(0.5, 1.2 * r)
    dMax = FOLLOW_MAX_M
    if (ctl) { ctl.minDistance = dMin; ctl.maxDistance = dMax }
  }
  let userZoomed = false   // 本次跟随里用户动过距离（滚轮 / 状态栏）：模型晚到时不再按它的尺寸重新取景
  function fitFollow() {
    const r = followRadius()
    setFollowLimits(r)
    if (!userZoomed) {
      // 进入跟随时模型往往还没到（下载 / 解码）：到了按真实包围半径重新定一次距离（直切，不做相机飞行）
      zoomTarget = Math.max(dMin, Math.min(dMax, r * 3.4))
      camL.position.setLength(zoomTarget)
    }
    const d = camL.position.length()
    if (d < dMin) camL.position.setLength(dMin)
    zoomTarget = Math.max(dMin, Math.min(dMax, zoomTarget))
    if (studio) { studio.fit(_v.set(0, 0, 0), r); tuneEarthshine() }
    reportZoom()
  }
  const distToT = (d) => TMAX * (Math.log(dMax) - Math.log(Math.max(dMin, Math.min(dMax, d)))) / Math.max(1e-9, Math.log(dMax) - Math.log(dMin))
  const tToDist = (t) => Math.exp(Math.log(dMax) - Math.max(0, Math.min(TMAX, t)) / TMAX * (Math.log(dMax) - Math.log(dMin)))
  function reportZoom() { if (o.onFollowZoom && fstate) o.onFollowZoom(distToT(zoomTarget)) }

  function otherSlot(key) {
    let s = others.get(key)
    if (!s) {
      s = { key, modelId: null, frame: null, frameSig: '', inst: null, mount: null, req: 0, label: null, dot: null, rel: new THREE.Vector3(), q: new THREE.Quaternion(), name: '', occ: false,
        los: false, anchorS: new THREE.Vector3(), hasAnchor: false }
      others.set(key, s)
      otherArr.push(s)
    }
    return s
  }
  function dropOther(s) {
    s.req++
    if (s.mount) othersRoot.remove(s.mount.holder)
    if (s.inst) s.inst.release()
    if (s.label) { othersRoot.remove(s.label); disposeSprite(s.label) }
    if (s.dot) { othersRoot.remove(s.dot); s.dot.material.dispose() }
    others.delete(s.key)
    const i = otherArr.indexOf(s); if (i >= 0) otherArr.splice(i, 1)
  }
  function dropAllOthers() { while (otherArr.length) dropOther(otherArr[otherArr.length - 1]) }
  const _o0 = new THREE.Vector3()
  function setOthers(list) {
    const seen = new Set()
    for (const it of (Array.isArray(list) ? list.slice(0, MAX_OTHERS) : [])) {
      if (!it || !it.key || !it.relL) continue
      seen.add(it.key)
      const s = otherSlot(it.key)
      s.rel.set(it.relL[0], it.relL[1], it.relL[2])
      // ISL 通视：主星 → 邻星的连线不擦过 100 km 高度以下（拍级量：相对位置每拍才变）
      s.los = !segHitsSphere(_o0, s.rel, earthL, ISL_GRAZE_M)
      if (Array.isArray(it.anchorS)) { s.anchorS.set(it.anchorS[0], it.anchorS[1], it.anchorS[2]); s.hasAnchor = true } else s.hasAnchor = false
      const qb = it.qB2L || Q_BODY2L_NADIR
      s.q.set(qb[0], qb[1], qb[2], qb[3])
      trackSun(s.mount, s.q, sunL)
      if (!s.dot) {
        s.dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(), color: 0xdfe8f5, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }))
        s.dot.renderOrder = 33
        othersRoot.add(s.dot)
      }
      const nm = String(it.name || '')
      if (nm !== s.name) {
        s.name = nm
        if (s.label) { othersRoot.remove(s.label); disposeSprite(s.label); s.label = null }
        if (nm) { s.label = makeLabel(nm, '#dfe8f5', 12); othersRoot.add(s.label) }
      }
      const fsig = frameSig(it.frame)
      if ((it.modelId || null) !== s.modelId || fsig !== s.frameSig) {
        const sameModel = (it.modelId || null) === s.modelId
        s.modelId = it.modelId || null
        s.frame = it.frame || null; s.frameSig = fsig
        if (!sameModel) {
          if (s.mount) { othersRoot.remove(s.mount.holder); s.mount = null }
          if (s.inst) { s.inst.release(); s.inst = null }
        }
        loadOther(s)
      }
    }
    for (let i = otherArr.length - 1; i >= 0; i--) if (!seen.has(otherArr[i].key)) dropOther(otherArr[i])
  }
  function loadOther(s) {
    const req = ++s.req
    if (!s.modelId || gpuWeak) return
    source.acquire(s.modelId, 'lod2', null).then(async (inst) => {
      const stale = () => disposed || req !== s.req || !others.has(s.key)
      if (stale()) { if (inst) inst.release(); return }
      if (!inst) return
      const mount = mountInstance(inst, s.frame)
      await warmUp(mount.holder, localScene, true, !!studioShadows)
      if (stale()) { inst.release(); return }
      if (s.mount) othersRoot.remove(s.mount.holder)
      if (s.inst) s.inst.release()
      s.inst = inst
      s.mount = mount
      trackSun(s.mount, s.q, sunL)
      if (gpu) gpu.track(s.mount.holder)
      othersRoot.add(s.mount.holder)
    })
  }
  // 某个模型刚下载好：当时没有任何可用档、只画了点的槽位重取一次
  source.onReady((id) => {
    if (disposed) return
    for (let i = 0; i < iconArr.length; i++) { const s = iconArr[i]; if (s.modelId === id && !s.inst) loadIcon(s) }
    for (let i = 0; i < otherArr.length; i++) { const s = otherArr[i]; if (s.modelId === id && !s.inst) loadOther(s) }
    if (fslot && fslot.modelId === id && !fslot.inst && fstate) loadFollow(id, lod, lodBudget, fslot.frame)
  })

  /**
   * 元数据刷新（DESIGN §6.3：工作台改了本体轴 / 缩放 / 关节 → models:changed {type:'meta', id}；导入 / 移除 / 远端清单更新 → 'manifest'）。
   * 丢掉该 id（缺省：全部）的元数据缓存，重取后与旧的比「挂架要用的那几项」（frame / 缩放 / 关节 / 太阳翼组）：
   * 变了的模型把在用的图标 / 邻星 / 主星原位重挂（旧实例照画到新的就绪，透明度不重来）；没变的一概不动。
   */
  // lod0 的 sha256 也进签名（P3 契约 §11-4）：装配件在工作台改尺寸后重存（同 id 换 glb），frame / 缩放 / 关节 / 太阳翼组都可能不变，
  // 不比它的话 3D 页一直挂着旧几何；glb 的 models:// 地址按 sha 取，换了 sha 重挂就是新文件
  const mountSig = (m) => JSON.stringify(m ? [m.frame || null, (m.units && m.units.scaleToMeters) || 1, m.articulations || null, m.solarPanelGroups || null,
    m.files && m.files.lod0 ? m.files.lod0.sha256 || null : null] : null)
  async function refreshModel(id) {
    if (disposed) return
    const inUse = new Set()
    for (let i = 0; i < iconArr.length; i++) if (iconArr[i].modelId) inUse.add(iconArr[i].modelId)
    for (let i = 0; i < otherArr.length; i++) if (otherArr[i].modelId) inUse.add(otherArr[i].modelId)
    if (fslot && fslot.modelId) inUse.add(fslot.modelId)
    const ids = [...inUse].filter((x) => !x.startsWith('param:') && (!id || x === id))
    const olds = ids.map((x) => source.peekMeta(x))
    source.invalidateMeta(id || null)
    await Promise.all(ids.map(async (mid, k) => {
      let before = null, after = null
      try { before = olds[k] ? await olds[k] : null } catch { before = null }
      try { after = await source.meta(mid) } catch { after = null }
      if (disposed || mountSig(before) === mountSig(after)) return
      for (let i = 0; i < iconArr.length; i++) { const s = iconArr[i]; if (s.modelId === mid) loadIcon(s, true) }
      for (let i = 0; i < otherArr.length; i++) { const s = otherArr[i]; if (s.modelId === mid) loadOther(s) }
      if (fslot && fslot.modelId === mid && fslot.go) fslot.go()
    }))
  }

  /**
   * 进入 / 刷新 / 退出跟随。state：{ key, modelId, frame?:{q,t}, anchor:[3]（场景单位）, qL2S:[4], qB2L?:[4], velL?:[3]（L 系单位矢量），
   *   eclipse:0..1, altKm, others:[{key, modelId, frame?, relL:[3]（米）, qB2L?:[4], anchorS?:[3], name}],
   *   stations?:[{name, dirL:[3]（L 系单位矢量，主星 → 站）}]（HUD「地球站」，页面按仰角 ≥ 0° 筛、近者优先），
   *   mounts?:[{name, posBody:[3]（米）, dir:[3]（本体系视轴）, fovDeg?}]（HUD「挂点」，绑定表里这颗星的挂点） } | null
   */
  function follow(state) {
    if (!state) {
      if (!fstate) return
      fstate = null
      releaseFollowInst()
      dropAllOthers()
      modelOff = false
      if (mark) mark.visible = false
      return
    }
    const entering = !fstate || fstate.key !== state.key
    const prevModel = fstate ? fstate.modelId : undefined
    const prevFrame = fstate ? frameSig(fstate.frame) : ''
    fstate = state
    anchor.set(state.anchor[0], state.anchor[1], state.anchor[2])
    qL2S.set(state.qL2S[0], state.qL2S[1], state.qL2S[2], state.qL2S[3]).normalize()
    qS2L.copy(qL2S).invert()
    const qb = state.qB2L || Q_BODY2L_NADIR
    qB2L.set(qb[0], qb[1], qb[2], qb[3])
    followRoot.quaternion.copy(qB2L)
    // HUD 标签是按语言烘进贴图的：界面语言换过就整份拆掉，下一帧 ensureFollowRig 按新语言重建
    if (hud && hud.lang !== curLang()) { localScene.remove(hud.group); hud.dispose(); hud = null }
    if (hud) hud.body.quaternion.copy(qB2L)
    sunL.copy(sunS).applyQuaternion(qS2L)
    if (state.velL) velL.set(state.velL[0], state.velL[1], state.velL[2]).normalize(); else velL.set(1, 0, 0)
    earthL.copy(anchor).multiplyScalar(-RE_M).applyQuaternion(qS2L)
    if (entering) {
      const prof = gpuWeak ? followProfile('low') : followProfile(getQuality().tier, getQuality())
      lod = prof.lod; lodDowngraded = null; lodBudget = prof.tris
      modelOff = false
      perf.acc = 0; perf.n = 0; perf.hold = 3; perf.slow = 0
      if (studio && studioShadows !== prof.shadows) { studio.dispose(); studio = null }
      studioShadows = prof.shadows
      userZoomed = false
      loadFollow(state.modelId, lod, lodBudget, state.frame)
      const r = followRadius()
      setFollowLimits(r)
      const d0 = Math.max(dMin, Math.min(dMax, r * 3.4))
      defaultCamDir(Number(state.altKm) || 500, camL.position).multiplyScalar(d0)
      camL.lookAt(0, 0, 0)
      zoomTarget = d0
      if (ctl) { ctl.target.set(0, 0, 0); ctl.update() }
    } else if (state.modelId !== prevModel || frameSig(state.frame) !== prevFrame) {
      modelOff = false
      loadFollow(state.modelId, lod, lodBudget, state.frame)
      if (!fslot || !fslot.mount) fitFollow()
    }
    if (fslot) trackSun(fslot.mount, qB2L, sunL)
    setOthers(state.others)
    if (studio) { if (sunLit) { studio.setSunDir(sunL); studio.setEclipse(state.eclipse) } tuneEarthshine() }   // 全亮时光向每帧按相机给（见 render）
  }
  /**
   * 进入跟随时的机位（从主星指向相机的单位方向，L 系）—— NASA Eyes 那种「受光面朝镜头、地球在背景里」的构图：
   *   俯仰：主星看地平线的俯角 δ = acos(R / (R + h))。低轨（δ ≈ 20°）相机抬到 δ + 4°，地平线略高于画面中线、地球铺满下半屏；
   *        高轨（GEO δ ≈ 81°）地球只有 ±8.7°，相机抬到 δ − 9.5°，地球盘心落在画面中心下方约 18°（42° 视场里整颗入画的下缘）。
   *   方位：太阳在相机身后偏 50°（3/4 受光，不正对着拍成平光）；两侧取偏向飞行反方向（−x̂）的那边 —— 看着星往前飞。
   *        太阳几乎在头顶 / 脚下（水平分量 < 0.2）时方位无所谓，取后方偏 +ẑ。
   *   例外：太阳远在水平面下而星在日照里（高轨夜侧）相机往下压、但留住地球临边（见 followCamDir）。
   */
  function defaultCamDir(altKm, out) { return followCamDir(altKm, sunL, out, !fstate || !(fstate.eclipse < 0.5)) }
  // 地球反照：主星脚下是昼半球才有（夜侧的「地球蓝」反射环境一并压下去）。
  // 夜侧留的底比物理值高（0.3 / 0.4 成，原 0.14 / 0.2）：背光面与地影里的星主要靠相机侧补光托起（见 FILL_LIT），这里再垫一点环境
  function tuneEarthshine() {
    if (!studio || !fstate) return
    const f = sunLit ? smooth(-0.35, 0.55, sunL.y) : 1   // 全亮（晨昏效果关）：按昼侧给满
    for (const l of studio.rig.children) if (l.isHemisphereLight) l.intensity = 0.35 * (0.3 + 0.7 * f)
    localScene.environmentIntensity = 0.55 * (0.4 + 0.6 * f)
  }

  function setFollowZoom(t) { if (!fstate) return; userZoomed = true; zoomTarget = tToDist(t); reportZoom() }

  const driver = {
    attach(el) {
      if (ctl) driver.detach()
      dom = el
      // ★ OrbitControls 的 connect / disconnect 会把画布的 touch-action 改成 'none' / ''（three r184 OrbitControls.js:527）。
      //   地球那套控件原本设的是 'none'：局部控件 dispose 后要写回进入前的值，不然触屏上单指拖地球会被浏览器当成滚动手势
      //   （pointercancel），第一次退出跟随后地球就拖不动了
      domTouch = el.style.touchAction
      ctl = new OrbitControls(camL, el)
      ctl.enableDamping = true
      ctl.dampingFactor = 0
      ctl.enablePan = false
      ctl.enableZoom = false
      ctl.rotateSpeed = 0.9
      ctl.minDistance = dMin; ctl.maxDistance = dMax
      ctl.target.set(0, 0, 0)
      ctl.addEventListener('start', onStart)
      ctl.addEventListener('end', onEnd)
      ctl.update()
    },
    detach() {
      if (ctl) {
        ctl.removeEventListener('start', onStart); ctl.removeEventListener('end', onEnd); ctl.dispose(); ctl = null
        if (dom) dom.style.touchAction = domTouch
      }
      dom = null; dragging = false
    },
    onWheel(e) {
      userZoomed = true
      const t1 = stepZoomT(distToT(zoomTarget), wheelNotches(e), wheelPct, TMAX)
      zoomTarget = tToDist(t1)
      reportZoom()
    },
    /** 每帧：局部相机（阻尼 / 缩放缓动）→ 推出地球相机位姿与 near / far */
    apply(camera, dt) {
      if (!fstate) return
      if (ctl) {
        const az0 = ctl.getAzimuthalAngle(), po0 = ctl.getPolarAngle()
        ctl.dampingFactor = dampingFor(dt, followTau)
        ctl.update()
        ctl.dampingFactor = 0
        camMovedL = Math.abs(ctl.getAzimuthalAngle() - az0) > 1e-7 || Math.abs(ctl.getPolarAngle() - po0) > 1e-7
      }
      // 缩放缓动的目标先夹进 [dMin, dMax]：控件每帧也按这对上下限夹距离，目标落在区间外就永远逼近不到、「还在缩放」恒真
      const d = camL.position.length()
      const zt = Math.max(dMin, Math.min(dMax, zoomTarget))
      zoomBusy = Math.abs(d - zt) > 1e-3 * Math.max(1, zt)
      if (zoomBusy) camL.position.setLength(d + (zt - d) * dampingFor(dt, ZOOM_TAU_MS / 1000))
      camL.updateMatrixWorld()
      // 地球相机：q_E = qL2S · q_camL；p_E = anchor + qL2S·p_camL / RE（JS 数值是 double，算完再落进 three）
      camera.quaternion.copy(qL2S).multiply(camL.quaternion)
      _v.copy(camL.position).applyQuaternion(qL2S).multiplyScalar(1 / RE_M)
      camera.position.copy(anchor).add(_v)
      // near：沿用 syncNear 的口径，再夹在「离地面 0.9 倍」以内（贴地的低轨星不把地球裁掉）；far 120 同地球场景
      const D = camera.position.length()
      const n = Math.max(1e-6, Math.min(Math.max(0.004, Math.min(0.1, (D - 1) * 0.4)), 0.9 * (D - 1)))
      if (Math.abs(camera.near - n) > 1e-9 || camera.far !== 120) { camera.near = n; camera.far = 120; camera.updateProjectionMatrix() }
      camera.updateMatrixWorld()
    }
  }
  function onStart() { dragging = true }
  function onEnd() { dragging = false }

  // ============================== 叠加层 ==============================
  let rendererReadyResolve = null
  const rendererReady = new Promise((res) => { rendererReadyResolve = res })
  function ensureRenderer(r) {
    if (renderer === r) return
    renderer = r
    if (rendererReadyResolve) { rendererReadyResolve(r); rendererReadyResolve = null }
    setMaterialAnisotropy(r)
    // 截下本 renderer 的释放闭包（开着阴影截全四类；哨兵是退化三角形，不改画面）
    const sm = r.shadowMap.enabled
    r.shadowMap.enabled = true
    gpu = createGpuReleaser(r)
    r.shadowMap.enabled = sm
    for (let i = 0; i < iconArr.length; i++) if (iconArr[i].mount) gpu.track(iconArr[i].mount.holder)
    if (fslot && fslot.mount) gpu.track(fslot.mount.holder)
    // 软件光栅判据（见 isSoftwareRenderer）：只在拿到 renderer 时判一次
    try {
      const gl = r.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      gpuWeak = isSoftwareRenderer(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    } catch { gpuWeak = false }
    if (gpuWeak) applyWeak()
  }
  // 软件光栅：已挂上的图标 / 主星 / 邻星模型全撤（图标回到点精灵、主星画回退标记）
  function applyWeak() {
    for (let i = 0; i < iconArr.length; i++) releaseIconInst(iconArr[i])
    if (fslot) { releaseFollowInst(); fitFollow() }
    for (let i = 0; i < otherArr.length; i++) { const s = otherArr[i]; s.req++; if (s.mount) othersRoot.remove(s.mount.holder); if (s.inst) s.inst.release(); s.inst = null; s.mount = null }
  }
  function ensureIconEnv() {
    if (iconEnv || !renderer) return
    const pm = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    iconEnv = pm.fromScene(room, 0.04)
    room.dispose(); pm.dispose()
    // 不挂 iconScene.environment：环境图逐材质挂（见 updateIcons 的地影段）
  }
  function ensureFollowRig() {
    if (!renderer) return
    if (!studio) {
      studio = createStudio(renderer, localScene, { mode: 'sun', shadows: !!studioShadows, shadowMapSize: 2048 })
      studio.setUp([0, 1, 0])
      studio.fit(_v.set(0, 0, 0), followRadius())
      studio.setSunDir(sunL)
      studio.setEclipse(sunLit && fstate ? fstate.eclipse : 1)
      tuneEarthshine()
    }
    if (!hud) { hud = createHud(lineMats); hud.body.quaternion.copy(qB2L); localScene.add(hud.group) }
    if (!mark) {
      mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: satMarkTexture(), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }))
      mark.renderOrder = 36
      mark.visible = false
      localScene.add(mark)
    }
  }

  const _lab = new THREE.Vector3()
  function updateFollow(dt, camera, w, h) {
    _vpW = w || 0; _vpH = h || 0
    camL.fov = camera.fov
    if (w && h && camL.aspect !== w / h) camL.aspect = w / h
    const d = camL.position.length()
    const r = followRadius()
    // 局部 near：跟距离走（深度精度），但不越过模型最近的那一面
    camL.near = Math.max(0.01, Math.min(d * 0.002, Math.max(0.01, (d - r) * 0.5)))
    camL.far = 6e5
    camL.updateProjectionMatrix()
    const labelK = 2 * Math.tan(camL.fov * Math.PI / 360) / Math.max(1, h)   // 1 CSS 像素 ↔ sizeAttenuation:false 精灵的 scale
    // 主星模型：逐档降级退到底（modelOff）就藏起来；没有可画的模型（绑定「无」/ 没缓存 / 失败 / 还在加载 / 软件光栅）画回退标记
    const hasModel = !!(fslot && fslot.mount) && !modelOff
    if (fslot && fslot.mount) fslot.mount.holder.visible = !modelOff
    if (mark) {
      mark.visible = !hasModel
      if (!hasModel) mark.scale.setScalar(MARK_PX * labelK)
    }
    let base = Math.max(1e-3, Math.min(r * 1.5, d * 0.3))
    if (hud) {
      hud.items.vel.dir.copy(velL)
      hud.items.sun.dir.copy(sunL)
      hud.setMounts(fstate.mounts || null)
      base = hud.update(hudOn, r, d, labelK)
      // 可见地球站方向：页面每拍给（L 系单位矢量 + 站名），最多 ES_MAX 支；长度比速度箭头再长一截，字标不叠
      const sts = fstate.stations
      let ne = 0
      if (hudOn.es && Array.isArray(sts)) {
        const n = Math.min(ES_MAX, sts.length)
        for (let i = 0; i < n; i++) { const st = sts[i]; if (st && st.dirL) hud.setEs(ne++, st.dirL, st.name || '', base * 2.0, labelK) }
      }
      hud.hideEsFrom(ne)
      // 挂点名按屏幕避让（对地挂点视轴几乎平行，斜侧机位下沿射线错开的长度被透视压扁）
      hudMoved = hudOn.mounts ? hud.declutter(camL, w, h) : 0
    }
    // 其他星：真实相对位置；地球挡住的藏起来（线段 相机→星 穿过地球球面）；亚像素时画点 + 名字
    const wpp0 = labelK
    let ni = 0
    for (let i = 0; i < otherArr.length; i++) {
      const s = otherArr[i]
      _v.copy(s.rel).sub(camL.position)
      const dist = _v.length()
      s.occ = segHitsSphere(camL.position, s.rel, earthL, RE_M)
      const pxR = s.mount ? s.mount.radius / Math.max(1e-6, dist * wpp0) : 0
      if (s.mount) {
        s.mount.holder.visible = !s.occ && pxR > 0.35
        s.mount.holder.position.copy(s.rel)
        s.mount.holder.quaternion.copy(s.q)
      }
      if (s.dot) {
        s.dot.position.copy(s.rel)
        const dpx = Math.max(0, 6 - pxR * 2)
        s.dot.visible = !s.occ && dpx > 0.5
        s.dot.scale.setScalar(dpx * labelK)
      }
      if (s.label) {
        s.label.visible = !s.occ
        s.label.position.copy(s.rel)
        const hh = s.label.userData.pxH * labelK
        s.label.scale.set(hh * s.label.userData.ar, hh, 1)
      }
      // ISL：与主星通视（连线不擦过 100 km 以下）的邻星连一根实线
      if (hud && hudOn.isl && s.los) hud.setIsl(ni++, s.rel)
    }
    if (hud) hud.hideIslFrom(ni)
    // 太阳被主星挡住多少：局部相机沿太阳方向的射线到包围球心的最近距离（宇宙空间 · 太阳开着时乘进眩光）
    {
      const t = -camL.position.dot(sunL)
      const md = t > 0 ? _lab.copy(sunL).multiplyScalar(t).add(camL.position).length() : camL.position.length()
      sunVisModel = hasModel ? 0.25 + 0.75 * smooth(r * 0.35, r * 0.9, md) : 1
    }
    // 自动降档（任务书 §5.9：帧率跌破上限 1 s 自动降一档 LOD，带迟滞 —— 降了本次跟随不回升）。
    // 链：lod0 → lod1 → lod2（参数化没有档）→ 只画标记。最后一步更严：平均帧时超过上限的 2.5 倍、连续 3 秒才撤模型
    //（真到这一步的是 GPU 跟不上，不是一两帧抖动）。
    // ★ 窗口藏起来时 rAF 被压到 ~1 Hz、dt 被钳在 0.1 s —— 那不是 GPU 慢，不许据此降档（每秒不足 10 帧的窗口不算）
    const hidden = typeof document !== 'undefined' && document.hidden
    if (dt > 0 && dt < 0.099 && !hidden && fslot && fslot.inst && !modelOff) {
      perf.acc += dt; perf.n++
      if (perf.acc >= 1) {
        const avg = perf.acc / perf.n
        const q = getQuality()
        const cap = q && q.fps > 0 ? q.fps : 60
        const bottom = fslot.lod === 'lod2' || fslot.lod === 'param'
        if (perf.hold > 0 || perf.n < 10) { if (perf.hold > 0) perf.hold-- }
        else if (!bottom && avg > 1.5 / cap) {
          lodDowngraded = fslot.lod
          lod = LOD_DOWN[fslot.lod] || 'lod2'
          loadFollow(fstate.modelId, lod, lodBudget, fstate.frame)
          perf.hold = 3; perf.slow = 0
        } else if (bottom) {
          perf.slow = avg > 2.5 / cap ? perf.slow + 1 : 0
          if (perf.slow >= 3) { lodDowngraded = fslot.lod; modelOff = true }
        }
        perf.acc = 0; perf.n = 0
      }
    }
  }
  function segHitsSphere(A, B, Cn, R) {
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z
    const fx0 = A.x - Cn.x, fy = A.y - Cn.y, fz = A.z - Cn.z
    const a = dx * dx + dy * dy + dz * dz
    const b = 2 * (fx0 * dx + fy * dy + fz * dz)
    const c = fx0 * fx0 + fy * fy + fz * fz - R * R
    const disc = b * b - 4 * a * c
    if (disc <= 0 || a <= 0) return false
    const sq = Math.sqrt(disc)
    const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a)
    return (t1 > 0 && t1 < 1) || (t2 > 0 && t2 < 1)
  }

  let lastMask = false
  const overlay = {
    update(dt, camera, w, h) {
      if (disposed) return
      lastW = w; lastH = h
      if (w && h) { const lm = lineMats.list; for (let i = 0; i < lm.length; i++) lm[i].resolution.set(w, h) }
      const busyIcons = updateIcons(dt, camera, h)
      overlay._busyIcons = busyIcons
      if (fstate) updateFollow(dt, camera, w, h)
      // 点精灵遮罩开关跟着「有没有图标 / 跟随邻星在」走（没有了就把原材质换回来 —— 关掉后球面逐像素回到原样）。
      // 跟随时 500 km 内的邻星由局部那一趟画（模型或圆点 + 名字），它在星座点云里那个点要藏掉，不然同一颗星画两遍
      const want = icons.size > 0 || (!!fstate && others.size > 0)
      if (want !== lastMask) { lastMask = want; maskOn = want; if (o.onMaskChange) o.onMaskChange(want) }
      if (dt > 0) { const t = performance.now(); if (perf.lastT) perf.frameMs = perf.frameMs * 0.9 + (t - perf.lastT) * 0.1; perf.lastT = t }
    },
    isEmpty() { return disposed || (!fstate && icons.size === 0) },
    busy() { return !!(overlay._busyIcons || (fstate && (dragging || camMovedL || zoomBusy))) },
    fillDotMask(arr) {
      let n = 0
      if (!maskOn) return 0
      for (let i = 0; i < iconArr.length; i++) {
        const s = iconArr[i]
        if (n >= MAX_ICONS) break
        if (s.dotW >= 0.999) continue
        arr[n * 4] = s.anchor.x; arr[n * 4 + 1] = s.anchor.y; arr[n * 4 + 2] = s.anchor.z; arr[n * 4 + 3] = s.dotW
        n++
      }
      if (fstate) {
        for (let i = 0; i < otherArr.length; i++) {
          const s = otherArr[i]
          if (n >= MAX_ICONS) break
          if (!s.hasAnchor) continue
          arr[n * 4] = s.anchorS.x; arr[n * 4 + 1] = s.anchorS.y; arr[n * 4 + 2] = s.anchorS.z; arr[n * 4 + 3] = 0
          n++
        }
      }
      return n
    },
    /** 跟随时主星模型挡太阳的系数（0..1）；不跟随 = 1。scene 乘进宇宙空间的眩光 */
    sunVisibility() { return fstate ? sunVisModel : 1 },
    render(r, camera, w, h) {
      ensureRenderer(r)
      const tm = r.toneMapping, te = r.toneMappingExposure, ac = r.autoClear, sm = r.shadowMap.enabled, st = r.shadowMap.type
      try {
        r.autoClear = false
        if (fstate) {
          ensureFollowRig()
          if (studio && !sunLit) studio.setSunDir(_hl.copy(HEADLIGHT_C).applyQuaternion(camL.quaternion))   // 全亮：光跟着跟随相机（L 系）
          // 按太阳打光时的相机侧补光：日照里 FILL_LIT，进地影按地影因子升到 FILL_ECL（全亮时主光本身就是头灯，不补）
          followFill.intensity = sunLit ? FILL_LIT + (FILL_ECL - FILL_LIT) * (1 - Math.max(0, Math.min(1, fstate.eclipse ?? 1))) : 0
          if (sunLit) { followFill.position.copy(_hl.copy(HEADLIGHT_C).applyQuaternion(camL.quaternion)).multiplyScalar(100); followFill.target.position.set(0, 0, 0) }
          r.clearDepth()
          r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0
          r.shadowMap.enabled = !!studioShadows; r.shadowMap.type = THREE.PCFShadowMap
          r.render(localScene, camL)
          r.toneMapping = tm; r.toneMappingExposure = te; r.shadowMap.enabled = sm; r.shadowMap.type = st
        } else if (iconsVisible()) {
          ensureIconEnv()
          iconSun.position.copy(sunLit ? sunS : _hl.copy(HEADLIGHT_C).applyQuaternion(camera.quaternion)).multiplyScalar(10)
          iconSun.target.position.set(0, 0, 0)
          // 相机侧补光（晨昏效果开时）：背光面托到看得清；地影里的星另按材质压到五成（见 ICON_ECL_FLOOR），补光一起跟着暗
          iconFill.intensity = sunLit ? FILL_LIT : 0
          if (sunLit) { iconFill.position.copy(_hl.copy(HEADLIGHT_C).applyQuaternion(camera.quaternion)).multiplyScalar(10); iconFill.target.position.set(0, 0, 0) }
          r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0
          r.clearDepth()   // 图标是屏幕定尺的符号：不与地球比深度（否则放大的低轨图标下半截扎进球面被裁掉）；图标之间的遮挡照常
          r.render(iconScene, camera)
        }
      } finally {
        r.toneMapping = tm; r.toneMappingExposure = te; r.autoClear = ac; r.shadowMap.enabled = sm; r.shadowMap.type = st
      }
    },
    dispose() { api.dispose() }
  }

  const api = {
    overlay,
    /** 模型来源（只读引用）：标记实体层（entityLayer.js）共用同一份模型缓存 / 元数据缓存 / 就绪通知 */
    source,
    followDriver: () => driver,
    setIcons,
    /** 图标总开关与大小（focusStyle.modelOn / modelPx） */
    setIconStyle(s) {
      if (!s) return
      if (s.on != null) iconsOn = !!s.on
      if (Number(s.px) > 0) { iconPx = Math.max(8, Math.min(256, Number(s.px))) }   // 与逐星 iconPx（schema 8–256）同一范围
    },
    /** 每拍：太阳方向（场景轴单位矢量）。第二参（GMST）原给跟随星空用，星空已归宇宙空间，留着只为调用口不变 */
    setSun(v) {
      if (v) sunS.set(v[0], v[1], v[2]).normalize()
      if (fstate) { sunL.copy(sunS).applyQuaternion(qS2L); if (studio) { if (sunLit) studio.setSunDir(sunL); tuneEarthshine() } }
    },
    /** 晨昏效果（地图设置 · 宇宙空间）：true = 按太阳打光 + 地影压暗；false = 全亮（相机头灯、不按地影压暗）。页面每拍都调，没变就不动 */
    setSunLit(on) {
      on = !!on
      if (on === sunLit) return
      sunLit = on
      for (let i = 0; i < iconArr.length; i++) iconArr[i].lastEcl = -1   // 下一帧按新口径重设各图标材质的地影压暗
      if (studio) {
        if (on) studio.setSunDir(sunL)   // 全亮时的光向每帧按相机给（见 render），切回按太阳
        studio.setEclipse(on && fstate ? fstate.eclipse : 1)
        tuneEarthshine()
      }
    },
    follow,
    isFollowing: () => !!fstate,
    followKey: () => (fstate ? fstate.key : null),
    setHud(h) { if (h) hudOn = { bodyAxes: !!h.bodyAxes, lvlh: !!h.lvlh, nadir: !!h.nadir, velocity: !!h.velocity, sun: !!h.sun, isl: !!h.isl, es: !!h.es, mounts: !!h.mounts } },
    /** 模型元数据变了（工作台存盘 / 清单更新）：见 refreshModel；id 缺省 = 全部在用的模型 */
    refreshModel,
    setDragDamping(p) { followTau = tauFor(p) },
    setWheelStep(p) { if (Number.isFinite(p)) wheelPct = Math.max(1, Math.min(20, Math.round(p))) },
    setFollowZoom,
    getFollowZoom: () => distToT(zoomTarget),
    /** 跟随视角直切（不做相机飞行）：dir = 从主星指向相机的方向（L 系），dist = 距离（米，夹在 1.2 倍包围半径 … 5 km） */
    setFollowCamera(v) {
      if (!fstate || !v) return
      if (Array.isArray(v.dir)) { _v.set(v.dir[0], v.dir[1], v.dir[2]); if (_v.lengthSq() > 0) camL.position.copy(_v.normalize()).multiplyScalar(camL.position.length() || zoomTarget) }
      if (Number(v.dist) > 0) { userZoomed = true; zoomTarget = Math.max(dMin, Math.min(dMax, Number(v.dist))); camL.position.setLength(zoomTarget) }
      if (ctl) { ctl.target.set(0, 0, 0); ctl.update() } else camL.lookAt(0, 0, 0)
      reportZoom()
    },
    /** 调试 / 验证台读数 */
    stats() {
      let icVis = 0
      for (const s of iconArr) if (s.visible) icVis++
      let isl = 0
      for (const s of otherArr) if (s.los) isl++
      return {
        icons: icons.size, iconsVisible: icVis, following: !!fstate, lod: fslot ? (fslot.inst ? fslot.inst.lod : 'loading') : null, lodTarget: fslot ? fslot.lod : null,
        lodDowngradedFrom: lodDowngraded, modelOff, marker: !!(mark && mark.visible), gpuWeak, followRadiusM: followRadius(), others: others.size, islLos: isl,
        stations: fstate && Array.isArray(fstate.stations) ? fstate.stations.length : 0, zoomBusy, dMin: +dMin.toFixed(3),
        followBox: fslot && fslot.mount ? fslot.mount.box : null, hudLang: hud ? hud.lang : null,
        frameMs: +perf.frameMs.toFixed(2), camDistM: +camL.position.length().toFixed(2),
        // 二期读数：主星本体 → L 的四元数、太阳翼关节转角（相对静止位姿，度）、HUD 挂点支数
        qB2L: [qB2L.x, qB2L.y, qB2L.z, qB2L.w], sunArt: fslot && fslot.mount && fslot.mount.sun ? fslot.mount.sun.angles() : null,
        hudMounts: hud ? hud.mountCount() : 0, hudLabelMoved: hudMoved, hudDeclutterRuns: hud ? hud.declutterRuns() : 0, vp: [_vpW, _vpH],
        hudMountRects: hud && hudOn.mounts ? hud.mountLabelRects(camL, _vpW, _vpH) : [],
        sunLit, followLight: studio ? { dir: studio.rig.children.filter((l) => l.isDirectionalLight && l.visible).map((l) => l.position.clone().sub(l.target.position).normalize().toArray().map((v) => +v.toFixed(4))) } : null
      }
    },
    /** 验证台用：本机是真 GPU 时模拟软件光栅那条回退路（判据本身由单测验） */
    _simulateWeakGpu(v) {
      gpuWeak = !!v
      if (gpuWeak) { applyWeak(); return }
      for (let i = 0; i < iconArr.length; i++) { const s = iconArr[i]; if (s.modelId && !s.inst) loadIcon(s) }
      for (let i = 0; i < otherArr.length; i++) { const s = otherArr[i]; if (s.modelId && !s.inst) loadOther(s) }
      if (fstate && !fslot) loadFollow(fstate.modelId, lod, lodBudget, fstate.frame)
    },
    /** 验证台用：局部相机（只读）、太阳在 L 系的方向 */
    _localCamera: () => camL,
    _sunL: () => [sunL.x, sunL.y, sunL.z],
    dispose() {
      if (disposed) return
      disposed = true
      follow(null)
      driver.detach()
      for (const s of iconArr) releaseIconInst(s)
      icons.clear(); iconArr.length = 0
      if (hud) { localScene.remove(hud.group); hud.dispose(); hud = null }
      if (mark) { localScene.remove(mark); mark.material.dispose(); mark = null }   // 贴图是模块级共享件，不随层释放
      if (studio) { studio.dispose(); studio = null }
      if (iconEnv) { iconEnv.dispose(); iconEnv = null; iconScene.environment = null }
      iconSun.dispose(); iconAmb.dispose(); iconFill.dispose(); followFill.dispose()
      if (gpu) gpu.releaseAll()
      source.dispose()
      lineMats.clear()
    }
  }
  return api
}
