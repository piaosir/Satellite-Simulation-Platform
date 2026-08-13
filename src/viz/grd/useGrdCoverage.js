// 覆盖图（GRD）逻辑 —— SATSOFT 模型：卫星 → 天线（命名覆盖）。支持多选卫星/天线。
// 选中的天线各成一层渲染到星座3D 的 scene/flat（独立图层）：所有选中天线画等值线；
// 当前聚焦(active)天线额外画分带填充。计算核心 src/viz/grd/{parse,coverage,colormap}.js。
import { ref, reactive, watch, nextTick } from 'vue'
import { parseGrd } from './parse.js'
import { antennaBasis, antennaBasisEcef, beamBasisFrom, dirAzElAbout, dirToAzEl, azElGround, surfaceAzEl, projectGrid, fieldDb, bandGeometry, stitchLoops, dLon, loopPointAtFraction, loopLabelAnchor, nearestFractionOnLoop } from './coverage.js'
import { boresightShellPoint } from './shellProj.js'
import { schemeColorsRGB, rgbCss, cssRgb } from './colormap.js'
import { RS_GEO, A, geodeticToEcef, geocentricToEcef, isoElevationContourAt } from '../wgs84.js'
import { effective as displayQuality } from '../../stores/displayQuality.js'
import { appAlert } from '../../stores/alert.js'   // 应用内提示，替代会夺焦点的原生 alert

const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

const H = RS_GEO - A
const GEO_ALT = 35786              // GEO 轨道高度 km（预置星默认）：NASA 标称值（22,236 mi）
// 仰角线配色调色板（卫星属性）：新建/预置星按序分配，可逐星改色
const SAT_PALETTE = ['#66ddff', '#ffd24a', '#7cff8a', '#ff6fae', '#c78bff', '#ff9a5a', '#5ad1ff', '#ff5a5a']

const wrap180 = (x) => ((x % 360) + 540) % 360 - 180
// 合成 GRD 文本（含中文表头）→ latin1 字节流管线：导入 GRD 全程按 latin1 字节串收发（open/save/raw
// 均 latin1，导出时 toBytes 逐字符取低 8 位），字节保真。而合成文本是真正的 Unicode 串（表头有中文/
// 全角字符），直接交 latin1 save 会把多字节字符截成单字节乱码——导出的 .grd 表头即被写坏（数值区为
// ASCII 不受影响，但文件被污染）。此处先编码为 UTF-8 字节、以 latin1 字符串承载，使其符合管线的
// 「latin1 字节串」约定：存盘/读回/导出全程字节保真，落盘文件即标准 UTF-8 .grd。
function utf8BytesAsLatin1(s) {
  const b = new TextEncoder().encode(String(s == null ? '' : s))
  let o = ''
  for (let i = 0; i < b.length; i += 8192) o += String.fromCharCode.apply(null, b.subarray(i, i + 8192))
  return o
}
// 凸包（Andrew monotone chain），输入 [[x,y]...]，返回 CCW 顶点环（<3 点原样返回）。
function convexHullCCW(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const crs = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = []
  for (const q of p) { while (lo.length >= 2 && crs(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
  const up = []
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && crs(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q) }
  lo.pop(); up.pop()
  return lo.concat(up)   // CCW
}
// 卫星可见地平弧（0°仰角线）的凸包，u=lon−satLon 解缠空间、CCW，供 bandGeometry 沿地平平滑裁剪覆盖填充。
// 只随卫星位置变 → 缓存到缓存条目 c（拖拽指向不动卫星位置，命中缓存）。失败返回 null（bandGeometry 回退半平面裁）。
function satHull(c) {
  const lon = c.meta.satLon, lat = c.meta.satLat || 0, alt = c.meta.satAlt
  const key = lon + ',' + lat + ',' + alt
  if (c._hull && c._hull.key === key) return c._hull.hull
  let hull = null
  // 采样点数 = 地平弧凸包顶点数：越地平的填充三角形按 clipToHull 裁到此环，环越密 → 每个碎多边形顶点越多、
  // Canvas2D 填充 tessellation 越贵。80 点在外缘平滑度与填充成本间折中（比原 120 点省约 1.5×，外缘无肉眼可见棱角）。
  const arc = isoElevationContourAt(geodeticToEcef(lon, lat, alt), 0, 80)
  if (arc && arc.length >= 3) {
    const ring = convexHullCCW(arc.map((p) => [wrap180(p[0] - lon), p[1]]))
    if (ring.length >= 3) hull = { ring, satLon: lon }
  }
  c._hull = { key, hull }
  return hull
}

// hooks.getTargetEcef(id) → 目标星当前 ECEF（km）或 null：对星指向（boreType='sat'）用。
// 由宿主页注入——星历/时间轴都在页面手里，本模块不自己碰 SGP4。
export function useGrdCoverage(getScene, getFlat, isFlat = () => false, hooks = {}) {
  // 卫星树（唯一真相）：预置星(index) / 自定义星 / 星座关联星 共用同一数组。
  // 每个节点 = { folder, satName, kind:'preset'|'custom'|'linked', lon, lat, altKm, noradId,
  //   els, elevColor, elevShow,  antennas:[...] }。仰角线是卫星属性，天线挂在卫星下。
  const sats = ref([])              // 卫星节点数组
  const expanded = ref({})          // folder → 是否展开
  const selected = ref([])          // 已选天线 key 列表（folder|name）
  const active = ref('')            // 聚焦天线 key（设置/填充对象）
  const loading = ref(false)
  let loaded = false
  const cache = new Map()           // key → { meta, P1, P2, proj }
  // 数值标签拖拽用（声明前置，供 buildLayer/buildBeamLayer 捕获引用；逻辑见文件后段 setDragLabel/labelDrag）
  let _dragLabels = []              // 聚焦天线当前可拖标签 [{ levelIdx, loop, anchor }]（recompute 按 showVal 捕获）
  let _dragCapture = null           // 捕获缓冲：仅在构建聚焦天线层期间非空
  // 已存档但尚未加载到 cache 的天线设置（key → cfg）：恢复时从存档灌入，天线一经 ensureLoaded 即套用并移出。
  // 作用：清除绘图(selected 清空)/未绘制的天线，其设置依旧随 getState 回存到本地，不丢失（后续改数据库的过渡形态）。
  const pendingCfgs = new Map()

  const STEP = 1   // 电平间隔（固定 1 dB，用户不可见）
  // 默认 5 档：相对峰值 −1..−5；绝对模式（默认）下换算为 peakDb + (−1..−5) 的绝对值（无 peak 时退回相对数值）。
  // jet 配色按值自动分配（填充色与线色默认同色，可分别改）。
  function defaultLevels(peakDb) {
    const abs = Number.isFinite(peakDb)
    const lv = [-1, -2, -3, -4, -5].map((v) => ({ v: abs ? +(peakDb + v).toFixed(2) : v, name: '', labelT: null, color: '', lineColor: '', locked: false, lineSet: false }))
    recolorList(lv); return lv
  }
  // 按值升序分配 jet 色（外圈冷、内圈热）。locked 标记「用户手动配过色」的档：整档锁定，填充与线色
  // 都不再被 jet 重配（记忆到用户下次再改，增删档不抹手动色）。lineSet 表示线色已单独设定（改填充时不跟随）。
  function recolorList(lv) {
    const n = lv.length; if (!n) return
    const cols = schemeColorsRGB('jet', n)
    lv.map((_, i) => i).sort((a, b) => lv[a].v - lv[b].v).forEach((idx, rank) => {
      if (lv[idx].locked) return
      const css = rgbCss(cols[rank]); lv[idx].color = css; lv[idx].lineColor = css
    })
  }

  const s = reactive({
    fill: false, alpha: 0.78, line: true, lineWidth: 1.6,   // 默认不填充（多天线/多星叠加时按需逐个开启）
    ctype: 'abs', levels: defaultLevels(),
    pol: 'RSS', gainOffset: 0, pathLoss: 'none',
    boreType: 'azel', boreLon: null, boreLat: 0, boreAz: 0, boreEl: 0, yaw: 0,
    boreSat: null, boreSatName: '',   // 对星指向（boreType='sat'/'satoff'）的目标星身份 + 显示名
    boreOffAz: 0, boreOffEl: 0,       // 对星跟踪 + 偏置（boreType='satoff'）：相对目标星方向的 az/el 偏置
    borePtLon: null, borePtLat: 0, borePtAlt: 550,   // 空间点指向（boreType='point'）：地心经纬度 + 高度 km
    boreLock: true,     // 指向锁定（默认开）：卫星移动时 boresight 钉在地面目标不动（天线重新指向）；关则随星下点平移

    beamsToPlot: [0],   // 多波束 GRD：要绘制的波束序号（SATSOFT「Beams To Plot」多选；共用本天线同一套电平/极化设置）
    beamNames: {},      // 波束序号 → 自定义波束名（空=用默认「波束 N」）。地图标注与选波束列表均用此名，不再用天线名+波束名
    // 全局显示选项（与 GXT 一致；不随聚焦天线切换，对所有选中天线生效）：天线名 / 波束中心 / 波束中心峰值 / 数值标签
    // 默认四项全关：新天线导入即为干净地图（无天线名/中心点/峰值/数值标注），需要时再逐项开启
    showName: false, nameSize: 16, showBore: false, boreSize: 0.5, showRay: false, showPeak: false, peakSize: 5, showVal: false, valSize: 12,
    // 波束射线样式（对地＝卫星↔波束中心连线，对星＝沿视轴射出的那条线；两视图同一套值）
    rayColor: '#ffb14a', rayWidth: 1.2, rayOpacity: 0.75
  })
  // 天线姿态基底，两大类五种指向来源：
  //  【对地指向】geo  —— 地表目标点
  //             azel —— 相对星下天底的固定 Az/El 偏置（可指深空）
  //  【对星指向】sat    —— 直指另一颗卫星（星间链路）。目标位置由宿主按【当前时间轴时刻】解算，故 basis 随时间走。
  //                        这是能表达「低轨打 GSO」这类【反天底】指向的模式：geo 只能瞄地表点，azel 的 El
  //                        虽然数学上能超过地平、但那是相对天底的固定偏置，不跟着目标星走。
  //             satoff —— sat 再叠一层相对目标星方向的 az/el 偏置（瞄目标星旁边某个方向；偏置 0 时严格等于 sat）
  //             point  —— 空间中一个【地心经纬度 + 高度】的定点（轨道壳层上的点）。与 geo 同为「钉住不动的
  //                        目标点、星动天线重指」，只是点不在地表——不依赖任何在场卫星，可自由拖。
  // 目标星解析不到（未在场 / 星历缺失）时退回天底，不让整层覆盖凭空消失。
  // ★ 公式本体在 coverage.beamBasisFrom（纯函数）：时段扫描要按任意时刻重建基底，两条路共用一份口径。
  //   这里只负责把「目标星身份 → 当前 ECEF」这一步经 hooks 解出来喂进去。
  function beamBasis(meta, st) {
    const T = (st.boreType === 'sat' || st.boreType === 'satoff') && st.boreSat && hooks.getTargetEcef
      ? hooks.getTargetEcef(st.boreSat) : null
    return beamBasisFrom(meta, st, T)
  }
  // 目标星当前是否解析得到（面板据此提示「目标星不在场」）
  const boreSatResolved = (st) => !!(st && (st.boreType === 'sat' || st.boreType === 'satoff') && st.boreSat && hooks.getTargetEcef && hooks.getTargetEcef(st.boreSat))
  // 当前聚焦天线 boresight 的地表落点（深空/对星/空间点则 null）：供 tip 显示与 geo↔azel 互换
  function boreGround() {
    const m = antMeta(); if (!m) return null
    if (s.boreType === 'sat' || s.boreType === 'satoff' || s.boreType === 'point') return null
    if (s.boreType === 'azel') return azElGround(m.satLon, m.satLat || 0, m.satAlt, s.boreAz || 0, s.boreEl || 0)
    return { lon: s.boreLon == null ? m.satLon : s.boreLon, lat: s.boreLat || 0 }
  }
  // 当前聚焦天线的 boresight 方向（ECEF 单位矢量）与源星位置：拖拽/切模式取初值用
  function boreDir() {
    const m = antMeta(); if (!m) return null
    const b = beamBasis(m, s)
    return { S: b.S, d: b.z }
  }
  // 当前视轴打在半径 R 壳层上的落点 {lon, lat, altKm}（地心口径）：3D 拖拽据此定转动增益
  function boreTip(R) {
    const bd = boreDir()
    return bd ? boresightShellPoint(bd.S, bd.d, R) : null
  }

  // ==================== 天线视轴（boresight axis）====================
  // 一根天线【一条】线：从源星沿方向图坐标系的 z 轴（u=v=0 那个方向）射出去。
  // ★ 这不是「每个波束一条」——多波束天线的 94 个波束共用同一根反射面/同一个视轴，逐波束连线既不是
  //   物理上的一根轴，94 条粗线本身也是每帧几十次几何分配（94 波束下点播放就卡在这里）。
  //   要看单个波束打在哪，那是「波束中心」那个开关的事。
  // 与半径 R 球面求交：源星在球外（对地 R=A）取【近】交点＝视轴打在地球上的落点；
  // 源星在球内（对星，R=最外壳层）恒有唯一正根。整个视轴指着天上（对地时打不到地球）→ 交不着，
  // 由调用方退到一个可见长度，射线仍在（拖全向指向时它是唯一的把手）。
  function axisHit(S, d, R) {
    const rS = Math.hypot(S[0], S[1], S[2]) || 1
    const b = 2 * (S[0] * d[0] + S[1] * d[1] + S[2] * d[2]), c = rS * rS - R * R
    const disc = b * b - 4 * c
    if (disc < 0) return null
    const sq = Math.sqrt(disc), t1 = (-b - sq) / 2, t2 = (-b + sq) / 2
    const t = t1 > 1e-6 ? t1 : (t2 > 1e-6 ? t2 : 0)
    if (!(t > 0)) return null
    return { rS, P: [S[0] + t * d[0], S[1] + t * d[1], S[2] + t * d[2]] }
  }
  // keys 里每根天线一条视轴。R 由调用方给（对地传地球半径，对星传最外一层壳层半径）；
  // 交不着就退到 rS×1.15 的球，保证线一直看得见。
  function buildAxisRays(keys, R) {
    if (!s.showRay) return []
    const D = 180 / Math.PI, out = []
    for (const key of (keys || [])) {
      // 直接取缓存算基底，不走 getPerfContext —— 后者顺带 map 出【全部波束】的清单（94 波束就是每帧
      // 94 个对象 + 94 次取名），而这里只要 S 和 z 两个矢量。拖拽热路径上这笔白账尤其贵。
      const c = cache.get(key); if (!c || !c.meta || !c.beams) continue
      const b0 = beamBasis(c.meta, c.settings)
      const S = b0.S, d = b0.z
      const rS = Math.hypot(S[0], S[1], S[2]) || 1
      const hit = axisHit(S, d, R) || axisHit(S, d, rS * 1.15)
      if (!hit) continue
      const P = hit.P, rP = Math.hypot(P[0], P[1], P[2]) || 1
      out.push({
        from: { lon: Math.atan2(S[1], S[0]) * D, lat: Math.asin(Math.max(-1, Math.min(1, S[2] / rS))) * D, rKm: rS },
        to: { lon: Math.atan2(P[1], P[0]) * D, lat: Math.asin(Math.max(-1, Math.min(1, P[2] / rP))) * D, rKm: rP },
        color: s.rayColor, width: s.rayWidth, opacity: s.rayOpacity
      })
    }
    return out
  }
  // 指向模式（STK 口径）＝ 底层 boreType(geo/azel)+boreLock 两字段的规范组合，UI 只暴露单一「模式」：
  //   目标跟踪 Targeted     = geo + 锁定：boresight 钉住固定经纬点，星动天线重指向、足迹中心不动（STK Targeted + Tracking Boresight）
  //   星下点跟随 Ground-track = geo + 不锁定：足迹随星下点平移、保持相对经纬偏置（本平台自有模式，STK 无对应项）
  //   本体固定 Fixed        = azel(不锁定)：相对天底固定 Az/El，星动足迹随之扫过地面（STK Fixed）
  //   天底 Nadir            = azel(不锁定) 且 Az=El=0：boresight 恒指星下点（Fixed 的特例）
  //   对星跟踪 Sat-track    = sat：boresight 直指另一颗卫星，随两星相对运动实时重指（星间链路；可指反天底）
  //   对星跟踪+偏置          = satoff：sat 再叠一层相对目标星方向的 az/el 偏置
  //   空间点 Space-point    = point：钉住空间中一个「地心经纬度 + 高度」的定点（不依赖在场卫星，可自由拖）
  // 后三者是【对星指向】，UI 里与前四者分作两个 optgroup。
  function boreModeOf() {
    if (s.boreType === 'sat') return 'sat'
    if (s.boreType === 'satoff') return 'satoff'
    if (s.boreType === 'point') return 'point'
    if (s.boreType === 'azel') return (!s.boreAz && !s.boreEl) ? 'nadir' : 'fixed'
    return s.boreLock !== false ? 'target' : 'groundtrack'
  }
  // 切模式只改这两字段：boreType 变化交给既有 watch(s.boreType) 无缝换算当前指向（geo↔azel 不跳变）。
  // Nadir 需把 Az/El 归零、覆盖换算结果，故在 nextTick（换算 watch 冲刷之后）再置 0；持久化同样延到换算完成后，避免存到中间态。
  // 切到 point 前先按【当前指向】反推空间点，切到 satoff 前把偏置归零 —— 两处都保证换模式时指向不跳变。
  function setBoreMode(mode) {
    if (!antMeta()) return
    if (mode === 'target') { s.boreType = 'geo'; s.boreLock = true }
    else if (mode === 'groundtrack') { s.boreType = 'geo'; s.boreLock = false }
    else if (mode === 'fixed') { s.boreType = 'azel'; s.boreLock = false }
    else if (mode === 'nadir') { s.boreType = 'azel'; s.boreLock = false }
    else if (mode === 'sat') { s.boreType = 'sat'; s.boreLock = false }   // 目标星在 boreSat，另设
    else if (mode === 'satoff') { if (s.boreType !== 'satoff') { s.boreOffAz = 0; s.boreOffEl = 0 } s.boreType = 'satoff'; s.boreLock = false }
    else if (mode === 'point') { syncBorePoint(); s.boreType = 'point'; s.boreLock = false }
    else return
    nextTick(() => { if (mode === 'nadir') { s.boreAz = 0; s.boreEl = 0 } persistActive() })
  }
  // 按当前 boresight 方向反推空间点（打在「默认壳层」上，宿主可经 hooks.defaultBoreAlt 给高度；
  // 缺省沿用上次的 borePtAlt）。切到 point 模式与首次拖拽前调用，避免指向凭空跳到某个旧坐标。
  function syncBorePoint() {
    if (s.boreType === 'point' && s.borePtLon != null) return
    const alt = (hooks.defaultBoreAlt && hooks.defaultBoreAlt()) || s.borePtAlt || 550
    const bd = boreDir(); if (!bd) { s.borePtAlt = alt; return }
    const p = boresightShellPoint(bd.S, bd.d, A + alt)
    // 只在算得出有限值时才写：当前指向的经纬度被清空（v-model.number 落空串）时 basis 会退化成 NaN，
    // 写进去就成了「NaN°E」，之后每次投影都是空的、还救不回来。
    if (p && Number.isFinite(p.lon) && Number.isFinite(p.lat)) { s.borePtLon = +p.lon.toFixed(4); s.borePtLat = +p.lat.toFixed(4) }
    s.borePtAlt = alt
  }
  // 设定 / 清除对星指向的目标（id = 宿主认得的身份串，见 hooks.getTargetEcef；name 仅供显示）
  function setBoreSat(id, name) {
    if (!antMeta()) return
    s.boreSat = id || null
    s.boreSatName = name || ''
    if (id && s.boreType !== 'satoff') s.boreType = 'sat'
    persistActive()
    reproject(); recompute()
  }
  // 直接设定空间点指向（面板输入 / 3D 拖拽落点共用）
  function setBorePoint(lon, lat, altKm) {
    if (!antMeta()) return
    if (Number.isFinite(lon)) s.borePtLon = +lon.toFixed(4)
    if (Number.isFinite(lat)) s.borePtLat = +lat.toFixed(4)
    if (Number.isFinite(altKm)) s.borePtAlt = +altKm.toFixed(3)
    s.boreType = 'point'
  }

  // 加一档（电平值一律取整数）：
  //  · 无档时——绝对模式从「峰值减1向下取整」起，相对模式从 −1 起（相对峰值）；
  //  · 只有一档时——取「上一档减1向下取整」；
  //  · 多档时——沿最后两档趋势方向再走 1 dB（其余同旧逻辑），结果取整。
  // 之后整体 jet 重新配色（locked 手动配色档不受影响）。
  function addLevel() {
    const lv = s.levels
    const m = antMeta(), peak = m ? m.peakDb : NaN
    let v
    if (!lv.length) v = s.ctype === 'rel' ? -1 : (Number.isFinite(peak) ? Math.floor(peak) - 1 : 50)
    else if (lv.length === 1) v = Math.floor(lv[0].v) - 1
    else { const dir = Math.sign(lv[lv.length - 1].v - lv[lv.length - 2].v) || (s.ctype === 'rel' ? -1 : 1); v = Math.floor(lv[lv.length - 1].v) + dir * STEP }
    lv.push({ v, name: '', labelT: null, color: '', lineColor: '', locked: false, lineSet: false })
    recolorList(lv)
  }
  function removeLevel(i) { s.levels.splice(i, 1); recolorList(s.levels) }
  // 由指定 dB 值数组构造电平表（jet 自动配色）：波束合成设默认档用
  function levelsFromValues(vals) {
    const lv = vals.map((v) => ({ v, name: '', labelT: null, color: '', lineColor: '', locked: false, lineSet: false }))
    recolorList(lv); return lv
  }

  // 每个天线的独立设置（数据库）：除等仰角线(全局参考线)外的全部绘制设置都按天线保存，
  // 切换聚焦时载入该天线设置、编辑时回存，只有用户改动才变。bore 指向同样并入。
  const PA = ['ctype', 'pol', 'gainOffset', 'pathLoss', 'fill', 'line', 'lineWidth', 'alpha', 'boreType', 'boreLon', 'boreLat', 'boreAz', 'boreEl', 'yaw', 'boreLock', 'boreSat', 'boreSatName', 'boreOffAz', 'boreOffEl', 'borePtLon', 'borePtLat', 'borePtAlt']
  const copyLevels = (lv) => lv.map((L) => ({ v: L.v, name: L.name || '', labelT: (L.labelT == null ? null : L.labelT), color: L.color, lineColor: L.lineColor, locked: !!L.locked, lineSet: !!L.lineSet }))
  function defaultSettings(satLon, satLat = 0, peakDb) {
    return { ctype: 'abs', pol: 'RSS', gainOffset: 0, pathLoss: 'none', fill: false, line: true, lineWidth: 1.6, alpha: 0.78,
      boreType: 'azel', boreLon: satLon == null ? null : satLon, boreLat: satLat || 0, boreAz: 0, boreEl: 0, yaw: 0, boreLock: true,
      boreSat: null, boreSatName: '', boreOffAz: 0, boreOffEl: 0,
      borePtLon: satLon == null ? null : satLon, borePtLat: satLat || 0, borePtAlt: 550,
      beamsToPlot: [0], beamNames: {}, levels: defaultLevels(peakDb) }
  }
  function applySettings(cfg) { if (!cfg) return; for (const k of PA) s[k] = cfg[k]; s.levels = copyLevels(cfg.levels || defaultLevels()); s.beamsToPlot = (cfg.beamsToPlot || []).slice(); s.beamNames = { ...(cfg.beamNames || {}) } }
  // 设置序列化（深拷贝 levels/beamsToPlot/beamNames/keptSets），供 getState 回存每个天线
  function serializeCfg(st) { return { ...st, levels: copyLevels(st.levels || []), beamsToPlot: (st.beamsToPlot || [0]).slice(), beamNames: { ...(st.beamNames || {}) }, keptSets: Array.isArray(st.keptSets) ? st.keptSets.slice() : null } }
  // 把存档 cfg 合到该天线一份完整 settings（缺省字段以 meta 默认补齐）
  function mergeCfg(meta, cfg) {
    return { ...defaultSettings(meta.satLon, meta.satLat || 0, meta.peakDb), ...cfg,
      levels: cfg.levels ? copyLevels(cfg.levels) : defaultLevels(meta.peakDb),
      beamsToPlot: (cfg.beamsToPlot || []).slice(), beamNames: { ...(cfg.beamNames || {}) },
      keptSets: Array.isArray(cfg.keptSets) ? cfg.keptSets.slice() : null }
  }
  // 载入时按存档的「保留波束」裁剪 c.beams（波束删除功能持久化）：keptSets = 存活波束在【原始 GRD set 顺序】
  // 里的下标（升序）。此刻 c.beams 是刚从原始 GRD 全量重建（原始 set 顺序），据此过滤即还原删除后的紧凑波束
  // 数组；之后 beamsToPlot/beamNames 都以紧凑下标存取，与裁剪结果一一对应。单波束/无删除记录不动。
  function applyKeptSets(c) {
    const keep = c.settings && c.settings.keptSets
    if (!Array.isArray(keep) || !keep.length) return       // 无删除记录：全量保留
    if (keep.length >= (c.beams || []).length) return       // 无需裁剪（已全量或数不符，兜底不动）
    const kept = keep.map((i) => c.beams[i]).filter(Boolean)
    if (!kept.length || kept.length === c.beams.length) return
    c.beams = kept
    c.meta.beams = kept.length
    const best = kept.reduce((a, b) => (b.peakDb > a.peakDb ? b : a), kept[0])
    c.meta.peakDb = best.peakDb; if (best.peak) c.meta.peak = best.peak
    const node = sats.value.find((x) => x.folder === c.meta.folder)
    const a = node && node.antennas.find((x) => x.name === c.meta.name)
    if (a) { a.beams = kept.length; a.peakDb = best.peakDb; if (best.peak) a.peak = best.peak }
    beamsRev.value++   // 若该天线正被面板展示，波束列表随裁剪即时刷新
  }
  // 天线一经加载即套用其待恢复设置（若有），并移出 pending（此后由 cache 接管、getState 从 cache 取最新）
  function applyPendingCfg(key) {
    const cfg = pendingCfgs.get(key); if (!cfg) return
    const c = cache.get(key); if (!c || !c.meta) return
    c.settings = mergeCfg(c.meta, cfg)
    applyKeptSets(c)   // 先按存档「保留波束」裁剪 c.beams，再据裁剪后的波束数做越界保护
    const nb = (c.beams || []).length
    c.settings.beamsToPlot = (c.settings.beamsToPlot || []).filter((i) => i < nb)   // 波束数变化越界保护
    pendingCfgs.delete(key)
  }
  let _muteSync = false
  function persistActive() {     // 把当前面板设置回存到聚焦天线
    if (_muteSync) return
    const c = cache.get(active.value); if (!c || !c.settings) return
    for (const k of PA) c.settings[k] = s[k]
    c.settings.levels = copyLevels(s.levels)
    c.settings.beamsToPlot = s.beamsToPlot.slice()
    c.settings.beamNames = { ...s.beamNames }
  }

  const keyOf = (folder, name) => `${folder}|${name}`
  const findAnt = (key) => { const [f, n] = key.split('|'); const sat = sats.value.find((x) => x.folder === f); return sat && sat.antennas.find((a) => a.name === n) ? { sat, a: sat.antennas.find((a) => a.name === n) } : null }
  const isSelected = (folder, name) => selected.value.includes(keyOf(folder, name))
  const isActive = (folder, name) => active.value === keyOf(folder, name)
  const antMeta = () => { const c = cache.get(active.value); return c && c.meta }
  const activeName = () => active.value ? active.value.split('|')[1] : ''
  const beamsCount = () => { const m = antMeta(); return m ? m.beams : 0 }
  const toF32 = (a) => Float32Array.from(a, (v) => (v == null ? NaN : v))

  // 波束的【原始序号】（0-based，原始 GRD set 顺序）：删过波束后由 keptSets 映射，否则=紧凑下标。
  // 波束号/默认名永久绑定原始序号——删除波束不重排、不改名（命名对用户是身份标识）。
  const origIdx = (c, bi) => { const k = c.settings && c.settings.keptSets; return (Array.isArray(k) && k[bi] != null) ? k[bi] : bi }
  // 波束名：自定义优先，否则默认「波束 N」（N=原始序号+1；未删过的单波束天线退回天线名）。地图标注与选波束列表共用。
  const defBeamName = (c, bi) => ((c.beams.length > 1 || Array.isArray(c.settings && c.settings.keptSets)) ? `波束 ${origIdx(c, bi) + 1}` : (c.meta && c.meta.name) || `波束 ${bi + 1}`)
  const beamName = (c, bi) => { const o = c.settings && c.settings.beamNames; return (o && o[bi]) || defBeamName(c, bi) }
  // 重命名聚焦天线的第 i 个波束：写入响应式 s.beamNames（空/同默认=清除回退默认），回存并重绘。
  function renameBeam(i, name) {
    const c = cache.get(active.value); if (!c) return
    const nm = String(name == null ? '' : name).trim()
    const m = { ...s.beamNames }
    if (!nm || nm === defBeamName(c, i)) delete m[i]; else m[i] = nm
    s.beamNames = m
    persistActive(); recompute()
  }

  // ===== Beams To Plot（SATSOFT 多选波束）：作用于聚焦天线，共用其同一套电平/极化设置 =====
  // 波束删除计数器：cache 非响应式，删除波束后靠它驱动模板重取 activeBeams()（列表/波束数 v-if 即时刷新）
  const beamsRev = ref(0)
  // 波束列表是否显示：多波束，或删过波束（keptSets 存在）。删到只剩 1 个也保持显示——
  // 剩下的波束仍需改名、且要能看到其原始序号/名称；真正的单波束天线（从未删过）照旧不显示。
  const beamListOn = () => {
    void beamsRev.value
    const c = cache.get(active.value)
    return !!(c && c.beams && (c.beams.length > 1 || Array.isArray(c.settings && c.settings.keptSets)))
  }
  // 聚焦天线已载入的波束列表（{ i 紧凑下标, seq 原始波束号(1-based，删除不重排), label, peakDb }）；单波束天线返回 1 项。label 用波束名（可编辑）。
  const activeBeams = () => {
    void beamsRev.value   // 建立响应式依赖（见上）
    const c = cache.get(active.value); if (!c || !c.beams) return []
    return c.beams.map((b, i) => ({ i, seq: origIdx(c, i) + 1, label: (s.beamNames && s.beamNames[i]) || defBeamName(c, i), peakDb: b.peakDb }))
  }
  const isBeamOn = (i) => s.beamsToPlot.includes(i)
  function toggleBeam(i) {
    const set = new Set(s.beamsToPlot)
    set.has(i) ? set.delete(i) : set.add(i)
    s.beamsToPlot = [...set].sort((a, b) => a - b)   // 触发 watcher → 回存 + 重绘
  }
  function setAllBeams(on) {
    const n = (cache.get(active.value)?.beams || []).length
    s.beamsToPlot = on ? Array.from({ length: n }, (_, i) => i) : []
  }
  const allBeamsOn = () => { const n = (cache.get(active.value)?.beams || []).length; return n > 0 && s.beamsToPlot.length === n }

  // ===== 部分批量多选：按序号/名称筛选 + 对筛选结果 全选/取消/反选（如 94 波束里一次选 1-62）=====
  const beamQuery = ref('')
  const setBeamQuery = (q) => { beamQuery.value = (q == null ? '' : String(q)) }
  // 纯序号语法（"1-62"、"1,3,5"、"1-10,20-30"）→ 1-based 序号集合，否则 null（当作波束名文字搜索）
  function parseSeqSet(q) {
    const set = new Set()
    for (const part of q.split(/[,，\s]+/)) {
      if (!part) continue
      const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/)
      if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i) }
      else if (/^\d+$/.test(part)) set.add(+part)
      else return null
    }
    return set.size ? set : null
  }
  // 按查询过滤聚焦天线波束：序号语法按【原始波束号】seq（删除波束后不重排），否则按波束名文字（大小写不敏感）。空查询=全部。
  function filteredBeams() {
    const all = activeBeams()
    const q = beamQuery.value.trim()
    if (!q) return all
    const seq = parseSeqSet(q)
    if (seq) return all.filter((b) => seq.has(b.seq))
    const ql = q.toLowerCase()
    return all.filter((b) => String(b.label).toLowerCase().includes(ql))
  }
  // Excel 「(全选)」三态：筛选结果全部已选 / 部分已选(半选 indeterminate) / 全未选。
  const filteredAllOn = () => { const f = filteredBeams(); return f.length > 0 && f.every((b) => s.beamsToPlot.includes(b.i)) }
  const filteredAnyOn = () => filteredBeams().some((b) => s.beamsToPlot.includes(b.i))
  // 勾选「(全选)/(全选搜索结果)」：作用于当前筛选结果（无查询=全部），累加进已选 → Excel 式批量选。
  function selectFiltered(on) {
    const ids = filteredBeams().map((b) => b.i)
    const set = new Set(s.beamsToPlot)
    if (on) ids.forEach((i) => set.add(i)); else ids.forEach((i) => set.delete(i))
    s.beamsToPlot = [...set].sort((a, b) => a - b)
  }

  // ===== 波束删除：从聚焦天线永久移除若干波束（本地存档持久化，可重新导入原 GRD 恢复）=====
  // UI 入口：波束行尾小×（单个删除）/「(全选)」行小×（删除全部勾选波束）。
  // delSet：要删除的【紧凑下标】集合。裁剪 c.beams，并把 beamsToPlot/beamNames/keptSets 全部重映射到新紧凑
  // 下标，同步 meta / 卫星树节点的波束数与峰值，回存后重绘。至少保留 1 个波束。
  function deleteBeamsByIndex(delSet) {
    const c = cache.get(active.value); if (!c || !c.beams) return
    const n = c.beams.length
    const keepIdx = []
    for (let i = 0; i < n; i++) if (!delSet.has(i)) keepIdx.push(i)
    if (keepIdx.length === n) return                                  // 没选中任何要删的波束
    if (!keepIdx.length) { appAlert('至少保留一个波束'); return }
    // keptSets：当前紧凑下标 → 原始 GRD set 下标（首次删除前视作恒等映射）。删除后据此重建，供重载复原。
    const oldKept = (Array.isArray(c.settings.keptSets) && c.settings.keptSets.length === n)
      ? c.settings.keptSets : Array.from({ length: n }, (_, i) => i)
    const pos = new Map(); keepIdx.forEach((oi, ni) => pos.set(oi, ni))   // 旧紧凑下标 → 新紧凑下标
    const newBeams = keepIdx.map((i) => c.beams[i])
    const newKept = keepIdx.map((i) => oldKept[i])
    const oldNames = c.settings.beamNames || {}
    const newNames = {}
    for (const k in oldNames) { const oi = +k; if (pos.has(oi)) newNames[pos.get(oi)] = oldNames[k] }
    let newPlot = (c.settings.beamsToPlot || []).filter((i) => pos.has(i)).map((i) => pos.get(i)).sort((a, b) => a - b)
    if (newBeams.length === 1) newPlot = [0]     // 只剩单波束：默认绘制它（列表仍显示，可改名/看原始序号，也可取消勾选）
    // 落库：c.beams / keptSets / meta / 树节点
    c.beams = newBeams
    c.settings.keptSets = newKept
    c.meta.beams = newBeams.length
    const best = newBeams.reduce((a, b) => (b.peakDb > a.peakDb ? b : a), newBeams[0])
    c.meta.peakDb = best.peakDb; if (best.peak) c.meta.peak = best.peak
    const [folder, nm] = active.value.split('|')
    const node = sats.value.find((x) => x.folder === folder)
    const a = node && node.antennas.find((x) => x.name === nm)
    if (a) { a.beams = newBeams.length; a.peakDb = best.peakDb; if (best.peak) a.peak = best.peak }
    sats.value = [...sats.value]                 // 触发卫星树响应式刷新（波束数/峰值）
    // 同步面板反应式状态 → 回存 → 重绘（_muteSync 避免赋值途中被 watcher 提前回存）
    _muteSync = true; s.beamNames = { ...newNames }; s.beamsToPlot = newPlot.slice(); _muteSync = false
    persistActive()
    beamsRev.value++   // 驱动波束列表/波束数即时刷新（cache 非响应式）
    recompute()   // 筛选词保留：filteredBeams 按新列表自动刷新，便于连续删除
  }
  // 单个删除（波束行尾小×）
  function deleteBeam(i) {
    const c = cache.get(active.value); if (!c || !c.beams) return
    if (c.beams.length <= 1) { appAlert('至少保留一个波束'); return }
    deleteBeamsByIndex(new Set([i]))
  }
  // 删除全部勾选波束（「(全选)」行小×）：不能删空，至少保留一个。
  function deleteCheckedBeams() {
    const c = cache.get(active.value); if (!c || !c.beams) return
    const del = new Set(s.beamsToPlot)
    if (!del.size) return
    if (del.size >= c.beams.length) { appAlert('不能删除全部波束，至少保留一个'); return }
    deleteBeamsByIndex(del)
  }

  // ===== 卫星节点：增/删/改 + 仰角线属性 =====
  // 轮转取色：卫星颜色默认已改为白色，下列暂保留备用（当前未调用）；如需恢复彩色，把 normPreset/addSatellite 的 '#ffffff' 改回 nextElevColor() 即可
  let _colorSeq = 0
  const nextElevColor = () => SAT_PALETTE[_colorSeq++ % SAT_PALETTE.length]
  // 预置星（index）补齐统一节点字段：GEO 定点(lon,0,GEO_ALT)、仰角线默认关、卫星名默认开、颜色默认白
  const normPreset = (s) => ({ ...s, kind: 'preset', lat: 0, altKm: GEO_ALT, noradId: null, els: '5,10', elevColor: '#ffffff', elevShow: false, elevWidth: 1.3, elevLabelSize: 18, iconSize: 10, labelSize: 4, iconShow: true, labelShow: true })

  // ===== 用户自定义卫星持久化（localStorage）=====
  // 覆盖分析里【添加的卫星】(custom/linked/orbit/elevline，非磁盘 index 的 preset) 只在内存 → 关闭重开丢失，
  // 且依赖它的波束合成组会成孤儿。存 localStorage：只存节点基本信息（不含天线——天线走磁盘 .grd + index() 重建）。
  // preset 星（loadIndex 从磁盘 index 重建）不存，避免与 index 重复；恢复时用户星与 index 星按 folder 去重合并（index 优先）。
  const SATS_KEY = 'globe3d/grdSats'
  const SAT_FIELDS = ['folder', 'satName', 'kind', 'lon', 'lat', 'altKm', 'noradId', 'elements', 'els',
    'elevColor', 'elevShow', 'elevWidth', 'elevLabelSize', 'iconSize', 'labelSize', 'iconShow', 'labelShow']
  const bareSat = (s) => { const o = {}; for (const k of SAT_FIELDS) o[k] = s[k]; return o }
  function persistSats() {
    try { localStorage.setItem(SATS_KEY, JSON.stringify(sats.value.filter((s) => s && s.kind && s.kind !== 'preset').map(bareSat))) } catch { /* ignore */ }
  }
  // 从 localStorage 恢复用户星，合并进 sats（按 folder 去重：磁盘 index 星优先/带天线，本地星补齐缺失的）
  function restoreSats() {
    let arr = null
    try { arr = JSON.parse(localStorage.getItem(SATS_KEY) || '[]') } catch { /* ignore */ }
    if (!Array.isArray(arr) || !arr.length) return
    const have = new Set(sats.value.map((s) => s.folder))
    const add = []
    for (const s of arr) {
      if (!s || !s.folder || have.has(s.folder)) continue
      have.add(s.folder)
      add.push({
        folder: s.folder, satName: s.satName || '卫星', kind: s.kind || 'custom',
        lon: Number(s.lon) || 0, lat: Number(s.lat) || 0, altKm: Number(s.altKm) || GEO_ALT,
        noradId: s.noradId || null, elements: s.elements || null, els: s.els != null ? s.els : '5,10',
        elevColor: s.elevColor || '#ffffff', elevShow: !!s.elevShow, elevWidth: Number(s.elevWidth) || 1.3,
        elevLabelSize: Number(s.elevLabelSize) || 18, iconSize: Number(s.iconSize) || 10, labelSize: Number(s.labelSize) || 4,
        iconShow: s.iconShow !== false, labelShow: s.labelShow !== false, antennas: []
      })
    }
    if (add.length) { sats.value = [...sats.value, ...add]; for (const s of add) expanded.value = { ...expanded.value, [s.folder]: true } }
  }

  // 天线 key 的增删改广播：本模块自己那份 selected 就地维护，但【对星覆盖分析】另存一份 selected
  // （画哪些天线是它独有的），删天线/删卫星/改名一律要跟着走。两棵树共用同一份数据、任一棵树都能改，
  // 靠订阅比靠调用方记得同步可靠（早先只在对星那边包一层，从对地树删掉的天线会在对星留一个死 key）。
  const _keySubs = []
  function onTreeKeys(fn) { if (typeof fn === 'function') _keySubs.push(fn) }
  function emitTreeKeys(ev) { for (const f of _keySubs) { try { f(ev) } catch (e) { console.warn('onTreeKeys 订阅者抛错', e) } } }

  // 同名加点号去重，作为节点唯一 key（folder）
  function genFolder(name) {
    const base = (name || '卫星').trim() || '卫星'
    let f = base, i = 1
    while (sats.value.some((x) => x.folder === f)) f = `${base}·${++i}`
    return f
  }
  // 往树里加一颗卫星：noradId 非空=星座关联星（位置随星历，由页面解算）；
  // 否则 elements 非空=轨道根数模拟星（位置由页面 SGP4 自行解算，随时间动）；都没有=固定 lon/lat/alt 自定义星。
  function addSatellite(draft) {
    const folder = genFolder(draft.name)
    const node = {
      folder, satName: (draft.name || '卫星').trim() || '卫星',
      kind: draft.noradId ? 'linked' : (draft.elements ? 'orbit' : 'custom'),
      lon: Number(draft.lon) || 0, lat: Number(draft.lat) || 0, altKm: Number(draft.altKm) || GEO_ALT,
      noradId: draft.noradId || null,
      elements: draft.elements || null,
      els: draft.els != null ? draft.els : '5,10',
      elevColor: draft.color || '#ffffff', elevShow: false, elevWidth: Number(draft.elevWidth) || 1.3,
      elevLabelSize: Number(draft.elevLabelSize) || 18,
      iconSize: Number(draft.iconSize) || 10, labelSize: Number(draft.labelSize) || 4, iconShow: draft.iconShow !== false, labelShow: draft.labelShow !== false,
      antennas: []
    }
    sats.value = [...sats.value, node]
    expanded.value = { ...expanded.value, [folder]: true }
    persistSats()
    return node
  }
  // 独立仰角线：与「卫星」脱钩的最小节点——只画等仰角环，不显示图标/卫星名，不挂天线。
  // 复用同一棵 sats 树（渲染/存档/实时刷新全部现成），kind:'elevline' 只影响树行 UI 与编辑弹窗走哪条。
  function addElevLine(draft) {
    const folder = genFolder(draft.satName || draft.name || '仰角线')
    const node = {
      folder, satName: (draft.satName || draft.name || '仰角线').trim() || '仰角线',
      kind: 'elevline',
      lon: Number(draft.lon) || 0, lat: Number(draft.lat) || 0, altKm: Number(draft.altKm) || GEO_ALT,
      noradId: null, elements: null,
      els: draft.els != null ? draft.els : '5,10',
      elevColor: draft.elevColor || draft.color || '#ffffff', elevShow: true, elevWidth: Number(draft.elevWidth) || 1.3,
      elevLabelSize: Number(draft.elevLabelSize) || 18,
      iconShow: false, labelShow: false, iconSize: 10, labelSize: 4,
      antennas: []
    }
    sats.value = [...sats.value, node]
    persistSats()
    return node
  }
  function updateSatellite(folder, patch) {
    const n = sats.value.find((x) => x.folder === folder); if (!n) return
    // 位置（经纬度/高度 或 轨道根数）变化 → 编辑后让该星天线覆盖图跟随重投影（仰角线由页面 redrawSats 处理）
    const moved = ('lon' in patch && Number(patch.lon) !== n.lon) || ('lat' in patch && Number(patch.lat) !== n.lat) || ('altKm' in patch && Number(patch.altKm) !== n.altKm) || ('elements' in patch)
    Object.assign(n, patch)
    if (moved) reprojectSat(folder)
    persistSats()
  }
  const setElev = (folder, patch) => updateSatellite(folder, patch)   // 仅改仰角线属性（els/elevColor/elevShow）
  // 删卫星：连带清掉其天线的选中/缓存（预置星也可删——仅本会话，重载后随 index 复现）
  function removeSatellite(folder) {
    const n = sats.value.find((x) => x.folder === folder); if (!n) return
    const gone = []
    for (const a of n.antennas) {
      const k = keyOf(folder, a.name)
      if (a.imported && a.file) { try { window.api.coverageGrd.remove(a.file) } catch { /* ignore */ } }
      cache.delete(k); pendingCfgs.delete(k)
      selected.value = selected.value.filter((x) => x !== k)
      if (active.value === k) active.value = ''
      gone.push(k)
    }
    if (gone.length) emitTreeKeys({ type: 'remove', keys: gone })
    sats.value = sats.value.filter((x) => x.folder !== folder)
    if (!active.value) { active.value = selected.value[0] || ''; loadActive() }
    persistSats()
    recompute()
  }
  // 删天线：从该星移除，并清掉其选中/聚焦/缓存
  function removeAntenna(folder, name) {
    const sat = sats.value.find((x) => x.folder === folder); if (!sat) return
    const key = keyOf(folder, name)
    const tgt = sat.antennas.find((a) => a.name === name)
    if (tgt && tgt.imported && tgt.file) { try { window.api.coverageGrd.remove(tgt.file) } catch { /* ignore */ } }
    sat.antennas = sat.antennas.filter((a) => a.name !== name)
    cache.delete(key); pendingCfgs.delete(key)
    selected.value = selected.value.filter((k) => k !== key)
    if (active.value === key) { active.value = selected.value[0] || ''; loadActive() }
    emitTreeKeys({ type: 'remove', keys: [key] })
    recompute()
  }
  // 重命名天线：改名同时迁移其缓存键/选中键/聚焦键（名称即天线唯一标识，导入天线的存盘 file 不受影响）。
  // 返回 false=空名或同星重名（调用方据此提示并回退输入）。
  function renameAntenna(folder, oldName, newName) {
    const sat = sats.value.find((x) => x.folder === folder); if (!sat) return false
    const nm = String(newName || '').trim()
    if (!nm) return false
    if (nm === oldName) return true
    if (sat.antennas.some((a) => a.name === nm)) return false   // 同星重名
    const a = sat.antennas.find((x) => x.name === oldName); if (!a) return false
    const oldKey = keyOf(folder, oldName), newKey = keyOf(folder, nm)
    a.name = nm
    const c = cache.get(oldKey); if (c) { if (c.meta) c.meta.name = nm; cache.delete(oldKey); cache.set(newKey, c) }
    if (pendingCfgs.has(oldKey)) { pendingCfgs.set(newKey, pendingCfgs.get(oldKey)); pendingCfgs.delete(oldKey) }   // 迁移未加载天线的存档设置
    selected.value = selected.value.map((k) => (k === oldKey ? newKey : k))
    if (active.value === oldKey) active.value = newKey
    sats.value = [...sats.value]   // 触发卫星树响应式刷新（antennas 内属性变更）
    emitTreeKeys({ type: 'rename', from: oldKey, to: newKey })
    recompute()
    return true
  }

  async function loadIndex(autoSelect = true) {
    if (loaded) return
    try {
      const idx = await window.api.coverageGrd.index()
      sats.value = (((idx && idx.satellites) || [])).map(normPreset)
      restoreSats()   // 合并 localStorage 里的用户自定义星（磁盘 index 之外的），按 folder 去重
      loaded = true
      if (autoSelect && sats.value.length) {
        expanded.value[sats.value[0].folder] = true
        const a0 = sats.value[0].antennas[0]
        if (a0) {
          const key = await ensureLoaded(sats.value[0].folder, a0)   // 初次打开默认显示第一颗天线（此后编辑不再顺带改显示）
          if (!selected.value.includes(key)) selected.value = [...selected.value, key]
          await setActive(sats.value[0], a0)
        }
      }
    } catch (e) { console.error('coverageGrd index 失败', e) }
  }

  async function ensureLoaded(folder, a) {
    const key = keyOf(folder, a.name)
    if (cache.has(key)) return key
    // 导入天线：从存盘的原始 GRD 重建（解析与导入同源）。无 file（旧版仅内存导入）或读盘失败 → 不缓存，
    // 由调用方按 cache 缺失跳过（不抛出，避免中断整体恢复）。
    if (a.imported) {
      if (!a.file) return key
      try {
        const { text } = await window.api.coverageGrd.raw(a.file)
        const g = parseGrd(text)
        const sat = sats.value.find((x) => x.folder === folder) || { satName: a.sat || '', folder }
        const pos = Number.isFinite(a.satLon) ? { lon: a.satLon, lat: a.satLat || 0, altKm: a.satAlt } : null
        const ent = importedCacheEntry(sat, g, a.name, pos)   // 多波束：一并重建全部波束（按文件原始 set 顺序）
        cache.set(key, { meta: ent.meta, beams: ent.beams, settings: defaultSettings(ent.meta.satLon, ent.meta.satLat, ent.meta.peakDb) })
        applyPendingCfg(key)   // 套用存档设置（若有）
      } catch (e) { console.warn('导入 GRD 重载失败', a.file, e) }
      return key
    }
    const raw = await window.api.coverageGrd.get(a.file)
    const settings = defaultSettings(raw.meta.satLon, raw.meta.satLat || 0, raw.meta.peakDb)
    // 预置天线自带经纬度 boresight：用经纬度模式载入以原样保留（避免 azel 默认按 az/el=0 归零到星下点）
    settings.boreType = 'geo'; settings.boreLon = raw.meta.antenna.boreLon; settings.boreLat = raw.meta.antenna.boreLat
    // 用本地 projectGrid 重投影（而非后端烘焙的 lon/lat），得到地平裕度 vis + 越地平点落到地平，
    // 这样预置天线也能精确切在 0°仰角线（后端数据无 vis、越地平点为 NaN，会留网格锯齿）。
    const basis = beamBasis({ satLon: raw.meta.satLon, satLat: raw.meta.satLat || 0, satAlt: raw.meta.satAlt }, settings)
    const proj = projectGrid(raw.meta.grid, raw.meta.igrid, basis, null, null, true)
    // 预置天线（后端烘焙）只含单波束 set0，包成统一的 beams[1] 结构
    const beam0 = { P1: toF32(raw.P1), P2: toF32(raw.P2), grid: raw.meta.grid, proj, peakDb: raw.meta.peakDb, peak: raw.meta.peak }
    cache.set(key, { meta: { ...raw.meta, beams: 1 }, beams: [beam0], settings })   // 每天线各存全部设置（含指向），数据库式
    applyPendingCfg(key)   // 套用存档设置（若有），并据此重投影
    if (cache.get(key).settings !== settings) {   // pending 已套用 → 用恢复后的指向重算投影
      const c = cache.get(key), basis2 = beamBasis({ satLon: raw.meta.satLon, satLat: raw.meta.satLat || 0, satAlt: raw.meta.satAlt }, c.settings)
      c.beams[0].proj = projectGrid(raw.meta.grid, raw.meta.igrid, basis2, null, null, true)
    }
    return key
  }

  // 点击天线名 → 仅设为聚焦/编辑对象，不改变其显示状态（显示与否只由勾选框 toggleAnt 控制，两者解耦）
  async function setActive(sat, a) {
    loading.value = true
    try {
      const key = await ensureLoaded(sat.folder, a)
      active.value = key
      const c = cache.get(key)
      // beamsToPlot 越界保护（如旧存档波束数变化）：过滤掉不存在的波束。空保持空（= 不绘制任何波束）。
      const nb = (c.beams || []).length
      c.settings.beamsToPlot = (c.settings.beamsToPlot || []).filter((i) => i < nb)
      _muteSync = true; applySettings(c.settings); _muteSync = false   // 载入该天线已存的全部设置（含指向 / Beams To Plot）
      recompute()
      const sc = getScene(); if (sc && c.meta.peak) sc.faceLonLat(c.meta.peak[0], c.meta.peak[1])
    } finally { loading.value = false }
  }

  // 聚焦项切换后，把该天线已存设置载入面板（_muteSync 防止载入即回存）
  function loadActive() { const c = cache.get(active.value); if (c && c.settings) { _muteSync = true; applySettings(c.settings); _muteSync = false } }
  // 按 key 聚焦（快照恢复 / 对星覆盖分析同步聚焦用）：树里找不到该天线就原地不动。
  // 聚焦是【全局唯一】的——两个覆盖视图的设置区绑的都是 s（＝聚焦天线的编辑态），不许各聚焦各的。
  async function setActiveKey(key) { const info = findAnt(key); if (info) await setActive(info.sat, info.a) }

  // 勾选框 → 加入/移出选中集
  async function toggleAnt(sat, a) {
    const key = keyOf(sat.folder, a.name)
    if (selected.value.includes(key)) {
      selected.value = selected.value.filter((k) => k !== key)
      if (active.value === key) { active.value = selected.value[0] || ''; loadActive() }
      recompute()
    } else {
      await ensureLoaded(sat.folder, a)
      selected.value = [...selected.value, key]
      if (!active.value) { active.value = key; loadActive() }
      recompute()
    }
  }

  // 卫星行勾选 → 该星全部天线 全选/全不选
  async function toggleSatAll(sat) {
    const keys = sat.antennas.map((a) => keyOf(sat.folder, a.name))
    const allOn = keys.every((k) => selected.value.includes(k))
    if (allOn) {
      selected.value = selected.value.filter((k) => !keys.includes(k))
      if (!selected.value.includes(active.value)) { active.value = selected.value[0] || ''; loadActive() }
    } else {
      for (const a of sat.antennas) await ensureLoaded(sat.folder, a)
      const add = keys.filter((k) => !selected.value.includes(k))
      selected.value = [...selected.value, ...add]
      if (!active.value) { active.value = keys[0]; loadActive() }
    }
    recompute()
  }
  function satState(sat) {
    const keys = sat.antennas.map((a) => keyOf(sat.folder, a.name))
    const on = keys.filter((k) => selected.value.includes(k)).length
    return on === 0 ? 'none' : on === keys.length ? 'all' : 'some'
  }
  function toggleExpand(folder) { expanded.value = { ...expanded.value, [folder]: !expanded.value[folder] } }
  const isExpanded = (folder) => !!expanded.value[folder]

  // 指向(basis)签名：投影只随它变。azel 按 az/el，geo 按 lon/lat，sat 按【目标星当前位置】——
  // 对星指向下 basis 每个时刻都在变，签名必须带上目标坐标，否则缓存会把投影钉死在第一帧。
  const basisKeyOf = (c) => {
    const m = c.meta, b = c.settings
    let p
    if (b.boreType === 'sat' || b.boreType === 'satoff') {
      const T = b.boreSat && hooks.getTargetEcef ? hooks.getTargetEcef(b.boreSat) : null
      p = 'S' + (b.boreSat || '') + ',' + (T ? T[0].toFixed(3) + ',' + T[1].toFixed(3) + ',' + T[2].toFixed(3) : 'x')
      if (b.boreType === 'satoff') p += ',O' + (b.boreOffAz || 0) + ',' + (b.boreOffEl || 0)
    } else if (b.boreType === 'point') p = 'P' + (b.borePtLon == null ? m.satLon : b.borePtLon) + ',' + (b.borePtLat || 0) + ',' + (b.borePtAlt || 0)
    else if (b.boreType === 'azel') p = 'A' + (b.boreAz || 0) + ',' + (b.boreEl || 0)
    else p = 'G' + (b.boreLon == null ? m.satLon : b.boreLon) + ',' + (b.boreLat || 0)
    return p + ',' + (b.yaw || 0) + ',' + m.satLon + ',' + (m.satLat || 0) + ',' + (m.satAlt || 0)
  }
  // 最低绝对档（相对模式 = 峰值 + 最低相对值）：低于它的点无覆盖、不参与绘制。
  const lowestAbs = (max, cfg) => { let lo = Infinity; for (const L of cfg.levels) { const a = cfg.ctype === 'rel' ? max + L.v : L.v; if (a < lo) lo = a }; return lo }
  // 覆盖热区子矩形：db ≥ L0 的点的包围盒，各向外扩 1（含边界格的 <L0 角，等值线插值需要）。
  // db 与指向无关（pathLoss='none'），故拖拽中此盒不变 → 缓存。其余区域不投影/不三角化。
  function computeBox(db, NX, NY, L0) {
    let r0 = NY, r1 = -1, c0 = NX, c1 = -1
    for (let r = 0; r < NY; r++) { const rb = r * NX; for (let c = 0; c < NX; c++) { if (db[rb + c] >= L0) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c } } }
    if (r1 < 0) return { r0: 0, r1: -1, c0: 0, c1: -1 }   // 无覆盖：空盒（投影/三角化都不跑）
    return { r0: Math.max(0, r0 - 1), r1: Math.min(NY - 1, r1 + 1), c0: Math.max(0, c0 - 1), c1: Math.min(NX - 1, c1 + 1) }
  }
  // 取该波束在给定场/电平下的热区盒（按 field 引用 + L0 缓存）。pathLoss≠none 时 db 随指向变 → 不裁剪（返回 null）。
  function beamBox(beam, cfg, field) {
    if (cfg.pathLoss !== 'none' || !field) return null
    const L0 = lowestAbs(field.max, cfg)
    if (beam._box && beam._box.field === field && beam._box.L0 === L0) return beam._box.box
    const box = computeBox(field.db, field.NX, field.NY, L0)
    beam._box = { field, L0, box }
    return box
  }
  // 投影同步：当 (指向 + 热区盒) 变化时才重投影该波束，并原地复用其 proj 数组。
  // 只对「绘制中(beamsToPlot)」的波束调用 → HTS 只画 1/N 省 N 倍；热区盒进一步把每个波束的投影量降到覆盖区。
  function syncBeamProj(c, beam, cfg, field) {
    const box = beamBox(beam, cfg, field)
    const bkey = basisKeyOf(c) + '|' + (box ? `${box.r0}_${box.r1}_${box.c0}_${box.c1}` : 'F')
    if (beam._projKey === bkey) return
    const basis = beamBasis(c.meta, cfg)
    beam.proj = projectGrid(beam.grid, c.meta.igrid, basis, box, beam.proj, true)   // limbOutside：越地平点延伸到地平外，供地平弧裁剪
    beam._projKey = bkey
  }
  function reproject() {
    const c = cache.get(active.value); if (!c) return
    persistActive()   // 回存该天线全部设置（含指向）
    const plot = (s.beamsToPlot || [])
    // 预投影绘制中的波束（拖拽每帧核心）：用已缓存的场算热区盒（拖拽中 pol/gain 不变 → 场稳定）
    for (const bi of plot) { const beam = c.beams[bi]; if (beam) syncBeamProj(c, beam, c.settings, (c.settings.pathLoss === 'none' && beam._fld) ? beam._fld.field : null) }
  }

  function absLevels(peak, cfg) { return cfg.levels.map((L, idx) => ({ idx, abs: cfg.ctype === 'rel' ? peak + L.v : L.v, v: L.v, name: L.name || '', labelT: (L.labelT == null ? null : L.labelT), color: L.color, lineColor: L.lineColor })) }

  // 数值标签锚点/沿环拖动（loopTop·loopPointAtFraction·nearestFractionOnLoop：把标签位置存成
  // 「沿环弧长的比例 t∈[0,1)」，几何每帧重算也始终贴在线上）的几何本体在 coverage.js —— 对星覆盖
  // （useShellCoverage）共用同一份，两视图标签落点口径逐字一致。
  // 单个波束 → 一个子图层（分带填充 + 等值线 + 波束中心）。相对峰值模式按【该波束自身峰值】算电平
  // （HTS 多点波束各自的 −3dB 圈），绝对模式所有波束共用同一绝对 dB。
  // 填充与等值线由 bandGeometry 一次性同源生成（逐三角形线性插值）：填充 = 各档环带多边形，
  // 线 = 相邻档公共边 → 二者精确重合；地平/接缝裁剪在 bandGeometry 内完成（无需再 clipSegsVisible）。
  // 方向图 dB 只随 极化/增益 变，与指向(投影)无关 → pathLoss='none' 时按 (pol,gain) 缓存到波束上，
  // 拖拽时直接复用，免去每帧整张网格的 log10 重算。pathLoss 依赖斜距(随指向变)，此时照常重算不缓存。
  function beamField(beam, cfg) {
    const arg = { P1: beam.P1, P2: beam.P2, NX: beam.proj.NX, NY: beam.proj.NY }
    if (cfg.pathLoss !== 'none') return fieldDb(arg, beam.proj, { pol: cfg.pol, gainOffset: cfg.gainOffset, pathLoss: cfg.pathLoss })
    const cc = beam._fld
    if (cc && cc.pol === cfg.pol && cc.gain === cfg.gainOffset) return cc.field
    const field = fieldDb(arg, beam.proj, { pol: cfg.pol, gainOffset: cfg.gainOffset, pathLoss: 'none' })
    beam._fld = { pol: cfg.pol, gain: cfg.gainOffset, field }
    return field
  }
  function buildBeamLayer(c, cfg, beam, name, withLabels) {
    const field = beamField(beam, cfg)
    const lv = absLevels(field.max, cfg)
    const asc = [...lv].sort((a, b) => a.abs - b.abs)   // 升序档：外圈冷、内圈热（与 jet 配色一致）
    // 用新场算热区盒并确保投影覆盖它（权威同步：处理电平/极化变化导致盒变大、未过 reproject 的情形）
    const box = beamBox(beam, cfg, field)
    syncBeamProj(c, beam, cfg, field)
    const need = cfg.fill || cfg.line
    // wantFills=cfg.fill：只画等值线时跳过逐档填充裁剪（关填充的大波束拖拽省一半三角化）；box：只三角化覆盖热区
    const geo = need ? bandGeometry({ lon: beam.proj.lon, lat: beam.proj.lat, vis: beam.proj.vis, db: field.db, NX: beam.proj.NX, NY: beam.proj.NY }, asc.map((x) => x.abs), cfg.fill, box, cfg.fill ? satHull(c) : null, displayQuality.value.gridStride) : null
    // 分带填充：每档一个颜色 + 该档环带多边形（升序，逐层从外到内绘制，非嵌套→无重叠透明叠加）
    const fillBands = cfg.fill && geo ? asc.map((x, i) => ({ color: cssRgb(x.color), verts: geo.fills[i].verts, counts: geo.fills[i].counts })).filter((b) => b.counts.length) : null
    // 等值线：每档一组线段（= 填充相邻档公共边）；数值标签锚点：该档拖过（labelT 非空）则按弧长比例取点，
    // 否则默认取环最上端点。标签仅在「显示数值」开启时才拼环求锚点——关闭时跳过 stitchLoops，拖拽时省一笔。
    const segGroups = cfg.line && geo
      ? asc.map((x, i) => {
        const segs = geo.lines[i]
        const labels = []
        if (withLabels) for (const loop of stitchLoops(segs)) {
          if (loop.length < 4) continue
          // 默认锚点见 loopLabelAnchor（单档取顶部、多档沿环错开）；该档拖过则按存下的弧长比例取点。
          const anchor = (x.labelT != null) ? loopPointAtFraction(loop, x.labelT) : loopLabelAnchor(loop, i, asc.length)
          labels.push(anchor)
          if (_dragCapture) _dragCapture.push({ levelIdx: x.idx, loop, anchor })   // 聚焦天线：供数值标签拖拽就近锁定 + 沿环投影
        }
        // txt：该档【自定义名称】优先（电平表灰色列可改名），为空则回退电平值 x.v = L.v。
        // 数值回退不做小数位裁剪——绝对模式下 x.abs 恒等于 x.v，之前用 toFixed(1) 会把用户输入的
        // 更高精度电平（如 42.567）显示成 42.6，与输入框对不上。
        return { segs, color: x.lineColor, width: cfg.lineWidth, txt: (x.name || String(x.v)), labels }
      }).filter((g) => g.segs.length)
      : []
    // 波束中心 = 当前场的峰值点（随指向/拖拽实时变化）；波束名标签贴在此处，并向所属卫星连线
    const pk = (Number.isFinite(beam.proj.lon[field.maxIdx]) && Number.isFinite(beam.proj.lat[field.maxIdx])) ? [beam.proj.lon[field.maxIdx], beam.proj.lat[field.maxIdx]] : (beam.peak || c.meta.peak || [c.meta.satLon, 0])
    // peak = 波束中心峰值 dB（当前场峰值；显示用，随极化/增益/路损变）
    const bore = { lon: pk[0], lat: pk[1], satLon: c.meta.satLon, satLat: c.meta.satLat || 0, satAlt: c.meta.satAlt || H, peak: Number.isFinite(field.max) ? field.max : null }
    return { fillBands, segGroups, bore, name }
  }
  // 每个选中天线 → N 个子图层（按 Beams To Plot 选中的波束逐个出层）；所有子层共用该天线同一套设置。
  // 所有选中画线，每个【开启填充】的天线各自分带填充（多天线/多波束/多星可叠加）。
  // 2D 与 3D 同源同一份几何 { fillBands(各档环带多边形+色), segGroups(等值线段) }，均由 bandGeometry
  //   逐三角形线性插值生成 → 填充与线精确重合；地平/接缝裁剪在 bandGeometry 内完成（不再依赖位图/着色器取档）。
  function buildLayer(key, withLabels) {
    const c = cache.get(key); if (!c || !c.beams) return []
    const cfg = c.settings   // 每层用自身保存的设置（聚焦层的实时编辑已由 watcher 回存到此）
    // satShown = 该天线所属卫星的「卫星名」是否显示：3D 连线(卫星↔波束中心)需 showBore 且 satShown 同时为真
    const node = sats.value.find((x) => x.folder === key.split('|')[0])
    const satShown = !node || node.labelShow !== false
    const plot = (cfg.beamsToPlot || []).filter((i) => i < c.beams.length)   // 全未选 → 不绘制任何波束
    // 仅聚焦天线 + 显示数值标签时，捕获各档各环的可拖标签（锚点+环+原档下标），供 labelDrag 就近锁定/投影
    const capturing = withLabels && key === active.value
    if (capturing) _dragCapture = []
    const out = plot.map((bi) => {
      // 投影同步在 buildBeamLayer 内用新场完成（覆盖 reproject 未触及/新勾选的波束，且按热区盒裁剪）
      // 标注一律用波束名（自定义或默认「波束 N」）—— 不再用「天线名+波束名」形式
      const L = buildBeamLayer(c, cfg, c.beams[bi], beamName(c, bi), withLabels)
      L.id = `${key}#${bi}`   // 稳定层 id（天线键|波束序号）：渲染层据此做拖拽增量更新（只重建聚焦天线层）
      if (L.bore) L.bore.satShown = satShown
      return L
    })
    if (capturing) { _dragLabels = _dragCapture; _dragCapture = null }
    return out
  }

  const fieldOpts = () => ({ alpha: s.alpha, showBore: s.showBore, boreSize: s.boreSize, showRay: s.showRay, rayColor: s.rayColor, rayWidth: s.rayWidth, rayOpacity: s.rayOpacity, showName: s.showName, nameSize: s.nameSize, showPeak: s.showPeak, peakSize: s.peakSize, showVal: s.showVal, valSize: s.valSize })
  // 2D 平面图只有【一块】GRD 场（flatCoverage 的 fieldLayers 是整体替换），对地与对星两个视图都往那儿画，
  // 归属由宿主页按当前活动视图裁定（hooks.ownsFlatField）——不归自己时一律不碰 flat，3D 侧两条通道
  // (setCoverageField / setShellField) 各自独立、不受此限。
  // 不加这道闸的后果：天线设置是两视图共享的 grd.s，改任一项都会同时唤醒两边的 watcher，对星那份走
  // rAF 后到、把对地刚喂进去的层整体换掉（它自己的 selected 通常是空的 → 直接清空）。症状即「在平面图上
  // 点分带填充，覆盖闪一下就没了，切一次视图（feedFlat 重喂）又回来」。
  // 两道闸：归属（对星视图占场时不碰，见上）+ 活跃（3D 视图下画布不可见，Path2D 白烘一整套；
  // 「按 2D 出图」在 3D 视图下也要喂 flat，由宿主的 flatActive 放行——所以不能直接拿 isFlat 当闸）。
  const flatField = () => {
    if (hooks.ownsFlatField && !hooks.ownsFlatField()) return null
    if (hooks.flatActive && !hooks.flatActive()) return null
    return getFlat()
  }
  function recompute() {
    const t0 = perfNow()
    // 2D 平面图盖住球面期间（scene 已 pause）不喂 3D：切回 3D 时由 applyFlat 补一次全量。
    const sc = isFlat() ? null : getScene(), fl = flatField()
    if (!sc && !fl) { _fullMs = 0; return }   // 两侧都不收（如 2D 下对星视图占着场）：几何白算，直接跳过
    // 聚焦（编辑中）天线排到最后 → 填充叠加时位于最上层，最醒目（其余按选中顺序在下）
    const ks = [...selected.value].sort((a, b) => (a === active.value ? 1 : 0) - (b === active.value ? 1 : 0))
    const layers = ks.flatMap((k) => buildLayer(k, s.showVal))   // 每天线展开成 N 个波束子层；2D/3D 共用同一份（省一半重算）
    const opts = fieldOpts()
    opts.rays = buildAxisRays(ks, A)                             // 天线视轴：一根天线一条，打到地球上（见 buildAxisRays）
    // 增量更新：图层按 id 复用 GPU 缓冲，只有真消失的层才销毁（94 波束下这是「点播放就卡」的大头）
    if (sc) (sc.updateCoverageField || sc.setCoverageField)(layers, opts)
    if (fl) fl.setField(layers, opts)
    _fullMs = perfNow() - t0            // 整轮耗时（几何 + GPU 重建都算在内）：面板读数用
  }
  // ★ 【一帧一个时刻】：覆盖场的重算永远与星位在同一次调用里做完，绝不延后。
  //   曾经为了省算力把它推迟到「上次耗时 ×2」之后 —— 那等于画面上星在 t、覆盖场在 t−Δ，
  //   同一帧里两个时刻。用户一眼就看出来了：「覆盖场等卫星走一小段后才刷新，慢半拍」。
  //   省算力的活交给时钟去做：一拍算多久，下一拍就隔多久（见 simClockCore.nextDelayMs 的占用底线）——
  //   场景贵就整体放慢，星和场一起慢，永远对得上，而不是让场去追星。
  let _fullMs = 0
  // 拖拽热路径：只重算【聚焦天线】这一层，并只补丁【当前可见视图】（2D 或 3D，由 isFlat 决定）。
  // 其余天线层不变（拖拽不改它们的投影），另一视图在拖拽结束时由 recompute 一次性补齐 → 每帧工作量大幅下降。
  function recomputeActive() {
    if (!active.value || !selected.value.includes(active.value)) return   // 未勾选显示的天线，编辑/拖拽时也不上图
    const layers = buildLayer(active.value, s.showVal)
    const opts = fieldOpts()
    opts.rays = buildAxisRays(selected.value, A)   // 拖指向时视轴跟着转（一天线一条，全量重建也不贵）
    if (isFlat()) { const fl = flatField(); if (fl) fl.patchField(layers, opts) }
    else { const sc = getScene(); if (sc) sc.patchCoverageLayers(layers, opts) }
  }
  // rAF 合帧的聚焦层重算（与拖拽同策略）：<input type=color> 的 @input 在挑色时高频连发，
  // 逐事件同步 recomputeActive 会把主线程打满 → 卡。合帧后一帧最多重算一次，挑色与拖拽同样顺滑。
  let _activeRaf = 0
  function scheduleRecomputeActive() {
    if (_activeRaf) return
    _activeRaf = requestAnimationFrame(() => { _activeRaf = 0; recomputeActive() })
  }

  // 卫星实时位置解算器（由页面注入：星座关联星按星历/时间轴解算星下点+高度）。
  // 未注入或非关联星 → 回退到节点静态 lon/lat/altKm。
  let _livePosFn = null
  function setLivePos(fn) { _livePosFn = fn }
  function liveOf(sat) {
    const p = _livePosFn && _livePosFn(sat)
    return (p && Number.isFinite(p.lon)) ? p : { lon: sat.lon, lat: sat.lat || 0, altKm: sat.altKm }
  }
  // 把单个天线的覆盖投影平移到卫星新位置 p：指向随星下点平移（保留用户相对偏置），
  // 高度变化则足迹随之缩放。返回是否有变化。供实时跟踪与手改卫星信息共用。
  function moveCoverage(c, key, p) {
    const oLon = c.meta.satLon, oLat = c.meta.satLat || 0, oAlt = c.meta.satAlt || 0
    if (Math.abs(p.lon - oLon) < 1e-6 && Math.abs((p.lat || 0) - oLat) < 1e-6 && Math.abs((p.altKm || 0) - oAlt) < 1e-3) return false
    const b = c.settings
    const locked = b.boreLock !== false   // 默认锁定：boresight 钉在地面目标，卫星动→天线重新指向，足迹中心不动
    if (locked) {
      // 锁定：geo 指向保持不动（不随星平移，basis 随新星位重算 → 天线自动重新指向同一地面点）。
      // azel 指向若有地面落点则钉成 geo（默认星下点 azel(0,0) 也就此锁定在初始目标）；越地平的深空指向无地面点可钉 → 保持 azel。
      if (b.boreType === 'azel') {
        const g = azElGround(oLon, oLat, oAlt, b.boreAz || 0, b.boreEl || 0)
        if (g) { b.boreType = 'geo'; b.boreLon = +g.lon.toFixed(4); b.boreLat = +g.lat.toFixed(4) }
      }
    } else if (b.boreType === 'geo') {
      // 不锁定（跟随卫星）：geo 指向随星下点平移，保留地面目标的相对偏置。azel 相对天底，星动自动跟随，无需平移。
      // 【对星指向】三型（sat/satoff/point）一律不在此平移：目标星有自己的星历，空间点是钉死的定点。
      let dLon = p.lon - oLon; while (dLon > 180) dLon -= 360; while (dLon < -180) dLon += 360
      const bl = (b.boreLon == null ? oLon : b.boreLon) + dLon
      b.boreLon = +(((bl % 360) + 540) % 360 - 180).toFixed(4)
      b.boreLat = +Math.max(-89.9, Math.min(89.9, (b.boreLat || 0) + (p.lat || 0) - oLat)).toFixed(4)
    }
    c.meta.satLon = p.lon; c.meta.satLat = p.lat || 0; c.meta.satAlt = p.altKm
    for (const bm of c.beams) bm._projKey = null   // 标记投影过期 → 下次按热区盒重投影（只重算绘制中的波束）
    // 同步聚焦天线面板（锁定钉点 azel→geo、或不锁定平移都可能改了 boreType/lon/lat）；值未变则赋值为空操作、不触发指向 watch。
    if (key === active.value) { _muteSync = true; s.boreType = b.boreType; if (b.boreType === 'geo') { s.boreLon = b.boreLon; s.boreLat = b.boreLat } _muteSync = false }
    return true
  }
  // 实时跟踪：linked 星随星历/时间轴移动 → 平移各选中天线的覆盖投影。
  // 由页面在 refreshPositions（1s 实时 / 时间轴拖动）调用。
  // extra：额外要跟踪的天线 key（单个或数组）。这些天线的覆盖未必绘制在【对地】视图里（不在 selected），
  // 但性能指标表 / 对星覆盖分析仍要按当前星位取值，故也得随星移动其 meta，否则 getPerfContext 取到陈旧星位。
  // 返回 moved（本次真的动了的 key 集合），调用方据此各取所需——只有一个 perfMoved 布尔量不够用了。
  // live=true ＝ 连播拍（重算走节流闸）；false ＝ 用户离散动作（步进/拖游标/跳时刻）→ 当场重算。
  function tickLive(extra = null) {
    const keys = new Set(selected.value)
    const extras = Array.isArray(extra) ? extra.filter(Boolean) : (extra ? [extra] : [])
    for (const k of extras) keys.add(k)
    if (!keys.size) return { changed: false, perfMoved: false, moved: null }
    let changed = false
    const moved = new Set()
    for (const key of keys) {
      const c = cache.get(key); if (!c || !c.meta) continue
      // 对星指向：即使源星不动，目标星在动 → basis 每刻都变，必须每拍重投影。
      // （源星是否跟踪由下面 moveCoverage 管，两者互不替代：低轨打 GSO 是两头都在动。）
      if (c.settings && (c.settings.boreType === 'sat' || c.settings.boreType === 'satoff') && c.settings.boreSat) {
        moved.add(key); if (selected.value.includes(key)) changed = true
      }
      const node = sats.value.find((x) => x.folder === c.meta.folder)
      if (!node || (!node.noradId && !node.elements)) continue   // 仅星座关联星 / 轨道根数模拟星跟踪（固定星不动）
      if (moveCoverage(c, key, liveOf(node))) { moved.add(key); if (selected.value.includes(key)) changed = true }
    }
    // 仅绘制中的覆盖层变了才重绘；未绘制的性能表天线只需 meta 已更新。
    // 当场重算、不延后：星位与覆盖场必须是同一个时刻（见上面「一帧一个时刻」）。
    if (changed) recompute()
    return { changed, perfMoved: extras.length ? moved.has(extras[0]) : false, moved }
  }
  // 手改卫星信息（经纬度/高度）后，该星全部天线的覆盖图随之平移/缩放（与仰角线一同变化）。
  // 已加载的天线即时重投影；导入天线同步存盘快照，未加载的下次按新位置重建。
  function reprojectSat(folder) {
    const node = sats.value.find((x) => x.folder === folder); if (!node) return
    const p = liveOf(node)
    let changed = false
    for (const a of node.antennas) {
      if (a.imported) { a.satLon = p.lon; a.satLat = p.lat || 0; a.satAlt = p.altKm }
      const c = cache.get(keyOf(folder, a.name)); if (!c || !c.meta) continue
      if (moveCoverage(c, keyOf(folder, a.name), p)) changed = true
    }
    if (changed) recompute()
  }

  // 导入 GRD：原生文件框 → 解析 → 在目标卫星下新建一个天线（名取自文件名，可后续改）
  const targetSat = () => { if (active.value) { const f = active.value.split('|')[0]; const s = sats.value.find((x) => x.folder === f); if (s) return s } return sats.value[0] }
  // 由解析结果 g 重建一个导入天线的缓存条目（含【全部波束】的投影/场/峰值 + 天线级 meta）。导入与
  // 重载（ensureLoaded）共用，保证两次结果一致。pos：卫星位置（导入时取实时星历；重载时取存盘位置）。
  // 一个 GRD（含 N 个 set）= 一个天线，N 个 set = N 个波束（SATSOFT 模型，由 Beams To Plot 多选绘制）。
  function importedCacheEntry(sat, g, name, pos) {
    const p0 = pos || liveOf(sat)
    const basis = antennaBasis(p0.lon, p0.lon, p0.lat || 0, 0, p0.lat || 0, p0.altKm)
    const beams = g.sets.map((set) => {
      const proj = projectGrid(set, g.igrid, basis, null, null, true)
      const field = fieldDb({ P1: set.P1, P2: set.P2, NX: set.NX, NY: set.NY }, proj, { pol: 'RSS' })
      const peak = [+proj.lon[field.maxIdx].toFixed(4), +proj.lat[field.maxIdx].toFixed(4)]
      return { P1: set.P1, P2: set.P2, c1re: set.c1re, c1im: set.c1im, c2re: set.c2re, c2im: set.c2im, grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY }, proj, peakDb: +field.max.toFixed(3), peak }
    })
    // 天线整体峰值 = 各波束峰值的最大者（电平表默认值/聚焦定位用）
    const best = beams.reduce((a, b) => (b.peakDb > a.peakDb ? b : a), beams[0])
    const meta = {
      sat: sat.satName, folder: sat.folder, name, type: '', band: '', satLon: p0.lon, satLat: p0.lat || 0, satAlt: p0.altKm,
      igrid: g.igrid, icomp: g.icomp, ncomp: g.ncomp, beams: g.nset,
      antenna: { satLon: p0.lon, boreLon: p0.lon, boreLat: p0.lat || 0, yaw: 0 },
      peakDb: best.peakDb, peak: best.peak
    }
    return { meta, beams, peak: best.peak, peakDb: best.peakDb }
  }
  // 返回新建天线的 key 列表（对星覆盖分析的树据此把新天线一并勾进【它自己那份】显示列表）
  async function importGrd(target) {
    const sat = target || targetSat()
    if (!sat) { appAlert('请先选择一颗卫星'); return [] }
    loading.value = true
    try {
      const res = await window.api.coverageGrd.open()
      if (!res || res.canceled) return []
      // 多选：每个文件 = 一个天线。兼容旧返回（单文件 {base,text}）。
      const files = res.files || (res.text ? [{ base: res.base, text: res.text }] : [])
      if (!files.length) { appAlert('读取失败：' + (res.error || '空文件')); return [] }
      const errs = []
      const added = []
      let lastKey = null, lastPeak = null
      for (const f of files) {
        if (f.error || !f.text) { errs.push((f.base || '文件') + '：' + (f.error || '空文件')); continue }
        let g
        try { g = parseGrd(f.text) } catch (e) { errs.push((f.base || '文件') + '：解析失败 ' + e.message); continue }
        let name = (f.base || 'GRD').replace(/\.(grd|pat)$/i, '')
        while (sat.antennas.some((a) => a.name === name)) name += '·'   // 重名加后缀
        const ent = importedCacheEntry(sat, g, name)
        const m = ent.meta
        // 原始 GRD 存盘（userData/coverage-grd-imported）；失败则仅本会话内有效，不阻断导入
        let file = null
        try { const r = await window.api.coverageGrd.save(f.base || name, f.text); file = r && r.file } catch (e) { console.warn('GRD 持久化失败，仅本会话内有效', e) }
        const key = keyOf(sat.folder, name)
        // 多波束默认只画第 1 个波束（与 SATSOFT 一致：Beams To Plot 由用户按需多选/全选）。
        // 切勿默认全选——HTS 动辄 20+ 波束，一次性建几十个网格/提几十遍等值线会瞬时压垮 GPU（见 command_buffer 崩溃）。
        const settings = defaultSettings(m.satLon, m.satLat, m.peakDb)
        cache.set(key, { meta: m, beams: ent.beams, settings })
        sat.antennas.push({ name, type: '', band: '', beams: m.beams, peakDb: ent.peakDb, peak: ent.peak, file, imported: true, satLon: m.satLon, satLat: m.satLat, satAlt: m.satAlt })
        selected.value = [...selected.value, key]
        added.push(key)
        lastKey = key; lastPeak = ent.peak
      }
      if (lastKey) {
        expanded.value = { ...expanded.value, [sat.folder]: true }
        active.value = lastKey                 // 聚焦最后导入的天线
        _muteSync = true; applySettings(cache.get(lastKey).settings); _muteSync = false
        recompute()
        const sc = getScene(); if (sc && lastPeak) sc.faceLonLat(lastPeak[0], lastPeak[1])
      }
      if (errs.length) appAlert('部分文件导入失败：\n' + errs.join('\n'))
      return added
    } finally { loading.value = false }
  }

  // 波束合成入树：把程序生成的 GRD 文本在指定卫星下建成一副「导入天线」，存盘原始文本后与手动
  // 导入完全同构（持久化/重载/多波束/性能表/链路预算/GXT·KML·小程序导出全部复用）。
  // 同名 = 重新生成：替换旧天线（旧盘上文件一并清理），已有的电平/极化等设置尽量保留。
  // opts: { ctype, levels:[dB...] }——合成波束默认相对模式（各波束自身相对峰值档，SATSOFT 观感）。
  async function importSynthGrd(folder, name, text, opts = {}) {
    const sat = sats.value.find((x) => x.folder === folder)
    if (!sat) { appAlert('目标卫星不存在'); return null }
    loading.value = true
    try {
      const g = parseGrd(text)
      const key = keyOf(folder, name)
      const prev = cache.get(key)
      const prevCfg = prev && prev.settings ? serializeCfg(prev.settings) : null   // 重新生成时保留用户设置
      if (sat.antennas.some((a) => a.name === name)) removeAntenna(folder, name)
      const ent = importedCacheEntry(sat, g, name)
      const m = ent.meta
      let file = null
      try { const r = await window.api.coverageGrd.save(name + '.grd', utf8BytesAsLatin1(text)); file = r && r.file } catch (e) { console.warn('合成 GRD 持久化失败，仅本会话内有效', e) }
      let settings
      if (prevCfg) {
        settings = mergeCfg(m, { ...prevCfg, keptSets: null })
      }
      else {
        settings = defaultSettings(m.satLon, m.satLat, m.peakDb)
        if (opts.ctype) settings.ctype = opts.ctype
        if (Array.isArray(opts.levels) && opts.levels.length) settings.levels = levelsFromValues(opts.levels)
      }
      // 合成波束默认全部绘制：网格是逐波束局部小窗口，规模远小于导入 HTS 整幅网格，可承受
      settings.beamsToPlot = ent.beams.map((_, i) => i)
      cache.set(key, { meta: m, beams: ent.beams, settings })
      sat.antennas.push({ name, type: '', band: '', beams: m.beams, peakDb: ent.peakDb, peak: ent.peak, file, imported: true, synth: true, satLon: m.satLon, satLat: m.satLat, satAlt: m.satAlt })
      if (!selected.value.includes(key)) selected.value = [...selected.value, key]
      expanded.value = { ...expanded.value, [folder]: true }
      active.value = key
      _muteSync = true; applySettings(settings); _muteSync = false
      recompute()
      const sc = getScene(); if (sc && ent.peak) sc.faceLonLat(ent.peak[0], ent.peak[1])
      return key
    } catch (e) {
      console.error('波束合成入树失败', e)
      appAlert('波束合成失败：' + ((e && e.message) || e))
      return null
    } finally { loading.value = false }
  }

  // 拖拽波束：在方向(az/el)空间相对拖动。地表经纬度在地平附近非单调（过地平会回折，导致"拖不到地平线"），
  // 故改用「光标方向(夹到地平)的 az/el」做增量 → 单调、可一路拖到地平线；落在可见地表时松手转回 geo 便于精调。
  const dragBore = ref(false)
  function setDragBore(v) {
    dragBore.value = !!v
    if (dragBore.value && dragLabel.value) setDragLabel(false)   // 与拖标签互斥（左键拖动只能干一件事）
    const sc = getScene(), fl = getFlat(); if (sc) sc.setBeamDragMode(dragBore.value); if (fl) fl.setBeamDragMode(dragBore.value)
  }
  let _drag = null, _dragRaf = 0, _dragLL = null, _dragging = false

  // ===== 数值标签拖拽：开模式后在地图上拖动数值标签，沿其所在等值线滑动（模式式，与拖波束互斥）=====
  // （_dragLabels/_dragCapture 已在顶部前置声明，供 buildLayer 捕获）
  const dragLabel = ref(false)
  let _dragLbl = null    // 本次拖拽锁定的标签（起拖就近锁定，整程用它的 loop 投影，跟手且稳定）
  function setDragLabel(v) {
    dragLabel.value = !!v
    if (dragLabel.value && dragBore.value) setDragBore(false)   // 互斥
    const sc = getScene(), fl = getFlat(); if (sc) sc.setLabelDragMode(dragLabel.value); if (fl) fl.setLabelDragMode(dragLabel.value)
  }
  // 指针经纬度 → 平面近似距离²（找最近标签用）
  const ll2d = (ll, p) => { const dx = dLon(ll.lon, p[0]) * Math.cos(ll.lat * Math.PI / 180), dy = ll.lat - p[1]; return dx * dx + dy * dy }
  function labelDrag(ll, phase) {
    if (phase === 'end') { if (_dragLbl) persistActive(); _dragLbl = null; return }
    if (!ll) return
    if (phase === 'start') {
      _dragLbl = null
      let best = Infinity
      for (const e of _dragLabels) { const d = ll2d(ll, e.anchor); if (d < best) { best = d; _dragLbl = e } }
      return
    }
    // move：把指针吸附到锁定标签所在环 → 弧长比例 t → 写回该档 labelT（该档所有环的标签同步到比例 t）
    if (!_dragLbl) return
    const L = s.levels[_dragLbl.levelIdx]; if (!L) return
    L.labelT = nearestFractionOnLoop(_dragLbl.loop, ll)
    scheduleRecomputeActive()   // 跟手：只重算聚焦层 + 补当前视图（labelT 变更同源触发 watch(s.levels) 亦会回存）
  }
  const curAzEl = (m, lon, lat) => surfaceAzEl(m.satLon, m.satLat || 0, m.satAlt, lon, lat)
  function beamDrag(ll, phase) {
    if (phase === 'end') {   // 松手：退出拖拽态；boresight 落在可见地表则转回 geo（面板便于精调），地平外保持 azel
      if (_dragRaf) { cancelAnimationFrame(_dragRaf); _dragRaf = 0 }
      _drag = null; _dragging = false
      if (s.boreType === 'azel') { const g = boreGround(); if (g) { s.boreType = 'geo'; s.boreLon = +g.lon.toFixed(4); s.boreLat = +g.lat.toFixed(4) } }
      recompute(); return
    }
    if (!active.value || !ll) return
    const m = antMeta(); if (!m) return
    if (phase === 'start') {
      _dragging = true
      // 锚点：当前 boresight 的 az/el（geo 模式由其落点换算）+ 起拖光标的 az/el
      const base = s.boreType === 'azel' ? { az: s.boreAz || 0, el: s.boreEl || 0 } : dirToAzEl(m.satLon, m.satLat || 0, m.satAlt, s.boreLon == null ? m.satLon : s.boreLon, s.boreLat || 0)
      _drag = { base, cur0: curAzEl(m, ll.lon, ll.lat) }
      return
    }
    if (!_drag) return
    _dragLL = ll
    if (_dragRaf) return                       // rAF 节流：每帧最多重投影一次
    _dragRaf = requestAnimationFrame(() => {
      _dragRaf = 0
      const c = curAzEl(m, _dragLL.lon, _dragLL.lat)
      s.boreType = 'azel'
      s.boreAz = +(_drag.base.az + (c.az - _drag.cur0.az)).toFixed(3)
      s.boreEl = +(_drag.base.el + (c.el - _drag.cur0.el)).toFixed(3)
    })
  }

  // 拖拽波束【对星覆盖分析视图】：绕【源星】转视轴 —— 光标在屏幕上移动多少，视轴就绕相机的右/上轴转多少
  // （转量由 scene 的转台算成一个世界系四元数，见那边注释）。与对地拖拽（beamDrag 的 az/el 增量）同为
  // 【增量】式：起拖不跳变、转量随光标线性累加不封顶 → 空间里 4π 全向可达（反天底、背面都指得到）。
  //   早先按「光标落在某层壳上的点」绝对写入，方向被那层壳朝向相机的那半边圈死，出了那片就指不过去
  //   —— 那就是「错误限位」。
  // ll = { q: [x,y,z,w] } 自起拖以来的累计转动；R = 首层显示中的壳层地心半径，只用来定射线长度
  // （写空间点得有个距离，方向与它无关）。写回按模式分两种，都只改「指向哪儿」、不改模式性质：
  //   对星跟踪 / +偏置 → 反解成相对目标星方向的 az/el 偏置（保住对目标星的锁定，只是偏一点）
  //   其余四种         → 写空间点（切到 point 模式）——这是唯一能在空间里自由指的模式
  let _sdRaf = 0, _sdLL = null, _sd = null
  const SD_R2D = 180 / Math.PI
  const clamp1 = (x) => (x < -1 ? -1 : x > 1 ? 1 : x)
  const unit3 = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n] }
  // v 绕四元数 q 转（与 THREE.Vector3.applyQuaternion 同一套展开）
  function applyQuat(v, q) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3]
    const ix = qw * v[0] + qy * v[2] - qz * v[1]
    const iy = qw * v[1] + qz * v[0] - qx * v[2]
    const iz = qw * v[2] + qx * v[1] - qy * v[0]
    const iw = -qx * v[0] - qy * v[1] - qz * v[2]
    return unit3([
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx
    ])
  }
  function shellDrag(ll, phase, R) {
    if (phase === 'end') {
      // 最后一帧还压在 rAF 队列里就松手了（快拖快放）→ 先补一次，否则末位光标位置被丢掉、指向差一截
      if (_sdRaf) { cancelAnimationFrame(_sdRaf); _sdRaf = 0; applyShellDrag(_sd, _sdLL) }
      _dragging = false; _sdLL = null; _sd = null
      persistActive(); recompute(); return
    }
    if (!active.value || !ll || !ll.q) return
    const m = antMeta(); if (!m) return
    if (phase === 'start') {
      const bd = boreDir(); if (!bd) return
      // 射线长度：当前视轴打在这层壳上的斜距；打不到（指向深空）就退到「半个源星地心距」的量级
      const rS = Math.hypot(bd.S[0], bd.S[1], bd.S[2])
      const hit = boresightShellPoint(bd.S, bd.d, R || (A + 550))
      let L = rS * 0.5
      if (hit) {
        const P = geocentricToEcef(hit.lon, hit.lat, hit.altKm)
        const t = Math.hypot(P[0] - bd.S[0], P[1] - bd.S[1], P[2] - bd.S[2])
        if (t > 1) L = t
      }
      _dragging = true
      _sd = { S: bd.S, b0: bd.d, L }
      return
    }
    if (!_sd) return
    _sdLL = ll
    if (_sdRaf) return                       // rAF 节流：每帧最多重投影一次
    _sdRaf = requestAnimationFrame(() => { _sdRaf = 0; applyShellDrag(_sd, _sdLL) })
  }
  function applyShellDrag(sd, ll) {
    if (!sd || !ll || !ll.q) return
    const b = applyQuat(sd.b0, ll.q)                              // 新视轴（ECEF 单位）
    if (s.boreType === 'sat' || s.boreType === 'satoff') {
      const T = s.boreSat && hooks.getTargetEcef ? hooks.getTargetEcef(s.boreSat) : null
      if (T) {
        const ae = dirAzElAbout(antennaBasisEcef(sd.S, T, s.yaw || 0), b)
        s.boreOffAz = +ae.az.toFixed(3); s.boreOffEl = +ae.el.toFixed(3); s.boreType = 'satoff'
        return
      }
    }
    // 空间点＝视轴上距源星 L 处。落进地球里就沿视轴把它推到地面（只动距离不动方向，指向不受影响）
    let L = sd.L
    for (let i = 0; i < 40; i++) {
      const P = [sd.S[0] + L * b[0], sd.S[1] + L * b[1], sd.S[2] + L * b[2]]
      const r = Math.hypot(P[0], P[1], P[2])
      if (r >= A) {
        setBorePoint(Math.atan2(P[1], P[0]) * SD_R2D, Math.asin(clamp1(P[2] / (r || 1))) * SD_R2D, r - A)
        return
      }
      L *= 0.8
    }
  }

  // 缓存：导出/恢复 GRD 面板状态（选中天线 / 聚焦 / 各天线全部设置 / 全局等仰角线）
  function getState() {
    persistActive()
    // 回存【所有已配置天线】的设置（不止当前绘制的）：未加载的沿用 pending 存档，已加载的取 cache 最新。
    // 这样「清除绘图」后 selected 为空，各天线设置仍完整保存到本地，重载即原样恢复。
    const cfgs = {}
    for (const [key, cfg] of pendingCfgs) cfgs[key] = cfg
    for (const [key, c] of cache) { if (c && c.settings) cfgs[key] = serializeCfg(c.settings) }
    // 卫星树：自定义/星座星完整定义 + 全部星的仰角线属性（预置星仅存仰角线，节点本身随 index 复现）
    // 导入天线（已存盘的原始 GRD）随卫星一并保存：重载时据 file 从盘上重建（预置天线由 index 复现，不存）
    const satsState = sats.value.map((s) => ({
      folder: s.folder, kind: s.kind, satName: s.satName,
      lon: s.lon, lat: s.lat, altKm: s.altKm, noradId: s.noradId, elements: s.elements || null,
      els: s.els, elevColor: s.elevColor, elevShow: s.elevShow, elevWidth: s.elevWidth, elevLabelSize: s.elevLabelSize, iconSize: s.iconSize, labelSize: s.labelSize, labelShow: s.labelShow !== false, iconShow: s.iconShow !== false,
      antennas: s.antennas.filter((a) => a.imported && a.file).map((a) => ({
        name: a.name, file: a.file, type: a.type || '', band: a.band || '', beams: a.beams, peakDb: a.peakDb, peak: a.peak,
        satLon: a.satLon, satLat: a.satLat, satAlt: a.satAlt, imported: true, synth: !!a.synth
      }))
    }))
    const disp = { showName: s.showName, nameSize: s.nameSize, showBore: s.showBore, boreSize: s.boreSize, showRay: s.showRay, rayColor: s.rayColor, rayWidth: s.rayWidth, rayOpacity: s.rayOpacity, showPeak: s.showPeak, peakSize: s.peakSize, showVal: s.showVal, valSize: s.valSize }
    return { selected: selected.value.slice(), active: active.value, cfgs, sats: satsState, disp }
  }
  async function restoreState(st) {
    if (!st) return
    // 全局显示选项（天线名/波束中心/数值标签）：先恢复，后续 recompute 即按此绘制
    if (st.disp) for (const k of ['showName', 'nameSize', 'showBore', 'boreSize', 'showRay', 'rayColor', 'rayWidth', 'rayOpacity', 'showPeak', 'peakSize', 'showVal', 'valSize']) if (st.disp[k] != null) s[k] = st.disp[k]
    // 先恢复卫星：自定义/星座关联星补建到树；所有星（含预置）叠加用户编辑（名称/位置/关联/仰角线）。
    // 预置星节点本身由 index 复现，这里仅叠加用户改过的字段；预置星 kind 始终保持 'preset'。
    if (Array.isArray(st.sats)) {
      for (const ss of st.sats) {
        let node = sats.value.find((x) => x.folder === ss.folder)
        if (!node) {
          if (!ss.kind || ss.kind === 'preset') continue   // 预置星已不在 index（如已删/改版）→ 跳过
          node = { folder: ss.folder, satName: ss.satName || '卫星', kind: ss.kind, antennas: [],
            lon: ss.lon, lat: ss.lat, altKm: ss.altKm, noradId: ss.noradId || null, elements: ss.elements || null,
            els: '5,10', elevColor: '#ffffff', elevShow: false, elevWidth: 1.3, elevLabelSize: 18, iconSize: 10, labelSize: 4, labelShow: true, iconShow: true }
          sats.value = [...sats.value, node]
        }
        if (ss.satName) node.satName = ss.satName
        if (Number.isFinite(ss.elevWidth)) node.elevWidth = ss.elevWidth
        if (Number.isFinite(ss.elevLabelSize)) node.elevLabelSize = ss.elevLabelSize
        if (Number.isFinite(ss.iconSize)) node.iconSize = ss.iconSize
        if (Number.isFinite(ss.labelSize)) node.labelSize = ss.labelSize
        if (typeof ss.labelShow === 'boolean') node.labelShow = ss.labelShow
        if (typeof ss.iconShow === 'boolean') node.iconShow = ss.iconShow
        if (Number.isFinite(ss.lon)) node.lon = ss.lon
        if (Number.isFinite(ss.lat)) node.lat = ss.lat
        if (Number.isFinite(ss.altKm)) node.altKm = ss.altKm
        node.noradId = ss.noradId || null
        if ('elements' in ss) node.elements = ss.elements || null
        if (ss.els != null) node.els = ss.els
        if (ss.elevColor) node.elevColor = ss.elevColor
        if (typeof ss.elevShow === 'boolean') node.elevShow = ss.elevShow
        if (ss.kind && ss.kind !== 'preset' && node.kind !== 'preset') node.kind = ss.kind
        // 重建该星下已存盘的导入天线（数据从盘上的原始 GRD 在 ensureLoaded 时解析）
        if (Array.isArray(ss.antennas)) {
          for (const aa of ss.antennas) {
            if (!aa || !aa.imported || !aa.file || node.antennas.some((x) => x.name === aa.name)) continue
            node.antennas.push({ name: aa.name, type: aa.type || '', band: aa.band || '', beams: aa.beams, peakDb: aa.peakDb, peak: aa.peak,
              file: aa.file, imported: true, synth: !!aa.synth, satLon: aa.satLon, satLat: aa.satLat, satAlt: aa.satAlt })
          }
        }
      }
    }
    // 灌入【所有】已存档天线设置到 pending（含未绘制/清除绘图的）：天线一经加载即套用；getState 时一并回存 → 不丢失。
    pendingCfgs.clear()
    if (st.cfgs) for (const key in st.cfgs) pendingCfgs.set(key, st.cfgs[key])
    // 已经在缓存里的天线当场套用：applyPendingCfg 只在天线【首次加载】时触发，启动恢复时 cache 是空的
    // 所以一直没露馅；一旦是会话中途恢复存档（cache 已有这些天线），存档设置就永远落不到它头上。
    for (const key of [...pendingCfgs.keys()]) if (cache.has(key)) applyPendingCfg(key)
    if (!Array.isArray(st.selected)) { recompute(); return }
    // 旧格式（全局设置 + bores）兜底：拼出该天线的 cfg
    const legacy = (key) => st.cfgs ? null : {
      ctype: st.ctype, pol: st.pol, gainOffset: st.gainOffset, pathLoss: st.pathLoss, fill: st.fill, line: st.line, lineWidth: st.lineWidth, alpha: st.alpha,
      ...(st.bores && st.bores[key] ? { boreType: st.bores[key].type, boreLon: st.bores[key].lon, boreLat: st.bores[key].lat, boreAz: st.bores[key].az, boreEl: st.bores[key].el, yaw: st.bores[key].yaw } : {}),
      levels: Array.isArray(st.levels) ? st.levels.map((L) => ({ v: L.v, color: L.color, lineColor: L.lineColor || L.color })) : null
    }
    const keys = []
    for (const key of st.selected) {
      const info = findAnt(key); if (!info) continue                      // 索引中已不存在（如内存导入的）跳过
      await ensureLoaded(info.sat.folder, info.a)                          // 内部 applyPendingCfg 已套用 st.cfgs[key]
      const c = cache.get(key); if (!c) continue
      const lc = legacy(key); if (lc) c.settings = mergeCfg(c.meta, lc)    // 旧格式：pending 为空，在此套用兜底 cfg
      const b = c.settings
      const basis = beamBasis(c.meta, b)
      for (const bm of c.beams) { bm.proj = projectGrid(bm.grid, c.meta.igrid, basis, null, null, true); bm._projKey = null }
      expanded.value = { ...expanded.value, [info.sat.folder]: true }
      keys.push(key)
    }
    selected.value = keys
    // ★ 聚焦与勾选是【两件事】（见 toggleAnt）：存档里的聚焦天线不一定在本视图的 selected 里 ——
    //   典型是只在「对星覆盖分析」里勾选画到壳层的那根。早先按 keys.includes 取，聚焦就落到了别的
    //   天线上，设置区（两视图共用、绑的就是聚焦天线的 s）显示与编辑的都成了另一根天线的设置，
    //   表现为「指向模式/目标星没保存」。故这里单独把它载进来，载不进才退回 keys[0]。
    let act = ''
    if (st.active && await ensureAntLoaded(st.active)) act = st.active
    active.value = act || keys[0] || ''
    if (active.value && cache.get(active.value)) { _muteSync = true; applySettings(cache.get(active.value).settings); _muteSync = false }
    recompute()
  }

  // 性能指标表取值上下文：某天线(key)的名义指向 basis + 当前「Beams To Plot」选中的波束（含数据/名/序号）
  // + 计算设置。供 usePerfTable 逐站调用 sampleBeamAt。该天线未加载缓存时返回 null。
  function getPerfContext(key) {
    const c = cache.get(key); if (!c || !c.beams) return null
    const basis = beamBasis(c.meta, c.settings)
    const folder = key.split('|')[0]
    const satIdx = sats.value.findIndex((x) => x.folder === folder)
    const node = satIdx >= 0 ? sats.value[satIdx] : null
    const antIdx = node ? node.antennas.findIndex((a) => a.name === key.split('|')[1]) : -1
    return {
      key, igrid: c.meta.igrid, icomp: c.meta.icomp, basis, meta: c.meta, settings: c.settings,
      satNo: satIdx + 1, antNo: antIdx + 1,
      satName: (node && node.satName) || c.meta.sat || '', antName: key.split('|')[1],
      // 性能表列【该天线现存的全部波束】（已删除的波束不再进表），不受「Beams To Plot」绘制选择影响；
      // 取值口径/指向仍跟随天线设置。覆盖该城市的波束由 filterOn(minDir) 过滤后显示（SATSOFT 口径）。
      // seq = 原始波束号（1-based，删除波束后不重排），与覆盖面板波束列表同一口径。
      beams: c.beams.map((bm, bi) => ({ bi, seq: origIdx(c, bi) + 1, name: beamName(c, bi), peakDb: bm.peakDb, beam: bm }))
    }
  }

  // 确保某天线已载入缓存（性能表对【非聚焦】天线取值前调用），返回是否就绪。
  async function ensureAntLoaded(key) {
    if (cache.has(key)) return true
    const info = findAnt(key); if (!info) return false
    await ensureLoaded(info.sat.folder, info.a)
    return cache.has(key)
  }

  // 导出当前【选中且绘制中】天线波束的等值线为 GXT 用数据（闭合环 + 增益）。供文件管理器「导出当前画面覆盖为 GXT」。
  // 复用绘制同款 bandGeometry，按各档拼成闭合环（stitchLoops）；相对模式记档值，绝对模式记绝对 dB。
  function exportContours() {
    const out = []
    for (const key of selected.value) {
      const c = cache.get(key); if (!c || !c.beams) continue
      const cfg = c.settings
      const node = sats.value.find((x) => x.folder === key.split('|')[0])
      const plot = (cfg.beamsToPlot || []).filter((i) => i < c.beams.length)
      for (const bi of plot) {
        const beam = c.beams[bi]
        const field = beamField(beam, cfg)
        const asc = [...absLevels(field.max, cfg)].sort((a, b) => a.abs - b.abs)
        const box = beamBox(beam, cfg, field)
        syncBeamProj(c, beam, cfg, field)
        const geo = bandGeometry({ lon: beam.proj.lon, lat: beam.proj.lat, vis: beam.proj.vis, db: field.db, NX: beam.proj.NX, NY: beam.proj.NY }, asc.map((x) => x.abs), false, box, null, displayQuality.value.gridStride)
        const contours = []
        asc.forEach((x, i) => {
          for (const loop of stitchLoops(geo.lines[i])) {
            if (loop.length >= 4) contours.push({ g: cfg.ctype === 'rel' ? x.v : +x.abs.toFixed(2), p: loop.map((p) => [+p[0].toFixed(3), +p[1].toFixed(3)]) })
          }
        })
        // 波束中心 = 当前场的峰值点，与 buildBeamLayer 画面显示同源（随指向拖拽/极化/增益实时变化）。
        // 不用载入时烘焙的 c.meta.peak——那是天线级最佳波束的初始峰值：拖拽指向后过时，多波束时全部波束被写成同一点。
        const pk = (Number.isFinite(beam.proj.lon[field.maxIdx]) && Number.isFinite(beam.proj.lat[field.maxIdx]))
          ? [+beam.proj.lon[field.maxIdx].toFixed(4), +beam.proj.lat[field.maxIdx].toFixed(4)]
          : (beam.peak || c.meta.peak || null)
        if (contours.length) out.push({ name: beamName(c, bi), satName: (node && node.satName) || c.meta.sat || '', lon: c.meta.satLon, bore: pk ? [pk] : [], contours })
      }
    }
    return out
  }

  function clearAll() { selected.value = []; active.value = ''; const sc = getScene(), fl = flatField(); if (sc) sc.setCoverageField([], {}); if (fl) fl.setField([], {}) }
  // 一键清除绘图：抹掉地图上的填充/线，但保留各天线设置（数据库）与聚焦项 → 再次勾选天线即按原设置重绘。
  function clearDrawing() { selected.value = []; const sc = getScene(), fl = flatField(); if (sc) sc.setCoverageField([], {}); if (fl) fl.setField([], {}) }

  watch(() => [s.fill, s.line, s.lineWidth, s.ctype, s.pol, s.gainOffset, s.pathLoss], () => { persistActive(); recompute() }, { deep: true })
  // 电平改动只影响聚焦天线这一层（persistActive 仅写 active）→ 走单层快路径 recomputeActive，只 patch 当前可见视图。
  // 另一视图（2D/3D）在切换时由 applyFlat 的 recompute 一次性补齐（与拖拽波束同策略，避免每次编辑全量重算所有选中层）。
  watch(() => s.levels, () => { persistActive(); scheduleRecomputeActive() }, { deep: true })   // 合帧：挑色高频连发不再卡（persistActive 同步保证状态最新，重算合到下一帧）
  watch(() => s.beamsToPlot, () => { persistActive(); recompute() }, { deep: true })   // Beams To Plot 多选变更 → 回存 + 重绘
  watch(active, () => { beamQuery.value = '' })   // 切换聚焦天线：清空波束筛选词（波束数/含义随天线变）
  watch(() => s.alpha, (a) => { persistActive(); const sc = getScene(), fl = flatField(); if (sc) sc.setCoverageFieldAlpha(a); if (fl) fl.setFieldAlpha(a) })
  // 切换 boresight 类型：把当前指向无缝换算到另一种表示，避免跳变（geo→azel 取该地表点的 az/el；azel→geo 取落地点）
  watch(() => s.boreType, (nt, ot) => {
    if (_muteSync || _dragging || nt === ot) return   // 拖拽自行管理指向，不在此换算
    const m = antMeta(); if (!m) return
    // 对星指向另成一路：目标是一颗星或空间中一个定点，不是一个角度或地表点，geo↔azel 那套换算对它没有意义。
    // 从对星模式切回来时保留原有的 az/el 与经纬度（切换前存的那份），不做任何折算。
    const off = (t) => t === 'sat' || t === 'satoff' || t === 'point'
    if (off(nt) || off(ot)) return
    if (nt === 'azel') { const ae = dirToAzEl(m.satLon, m.satLat || 0, m.satAlt, s.boreLon == null ? m.satLon : s.boreLon, s.boreLat || 0); _muteSync = true; s.boreAz = +ae.az.toFixed(3); s.boreEl = +ae.el.toFixed(3); _muteSync = false }
    else { const g = azElGround(m.satLon, m.satLat || 0, m.satAlt, s.boreAz || 0, s.boreEl || 0); if (g) { _muteSync = true; s.boreLon = +g.lon.toFixed(4); s.boreLat = +g.lat.toFixed(4); _muteSync = false } }
  })
  watch(() => s.boreLock, () => persistActive())   // 指向锁定开关：回存到聚焦天线设置（不改画面，下次卫星移动/编辑星位时生效）
  // 指向变化（geo 的 lon/lat 或 azel 的 az/el，含 yaw/类型）：reproject 只重投影聚焦天线；拖拽中走单层+单视图快路径，否则全量。
  watch(() => [s.boreLon, s.boreLat, s.boreAz, s.boreEl, s.yaw, s.boreType,
    s.boreOffAz, s.boreOffEl, s.borePtLon, s.borePtLat, s.borePtAlt], () => {
    reproject(); _dragging ? recomputeActive() : recompute()
  })
  // 全局显示选项（天线名/波束中心/数值标签开关与字号）：仅影响标注层，重绘即可（不回存到天线设置）
  watch(() => [s.showName, s.nameSize, s.showBore, s.boreSize, s.showRay, s.rayColor, s.rayWidth, s.rayOpacity, s.showPeak, s.peakSize, s.showVal, s.valSize], () => recompute())
  watch(() => s.showVal, (v) => { if (!v && dragLabel.value) setDragLabel(false) })   // 关掉数值标签即退出标签拖拽模式（无标签可拖）

  return {
    sats, expanded, selected, active, loading, s,
    keyOf, isSelected, isActive, isExpanded, antMeta, activeName, beamsCount, satState, dragBore, boreGround, boreDir, boreTip, buildAxisRays, boreModeOf, setBoreMode,
    setBoreSat, boreSatResolved, setBorePoint, syncBorePoint, shellDrag, beamBasis,
    activeBeams, beamListOn, isBeamOn, toggleBeam, setAllBeams, allBeamsOn, renameBeam,
    beamQuery, setBeamQuery, filteredBeams, filteredAllOn, filteredAnyOn, selectFiltered,
    deleteBeam, deleteCheckedBeams,
    loadIndex, setActive, toggleAnt, toggleSatAll, toggleExpand, addLevel, removeLevel, importGrd, importSynthGrd,
    addSatellite, addElevLine, updateSatellite, removeSatellite, removeAntenna, renameAntenna, setElev, onTreeKeys,
    setDragBore, beamDrag, dragLabel, setDragLabel, labelDrag, getState, restoreState, recompute, clearAll, clearDrawing, setActiveKey,
    setLivePos, tickLive, getPerfContext, ensureAntLoaded, exportContours
  }
}
